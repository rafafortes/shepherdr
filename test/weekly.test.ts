// The weekly full check (SHE-90, audit 2026-11-18 QG-11): one run of the whole gate on the default branch, an
// automation's task. These tests hold its parts: the runner's verdict parsed into parts and reds, the report assembled
// from a run, one task per red area, the rotating sample of browser test files, and the leftovers counted without ever
// deleting one. A fake runner stands in for the gate, the audit, `bun outdated` and the flaky probe: no test here runs
// a real suite.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
  leftovers,
  lowPriorityArgs,
  main,
  mtimeOf,
  orderBySlowest,
  parseArgs,
  parseDur,
  parseOutdated,
  parseVerdict,
  parseWorktrees,
  pickSample,
  REPEATS,
  type Run,
  type RunResult,
  realRun,
  redTasks,
  runGate,
  runProbe,
  TITLE_MAX,
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
5/5 docs skipped: gitleaks is missing

PASSED in 1m08s · logs: /nowhere
`

const RED = `check:local · work/90 at deadbee · 8 test workers
1/5 dependencies ok (3s)
2/5 audit ok (1s) 1 new, 0 accepted advisories
3/5 tests FAILED (1m)
4/5 types FAILED (2s)
5/5 build skipped: the run stopped at types

FAILED in 1m03s: tests types · logs: /nowhere
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
      return plain(a.verdict, a.gateCode ?? 0)
    }
    if (line.includes('check-browsers.ts')) return plain(a.browsers ?? '')
    if (args[0] === 'bun' && args[1] === 'audit') return plain(a.audit ?? '{}')
    if (args[0] === 'bun' && args[1] === 'outdated') return plain(a.outdated ?? '')
    const file = args[args.length - 1] ?? ''
    if (args.includes('test') && file.endsWith('.test.ts')) {
      const code = a.probe?.[file] ?? 0
      return { stdout: code ? '(fail) opens the board [3.00ms]\n' : 'ok\n', stderr: '', exitCode: code }
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
    list,
    write: (file, text) => {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, text)
    },
    log: () => {},
    lowPriority: [],
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
    expect(v.secs).toBe(68)
    expect(v.line).toBe('PASSED in 1m08s')
    expect(v.parts.map((p) => `${p.name} ${p.status} ${p.secs}`)).toEqual(['dependencies ok 3', 'audit ok 1', 'tests ok 62', 'coverage ok 2', 'docs skipped 0'])
    expect(v.parts[1]?.note).toBe('0 new, 2 accepted advisories; licences: 80 checked, 3 not installed here')
    expect(v.parts[4]?.note).toBe('gitleaks is missing')
    expect(v.failed).toEqual([])
  })

  test('a failed run names its failed parts, a skipped one is not one of them', () => {
    const v = parseVerdict(RED)
    expect(v.passed).toBe(false)
    expect(v.failed).toEqual(['tests', 'types'])
    expect(v.parts.find((p) => p.name === 'build')?.status).toBe('skipped')
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
    expect(pickSample(files, [], 5)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(pickSample(files, ['a'], 5)).toEqual(['b', 'c', 'd', 'e', 'f'])
    expect(pickSample(files, ['f'], 5)).toEqual(['g', 'a', 'b', 'c', 'd'])
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
    const d = world(f, fakeRun(f, { verdict: GREEN, probe: { './test/layout-a.test.ts': 1 } }))
    const probe = runProbe(d, ['test/layout-a.test.ts', 'test/layout-b.test.ts'])
    expect(probe[0]).toMatchObject({ file: 'test/layout-a.test.ts', ok: false, repeats: REPEATS })
    expect(probe[0]?.detail).toEqual(['opens the board'])
    expect(probe[1]?.ok).toBe(true)
    expect(failingTests('ok\n(fail) one [1.00ms]\n(fail) two [2.00ms]')).toEqual(['one', 'two'])
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
    mkdirSync(join(f.tmpdir, 'shep-proof-home'))
    const now = Date.now()
    const cache = join(f.home, '.cache', 'shepherdr', 'check-local')
    mkdirSync(join(cache, 'merged-task'), { recursive: true })
    mkdirSync(join(cache, 'verdicts'), { recursive: true })
    const porcelain = `worktree ${f.repo}\nHEAD abc\nbranch refs/heads/work/90\n\nworktree ${gone}\nHEAD def\nbranch refs/heads/work/1\n\nworktree ${f.tmpdir}\nHEAD 0\nbranch refs/heads/herdr-tui\n`
    const run: Run = (args) => {
      const line = args.join(' ')
      if (line.includes('worktree list')) return plain(porcelain)
      if (line.includes('branch --merged')) return plain('* herdr-tui\n+ work/1\n+ work/90\n')
      if (line.includes('status --porcelain')) return plain(' M scripts/weekly.ts\n')
      return plain('')
    }
    const d = world(f, run, {
      clock: () => now,
      list: (dir) => {
        if (dir === f.tmpdir)
          return [
            { name: 'shep-proof-home', dir: true, mtime: now - 3 * 3600_000 },
            { name: 'young', dir: true, mtime: now },
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
    expect(left.worktrees).toBe(3)
    expect(left.dead).toEqual([gone])
    expect(left.merged).toEqual(['work/1'])
    expect(left.uncommitted).toEqual(['M scripts/weekly.ts'])
    expect(left.tmpHomes).toEqual(['shep-proof-home'])
    expect(left.logFolders).toEqual(['merged-task'])
    expect(parseWorktrees(porcelain)).toHaveLength(3)
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
      { name: 'docs', status: 'skipped', secs: 0, note: 'gitleaks is missing' },
    ],
    failed: [],
    secs: 68,
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
    report: '/repo/.git/shepherdr-weekly/report.md',
    logs: '/logs',
    browsers: [{ engine: 'chromium', line: 'ok (1s)' }],
    gate,
    audit: { fresh: [], known: 2, offline: false },
    outdated: [],
    probe: { files: [], skipped: '' },
    coverage: { commit: 'abc1234', at: 0, ageDays: 3, summary: 'Coverage: 91.2%', top: [], exempt: 4 },
    leftovers: { worktrees: 1, dead: [], merged: [], tmpHomes: [], logFolders: [], uncommitted: [] },
    took: 500,
    ...o,
  }
}

describe('the report and its tasks', () => {
  test('the report carries every part, the audit, the probe, the coverage trend and the leftovers', () => {
    const run = baseRun({
      outdated: [{ pkg: 'ws', current: '8.22.0', update: '8.23.0', latest: '8.23.0', dev: false }],
      probe: { files: [{ file: 'test/layout-a.test.ts', ok: true, repeats: REPEATS, detail: [] }], skipped: '' },
      coverage: { commit: 'abc1234', at: 0, ageDays: 3, summary: 'Coverage: 91.2%', top: ['index.ts 90.0% missed 2: 4, 9'], exempt: 4 },
      leftovers: { worktrees: 3, dead: ['/tmp/gone'], merged: ['work/1'], tmpHomes: ['shep-proof'], logFolders: ['merged-task'], uncommitted: [' M x.ts'] },
    })
    const report = buildReport(run)
    expect(report).toContain('# Weekly full check · 2026-11-22T08:30:00.000Z')
    expect(report).toContain('Took 8m20s.')
    expect(report).toContain('## Gate\nPASSED in 1m08s')
    expect(report).toContain('- tests ok (1m02s): Ran 400 tests across 80 files')
    expect(report).toContain('- docs skipped: gitleaks is missing')
    expect(report).toContain('- chromium: ok (1s)')
    expect(report).toContain('- audit: 0 new, 2 accepted advisories')
    expect(report).toContain('ws 8.22.0 → 8.23.0')
    expect(report).toContain('Repeated 5 times each')
    expect(report).toContain('- test/layout-a.test.ts ok')
    expect(report).toContain('baseline from `abc1234`, 3 days old')
    expect(report).toContain('index.ts 90.0% missed 2: 4, 9')
    expect(report).toContain('`coverage-exempt:` markers in the tree: 4')
    expect(report).toContain('worktrees: 3, 1 dead, 1 of merged branches')
    expect(report).toContain('dead: /tmp/gone')
    expect(report).toContain('merged: work/1')
    expect(report).toContain('/tmp homes of finished tasks (older than 2 h): 1')
    expect(report).toContain('gate log folders older than 7 days: 1')
    expect(report).toContain('uncommitted files in this checkout: 1')
    expect(report).toContain('## Red\nNone: the gate passed and nothing else is red.')
  })

  test('a run that gave up, a registry it could not read and no baseline are said plainly', () => {
    const run = baseRun({
      browsers: [],
      audit: { fresh: [], known: 0, offline: true },
      probe: { files: [], skipped: 'asked not to run (--no-probe)' },
      coverage: { commit: '', at: null, ageDays: null, summary: '', top: [], exempt: 0 },
      gate: { ...baseRun().gate, ran: false, passed: false, parts: [], line: '', exitCode: 2 },
      leftovers: { worktrees: 0, dead: [], merged: [], tmpHomes: [], logFolders: [], uncommitted: [] },
    })
    const report = buildReport(run)
    expect(report).toContain('- nothing ran')
    expect(report).toContain('Exit code 2. Logs: `/logs`.')
    expect(report).toContain('- the probe said nothing')
    expect(report).toContain('- audit: the registry could not be read, advisories not checked')
    expect(report).toContain('Not run: asked not to run (--no-probe).')
    expect(report).toContain('- no baseline recorded on the default branch yet')
    expect(report).toContain('no coverage measured (the gate did not reach its coverage step)')
  })

  test('one task per red area: the gate, a new advisory and a flaky file, each with its own name', () => {
    const run = baseRun({
      gate: { ...baseRun().gate, ran: false, passed: false, parts: [], line: '', exitCode: 2 },
      audit: { fresh: ['ws · advisory 9'], known: 0, offline: false },
      probe: { files: [{ file: 'test/layout-settings-lazy.test.ts', ok: false, repeats: REPEATS, detail: ['opens the board'] }], skipped: '' },
    })
    const reds = redTasks(run)
    expect(reds.map((r) => r.area)).toEqual(['gate', 'audit', 'flaky test/layout-settings-lazy.test.ts'])
    expect(reds[0]?.title).toBe('Weekly: the gate did not run')
    expect(reds.every((r) => r.title.length <= TITLE_MAX)).toBe(true)
    expect(reds[1]?.brief).toContain('new advisories: ws · advisory 9')
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
    expect(out.lines).toHaveLength(2)
    expect(out.lines[1]?.startsWith('weekly: green · PASSED in 1m08s')).toBe(true)
    expect(out.lines[1]).toContain('1 file ok')
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
    expect(out.lines).toContain('weekly: red · types · file one task: Weekly: types red')
    expect(out.lines.at(-1)).toContain('weekly: 2 red areas · report:')
    const report = readFileSync(join(f.common, 'shepherdr-weekly', 'report.md'), 'utf8')
    expect(report).toContain('## Red: 2 areas, one task each')
    expect(report).toContain('### Weekly: tests red')
    // the probe does not add load to a machine whose suite is already red
    expect(report).toContain('Not run: the gate failed its tests part')
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
    expect(out.lines[1]?.startsWith('weekly: red · gate · file one task: Weekly: the gate did not run')).toBe(true)
    expect(readFileSync(join(f.common, 'shepherdr-weekly', 'report.md'), 'utf8')).toContain('Not run: asked not to run (--no-probe)')
    expect(parseArgs(['--sample', '2', '--no-probe'])).toEqual({ probe: false, sample: 2 })
    expect(parseArgs(['--sample', 'nope'])).toEqual({ probe: true, sample: 5 })
    expect(parseArgs([])).toEqual({ probe: true, sample: 5 })
  })

  test('outside a checkout it says so and runs nothing', () => {
    const dir = tmp('weekly-nogit')
    const out = capture()
    expect(main([], { root: dir, home: dir, tmpdir: dir, run: realRun, log: out.log })).toBe(2)
    expect(out.lines[0]).toContain('is not a git checkout')
    const repo = repoFixture()
    expect(baseBranch(world(repo, realRun))).toBe('herdr-tui')
    // a command this host does not have is one failed process, never a crash
    expect(realRun(['/nonexistent-shepherdr-weekly-command']).exitCode).not.toBe(0)
    expect(lowPriorityArgs(() => false)).toEqual([])
    // an entry that went while /tmp was listed is no age, never an error that loses the whole listing
    expect(mtimeOf('/nonexistent-shepherdr-weekly-entry')).toBe(0)
    expect(lowPriorityArgs(() => true)).toEqual(['nice', '-n', '19', 'ionice', '-c', '3'])
  })

  test('a browser that cannot start is named before the gate, not skipped inside it', () => {
    const f = repoFixture()
    const out = capture()
    const fakes = depsOf(f, out)
    fakes.run = fakeRun(f, { verdict: GREEN, browsers: 'chromium: not installed: bun x playwright-core install --only-shell chromium\nwebkit: ok (2s)\n' })
    expect(main(['--no-probe'], fakes)).toBe(0)
    const report = readFileSync(join(f.common, 'shepherdr-weekly', 'report.md'), 'utf8')
    expect(report).toContain('- chromium: not installed: bun x playwright-core install --only-shell chromium')
    expect(report).toContain('- webkit: ok (2s)')
  })
})

/** only what a run says, plus the fixture's world: main fills the rest with its own defaults */
function depsOf(f: ReturnType<typeof repoFixture>, out: { log: (l: string) => void }): Partial<Deps> {
  let t = 1_700_000_000_000
  return { root: f.repo, home: f.home, tmpdir: f.tmpdir, clock: () => (t += 500), log: out.log, lowPriority: [] }
}
