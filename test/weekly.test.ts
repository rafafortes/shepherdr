// The weekly full check (SHE-90, audit 2026-11-18 QG-11): one run of the whole gate on the default branch, an
// automation's task. These tests hold its parts: the runner's verdict parsed into parts and reds, the report assembled
// from a run, one task per red area, the rotating sample of browser test files, and the leftovers counted without ever
// deleting one. A fake runner stands in for the gate, the audit, `bun outdated` and the flaky probe: no test here runs
// a real suite.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  auditInfo,
  baseBranch,
  browserTests,
  buildReport,
  coverageTrend,
  type Deps,
  failingTests,
  fitTitle,
  type GateResult,
  gateBrowsers,
  leftovers,
  limiter,
  lowPriorityArgs,
  main,
  mtimeOf,
  orderBySlowest,
  outdatedInfo,
  parseArgs,
  parseDur,
  parseOutdated,
  parseVerdict,
  parseWorktrees,
  pickSample,
  processAlive,
  REPEATS,
  type Run,
  type RunResult,
  realRun,
  redTasks,
  runGate,
  runProbe,
  TITLE_MAX,
  taskOf,
  type WeeklyRun,
} from '../scripts/weekly.ts'
import { tmp } from './tmp.ts'

const plain = (stdout: string, exitCode = 0): RunResult => ({ stdout, stderr: '', exitCode })
const read = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
const list = (dir: string): { name: string; dir: boolean; mtime: number }[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory(), mtime: statSync(join(dir, e.name)).mtimeMs }))
  } catch {
    return []
  }
}

/** a fixture checkout: one commit, herdr-tui as its base, a browser test file and a plain one */
function repoFixture() {
  const dir = tmp('weekly')
  const home = join(dir, 'home')
  const repo = join(dir, 'repo')
  const tmpdir = join(dir, 'tmp')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(repo, 'test'), { recursive: true })
  mkdirSync(tmpdir, { recursive: true })
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
  }
  git('init', '-q', '-b', 'herdr-tui')
  writeFileSync(join(repo, 'README.md'), 'fixture\n')
  writeFileSync(join(repo, 'index.ts'), 'export const x = 1\n')
  writeFileSync(join(repo, 'test', 'layout-a.test.ts'), "import { expect, test } from 'bun:test'\nimport { open } from './layout.ts'\n")
  writeFileSync(join(repo, 'test', 'plain.test.ts'), "import { expect, test } from 'bun:test'\n")
  git('add', '-A')
  git('-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-qm', 'init')
  git('update-ref', 'refs/remotes/origin/herdr-tui', 'HEAD')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/herdr-tui')
  const logs = join(home, '.cache', 'shepherdr', 'check-local', basename(repo))
  mkdirSync(logs, { recursive: true })
  return { dir, home, repo, tmpdir, common: join(repo, '.git'), logs, git }
}

const GREEN = `check:local · herdr-tui at 3cb7a424 · 8 test workers · nice 19, idle disk
1/5 dependencies ok (3s)
2/5 audit ok (1s) 0 new, 2 accepted advisories; licences: 80 checked, 3 not installed here
3/5 tests ok (1m02s) Ran 400 tests across 80 files
4/5 coverage ok (2s) 91.2% of the server's lines
5/5 build ok (1s) built in 621ms

PASSED in 1m08s · logs: /nowhere
`

// the runner stops at the first failed step, so a real red verdict names that one and nothing after it
const RED = `check:local · work/90 at deadbee · 8 test workers
1/5 dependencies ok (3s)
2/5 tests FAILED (1m)

FAILED in 1m03s: tests · logs: /nowhere
`

// a stopped step, as the runner prints one when its tool's timeout fires
const STOPPED = `check:local · work/90 at deadbee · 8 test workers
1/5 dependencies ok (3s)
2/5 tests STOPPED (5m10s): this check was stopped before it finished
`

const GAVE_UP = `check:local is running: no verdict yet
GAVE UP: another check (pid 12) still ran after 1h00m; nothing ran here.
`

type Answers = { verdict: string; gateCode?: number; browsers?: string; audit?: string; outdated?: string; probe?: Record<string, number> }

/** the processes a run makes, with the gate's verdict, the registry and the probe answered from the test */
function fakeRun(f: ReturnType<typeof repoFixture>, a: Answers): Run {
  return (args, o) => {
    const line = args.join(' ')
    if (line.includes('check-local.sh')) {
      writeFileSync(join(f.logs, 'verdict.txt'), a.verdict)
      if (a.browsers !== undefined) writeFileSync(join(f.logs, 'browsers.log'), a.browsers)
      else if (!existsSync(join(f.logs, 'browsers.log'))) writeFileSync(join(f.logs, 'browsers.log'), 'chromium: ok (fixture)\nwebkit: ok (fixture)\n')
      return plain(a.verdict, a.gateCode ?? 0)
    }
    if (args[0] === 'bun' && args[1] === 'audit') return plain(a.audit ?? '{}')
    if (args[0] === 'bun' && args[1] === 'outdated') return plain(a.outdated ?? '')
    const file = args[args.length - 1] ?? ''
    if (args.includes('test') && file.endsWith('.test.ts')) {
      const code = a.probe?.[file] ?? 0
      return { stdout: code ? '(fail) opens the board [3.00ms]\n' : '(pass) opens the board [3.00ms]\n', stderr: '', exitCode: code }
    }
    return realRun(args, o)
  }
}

