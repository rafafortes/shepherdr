// A stalled server must not fail a launch over a route write whose answer came after the 5 s window. The helper's file,
// not the child's exit code, is the evidence: verify it, retry while the loop is healthy, and fail only when it is
// really absent. A start that genuinely cannot be routed takes its idle agent down instead of leaving it without a brief.
//
// Every CLI: the route and the record are not CLI-specific. `agents.launch`, `bindRoute` and `provisionRoute` are the one
// path Claude Code, Codex, pi, OpenCode and agy all start through; `herdr.processInfo` finds each CLI's process with
// `isAgentProcess(kind, argv)`, and the helper writes the same route for each. These tests drive that path with claude's
// argv and check the file, the retry, the brief and the teardown; no CLI has a different route write or startup wait to
// change here, so no per-CLI test is added. What is per CLI was checked and left alone: each CLI's own launch flags in
// `args()` (claude --settings/--model/--effort, pi --model/--thinking, codex -c/-m, agy --settings/--conversation,
// opencode --standalone/--session), the startup-screen reader in `start.ts` (each CLI's own screen), and the CLI's own
// time to become ready — none is touched by this change. The harness test covers the same shared spec path for claude
// and a restart to pi, with Settings on OpenCode; Codex and agy take the identical `own`-harness branch.
import { describe, expect, test, spyOn } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const home = tmp('route-late')
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
const { StallWatch } = await import('../server/live/stall.ts')
const { ROOT } = await import('../server/root.ts')
const realRun = box.run

/** the route helper writes under $HOME/.shepherdr, by design (the CLI looks there); write one for our own process here */
function writeRealRoute(key: string, cwd: string, url = 'http://127.0.0.1:7787') {
  const router = join(import.meta.dir, '..', 'helper', 'route.pl')
  const route = { chat: key, cwd, url, credentialFile: box.agentEnv(key, ROOT).SHEPHERDR_SECRET_FILE }
  const r = box.runSync(['perl', router, '--bind', String(process.pid)], { stdin: JSON.stringify(route) })
  expect(r.code).toBe(0)
  const file = join(home, '.shepherdr', 'helper', 'routes', `${process.pid}.json`)
  expect(existsSync(file)).toBe(true)
  return file
}

function agent() {
  const a = new Agents()
  const queued: string[][] = []
  Object.assign(a, { refresh: async () => undefined, queue: (_key: string, texts: string[]) => { queued.push(texts) } })
  return { a, queued }
}

const spec = (key: string) => {
  const cwd = tmp('route-cwd')
  return { key, name: `shep-${key.split('/')[0].toLowerCase()}`, kind: 'claude', cwd, workspace: 'test', tab: 'Agent', first: 'The brief.', pane: async () => 'pane-1' }
}

/** a bind called late by a stalled loop: code 124, while --check still reads the file the helper really wrote */
function lateBind(argv: string[], o: Parameters<typeof realRun>[1]) {
  return argv.includes('--bind') ? Promise.resolve({ code: 124, out: '', err: 'timed out' }) : realRun(argv, o)
}

