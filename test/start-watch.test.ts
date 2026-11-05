// A start that never becomes a turn, on the real source with herdr standing in: an agent stopped on its startup
// screen is a card in its chat and the task waits on you, a CLI gone from its pane is an error with its reason, a resume
// whose session is gone starts a new one — once each, and never for an agent that is working.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.SHEPHERDR_HOME = mkdtempSync(join(tmpdir(), 'shep-starts-'))
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { herdr } = await import('../server/live/herdr.ts')
const { Worktrees } = await import('../server/live/engine/worktrees.ts')
const { menuId } = await import('../server/live/screen.ts')
const { fakeHerdr } = await import('./fake-herdr.ts')
type AgentInfo = import('../server/live/herdr.ts').AgentInfo
type TaskRec = import('../server/live/engine/engine.ts').TaskRec

const src = new LiveSource()
// herdr makes the task worktrees: a stand-in on real git
const fake = fakeHerdr()
Object.assign(src.engine, { wt: new Worktrees(fake.h as never) })
const ensure = src.agents.ensure.bind(src.agents)
const relaunch = src.agents.relaunch.bind(src.agents)
afterAll(() => src.stop())

const TRUST = readFileSync(join(import.meta.dir, 'fixtures/startup/claude-trust.txt'), 'utf8')
const LOST = 'No conversation found with session ID: 11111111-2222-4333-8444-555555555555\n'
const PI = ' █▀ █ escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash ·\n /tmp/work\n 0.0%/1.0M (auto)  deepseek/deepseek-v4.1-flash • high\n'

/** what its pane shows now, whether its CLI still runs there, and what herdr lists */
let screen = ''
let exited = false
let listing: AgentInfo[] = []
/** every start asked of the agents, and every key pressed into a pane */
let started: { key: string; first?: string }[] = []
let pressed: string[][] = []
let spies: { mockRestore(): void }[] = []

beforeEach(() => {
  screen = ''
  exited = false
  listing = []
  started = []
  pressed = []
  // the CLI in its pane: herdr answers nothing to judge, so the screen is what is read
  spies = [
    spyOn(herdr, 'agents').mockImplementation(async () => listing.map((a) => ({ ...a }))),
    spyOn(herdr, 'processInfo').mockImplementation(async () =>
      exited ? { shell_pid: 1, foreground_process_group_id: 1 } : { shell_pid: 1, foreground_process_group_id: 2, foreground_processes: [{ argv: ['/usr/bin/node'], pid: 2 }] },
    ),
    spyOn(herdr, 'visible').mockImplementation(async () => screen),
    spyOn(herdr, 'paneKeys').mockImplementation(async (_pane: string, keys: string[]) => {
      pressed.push(keys)
      // a press at a startup screen takes it: the CLI starts
      screen = 'started\n'
      return {}
    }),
    spyOn(herdr, 'closePane').mockResolvedValue({} as never),
  ]
  src.agents.ensure = (async (spec: { key: string; first?: string }) => {
    started.push({ key: spec.key, first: spec.first })
    return null
  }) as typeof src.agents.ensure
  src.agents.relaunch = (async (key: string, _close: boolean, start: () => Promise<unknown>) => {
    await start()
  }) as typeof src.agents.relaunch
})
afterEach(() => {
  for (const spy of spies) spy.mockRestore()
  spies = []
  src.agents.ensure = ensure
  src.agents.relaunch = relaunch
  src.agents.live = new Map()
  src.agents.outbox = []
})

/** a task whose agent Shepherdr started once, and its own herdr agent standing at its pane */
let repos = 0
async function task(o: { title: string; kind?: string; screen: string; resumed?: boolean; exit?: boolean; gone?: boolean; waits?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'shep-starts-repo-'))
  execSync('git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init', { cwd: dir, shell: '/bin/sh' })
  const place = await src.places.add(dir, `starts${++repos}`)
  const t: TaskRec = src.engine.add({ project: place.name, title: o.title, by: 'test' })
  for (let i = 0; !t.worktree && i < 200; i++) await Bun.sleep(20)
  if (!t.worktree) throw new Error(`${t.id} got no worktree: ${t.trouble}`)
  started = []
  const key = `${t.id}/Agent`, name = `shep-${t.id.toLowerCase()}`
  const at = Date.now()
  screen = o.screen
  exited = !!o.exit
  listing = o.gone ? [] : [{ agent: o.kind ?? 'claude', agent_status: 'unknown', name, pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: t.worktree }]
  src.agents.live = new Map(listing.map((a) => [a.name!, a]))
  src.agents.records[key] = {
    key,
    name,
    kind: o.kind ?? 'claude',
    cwd: t.worktree,
    workspace: 'w',
    logs: [],
    started: at - 30_000,
    sessionId: 'session-1',
    lastPane: 'p1',
    resumed: !!o.resumed,
  }
  src.agents.outbox = o.waits === false ? [] : [{ id: `o-${key}`, key, text: 'the brief', at }]
  src.agents.reachable = true
  src.agents.lastReach = at
  return { t, key, name, at }
}

