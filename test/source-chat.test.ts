// The chat beside the command: choice cards, the needs-you cards, waiting on you, a task's progress, attachments and
// what you send showing at once, Send now, and a tile's small copy of a chat's picture or video.
import { afterAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('source')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
// no OpenCode database of this machine: its mirror copies rows from one that isn't there (an OpenCode log reads as a
// copy of its session)
process.env.SHEPHERDR_OPENCODE_DB = join(process.env.SHEPHERDR_HOME, 'no-opencode.db')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { herdr } = await import('../server/live/herdr.ts')
const { hidden } = await import('../server/live/agents.ts')
const { parseUserLine } = await import('../server/live/chatlines.ts')
const { Worktrees } = await import('../server/live/engine/worktrees.ts')
const { fakeHerdr } = await import('./fake-herdr.ts')

const src = new LiveSource()
// this file is not about the spacing between starts: with machine.startEvery's 2 minutes, the shared machine of these
// tests would start one task every two minutes (every start Shepherdr makes by itself follows it now, engine.startGate)
src.settings.set('machine.startEvery', '0', 'machine')
// herdr makes task worktrees: a stand-in on real git; no terminal opens for their agents (no herdr is there)
const fake = fakeHerdr()
fake.h.createTab = async () => {
  throw new Error('herdr is not here')
}
Object.assign(src.engine, { wt: new Worktrees(fake.h as never) })
afterAll(() => src.stop())

/** what a test waits for has come true, however slow the machine (a timer, another process) */
const until = async (f: () => boolean, ms = 8000, said = 'it') => {
  for (const t0 = Date.now(); !f(); await Bun.sleep(20)) if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${said}`)
}

/**
 * Something that only has to settle before the tests after this one (an agent herdr can't start): waited for at
 * most 8 s — the 20 s these tests run in is the other bound — and the test goes on either way, however slow the
 * machine. The fixed 5 s these had failed a slow runner; a longer wait would only spend a test's own time.
 */
const settle = (f: () => boolean, said: string) => until(f, 8000, said).catch(() => undefined)

/** a repo a test made, with its first commit (never the folder the tests run from) */
const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'

/**
 * The test's own git, bounded: 30 s, and a stalled one says which command it was, instead of bun taking the whole test
 * away with no word on the step (SHE-9 bounded the engine worlds' and herdr's stand-in after run 42020185856, but a
 * timeout there reads just "ETIMEDOUT", which names nothing either).
 */
const run = (cmd: string, cwd: string): string => {
  try {
    return execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8', timeout: 30_000 }).trim()
  } catch (e) {
    throw new Error(`\`${cmd}\` in ${cwd}: ${(e as Error).message.trim()}`, { cause: e })
  }
}

/** a project with a task whose agent has committed work on its branch (herdr isn't there: its agent can't start) */
async function workedTask(name: string) {
  const dir = tmp('src-repo')
  run(REPO, dir)
  const p = await src.places.add(dir, name)
  return { t: await worked(p), dir, place: placeId.space(p.name) }
}

/**
 * The worktree herdr's stand-in makes for a task, waited for until it is there or the start has said why it can't be —
 * so a start that never gets one fails with the app's own words, inside the 20 s a test has unless it says otherwise.
 */
async function worktree(t: { id: string; worktree?: string; trouble?: string }, ms = 15_000) {
  await until(() => !!t.worktree || !!t.trouble, ms, `${t.id}'s worktree`)
  if (!t.worktree) throw new Error(`${t.id} got no worktree: ${t.trouble}`)
}

/**
 * A task in a place already there, its agent's work committed on its branch (herdr isn't there: its agent can't
 * start). It waits for the worktree herdr's stand-in makes, so the commit never lands in a folder not there yet.
 */
async function worked(p: { name: string }, file = 'x.txt') {
  const t = src.engine.add({ project: p.name, title: 'Worked', by: 'test' })
  await worktree(t)
  run(`echo x > ${file} && git add -A && git commit -qm work`, t.worktree!)
  return t
}

describe('choice cards', () => {
  test('fast answers require an explicit ordinary question declaration', async () => {
    const chat = placeId.home()
    for (const ordinary of [false, true]) {
      const r = await src.cli(['ask', 'Which colour?', ...(ordinary ? ['--ordinary'] : []), '--choice', 'Blue', '--choice', 'Green'], { chat })
      expect(r.code).toBe(0)
      const q = src.chats.log(chat).posted.at(-1)!.question!
      expect(q.ordinary).toBe(ordinary || undefined)
      expect(q.choices.map((c) => c.label)).toEqual(['Blue', 'Green'])
      src.chats.answer(chat, q.id, 0)
    }
  })

  test('a typed reply closes the open card: the dot stops waiting and the card shows answered', async () => {
    const chat = placeId.home()
    const r = await src.cli(['ask', 'Rerun CI on main?', '--choice', 'Rerun it', '--choice', 'Leave it'], { chat })
    expect(r.out).toContain('Asked')
    const qid = src.asks()[chat]
    expect(qid).toStartWith('ask:')
    // herdr isn't running here, so the message itself may not go in; the card closes all the same
    await src.act({ type: 'send', chat, text: 'Leave it, I will look later' }).catch(() => undefined)
    expect(src.asks()[chat]).toBeUndefined()
    expect(src.chats.log(chat).answers[qid]).toBe(-1)
    const card = src.chats.chat(chat).messages.find((m) => m.question?.id === qid)
    // answered in chat, quoting your words: not as if an option was picked
    expect(card?.question).toMatchObject({ sent: -1, said: 'Leave it, I will look later', via: 'chat' })
  })

  test('an Other answer typed on the card is quoted, and sent from the card', async () => {
    const chat = placeId.home()
    await src.cli(['ask', 'Which branch?', '--choice', 'main', '--choice', 'next', '--other'], { chat })
    const qid = src.asks()[chat]
    await src.act({ type: 'answer', chat, question: qid, choice: -1, other: 'release-2' }).catch(() => undefined)
    const card = src.chats.chat(chat).messages.find((m) => m.question?.id === qid)
    expect(card?.question).toMatchObject({ sent: -1, said: 'release-2' })
    expect(card?.question?.via).toBeUndefined()
  })

  test('its Dismiss closes the card without an answer: the agent hears the person declined it, and it decides', async () => {
    const chat = placeId.home()
    await src.cli(['ask', 'Rerun CI on main?', '--choice', 'Rerun it', '--choice', 'Leave it'], { chat })
    const qid = src.asks()[chat]
    const told: string[] = []
    const send = src.agents.send
    src.agents.send = (async (k: string, text: string) => (k === chat && told.push(text), { waiting: false })) as never
    try {
      expect(await src.act({ type: 'answer', chat, question: qid, choice: -1, dismiss: true })).toMatchObject({ ok: true })
    } finally {
      src.agents.send = send
    }
    // no pick, and the card says dismissed rather than answered
    expect(src.chats.log(chat).answers[qid]).toBe(-1)
    const card = src.chats.chat(chat).messages.find((m) => m.question?.id === qid)?.question
    expect(card).toMatchObject({ sent: -1, dismissed: true })
    expect(card?.via).toBeUndefined()
    // it waits on you no longer, and the agent hears a decline it may decide past
    expect(src.asks()[chat]).toBeUndefined()
    const heard = told.join('\n')
    expect(heard).toContain('<dismissed')
    expect(heard).toContain('Rerun CI on main?')
    expect(heard).toContain('dismissed this without answering')
    expect(heard).toContain('carry on with your best judgment')
    // it is a dismissal of its own, never an answer carrying the agent's instructions as the person's words
    const line = told.find((t) => t.includes('<dismissed'))!
    expect(parseUserLine(line)).toMatchObject({ kind: 'dismiss', title: 'Rerun CI on main?' })
    // closed once: a second dismissal is refused
    expect(await src.act({ type: 'answer', chat, question: qid, choice: -1, dismiss: true })).toMatchObject({ ok: false })
  })

  test("its Dismiss closes that card alone: the chat's other cards still wait on you", async () => {
    const chat = placeId.home()
    await src.cli(['ask', 'First?', '--choice', 'A', '--choice', 'B'], { chat })
    await src.cli(['ask', 'Second?', '--choice', 'C', '--choice', 'D'], { chat })
    const open = src.chats.log(chat).posted.filter((p) => p.question?.id.startsWith('ask:') && p.question.sent === undefined).slice(-2)
    const [first, second] = open.map((p) => p.question!.id)
    const send = src.agents.send
    src.agents.send = (async () => ({ waiting: false })) as never
    try {
      expect(await src.act({ type: 'answer', chat, question: first, choice: -1, dismiss: true })).toMatchObject({ ok: true })
    } finally {
      src.agents.send = send
    }
    expect(src.chats.log(chat).answers[first]).toBe(-1)
    // the other card was not answered by the dismissal, and still waits
    expect(src.chats.log(chat).answers[second]).toBeUndefined()
    expect(src.asks()[chat]).toBe(second)
    src.chats.answer(chat, second, 0)
  })

  test("a plan's Dismiss is no approval, and the agent hears the plan isn't approved", async () => {
    const { t } = await workedTask('plandismiss')
    const key = `${t.id}/Agent`
    await src.engine.plan(t.id, ['Build it'])
    const qid = src.chats.log(key).posted.findLast((p) => p.question)!.question!.id
    expect(qid).toStartWith('plan:')
    const told: string[] = []
    const send = src.agents.send
    src.agents.send = (async (k: string, text: string) => (k === key && told.push(text), { waiting: false })) as never
    try {
      expect(await src.act({ type: 'answer', chat: key, question: qid, choice: -1, dismiss: true })).toMatchObject({ ok: true })
    } finally {
      src.agents.send = send
    }
    expect(src.chats.log(key).answers[qid]).toBe(-1)
    const card = src.chats.chat(key).messages.find((m) => m.question?.id === qid)?.question
    expect(card).toMatchObject({ sent: -1, dismissed: true })
    // never an approved plan: the card's own first choice is not what went in
    expect(card?.sent).not.toBe(0)
    expect(told.join('\n')).toContain("the plan isn't approved")
  })
})

