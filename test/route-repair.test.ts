// A restart re-provisions the route of every live agent, because the in-memory routes map is empty. One at a time that
// pass is a chain as long as the number of agents — minutes with ~60 — and a task that starts during it can fail its
// first write with ROUTING_FAILURE (the SHE-56 incident, 2026-11-18). The pass now binds a chunk at a time, leaves an
// agent whose own launch binds it alone, and lets one route fail without taking the others down.
//
// Every CLI: the route is written by helper/route.pl for the pid herdr reports, and `bindRoute` is the one path Claude
// Code, Codex, pi, OpenCode and agy all take — `isAgentProcess` is what tells each CLI's process apart, and the fake
// herdr below answers each of the five with its own argv, so a pass binds all five at once. What is per CLI (its launch
// flags, its startup screen, its own time to become ready) is untouched by this change and covered by that CLI's tests.
import { describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const home = tmp('route-repair')
mkdirSync(join(home, 'hooks'), { recursive: true })
// this agent's own launch provisioned a secret file; a proof must not carry it into a route
delete process.env.SHEPHERDR_SECRET_FILE
process.env.HOME = home
process.env.SHEPHERDR_HOME = home
process.env.HERDR_SOCKET_PATH = join(home, 'no-herdr.sock')
process.env.SHEPHERDR_LAUNCH_AGENTS = '1'

const { Agents, ROUTING_FAILURE } = await import('../server/live/agents.ts')
const { herdr } = await import('../server/live/herdr.ts')
const box = await import('../server/live/box.ts')
const { writeJson } = await import('../server/store.ts')
type AgentRecord = import('../server/live/agents.ts').AgentRecord
type Agents = InstanceType<typeof Agents>

/** everything of the pass a test drives directly: no network, no real CLI, no real helper */
type Pass = {
  repairRoutes: (todo?: AgentRecord[]) => Promise<void>
  repairTodo: () => AgentRecord[]
  repairRoute: (r: AgentRecord) => Promise<void>
  bindRoute: (r: AgentRecord, pane: string, own?: boolean, deadlineMs?: number) => Promise<void>
  routes: Map<string, string>
  starting: Map<string, Promise<unknown>>
  stopping: Set<string>
  stopped: boolean
}

const cwd = tmp('route-repair-cwd')
/** one of each CLI in turn, so a pass really binds them all */
const kinds = ['claude', 'codex', 'pi', 'opencode', 'agy']

function world(n: number) {
  const records: Record<string, AgentRecord> = {}
  for (let i = 1; i <= n; i++) {
    const key = `RR-${i}/Agent`
    records[key] = { key, name: Agents.nameFor(key), kind: kinds[(i - 1) % kinds.length], cwd, workspace: 'w', logs: [], started: Date.now() }
  }
  writeJson('agents.json', records)
  writeJson('outbox.json', [])
  const a = new Agents()
  return { a, records }
}

/** the CLI process each agent's pane runs, as herdr reports it: this test's own pids, nothing is started */
const procs = new Map<string, { pid: number; argv: string[] }>()
const paneOf = (key: string) => `pane-${key.split('/')[0].toLowerCase()}`

/** herdr lists these agents, each its CLI in the pane's foreground */
function listed(a: Agents, records: AgentRecord[]) {
  const live = records.map((r) => {
    const pane = paneOf(r.key)
    if (!procs.has(pane)) procs.set(pane, { pid: 6000 + procs.size, argv: [r.kind] })
    return [r.name, { name: r.name, pane_id: pane, agent: r.kind, agent_status: 'idle' } as never] as const
  })
  a.live = new Map(live)
}

const processInfo = () => spyOn(herdr, 'processInfo').mockImplementation((async (pane: string) => ({ foreground_processes: [procs.get(pane) ?? { pid: 0, argv: [] }] })) as never)

/** the helper's `--bind`: what it was asked to bind, and a moment of work, as a child process takes. A pid `fail` says
 *  yes for is one the helper cannot write: its `--bind` and its `--check` alike say so, and the route is absent. */
function binder(ms: number, fail?: (pid: string) => boolean) {
  const written: string[] = []
  const state = { inflight: 0, peak: 0 }
  const run = spyOn(box, 'run').mockImplementation((async (argv: string[]) => {
    const pid = argv.at(-1) ?? ''
    if (argv.includes('--check')) return { code: fail?.(pid) ? 1 : 0, out: '', err: '' }
    if (!argv.includes('--bind')) throw new Error(`the repair pass made an unexpected helper call: ${argv.join(' ')}`)
    written.push(pid)
    state.peak = Math.max(state.peak, ++state.inflight)
    await Bun.sleep(ms)
    state.inflight--
    return fail?.(pid) ? { code: 1, out: '', err: 'no' } : { code: 0, out: '', err: '' }
  }) as never)
  return { written, state, run }
}

const pids = (records: AgentRecord[]) => records.map((r) => String(procs.get(paneOf(r.key))!.pid))

const until = async (f: () => boolean, ms = 5000) => {
  for (const t0 = Date.now(); !f(); await Bun.sleep(10)) if (Date.now() - t0 > ms) throw new Error('timed out')
}

describe('the route repair pass', () => {
  test('binds every live agent a chunk at a time instead of one after another', async () => {
    const BIND_MS = 25
    const { a, records } = world(20)
    listed(a, Object.values(records))
    const info = processInfo()
    const b = binder(BIND_MS)
    const inner = a as unknown as Pass
    try {
      // the pass a restart runs with the routes map empty
      const t0 = performance.now()
      await inner.repairRoutes()
      const parallel = performance.now() - t0
      expect(b.written.sort()).toEqual(pids(Object.values(records)).sort())
      expect(b.state.peak).toBeGreaterThan(1)
      expect(b.state.peak).toBeLessThanOrEqual(6)
      expect(Object.keys(records).every((k) => a.routed(k))).toBe(true)
      // the same writes one at a time, which is the pass this replaced: both numbers are the measurement for the change
      inner.routes.clear()
      b.written.length = 0
      const serialPeak = b.state.peak
      b.state.peak = 0
      const t1 = performance.now()
      for (const r of Object.values(records)) await inner.bindRoute(r, paneOf(r.key))
      const serial = performance.now() - t1
      console.log(`route repair, 20 binds of ${BIND_MS} ms: ${Math.round(serial)} ms one at a time, ${Math.round(parallel)} ms ${serialPeak} at a time`)
      expect(b.written).toHaveLength(20)
      expect(b.state.peak).toBe(1)
      // what proves the concurrency is the peak above (deterministic); the clock is only the number for the change, so
      // its assertion is loose enough for a busy machine
      expect(parallel).toBeLessThan(serial)
    } finally {
      a.stop(); info.mockRestore(); b.run.mockRestore()
    }
  })

  test('leaves an agent whose own launch binds it to that bind, and never writes a route twice', async () => {
    const { a, records } = world(5)
    const [one, pending, starting, restarting, launching] = Object.values(a.records)
    listed(a, Object.values(records))
    // the store still says its launch is pending, ensure() has its start in flight, a restart holds it, and herdr itself
    // lists the last one's launch as pending: each binds on its own start
    pending.pendingLaunch = true
    const inner = a as unknown as Pass
    inner.starting.set(starting.key, Promise.resolve(null))
    inner.stopping.add(restarting.key)
    a.live.get(launching.name)!.launch_pending = true
    const info = processInfo()
    const b = binder(0)
    try {
      await inner.repairRoutes()
      expect(b.written).toEqual(pids([one]))
      for (const r of [pending, starting, restarting, launching]) expect(a.routed(r.key)).toBe(false)
      // its launch's own bind, which the pass left to it
      await inner.bindRoute(pending, paneOf(pending.key), true)
      expect(b.written).toEqual(pids([one, pending]))
      expect(a.routed(pending.key)).toBe(true)
      // a launch that begins while an earlier chunk binds is left alone too: the route reads its own bind again just
      // before writing
      await inner.repairRoute(starting)
      expect(b.written).toEqual(pids([one, pending]))
      // their own flow is over: the next pass binds those and writes nothing a second time
      inner.starting.clear()
      inner.stopping.clear()
      a.live.get(launching.name)!.launch_pending = false
      await inner.repairRoutes()
      expect(b.written).toEqual(pids([one, pending, starting, restarting, launching]))
      expect(Object.keys(records).every((k) => a.routed(k))).toBe(true)
    } finally {
      a.stop(); info.mockRestore(); b.run.mockRestore()
    }
  })

  test('says a route that cannot be bound once and keeps the others', async () => {
    const { a, records } = world(3)
    listed(a, Object.values(records))
    const [one, broken, three] = Object.values(records)
    // the helper cannot write its route, and the file really is not there: a routing failure of its own
    const info = processInfo()
    const b = binder(0, (pid) => pid === String(procs.get(paneOf(broken.key))!.pid))
    const said: string[] = []
    const err = spyOn(console, 'error').mockImplementation(((...m: unknown[]) => { said.push(m.join(' ')) }) as never)
    try {
      await (a as unknown as Pass).repairRoutes()
      expect(said).toEqual([`shepherdr: routing ${broken.key}: ${ROUTING_FAILURE}`])
      expect(b.written.filter((p) => p === String(procs.get(paneOf(broken.key))!.pid))).toHaveLength(3) // one write, two retries
      expect(a.routed(one.key)).toBe(true)
      expect(a.routed(three.key)).toBe(true)
      expect(a.routed(broken.key)).toBe(false)
    } finally {
      err.mockRestore(); a.stop(); info.mockRestore(); b.run.mockRestore()
    }
  })

  test('one route herdr cannot even be asked about is no failure of the others', async () => {
    const { a, records } = world(3)
    listed(a, Object.values(records))
    const [one, broken, three] = Object.values(records)
    const info = spyOn(herdr, 'processInfo').mockImplementation((async (pane: string) => {
      if (pane === paneOf(broken.key)) throw new Error('herdr went away')
      return { foreground_processes: [procs.get(pane)] }
    }) as never)
    const b = binder(0)
    const said: string[] = []
    const err = spyOn(console, 'error').mockImplementation(((...m: unknown[]) => { said.push(m.join(' ')) }) as never)
    try {
      await (a as unknown as Pass).repairRoutes()
      expect(said).toEqual([`shepherdr: routing ${broken.key}: herdr went away`])
      expect(b.written.sort()).toEqual(pids([one, three]).sort())
      expect(a.routed(one.key)).toBe(true)
      expect(a.routed(three.key)).toBe(true)
      expect(a.routed(broken.key)).toBe(false)
    } finally {
      err.mockRestore(); a.stop(); info.mockRestore(); b.run.mockRestore()
    }
  })

  test('binds nothing once the server is stopping, and skips an agent that left meanwhile', async () => {
    const { a, records } = world(2)
    listed(a, Object.values(records))
    const [gone, live] = Object.values(a.records)
    const inner = a as unknown as Pass
    const info = processInfo()
    const b = binder(0)
    try {
      // herdr dropped one between the look that listed it and the pass
      const todo = inner.repairTodo()
      a.live.delete(gone.name)
      await inner.repairRoutes(todo)
      expect(b.written).toEqual(pids([live]))
      // a server that is stopping binds no route at all
      inner.routes.clear()
      b.written.length = 0
      inner.stopped = true
      await inner.repairRoutes()
      expect(b.written).toEqual([])
    } finally {
      a.stop(); info.mockRestore(); b.run.mockRestore()
    }
  })

  test('runs at the first look at herdr that lists an agent, not 30 s later', async () => {
    const { a, records } = world(2)
    listed(a, Object.values(records))
    // a server that just came up knows of no agent until it looks
    a.live = new Map()
    // herdr has not listed them yet: the first look finds nothing to bind, and that must not start the 30 s wait
    const agents = spyOn(herdr, 'agents').mockResolvedValue([] as never)
    const info = processInfo()
    const b = binder(0)
    try {
      await a.refresh()
      expect(b.written).toEqual([])
      // and the look that does list them repairs their routes for that very look
      agents.mockResolvedValue(Object.values(records).map((r) => ({ name: r.name, pane_id: paneOf(r.key), agent: r.kind, agent_status: 'idle' })) as never)
      const t0 = Date.now()
      await a.refresh()
      await until(() => Object.keys(records).every((k) => a.routed(k)))
      expect(b.written.sort()).toEqual(pids(Object.values(records)).sort())
      expect(Date.now() - t0).toBeLessThan(5000) // the 30 s wait this used to sit behind
    } finally {
      a.stop(); agents.mockRestore(); info.mockRestore(); b.run.mockRestore()
    }
  })

  test('binds a launch the store still calls pending as soon as herdr says that launch is over', async () => {
    const { a, records } = world(1)
    const [only] = Object.values(a.records)
    // a restart left its pendingLaunch in agents.json, while herdr finished that launch long ago
    only.pendingLaunch = true
    listed(a, Object.values(records))
    a.live = new Map()
    const agents = spyOn(herdr, 'agents').mockResolvedValue([{ name: only.name, pane_id: paneOf(only.key), agent: only.kind, agent_status: 'idle' }] as never)
    const info = processInfo()
    const b = binder(0)
    try {
      await a.refresh()
      await until(() => a.routed(only.key))
      expect(b.written).toEqual(pids([only]))
      expect(a.records[only.key].pendingLaunch).toBe(false)
    } finally {
      a.stop(); agents.mockRestore(); info.mockRestore(); b.run.mockRestore()
    }
  })
})