/** every field of a run's world, for the parts called directly */
function world(f: ReturnType<typeof repoFixture>, run: Run, extra: Partial<Deps> = {}): Deps {
  let t = 1_700_000_000_000
  return {
    root: f.repo,
    home: f.home,
    tmpdir: f.tmpdir,
    clock: () => (t += 500),
    run,
    read,
    exists: existsSync,
    alive: (pid) => pid === process.pid,
    list,
    write: (file, text) => {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, text)
    },
    log: () => {},
    lowPriority: [],
    lock: join(f.home, '.cache', 'shepherdr', 'check-local.lock'),
    flock: true,
    ...extra,
  }
}

/** only what a run says, so a test reads its lines instead of a terminal */
function capture() {
  const lines: string[] = []
  return { lines, log: (l: string) => lines.push(l) }
}

describe('the gate verdict', () => {
  test('a passed run: its parts, their times and notes, the verdict line', () => {
    const v = parseVerdict(GREEN)
    expect(v.ran).toBe(true)
    expect(v.passed).toBe(true)
    expect(v.branch).toBe('herdr-tui')
    expect(v.commit).toBe('3cb7a424')
    expect(v.line).toBe('PASSED in 1m08s')
    expect(v.parts.map((p) => `${p.name} ${p.status} ${p.secs}`)).toEqual(['dependencies ok 3', 'audit ok 1', 'tests ok 62', 'coverage ok 2', 'build ok 1'])
    expect(v.parts[1]?.note).toBe('0 new, 2 accepted advisories; licences: 80 checked, 3 not installed here')
    expect(v.failed).toEqual([])
    expect(v.skipped).toEqual([])
    expect(v.notes).toEqual([])
    expect(v.detail).toEqual([])
  })

  test('a failed run names its failed part, a stopped one is a failure too', () => {
    const v = parseVerdict(RED)
    expect(v.passed).toBe(false)
    expect(v.failed).toEqual(['tests'])
    expect(parseVerdict(STOPPED).failed).toEqual(['tests'])
    // a part the runner skipped, and why, so the week can name what it did not check
    const skipped = parseVerdict(
      'check:local · herdr-tui at abc1234 · 2 test workers\n1/2 tests ok (1m)\n2/2 docs skipped: gitleaks is missing\n\nPASSED in 1m01s, with parts of it not run:\n  ! docs: gitleaks is missing\n  ! the tests: 3 skipped\n',
    )
    expect(skipped.skipped).toEqual(['docs'])
    expect(skipped.parts[1]?.note).toBe('gitleaks is missing')
    // the runner's own notes: what did not happen outside a step
    expect(skipped.notes).toEqual(['docs: gitleaks is missing', 'the tests: 3 skipped'])
    // the failing tests the runner named under its verdict, for the brief
    const failed = parseVerdict(
      'check:local · work/90 at abc1234 · 2 test workers\n1/2 tests FAILED (1m)\n\nFAILED in 1m03s: tests\n\nFailing tests:\n  test/x.test.ts > opens the board\n  test/y.test.ts > sends\n',
    )
    expect(failed.detail).toEqual(['test/x.test.ts > opens the board', 'test/y.test.ts > sends'])
  })

  test('a run that gave up has no parts and is not a run of the gate', () => {
    expect(parseVerdict(GAVE_UP).ran).toBe(false)
    expect(parseVerdict('').ran).toBe(false)
    expect(parseVerdict('12/14 tests TIMED OUT (1800s)').parts[0]).toMatchObject({ status: 'failed', secs: 1800 })
    expect(parseVerdict('13/14 build KILLED (5s): out of memory').parts[0]?.status).toBe('failed')
  })

  test('a passed verdict with a runner that failed is red', () => {
    const f = repoFixture()
    const gate = runGate(world(f, fakeRun(f, { verdict: GREEN, gateCode: 1 }), { read: () => GREEN }))
    expect(gate.passed).toBe(false)
    expect(gate.exitCode).toBe(1)
  })

  test('`12s` and `2m03s` as seconds', () => {
    expect(parseDur('12s')).toBe(12)
    expect(parseDur('2m03s')).toBe(123)
    expect(parseDur('')).toBe(0)
  })
})

describe('dependencies', () => {
  test('the outdated table, dev packages included, nothing changed', () => {
    const table = `bun outdated v1.4.4
|-------------------------|
| Package        | Current | Update | Latest |
|----------------|---------|--------|--------|
| ws             | 8.22.0  | 8.23.0 | 8.23.0 |
|----------------|---------|--------|--------|
| typescript (dev) | 5.9.3 | 5.9.3  | 7.0.2  |
|----------------|---------|--------|--------|
`
    const rows = parseOutdated(table)
    expect(rows).toEqual([
      { pkg: 'ws', current: '8.22.0', update: '8.23.0', latest: '8.23.0', dev: false },
      { pkg: 'typescript', current: '5.9.3', update: '5.9.3', latest: '7.0.2', dev: true },
    ])
    expect(parseOutdated('bun outdated v1.4.4\nNo dependencies to update')).toEqual([])
  })

  test('the audit weighs advisories against the accepted ids, and an unreachable registry is not red', () => {
    const f = repoFixture()
    const known = '{"left-pad":[{"id":7,"title":"old","url":"https://x/7"}]}'
    const fresh = '{"ws":[{"id":9,"title":"new","severity":"high","url":"https://x/9"}]}'
    const base = (audit: string) =>
      auditInfo(
        world(f, () => plain(audit)),
        f.common,
      )
    // no baseline yet: every advisory is new until the default branch accepts it
    expect(base(known)).toMatchObject({ known: 0, offline: false })
    expect(base(known).fresh[0]).toContain('left-pad · advisory 7')
    expect(base('not json at all')).toEqual({ fresh: [], known: 0, offline: true })
    // an accepted id stays accepted: the baseline lives in the repository's own .git
    mkdirSync(join(f.common, 'shepherdr-audit'), { recursive: true })
    writeFileSync(join(f.common, 'shepherdr-audit', 'accepted.json'), JSON.stringify({ commit: 'abc', at: 1, ids: ['7'] }))
    expect(base(known)).toEqual({ fresh: [], known: 1, offline: false })
    expect(base(fresh).fresh[0]).toContain('ws · advisory 9')
  })
})