describe("a coordinator's question", () => {
  test('sends no alert of its own (the main machine\'s home space picks what buzzes); a second answer is refused', async () => {
    const chat = placeId.home()
    const alerts: import('../shared/types.ts').Alert[] = []
    const off = src.on('alert', (a) => void alerts.push(a))
    try {
      await src.cli(['ask', 'Rerun CI?', '--choice', 'Rerun it', '--choice', 'Leave it'], { chat })
      const qid = src.asks()[chat]
      expect(alerts.filter((a) => a.tag === `ask:${chat}` || a.card)).toEqual([])
      await src.act({ type: 'answer', chat, question: qid, choice: 1 }).catch(() => undefined)
      expect(src.chats.log(chat).answers[qid]).toBe(1)
      // an old alert's button: refused, the answer stays
      expect(await src.act({ type: 'answer', chat, question: qid, choice: 0 })).toMatchObject({ ok: false })
      expect(src.chats.log(chat).answers[qid]).toBe(1)
    } finally {
      off()
    }
  })
})

describe("an alert's button", () => {
  test('answers only the card the chat still ends on; the app may still answer it', async () => {
    const chat = placeId.home()
    await src.cli(['ask', 'Ship it?', '--choice', 'Ship', '--choice', 'Wait'], { chat })
    const qid = src.asks()[chat]
    // something came after the card (an answer in words that leaves it open)
    src.chats.post(chat, { id: 'later', who: 'you', text: 'Hold on, one more thing' })
    expect(await src.act({ type: 'answer', chat, question: qid, choice: 0, fromAlert: true })).toMatchObject({ ok: false })
    expect(src.chats.log(chat).answers[qid]).toBeUndefined()
    await src.act({ type: 'answer', chat, question: qid, choice: 1 }).catch(() => undefined)
    expect(src.chats.log(chat).answers[qid]).toBe(1)
  })
})

describe("a coordinator's alert about a task", () => {
  test('says what the task needs, then the why, in place of the task\'s own alert', async () => {
    const { t } = await workedTask('alerted')
    await until(() => src.engine.statusOf(t) === 'need', 8000, `${t.id} to need you`)
    expect(src.engine.statusOf(t)).toBe('need')
    const alerts: import('../shared/types.ts').Alert[] = []
    const off = src.on('alert', (a) => void alerts.push(a))
    try {
      await src.cli(['alert', 'Needs a look', '--body', 'It could not start', '--task', t.id], { chat: placeId.home() })
    } finally {
      off()
    }
    const a = alerts.at(-1)!
    expect(a).toMatchObject({ from: 'Shepherdr', tag: t.id, go: { task: t.id } })
    expect(a.title).toStartWith(`${t.id} · `)
    expect(a.body).toEndWith('\nhome: Needs a look: It could not start')
  })
})