/** what a start does over the next few looks: two a poll apart, past its first look */
async function look(at: number, times = 2) {
  for (let i = 0; i < times; i++) {
    const now = at + i * 2000
    // herdr answered at the last look: it is reachable for this one
    src.agents.reachable = true
    src.agents.lastReach = now
    await src.watchStarts(now)
  }
}

const cards = (key: string) => src.chats.chat(key).messages.filter((m) => m.card).map((m) => m.card!.text)
const spaceCards = (t: TaskRec) => src.chats.chat(t.project).messages.filter((m) => m.card).map((m) => m.card!.text)

describe('an agent stopped on its startup screen', () => {
  test('comes to the chat as a card with the choices it reads, and the task counts as needs you', async () => {
    const { t, key } = await task({ title: 'Trust', screen: TRUST })
    // its start was seen once: nothing is said of a screen it has not rested on yet
    await look(Date.now(), 1)
    expect(src.chats.menu(key)).toBeUndefined()
    expect(cards(key)).toEqual([])
    await look(Date.now(), 2)
    const menu = src.chats.menu(key)
    expect(menu?.choices).toEqual(['No, exit', 'Yes, I trust this folder'])
    expect(menu?.screen).toContain('Quick safety check')
    // the task waits on you for it, and the space's chat says what it waits on
    expect(src.engine.statusOf(t)).toBe('need')
    expect(src.engine.subOf(t)).toContain('Quick safety check')
    expect(spaceCards(t)).toEqual(['needs you: Quick safety check: Is this a project'])
    expect(t.trouble).toBeUndefined()
    // what waits for it holds: typed text would pick an option there
    expect(src.agents.menuUp!(key)).toBe(true)
    // one screen, one card, however often it is looked at
    await look(Date.now(), 2)
    expect(src.chats.chat(key).messages.filter((m) => m.question).length).toBe(1)
    // the card is answered by pressing the choice it reads, from where the CLI's cursor is
    const answer = await src.act({ type: 'answer', chat: key, question: menuId(key, menu!), choice: 1 })
    expect(answer).toEqual({ ok: true })
    expect(pressed).toEqual([['down', 'enter']])
    expect(src.chats.menu(key)).toBeUndefined()
    expect(src.chats.startMenuUp(key)).toBe(false)
  })

  test('one tap, once: a card whose screen changed under it is not pressed', async () => {
    const { key } = await task({ title: 'Moved', screen: TRUST })
    await look(Date.now(), 2)
    const menu = src.chats.menu(key)!
    screen = 'Choose a style\n\n ❯ Dark mode\n   Light mode\n\n Enter to confirm\n'
    const answer = await src.act({ type: 'answer', chat: key, question: menuId(key, menu), choice: 1 })
    expect(answer).toMatchObject({ ok: false })
    expect(pressed).toEqual([])
  })

  test('a screen with nothing to read is a card too, and holds nothing: its brief goes in as soon as it can', async () => {
    const { key } = await task({ title: 'Nothing to read', screen: 'Error: model nope/nope not found' })
    await look(Date.now(), 2)
    expect(src.chats.menu(key)?.choices).toEqual([])
    expect(src.chats.menu(key)?.title).toBe('Claude Code is waiting on its screen')
    // no options to press, so nothing waits on a card that has none
    expect(src.agents.menuUp!(key)).toBe(false)
  })
})

