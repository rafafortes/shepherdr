// The advisor: a question a task or a coordinator opens for the human goes to another model, when the human asks (Ask
// the advisor on its card) or by itself once it waited (Settings → Agents → Advisor → Answers for you after). A real
// LiveSource, a herdr socket that isn't there, what an agent is sent caught at the one place it goes, and the advisor's
// run stubbed at the one place it runs: no CLI is run, and no model is asked anything.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('advisor')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { adviceArgs, advisorPrompt, parseAdvice } = await import('../server/live/advisor.ts')

const src = new LiveSource()
afterAll(() => src.stop())
const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'

/** what the advisor was run with, and what it answers next (one per run) */
const runs: { kind: string; model?: string; prompt: string; cwd: string }[] = []
let replies: { ok: boolean; out: string }[] = []
/** what each agent was sent */
let sent: { key: string; text: string }[] = []
let alerts: { title: string; body: string }[] = []
const json = (o: object) => ({ ok: true, out: `I read the code.\n${JSON.stringify(o)}` })

beforeEach(() => {
  runs.length = 0
  replies = []
  sent = []
  alerts = []
  src.engine.installed = () => true
  src.runAdvisor = (async (h: { kind: string; model?: string }, prompt: string, cwd: string) => {
    runs.push({ kind: h.kind, model: h.model, prompt, cwd })
    return replies.shift() ?? { ok: false, out: 'nothing to say' }
  }) as never
  src.agents.send = (async (key: string, text: string) => {
    sent.push({ key, text })
    return {}
  }) as never
  src.alert = ((a: { title: string; body: string }) => alerts.push(a)) as never
})