describe("a task's question on its needs-you card in its space's chat", () => {
  const engine = () => src.engine as unknown as { emit(e: string, ...a: unknown[]): void }
  const told = (place: string) => {
    const said: string[] = []
    const send = src.agents.send
    src.agents.send = (async (k: string, text: string) => (k === place && said.push(text), { waiting: false })) as never
    return { said, off: () => void (src.agents.send = send) }
  }

  test('a choice card answered on the card: it goes to the task, both copies say where, the coordinator hears it', async () => {
    const { t, place } = await workedTask('askcopy')
    await until(() => src.engine.statusOf(t) === 'need')
    const key = `${t.id}/Agent`
    await src.cli(['ask', 'Which colour?', '--choice', 'Blue', '--choice', 'Green'], { chat: key })
    const qid = src.chats.log(key).posted.findLast((p) => p.question)!.question!.id
    engine().emit('card', t, 'need', 'Question for you')
    // kept on the card as it goes up, before anyone opens the space's chat
    expect(src.chats.log(place).posted.findLast((p) => p.card?.task === t.id)?.card?.ask?.questions?.[0]?.id).toBe(qid)
    const card = () => src.chat(place)!.messages.findLast((m) => m.card?.task === t.id)!.card!
    expect(card().ask).toMatchObject({ chat: key, open: true, questions: [{ id: qid, title: 'Which colour?', choices: [{ label: 'Blue' }, { label: 'Green' }] }] })
    const { said, off } = told(place)
    try {
      await src.act({ type: 'answer', chat: key, question: qid, choice: 1, space: place }).catch(() => undefined)
    } finally {
      off()
    }
    expect(src.chats.log(key).answers[qid]).toBe(1)
    expect(card().ask).toMatchObject({ open: false, answered: { where: 'space' }, questions: [{ sent: 1, elsewhere: { label: 'Answered here ·', chat: key, name: `${t.id} chat` } }] })
    expect(src.chats.chat(key).messages.find((m) => m.question?.id === qid)?.question).toMatchObject({ sent: 1, elsewhere: { label: 'Answered in', chat: place } })
    expect(said.join('\n')).toContain("don't answer it too")
    // answered once: the task's own chat can't answer it again
    expect(await src.act({ type: 'answer', chat: key, question: qid, choice: 0 })).toMatchObject({ ok: false })
  })

  test('dismissed on the card: both copies say Dismissed, and the coordinator hears a decline, not an answer', async () => {
    const { t, place } = await workedTask('askdismiss')
    await until(() => src.engine.statusOf(t) === 'need')
    const key = `${t.id}/Agent`
    await src.cli(['ask', 'Which colour?', '--choice', 'Blue', '--choice', 'Green'], { chat: key })
    const qid = src.chats.log(key).posted.findLast((p) => p.question)!.question!.id
    engine().emit('card', t, 'need', 'Question for you')
    const card = () => src.chat(place)!.messages.findLast((m) => m.card?.task === t.id)!.card!
    expect(card().ask).toMatchObject({ chat: key, open: true })
    const { said, off } = told(place)
    try {
      await src.act({ type: 'answer', chat: key, question: qid, choice: -1, dismiss: true, space: place }).catch(() => undefined)
    } finally {
      off()
    }
    expect(card().ask).toMatchObject({ open: false, answered: { where: 'space', dismissed: true }, questions: [{ sent: -1, dismissed: true, elsewhere: { label: 'Dismissed ·', chat: key, name: `${t.id} chat` } }] })
    expect(src.chats.chat(key).messages.find((m) => m.question?.id === qid)?.question).toMatchObject({ sent: -1, dismissed: true, elsewhere: { label: 'Dismissed in' } })
    // the space's coordinator hears the person declined it, never that they answered
    expect(said.join('\n')).toContain('dismissed')
    expect(said.join('\n')).not.toContain("don't answer it too")
  })

  test('answered in the task chat instead: the card follows, and says where', async () => {
    const { t, place } = await workedTask('askthere')
    await until(() => src.engine.statusOf(t) === 'need')
    const key = `${t.id}/Agent`
    await src.cli(['ask', 'Ship it?', '--choice', 'Ship', '--choice', 'Wait'], { chat: key })
    const qid = src.chats.log(key).posted.findLast((p) => p.question)!.question!.id
    engine().emit('card', t, 'need', 'Question for you')
    const card = () => src.chat(place)!.messages.findLast((m) => m.card?.task === t.id)!.card!
    expect(card().ask?.open).toBe(true)
    await src.act({ type: 'answer', chat: key, question: qid, choice: 0 }).catch(() => undefined)
    expect(card().ask).toMatchObject({ open: false, answered: { where: 'task' }, questions: [{ sent: 0, elsewhere: { label: 'Answered in', chat: key } }] })
    // a card from another space can't answer for it
    expect(await src.act({ type: 'answer', chat: key, question: qid, choice: 1, space: placeId.home() })).toMatchObject({ ok: false })
  })

  test('a plain question: its words and a reply that goes to the task', async () => {
    const { t, place } = await workedTask('askplain')
    await until(() => src.engine.statusOf(t) === 'need')
    const key = `${t.id}/Agent`
    src.chats.post(key, { id: 'plain-q', text: 'Keep the old API around?' })
    // its question cut to a status line, as the task's row shows it
    engine().emit('card', t, 'need', 'Keep the old API around?')
    const card = () => src.chat(place)!.messages.findLast((m) => m.card?.task === t.id)!.card!
    expect(card().ask).toMatchObject({ chat: key, open: true, reply: { id: 'plain-q', text: 'Keep the old API around?' } })
    const { said, off } = told(place)
    try {
      await src.act({ type: 'send', chat: key, text: 'Yes, one more release', reply: 'plain-q', space: place }).catch(() => undefined)
    } finally {
      off()
    }
    expect(card().ask).toMatchObject({ open: false, answered: { where: 'space', text: 'Yes, one more release' } })
    expect(said.join('\n')).toContain("don't answer it too")
    // another screen still showing the card can't send it twice
    expect(await src.act({ type: 'send', chat: key, text: 'Yes', reply: 'plain-q', space: place })).toMatchObject({ ok: false })
  })

  test('a plain question dismissed: the agent hears the decline, and its card says so', async () => {
    const { t, place } = await workedTask('askplainno')
    await until(() => src.engine.statusOf(t) === 'need')
    const key = `${t.id}/Agent`
    src.chats.post(key, { id: 'plain-dismiss', text: 'Keep the old API around?' })
    engine().emit('card', t, 'need', 'Keep the old API around?')
    const card = () => src.chat(place)!.messages.findLast((m) => m.card?.task === t.id)!.card!
    expect(card().ask).toMatchObject({ chat: key, open: true, reply: { id: 'plain-dismiss' } })
    const heard: string[] = []
    const send = src.agents.send
    src.agents.send = (async (k: string, text: string) => (k === key && heard.push(text), { waiting: false })) as never
    try {
      expect(await src.act({ type: 'answer', chat: key, question: 'plain-dismiss', choice: -1, dismiss: true, space: place })).toMatchObject({ ok: true })
    } finally {
      src.agents.send = send
    }
    expect(heard.join('\n')).toContain('<dismissed')
    expect(heard.join('\n')).toContain('Keep the old API around?')
    expect(card().ask).toMatchObject({ open: false, answered: { where: 'space', dismissed: true } })
    // its own dismissal line is there now (as the agent's log would show it): a second one goes nowhere
    src.chats.post(key, { id: 'a-dismissal', who: 'you', answered: 'Dismissed “Keep the old API around?”' })
    expect(await src.act({ type: 'answer', chat: key, question: 'plain-dismiss', choice: -1, dismiss: true, space: place })).toMatchObject({ ok: false })
  })
})

describe('waiting on you', () => {
  test("a coordinator blocked on its CLI's own menu waits on you, like an open card: the sidebar counts it", () => {
    const chat = placeId.home()
    const agents = src.agents as unknown as { status: (k: string) => string }
    const status = agents.status
    agents.status = (k) => (k === chat ? 'blocked' : status.call(src.agents, k))
    try {
      const s = src.snapshot()
      expect(s.asks[chat]).toBe('blocked')
      expect(s.places[0].status).toBe('need')
    } finally {
      agents.status = status
    }
    expect(src.snapshot().asks[chat]).toBeUndefined()
  })
})