describe('a start that fails', () => {
  test('shows on the task as an error with the reason, in the chat too, and nothing starts it again', async () => {
    const { t, key, at } = await task({ title: 'Broken', screen: 'Error: Invalid API key\nPlease run /login\n', exit: true, gone: true })
    await look(at)
    expect(src.engine.statusOf(t)).toBe('need')
    expect(t.trouble).toBe("Claude Code couldn't start: Error: Invalid API key Please run /login")
    expect(src.engine.subOf(t)).toBe("Went wrong: Claude Code couldn't start")
    expect(cards(key)).toEqual(["Claude Code couldn't start: Error: Invalid API key Please run /login"])
    // the relaunch loop leaves a failed start to the human: no second card, no start of its own
    src.agents.reachable = true
    src.agents.lastReach = at + 60_000
    await src.revive(at + 60_000)
    src.agents.lastReach = at + 600_000
    await src.revive(at + 600_000)
    expect(cards(key)).toHaveLength(1)
    expect(started.map((s) => s.key)).not.toContain(key)
    // writing to it is how it is tried again
    src.engine.youWrote(key)
    expect(t.trouble).toBeUndefined()
    expect(src.engine.startFailedAt(key)).toBeUndefined()
    expect(src.engine.statusOf(t)).not.toBe('need')
  })

  test('a resume whose session is gone starts a new session with its brief, and the chat says so', async () => {
    const { t, key, at } = await task({ title: 'Resumed', screen: LOST, exit: true, gone: true, resumed: true })
    await look(at)
    expect(cards(key)).toEqual(['Its earlier session was gone, so Claude Code started a new one.'])
    // a new session, not another resume of the one that is gone, and its brief again: it remembers none of it
    expect(src.agents.records[key].sessionId).toBeUndefined()
    expect(src.agents.records[key].fresh).toBe(true)
    const fresh = started.filter((s) => s.key === key)
    expect(fresh).toHaveLength(1)
    expect(fresh[0].first).toContain('Resumed')
    expect(fresh[0].first).toContain('Your earlier session is gone')
    // a start without a session is no failure at all
    expect(t.trouble).toBeUndefined()
    expect(src.engine.startFailedAt(key)).toBeUndefined()
    await look(at + 10_000)
    expect(cards(key)).toHaveLength(1)
  })

  test('the same words on a start that had no session to lose are only a failed start', async () => {
    const { t, key, at } = await task({ title: 'No session', screen: LOST, exit: true, gone: true })
    await look(at)
    expect(t.trouble).toBe("Claude Code couldn't start: No conversation found with session ID: 11111111-2222-4333-8444-555555555555")
    expect(started.map((s) => s.key)).not.toContain(key)
  })
})

describe('no false card', () => {
  test('an agent at work gets none, whatever its screen shows', async () => {
    const { t, key, at } = await task({ title: 'Working', screen: TRUST, waits: false })
    listing = [{ ...listing[0], agent_status: 'working' }]
    src.agents.live = new Map(listing.map((a) => [a.name!, a]))
    // herdr's own status change: it is at work, its brief taken
    src.engine.agentStatus(key)
    await look(at, 3)
    expect(src.chats.menu(key)).toBeUndefined()
    expect(src.chats.chat(key).messages.filter((m) => m.question)).toEqual([])
    expect(src.engine.statusOf(t)).toBe('work')
  })

  test('a screen that keeps saying something new is a slow start, however long it takes', async () => {
    const { t, key, at } = await task({ title: 'Slow', screen: 'Loading model 1 of 4', waits: false })
    await look(at, 3)
    screen = 'Loading model 2 of 4'
    await look(at + 10_000, 2)
    screen = 'Loading model 3 of 4 (12s)'
    await look(at + 120_000, 2)
    expect(src.chats.menu(key)).toBeUndefined()
    expect(src.chats.chat(key).messages.filter((m) => m.question)).toEqual([])
    expect(t.trouble).toBeUndefined()
  })

  test('pi at its start screen with its brief already in is left alone: a cold local model takes a while', async () => {
    const { t, key, at } = await task({ title: 'Cold model', kind: 'pi', screen: PI, waits: false })
    await look(at, 3)
    expect(src.chats.menu(key)).toBeUndefined()
    expect(src.engine.statusOf(t)).not.toBe('need')
    expect(t.trouble).toBeUndefined()
  })

  test('an agent back on an older session is not carded, whatever its transcript looks like', async () => {
    const { key, at } = await task({ title: 'Transcript', screen: 'Should I take the second approach?\n\n1. Yes, do that\n2. No, keep this one\n', resumed: true })
    await look(at, 3)
    expect(src.chats.menu(key)).toBeUndefined()
    expect(src.chats.chat(key).messages.filter((m) => m.question)).toEqual([])
  })

  test('a start herdr still finishes (a launch left pending) is neither failed nor carded', async () => {
    const { t, key, at } = await task({ title: 'Pending', screen: TRUST })
    listing = [{ ...listing[0], launch_pending: true }]
    src.agents.live = new Map(listing.map((a) => [a.name!, a]))
    await look(at, 3)
    expect(src.chats.menu(key)).toBeUndefined()
    expect(src.engine.statusOf(t)).not.toBe('need')
    expect(src.engine.startFailedAt(key)).toBeUndefined()
  })
})
