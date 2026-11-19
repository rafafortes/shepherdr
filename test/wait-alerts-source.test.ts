// What your alert command is told of what waits on you (source.ts tellWaits, waitWords): a task's question with its space
// and task, and what the advisor is doing about it; a plan, which the advisor never answers by itself; a coordinator's
// question, left out where its space's Notify is Off (a task's never). A question the advisor will answer by itself gets
// first refusal: no alert until it hands back, fails, waits for room, or runs out of time. Another agent's relay, in the
// shape each CLI's log carries it, closes a card before any alert goes. A real LiveSource, a herdr socket that isn't
// there, and the command caught at the one place it runs: nothing is run.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { openCards } from '../shared/alerts.ts'
import { fromAgentLine } from '../server/live/chatlines.ts'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('wait-alerts-source')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { WaitAlerts, keyWords } = await import('../server/live/wait-alerts.ts')
const { writeJson } = await import('../server/store.ts')

const src = new LiveSource()
afterAll(() => src.stop())
const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'

/** what the command was run with */
let ran: { command: string; args: string[] }[] = []

beforeEach(() => {
  ran = []
  writeJson('wait-alerts.json', { waits: {} })
  src.waitAlerts = new WaitAlerts((command, args) => ran.push({ command, args }))
  src.engine.tasks.length = 0
  src.settings.set('alerts.command', '~/bin/notify', 'machine')
  src.settings.set('alerts.doneCommand', null, 'machine')
})