describe("a task's own progress (shepherdr status)", () => {
  test('its agent reports a line, % done and time left; the task shows it while it works, frozen while it waits on you, gone once done', async () => {
    const { t } = await workedTask('reported')
    const other = await workedTask('reported2')
    const key = `${t.id}/Agent`
    const agents = src.agents as unknown as { status: (k: string) => string }
    const { status } = agents
    let st = 'working'
    agents.status = (k) => (k === key ? st : status.call(src.agents, k))
    const view = () => src.snapshot().tasks.find((x) => x.id === t.id)!
    try {
      // herdr isn't here, so its agent couldn't start: say it did
      t.trouble = undefined
      src.engine.agentStatus(key)
      expect(view().status).toBe('work')
      const no = await src.cli(['status', other.t.id, 'Fixing', '--done', '10'], { chat: key })
      expect(no.code).toBe(1)
      expect(no.out).toContain('only its own task')
      expect((await src.cli(['status', t.id, 'Fixing'], { chat: key })).out).toContain('--done <0-100>')
      expect((await src.cli(['status', t.id, 'Fixing', '--done', '140'], { chat: key })).code).toBe(1)
      expect((await src.cli(['status', t.id, 'Fixing', '--done', '10', '--left', 'soon'], { chat: key })).out).toContain('--left takes a time')
      expect((await src.cli(['status', t.id, 'Fixing', '--done', '10', '--left', '200h'], { chat: key })).out).toContain('up to 99h')
      expect((await src.cli(['status', t.id, 'Fixing', '--done', '10', '--left'], { chat: key })).code).toBe(1)
      expect((await src.cli(['status', t.id, ',,, ,,,', '--done', '10'], { chat: key })).out).toContain('in words')
      const r = await src.cli(['status', t.id, 'Fixing the two failing tests', '--done', '40%', '--left', '1h20m'], { chat: key })
      expect(r.out).toBe(`Noted: ${t.id} shows "Fixing the two failing tests", 40% done, about 80 min left.\n`)
      expect(view().report).toEqual({ msg: 'Fixing the two failing tests', progress: 40, eta: 80, paused: undefined })
      // the CLI's task list shows its own line while it works
      expect((await src.cli(['task', 'list'], {})).out).toContain(`${t.id}    work  Worked  · Fixing the two failing tests`)
      // the minutes count down while it works, and at the cadence the line reads as older
      t.report!.at -= 5 * 60_000
      expect(view().report!.eta).toBe(75)
      expect(view().report!.stale).toBe(5)
      // waiting on you: frozen, and the time it waits does not count
      st = 'blocked'
      src.engine.agentStatus(key)
      expect(view().report).toMatchObject({ progress: 40, eta: 75, paused: true })
      // ten minutes go by while it waits
      t.report!.at -= 10 * 60_000
      t.report!.pausedAt! -= 10 * 60_000
      expect(view().report!.eta).toBe(75)
      st = 'working'
      src.engine.agentStatus(key)
      expect(view().report).toEqual({ msg: 'Fixing the two failing tests', progress: 40, eta: 75, paused: undefined, stale: 5 })
      // a line too long is cut at a word, and it says so; no --left, no minutes
      const long = await src.cli(['status', t.id, 'Rebasing onto main and running every check again', '--done', '90'], { chat: key })
      expect(long.out).toBe(`Noted: ${t.id} shows "Rebasing onto main and running every" (cut to 40 characters), 90% done.\n`)
      expect(view().report!.eta).toBeUndefined()
      // done: its job is over, and so is its report
      st = 'idle'
      await src.cli(['done', t.id, '--summary', 'Fixed'], { chat: key })
      expect(view().status).toBe('ready')
      expect(view().report).toBeUndefined()
      expect(t.report).toBeUndefined()
      // Ready: a report would show nothing now, and come back stale later
      expect((await src.cli(['status', t.id, 'Tidying up', '--done', '99'], { chat: key })).out).toContain('is Ready')
      expect(t.report).toBeUndefined()
      // with no id it still says how Shepherdr is
      expect((await src.cli(['status'], {})).out).toContain('Shepherdr on ')
    } finally {
      agents.status = status
    }
  })
})

