// The resource lines in `shepherdr doctor`: what the hourly sweep finds (RES-03) — a cwd under a worktree Shepherdr
// removed, or a proof server's SHEPHERDR_HOME under /tmp — and the ready kill line beside each. Nothing here reads
// the operator's processes: the process table, the worktree root and the ender are all stand-ins.
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const home = tmp('doctor-orphans')
process.env.SHEPHERDR_HOME = home
process.env.HERDR_SOCKET_PATH = join(home, 'no-herdr.sock')
const standIns = tmp('doctor-orphans-bin')
for (const n of ['herdr', 'agent-browser']) writeFileSync(join(standIns, n), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
process.env.PATH = `${standIns}:${process.env.PATH}`
process.env.SHEPHERDR_AGENT_BROWSER = join(standIns, 'agent-browser')

const O = await import('../server/live/orphans.ts')
const R = await import('../server/live/resources.ts')
const { LiveSource } = await import('../server/live/source.ts')
type Row = import('../server/live/orphans.ts').Row
type Source = import('../server/live/orphans.ts').Source
type ScanOpts = import('../server/live/orphans.ts').ScanOpts
const src = new LiveSource()
src.checkLogRoot = join(home, 'check-local') // the default reader never measures this machine's check logs
afterAll(() => src.stop())
/** the news is sent when the set changes; each test starts with a fresh set */
const resetSignature = () => {
  ;(src as unknown as { orphanSignature: string }).orphanSignature = ''
}

/** worktree root of this test, with one worktree still live and one gone */
const opts: ScanOpts = { worktrees: '/wt', exists: (p) => p === '/wt/repo/live' }
const rows: Row[] = [
  { pid: 101, ppid: 1, cmd: 'node dev.mjs', cwd: '/wt/repo/gone/sub' },
  { pid: 102, ppid: 1, cmd: 'bun server/main.ts', cwd: '/elsewhere', home: '/tmp/proof-x' },
  { pid: 103, ppid: 1, cmd: 'node both', cwd: '/wt/repo/gone', home: '/tmp/proof-y' },
  { pid: 104, ppid: 1, cmd: 'claude', cwd: '/wt/repo/live', home: '/home/u/.shepherdr' }, // live worktree, real home
  { pid: 105, ppid: 1, cmd: 'bun server/main.ts', cwd: '/wt/repo/live', home: '/tmp/proof-live' }, // a LIVE task's proof server
  { pid: 106, ppid: 1, cmd: 'bun server/main.ts', cwd: '/wt/repo/gone (deleted)' }, // cwd of a removed folder, as /proc names it
  { pid: 500, ppid: 1, cmd: 'herdr --serve', cwd: '/' }, // a live pane's ancestry
  { pid: 501, ppid: 500, cmd: 'bash', cwd: '/' },
  { pid: 502, ppid: 501, cmd: 'pi', cwd: '/wt/repo/gone', home: '/tmp/proof-pane' }, // live agent, removed cwd + proof home
  { pid: 1, ppid: 0, cmd: 'init', cwd: '/wt/repo/gone', home: '/tmp/proof-init' }, // never pid 1
]

/** a stand-in process table for the sweep, built from rows */
function sourceFor(table: Row[]): Source {
  const byPid = new Map(table.map((r) => [r.pid, r]))
  return {
    platform: 'linux',
    pids: () => [...byPid.keys()].map(String),
    read: (p) => {
      const m = /^\/proc\/(\d+)\/(stat|status|cmdline|environ)$/.exec(p)
      if (!m) return ''
      const r = byPid.get(Number(m[1]))
      if (!r) return ''
      if (m[2] === 'stat') return `${r.pid} (x) S ${r.ppid} 0`
      if (m[2] === 'status') return 'Uid:\t1000'
      if (m[2] === 'cmdline') return r.cmd
      return r.home ? `SHEPHERDR_HOME=${r.home}` : ''
    },
    link: (p) => {
      const m = /^\/proc\/(\d+)\/cwd$/.exec(p)
      return m ? (byPid.get(Number(m[1]))?.cwd ?? '') : ''
    },
    selfUid: () => 1000,
    ps: () => '',
    now: () => 1000,
  }
}

describe('what the sweep recognises', () => {
  test('a removed worktree is a leftover; a proof home under /tmp is proof-marked; both are named', () => {
    const found = O.scan(rows, opts)
    expect(found.map((f) => [f.pid, f.kind])).toEqual([
      [101, 'worktree'],
      [102, 'proof'],
      [103, 'proof'],
      [106, 'worktree'],
    ])
    expect(found[0].why).toBe('cwd in a removed worktree /wt/repo/gone/sub')
    expect(found[1].why).toBe('SHEPHERDR_HOME /tmp/proof-x')
    expect(found[2].why).toContain('cwd in a removed worktree')
    expect(found[2].why).toContain('SHEPHERDR_HOME /tmp/proof-y')
    expect(found[3].why).toBe('cwd in a removed worktree /wt/repo/gone') // /proc's " (deleted)" stripped
    expect(found.map((f) => f.kill)).toEqual(['kill -TERM 101', 'kill -TERM 102', 'kill -TERM 103', 'kill -TERM 106'])
    // a live task's worktree, a live pane's ancestry (even under a removed worktree with a proof home), a real home
    // and pid 1 are none of this sweep's business
    expect(found.some((f) => [104, 105, 502, 1].includes(f.pid))).toBe(false)
  })

  test('the helpers stay narrow: only /tmp homes, only worktrees directly under the root that are gone', () => {
    expect(O.proofHome('/tmp/proof-1')).toBe(true)
    expect(O.proofHome('/home/u/.shepherdr')).toBe(false)
    expect(O.proofHome(undefined)).toBe(false)
    expect(O.removedWorktree('/wt/repo/gone/a/b', opts)).toBe(true)
    expect(O.removedWorktree('/wt/repo/gone (deleted)', opts)).toBe(true)
    expect(O.removedWorktree('/wt/repo/live', opts)).toBe(false)
    expect(O.removedWorktree('/elsewhere', opts)).toBe(false)
    expect(O.removedWorktree('/wt/repo', opts)).toBe(false)
    expect(O.liveWorktree('/wt/repo/live', opts)).toBe(true)
    expect(O.liveWorktree('/wt/repo/gone', opts)).toBe(false)
    expect(O.liveWorktree('/elsewhere', opts)).toBe(false)
    const byPid = new Map(rows.map((r) => [r.pid, r]))
    expect(O.underHerdr(502, byPid)).toBe(true)
    expect(O.underHerdr(101, byPid)).toBe(false)
    // a corrupt parent chain that loops must end, not spin
    expect(
      O.underHerdr(
        700,
        new Map([
          [700, { pid: 700, ppid: 701, cmd: 'x', cwd: '' }],
          [701, { pid: 701, ppid: 700, cmd: 'y', cwd: '' }],
        ]),
      ),
    ).toBe(false)
  })

  test('a worktree path in a command is not the herdr daemon: the real orphan stays visible', () => {
    // a server started with an absolute path into its worktree is exactly the leftover Part 2 exists to find
    const orphan: Row[] = [{ pid: 800, ppid: 1, cmd: 'node qa.mjs --out /home/u/.herdr/worktrees/website/work-38/out', cwd: '/wt/repo/gone' }]
    expect(O.scan(orphan, opts).map((f) => f.pid)).toEqual([800])
  })

  test('only proof-marked pids are ever candidates for an end, and none when clean', () => {
    expect(O.proofPids(O.scan(rows, opts))).toEqual([102, 103])
    expect(O.scan([], opts)).toEqual([])
    expect(O.lines([])).toEqual([])
  })
})

describe('the doctor lines', () => {
  test('a ready command for all, then each with why and how to end it', () => {
    const found = O.scan(rows, opts)
    const lines = O.lines(found)
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe('Orphaned processes (RES-03): 4 found at the last hourly look. End the proof-marked ones with: kill -TERM 102 103')
    expect(lines[1]).toContain('pid 101: node dev.mjs — cwd in a removed worktree /wt/repo/gone/sub; end it: kill -TERM 101')
    expect(lines[2]).toContain('proof-marked; auto-end is off until the operator decides')
    expect(lines[3]).toContain('end it: kill -TERM 103')
    expect(lines[4]).toContain('end it: kill -TERM 106')
    expect(O.newsLine(found, [102, 103])).toContain('Ended 2 proof-marked: 102, 103.')
    expect(O.newsLine(found, [])).toContain('pid 101 (node dev.mjs)')
  })

  test('a large sweep stays short: eight named, the count of the rest, and a capped kill line', () => {
    const many = Array.from({ length: 24 }, (_, i) => ({ pid: 900 + i, ppid: 1, cmd: 'node dev.mjs', cwd: '/wt/repo/gone', home: i % 2 ? '/tmp/proof' : undefined }))
    const found = O.scan(many, opts)
    const lines = O.lines(found)
    expect(found).toHaveLength(24)
    expect(lines).toHaveLength(1 + O.SHOWN + 1)
    expect(lines[0]).toContain('24 found')
    expect(lines[0]).toContain('(first 8)')
    expect(lines.at(-1)).toContain('and 16 more')
    const news = O.newsLine(found, O.proofPids(found))
    expect(news).toContain('and 16 more')
    expect(news.length).toBeLessThan(2500) // a phone's card, not 24 pids in three places
  })

  test('the CLI prints the resource lines when the sweep found orphans, and none when it did not', async () => {
    src.orphansFound = O.scan(rows, opts)
    try {
      const out = (await src.cli(['doctor'], {})).out
      expect(out).toContain('Orphaned processes (RES-03): 4 found at the last hourly look.')
      expect(out).toContain('kill -TERM 102 103')
      expect(out).toContain('pid 101: node dev.mjs')
    } finally {
      src.orphansFound = []
    }
    expect((await src.cli(['doctor'], {})).out).not.toContain('Orphaned processes (RES-03)')
  })

  test('the RES-09 line names stale installs from the injected reader and deletes nothing', async () => {
    const family = '/x/github-installations/herdr-projects-abc'
    const old = 1_000_000_000_000
    const day = 86_400_000
    const io = {
      now: () => old + 40 * day,
      dirs: () => [
        { name: '100-0', mtime: old + 39 * day }, // running
        { name: '90-0', mtime: old + 38 * day }, // previous
        { name: '10-0', mtime: old }, // 40 days old
      ],
      processes: () => [],
    }
    const wasIO = src.installIO
    const wasRoot = src.installRoot
    try {
      src.installIO = io
      src.installRoot = join(family, '100-0', 'checkout')
      const out = (await src.cli(['doctor'], {})).out
      expect(out).toContain('Stale plugin installs (RES-09): 1 older than 14 days; running and 2 newest kept.')
      expect(out).toContain(`${join(family, '10-0')} (40 days old; no supervisor or server command line names it`)
      expect(out).toContain('Report only:')
      expect(existsSync(join(family, '10-0'))).toBe(false)
      // an empty reader, not this host's, proves the line goes away when there is nothing stale
      src.installIO = { now: () => 0, dirs: () => [], processes: () => [] }
      expect((await src.cli(['doctor'], {})).out).not.toContain('Stale plugin installs (RES-09)')
    } finally {
      src.installIO = wasIO
      src.installRoot = wasRoot
    }
  })
})

describe('the resource lines', () => {
  /** a stand-in folder tree: /box/inbox has a subfolder, a file and a link; only the two files have bytes */
  const io: import('../server/live/resources.ts').SizeIO = {
    exists: (p) => ['/box/inbox', '/box/inbox/a', '/box/artifacts'].includes(p),
    entries: (p) =>
      p === '/box/inbox'
        ? [
            { name: 'a', dir: true, link: false },
            { name: 'x.txt', dir: false, link: false },
            { name: 'loop', dir: false, link: true },
          ]
        : p === '/box/inbox/a'
          ? [{ name: 'y.txt', dir: false, link: false }]
          : p === '/box/artifacts'
            ? []
            : [],
    size: (p) => ({ '/box/inbox/x.txt': 1024, '/box/inbox/a/y.txt': 2048 })[p] ?? 0,
  }

  test('a folder size sums files recursively, skips links and is undefined when absent', () => {
    expect(R.folderSize('/box/inbox', io)).toBe(3072)
    expect(R.folderSize('/box/artifacts', io)).toBe(0)
    expect(R.folderSize('/box/browser', io)).toBeUndefined()
  })

  test('a size uses the biggest unit that fits', () => {
    expect(R.bytes(512)).toBe('512 B')
    expect(R.bytes(1536)).toBe('1.5 KB')
    expect(R.bytes(2 * 1024 * 1024)).toBe('2.0 MB')
  })

  test('the real folder reader measures a folder on disk', () => {
    const dir = join(home, 'sizes')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), '1234567890')
    expect(R.folderSize(dir)).toBe(10)
  })

  test('agent counts group idle and done by kind; only non-live Chrome tasks are orphans', () => {
    const records = {
      a: { key: 'a', kind: 'claude' },
      b: { key: 'b', kind: 'pi' },
      c: { key: 'c', kind: 'pi' },
      d: { key: 'd', kind: 'codex' },
    }
    const status = (key: string) => ({ a: 'idle', b: 'idle', c: 'done', d: 'working' })[key] ?? 'gone'
    expect(R.agentCounts(records, status)).toEqual({ idle: { claude: 1, pi: 1 }, done: { pi: 1 } })
    const chromes = [
      { pid: 1, task: 'SHE-1', age: 0 },
      { pid: 2, task: 'SHE-2', age: 0 },
    ]
    expect(R.orphanChromes(chromes, new Set(['SHE-1']))).toEqual([chromes[1]])
  })

  const facts = (over: Partial<import('../server/live/resources.ts').Resources> = {}): import('../server/live/resources.ts').Resources => ({
    idle: { claude: 1, pi: 2, codex: 0 },
    done: { claude: 1 },
    kept: ['SHE-1 worktree, branch'],
    chromes: [
      { pid: 1, task: 'SHE-9', age: 100 },
      { pid: 2, task: 'SHE-9', age: 200 },
    ],
    folders: [
      { name: 'inbox', bytes: 1536 },
      { name: 'check logs', bytes: 5 * 1024 * 1024 * 1024 },
    ],
    ...over,
  })

  test('each growing thing gets one line, naming the verb or setting that deals with it', () => {
    const out = R.lines(facts())
    expect(out).toHaveLength(6)
    expect(out[0]).toContain('Idle agents: 1 claude, 2 pi')
    expect(out[0]).toContain('agents.idleClose')
    expect(out[1]).toContain('Done agents still running: 1 claude')
    expect(out[1]).toContain('agents.idleClose')
    expect(out[2]).toContain('Done tasks keeping work (1): SHE-1 worktree, branch')
    expect(out[2]).toContain('tasks.keptExpiry')
    expect(out[3]).toContain('Shared-browser processes of done or gone tasks (2): SHE-9 (2)')
    expect(out[3]).toContain('browser.idleClose')
    expect(out[4]).toContain('Shepherdr inbox: 1.5 KB')
    expect(out[4]).toContain('tasks.inboxKeep')
    expect(out.at(-1)).toContain('SHEPHERDR_CHECK_KEEP')
  })

  test('an empty machine produces none, and a large set stays short', () => {
    expect(
      R.lines(
        facts({
          idle: {},
          done: {},
          kept: [],
          chromes: [],
          folders: [
            { name: 'inbox', bytes: undefined },
            { name: 'browser', bytes: 0 },
          ],
        }),
      ),
    ).toEqual([])
    const many = facts({
      kept: Array.from({ length: 12 }, (_, i) => `SHE-${i} worktree`),
      chromes: Array.from({ length: 12 }, (_, i) => ({ pid: i, task: `SHE-${i}`, age: 0 })),
      idle: {},
      done: {},
      folders: [],
    })
    const out = R.lines(many)
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('and 4 more')
    expect(out[1]).toContain('and 4 more tasks')
  })

  test('the CLI prints the lines from the reader, and none when it is empty', async () => {
    const was = src.resourceReader
    try {
      src.resourceReader = async () => facts()
      const out = (await src.cli(['doctor'], {})).out
      expect(out).toContain('Idle agents: 1 claude, 2 pi')
      expect(out).toContain('Done tasks keeping work (1)')
      expect(out).toContain('Shared-browser processes of done or gone tasks (2)')
      expect(out).toContain('Shepherdr inbox: 1.5 KB')
      src.resourceReader = async () => ({ idle: {}, done: {}, kept: [], chromes: [], folders: [] })
      const clean = (await src.cli(['doctor'], {})).out
      for (const word of ['Idle agents:', 'Done agents still running:', 'Done tasks keeping work', 'Shared-browser processes', 'Shepherdr inbox:']) expect(clean).not.toContain(word)
    } finally {
      src.resourceReader = was
    }
  })
})

