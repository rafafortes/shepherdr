// A pane closes but the processes under its shell do not (RES-03): MCP servers, their puppeteer Chromes, dev servers.
// Every reader here is a stand-in table — nothing in this file looks at the operator's processes — and one real child
// of this test is started and ended to exercise the production signal helpers. The tree walk is CLI-agnostic: a child
// of each of the five CLIs is seeded, so one reaper covers all of them.
import { describe, expect, spyOn, test } from 'bun:test'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('agents-reap')
const O = await import('../server/live/orphans.ts')
const { herdr } = await import('../server/live/herdr.ts')
const { Agents } = await import('../server/live/agents.ts')
type Row = import('../server/live/orphans.ts').Row
type Source = import('../server/live/orphans.ts').Source
type EndDeps = import('../server/live/orphans.ts').EndDeps

const UID = 4242

/** the shell's tree: one helper per CLI, the MCPs' Chromes, a dev server, and a live task's shared browser */
const shell = 100
const rows: Row[] = [
  { pid: shell, ppid: 1, cmd: '/bin/bash', cwd: '/work' },
  { pid: 201, ppid: shell, cmd: 'node chrome-devtools-mcp.js', cwd: '/work' }, // claude's MCP
  { pid: 202, ppid: 201, cmd: 'chrome --type=renderer --user-data-dir=/tmp/puppeteer_dev_chrome_profile-abc', cwd: '/tmp' },
  { pid: 203, ppid: shell, cmd: 'sh -c check', cwd: '/work' }, // codex: its MCPs run in-process, but a tree child is the same
  { pid: 204, ppid: shell, cmd: 'node pi-mcp.js', cwd: '/work' }, // pi's MCP
  { pid: 205, ppid: 204, cmd: 'chrome --user-data-dir=/tmp/puppeteer_dev_chrome_profile-def', cwd: '/tmp' },
  { pid: 206, ppid: shell, cmd: 'opencode serve --standalone', cwd: '/work' }, // opencode's daemon
  { pid: 207, ppid: shell, cmd: 'agy helper', cwd: '/work' }, // agy's helper
  { pid: 208, ppid: shell, cmd: 'bun server/main.ts', cwd: '/work' }, // the dev server the task left
  { pid: 300, ppid: shell, cmd: 'chrome --user-data-dir=/home/u/.shepherdr/browser/SHE-99/', cwd: '/work' }, // a live task's browser
  { pid: 400, ppid: 1, cmd: 'definitely not ours', cwd: '/work' },
]

/** a stand-in /proc table built from the rows the reaper should see. `reads` counts process-table reads. */
function procSource(rows: Row[], uid = UID) {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const s = {
    platform: 'linux',
    reads: 0,
    pids: () => [...byPid.keys()].map(String),
    read(path: string): string {
      s.reads++
      const m = /^\/proc\/(\d+)\/(stat|status|cmdline|environ)$/.exec(path)
      if (!m) return ''
      const r = byPid.get(Number(m[1]))
      if (!r) return ''
      if (m[2] === 'stat') return `${r.pid} (x) S ${r.ppid} 0 0 0`
      if (m[2] === 'status') return `Name:\tx\nUid:\t${r.uid ?? uid}\t${r.uid ?? uid}\t${r.uid ?? uid}\t${r.uid ?? uid}`
      if (m[2] === 'cmdline') return r.cmd.split(' ').join('\0')
      return r.home ? `PATH=/usr/bin\0SHEPHERDR_HOME=${r.home}\0` : 'PATH=/usr/bin\0'
    },
    link(path: string): string {
      const m = /^\/proc\/(\d+)\/cwd$/.exec(path)
      return m ? (byPid.get(Number(m[1]))?.cwd ?? '') : ''
    },
    selfUid: () => uid,
    ps: () => '',
    now: () => 1000,
  }
  return s
}

/** a stand-in macOS table: `ps -axo pid=,ppid=,command=` gives parent and command, never cwd or environment */
const psSource = (text: string): Source => ({ platform: 'darwin', pids: () => [], read: () => '', link: () => '', selfUid: () => UID, ps: () => text, now: () => 1000 })

