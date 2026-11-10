// What server/live/agents.ts does that the rest of the suite does not reach: events that come over herdr's
// subscription, a route bound to the CLI process a pane runs (helper/route.pl, a fake perl here), Codex runtimes read
// from its app server (a fake codex here), sessions herdr or a CLI names, a start herdr turns down, slash commands
// checked at the prompt, and the pane reads and keys a screen asks for. herdr itself is spied on; its socket is a fake
// of this file's that serves only the event subscription, and no real CLI runs.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('cover-agents')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'herdr.sock')
// every CLI's home is a folder of this file's: logs are looked for there, never in the human's
process.env.CLAUDE_CONFIG_DIR = tmp('cover-agents-claude')
process.env.CODEX_HOME = tmp('cover-agents-codex')
process.env.PI_CODING_AGENT_DIR = tmp('cover-agents-pi')

const { Agents, HOOKS_DIR, ROUTING_FAILURE } = await import('../server/live/agents.ts')
const { herdr, HerdrError } = await import('../server/live/herdr.ts')
const { writeJson } = await import('../server/store.ts')
const { record } = await import('../server/live/readers/hooks.ts')
const { claudeLogPath, codexHome, piSessionDir } = await import('../server/live/readers/find.ts')
type AgentInfo = import('../server/live/herdr.ts').AgentInfo
type AgentRecord = import('../server/live/agents.ts').AgentRecord
type Agents = InstanceType<typeof Agents>

/* ---------- fake CLIs on PATH ---------- */

const bin = tmp('cover-agents-bin')
const seen = tmp('cover-agents-seen')
/** what the fake perl was given: its arguments, and the route on its stdin, a line each */
const routeArgs = join(seen, 'route-args')
const routeIn = join(seen, 'route-in')
// helper/route.pl, standing in: it writes into the real ~/.shepherdr, so here it only says what it was asked and exits
// with FAKE_ROUTE_EXIT
writeFileSync(join(bin, 'perl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${routeArgs}'\ncat >> '${routeIn}'\necho >> '${routeIn}'\nexit "\${FAKE_ROUTE_EXIT:-0}"\n`)
// `codex app-server proxy`, standing in: a WebSocket server on its stdin and stdout, as the real proxy is, that answers
// what readCodexRuntime asks and writes down the threads it was asked about
process.env.FAKE_CODEX_ASKED = join(seen, 'codex-asked')
writeFileSync(
  join(bin, 'codex'),
  `#!${process.execPath}\n` +
    String.raw`const { createHash } = require('node:crypto')
const { appendFileSync } = require('node:fs')
let buf = Buffer.alloc(0)
let open = false
const send = (o) => {
  const p = Buffer.from(JSON.stringify(o))
  process.stdout.write(Buffer.concat([Buffer.from(p.length < 126 ? [0x81, p.length] : [0x81, 126, p.length >> 8, p.length & 255]), p]))
}
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  if (!open) {
    const end = buf.indexOf('\r\n\r\n')
    if (end < 0) return
    const key = /sec-websocket-key: *(\S+)/i.exec(buf.subarray(0, end).toString())[1]
    buf = buf.subarray(end + 4)
    open = true
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    process.stdout.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  }
  for (;;) {
    if (buf.length < 2) return
    let len = buf[1] & 127
    let at = 2
    if (len === 126) {
      if (buf.length < 4) return
      len = buf.readUInt16BE(2)
      at = 4
    }
    const masked = (buf[1] & 128) !== 0
    if (buf.length < at + (masked ? 4 : 0) + len) return
    const mask = masked ? buf.subarray(at, at + 4) : null
    if (masked) at += 4
    const body = Buffer.from(buf.subarray(at, at + len))
    const op = buf[0] & 15
    buf = buf.subarray(at + len)
    if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
    if (op !== 1) continue
    const m = JSON.parse(body.toString())
    if (m.id === 0) send({ id: 0, result: {} })
    else if (m.method === 'model/list') send({ id: m.id, result: { data: [{ model: 'gpt-fake', supportedReasoningEfforts: [] }] } })
    else if (m.method === 'thread/read') {
      appendFileSync(process.env.FAKE_CODEX_ASKED, m.params.threadId + '\n')
      send({ id: m.id, result: { thread: { model: 'gpt-fake', reasoningEffort: 'high', status: { type: 'idle' } } } })
    }
  }
})
`,
)
for (const f of ['perl', 'codex']) chmodSync(join(bin, f), 0o755)
const path = process.env.PATH
process.env.PATH = `${bin}:${path}`
afterAll(() => {
  process.env.PATH = path
  delete process.env.FAKE_ROUTE_EXIT
  delete process.env.FAKE_CODEX_ASKED
})
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [])