describe('the flaky probe', () => {
  test('the sample walks the list, so the same five files do not repeat for ever', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    // the turn's slowest first; a file this turn already had never comes back in it
    expect(pickSample(files, [], 5)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(pickSample(files, ['a', 'b'], 5)).toEqual(['c', 'd', 'e', 'f', 'g'])
    // the turn is done: a new one starts at the slowest, the rest of the old one after
    expect(pickSample(files, ['a', 'b', 'c', 'd', 'e', 'f'], 5)).toEqual(['g', 'a', 'b', 'c', 'd'])
    expect(pickSample(files, ['gone'], 2)).toEqual(['a', 'b'])
    expect(pickSample(files, [], 99)).toEqual(files)
    expect(pickSample([], [], 5)).toEqual([])
    expect(pickSample(files, [], 0)).toEqual([])
  })

  test('the slowest come first, the unknown ones after them by name', () => {
    const files = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts']
    expect(orderBySlowest(files, { 'test/b.test.ts': 900, 'test/a.test.ts': 5000 })).toEqual(['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'])
    expect(orderBySlowest(files, { 'a.test.ts': 900 })).toEqual(['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'])
    expect(orderBySlowest(files, null)).toEqual(files)
  })

  test("the browsers are read from the gate's own probe log", () => {
    const f = repoFixture()
    writeFileSync(join(f.logs, 'browsers.log'), 'chromium: ok (1s)\nwebkit: not installed: bun x playwright-core install webkit\nnoise\n')
    expect(
      gateBrowsers(
        world(f, () => plain('')),
        f.logs,
        0,
      ),
    ).toEqual([
      { engine: 'chromium', line: 'ok (1s)' },
      { engine: 'webkit', line: 'not installed: bun x playwright-core install webkit' },
    ])
    expect(
      gateBrowsers(
        world(f, () => plain('')),
        join(f.dir, 'nowhere'),
        0,
      ),
    ).toEqual([])
    // a log an earlier run left is not this run's browsers
    expect(
      gateBrowsers(
        world(f, () => plain('')),
        f.logs,
        Date.now() + 60_000,
      ),
    ).toEqual([])
  })

  test('only the files that open a browser are probed', () => {
    const f = repoFixture()
    const d = world(f, () => plain(''), {
      list: (dir) =>
        dir.endsWith('/test')
          ? [
              { name: 'layout-a.test.ts', dir: false, mtime: 0 },
              { name: 'plain.test.ts', dir: false, mtime: 0 },
            ]
          : [],
    })
    expect(browserTests(d)).toEqual(['test/layout-a.test.ts'])
    expect(browserTests(world(f, () => plain(''), { list: () => [] }))).toEqual([])
  })

  test('a file that fails once in the repeats is the one the report names', () => {
    const f = repoFixture()
    const asked: string[][] = []
    const probeRun: Run = (args, o) => {
      asked.push(args)
      return fakeRun(f, { verdict: GREEN, probe: { './test/layout-a.test.ts': 1 } })(args, o)
    }
    const probe = runProbe(world(f, probeRun), ['test/layout-a.test.ts', 'test/layout-b.test.ts']).files
    expect(probe[0]).toMatchObject({ file: 'test/layout-a.test.ts', ok: false, repeats: REPEATS })
    expect(probe[0]?.detail).toEqual(['opens the board'])
    expect(probe[1]?.ok).toBe(true)
    // --parallel keeps test/preload.ts from sending this through scripts/test.ts, which rewrites the timings that
    // order the next week's sample
    expect(asked[0]).toContain('--parallel=1')
    expect(asked[0]).toContain(`--rerun-each=${REPEATS}`)
    // a failure with no (fail) line still says what it was
    const timedOut = runProbe(
      world(f, () => ({ stdout: '', stderr: '', exitCode: 124 })),
      ['test/layout-a.test.ts'],
    )
    expect(timedOut.files[0]?.detail).toEqual(['exit 124'])
    expect(timedOut.skipped).toBe('')
    expect(failingTests('ok\n(fail) one [1.00ms]\n(fail) two [2.00ms]')).toEqual(['one', 'two'])
    // the lock's wait ran out with nothing printed: not a failure, and no second quarter of an hour for the next file
    const busy = runProbe(
      world(f, () => ({ stdout: '', stderr: '', exitCode: 1 }), { flock: true }),
      ['test/layout-a.test.ts', 'test/layout-b.test.ts'],
    )
    expect(busy).toEqual({ files: [], skipped: 'another check kept the machine for the whole wait' })
    // without flock that same silent exit is just a failed run
    const silent = runProbe(
      world(f, () => ({ stdout: '', stderr: '', exitCode: 1 }), { flock: false }),
      ['test/layout-a.test.ts'],
    ).files
    expect(silent[0]?.detail).toEqual(['exit 1'])
  })
})