/** a space with the advisor set (answering after 2 min), and a task of it started as a real one is, its agent on a CLI */
async function world(name: string, kind = 'pi') {
  const dir = tmp('wait-alerts-repo')
  execSync(REPO, { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, name)
  for (const [k, v] of [
    ['advisor.agent', 'pi'],
    ['advisor.after', '2 min'],
  ])
    expect(src.settings.set(k, v, { space: p.name }).ok).toBe(true)
  const id = `WA-${Math.random().toString(36).slice(2, 6)}`
  src.engine.tasks.push({
    id,
    n: 1,
    project: placeId.space(p.name),
    base: 'main',
    branch: 'main',
    worktree: dir,
    title: 'Pick a store',
    desc: 'Keep the outbox somewhere.',
    by: 'test',
    created: Date.now(),
    updated: Date.now() - 60 * 60_000,
    told: 'work',
  } as never)
  const key = `${id}/Agent`
  src.agents.records[key] = { key, name: id, kind, cwd: dir, workspace: p.name, logs: [], started: Date.now() } as never
  return { p, id, key, coord: placeId.space(p.name) }
}

/** a choice card an agent asked, or a plan it waits on, posted at a time */
function card(key: string, id: string, title: string, labels: string[], at: number, kind: 'Form' | 'Plan' = 'Form') {
  src.chats.post(key, { id, at, question: { id, title, kind, choices: labels.map((label) => ({ label })), to: key } } as never)
}

/** the advisor's record for a question, in the state a run left it */
function advice(w: { key: string }, qid: string, state: string, extra: object = {}) {
  src.advices.set({ chat: w.key, question: qid, at: Date.now(), state, ...extra } as never)
}

/** a line another agent's message left in a CLI's log, standing in for its reader */
function reached(key: string, e: object) {
  const events = (src.chats as unknown as { events: Map<string, unknown[]> }).events
  events.set(key, [...(events.get(key) ?? []), e])
}

describe('what your alert command is told', () => {
  test("a task's question the advisor will take: told only when it hands back, with its reason", async () => {
    const w = await world('wa-question')
    const at = Date.now()
    card(w.key, 'ask:q1', 'Which store for the outbox?', ['SQLite', 'Postgres'], at)
    src.tellWaits(at)
    src.tellWaits(at + 10_000)
    src.tellWaits(at + 20_000)
    // the advisor has first refusal: the human is not told while it is on the question
    expect(ran).toEqual([])
    // it leaves the question to the human: one alert, with its reason instead of "answers for you at"
    advice(w, 'ask:q1', 'human', { auto: true, advice: { human: 'This decides spending', why: 'budget', by: 'pi' } })
    src.tellWaits(at + 30_000)
    expect(ran).toHaveLength(1)
    const [title, body, key] = ran[0]!.args
    expect(ran[0]!.command).toBe('~/bin/notify')
    expect(title).toBe(`Shepherdr · ${w.id} · Which store for the outbox?`)
    const lines = body!.split('\n')
    expect(lines[0]).toBe(`wa-question · ${w.id}: Pick a store`)
    expect(lines[1]).toContain('SQLite')
    expect(lines.at(-1)).toBe('The advisor left this to you: This decides spending (pi).')
    expect(body).not.toContain('the advisor answers for you')
    expect(key).toBe(`shepherdr-${w.key}_ask_q1-${at}`.replace(/[^A-Za-z0-9._-]+/g, '_'))
  })

  test('a plan: told as before, with no word of the advisor (it never answers one by itself)', async () => {
    const w = await world('wa-plan')
    const at = Date.now()
    card(w.key, 'plan:p1', 'Build the outbox', ['Approve', 'Change it'], at, 'Plan')
    src.tellWaits(at)
    src.tellWaits(at + 10_000)
    expect(ran).toHaveLength(1)
    expect(ran[0]!.args[0]).toBe(`Shepherdr · ${w.id} · Plan to approve`)
    expect(ran[0]!.args[1]).not.toContain('advisor')
  })

  test('a stuck advisor: the alert goes after advisor.after plus a margin', async () => {
    const w = await world('wa-stuck')
    const at = Date.now()
    card(w.key, 'ask:stuck', 'Which store?', ['A', 'B'], at)
    src.tellWaits(at)
    src.tellWaits(at + 179_000)
    expect(ran).toEqual([])
    src.tellWaits(at + 180_000)
    expect(ran.map((r) => r.args[0])).toEqual([`Shepherdr · ${w.id} · Which store?`])
    expect(ran[0]!.args[1]).toContain('has not finished')
  })

  test('an advisor that fails or waits for room tells the human with what happened', async () => {
    const w = await world('wa-failed')
    const at = Date.now()
    card(w.key, 'ask:failed', 'Which store?', ['A', 'B'], at)
    advice(w, 'ask:failed', 'failed', { auto: true })
    src.tellWaits(at)
    src.tellWaits(at + 10_000)
    expect(ran).toHaveLength(1)
    expect(ran[0]!.args[1]).toContain('The advisor could not answer, so this waits for you')
    const v = await world('wa-room')
    card(v.key, 'ask:room', 'Which name?', ['A', 'B'], at)
    advice(v, 'ask:room', 'waiting', { auto: true })
    src.tellWaits(at)
    src.tellWaits(at + 10_000)
    expect(ran.at(-1)!.args[1]).toContain('The advisor waits for a free model')
  })

  test('an advisor answer before the delay tells nothing at all', async () => {
    const w = await world('wa-auto')
    const at = Date.now()
    card(w.key, 'ask:auto', 'Which store?', ['A', 'B'], at)
    advice(w, 'ask:auto', 'sent', { auto: true })
    src.chats.answer(w.key, 'ask:auto', 0)
    ;(src.engine.task(w.id) as unknown as { reported: unknown }).reported = 'done'
    for (const t of [at, at + 10_000, at + 180_000, at + 240_000]) src.tellWaits(t)
    expect(ran.filter((r) => r.args[0]!.includes(w.id))).toEqual([])
  })

  test('the advisor answering by itself tells nothing, and marks the wait it had told', async () => {
    const w = await world('wa-solved')
    const at = Date.now()
    card(w.key, 'ask:solved', 'Which store?', ['A', 'B'], at)
    src.settings.set('alerts.doneCommand', '~/bin/notify --done', 'machine')
    src.tellWaits(at)
    src.tellWaits(at + 180_000) // no advisor result: the margin tells it once
    expect(ran.filter((r) => r.command === '~/bin/notify')).toHaveLength(1)
    // the advisor answered while the human did not: the card is gone, and its record says who answered
    advice(w, 'ask:solved', 'sent', { auto: true })
    src.chats.answer(w.key, 'ask:solved', 0)
    src.tellWaits(at + 190_000)
    expect(ran.filter((r) => r.command === '~/bin/notify').map((r) => r.args[0])).toEqual([`Shepherdr · ${w.id} · Which store?`])
    expect(ran.filter((r) => r.command === '~/bin/notify --done').map((r) => r.args)).toEqual([[keyWords(`${w.key}:ask:solved`, at), 'The advisor answered']])
  })

  test('a wait the human answers marks it as answered', async () => {
    const w = await world('wa-answered')
    const at = Date.now()
    card(w.key, 'ask:answered', 'Which store?', ['A', 'B'], at)
    src.settings.set('alerts.doneCommand', '~/bin/notify --done', 'machine')
    src.tellWaits(at)
    src.tellWaits(at + 180_000)
    expect(ran.filter((r) => r.command === '~/bin/notify')).toHaveLength(1)
    src.chats.answer(w.key, 'ask:answered', 0)
    ;(src.engine.task(w.id) as unknown as { reported: unknown }).reported = 'done'
    src.tellWaits(at + 190_000)
    expect(ran.filter((r) => r.command === '~/bin/notify --done').map((r) => r.args)).toEqual([[keyWords(`${w.key}:ask:answered`, at), 'Answered']])
  })

  test('a relay that ends a told wait marks it with how it ended', async () => {
    const w = await world('wa-relay-end')
    const at = Date.now()
    card(w.key, 'ask:relayed', 'Which store?', ['A', 'B'], at)
    src.settings.set('alerts.doneCommand', '~/bin/notify --done', 'machine')
    src.tellWaits(at)
    src.tellWaits(at + 180_000)
    expect(ran.filter((r) => r.command === '~/bin/notify')).toHaveLength(1)
    reached(w.key, { kind: 'peer', id: 'peer-1', at: at + 190_000, text: 'Relayed from the operator: pick B.' })
    ;(src.engine.task(w.id) as unknown as { reported: unknown }).reported = 'done'
    src.tellWaits(at + 200_000)
    expect(ran.filter((r) => r.command === '~/bin/notify --done').map((r) => r.args)).toEqual([[keyWords(`${w.key}:ask:relayed`, at), 'Answered by another agent']])
  })

  test("a coordinator's card closed by a relay no longer waits, asks or alerts", async () => {
    const w = await world('wa-coord-relay')
    const at = Date.now()
    card(w.coord, 'ask:coord', 'Merge both now?', ['Yes', 'No'], at)
    expect(openCards(src.chats.chat(w.coord)).map((m) => m.question.id)).toEqual(['ask:coord'])
    expect(src.asks()[w.coord]).toBe('ask:coord')
    reached(w.coord, { kind: 'peer', id: 'peer-1', at: at + 1000, text: 'Relayed from the operator: yes, merge.' })
    // the same rule as a task's card, in Needs you, its counts and the coordinator's asks (POL-442)
    expect(openCards(src.chats.chat(w.coord))).toEqual([])
    expect(src.asks()[w.coord]).toBeUndefined()
    ;(src.engine.task(w.id) as unknown as { reported: unknown }).reported = 'done'
    src.tellWaits(at)
    src.tellWaits(at + 10_000)
    expect(ran).toEqual([])
  })

  test('a hidden note and an app answer close a card in Needs you and alerts, not just in the raw log', async () => {
    const w = await world('wa-hidden')
    const at = Date.now()
    card(w.key, 'ask:hidden', 'Which store?', ['A', 'B'], at)
    expect(openCards(src.chats.chat(w.key)).map((m) => m.question.id)).toEqual(['ask:hidden'])
    // the operator's notes on a page: Shepherdr hides them in a line the screen does not show
    reached(w.key, { kind: 'user', id: 'u-notes', at: at + 1000, text: '<shepherdr><browser from="Elias">Make the button say Save</browser></shepherdr>' })
    expect(src.chats.openCard(w.key)).toBeUndefined()
    expect(openCards(src.chats.chat(w.key))).toEqual([])
    // an answer sent from the app to another card is a posted line of yours, not a visible answer row either
    const v = await world('wa-app-answer')
    card(v.key, 'ask:app', 'Which name?', ['A', 'B'], at)
    expect(openCards(src.chats.chat(v.key)).map((m) => m.question.id)).toEqual(['ask:app'])
    src.chats.post(v.key, { id: 'cli-answer', who: 'you', answered: 'Answered “Allow: rm -rf build?”', at: at + 1000 } as never)
    expect(openCards(src.chats.chat(v.key))).toEqual([])
    for (const x of [w, v]) (src.engine.task(x.id) as unknown as { reported: unknown }).reported = 'done'
    src.tellWaits(at)
    src.tellWaits(at + 10_000)
    expect(ran.filter((r) => r.args[0]!.includes(w.id) || r.args[0]!.includes(v.id))).toEqual([])
  })

  test('Notify Off does not mark a still-open wait as ended', async () => {
    const w = await world('wa-notify-off')
    src.settings.set('alerts.doneCommand', '~/bin/notify --done', 'machine')
    const at = Date.now()
    card(w.coord, 'ask:off', 'Merge both now?', ['Yes', 'No'], at)
    src.tellWaits(at)
    src.tellWaits(at + 10_000)
    expect(ran.map((r) => r.command)).toEqual(['~/bin/notify'])
    // its space goes quiet: the card is still open, so nothing says it ended
    src.settings.set('notify', 'Off', { space: w.p.name })
    src.tellWaits(at + 20_000)
    expect(ran.map((r) => r.command)).toEqual(['~/bin/notify'])
    src.settings.set('notify', null, { space: w.p.name })
  })

  test('a menu card still open while its task reads Working is not marked ended or told twice', async () => {
    const w = await world('wa-menu-grace')
    const at = Date.now()
    const mid = `menu:${w.key}`
    src.chats.post(w.key, { id: mid, at, question: { id: mid, kind: 'Form', title: 'Allow: rm -rf build', terminal: true, choices: [{ label: 'Yes' }, { label: 'No' }], to: w.key } } as never)
    src.settings.set('alerts.doneCommand', '~/bin/notify --done', 'machine')
    src.tellWaits(at)
    src.tellWaits(at + 10_000)
    expect(ran.filter((r) => r.command === '~/bin/notify')).toHaveLength(1)
    // the human typed while the prompt is up: herdr holds the message, the task reads Working, the card stays open
    const wrote = (src.engine as unknown as { wrote: Map<string, number> }).wrote
    wrote.set(w.id, Date.now() + 60_000)
    src.tellWaits(at + 13_000)
    expect(ran.filter((r) => r.command === '~/bin/notify --done')).toEqual([])
    // when it needs you again, the same card does not alert a second time under a new key
    wrote.set(w.id, 0)
    src.tellWaits(at + 40_000)
    expect(ran.filter((r) => r.command === '~/bin/notify')).toHaveLength(1)
  })

  test('a declined terminal prompt is marked as dismissed, not answered', async () => {
    const w = await world('wa-menu-dismiss')
    const at = Date.now()
    const mid = `menu:${w.key}`
    src.chats.post(w.key, { id: mid, at, question: { id: mid, kind: 'Form', title: 'Allow: rm -rf build', terminal: true, choices: [{ label: 'Yes' }, { label: 'No' }], to: w.key } } as never)
    src.settings.set('alerts.doneCommand', '~/bin/notify --done', 'machine')
    src.tellWaits(at)
    src.tellWaits(at + 10_000)
    // Esc closes the terminal prompt: its card leaves the chat and the Dismiss line reaches the agent
    ;(src.chats as unknown as { menus: Map<string, unknown> }).menus.delete(w.key)
    src.chats.post(w.key, { id: 'menu-dismiss:1', who: 'you', answered: 'Dismissed “Allow: rm -rf build”', at: at + 11_000 } as never)
    ;(src.engine as unknown as { wrote: Map<string, number> }).wrote.set(w.id, Date.now() + 60_000)
    src.tellWaits(at + 13_000)
    expect(ran.filter((r) => r.command === '~/bin/notify --done').map((r) => r.args)).toEqual([[keyWords(`${w.key}:${mid}`, at), 'Dismissed']])
  })

  test('a dismissed card is marked as declined, not answered', async () => {
    const w = await world('wa-dismissed')
    const at = Date.now()
    card(w.key, 'ask:declined', 'Which store?', ['A', 'B'], at)
    src.settings.set('alerts.doneCommand', '~/bin/notify --done', 'machine')
    src.tellWaits(at)
    src.tellWaits(at + 180_000)
    src.chats.answer(w.key, 'ask:declined', -1, undefined, undefined, true)
    ;(src.engine.task(w.id) as unknown as { reported: unknown }).reported = 'done'
    src.tellWaits(at + 190_000)
    expect(ran.filter((r) => r.command === '~/bin/notify --done').map((r) => r.args)).toEqual([[keyWords(`${w.key}:ask:declined`, at), 'Dismissed']])
  })

  test("a coordinator's question is told, unless its space's Notify is Off; its tasks' are told either way", async () => {
    const w = await world('wa-coord')
    // its task is not here: a task whose agent is not running needs you too (the last test)
    src.engine.tasks.length = 0
    src.settings.set('advisor.after', 'off', { space: w.p.name })
    const at = Date.now()
    card(w.coord, 'ask:c1', 'Merge both now?', ['Yes', 'No'], at)
    src.tellWaits(at)
    src.tellWaits(at + 10_000)
    expect(ran.map((r) => r.args[0])).toEqual(["Shepherdr · wa-coord's coordinator · Merge both now?"])
    expect(ran[0]!.args[1]!.split('\n')[0]).toBe('wa-coord · its coordinator')
    const m = await world('wa-muted')
    src.settings.set('advisor.after', 'off', { space: m.p.name })
    expect(src.settings.set('notify', 'Off', { space: m.p.name }).ok).toBe(true)
    card(m.coord, 'ask:c2', 'Muted?', ['Yes', 'No'], at)
    card(m.key, 'ask:t2', 'Which name?', ['A', 'B'], at)
    src.tellWaits(at + 20_000)
    src.tellWaits(at + 30_000)
    expect(ran.slice(1).map((r) => r.args[0])).toEqual([`Shepherdr · ${m.id} · Which name?`])
    src.settings.set('notify', null, { space: m.p.name })
  })

  test('with the command off nothing is told, and what waited then is not told once it is on', async () => {
    const w = await world('wa-off')
    src.settings.set('alerts.command', null, 'machine')
    const at = Date.now()
    card(w.key, 'ask:o1', 'Which?', ['A', 'B'], at)
    src.tellWaits(at)
    src.tellWaits(at + 60_000)
    src.settings.set('alerts.command', '~/bin/notify', 'machine')
    src.tellWaits(at + 70_000)
    expect(ran).toEqual([])
  })

  test('a wait with no card (a task whose agent is not running): what it waits with, under Needs you', async () => {
    const w = await world('wa-words')
    src.tellWaits(1000)
    src.tellWaits(11_000)
    const told = ran.filter((r) => r.args[0]!.includes(w.id))
    expect(told.map((r) => r.args[0])).toEqual([`Shepherdr · ${w.id} · Needs you`])
    const lines = told[0]!.args[1]!.split('\n')
    expect(lines[0]).toBe(`wa-words · ${w.id}: Pick a store`)
    expect(lines[1]).toBe(src.engine.subOf(src.engine.task(w.id)!, 'need'))
  })
})

describe("every CLI's agent: its waits are told the same way", () => {
  for (const kind of ['claude', 'codex', 'pi', 'opencode', 'agy'])
    test(`a ${kind} agent: a question it asked, and its CLI's own permission screen`, async () => {
      const w = await world(`wa-${kind}`, kind)
      const at = Date.now()
      // a question through Shepherdr (shepherdr ask, or Claude Code's and Codex's own question tools, read as cards)
      card(w.key, `ask:${kind}`, 'Which name?', ['A', 'B'], at)
      // its CLI's own screen, read from its terminal as every CLI's is (screen.ts): a permission to grant
      src.chats.post(w.key, {
        id: `menu:${kind}`,
        at,
        question: { id: `menu:${kind}`, kind: 'Form', title: 'Allow: rm -rf build', terminal: true, choices: [{ label: 'Yes' }, { label: 'No' }], to: w.key },
      } as never)
      src.tellWaits(at)
      src.tellWaits(at + 10_000)
      src.tellWaits(at + 20_000)
      const mine = () => ran.filter((r) => r.args[0]!.includes(w.id)).map((r) => r.args[0])
      // the advisor has first refusal on the question; a permission is never its to answer, so that is the only alert
      expect(mine()).toEqual([`Shepherdr · ${w.id} · Allow: rm -rf build`])
      // once the advisor hands the question back, it is told too, with its reason and not the old "answers for you" line
      advice(w, `ask:${kind}`, 'human', { auto: true, advice: { human: 'unsure', by: 'pi' } })
      src.tellWaits(at + 30_000)
      expect(mine().sort()).toEqual([`Shepherdr · ${w.id} · Allow: rm -rf build`, `Shepherdr · ${w.id} · Which name?`])
      const reason = ran.find((r) => r.args[0]!.includes('Which name?'))!.args[1]!
      expect(reason).toContain('The advisor left this to you: unsure')
      expect(reason).not.toContain('the advisor answers for you')
    })
})

describe("another agent's message in every CLI's chat closes the card it reached", () => {
  for (const kind of ['claude', 'codex', 'pi', 'opencode', 'agy'])
    test(`a ${kind} agent: the relay is a peer row, so the card no longer waits or alerts`, async () => {
      const w = await world(`wa-relay-${kind}`, kind)
      const at = Date.now()
      card(w.key, `ask:${kind}`, 'Which name?', ['A', 'B'], at)
      expect(openCards(src.chats.chat(w.key)).map((m) => m.question.id)).toEqual([`ask:${kind}`])
      // how another agent's message lands in each CLI's log: Claude Code marks its own cross-session line as a peer;
      // the others get the envelope the sender typed into the pane, which the chat reads as a row naming that sender
      if (kind === 'claude') reached(w.key, { kind: 'peer', id: 'peer-1', at: at + 1000, text: 'Relayed from the operator: pick B.' })
      else reached(w.key, { kind: 'user', id: 'peer-1', at: at + 1000, text: fromAgentLine({ name: 'Another agent', to: `${w.id} agent` }, 'Relayed from the operator: pick B.') })
      const msgs = src.chats.chat(w.key).messages
      expect(msgs.some((m) => m.who === 'peer' && m.text?.includes('pick B'))).toBe(true)
      // the card is still in the chat, but the relay answered it: it is not open and not in Needs you
      expect(msgs.some((m) => m.question?.id === `ask:${kind}`)).toBe(true)
      expect(openCards(src.chats.chat(w.key))).toEqual([])
      // the card itself is gone from Needs you, not just the task after the agent moved on
      expect((src as unknown as { needs: () => { id: string }[] }).needs().some((n) => n.id === `ask:${kind}`)).toBe(false)
      // the relay woke the agent, which moved on: a task with no card left does not need the human either
      ;(src.engine.task(w.id) as unknown as { reported: unknown }).reported = 'done'
      src.tellWaits(at)
      src.tellWaits(at + 10_000)
      expect(ran.filter((r) => r.args[0]!.includes(w.id))).toEqual([])
    })
})
