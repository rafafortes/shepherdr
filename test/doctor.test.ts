// The resource lines in `shepherdr doctor`: what the hourly sweep finds (RES-03) — a cwd under a worktree Shepherdr
// removed, or a proof server's SHEPHERDR_HOME under /tmp — and the ready kill line beside each. Nothing here reads
// the operator's processes: the process table, the worktree root and the ender are all stand-ins.
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
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
const { LiveSource } = await import('../server/live/source.ts')
type Row = import('../server/live/orphans.ts').Row
type Source = import('../server/live/orphans.ts').Source
type ScanOpts = import('../server/live/orphans.ts').ScanOpts
const src = new LiveSource()
afterAll(() => src.stop())
/** the news is sent when the set changes; each test starts with a fresh set */
const resetSignature = () => { (src as unknown as { orphanSignature: string }).orphanSignature = '' }

/** worktree root of this test, with one worktree still live and one gone */
const opts: ScanOpts = { worktrees: '/wt', exists: (p) => p === '/wt/repo/live' }
const rows: Row[] = [
  { pid: 101, ppid: 1, cmd: 'node dev.mjs', cwd: '/wt/repo/gone/sub' },
  { pid: 102, ppid: 1, cmd: 'bun server/main.ts', cwd: '/elsewhere', home: '/tmp/proof-x' },
  { pid: 103, ppid: 1, cmd: 'node both', cwd: '/wt/repo/gone', home: '/tmp/proof-y' },
  { pid: 104, ppid: 1, cmd: 'claude', cwd: '/wt/repo/live', home: '/home/u/.shepherdr' }, // live worktree, real home
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
    expect(found.map((f) => [f.pid, f.kind])).toEqual([[101, 'worktree'], [102, 'proof'], [103, 'proof']])
    expect(found[0].why).toBe('cwd in a removed worktree /wt/repo/gone/sub')
    expect(found[1].why).toBe('SHEPHERDR_HOME /tmp/proof-x')
    expect(found[2].why).toContain('cwd in a removed worktree')
    expect(found[2].why).toContain('SHEPHERDR_HOME /tmp/proof-y')
    expect(found.map((f) => f.kill)).toEqual(['kill -TERM 101', 'kill -TERM 102', 'kill -TERM 103'])
    // a worktree still on disk, a real Shepherdr home and pid 1 are none of this sweep's business
    expect(found.some((f) => f.pid === 104 || f.pid === 1)).toBe(false)
  })

  test('the helpers stay narrow: only /tmp homes, only worktrees directly under the root that are gone', () => {
    expect(O.proofHome('/tmp/proof-1')).toBe(true)
    expect(O.proofHome('/home/u/.shepherdr')).toBe(false)
    expect(O.proofHome(undefined)).toBe(false)
    expect(O.removedWorktree('/wt/repo/gone/a/b', opts)).toBe(true)
    expect(O.removedWorktree('/wt/repo/live', opts)).toBe(false)
    expect(O.removedWorktree('/elsewhere', opts)).toBe(false)
    expect(O.removedWorktree('/wt/repo', opts)).toBe(false)
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
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('Orphaned processes (RES-03): 3 found. End them all with: kill -TERM 101 102 103')
    expect(lines[1]).toContain('pid 101: node dev.mjs — cwd in a removed worktree /wt/repo/gone/sub; end it: kill -TERM 101')
    expect(lines[2]).toContain('proof-marked; auto-end is off until the operator decides')
    expect(lines[3]).toContain('end it: kill -TERM 103')
    expect(O.newsLine(found, [102, 103])).toContain('Ended 2 proof-marked: 102, 103.')
    expect(O.newsLine(found, [])).toContain('pid 101 (node dev.mjs)')
  })

  test('the CLI prints the resource lines when the sweep found orphans, and none when it did not', async () => {
    src.orphansFound = O.scan(rows, opts)
    try {
      const out = (await src.cli(['doctor'], {})).out
      expect(out).toContain('Orphaned processes (RES-03): 3 found.')
      expect(out).toContain('kill -TERM 101 102 103')
      expect(out).toContain('pid 101: node dev.mjs')
    } finally {
      src.orphansFound = []
    }
    expect((await src.cli(['doctor'], {})).out).not.toContain('Orphaned processes (RES-03)')
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
    src.orphanEnd = async (pids) => { ended.push(pids); return [] }
    const news = spyOn(src as unknown as { news: (...a: unknown[]) => void }, 'news')
    try {
      const found = await src.sweepOrphans()
      expect(found.map((f) => f.pid)).toEqual([101, 102, 103])
      expect(src.orphansFound).toHaveLength(3)
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
    src.orphanEnd = async (pids) => { ended.push(pids); return [] }
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