describe('the coverage trend and the leftovers', () => {
  test('the baseline age, the worst files and the exempt markers', () => {
    const f = repoFixture()
    mkdirSync(join(f.repo, 'scripts'), { recursive: true })
    writeFileSync(join(f.repo, 'scripts', 'probe.ts'), 'const a = 1\n// coverage-exempt: needs a real host\n')
    f.git('add', '-A')
    f.git('-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-qm', 'exempt')
    mkdirSync(join(f.common, 'shepherdr-test'), { recursive: true })
    writeFileSync(join(f.common, 'shepherdr-test', 'coverage.json'), JSON.stringify({ commit: 'abc1234', at: 1_000_000, files: {} }))
    const logs = join(f.dir, 'logs')
    const trend = coverageTrend(world(f, realRun, { clock: () => 1_000_000 + 3 * 86_400_000 }), f.common, logs)
    expect(trend).toMatchObject({ commit: 'abc1234', ageDays: 3, summary: '', top: [], exempt: 1 })
    mkdirSync(join(logs, 'coverage'), { recursive: true })
    writeFileSync(join(logs, 'coverage', 'report.txt'), "Coverage: 91.2% of the server's lines (100 of 110)\n\nindex.ts 90.0% missed 2: 4, 9\napp.ts 95.0% missed 1: 7\n")
    const measured = coverageTrend(world(f, realRun), f.common, logs)
    expect(measured.summary).toBe("Coverage: 91.2% of the server's lines (100 of 110)")
    expect(measured.top).toEqual(['index.ts 90.0% missed 2: 4, 9', 'app.ts 95.0% missed 1: 7'])
    // a gate that did not reach its coverage step leaves an earlier run's report behind: never read it as this week's
    expect(coverageTrend(world(f, realRun), f.common, logs, false)).toMatchObject({ summary: '', top: [] })
    // nothing recorded yet: no baseline, no report
    const empty = coverageTrend(
      world(f, () => plain('')),
      join(f.dir, 'none'),
      join(f.dir, 'none'),
    )
    expect(empty).toMatchObject({ commit: '', at: null, ageDays: null, summary: '', top: [], exempt: 0 })
  })

  test('dead worktrees of done tasks, /tmp homes, old gate logs and uncommitted files are counted, never removed', () => {
    const f = repoFixture()
    const gone = join(f.tmpdir, 'gone')
    mkdirSync(join(f.tmpdir, 'follow-up'))
    mkdirSync(join(f.tmpdir, 'old-proof'))
    mkdirSync(join(f.tmpdir, 'running-proof-home'), { recursive: true })
    writeFileSync(join(f.tmpdir, 'running-proof-home', 'server.json'), JSON.stringify({ pid: process.pid }))
    mkdirSync(join(f.tmpdir, 'bad-proof'), { recursive: true })
    writeFileSync(join(f.tmpdir, 'bad-proof', 'server.json'), 'not json')
    const now = Date.now()
    const cache = join(f.home, '.cache', 'shepherdr', 'check-local')
    mkdirSync(join(cache, 'merged-task'), { recursive: true })
    mkdirSync(join(cache, 'verdicts'), { recursive: true })
    const porcelain = `worktree ${f.repo}\nHEAD abc\nbranch refs/heads/work/90\n\nworktree ${gone}\nHEAD def\nbranch refs/heads/work/1\n\nworktree ${join(f.tmpdir, 'follow-up')}\nHEAD 1\nbranch refs/heads/work/77\n\nworktree ${f.tmpdir}\nHEAD 0\nbranch refs/heads/herdr-tui\n`
    const run: Run = (args, o) => {
      const line = args.join(' ')
      if (line.includes('worktree list')) return plain(porcelain)
      if (line.includes('branch --merged')) return plain('* herdr-tui\n+ work/90\n')
      if (line.includes('log --format=%s herdr-tui')) return plain('SHE-90: Run the complete gate weekly\nSHE-77: Something else\n')
      if (line.includes('log -1 --format=%s%x00%ct work/1') && line.includes('work/1')) return plain(`SHE-77: Squashed under another id\u0000${Math.round((now - 30 * 86_400_000) / 1000)}\n`)
      if (line.includes('log -1 --format=%s%x00%ct work/90') && line.includes('work/90')) return plain(`SHE-90: Run the complete gate weekly\u0000${Math.round(now / 1000)}\n`)
      // the same task id the base already carries, but a branch still at work: not a leftover
      if (line.includes('log -1 --format=%s%x00%ct work/77')) return plain(`SHE-77: A follow-up still at work\u0000${Math.round(now / 1000)}\n`)
      if (line.includes('status --porcelain')) return o?.cwd === f.repo ? plain(' M scripts/weekly.ts\n') : plain('')
      return plain('')
    }
    const d = world(f, run, {
      clock: () => now,
      list: (dir) => {
        if (dir === f.tmpdir)
          return [
            { name: 'old-proof', dir: true, mtime: now - 3 * 3600_000 },
            { name: 'bad-proof', dir: true, mtime: now - 3 * 3600_000 },
            { name: 'running-proof-home', dir: true, mtime: now - 3 * 3600_000 },
            { name: 'young-proof', dir: true, mtime: now },
          ]
        if (dir === cache)
          return [
            { name: 'merged-task', dir: true, mtime: now - 8 * 86_400_000 },
            { name: 'verdicts', dir: true, mtime: now - 900 * 86_400_000 },
            { name: 'fresh', dir: true, mtime: now },
          ]
        return []
      },
    })
    const left = leftovers(d, 'herdr-tui', 'work/90')
    expect(left.worktrees).toBe(4)
    expect(left.dead).toEqual([gone])
    // work/1 descended from the base, work/77 landed as a squash under a task id its own branch names
    expect(left.done).toEqual(['work/1'])
    expect(left.uncommitted).toEqual(['repo: M scripts/weekly.ts'])
    // the running proof server's home is not a leftover; the young one is not finished; the old one is
    expect(left.tmpHomes).toEqual(['bad-proof', 'old-proof'])
    expect(processAlive(process.pid)).toBe(true)
    expect(processAlive(4194305)).toBe(false)
    expect(left.logFolders).toEqual(['merged-task'])
    expect(parseWorktrees(porcelain)).toHaveLength(4)
  })
})