/** a record of what was signalled, for the injected ender */
function endSpy(live = new Set<number>()) {
  const signals: { pid: number; sig: string }[] = []
  const d: EndDeps = {
    signal: (pid, sig) => {
      signals.push({ pid, sig })
      live.delete(pid) // the stand-in TERM is enough; a stubborn one is made in the test below
    },
    alive: (pid) => live.has(pid),
    wait: async () => undefined,
  }
  return { d, signals, live }
}

describe('reading the process table', () => {
  test('Linux: /proc gives parent, command, cwd and proof home; another user is left out', () => {
    const source = procSource([
      { pid: 10, ppid: 1, cmd: 'node server/main.ts', cwd: '/work', home: '/tmp/proof-1' },
      { pid: 11, ppid: 1, cmd: 'node other-user.mjs', cwd: '/work', uid: UID + 1 },
      { pid: 12, ppid: 1, cmd: '', cwd: '' },
    ])
    const rows = O.readRows(source)
    expect(rows).toEqual([{ pid: 10, ppid: 1, cmd: 'node server/main.ts', cwd: '/work', home: '/tmp/proof-1', uid: UID }, { pid: 12, ppid: 1, cmd: '', cwd: '', uid: UID }])
    expect(source.reads).toBeGreaterThan(0) // one table read, not one ps per process
  })

  test('macOS: ps -axo pid=,ppid=,command= gives ancestry and command, no cwd or environment', () => {
    // The brief's exact reader. Without /proc there is no cwd and no SHEPHERDR_HOME, so the hourly sweep cannot
    // recognise proof homes or removed worktrees there; the close reap, which walks ancestry only, still works.
    const rows = O.readRows(psSource('  100     1 /usr/bin/claude\n  201   100 node mcp.js\n'))
    expect(rows).toEqual([
      { pid: 100, ppid: 1, cmd: '/usr/bin/claude', cwd: '' },
      { pid: 201, ppid: 100, cmd: 'node mcp.js', cwd: '' },
    ])
    expect(O.descendants(rows, 100)).toEqual([201])
  })

  test('the machine reader reads the real /proc, and the signal helpers end a process of this test', async () => {
    const rows = O.readRows(O.systemSource)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.pid === process.pid && r.cmd)).toBe(true)
    // a real child, ours to end: SIGTERM is enough for `sleep`, and the production helpers are what signal it
    const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      const ended = await O.end([child.pid], O.endDeps, 200)
      expect(ended).toEqual([])
      expect(O.endDeps.alive(child.pid)).toBe(false)
    } finally {
      try { child.kill() } catch { /* gone */ }
    }
  }, 10_000)
})

