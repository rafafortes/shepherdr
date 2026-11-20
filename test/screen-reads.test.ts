// SHE-133: reading an idle agent's screen is the costly half of a refresh. Count herdr's visible reads under a stub
// clock: once when a turn ends, on herdr's output event or while work still runs, then at most every 30 s. The five CLIs
// are all here: only agy and a Claude Code with no session file have a screen to read (readers/background.ts).
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('screen-reads')
process.env.CLAUDE_CONFIG_DIR = tmp('screen-reads-claude')
const socket = join(process.env.SHEPHERDR_HOME, 'herdr.sock')
process.env.HERDR_SOCKET_PATH = socket
const { Agents } = await import('../server/live/agents.ts')
const { herdr } = await import('../server/live/herdr.ts')
const { writeJson } = await import('../server/store.ts')

const AGY_RULE = '─'.repeat(78)
const agyScreen = (tasks = false) => ['', AGY_RULE, '>', AGY_RULE, tasks ? '? for shortcuts  ·  2 task(s) · /tasks' : '? for shortcuts'].join('\n')
const AGY_IDLE = agyScreen()
const AGY_RUNNING = agyScreen(true)

const realNow = Date.now
/** what a test waits for has happened, however slow the machine (the clock under test is held still) */
const until = async (f: () => boolean, ms = 8000) => {
  for (const t0 = realNow(); !f(); await Bun.sleep(5)) if (realNow() - t0 > ms) throw new Error('timed out')
}

type Kind = 'agy' | 'claude' | 'claude-session' | 'codex' | 'pi' | 'opencode'
type Rec = ReturnType<typeof record>
const record = (key: string, kind: Kind, cwd: string) => ({
  key,
  name: Agents.nameFor(key),
  kind: kind === 'claude-session' ? 'claude' : kind,
  cwd,
  workspace: 'w',
  logs: [],
  sessionId: kind === 'claude-session' ? `s-${key}` : undefined,
  started: 0,
})
const info = (key: string, kind: Kind, pane: string, status: string) => ({
  agent: kind === 'claude-session' ? 'claude' : kind,
  agent_status: status,
  name: Agents.nameFor(key),
  pane_id: pane,
  tab_id: 't',
  workspace_id: 'w',
  cwd: null,
  interactive_ready: true,
})