/** a run of every part, as the report sees it */
function baseRun(o: Partial<WeeklyRun> = {}): WeeklyRun {
  const gate: GateResult = {
    ran: true,
    passed: true,
    parts: [
      { name: 'dependencies', status: 'ok', secs: 3, note: '' },
      { name: 'tests', status: 'ok', secs: 62, note: 'Ran 400 tests across 80 files' },
      { name: 'build', status: 'ok', secs: 1, note: 'built in 621ms' },
    ],
    failed: [],
    skipped: [],
    notes: [],
    detail: [],
    line: 'PASSED in 1m08s',
    branch: 'herdr-tui',
    commit: '3cb7a424',
    logs: '/logs',
    exitCode: 0,
  }
  return {
    at: Date.UTC(2026, 10, 22, 8, 30),
    root: '/repo',
    branch: 'herdr-tui',
    commit: '3cb7a424',
    base: 'herdr-tui',
    tip: 'abc1234deadbeef',
    behind: 0,
    report: '/repo/.git/shepherdr-weekly/report.md',
    browsers: [{ engine: 'chromium', line: 'ok (1s)' }],
    gate,
    audit: { fresh: [], known: 2, offline: false },
    outdated: { rows: [], offline: false },
    probe: { files: [], skipped: '' },
    coverage: { commit: 'abc1234', at: 0, ageDays: 3, summary: 'Coverage: 91.2%', top: [], exempt: 4 },
    leftovers: { worktrees: 1, dead: [], done: [], tmpHomes: [], logFolders: [], uncommitted: [] },
    took: 500,
    ...o,
  }
}

describe('the report and its tasks', () => {
  test('the report carries every part, the audit, the probe, the coverage trend and the leftovers', () => {
    const run = baseRun({
      outdated: { rows: [{ pkg: 'ws', current: '8.22.0', update: '8.23.0', latest: '8.23.0', dev: false }], offline: false },
      probe: { files: [{ file: 'test/layout-a.test.ts', ok: true, repeats: REPEATS, detail: [], skipped: false }], skipped: '' },
      coverage: { commit: 'abc1234', at: 0, ageDays: 3, summary: 'Coverage: 91.2%', top: ['index.ts 90.0% missed 2: 4, 9'], exempt: 4 },
      leftovers: { worktrees: 3, dead: ['/tmp/gone'], done: ['work/1'], tmpHomes: ['shep-proof'], logFolders: ['merged-task'], uncommitted: [' M x.ts'] },
    })
    const report = buildReport(run)
    expect(report).toContain('# Weekly full check · 2026-11-22T08:30:00.000Z')
    expect(report).toContain('Took 8m20s.')
    expect(report).toContain('## Gate\nPASSED in 1m08s')
    expect(report).toContain('- tests ok (1m02s): Ran 400 tests across 80 files')
    expect(report).toContain('- build ok (1s): built in 621ms')
    expect(report).toContain('base `herdr-tui` at `abc1234`: this run is its tip')
    expect(report).toContain('- chromium: ok (1s)')
    expect(report).toContain('- audit: 0 new, 2 accepted advisories')
    expect(report).toContain('ws 8.22.0 → 8.23.0')
    expect(report).toContain('Repeated 5 times each')
    expect(report).toContain('- test/layout-a.test.ts ok')
    expect(report).toContain('baseline from `abc1234`, 3 days old')
    expect(report).toContain('index.ts 90.0% missed 2: 4, 9')
    expect(report).toContain('`coverage-exempt:` markers in the tree: 4')
    expect(report).toContain('worktrees: 3, 1 dead, 1 of done tasks')
    expect(report).toContain('dead: /tmp/gone')
    expect(report).toContain('done: work/1')
    expect(report).toContain('/tmp proof scratch of finished tasks (older than 2 h): 1')
    expect(report).toContain('gate log folders older than 7 days: 1')
    expect(report).toContain('uncommitted files in this checkout: 1')
    expect(report).toContain('## Red\nNone: the gate passed and nothing else is red.')
  })

  test('a run that gave up, a registry it could not read and no baseline are said plainly', () => {
    const run = baseRun({
      browsers: [],
      audit: { fresh: [], known: 0, offline: true },
      outdated: { rows: [], offline: true },
      probe: { files: [], skipped: 'asked not to run (--no-probe)' },
      coverage: { commit: '', at: null, ageDays: null, summary: '', top: [], exempt: 0 },
      gate: { ...baseRun().gate, ran: false, passed: false, parts: [], line: '', exitCode: 2 },
      tip: '',
      behind: null,
      leftovers: { worktrees: 0, dead: [], done: [], tmpHomes: [], logFolders: [], uncommitted: [] },
    })
    const report = buildReport(run)
    expect(report).toContain('- nothing ran')
    expect(report).toContain('Exit code 2. Logs: `/logs`.')
    expect(report).toContain('- the probe said nothing')
    expect(report).toContain('- audit: the registry could not be read, advisories not checked')
    expect(report).toContain('- outdated: the registry could not be read, nothing weighed')
    expect(report).toContain('- base `herdr-tui`: its tip could not be read')
    expect(report).toContain('Not run: asked not to run (--no-probe).')
    expect(report).toContain('- no baseline recorded on the default branch yet')
    expect(report).toContain('no coverage measured (the gate did not reach its coverage step)')
  })

  test('one task per red area: the gate, a new advisory and a flaky file, each with its own name', () => {
    const run = baseRun({
      gate: { ...baseRun().gate, ran: false, passed: false, parts: [], line: '', exitCode: 2 },
      audit: { fresh: ['ws · advisory 9'], known: 0, offline: false },
      probe: { files: [{ file: 'test/layout-settings-lazy.test.ts', ok: false, repeats: REPEATS, detail: ['opens the board'], skipped: false }], skipped: '' },
    })
    const reds = redTasks(run)
    expect(reds.map((r) => r.area)).toEqual(['gate', 'audit', 'flaky test/layout-settings-lazy.test.ts'])
    expect(reds[0]?.title).toBe('Weekly: the gate did not run')
    expect(reds.every((r) => r.title.length <= TITLE_MAX)).toBe(true)
    expect(reds[1]?.brief).toContain('new advisories: ws · advisory 9')
    expect(reds[2]?.title).toBe('Weekly: flaky …out-settings-lazy')
    expect(reds[2]?.title).toHaveLength(TITLE_MAX)
    expect(reds[2]?.brief).toContain('failing at least once in 5 repeats (opens the board)')
    expect(reds[2]?.brief).toContain('Run bun run check:local in a worktree of herdr-tui')

    // the gate's own audit step names the same advisory: one task, not two, and its brief carries the advisories
    const both = redTasks(baseRun({ gate: { ...baseRun().gate, passed: false, failed: ['audit'] }, audit: { fresh: ['ws · advisory 9'], known: 0, offline: false } }))
    expect(both.map((r) => r.area)).toEqual(['audit'])
    expect(both[0]?.title).toBe('Weekly: audit red')
    expect(both[0]?.brief).toContain('New advisories: ws · advisory 9.')
    expect(fitTitle('x'.repeat(40))).toHaveLength(TITLE_MAX)
  })
})