/* ---------- herdr's socket: only the event subscription ---------- */

/** herdr's socket, standing in, for the one test that wants events: it serves only the subscription, and says which
 *  ones are open with what each asked for. Elsewhere there is no socket, so no subscription opens to look again by
 *  itself in the middle of a test */
async function eventSocket() {
  const subs: { c: Socket; wants: string }[] = []
  const server = createServer((c) => {
    c.on('error', () => undefined)
    c.on('close', () => subs.splice(0, subs.length, ...subs.filter((x) => x.c !== c)))
    c.on('data', (d) => {
      for (const line of String(d).split('\n').filter(Boolean)) {
        const { id, method, params } = JSON.parse(line)
        if (method === 'events.subscribe') {
          subs.push({ c, wants: JSON.stringify(params) })
          c.write(`${JSON.stringify({ id, result: { type: 'subscription_started' } })}\n`)
        } else c.write(`${JSON.stringify({ id, error: { code: 'unknown_method', message: `${method} is not served here` } })}\n`)
      }
    })
  })
  await new Promise<void>((res) => server.listen(process.env.HERDR_SOCKET_PATH, res))
  return { subs, close: () => new Promise<void>((res) => server.close(() => res())) }
}

/* ---------- herdr, spied on ---------- */

/** what herdr lists, changed in place by each test: its answer to a look */
const listing: AgentInfo[] = []
const info = (name: string, o: Partial<AgentInfo> = {}): AgentInfo => ({
  agent: 'claude',
  agent_status: 'idle',
  name,
  pane_id: `pane-${name}`,
  tab_id: 't1',
  workspace_id: 'w1',
  cwd: null,
  ...o,
})

function spies() {
  return {
    agents: spyOn(herdr, 'agents').mockImplementation(async () => listing.map((a) => ({ ...a }))),
    agent: spyOn(herdr, 'agent').mockImplementation(async (target: string) => ({ ...listing.find((a) => a.name === target)! })),
    processInfo: spyOn(herdr, 'processInfo').mockResolvedValue({}),
    visible: spyOn(herdr, 'visible').mockResolvedValue(''),
    read: spyOn(herdr, 'read').mockResolvedValue(''),
    size: spyOn(herdr, 'size').mockResolvedValue({ cols: 120, rows: 40 }),
    prompt: spyOn(herdr, 'prompt').mockResolvedValue({}),
    paneKeys: spyOn(herdr, 'paneKeys').mockResolvedValue({}),
    paneText: spyOn(herdr, 'paneText').mockResolvedValue({}),
    sendKeys: spyOn(herdr, 'sendKeys').mockResolvedValue({}),
    paneIdle: spyOn(herdr, 'paneIdle').mockResolvedValue(true),
    closePane: spyOn(herdr, 'closePane').mockImplementation(async (pane: string) => {
      listing.splice(0, listing.length, ...listing.filter((a) => a.pane_id !== pane))
      return {}
    }),
    start: spyOn(herdr, 'start').mockResolvedValue({ agent: null } as never),
    workspaces: spyOn(herdr, 'workspaces').mockResolvedValue([]),
  }
}

let s: ReturnType<typeof spies>
const made: Agents[] = []
beforeEach(() => {
  listing.length = 0
  delete process.env.FAKE_ROUTE_EXIT
  s = spies()
})
afterEach(() => {
  for (const a of made.splice(0)) a.stop()
  for (const spy of Object.values(s)) spy.mockRestore()
})

const until = async (f: () => boolean, ms = 8000) => {
  for (const t0 = Date.now(); !f(); await Bun.sleep(20)) if (Date.now() - t0 > ms) throw new Error('timed out')
}

const cwd = tmp('cover-agents-cwd')
const rec = (key: string, o: Partial<AgentRecord> = {}): AgentRecord => ({ key, name: Agents.nameFor(key), kind: 'pi', cwd, workspace: 'w', logs: [], started: Date.now(), ...o })