describe('attachments', () => {
  const chat = placeId.home()
  /** what the human sent, as the CLI's log has it */
  const said = (id: string, text: string) => {
    const ev = (src.chats as unknown as { events: Map<string, unknown[]> }).events
    ev.set(chat, [...(ev.get(chat) ?? []), { kind: 'user', id, at: Date.now(), text }])
  }
  const attach = (name: string, path: string) => `<attachment from="Elias" name="${name}" path="${path}"/>`

  test('each file is a message of its own, right after the text it came with', async () => {
    const shot = await src.upload(chat, 'shot.png', new Uint8Array([1, 2, 3]))
    const notes = await src.upload(chat, 'notes.pdf', new Uint8Array([4]))
    said('u1', `Look at this\n${attach('shot.png', shot)}\n${attach('notes.pdf', notes)}`)
    // the same name again, a new file
    const again = await src.upload(chat, 'shot.png', new Uint8Array([9]))
    expect(again).not.toBe(shot)
    said('u2', attach('shot.png', again))
    const msgs = src.chats.chat(chat).messages.filter((m) => m.id.startsWith('u'))
    expect(msgs.map((m) => [m.id, m.text ?? m.file?.name])).toEqual([
      ['u1', 'Look at this'],
      ['u1:0', 'shot.png'],
      ['u1:1', 'notes.pdf'],
      ['u2', 'shot.png'],
    ])
    expect(msgs[1].file?.path).toBe(shot)
  })
  test('an upload writes its bytes under a sanitized name', async () => {
    const path = await src.upload(chat, '../../evil?.png', new Uint8Array([1, 2, 3]))
    expect(basename(path)).toContain('-.._.._evil_.png')
    expect(basename(path)).not.toContain('/')
    expect(existsSync(path)).toBe(true)
    expect(await (await src.attachment(chat, path))?.bytes()).toEqual(new Uint8Array([1, 2, 3]))
  })
  test('a reaction to a file lands on that file, not on a later one of the same name', async () => {
    const first = src.chats.chat(chat).messages.find((x) => x.id === 'u1:0')!
    // what a tap sends names the file by its path
    const sent: string[] = []
    const send = src.agents.send
    src.agents.send = (async (_k: string, text: string) => (sent.push(text), { waiting: false })) as typeof send
    try {
      expect(await src.act({ type: 'react', chat, message: first.id, emoji: '❤️' })).toEqual({})
    } finally {
      src.agents.send = send
    }
    expect(sent).toEqual([`<reaction from="${src.user}" emoji="❤️" file="shot.png" path="${first.file!.path}"/>`])
    // and read back from the log, it marks the first shot.png (u2 is a later one)
    said('u3', sent[0])
    // the agent's own reaction to it, too
    const ev = (src.chats as unknown as { events: Map<string, unknown[]> }).events
    ev.get(chat)!.push({ kind: 'agent', id: 'a3', at: Date.now(), text: `<react emoji="👀" file="shot.png" path="${first.file!.path}"/>\nLooking.` })
    const msgs = src.chats.chat(chat).messages
    expect(msgs.find((x) => x.id === 'u1:0')?.reactions).toEqual([{ emoji: '❤️', by: 'me' }, { emoji: '👀', by: 'them' }])
    expect(msgs.find((x) => x.id === 'u2')?.reactions).toBeUndefined()
    // a line naming only the file (an older one) goes to the latest of that name
    said('u3c', '[Elias reacted 🎉 to "notes.pdf"]')
    expect(src.chats.chat(chat).messages.find((x) => x.id === 'u1:1')?.reactions).toEqual([{ emoji: '🎉', by: 'me' }])
  })
  test('a reply goes in quoting the message it answers, and reads back as a quote that jumps to it', async () => {
    const ev = (src.chats as unknown as { events: Map<string, unknown[]> }).events
    ev.get(chat)!.push({ kind: 'agent', id: 'r1', at: Date.now(), text: 'Tests pass on the branch. Want me to merge?' })
    const sent: string[] = []
    const send = src.agents.send
    src.agents.send = (async (_k: string, text: string) => (sent.push(text), { waiting: false })) as typeof send
    try {
      await src.act({ type: 'send', chat, text: 'Yes\nmerge it', reply: 'r1', cid: 'cr1' })
      // a message no longer there: the words go plain
      await src.act({ type: 'send', chat, text: 'Plain', reply: 'gone' })
    } finally {
      src.agents.send = send
    }
    expect(sent).toEqual([`<reply from="${src.user}" to="Tests pass on the branch. Want me to merge?">Yes\nmerge it</reply>`, 'Plain'])
    said('r2', sent[0])
    // the agent answers your reply with one of its own, quoting your words
    ev.get(chat)!.push({ kind: 'agent', id: 'r3', at: Date.now(), text: '<reply to="Yes merge it"/>\nMerged.' })
    // a reply to a file, with a file of its own and no words
    said('r4', `<reply from="Elias" to="shot.png"></reply>\n${attach('b.png', '/inbox/b.png')}`)
    const msgs = src.chats.chat(chat).messages
    const r2 = msgs.find((m) => m.id === 'r2')!
    expect(r2.text).toBe('Yes\nmerge it')
    expect(r2.reply).toEqual({ id: 'r1', who: 'agent', text: 'Tests pass on the branch. Want me to merge?' })
    expect(msgs.find((m) => m.id === 'r3')).toMatchObject({ text: 'Merged.', reply: { id: 'r2', who: 'you', text: 'Yes merge it' } })
    expect(msgs.find((m) => m.id === 'r4')).toMatchObject({ file: { name: 'b.png' }, reply: { who: 'you', text: 'shot.png', file: true } })
    // a quote of something no longer in the chat still shows, without a way to jump
    // (an older bracket line, from a log kept before tags)
    said('r5', '[Elias replied to "Long gone": Still?]')
    expect(src.chats.chat(chat).messages.find((m) => m.id === 'r5')).toMatchObject({ text: 'Still?', reply: { text: 'Long gone' } })
    expect(src.chats.chat(chat).messages.find((m) => m.id === 'r5')?.reply?.id).toBeUndefined()
    // a reply to an older "Done." keeps to it, though a newer one starts the same way
    ev.get(chat)!.push({ kind: 'agent', id: 'd1', at: Date.now(), text: 'Done.' }, { kind: 'agent', id: 'd2', at: Date.now(), text: 'Done.' })
    const sent2: string[] = []
    src.agents.send = (async (_k: string, text: string) => (sent2.push(text), { waiting: false })) as typeof send
    try {
      await src.act({ type: 'send', chat, text: 'Which one?', reply: 'd1' })
    } finally {
      src.agents.send = send
    }
    said('d3', sent2[0])
    expect(src.chats.chat(chat).messages.find((m) => m.id === 'd3')?.reply?.id).toBe('d1')
  })
  test('only files attached in that chat, from the inbox, are served', async () => {
    const shot = src.chats.chat(chat).messages.find((x) => x.id === 'u1:0')!.file!.path
    expect(await (await src.attachment(chat, shot))?.bytes()).toEqual(new Uint8Array([1, 2, 3]))
    // not in this chat
    expect(await src.attachment(placeId.space('elsewhere'), shot)).toBeNull()
    // never attached
    expect(await src.attachment(chat, join(process.env.SHEPHERDR_HOME!, 'config.json'))).toBeNull()
    // attached, but leading out of the inbox: by dots or by a link
    const secret = join(process.env.SHEPHERDR_HOME!, 'secret.txt')
    writeFileSync(secret, 'no')
    const dots = join(process.env.SHEPHERDR_HOME!, 'inbox', 'x', '..', '..', 'secret.txt')
    mkdirSync(join(process.env.SHEPHERDR_HOME!, 'inbox', 'x'), { recursive: true })
    const link = join(process.env.SHEPHERDR_HOME!, 'inbox', 'x', 'mf1-link.txt')
    symlinkSync(secret, link)
    said('u4', `${attach('secret.txt', dots)}\n${attach('link.txt', link)}`)
    expect(await src.attachment(chat, dots)).toBeNull()
    expect(await src.attachment(chat, link)).toBeNull()
  })
  test('a file still in the message box shows there before it is sent, in its own chat only', async () => {
    const waiting = await src.upload(chat, 'draft.png', new Uint8Array([5]))
    expect(await (await src.attachment(chat, waiting))?.bytes()).toEqual(new Uint8Array([5]))
    expect(await src.attachment(placeId.space('elsewhere'), waiting)).toBeNull()
    // another file in that chat's inbox folder that leads out of it by a link is still refused
    const secret = join(process.env.SHEPHERDR_HOME!, 'secret2.txt')
    writeFileSync(secret, 'no')
    const link = join(waiting, '..', 'mf2-link.txt')
    symlinkSync(secret, link)
    expect(await src.attachment(chat, link)).toBeNull()
  })

  test("an agent's own picture is taken into the chat's inbox and shows as a message of its own", async () => {
    const shot = join(tmp('attach'), 'shot.png')
    writeFileSync(shot, new Uint8Array([7, 7, 7, 7]))
    const r = await src.cli(['attach', shot, '--caption', 'The keyboard up, and the button above it'], { chat })
    expect(r.code).toBe(0)
    expect(r.out).toContain('Posted a picture in your chat')
    const msgs = src.chats.chat(chat).messages.filter((m) => m.id.startsWith('media:'))
    expect(msgs.map((m) => m.text ?? m.file?.name)).toEqual(['The keyboard up, and the button above it', 'shot.png'])
    // a copy of its own in the chat's folder, not the file it was (that one is in a worktree or /tmp)
    const media = msgs[1].file!
    expect(media.path).not.toBe(shot)
    expect(dirname(media.path)).toBe(join(process.env.SHEPHERDR_HOME!, 'inbox', chat.replace(/[^a-zA-Z0-9_.-]+/g, '_')))
    expect(new Uint8Array(await Bun.file(media.path).arrayBuffer())).toEqual(new Uint8Array([7, 7, 7, 7]))
    // it is served as the chat's own file, copied before it was named, so deleting the chat takes both away
    expect(await (await src.attachment(chat, media.path))?.bytes()).toEqual(new Uint8Array([7, 7, 7, 7]))
    // and only in that chat
    expect(await src.attachment(placeId.space('elsewhere'), media.path)).toBeNull()
    // nothing else the machine holds is served, whatever a reply names: the file it came from is outside the inbox
    expect(await src.attachment(chat, shot)).toBeNull()
  })
  test('attach refuses what the chat cannot draw, and asks for an agent of Shepherdr', async () => {
    const dir = tmp('attach')
    writeFileSync(join(dir, 'notes.txt'), 'words')
    expect((await src.cli(['attach', join(dir, 'notes.txt')], { chat })).out).toContain('is neither a picture nor a video')
    expect((await src.cli(['attach', join(dir, 'gone.png')], { chat })).out).toContain('No file ')
    // no path: the pictures and the videos of the folder it runs in
    writeFileSync(join(dir, 'shot.png'), new Uint8Array([1]))
    expect((await src.cli(['attach'], { chat, cwd: dir })).out).toContain('Here: shot.png')
    // the human's own terminal is not a chat to post into
    expect((await src.cli(['attach', join(dir, 'shot.png')], {})).out).toContain('works from an agent Shepherdr started')
  })
})