describe('a red week that is not a failed step', () => {
  test('a gate that ran without a pass it can name a step for is red as a whole', () => {
    const stopped = redTasks(baseRun({ gate: { ...baseRun().gate, passed: false, failed: [], line: 'FAILED in 1m03s', exitCode: 1 } }))
    expect(stopped.map((r) => r.area)).toEqual(['gate'])
    expect(stopped[0]?.title).toBe('Weekly: the gate did not pass')
    expect(stopped[0]?.brief).toContain('FAILED in 1m03s, exit 1')
    // a failed step keeps its own task, not a second one for the gate around it
    const named = redTasks(baseRun({ gate: { ...baseRun().gate, passed: false, failed: ['tests'], line: 'FAILED in 1m03s', exitCode: 1 } }))
    expect(named.map((r) => r.area)).toEqual(['tests'])
    const withDetail = redTasks(baseRun({ gate: { ...baseRun().gate, passed: false, failed: ['tests'], detail: ['test/x.test.ts > opens the board'] } }))
    expect(withDetail[0]?.brief).toContain('The gate named: test/x.test.ts > opens the board.')
  })

  test('no browser line, and a note no step covers, are red too', () => {
    const blind = baseRun({ browsers: [] })
    const red = redTasks(blind)
    expect(red.map((r) => r.area)).toContain('browsers')
    expect(red.find((r) => r.area === 'browsers')?.title).toBe('Weekly: browsers not checked')
    const noted = redTasks(
      baseRun({
        gate: { ...baseRun().gate, notes: ['webkit: not installed · the iPhone tests skip', 'the tests: 3 skipped (a browser that died)'] },
      }),
    )
    // the browser note is the browsers section's business; the tests' own note is news
    expect(noted.map((r) => r.area)).toEqual(['notes'])
    expect(noted[0]?.brief).toContain('the tests: 3 skipped (a browser that died)')
    expect(noted[0]?.title).toBe('Weekly: the run skipped parts')
  })

  test('a step the runner skipped was not checked this week: it is red with its reason', () => {
    const run = baseRun({
      gate: {
        ...baseRun().gate,
        parts: [
          { name: 'tests', status: 'ok', secs: 60, note: '' },
          { name: 'docs', status: 'skipped', secs: 0, note: 'gitleaks is missing: install it' },
        ],
        skipped: ['docs'],
      },
    })
    const reds = redTasks(run)
    expect(reds.map((r) => r.area)).toEqual(['docs not run'])
    expect(reds[0]?.title).toBe('Weekly: docs did not run')
    expect(reds[0]?.brief).toContain('did not run this week (gitleaks is missing: install it)')
  })

  test('an unreachable registry is said, never taken for "nothing to move"', () => {
    const f = repoFixture()
    expect(outdatedInfo(world(f, () => ({ stdout: '', stderr: 'registry down', exitCode: 1 })))).toEqual({ rows: [], offline: true })
    expect(outdatedInfo(world(f, () => plain('| Package | Current | Update | Latest |\n')))).toEqual({ rows: [], offline: false })
    expect(taskOf('SHE-90: Run the complete gate weekly')).toBe('SHE-90')
    expect(taskOf('Format codebase with Biome')).toBe('')
  })

  test('the base says how far the run is from it', () => {
    expect(buildReport(baseRun({ behind: 3, tip: 'abcdef1234567' }))).toContain('base `herdr-tui` at `abcdef1`: 3 commits this run does not have')
    expect(buildReport(baseRun({ behind: 1, tip: 'abcdef1234567' }))).toContain('1 commit this run does not have')
  })
})