/** an Agents over these records, as the server makes one when it starts: they are its chats */
function agentsWith(...records: AgentRecord[]) {
  writeJson('agents.json', Object.fromEntries(records.map((r) => [r.key, r])))
  writeJson('outbox.json', [])
  const a = new Agents()
  made.push(a)
  return a
}

/** herdr lists these agents, and Shepherdr has looked: a look already under way (it skips another) may have read the
 *  listing before */
async function looked(a: Agents, ...agents: AgentInfo[]) {
  listing.splice(0, listing.length, ...agents)
  const shape = (l: AgentInfo[]) => JSON.stringify(l.map((x) => [x.name, x.pane_id, x.agent_status]))
  for (const t0 = Date.now(); ; await Bun.sleep(10)) {
    await a.refresh()
    if (shape([...a.live.values()]) === shape(agents)) return
    if (Date.now() - t0 > 8000) throw new Error('herdr was never looked at')
  }
}

/** setTimeout, held: what is scheduled is kept to be run by hand, and a 750 ms pause (a start tried again) is none */
function heldTimers() {
  const real = globalThis.setTimeout
  const held: { fn: () => void; ms: number }[] = []
  const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms = 0) => {
    if (ms === 750) return real(fn, 0)
    held.push({ fn, ms })
    return 0
  }) as never)
  return { held, restore: () => spy.mockRestore() }
}

const UUID = '0b6f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4'

/* ---------- the tests ---------- */

describe('watching herdr', () => {
  test('a hooks folder that cannot be made leaves hook events to the next look at herdr', () => {
    // the folder is this file's own, and nothing has made it yet: a file there makes mkdir fail
    expect(HOOKS_DIR.startsWith(tmpdir())).toBe(true)
    expect(existsSync(HOOKS_DIR)).toBe(false)
    writeFileSync(HOOKS_DIR, 'not a folder')
    try {
      const a = agentsWith()
      expect(() => a.start()).not.toThrow()
      // it still looked at herdr, and goes on looking on its timer
      expect(s.agents).toHaveBeenCalledTimes(1)
      a.stop()
    } finally {
      rmSync(HOOKS_DIR)
    }
  })

  test("an event about a watched pane's output tells its chat; any other event looks at herdr again", async () => {
    const socket = await eventSocket()
    try {
      const key = 'EV-1/Agent'
      const a = agentsWith(rec(key, { kind: 'claude' }))
      await looked(a, info(Agents.nameFor(key), { pane_id: 'p-ev' }))
      const outputs: string[] = []
      a.on('output', (k) => outputs.push(k))
      a.watchTerminals([key])
      // the subscription is opened again with the pane's output in it
      const watching = () => socket.subs.find((x) => x.wants.includes('p-ev'))
      await until(() => {
        if (!watching()) void a.refresh()
        return !!watching()
      })
      const event = (type: string, data: Record<string, unknown> = {}) => watching()!.c.write(`${JSON.stringify({ event: type, data: { type, ...data } })}\n`)
      event('pane.output_changed', { pane_id: 'p-other' })
      event('pane.output_changed', { pane_id: 'p-ev' })
      await until(() => outputs.length > 0)
      expect(outputs).toEqual([key])
      const looks = s.agents.mock.calls.length
      event('pane.agent_status_changed', { pane_id: 'p-ev' })
      await until(() => s.agents.mock.calls.length > looks)
      expect(outputs).toEqual([key])
      a.stop()
    } finally {
      await socket.close()
    }
  })

  test('herdr naming a log path or a Claude Code session id adds it to the chat once', async () => {
    const pi = rec('LS-1/Agent')
    const claude = rec('LS-2/Agent', { kind: 'claude' })
    const a = agentsWith(pi, claude)
    const told: string[] = []
    a.on('logs', (k) => told.push(k))
    const session = (kind: 'path' | 'id', value: string) => ({ source: 'herdr', agent: 'x', kind, value })
    await looked(a, info(pi.name, { agent: 'pi', agent_session: session('path', '/logs/pi-session.jsonl') }), info(claude.name, { agent_session: session('id', UUID) }))
    expect(a.record(pi.key).logs).toEqual(['/logs/pi-session.jsonl'])
    expect(a.record(claude.key).logs).toEqual([claudeLogPath(cwd, UUID)])
    expect(a.record(claude.key).sessionId).toBe(UUID)
    expect(told).toContain(pi.key)
    expect(told).toContain(claude.key)
    // named again on the next look: nothing new
    await a.refresh()
    expect(a.record(pi.key).logs).toHaveLength(1)
    expect(a.record(claude.key).logs).toHaveLength(1)
  })

  test("a Codex agent's model and effort are read from its app server, by the session it runs", async () => {
    const byId = rec('CX-1/Agent', { kind: 'codex' })
    const byPath = rec('CX-2/Agent', { kind: 'codex' })
    const byLog = rec('CX-3/Agent', { kind: 'codex', logs: ['/codex/rollout-2026-11-10T10-00-00-33333333-3333-4333-8333-333333333333.jsonl'] })
    const restarted = rec('CX-4/Agent', { kind: 'codex', logs: ['/codex/rollout-2026-11-10T10-00-00-44444444-4444-4444-8444-444444444444.jsonl'] })
    const noSession = rec('CX-5/Agent', { kind: 'codex' })
    const notRunning = rec('CX-6/Agent', { kind: 'codex', logs: ['/codex/rollout-66666666-6666-4666-8666-666666666666.jsonl'] })
    const a = agentsWith(byId, byPath, byLog, restarted, noSession, notRunning)
    const session = (kind: 'path' | 'id', value: string) => ({ source: 'herdr', agent: 'codex', kind, value })
    // the agents are listed, but the look itself reads no runtime: this test asks for it
    Object.assign(a, { runtimeAt: Date.now() })
    await looked(
      a,
      info(byId.name, { agent: 'codex', agent_session: session('id', '11111111-1111-4111-8111-111111111111') }),
      info(byPath.name, { agent: 'codex', agent_session: session('path', '/codex/rollout-2026-11-10T10-00-00-22222222-2222-4222-8222-222222222222.jsonl') }),
      info(byLog.name, { agent: 'codex' }),
      info(restarted.name, { agent: 'codex' }),
      info(noSession.name, { agent: 'codex' }),
    )
    const told: string[] = []
    a.on('logs', (k) => told.push(k))
    Object.assign(a, { runtimeAt: 0 })
    const reading = (a as unknown as { readRuntime(): Promise<void> }).readRuntime()
    // one restarts while its runtime is read: what came back was the run before's
    a.record(restarted.key).started += 1
    await reading
    expect(lines(process.env.FAKE_CODEX_ASKED!).sort()).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ])
    for (const r of [byId, byPath, byLog]) expect(a.runtime(r.key)).toMatchObject({ source: 'session', model: 'gpt-fake', effort: 'high', effortUnsupported: true })
    for (const r of [restarted, noSession, notRunning]) expect(a.runtime(r.key)).toBeUndefined()
    expect(told.sort()).toEqual([byId.key, byPath.key, byLog.key].sort())
  })
})