describe('what you send shows at once', () => {
  const chat = placeId.home()
  const said = (id: string, text: string, at = Date.now()) => {
    const ev = (src.chats as unknown as { events: Map<string, unknown[]> }).events
    ev.set(chat, [...(ev.get(chat) ?? []), { kind: 'user', id, at, text }])
  }
  /** the agent's state for a while, as herdr would say it */
  const as = async <T,>(st: string, fn: () => Promise<T>) => {
    const status = src.agents.status
    src.agents.status = () => st as ReturnType<typeof status>
    try {
      return await fn()
    } finally {
      src.agents.status = status
    }
  }
  test("an agent that won't start, or won't take it, is an error the screen shows, not a wait", async () => {
    // what earlier tests left waiting
    src.agents.outbox = src.agents.outbox.filter((o) => o.key !== chat)
    // herdr isn't running here: the agent can't be started
    await expect(src.act({ type: 'send', chat, text: 'Hello?', cid: 'c0' })).rejects.toThrow(/herdr|agent/)
    // ready, but typing it in fails
    await as('idle', async () => {
      await expect(src.act({ type: 'send', chat, text: 'Hello?', cid: 'c0' })).rejects.toThrow("The agent didn't take it")
    })
    expect(src.agents.waiting(chat).some((o) => o.cid === 'c0')).toBe(false)
  })
  test('one that waited and then could not go in fails in the chat; sent again, it is on its way once more', async () => {
    src.agents.outbox = src.agents.outbox.filter((o) => o.key !== chat)
    expect(await as('blocked', () => src.act({ type: 'send', chat, text: 'Later', cid: 'c9' }))).toMatchObject({ waiting: true })
    // the agent is ready, but typing it in fails
    await as('idle', () => src.agents.deliver(chat))
    const c = src.chats.chat(chat)
    expect(c.messages.some((m) => m.cid === 'c9')).toBe(false)
    expect(c.failed).toEqual([{ cid: 'c9', error: expect.stringContaining("The agent didn't take it") }])
    await as('blocked', () => src.act({ type: 'send', chat, text: 'Later', cid: 'c9' }))
    expect(src.chats.chat(chat).failed).toBeUndefined()
    src.agents.outbox = src.agents.outbox.filter((o) => o.key !== chat)
  })
  test("it comes back with the screen's id: while it waits, and once the log has it", async () => {
    // an agent on a menu: it waits, and says why
    const r = (await as('blocked', () => src.act({ type: 'send', chat, text: 'Ship  it\nnow', cid: 'c1' }))) as { waiting: boolean; at: number }
    expect(r.waiting).toBe(true)
    expect(Math.abs(r.at - Date.now())).toBeLessThan(5000)
    expect(r).toMatchObject({ waitsFor: 'menu' })
    const shown = await as('blocked', async () => src.chats.chat(chat).messages.filter((m) => m.cid === 'c1'))
    expect(shown.map((m) => [m.text, m.waiting, m.waitsFor])).toEqual([['Ship  it\nnow', true, 'menu']])
    // the screen heard no answer and sends it again: it still goes in once
    await as('blocked', () => src.act({ type: 'send', chat, text: 'Ship  it\nnow', cid: 'c1' }))
    expect(src.agents.waiting(chat).filter((o) => o.cid === 'c1')).toHaveLength(1)
    // it goes in, and the log has it with its own spacing: the message keeps the id
    const item = src.agents.outbox.find((o) => o.cid === 'c1')!
    src.agents.outbox = src.agents.outbox.filter((o) => o !== item)
    ;(src.agents as unknown as { went(o: typeof item): void }).went(item)
    said('s1', 'Ship it\n now')
    const back = src.chats.chat(chat).messages.filter((m) => m.cid === 'c1')
    expect(back.map((m) => [m.id, m.waiting])).toEqual([['s1', undefined]])
    // the same words again, typed in the terminal, are not it: the id went to the first
    said('s2', 'Ship it now')
    expect(src.chats.chat(chat).messages.find((m) => m.id === 's2')?.cid).toBeUndefined()
  })
  test('one waiting on a menu fails once the agent is gone or herdr out of reach for a while', async () => {
    const agents = src.agents
    for (const [lost, error] of [
      [false, 'The agent stopped before it went in.'],
      [true, 'Lost herdr before it went in.'],
    ] as const) {
      agents.outbox = agents.outbox.filter((o) => o.key !== chat)
      const cid = `strand-${lost}`
      await as('blocked', () => src.act({ type: 'send', chat, text: 'Later', cid }))
      // the agent stops, or herdr goes away while the agent was working
      const reachable = agents.reachable
      agents.reachable = !lost
      try {
        await as(lost ? 'blocked' : 'gone', async () => {
          const t = Date.now()
          agents.checkStranded(t)
          // a moment gone (the agent starting again) is no reason yet
          agents.checkStranded(t + 10_000)
          expect(agents.waiting(chat).some((o) => o.cid === cid)).toBe(true)
          agents.checkStranded(t + agents.strandAfter)
        })
      } finally {
        agents.reachable = reachable
      }
      expect(agents.waiting(chat).some((o) => o.cid === cid)).toBe(false)
      expect(src.chats.chat(chat).failed).toContainEqual({ cid, error })
    }
    // back while it waited: it goes on waiting
    const reachable = agents.reachable
    agents.reachable = true
    await as('blocked', () => src.act({ type: 'send', chat, text: 'Later', cid: 'back' }))
    await as('gone', async () => agents.checkStranded(Date.now()))
    await as('blocked', async () => agents.checkStranded(Date.now() + agents.strandAfter))
    expect(agents.waiting(chat).some((o) => o.cid === 'back')).toBe(true)
    agents.reachable = reachable
    agents.outbox = agents.outbox.filter((o) => o.key !== chat)
  })
  test('requester news survives offline timeouts and keeps a receipt across Agents restart', async () => {
    const agents = src.agents
    const cid = `requested-news:restart-${Date.now()}`
    await as('blocked', () => agents.send(chat, hidden('Task is ready', 'news'), { cid }))
    const reachable = agents.reachable
    agents.reachable = false
    try {
      agents.checkStranded(Date.now())
      agents.checkStranded(Date.now() + agents.strandAfter + 1)
      expect(agents.waiting(chat).some((o) => o.cid === cid)).toBe(true)
      const item = agents.outbox.find((o) => o.cid === cid)!
      ;(agents as unknown as { fail(key: string, error: string): void }).fail(chat, 'offline')
      expect(agents.outbox).toContain(item)
      // This is the actual delivery bookkeeping, which must outlive a process restart.
      ;(agents as unknown as { went(o: typeof item): void }).went(item)
      agents.save() // simulate a crash after receipt, before removing the queued copy
      agents.flushRecords()
      const { Agents } = await import('../server/live/agents.ts')
      const restarted = new Agents()
      try {
        await restarted.deliver(chat)
        expect((await restarted.send(chat, item.text, { cid })).waiting).toBe(false)
        expect(restarted.waiting(chat).some((o) => o.cid === cid)).toBe(false)
      } finally { restarted.stop() }
      agents.outbox = agents.outbox.filter((o) => o !== item)
      agents.save()
    } finally { agents.reachable = reachable }
  })
  test('sent again while the first is still on its way, it goes in once', async () => {
    const agents = src.agents
    agents.outbox = agents.outbox.filter((o) => o.key !== chat)
    const prompt = herdr.prompt
    const record = agents.records[chat]
    agents.records[chat] = { ...(record ?? {}), key: chat, name: 'held' } as (typeof agents.records)[string]
    let typed = 0
    let let_go!: () => void
    herdr.prompt = (async () => {
      typed++
      await new Promise<void>((r) => (let_go = r))
    }) as typeof prompt
    try {
      await as('idle', async () => {
        const first = src.act({ type: 'send', chat, text: 'Once', cid: 'twice' })
        await new Promise((r) => setTimeout(r, 10))
        const second = src.act({ type: 'send', chat, text: 'Once', cid: 'twice' })
        await new Promise((r) => setTimeout(r, 10))
        let_go()
        expect(await first).toMatchObject({ waiting: false })
        expect(await second).toMatchObject({ waiting: false })
        // and once it is in, a third goes nowhere either
        await src.act({ type: 'send', chat, text: 'Once', cid: 'twice' })
      })
    } finally {
      herdr.prompt = prompt
      if (record) agents.records[chat] = record
      else delete agents.records[chat]
    }
    expect(typed).toBe(1)
  })
  test('a busy agent takes it at once, mid-turn; only a menu, a starting agent or a CLI command mid-turn holds it', async () => {
    const agents = src.agents
    agents.outbox = agents.outbox.filter((o) => o.key !== chat)
    const prompt = herdr.prompt
    const record = agents.records[chat]
    agents.records[chat] = { ...(record ?? {}), key: chat, name: 'steer' } as (typeof agents.records)[string]
    const typed: string[] = []
    let menu = false
    herdr.prompt = (async (_name: string, text: string) => {
      // herdr itself refuses while a menu is up
      if (menu) throw Object.assign(new Error('blocked'), { code: 'agent_blocked' })
      typed.push(text)
    }) as typeof prompt
    try {
      expect(await as('working', () => src.act({ type: 'send', chat, text: 'Also the README', cid: 'w1' }))).toMatchObject({ waiting: false })
      expect(typed).toEqual(['Also the README'])
      // a reaction goes in at once too
      await as('working', () => agents.send(chat, '<reaction from="Elias" emoji="👍" to="x"/>', { reaction: { message: 'm', emoji: '👍' } }))
      expect(typed).toHaveLength(2)
      // a CLI command waits for the turn to end
      expect(await as('working', () => agents.send(chat, '/compact', { idle: true }))).toMatchObject({ waiting: true, waitsFor: 'turn' })
      await as('working', () => agents.deliver(chat))
      expect(typed).toHaveLength(2)
      await as('idle', () => agents.deliver(chat))
      expect(typed.at(-1)).toBe('/compact')
      // a menu came up just as it was typed: it waits for the menu instead of failing
      menu = true
      expect(await as('working', () => src.act({ type: 'send', chat, text: 'Pick nothing', cid: 'w2' }))).toMatchObject({ waiting: true, waitsFor: 'menu' })
      expect(agents.waiting(chat).map((o) => o.cid)).toEqual(['w2'])
      // still up: it stays, without failing
      await as('blocked', () => agents.deliver(chat))
      expect(agents.waiting(chat)).toHaveLength(1)
      expect(src.chats.chat(chat).failed?.some((f) => f.cid === 'w2')).toBeFalsy()
      // the menu is gone and the agent works on: it goes in
      menu = false
      await as('working', () => agents.deliver(chat))
      expect(typed.at(-1)).toBe('Pick nothing')
      expect(agents.waiting(chat)).toHaveLength(0)
      // starting up: it waits for the CLI to take input
      expect(await as('idle', async () => agents.holdOf(chat))).toBeUndefined()
      const info = agents.info
      agents.info = () => ({ interactive_ready: false }) as ReturnType<typeof info>
      try {
        expect(await as('idle', async () => agents.holdOf(chat))).toBe('start')
      } finally {
        agents.info = info
      }
    } finally {
      herdr.prompt = prompt
      if (record) agents.records[chat] = record
      else delete agents.records[chat]
      agents.outbox = agents.outbox.filter((o) => o.key !== chat)
    }
  })
  test("the first message to an agent just started waits until herdr takes input for it, then goes in once; no 'Not sent'", async () => {
    const agents = src.agents
    agents.outbox = agents.outbox.filter((o) => o.key !== chat)
    const prompt = herdr.prompt
    const status = agents.status
    const record = agents.records[chat]
    agents.records[chat] = { ...(record ?? {}), key: chat, name: 'fresh' } as (typeof agents.records)[string]
    // gone until it is started; then herdr lists it, but doesn't count it as its named agent yet
    let st = 'gone'
    let ready = false
    const typed: string[] = []
    agents.status = () => st as ReturnType<typeof status>
    herdr.prompt = (async (name: string, text: string) => {
      if (!ready) throw Object.assign(new Error(`agent ${name} is not an active named agent`), { code: 'agent_not_found' })
      typed.push(text)
    }) as typeof prompt
    try {
      const ensure = async () => void (st = 'idle')
      const r = await agents.send(chat, 'Hello there', { ensure, cid: 'first' })
      expect(r).toMatchObject({ waiting: true, waitsFor: 'start' })
      const mine = () => agents.waiting(chat).filter((o) => o.cid)
      expect(mine().map((o) => o.cid)).toEqual(['first'])
      // refreshes while herdr still refuses it: it keeps waiting, without failing
      await agents.deliver(chat)
      await agents.deliver(chat)
      expect(mine()).toHaveLength(1)
      expect(agents.holdOf(chat)).toBe('start')
      expect(src.chats.chat(chat).failed?.some((f) => f.cid === 'first')).toBeFalsy()
      // the agent is up: it goes in, once (news for this coordinator may go in too)
      ready = true
      await agents.deliver(chat)
      expect(typed.filter((x) => x === 'Hello there')).toHaveLength(1)
      expect(mine()).toHaveLength(0)
      expect(agents.holdOf(chat)).toBeUndefined()
      expect(src.chats.chat(chat).failed?.some((f) => f.cid === 'first')).toBeFalsy()
      // one that never comes up: after a while it fails, and Retry is offered
      ready = false
      const unreadyFor = agents.unreadyFor
      agents.unreadyFor = 0
      try {
        expect(await agents.send(chat, 'Anyone?', { cid: 'never' })).toMatchObject({ waiting: true, waitsFor: 'start' })
        // the try send started reads the screen first, so it may still be on its way: until it is over
        for (let i = 0; i < 100 && mine().length; i++) {
          await agents.deliver(chat)
          await new Promise((r) => setTimeout(r, 20))
        }
      } finally {
        agents.unreadyFor = unreadyFor
      }
      expect(mine()).toHaveLength(0)
      expect(src.chats.chat(chat).failed).toContainEqual({ cid: 'never', error: expect.stringContaining("The agent didn't take it") })
    } finally {
      herdr.prompt = prompt
      agents.status = status
      if (record) agents.records[chat] = record
      else delete agents.records[chat]
      agents.outbox = agents.outbox.filter((o) => o.key !== chat)
    }
  })
  test('its files carry the id too', async () => {
    const shot = await src.upload(chat, 'shot.png', new Uint8Array([1]))
    await as('blocked', () => src.act({ type: 'send', chat, text: '', attachments: [shot], cid: 'c2' }))
    expect(src.chats.chat(chat).messages.filter((m) => m.cid === 'c2').map((m) => m.file?.path)).toEqual([shot])
  })
})