describe("an idle agent's screen reads", () => {
  /** a stand-in herdr: one list, one screen per pane, and a count of the visible reads it is asked for */
  const screens = new Map<string, string>()
  let listing: ReturnType<typeof info>[] = []
  const reads = new Map<string, number>()
  const server = createServer((c) => {
    c.on('error', () => undefined)
    let buf = ''
    c.on('data', (d) => {
      buf += d
      let i = buf.indexOf('\n')
      while (i >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        i = buf.indexOf('\n')
        if (!line.trim()) continue
        const { id, method, params } = JSON.parse(line)
        const result =
          method === 'agent.list'
            ? { agents: listing.map((a) => ({ ...a })) }
            : method === 'pane.read'
              ? (() => {
                  if (params.source === 'visible') reads.set(params.pane_id, (reads.get(params.pane_id) ?? 0) + 1)
                  return { read: { text: screens.get(params.pane_id) ?? '' } }
                })()
              : method === 'pane.process_info'
                ? { process_info: {} }
                : method === 'agent.get'
                  ? { agent: listing.find((a) => a.name === params.target) }
                  : {}
        c.end(`${JSON.stringify({ id, result })}\n`)
      }
    })
  })
  const total = () => [...reads.values()].reduce((a, b) => a + b, 0)
  let clock = 1_700_000_000_000
  let a: InstanceType<typeof Agents>
  /** an Agents with no event subscription of its own: the tests drive events by hand, so no handshake refresh lands */
  const start = (records: Record<string, Rec>) => {
    writeJson('agents.json', records)
    a = new Agents()
    ;(a as unknown as { sub: { set: () => void } }).sub.set = () => undefined
  }
  /** each refresh followed by the screen pass it starts */
  const tick = async (ms: number) => {
    clock += ms
    await a.refresh()
    await until(() => !(a as unknown as { readingBackground: boolean }).readingBackground)
  }
  /** herdr telling the pane printed, by the 0.9.5 name and the older name */
  const printed = (pane_id: string) => {
    for (const type of ['pane.output_matched', 'pane_output_matched']) (a as unknown as { onEvent: (e: object) => void }).onEvent({ event: type, data: { type, pane_id } })
  }

  afterAll(async () => {
    a?.stop()
    Date.now = realNow
    await new Promise<void>((r) => server.close(() => r()))
  })

  test('ten idle agy agents: a read when their turns end, then 2 s for a minute, then at most one per 30 s', async () => {
    await new Promise<void>((r) => server.listen(socket, r))
    Date.now = () => clock
    reads.clear()
    const keys = Array.from({ length: 10 }, (_, i) => `SR-${i}/Agent`)
    start(Object.fromEntries(keys.map((k, i) => [k, record(k, 'agy', `/w/${i}`)])))
    listing = keys.map((k, i) => info(k, 'agy', `p-${i}`, 'idle'))
    for (let i = 0; i < 10; i++) screens.set(`p-${i}`, AGY_IDLE)

    await tick(0)
    expect(total()).toBe(10)
    for (let i = 0; i < 10; i++) expect(reads.get(`p-${i}`)).toBe(1)

    // the first minute follows the refresh's own cadence: still one read per agent every 2 s
    for (let i = 0; i < 29; i++) await tick(2000)
    expect(total()).toBe(300)

    // past the minute a screen that has not printed is not read again, even over many refreshes
    for (let i = 0; i < 5; i++) await tick(2000)
    expect(total()).toBe(300)
    // one read per agent at 30 s, and none until the next 30 s is up
    await tick(21_000)
    expect(total()).toBe(310)
    for (let i = 0; i < 10; i++) expect(reads.get(`p-${i}`)).toBe(31)
    await tick(2000)
    expect(total()).toBe(310)
    a.stop()
  })

  test('a turn that ends is read at once; work announced there is told as fast as today, and its end within the fast pace', async () => {
    reads.clear()
    start({ 'SR-turn/Agent': record('SR-turn/Agent', 'agy', '/w/t') })
    listing = [info('SR-turn/Agent', 'agy', 'p-turn', 'working')]
    screens.set('p-turn', AGY_IDLE)
    const told: string[] = []
    a.on('status', (key) => told.push(key))

    await tick(0)
    expect(total()).toBe(0) // working agents are never read
    expect(a.background('SR-turn/Agent')).toBeUndefined()

    // its turn ends and a shell starts on the screen in the same look: read now, not on a pace
    listing = [info('SR-turn/Agent', 'agy', 'p-turn', 'done')]
    screens.set('p-turn', AGY_RUNNING)
    await tick(0)
    expect(total()).toBe(1)
    expect(a.background('SR-turn/Agent')).toBe('shells')
    expect(told).toContain('SR-turn/Agent')

    // the shell ends while the fast pace holds: noticed on the next refresh
    told.length = 0
    screens.set('p-turn', AGY_IDLE)
    await tick(2000)
    expect(a.background('SR-turn/Agent')).toBeUndefined()
    expect(told).toContain('SR-turn/Agent')
    a.stop()
  })

  test("herdr's output event reads a long-idle pane at once, however slow its pace has become", async () => {
    reads.clear()
    start({ 'SR-event/Agent': record('SR-event/Agent', 'agy', '/w/e') })
    listing = [info('SR-event/Agent', 'agy', 'p-event', 'idle')]
    screens.set('p-event', AGY_IDLE)
    await tick(0)
    expect(total()).toBe(1)
    // a minute of fast reads, then the slow pace takes over and a static screen is left alone
    for (let i = 0; i < 31; i++) await tick(2000)
    expect(total()).toBe(30)

    printed('p-event')
    await until(() => total() === 32)
    a.stop()
  })

  test('only agy and a Claude Code with no session file read a screen: codex, pi, OpenCode and a session file do not', async () => {
    reads.clear()
    const keys: Kind[] = ['agy', 'claude', 'claude-session', 'codex', 'pi', 'opencode']
    start(Object.fromEntries(keys.map((kind, i) => [`SR-${kind}/Agent`, record(`SR-${kind}/Agent`, kind, `/w/${i}`)])))
    // a session file for the Claude Code that has one, so its background comes from the file and not its screen
    const sessions = join(process.env.CLAUDE_CONFIG_DIR ?? '', 'sessions')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(
      join(sessions, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: 's-SR-claude-session/Agent', cwd: '/w/2', kind: 'interactive', status: 'shell', updatedAt: Date.now() }),
    )
    listing = keys.map((kind) => info(`SR-${kind}/Agent`, kind, `p-${kind}`, 'idle'))
    for (const kind of keys) screens.set(`p-${kind}`, AGY_IDLE)
    await tick(0)

    expect(reads.get('p-agy')).toBe(1)
    expect(reads.get('p-claude')).toBe(1)
    for (const kind of ['claude-session', 'codex', 'pi', 'opencode']) expect(reads.get(`p-${kind}`) ?? 0).toBe(0)
    expect(total()).toBe(2)
    a.stop()
  })

  test('no more than a few screen reads are in flight at once', async () => {
    reads.clear()
    start(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`SR-limit-${i}/Agent`, record(`SR-limit-${i}/Agent`, 'agy', `/w/${i}`)])))
    listing = Array.from({ length: 10 }, (_, i) => info(`SR-limit-${i}/Agent`, 'agy', `q-${i}`, 'idle'))
    for (let i = 0; i < 10; i++) screens.set(`q-${i}`, AGY_IDLE)
    let inFlight = 0
    let peak = 0
    const visible = spyOn(herdr, 'visible').mockImplementation(async (pane) => {
      reads.set(pane, (reads.get(pane) ?? 0) + 1)
      peak = Math.max(peak, ++inFlight)
      await Bun.sleep(5)
      inFlight--
      return AGY_IDLE
    })
    try {
      await tick(0)
    } finally {
      visible.mockRestore()
    }
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
    a.stop()
  })
})