describe('the hourly sweep', () => {
  test('report-only by default: it names orphans and the kill line, and ends nothing', async () => {
    resetSignature()
    src.orphanSource = sourceFor(rows)
    src.orphanOpts = opts
    src.autoKillProof = false
    const ended: number[][] = []
    const realEnd = src.orphanEnd
    src.orphanEnd = async (pids) => {
      ended.push(pids)
      return []
    }
    const news = spyOn(src as unknown as { news: (...a: unknown[]) => void }, 'news')
    try {
      const found = await src.sweepOrphans()
      expect(found.map((f) => f.pid)).toEqual([101, 102, 103, 106])
      expect(src.orphansFound).toHaveLength(4)
      expect(ended).toEqual([]) // report-only, including the proof-marked ones
      expect(news).toHaveBeenCalled()
      const said = String(news.mock.calls[0][1])
      expect(said).toContain('pid 101')
      expect(said).toContain('pid 102')
      expect(said).toContain('kill -TERM <pid>')
      expect(news.mock.calls[0][2]).toBe('stalled')
      // the set did not change: no second news
      news.mockClear()
      await src.sweepOrphans()
      expect(news).not.toHaveBeenCalled()
    } finally {
      news.mockRestore()
      src.orphanEnd = realEnd
    }
  })

  test('once allowed, only proof-marked orphans are ended; an unknown one stays a report', async () => {
    resetSignature()
    src.orphanSource = sourceFor(rows)
    src.orphanOpts = opts
    src.autoKillProof = true
    const ended: number[][] = []
    const realEnd = src.orphanEnd
    src.orphanEnd = async (pids) => {
      ended.push(pids)
      return []
    }
    const news = spyOn(src as unknown as { news: (...a: unknown[]) => void }, 'news')
    try {
      await src.sweepOrphans()
      expect(ended).toEqual([[102, 103]]) // not 101: a removed worktree is not proof-marked
      expect(String(news.mock.calls[0][1])).toContain('Ended 2 proof-marked: 102, 103.')
    } finally {
      news.mockRestore()
      src.orphanEnd = realEnd
      src.autoKillProof = false
    }
  })
})