describe('reaping a closing pane', () => {
  test('all five CLIs\' descendants are caught; a live task\'s agent-browser Chrome and a stranger are not', async () => {
    const caught = O.capture(rows, shell).sort((a, b) => a - b)
    expect(caught).toEqual([201, 202, 203, 204, 205, 206, 207, 208])
    // the live task's Chrome (300) stays for browser.ts; pid 400 is not under the shell
    expect(caught).not.toContain(300)
    expect(caught).not.toContain(400)
    const spy = endSpy(new Set(caught))
    expect(await O.end(caught, spy.d, 10)).toEqual([])
    // TERM goes to everyone in one pass; only those still alive get KILL
    expect(spy.signals.filter((s) => s.sig === 'SIGTERM').map((s) => s.pid)).toEqual(caught)
    expect(spy.signals.filter((s) => s.sig === 'SIGKILL')).toEqual([])
  })

  test('SIGKILL follows SIGTERM only for those that did not go; a gone one is not signalled twice', async () => {
    const spy = endSpy(new Set([101, 102]))
    // 101 answers TERM; 102 only goes on KILL. The stand-in ender drops a pid on TERM unless it is "stubborn".
    const d: EndDeps = {
      ...spy.d,
      signal: (pid, sig) => {
        spy.signals.push({ pid, sig })
        if (sig === 'SIGKILL' || pid !== 102) spy.live.delete(pid)
      },
    }
    expect(await O.end([101, 102], d, 10)).toEqual([])
    expect(spy.signals).toEqual([{ pid: 101, sig: 'SIGTERM' }, { pid: 102, sig: 'SIGTERM' }, { pid: 102, sig: 'SIGKILL' }])
  })

  test('a pane with no shell pid, or a bad one, captures nothing', () => {
    expect(O.descendants(rows, 0)).toEqual([])
    expect(O.descendants(rows, 1)).toEqual([])
    expect(O.capture(rows, 99999)).toEqual([])
  })

  test('a real spin of 208 orphan Chromes in a busy table: all are ended, from one table read', async () => {
    const busy: Row[] = [{ pid: shell, ppid: 1, cmd: '/bin/bash', cwd: '/work' }]
    for (let i = 0; i < 208; i++) busy.push({ pid: 1000 + i, ppid: shell, cmd: `chrome --user-data-dir=/tmp/puppeteer_dev_chrome_profile-${i}`, cwd: '/tmp' })
    for (let i = 0; i < 1000; i++) busy.push({ pid: 10000 + i, ppid: 1, cmd: 'unrelated', cwd: '/' })
    const source = procSource(busy)
    const spy = endSpy(new Set(busy.map((r) => r.pid)))
    const at = performance.now()
    const caught = O.capture(O.readRows(source), shell)
    const left = await O.end(caught, spy.d, 10)
    const ms = performance.now() - at
    expect(caught).toHaveLength(208)
    expect(left).toEqual([])
    expect(source.reads).toBe(busy.length * 4) // one read of each entry; no per-process ps
    // counters for --facts: 208 ended, 1209 rows read, `ms` milliseconds in memory
    expect(ms).toBeLessThan(5000)
  }, 10_000)
})

describe('finish closes the pane and ends what survived it', () => {
  test('an agent whose tree holds a spawned server: the server is in the captured set and the pane closes', async () => {
    const agents = new Agents()
    agents.records['SHE-70/Agent'] = { key: 'SHE-70/Agent', name: 'agent-one', kind: 'claude', cwd: '/work', workspace: 'w', started: 0, logs: [], finished: false } as never
    agents.live.set('agent-one', { pane_id: 'pane-1', name: 'agent-one' } as never)
    const ended: number[][] = []
    agents.reaper = { source: procSource(rows), end: async (pids) => { ended.push([...pids].sort((a, b) => a - b)); return [] } }
    const refresh = spyOn(agents, 'refresh').mockResolvedValue(undefined as never)
    const info = spyOn(herdr, 'processInfo').mockResolvedValue({ shell_pid: shell } as never)
    const close = spyOn(herdr, 'closePane').mockResolvedValue(undefined as never)
    try {
      await agents.finish('SHE-70/Agent')
      expect(close).toHaveBeenCalledWith('pane-1')
      expect(ended).toEqual([[201, 202, 203, 204, 205, 206, 207, 208]]) // not the live task's Chrome
      expect(agents.records['SHE-70/Agent'].finished).toBe(true)
    } finally {
      refresh.mockRestore(); info.mockRestore(); close.mockRestore()
    }
  })

  test('a pane herdr no longer knows about still closes, and ends nothing', async () => {
    const agents = new Agents()
    agents.records['SHE-70/Agent'] = { key: 'SHE-70/Agent', name: 'agent-two', kind: 'pi', cwd: '/work', workspace: 'w', started: 0, logs: [], finished: false } as never
    agents.live.set('agent-two', { pane_id: 'pane-2' } as never)
    const ended: number[][] = []
    agents.reaper = { source: procSource(rows), end: async (pids) => { ended.push(pids); return [] } }
    const refresh = spyOn(agents, 'refresh').mockResolvedValue(undefined as never)
    const info = spyOn(herdr, 'processInfo').mockRejectedValue(new Error('pane gone') as never)
    const close = spyOn(herdr, 'closePane').mockResolvedValue(undefined as never)
    try {
      await agents.finish('SHE-70/Agent')
      expect(close).toHaveBeenCalledWith('pane-2')
      expect(ended).toEqual([])
    } finally {
      refresh.mockRestore(); info.mockRestore(); close.mockRestore()
    }
  })
})