describe('the run itself', () => {
  test('a green week prints one line and writes the report into the .git, never the tree', () => {
    const f = repoFixture()
    const out = capture()
    const fakes = depsOf(f, out)
    fakes.run = fakeRun(f, {
      verdict: GREEN,
      browsers: 'chromium: ok (1s)\nwebkit: ok (2s)\n',
      outdated: '| Package | Current | Update | Latest |\n| ws | 8.22.0 | 8.23.0 | 8.23.0 |\n',
    })
    expect(main([], fakes)).toBe(0)
    // one line, and nothing else: a green week says what it found, once
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0]?.startsWith('weekly: green · PASSED in 1m08s')).toBe(true)
    expect(out.lines[0]).toContain('1 file ok')
    const report = join(f.common, 'shepherdr-weekly', 'report.md')
    expect(existsSync(report)).toBe(true)
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('## Browsers\n- chromium: ok (1s)')
    expect(text).toContain('ws 8.22.0 → 8.23.0')
    expect(text).toContain('test/layout-a.test.ts ok')
    expect(text).toContain('## Red\nNone')
    expect(existsSync(join(f.repo, 'report.md'))).toBe(false)
    // the next week's sample starts after this one's first pick (the rotation)
    const state = JSON.parse(readFileSync(join(f.common, 'shepherdr-weekly', 'state.json'), 'utf8')) as { sample: string[] }
    expect(state.sample).toEqual(['test/layout-a.test.ts'])
  })

  test("the next week starts after this week's last pick, through the state the first run left", () => {
    const f = repoFixture()
    const out = capture()
    const fakes = depsOf(f, out)
    fakes.run = fakeRun(f, { verdict: GREEN })
    expect(main([], fakes)).toBe(0)
    expect((JSON.parse(readFileSync(join(f.common, 'shepherdr-weekly', 'state.json'), 'utf8')) as { sample: string[] }).sample).toEqual(['test/layout-a.test.ts'])
    // a second browser test file joins the list: the next week probes it, not the one just probed
    writeFileSync(join(f.repo, 'test', 'layout-b.test.ts'), "import { open } from './layout.ts'\n")
    expect(main([], fakes)).toBe(0)
    expect(readFileSync(join(f.common, 'shepherdr-weekly', 'report.md'), 'utf8')).toContain('- test/layout-b.test.ts ok')
  })

  test('a checkout with no browser test file says so and leaves no sample', () => {
    const f = repoFixture()
    rmSync(join(f.repo, 'test', 'layout-a.test.ts'))
    const out = capture()
    const fakes = depsOf(f, out)
    fakes.run = fakeRun(f, { verdict: GREEN })
    expect(main([], fakes)).toBe(0)
    expect(readFileSync(join(f.common, 'shepherdr-weekly', 'report.md'), 'utf8')).toContain('Not run: no browser test file found.')
    expect(existsSync(join(f.common, 'shepherdr-weekly', 'state.json'))).toBe(false)
  })

  test('a state file that is not one of ours is no sample, and broken timings are no timings', () => {
    const f = repoFixture()
    const out = capture()
    mkdirSync(join(f.common, 'shepherdr-weekly'), { recursive: true })
    writeFileSync(join(f.common, 'shepherdr-weekly', 'state.json'), '{"sample":"broken"}')
    mkdirSync(join(f.repo, 'node_modules', '.cache', 'shepherdr-test'), { recursive: true })
    writeFileSync(join(f.repo, 'node_modules', '.cache', 'shepherdr-test', 'timings.json'), '{ not json')
    const fakes = depsOf(f, out)
    fakes.run = fakeRun(f, { verdict: GREEN })
    expect(main([], fakes)).toBe(0)
    expect(readFileSync(join(f.common, 'shepherdr-weekly', 'report.md'), 'utf8')).toContain('test/layout-a.test.ts ok')
  })

  test('a red week names its areas and the task each one files', () => {
    const f = repoFixture()
    const out = capture()
    const fakes = depsOf(f, out)
    fakes.run = fakeRun(f, { verdict: RED, gateCode: 1, browsers: 'chromium: ok (1s)\n' })
    expect(main([], fakes)).toBe(1)
    expect(out.lines).toContain('weekly: red · tests · file one task: Weekly: tests red')
    expect(out.lines.at(-1)).toContain('weekly: 1 red area · report:')
    const report = readFileSync(join(f.common, 'shepherdr-weekly', 'report.md'), 'utf8')
    expect(report).toContain('## Red: 1 area, one task each')
    expect(report).toContain('### Weekly: tests red')
    // the probe does not add load to a machine whose gate did not pass
    expect(report).toContain('Not run: the gate did not pass')
    expect(report).toContain('uncommitted files in this checkout: 0')
  })

  test('a run of the gate that gave up is red, and a trial run can skip the probe', () => {
    const f = repoFixture()
    const out = capture()
    const fakes = depsOf(f, out)
    // a /tmp nothing has made yet: a folder that is not there is no leftover, never an error
    fakes.tmpdir = join(f.dir, 'nope')
    fakes.run = fakeRun(f, { verdict: GAVE_UP, gateCode: 2 })
    expect(main(['--no-probe', '--sample', '0'], fakes)).toBe(1)
    expect(out.lines[0]?.startsWith('weekly: red · gate · file one task: Weekly: the gate did not run')).toBe(true)
    expect(readFileSync(join(f.common, 'shepherdr-weekly', 'report.md'), 'utf8')).toContain('Not run: asked not to run (--no-probe)')
    expect(parseArgs(['--sample', '2', '--no-probe'])).toEqual({ probe: false, sample: 2 })
    expect(parseArgs(['--sample', 'nope'])).toEqual({ probe: true, sample: 5 })
    expect(parseArgs(['--sample', '99'])).toEqual({ probe: true, sample: 5 })
    expect(parseArgs([])).toEqual({ probe: true, sample: 5 })
  })

  test('a week without a probe keeps the last sample, and a report that cannot be written is not a green week', () => {
    const f = repoFixture()
    mkdirSync(join(f.common, 'shepherdr-weekly'), { recursive: true })
    const state = join(f.common, 'shepherdr-weekly', 'state.json')
    writeFileSync(state, JSON.stringify({ at: 1, commit: 'abc', sample: ['test/layout-a.test.ts'] }))
    const out = capture()
    const fakes = depsOf(f, out)
    fakes.run = fakeRun(f, { verdict: GREEN })
    // nothing can be written at all: no run starts
    fakes.write = (file: string) => {
      throw new Error(`no write to ${basename(file)}`)
    }
    expect(main(['--no-probe'], fakes)).toBe(2)
    expect(out.lines.at(-1)).toContain('the report could not be written (no write to report.md): nothing was started')
    // the first write is the running marker the run leaves while it works; the second is the report
    const written: { file: string; text: string }[] = []
    fakes.write = (file: string, text: string) => {
      written.push({ file, text })
      if (written.length > 1) throw new Error(`no write to ${basename(file)}`)
    }
    expect(main(['--no-probe'], fakes)).toBe(2)
    expect(written[0]?.text).toContain('# Weekly full check · running')
    expect(written[0]?.text).toContain('replaced when the run ends')
    expect(out.lines.at(-1)).toContain('the report could not be written (no write to report.md): nothing was recorded')
    // the failed write left the sample alone
    expect(JSON.parse(readFileSync(state, 'utf8')).sample).toEqual(['test/layout-a.test.ts'])
  })

  test('outside a checkout it says so and runs nothing', () => {
    const dir = tmp('weekly-nogit')
    const out = capture()
    expect(main([], { root: dir, home: dir, tmpdir: dir, run: realRun, log: out.log })).toBe(2)
    expect(out.lines[0]).toContain('is not a git checkout')
    const repo = repoFixture()
    expect(baseBranch(world(repo, realRun))).toBe('herdr-tui')
    // no origin/HEAD: origin/herdr-tui still names the base the space merges into, and never this branch
    repo.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
    expect(baseBranch(world(repo, realRun))).toBe('herdr-tui')
    const bare = tmp('weekly-nobase')
    Bun.spawnSync(['git', 'init', '-q', '-b', 'work/90', bare])
    expect(baseBranch(world({ ...repo, repo: bare }, realRun))).toBe('main')
    // a command this host does not have is one failed process, never a crash
    expect(realRun(['/nonexistent-shepherdr-weekly-command']).exitCode).not.toBe(0)
    expect(lowPriorityArgs(() => false)).toEqual([])
    // an entry that went while /tmp was listed is no age, never an error that loses the whole listing
    expect(mtimeOf('/nonexistent-shepherdr-weekly-entry')).toBe(0)
    expect(lowPriorityArgs(() => true)).toEqual(['nice', '-n', '19', 'ionice', '-c', '3'])
    const scope = ['systemd-run', '--user', '--scope', '--quiet', '--collect', '-p', 'CPUWeight=1', '-p', 'IOWeight=1']
    if (process.platform === 'linux') {
      expect(
        limiter(
          () => true,
          () => true,
        ),
      ).toEqual([...scope, 'nice', '-n', '19', 'ionice', '-c', '3'])
      expect(
        limiter(
          () => false,
          () => true,
        ),
      ).toEqual([])
    } else expect(limiter(() => true)).toEqual(['nice', '-n', '19', 'ionice', '-c', '3'])
  })

  test('a browser that cannot start is named before the gate, not skipped inside it', () => {
    const f = repoFixture()
    const out = capture()
    const fakes = depsOf(f, out)
    fakes.run = fakeRun(f, { verdict: GREEN, browsers: 'chromium: not installed: bun x playwright-core install --only-shell chromium\nwebkit: ok (2s)\n' })
    // a browser that cannot start means its tests skip inside the gate: the week is red and names it
    expect(main(['--no-probe'], fakes)).toBe(1)
    expect(out.lines[0]).toContain('weekly: red · browser chromium · file one task: Weekly: chromium did not start')
    const report = readFileSync(join(f.common, 'shepherdr-weekly', 'report.md'), 'utf8')
    expect(report).toContain('- chromium: not installed: bun x playwright-core install --only-shell chromium')
    expect(report).toContain('- webkit: ok (2s)')
    expect(report).toContain('### Weekly: chromium did not start')
  })
})

/** only what a run says, plus the fixture's world: main fills the rest with its own defaults */
function depsOf(f: ReturnType<typeof repoFixture>, out: { log: (l: string) => void }): Partial<Deps> {
  let t = 1_700_000_000_000
  return { root: f.repo, home: f.home, tmpdir: f.tmpdir, clock: () => (t += 500), log: out.log, lowPriority: [] }
}