describe('Send now on a message its CLI queued', () => {
  const chat = placeId.home()
  test('the chat names what its CLI still holds in its own queue, and drops it once its log has it', async () => {
    const agents = src.agents
    const originals = { status: agents.status, record: agents.records[chat], prompt: herdr.prompt }
    let st = 'working'
    agents.records[chat] = { ...(originals.record ?? { logs: [] }), key: chat, name: 'queued-now', kind: 'claude' } as (typeof agents.records)[string]
    agents.status = (() => st) as typeof agents.status
    herdr.prompt = (async () => {}) as typeof herdr.prompt
    /** a line its CLI's log took: the readers keep them so */
    const logged = (id: string, text: string) => {
      const events = (src.chats as unknown as { events: Map<string, { kind: string; id: string; at: number; text: string }[]> }).events
      events.set(chat, [...(events.get(chat) ?? []), { kind: 'user', id, at: Date.now(), text }])
    }
    try {
      // what earlier tests left waiting for this chat
      agents.outbox = agents.outbox.filter((o) => o.key !== chat)
      // typed mid-turn, and its log hasn't taken it yet: in its own queue
      expect(await src.act({ type: 'send', chat, text: 'Also the README', cid: 'q1' })).toMatchObject({ waiting: false })
      expect(src.chats.chat(chat).queued).toContain('q1')
      // its log has it: taken, and no longer in its queue
      logged('q1-log', 'Also the README')
      expect(src.chats.chat(chat).queued ?? []).not.toContain('q1')
      // a turn over means what it queued goes in on its own: nothing named then
      expect(await src.act({ type: 'send', chat, text: 'And the changelog', cid: 'q2' })).toMatchObject({ waiting: false })
      expect(src.chats.chat(chat).queued).toContain('q2')
      st = 'idle'
      expect(src.chats.chat(chat).queued).toBeUndefined()
    } finally {
      Object.assign(agents, { status: originals.status })
      herdr.prompt = originals.prompt
      if (originals.record) agents.records[chat] = originals.record
      else delete agents.records[chat]
      agents.outbox = agents.outbox.filter((o) => o.key !== chat)
    }
  })
  test("Claude Code's Ctrl+Enter, pressed only while its screen offers it, once per tap", async () => {
    const agents = src.agents
    const originals = { info: agents.info, status: agents.status, record: agents.records[chat], visible: herdr.visible, paneKeys: herdr.paneKeys }
    let screen = ''
    let st = 'working'
    const pressed: string[][] = []
    agents.records[chat] = { ...(originals.record ?? {}), key: chat, name: 'steer-now', kind: 'claude' } as (typeof agents.records)[string]
    agents.info = (() => ({ agent: 'claude', agent_status: 'working', pane_id: 'steer-pane', cwd: '/tmp', tab_id: 'steer-tab', workspace_id: 'steer-space' })) as typeof agents.info
    agents.status = (() => st) as typeof agents.status
    herdr.visible = async () => screen
    herdr.paneKeys = (async (_pane: string, keys: string[]) => {
      pressed.push(keys)
    }) as typeof herdr.paneKeys
    try {
      // its screen offers it: pressed, once
      screen = '● Working…\n❯ \n  ctrl+enter to send now · esc to interrupt'
      expect(await src.act({ type: 'steer', chat })).toMatchObject({ ok: true })
      expect(pressed).toEqual([['ctrl+enter']])
      // another tap, another press: one key each, and nothing else
      expect(await src.act({ type: 'steer', chat })).toMatchObject({ ok: true })
      expect(pressed).toEqual([['ctrl+enter'], ['ctrl+enter']])
      // no offer: nothing is pressed (on an empty prompt Ctrl+Enter would type something else), and it says so
      screen = '● Working…\n❯ \n  esc to interrupt'
      expect(await src.act({ type: 'steer', chat })).toMatchObject({ ok: false, error: "It couldn't take it now." })
      expect(pressed).toHaveLength(2)
      // another CLI has no such queue to take, though its screen says those words
      agents.records[chat] = { ...agents.records[chat], kind: 'pi' }
      screen = '  ctrl+enter to send now'
      expect(await src.act({ type: 'steer', chat })).toMatchObject({ ok: false })
      expect(pressed).toHaveLength(2)
      // its turn is over: what it queued goes in on its own, so there is nothing to press
      agents.records[chat] = { ...agents.records[chat], kind: 'claude' }
      st = 'idle'
      expect(await src.act({ type: 'steer', chat })).toMatchObject({ ok: false })
      expect(pressed).toHaveLength(2)
      // and an agent that isn't there has no pane to read
      st = 'gone'
      expect(await src.act({ type: 'steer', chat })).toMatchObject({ ok: false })
      expect(pressed).toHaveLength(2)
    } finally {
      Object.assign(agents, { info: originals.info, status: originals.status })
      if (originals.record) agents.records[chat] = originals.record
      else delete agents.records[chat]
      herdr.visible = originals.visible
      herdr.paneKeys = originals.paneKeys
    }
  })
})