/** a space with the advisor set (pi, its backup Codex), and a task of it started as a real one is */
async function world(name: string) {
  const dir = tmp('advisor-repo')
  execSync(REPO, { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, name)
  for (const [k, v] of [['advisor.agent', 'pi'], ['advisor.model', 'opencode-go/deepseek-v4.1-flash'], ['advisor.fallback', 'Codex']])
    expect(src.settings.set(k, v, { space: p.name }).ok).toBe(true)
  const id = `ADV-${Math.random().toString(36).slice(2, 6)}`
  src.engine.tasks.push({ id, n: 1, project: placeId.space(p.name), base: 'main', branch: 'main', worktree: dir, title: 'Pick a store', desc: 'Keep the outbox somewhere.', by: 'test', created: Date.now(), updated: Date.now() - 60 * 60_000, told: 'work' } as never)
  const key = `${id}/Agent`
  src.agents.records[key] = { key, name: id, kind: 'pi', cwd: dir, workspace: p.name, logs: [], started: Date.now() } as never
  const done = () => {
    for (const k of ['advisor.agent', 'advisor.model', 'advisor.fallback', 'advisor.after']) src.settings.set(k, null, { space: p.name })
  }
  return { p, id, key, dir, coord: placeId.space(p.name), done }
}

/** a choice card the agent asked (shepherdr ask), or a plan it waits on */
function card(key: string, id: string, title: string, labels: string[], kind: 'Form' | 'Plan' = 'Form') {
  src.chats.post(key, { id, question: { id, title, kind, choices: labels.map((label) => ({ label })), to: key } } as never)
}

/** what one chat's agent was sent (its coordinator also hears the news of its tasks) */
const to = (key: string) => sent.filter((s) => s.key === key).map((s) => s.text)
const cards = (key: string) => src.chats.chat(key).messages.filter((m) => m.card).map((m) => m.card!.text)
const advice = (key: string) => src.chats.chat(key).messages.find((m) => m.question?.id.startsWith('advice:'))?.question

describe('what the advisor is asked, and how it answers', () => {
  test('its prompt names what only the human decides, the question and its options, and the one line it ends with', () => {
    const p = advisorPrompt({ question: { kind: 'choice', title: 'Which store?', choices: [{ label: 'SQLite', description: 'a file' }, { label: 'Postgres' }] }, asker: "POL-1's agent", brief: 'Keep the outbox.', chat: 'agent: which store?', folder: '/w', human: 'Rafael' })
    expect(p).toContain("POL-1's agent is waiting for Rafael's answer")
    expect(p).toContain('read only')
    expect(p).toContain('force-pushing')
    expect(p).toContain('1. SQLite — a file\n2. Postgres')
    expect(p).toContain('"choice": the number of the option you pick')
  })

  test('each CLI runs read only, with no session and no MCP servers', () => {
    expect(adviceArgs({ kind: 'pi', model: 'm' }, 'Q')!.cmd).toEqual(['pi', '-p', '--no-session', '--no-mcp', '--no-skills', '--tools', 'read,grep,find,ls', '--model', 'm', 'Q'])
    const claude = adviceArgs({ kind: 'claude' }, 'Q')!
    expect(claude.cmd).toEqual(expect.arrayContaining(['--allowedTools', 'Read,Grep,Glob', '--no-session-persistence', '--strict-mcp-config']))
    expect(claude.stdin).toBe('Q')
    expect(adviceArgs({ kind: 'codex' }, 'Q')!.cmd).toEqual(expect.arrayContaining(['--sandbox', 'read-only']))
    expect(adviceArgs({ kind: 'opencode' }, 'Q')).toBeUndefined()
  })

  test('its last line of JSON is its answer: a pick in range, several, its own words, or the human', () => {
    const q = { kind: 'choice' as const, title: 'Which?', choices: [{ label: 'A' }, { label: 'B' }] }
    expect(parseAdvice('thinking {"x":1}\n{"decide":"advisor","choice":2,"why":"B is simpler","sure":true}', q)).toEqual({ choice: 1, why: 'B is simpler' })
    expect(parseAdvice('{"decide":"advisor","choice":3,"why":"?","sure":true}', q)).toBeUndefined()
    expect(parseAdvice('{"decide":"advisor","choice":1,"why":"maybe","sure":false}', q)).toEqual({ why: 'maybe', human: 'maybe' })
    expect(parseAdvice('{"decide":"human","why":"it deletes a branch","sure":true}', q)).toEqual({ why: 'it deletes a branch', human: 'it deletes a branch' })
    expect(parseAdvice('{"decide":"advisor","choices":[1,2],"why":"both","sure":true}', { ...q, multi: true })).toEqual({ choice: 0, choices: [0, 1], why: 'both' })
    expect(parseAdvice('{"decide":"advisor","reply":"Use SQLite.","why":"small","sure":true}', { kind: 'words', title: 'Which store?' })).toEqual({ reply: 'Use SQLite.', why: 'small' })
    expect(parseAdvice('no json at all', q)).toBeUndefined()
  })

  test('its own words on a question that takes them: with no pick, a null one, or the slot after the options', () => {
    const q = { kind: 'choice' as const, title: 'What do I record?', choices: [{ label: 'Both' }, { label: 'Aldo only' }, { label: 'Leave it' }], other: true }
    const words = { other: 'Record Aldo now; keep Marisa open until her card is confirmed.', why: 'Only one is proven.', choice: 3 }
    expect(parseAdvice('{"decide":"advisor","other":"Record Aldo now; keep Marisa open until her card is confirmed.","why":"Only one is proven.","sure":true}', q)).toEqual(words)
    expect(parseAdvice('{"decide":"advisor","choice":null,"other":"Record Aldo now; keep Marisa open until her card is confirmed.","why":"Only one is proven.","sure":true}', q)).toEqual(words)
    expect(parseAdvice('{"decide":"advisor","choice":4,"other":"Record Aldo now; keep Marisa open until her card is confirmed.","why":"Only one is proven.","sure":true}', q)).toEqual(words)
    // a number written as JSON words is still a pick
    expect(parseAdvice('{"decide":"advisor","choice":"2","why":"Aldo is proven.","sure":true}', q)).toEqual({ choice: 1, why: 'Aldo is proven.' })
    // words where the question takes none: no answer
    expect(parseAdvice('{"decide":"advisor","choice":null,"other":"x","why":"y","sure":true}', { ...q, other: false })).toBeUndefined()
  })
})

describe('on the human’s word', () => {
  test('Ask the advisor on a card: its suggestion is a card of its own, and Send it answers the question as the human would', async () => {
    const w = await world('adv-manual')
    try {
      card(w.key, 'ask:m1', 'Which store for the outbox?', ['SQLite', 'Postgres'])
      // the card offers the advisor, where one is set
      expect(src.chat(w.key)!.messages.find((m) => m.question?.id === 'ask:m1')!.question!.advise).toBe(true)
      replies = [json({ decide: 'advisor', choice: 1, why: 'One file, no server: enough for an outbox.', sure: true })]
      expect(await src.advise(w.key, 'ask:m1')).toEqual({ ok: true })
      // run where the work is, on the space's advisor, read only
      expect(runs.map((r) => [r.kind, r.model, r.cwd])).toEqual([['pi', 'opencode-go/deepseek-v4.1-flash', w.dir]])
      expect(runs[0].prompt).toContain('Which store for the outbox?')
      expect(runs[0].prompt).toContain('Keep the outbox somewhere.')
      // nothing reached the agent yet: a suggestion waits for the human
      expect(to(w.key)).toEqual([])
      const a = advice(w.key)!
      expect(a.title).toBe('The advisor suggests: “SQLite”')
      expect(a.choices.map((c) => c.label)).toEqual(['Send it', "I'll answer myself"])
      expect(a.choices[0].description).toContain('One file, no server')
      // asked once: the card no longer offers it
      expect(src.chat(w.key)!.messages.find((m) => m.question?.id === 'ask:m1')!.question!.advise).toBeUndefined()
      // Send it: the question is answered as the human would, in the human's name
      expect(await src.act({ type: 'answer', chat: w.key, question: a.id, choice: 0 })).toEqual({ ok: true })
      expect(to(w.key)).toHaveLength(1)
      expect(to(w.key)[0]).toContain(`from="${src.user}"`)
      expect(to(w.key)[0]).toContain('SQLite')
      expect(src.chats.log(w.key).answers['ask:m1']).toBe(0)
    } finally {
      w.done()
    }
  })

  test('its suggestion is the human’s to send: never advised itself, never sent by itself, however long it waits', async () => {
    const w = await world('adv-suggestion')
    try {
      card(w.key, 'plan:s1', 'Plan: split the store', ['Approve', 'Change it'], 'Plan')
      replies = [json({ decide: 'advisor', choice: 1, why: 'Sound.', sure: true })]
      await src.advise(w.key, 'plan:s1')
      const a = advice(w.key)!
      expect(src.chat(w.key)!.messages.find((m) => m.question?.id === a.id)!.question!.advise).toBeUndefined()
      replies = [json({ decide: 'advisor', choice: 1, why: 'Send it.', sure: true })]
      await src.watchAdvice(Date.now() + 3_600_000)
      expect(runs).toHaveLength(1)
      expect(to(w.key)).toEqual([])
    } finally {
      w.done()
    }
  })

  test("I'll answer myself leaves the question as it was", async () => {
    const w = await world('adv-decline')
    try {
      card(w.key, 'ask:d1', 'Retry or give up?', ['Retry', 'Give up'])
      replies = [json({ decide: 'advisor', choice: 1, why: 'Transient.', sure: true })]
      await src.advise(w.key, 'ask:d1')
      await src.act({ type: 'answer', chat: w.key, question: advice(w.key)!.id, choice: 1 })
      expect(to(w.key)).toEqual([])
      expect(src.chats.log(w.key).answers['ask:d1']).toBeUndefined()
    } finally {
      w.done()
    }
  })

  test('a plan only ever gets a suggestion, and a permission is never the advisor’s', async () => {
    const w = await world('adv-plan')
    try {
      card(w.key, 'plan:p1', 'Plan: rewrite the store', ['Approve', 'Change it'], 'Plan')
      // never by itself, however long it waited
      await src.watchAdvice(Date.now() + 3_600_000)
      expect(runs).toEqual([])
      replies = [json({ decide: 'advisor', choice: 1, why: 'Sound.', sure: true })]
      expect(await src.advise(w.key, 'plan:p1')).toEqual({ ok: true })
      expect(to(w.key)).toEqual([])
      expect(advice(w.key)!.title).toContain('Approve')
      // a terminal's menu (a permission): not offered, not taken
      card(w.key, 'menu:x', 'Allow rm -rf?', ['Yes', 'No'])
      expect((await src.advise(w.key, 'menu:x')).ok).toBe(false)
    } finally {
      w.done()
    }
  })
})

describe('by itself, once a question waited', () => {
  test('after its wait a sure answer goes to the agent, the chat says it was the advisor, and an alert goes out', async () => {
    const w = await world('adv-auto')
    try {
      card(w.key, 'ask:a1', 'Which store for the outbox?', ['SQLite', 'Postgres'])
      replies = [json({ decide: 'advisor', choice: 1, why: 'Enough for an outbox.', sure: true })]
      // not before its wait (2 minutes unless set)
      await src.watchAdvice(Date.now() + 60_000)
      expect(runs).toEqual([])
      await src.watchAdvice(Date.now() + 3 * 60_000)
      expect(runs).toHaveLength(1)
      expect(to(w.key)).toHaveLength(1)
      expect(to(w.key)[0]).toContain('from="The advisor"')
      expect(to(w.key)[0]).toContain('SQLite')
      expect(cards(w.key).at(-1)).toContain('The advisor answered for you, as you didn\'t: “SQLite”. Enough for an outbox.')
      expect(alerts.map((a) => a.title)).toEqual([`The advisor answered ${w.id}`])
      // once: never asked again about it
      await src.watchAdvice(Date.now() + 10 * 60_000)
      expect(runs).toHaveLength(1)
    } finally {
      w.done()
    }
  })

  test('its wait is a setting: off, it never goes by itself', async () => {
    const w = await world('adv-off')
    try {
      expect(src.settings.set('advisor.after', 'off', { space: w.p.name }).ok).toBe(true)
      card(w.key, 'ask:o1', 'Which?', ['A', 'B'])
      await src.watchAdvice(Date.now() + 3_600_000)
      expect(runs).toEqual([])
    } finally {
      w.done()
    }
  })

  test('unsure, or the human’s to decide: a card says so, and nothing is sent', async () => {
    const w = await world('adv-human')
    try {
      card(w.key, 'ask:h1', 'Delete the old branch?', ['Yes', 'No'])
      replies = [json({ decide: 'human', why: 'Deleting a branch is yours to decide.', sure: true })]
      await src.watchAdvice(Date.now() + 3 * 60_000)
      expect(to(w.key)).toEqual([])
      expect(cards(w.key).at(-1)).toContain('The advisor leaves this to you: Deleting a branch is yours to decide.')
    } finally {
      w.done()
    }
  })

  test('the advisor can’t answer: its backup does', async () => {
    const w = await world('adv-backup')
    try {
      card(w.key, 'ask:b1', 'Which?', ['A', 'B'])
      replies = [{ ok: false, out: '402 Insufficient account funds' }, json({ decide: 'advisor', choice: 2, why: 'B fits.', sure: true })]
      await src.watchAdvice(Date.now() + 3 * 60_000)
      expect(runs.map((r) => r.kind)).toEqual(['pi', 'codex'])
      expect(to(w.key)[0]).toContain('from="The advisor"')
      expect(cards(w.key).at(-1)).toContain('(Codex')
    } finally {
      w.done()
    }
  })

  test('words that give no answer are kept whole, for the day they need explaining', async () => {
    const w = await world('adv-kept')
    try {
      card(w.key, 'ask:k1', 'Which?', ['A', 'B'])
      replies = [{ ok: true, out: 'I looked at it at length.\n{"decide":"advisor","choice":9,"why":"neither","sure":true}' }, json({ decide: 'advisor', choice: 1, why: 'A fits.', sure: true })]
      await src.watchAdvice(Date.now() + 3 * 60_000)
      const dir = join(process.env.SHEPHERDR_HOME!, 'advisor')
      const files = readdirSync(dir).filter((f) => f.includes(w.id))
      expect(files).toHaveLength(1)
      expect(readFileSync(join(dir, files[0]), 'utf8')).toContain('I looked at it at length.')
    } finally {
      w.done()
    }
  })

  test('a plain question in words gets an answer in words', async () => {
    const w = await world('adv-words')
    try {
      const ev = (src.chats as unknown as { events: Map<string, unknown[]> }).events
      ev.set(w.key, [...(ev.get(w.key) ?? []), { kind: 'agent', id: 'w1', at: Date.now(), text: 'The tests pass. Should I keep the old endpoint for one more release, or remove it now?' }])
      replies = [json({ decide: 'advisor', reply: 'Keep it for one more release and mark it deprecated.', why: 'Clients still call it.', sure: true })]
      await src.watchAdvice(Date.now() + 3 * 60_000)
      expect(runs).toHaveLength(1)
      expect(runs[0].prompt).toContain('Should I keep the old endpoint')
      expect(to(w.key)).toEqual([`The advisor, answering for ${src.user} (who left your question to it): Keep it for one more release and mark it deprecated.`])
    } finally {
      w.done()
    }
  })

  test('a coordinator’s question goes too, answered in its own folder', async () => {
    const w = await world('adv-coord')
    try {
      card(w.coord, 'ask:c1', 'Queue the audit tasks now or tonight?', ['Now', 'Tonight'])
      replies = [json({ decide: 'advisor', choice: 2, why: 'The machine is loaded now.', sure: true })]
      await src.watchAdvice(Date.now() + 3 * 60_000)
      expect(runs).toHaveLength(1)
      expect(to(w.coord).filter((t) => t.includes('from="The advisor"'))).toHaveLength(1)
      expect(to(w.coord).find((t) => t.includes('from="The advisor"'))).toContain('Tonight')
    } finally {
      w.done()
    }
  })

  test('where no advisor is set, nothing is offered or asked', async () => {
    const w = await world('adv-none')
    try {
      src.settings.set('advisor.agent', 'off', { space: w.p.name })
      card(w.key, 'ask:n1', 'Which?', ['A', 'B'])
      expect(src.chat(w.key)!.messages.find((m) => m.question?.id === 'ask:n1')!.question!.advise).toBeUndefined()
      await src.watchAdvice(Date.now() + 3_600_000)
      expect(runs).toEqual([])
    } finally {
      w.done()
    }
  })
})