describe('a route write that answers late', () => {
  test('a late (non-zero) bind with the file really written is not a routing failure: the brief still goes in', async () => {
    const key = 'RL-1/Agent'
    const s = { ...spec(key), model: 'claude-opus-5-5', effort: 'high' }
    const file = writeRealRoute(key, s.cwd)
    const before = readFileSync(file, 'utf8')
    const info = spyOn(herdr, 'processInfo').mockResolvedValue({ foreground_processes: [{ pid: process.pid, argv: ['claude'] }] } as never)
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const close = spyOn(herdr, 'closePane').mockResolvedValue(undefined as never)
    const run = spyOn(box, 'run').mockImplementation(lateBind as never)
    const { a, queued } = agent()
    try {
      await a.ensure(s)
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(queued.at(-1)).toContain('The brief.')
      expect(close).not.toHaveBeenCalled()
      // the record is written by the real launch from the harness it used, not Settings' default: the writer itself
      // (Object.assign in launch), not the test's fake registry
      expect(a.record(key)).toMatchObject({ kind: 'claude', model: 'claude-opus-5-5', effort: 'high' })
      // the old decision fed the very late-bind result this test just produced refuses the same world: the fix is what
      // changed the outcome. This is the bug reproduced, not a stand-in assertion.
      const late = await lateBind(['perl', 'route.pl', '--bind', String(process.pid)], { stdin: '{}' })
      const refused = (code: number) => { if (code) throw new Error(ROUTING_FAILURE) }
      expect(() => refused(late.code)).toThrow(ROUTING_FAILURE)
    } finally {
      a.stop(); info.mockRestore(); start.mockRestore(); close.mockRestore(); run.mockRestore()
    }
  })

  test('a route genuinely absent fails with its words, after retrying, and takes the idle agent down', async () => {
    const key = 'RL-2/Agent'
    const s = spec(key)
    rmSync(join(home, '.shepherdr', 'helper', 'routes', `${process.pid}.json`), { force: true })
    const info = spyOn(herdr, 'processInfo').mockResolvedValue({ foreground_processes: [{ pid: process.pid, argv: ['claude'] }] } as never)
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const close = spyOn(herdr, 'closePane').mockResolvedValue(undefined as never)
    let binds = 0
    const run = spyOn(box, 'run').mockImplementation(((argv: string[], o: Parameters<typeof realRun>[1]) => {
      if (argv.includes('--bind')) { binds++; return Promise.resolve({ code: 124, out: '', err: 'timed out' }) }
      return realRun(argv, o)
    }) as never)
    const { a, queued } = agent()
    // the agent is already up in herdr when the start fails: finish() must close that pane, not just mark it finished
    Object.assign(a, { refresh: async () => { a.live.set(s.name, { pane_id: 'pane-1', name: s.name, agent: 'claude', agent_status: 'idle' } as never) } })
    try {
      // no route file for this pid: --check really answers "not there"
      let error: unknown
      try { await a.ensure(s) } catch (e) { error = e }
      expect((error as Error)?.message).toBe(ROUTING_FAILURE)
      expect(binds).toBe(3) // one write, then two retries with backoff before giving up
      expect(queued).toEqual([]) // no brief to an agent that cannot act on it
      expect(close).toHaveBeenCalled() // no idle agent left with no brief and no card saying so
    } finally {
      a.stop(); info.mockRestore(); start.mockRestore(); close.mockRestore(); run.mockRestore()
    }
  })

  test('a cwd with a symlink component is no absence: --check compares what --bind canonicalized', () => {
    const key = 'RL-sym/Agent'
    const real = tmp('route-sym-real')
    const link = join(home, 'route-sym-link')
    rmSync(link, { force: true })
    symlinkSync(real, link)
    const router = join(import.meta.dir, '..', 'helper', 'route.pl')
    const route = { chat: key, cwd: link, url: 'http://127.0.0.1:7787', credentialFile: box.agentEnv(key, ROOT).SHEPHERDR_SECRET_FILE }
    expect(box.runSync(['perl', router, '--bind', String(process.pid)], { stdin: JSON.stringify(route) }).code).toBe(0)
    // the file holds the canonical path (bind_route: abs_path) while the server sends the symlinked one it was given
    expect(box.runSync(['perl', router, '--check', String(process.pid)], { stdin: JSON.stringify(route) }).code).toBe(0)
    rmSync(join(home, '.shepherdr', 'helper', 'routes', `${process.pid}.json`), { force: true })
    rmSync(link, { force: true })
  })

  test('a route of another capability, or whose credential never landed, is no verification', () => {
    const key = 'RL-cap/Agent'
    const real = tmp('route-cap-real')
    const router = join(import.meta.dir, '..', 'helper', 'route.pl')
    const credentialFile = box.agentEnv(key, ROOT).SHEPHERDR_SECRET_FILE
    const route = { chat: key, cwd: real, url: 'http://127.0.0.1:7787', credentialFile, capability: 'cap-A' }
    expect(box.runSync(['perl', router, '--bind', String(process.pid)], { stdin: JSON.stringify(route) }).code).toBe(0)
    expect(box.runSync(['perl', router, '--check', String(process.pid)], { stdin: JSON.stringify(route) }).code).toBe(0)
    // another capability: not the route this launch asked for (a route the previous incarnation wrote)
    expect(box.runSync(['perl', router, '--check', String(process.pid)], { stdin: JSON.stringify({ ...route, capability: 'cap-B' }) }).code).toBe(1)
    // the credential file gone (a --bind killed between its two writes): the route is unusable, so no verification
    rmSync(credentialFile, { force: true })
    expect(box.runSync(['perl', router, '--check', String(process.pid)], { stdin: JSON.stringify(route) }).code).toBe(1)
    rmSync(join(home, '.shepherdr', 'helper', 'routes', `${process.pid}.json`), { force: true })
  })

  test('the retry path adds no event-loop stall, so doctor counts none from it', async () => {
    const key = 'RL-3/Agent'
    const s = spec(key)
    writeRealRoute(key, s.cwd)
    const watch = new StallWatch({ every: 20, over: 60, slow: 30 })
    watch.start()
    const info = spyOn(herdr, 'processInfo').mockResolvedValue({ foreground_processes: [{ pid: process.pid, argv: ['claude'] }] } as never)
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    // a check answered late once (its own timer fired into a busy moment) so the backoff really runs, then the truth
    let checks = 0
    const run = spyOn(box, 'run').mockImplementation(((argv: string[], o: Parameters<typeof realRun>[1]) => {
      if (argv.includes('--bind')) return Promise.resolve({ code: 124, out: '', err: 'timed out' })
      if (argv.includes('--check') && checks++ === 0) return Promise.resolve({ code: 1, out: '', err: 'answered late' })
      return realRun(argv, o)
    }) as never)
    const { a, queued } = agent()
    try {
      await a.ensure(s)
      expect(queued.at(-1)).toContain('The brief.')
      await Bun.sleep(60)
      expect(watch.count).toBe(0)
      expect(watch.report()).toEqual([])
    } finally {
      a.stop(); watch.stop(); info.mockRestore(); start.mockRestore(); run.mockRestore()
    }
  })

  test('a ceiling that passes mid-stall still reads the file: a route that landed is no failure', async () => {
    const key = 'RL-6/Agent'
    const s = spec(key)
    writeRealRoute(key, s.cwd)
    const { a } = agent()
    // the loop never catches up (its own health gate says so) and the window is a moment: the decision must still
    // come from the file, not the clock — a check past the ceiling is the last word
    a.healthy = () => false
    const run = spyOn(box, 'run').mockImplementation(((argv: string[], o: Parameters<typeof realRun>[1]) => {
      if (argv.includes('--bind')) return Promise.resolve({ code: 124, out: '', err: 'timed out' })
      return realRun(argv, o)
    }) as never)
    const router = join(import.meta.dir, '..', 'helper', 'route.pl')
    const opts = { stdin: JSON.stringify({ chat: key, cwd: s.cwd, url: 'http://127.0.0.1:7787', credentialFile: box.agentEnv(key, ROOT).SHEPHERDR_SECRET_FILE }) }
    const inner = a as unknown as { provisionRoute: (pid: number, k: string, r: string, o: { stdin: string }, own: boolean, ms: number) => Promise<boolean> }
    try {
      expect(await inner.provisionRoute(process.pid, key, router, opts, true, 30)).toBe(true)
      // the file really absent: the ceiling is the end, and the failure is honest
      rmSync(join(home, '.shepherdr', 'helper', 'routes', `${process.pid}.json`), { force: true })
      await Bun.sleep(40)
      expect(await inner.provisionRoute(process.pid, key, router, opts, true, 30)).toBe(false)
    } finally {
      a.stop(); run.mockRestore()
    }
  })

  test("a restart's own launch binds its route: its stopping flag never strands the new agent", async () => {
    const key = 'RL-4/Agent'
    const s = spec(key)
    writeRealRoute(key, s.cwd)
    const info = spyOn(herdr, 'processInfo').mockResolvedValue({ foreground_processes: [{ pid: process.pid, argv: ['claude'] }] } as never)
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const close = spyOn(herdr, 'closePane').mockResolvedValue(undefined as never)
    const run = spyOn(box, 'run').mockImplementation(lateBind as never)
    const { a, queued } = agent()
    let routed = false
    a.on('routed', (k) => { if (k === key) routed = true })
    try {
      await a.restart(s)
      // before the fix the stopping flag a restart holds made bindRoute skip silently: no route, the brief left
      // waiting for the repair pass and the launch reading success
      expect(routed).toBe(true)
      expect(queued.at(-1)).toContain('The brief.')
    } finally {
      a.stop(); info.mockRestore(); start.mockRestore(); close.mockRestore(); run.mockRestore()
    }
  })

  test('a restart whose route is genuinely absent fails its launch and takes the new agent down', async () => {
    const key = 'RL-5/Agent'
    const s = spec(key)
    rmSync(join(home, '.shepherdr', 'helper', 'routes', `${process.pid}.json`), { force: true })
    const info = spyOn(herdr, 'processInfo').mockResolvedValue({ foreground_processes: [{ pid: process.pid, argv: ['claude'] }] } as never)
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const close = spyOn(herdr, 'closePane').mockResolvedValue(undefined as never)
    const run = spyOn(box, 'run').mockImplementation(((argv: string[], o: Parameters<typeof realRun>[1]) => {
      if (argv.includes('--bind')) return Promise.resolve({ code: 124, out: '', err: 'timed out' })
      return realRun(argv, o)
    }) as never)
    const { a, queued } = agent()
    Object.assign(a, { refresh: async () => { a.live.set(s.name, { pane_id: 'pane-1', name: s.name, agent: 'claude', agent_status: 'idle' } as never) } })
    try {
      // the restart holds its stopping flag for the whole flow: the launch inside it must still provision and fail
      const error = await a.restart(s).then(() => undefined, (e) => e)
      expect((error as Error)?.message).toBe(ROUTING_FAILURE)
      expect(queued).toEqual([])
      expect(close).toHaveBeenCalled() // no idle agent left with no brief
    } finally {
      a.stop(); info.mockRestore(); start.mockRestore(); close.mockRestore(); run.mockRestore()
    }
  })

  test('a stop that finishes the record mid-provisioning is no routing failure of the start it abandoned', async () => {
    const key = 'RL-7/Agent'
    const s = spec(key)
    rmSync(join(home, '.shepherdr', 'helper', 'routes', `${process.pid}.json`), { force: true })
    const info = spyOn(herdr, 'processInfo').mockResolvedValue({ foreground_processes: [{ pid: process.pid, argv: ['claude'] }] } as never)
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const { a } = agent()
    const records = (a as unknown as { records: Record<string, { finished?: boolean; startError?: string }> }).records
    // the human's stop lands while the bind waits: the record reads finished before any check answers
    const run = spyOn(box, 'run').mockImplementation(((argv: string[], o: Parameters<typeof realRun>[1]) => {
      if (argv.includes('--bind')) {
        const r = records[s.key]
        if (r) r.finished = true
        return Promise.resolve({ code: 124, out: '', err: 'timed out' })
      }
      return realRun(argv, o)
    }) as never)
    try {
      // no ROUTING_FAILURE and no startError: the stop owns what happens next, never "Went wrong" for it
      await a.ensure(s)
      expect(records[s.key]?.startError).toBeUndefined()
    } finally {
      a.stop(); info.mockRestore(); start.mockRestore(); run.mockRestore()
    }
  })
})