describe('what a Claude Code agent reports of itself', () => {
  const hooksFile = (name: string) => join(tmp('cover-agents-hooks'), `${name}.jsonl`)

  test("its model and effort from its hooks count for this run's own session only", () => {
    const t0 = Date.now()
    const file = hooksFile('rt')
    record(file, { hook_event_name: 'SessionStart', session_id: 's1', model: 'claude-opus-5-5', source: 'startup' }, t0)
    record(file, { hook_event_name: 'UserPromptSubmit', session_id: 's1', effort: { level: 'high' }, prompt: 'go' }, t0 + 1)
    const mine = rec('RH-1/Agent', { kind: 'claude', hooks: file, sessionId: 's1', started: t0 - 1000 })
    const later = rec('RH-2/Agent', { kind: 'claude', hooks: file, sessionId: 's1', started: t0 + 5000 })
    const other = rec('RH-3/Agent', { kind: 'claude', hooks: file, sessionId: 's2', started: t0 - 1000 })
    const gone = rec('RH-4/Agent', { kind: 'claude', hooks: file, sessionId: 's1', started: t0 - 1000 })
    const a = agentsWith(mine, later, other, gone)
    a.live = new Map([mine, later, other].map((r) => [r.name, info(r.name)]))
    expect(a.runtimeHook(mine.key)).toEqual({ model: 'claude-opus-5-5', effort: 'high', at: t0 + 1, session: 's1' })
    // what an earlier run recorded, or another session, is not this run's
    expect(a.runtimeHook(later.key)).toBeUndefined()
    expect(a.runtimeHook(other.key)).toBeUndefined()
    // nor is anything said for an agent herdr no longer runs
    expect(a.runtimeHook(gone.key)).toBeUndefined()
  })

  test('it was working when its hooks last said so, unless its log shows that turn over', () => {
    const working = hooksFile('working')
    record(working, { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go' })
    const stopped = hooksFile('stopped')
    record(stopped, { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go' })
    record(stopped, { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'done' })
    const a = agentsWith(rec('WW-1/Agent', { kind: 'claude', hooks: working }), rec('WW-2/Agent', { kind: 'claude', hooks: stopped }), rec('WW-3/Agent', { kind: 'pi' }))
    // gone from herdr or not, what its hooks said is what counts
    expect(a.wasWorking('WW-1/Agent')).toBe(true)
    expect(a.wasWorking('WW-2/Agent')).toBe(false)
    expect(a.wasWorking('WW-3/Agent')).toBe(false)
    expect(a.wasWorking('nobody')).toBe(false)
    a.endedSince = () => true
    expect(a.wasWorking('WW-1/Agent')).toBe(false)
  })
})

describe("a route to the CLI process a pane runs", () => {
  const key = 'RT-1/Agent'
  const spec = () => ({ key, name: Agents.nameFor(key), kind: 'claude', cwd, workspace: 'w' })
  /** herdr runs the agent, a claude CLI in its pane's foreground */
  function running() {
    const a = agentsWith(rec(key, { kind: 'claude' }))
    a.live = new Map([[spec().name, info(spec().name, { pane_id: 'p-rt' })]])
    s.processInfo.mockResolvedValue({ shell_pid: 10, foreground_processes: [{ pid: 4242, argv: ['/usr/local/bin/claude', '--resume'] }] })
    a.secretScope = () => ['RT']
    return a
  }
  const routes = () => lines(routeIn).map((l) => JSON.parse(l))

  test('is bound once for its process, with a credential of its own, and says so', async () => {
    const before = routes().length
    const a = running()
    const told: string[] = []
    a.on('routed', (k) => told.push(k))
    expect(await a.ensure(spec())).toMatchObject({ pane_id: 'p-rt' })
    expect(lines(routeArgs).at(-1)).toEndWith('route.pl --bind 4242')
    const route = routes().at(-1)
    expect(routes()).toHaveLength(before + 1)
    expect(route).toMatchObject({ chat: key, cwd, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), credentialFile: expect.stringContaining('/helper/credentials/') })
    // the credential the route carries is the one Shepherdr knows this chat by
    expect(a.secretAccess.authenticate(route.capability)).toEqual({ chat: key, chain: ['RT'] })
    expect(a.routed(key)).toBe(true)
    expect(told).toEqual([key])
    // the same process again: nothing is written twice, and it is still routed
    await a.ensure(spec())
    expect(routes()).toHaveLength(before + 1)
    expect(told).toEqual([key, key])
    // once its run ends it is not
    await a.finish(key)
    expect(a.routed(key)).toBe(false)
  })

  test('that the helper could not write fails the start, and leaves no credential behind', async () => {
    const a = running()
    process.env.FAKE_ROUTE_EXIT = '1'
    await expect(a.ensure(spec())).rejects.toThrow(ROUTING_FAILURE)
    expect(a.secretAccess.authenticate(routes().at(-1).capability)).toBeUndefined()
    expect(a.routed(key)).toBe(false)
  })

  test('stopped while it was being written, its credential is taken back', async () => {
    const a = running()
    // the run ends as the route is being made: after the process was read, before the helper is done
    a.secretScope = (chat) => {
      a.records[chat].finished = true
      return ['RT']
    }
    const told: string[] = []
    a.on('routed', (k) => told.push(k))
    await a.ensure(spec())
    expect(a.secretAccess.authenticate(routes().at(-1).capability)).toBeUndefined()
    expect(a.routed(key)).toBe(false)
    expect(told).toEqual([])
  })
})

describe('logs a CLI starts on its own', () => {
  const touch = (f: string, text = '{}\n') => {
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, text)
  }

  test('after a command that may start another session, the newest log joins the chat and names its session', () => {
    const pi = rec('FL-1/Agent', { kind: 'pi', cwd: tmp('cover-agents-fl-pi'), sessionId: 'old' })
    const codex = rec('FL-2/Agent', { kind: 'codex', cwd: tmp('cover-agents-fl-codex'), sessionId: 'kept' })
    const a = agentsWith(pi, codex)
    const told: string[] = []
    a.on('logs', (k) => told.push(k))
    const t = heldTimers()
    try {
      a.follow(pi.key, Date.now())
      a.follow(codex.key, Date.now())
      a.follow('nobody', Date.now())
    } finally {
      t.restore()
    }
    // looked for a while after, since a menu the command opened may be answered late
    expect(t.held.map((x) => x.ms)).toEqual([1500, 5000, 15000, 60000, 180000, 1500, 5000, 15000, 60000, 180000])
    // nothing new yet
    t.held[0].fn()
    expect(a.record(pi.key).logs).toEqual([])
    const piLog = join(piSessionDir(pi.cwd), `2026-11-10T10-00-00-000Z_${UUID}.jsonl`)
    touch(piLog)
    t.held[0].fn()
    expect(a.record(pi.key).logs).toEqual([piLog])
    expect(a.record(pi.key).sessionId).toBe(UUID)
    expect(told).toEqual([pi.key])
    // the same log on a later look: nothing more
    t.held[1].fn()
    expect(told).toEqual([pi.key])
    // Codex resumes by its last log, not by an id
    const d = new Date()
    const day = join(codexHome(), 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    const codexLog = join(day, `rollout-2026-11-10T10-00-00-${UUID}.jsonl`)
    touch(codexLog, `${JSON.stringify({ type: 'session_meta', payload: { cwd: codex.cwd } })}\n`)
    t.held[5].fn()
    expect(a.record(codex.key).logs).toEqual([codexLog])
    expect(a.record(codex.key).sessionId).toBe('kept')
  })

  test("a log its CLI started since the agent did is found where herdr named none", () => {
    const pi = rec('DL-1/Agent', { kind: 'pi', cwd: tmp('cover-agents-dl-pi') })
    const claude = rec('DL-2/Agent', { kind: 'claude', cwd: tmp('cover-agents-dl-claude'), sessionId: UUID })
    const unknown = rec('DL-3/Agent', { kind: 'gemini' })
    const a = agentsWith(pi, claude, unknown)
    const told: string[] = []
    a.on('logs', (k) => told.push(k))
    const piLog = join(piSessionDir(pi.cwd), `2026-11-10T10-00-00-000Z_${UUID}.jsonl`)
    touch(piLog)
    for (const r of [pi, claude, unknown]) a.discoverLog(r.key)
    a.discoverLog('nobody')
    expect(a.record(pi.key).logs).toEqual([piLog])
    // Claude Code's is where its session id says, written yet or not
    expect(a.record(claude.key).logs).toEqual([claudeLogPath(claude.cwd, UUID)])
    expect(a.record(unknown.key).logs).toEqual([])
    expect(told).toEqual([pi.key, claude.key])
    // found again: nothing more
    a.discoverLog(pi.key)
    expect(told).toEqual([pi.key, claude.key])
  })

  test('an agent already running in herdr is adopted as a chat, with the log herdr names', () => {
    const a = agentsWith()
    const key = 'AD-1/Agent'
    const agent = info('shep-adopted', { agent: 'pi', cwd: '/work/here', agent_session: { source: 'herdr', agent: 'pi', kind: 'path', value: '/logs/adopted.jsonl' } })
    a.adopt(key, agent, 'pi', 'ws')
    expect(a.record(key)).toMatchObject({ key, name: 'shep-adopted', kind: 'pi', cwd: '/work/here', workspace: 'ws', logs: ['/logs/adopted.jsonl'] })
    // a new Agents reads it back: it was saved
    const again = new Agents()
    made.push(again)
    expect(again.record(key)?.name).toBe('shep-adopted')
    // the same agent again changes nothing
    const started = a.record(key).started
    a.adopt(key, { ...agent, cwd: '/elsewhere' }, 'pi', 'ws')
    expect(a.record(key)).toMatchObject({ cwd: '/work/here', started })
  })
})

describe('a start herdr turns down', () => {
  const key = 'ST-1/Agent'
  const spec = (o: Record<string, unknown> = {}) => ({ key, name: Agents.nameFor(key), kind: 'codex', cwd: tmp('cover-agents-st'), workspace: 'w', system: 'private rules', first: 'the brief', pane: async () => 'p-st', ...o })

  test('is tried again after a moment, and its instructions and first message go ahead of what was sent meanwhile', async () => {
    const a = agentsWith()
    a.outbox.push({ id: 'o1', key, text: 'typed meanwhile', at: Date.now() })
    s.start.mockRejectedValueOnce(new Error('the shell is not at its prompt yet'))
    const t = heldTimers()
    try {
      expect(await a.ensure(spec())).toBeNull()
    } finally {
      t.restore()
    }
    expect(s.start).toHaveBeenCalledTimes(2)
    expect(s.start.mock.calls[1].slice(0, 3)).toEqual([spec().name, 'codex', 'p-st'])
    // Codex has no option for instructions: they go first, hidden, then the first message, then what waited
    expect(a.waiting(key).map((o) => o.text)).toEqual([expect.stringContaining('private rules'), 'the brief', 'typed meanwhile'])
    expect(a.waiting(key)[0].text).toStartWith('<shepherdr>')
    // then it goes in, and its log is looked for
    expect(t.held.map((x) => x.ms)).toEqual(expect.arrayContaining([1000, 3000, 15000]))
  })

  test('as not ready yet is a start that went through', async () => {
    const a = agentsWith()
    s.start.mockRejectedValueOnce(new HerdrError('agent_not_ready', 'agent shep-st-1-agent is not an active named agent yet'))
    const t = heldTimers()
    try {
      await a.ensure(spec({ first: undefined, system: undefined }))
    } finally {
      t.restore()
    }
    expect(s.start).toHaveBeenCalledTimes(1)
    expect(a.record(key).startError).toBeUndefined()
    expect(a.waiting(key)).toEqual([])
  })

  test('again and again fails after nine tries, said in the log and kept as the reason', async () => {
    const a = agentsWith()
    s.start.mockRejectedValue(new Error('no such pane'))
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const t = heldTimers()
    let said: string[] = []
    try {
      await expect(a.ensure(spec())).rejects.toThrow('no such pane')
    } finally {
      // read before the spy is restored, which forgets its calls
      said = logged.mock.calls.map((c) => c.join(' '))
      t.restore()
      logged.mockRestore()
    }
    expect(s.start).toHaveBeenCalledTimes(9)
    expect(said).toContain(`shepherdr: could not start ${spec().name}: no such pane`)
    expect(a.record(key).startError).toBe('no such pane')
  })
})

describe('starting again and stopping', () => {
  const key = 'RL-1/Agent'
  const name = Agents.nameFor(key)

  test('a relaunch closes the pane it held first, and what is sent meanwhile waits for the one it starts', async () => {
    const a = agentsWith(rec(key))
    await looked(a, info(name, { agent: 'pi', pane_id: 'p-rl' }))
    let during: { busy: boolean; hold?: string } | undefined
    await a.relaunch(key, true, async () => {
      during = { busy: a.busy(key), hold: a.holdOf(key) }
    })
    expect(s.closePane).toHaveBeenCalledWith('p-rl')
    expect(during).toEqual({ busy: true, hold: 'start' })
    expect(a.busy(key)).toBe(false)
    // not asked to close: its pane is left alone
    s.closePane.mockClear()
    await looked(a, info(name, { agent: 'pi', pane_id: 'p-rl' }))
    await a.relaunch(key, false, async () => undefined)
    expect(s.closePane).not.toHaveBeenCalled()
  })

  test("a finished run's pane closes, and herdr is looked at again at once", async () => {
    const a = agentsWith(rec(key))
    await looked(a, info(name, { agent: 'pi', pane_id: 'p-fin' }))
    const looks = s.agents.mock.calls.length
    await a.finish(key)
    expect(s.closePane).toHaveBeenCalledWith('p-fin')
    expect(s.agents.mock.calls.length).toBeGreaterThan(looks)
    expect(a.info(key)).toBeUndefined()
    expect(a.record(key).finished).toBe(true)
  })

  test('a turn interrupted ends once herdr sees it idle; one still at work past the wait throws', async () => {
    const a = agentsWith(rec(key))
    await looked(a, info(name, { agent: 'pi', agent_status: 'working' }))
    // the interrupt lands: herdr sees it idle on its next look
    s.sendKeys.mockImplementation(async () => {
      listing[0] = { ...listing[0], agent_status: 'idle' }
      return {}
    })
    await a.stopTurn(key)
    expect(s.sendKeys).toHaveBeenCalledWith(name, ['esc'])
    expect(a.status(key)).toBe('idle')
    // this time it goes on working
    s.sendKeys.mockResolvedValue({})
    await looked(a, info(name, { agent: 'pi', agent_status: 'working' }))
    await expect(a.stopTurn(key, 0)).rejects.toThrow('It is still working after an interrupt')
  })
})

describe('a slash command you typed', () => {
  const key = 'SC-1/Agent'
  const name = Agents.nameFor(key)
  async function ready() {
    const a = agentsWith(rec(key, { kind: 'claude' }))
    await looked(a, info(name, { pane_id: 'p-sc' }))
    a.commandMs = 10
    return a
  }
  const atPrompt = '  ✻ Thinking\n\n❯ /compact\n'

  test('that ran: it went in, and no key is pressed', async () => {
    const a = await ready()
    expect(await a.send(key, '/compact', { command: true, cid: 'c-ran' })).toMatchObject({ waiting: false })
    expect(s.prompt).toHaveBeenCalledWith(name, '/compact')
    expect(s.read).toHaveBeenCalledWith('p-sc', 'text', 30)
    expect(s.paneKeys).not.toHaveBeenCalled()
  })

  test("still in the input, a menu took its Enter: Enter goes again", async () => {
    const a = await ready()
    // both looks of the first try find it still there; the next finds it gone
    s.read.mockResolvedValueOnce(atPrompt).mockResolvedValueOnce(atPrompt).mockResolvedValue('')
    expect(await a.send(key, '/compact', { command: true, cid: 'c-enter' })).toMatchObject({ waiting: false })
    expect(s.paneKeys.mock.calls).toEqual([['p-sc', ['enter']]])
  })

  test('that never ran is wiped from the input, and the chat hears it did not go in', async () => {
    const a = await ready()
    s.read.mockResolvedValue(atPrompt)
    await expect(a.send(key, '/compact', { command: true, cid: 'c-never' })).rejects.toThrow("The agent didn't take it: /compact didn't run in the terminal.")
    expect(s.paneKeys.mock.calls).toEqual([
      ['p-sc', ['enter']],
      ['p-sc', ['enter']],
      ['p-sc', Array('/compact'.length + 2).fill('backspace')],
    ])
  })
})

describe("an agent's terminal, for a screen", () => {
  const key = 'TM-1/Agent'
  const name = Agents.nameFor(key)
  async function shown() {
    const a = agentsWith(rec(key, { kind: 'claude' }))
    await looked(a, info(name, { pane_id: 'p-tm' }))
    return a
  }

  test('its recent lines come at its real size, the size read again only after a few seconds', async () => {
    const a = await shown()
    s.read.mockResolvedValue('\x1b[1mhello\x1b[0m')
    expect(await a.screen(key)).toEqual({ ansi: '\x1b[1mhello\x1b[0m', cols: 120, rows: 40 })
    expect(await a.screen(key)).toEqual({ ansi: '\x1b[1mhello\x1b[0m', cols: 120, rows: 40 })
    expect(s.read).toHaveBeenCalledWith('p-tm', 'ansi', 300)
    expect(s.size).toHaveBeenCalledTimes(1)
    // no longer watched, its size is forgotten and read again
    a.watchTerminals([])
    s.size.mockRejectedValueOnce(new Error('no layout'))
    expect(await a.screen(key)).toEqual({ ansi: '\x1b[1mhello\x1b[0m' })
    expect(s.size).toHaveBeenCalledTimes(2)
    expect(await a.screen('nobody')).toEqual({ ansi: '' })
  })

  test('its last lines as plain text, and text typed into it', async () => {
    const a = await shown()
    s.read.mockResolvedValue('plain lines')
    expect(await a.screenText(key)).toBe('plain lines')
    expect(s.read).toHaveBeenCalledWith('p-tm', 'text', 60)
    expect(await a.screenText('nobody')).toBe('')
    await a.text(key, 'typed')
    await a.text('nobody', 'lost')
    expect(s.paneText.mock.calls).toEqual([['p-tm', 'typed']])
  })

  test('watching its terminal follows its pane, and looks at herdr again only when that changes', async () => {
    const a = await shown()
    const looks = s.agents.mock.calls.length
    a.watchTerminals([key, 'nobody'])
    expect([...a.watchedPanes]).toEqual(['p-tm'])
    await until(() => s.agents.mock.calls.length > looks)
    const after = s.agents.mock.calls.length
    a.watchTerminals([key])
    await Bun.sleep(20)
    expect(s.agents.mock.calls.length).toBe(after)
  })
})