describe("a tile's small copy of a chat's picture or video", () => {
  const chat = placeId.home()
  const shot = () => join(tmp('media-shot'), 'shot.png')

  test('only a file of that chat, never a path a reply names', async () => {
    const at = shot()
    writeFileSync(at, new Uint8Array([1, 2, 3]))
    expect(await src.media(chat, at, 'thumb')).toBeNull()
    expect(await src.media(chat, '/etc/passwd', 'thumb')).toBeNull()
    // one the chat has, but another chat's: refused
    const sent = await src.cli(['attach', at, '--caption', 'A shot'], { chat })
    expect(sent.code).toBe(0)
    const file = src.chats.chat(chat).messages.find((m) => m.id.startsWith('media:') && m.file)!.file!
    expect(await src.media(placeId.space('elsewhere'), file.path, 'thumb')).toBeNull()
    // a small picture is its own thumbnail: nothing to make
    expect(await src.media(chat, file.path, 'thumb')).toBeNull()
    // a still is asked of a video only
    expect(await src.media(chat, file.path, 'poster')).toBeNull()
  })

  test.skipIf(!Bun.which('ffmpeg'))('a big picture of that chat gets one, made beside it', async () => {
    const dir = tmp('media-big')
    const at = join(dir, 'big.png')
    const made = Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2f6f4f:s=900x700:d=1', '-vf', 'noise=alls=90:allf=t', '-frames:v', '1', at])
    expect(made.exitCode).toBe(0)
    await src.cli(['attach', at], { chat })
    const file = src.chats.chat(chat).messages.findLast((m) => m.id.startsWith('media:') && m.file)!.file!
    const thumb = await src.media(chat, file.path, 'thumb')
    expect(thumb?.type).toBe('image/jpeg')
    // the whole picture is bigger than what a tile draws from
    expect(Bun.file(file.path).size).toBeGreaterThan((await thumb!.bytes()).length)
  })

  test("another machine's chat asks that machine for its tile, and nothing when it cannot answer", async () => {
    const asked: string[] = []
    const peers = src.peers as unknown as { owner: (k: string) => unknown; fetch: (l: unknown, p: string) => Promise<Response> }
    const owner = peers.owner
    const fetch_ = peers.fetch
    peers.owner = () => ({ rec: { machine: 'laptop' }, reachable: true })
    try {
      peers.fetch = async (_l, p) => (asked.push(p), new Response(new Uint8Array([9, 9]), { headers: { 'content-type': 'image/jpeg' } }))
      const thumb = await src.media('p:laptop:~', '/home/u/.shepherdr/inbox/x/shot.png', 'thumb')
      expect(thumb?.type).toBe('image/jpeg')
      expect(asked[0]).toContain('/api/file?')
      expect(asked[0]).toContain('thumb=1')
      expect(decodeURIComponent(asked[0])).toContain('chat=p:laptop:~')
      // a still the other machine cannot make: none here either
      peers.fetch = async () => new Response('no still', { status: 404 })
      expect(await src.media('p:laptop:~', '/home/u/.shepherdr/inbox/x/clip.mp4', 'poster')).toBeNull()
      // and one unreachable answers nothing rather than throwing
      peers.fetch = async () => {
        throw new Error('no route')
      }
      expect(await src.media('p:laptop:~', '/home/u/.shepherdr/inbox/x/shot.png', 'thumb')).toBeNull()
    } finally {
      peers.owner = owner
      peers.fetch = fetch_
    }
  })
})
