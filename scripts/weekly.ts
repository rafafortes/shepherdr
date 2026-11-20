// The weekly full check (audit 2026-11-18, QG-11): the one run that sees what a task's gate cannot. A task runs
// `bun run check:local --quick`, so a break only a full run shows (a WebKit-only test, two green branches breaking
// together, a dependency advisory, a browser test gone flaky under this machine's load) waits for the merge gate of
// the next task; this runs the full gate on the default branch on a schedule instead, at the check's own low priority.
//
//   bun scripts/weekly.ts                 the run: the full gate, the audit, `bun outdated`, a flaky probe, the
//                                         coverage trend and the leftovers, then the report
//   bun scripts/weekly.ts --no-probe      the same without the flaky probe (a trial run, never the weekly one)
//   bun scripts/weekly.ts --sample 2      the flaky probe repeats that many files (default 5, at most the file count)
//
// It is one Shepherdr automation, "Weekly full check" (Tuesday 9:00, after Monday's upstream pass): its added task runs
// this and, on red, files one task per red area through the space's coordinator. The script never starts an agent and
// never changes a dependency: updates are only reported, to be weighed and pinned one by one.
//
// It writes one markdown report into the repository's own .git, beside the coverage, audit, lint and dist baselines
// (`shepherdr-weekly/report.md`, with `state.json` for the next week's rotating sample), never into the tree: a report
// of this machine's numbers has nothing to do in the repository's history.
//
// Exit codes: 0 every part green, 1 a red part (the report names which), 2 it could not run (not a git checkout, or the
// report could not be written).
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { compare, parseAudit, readBaseline as readAuditBaseline } from './checks/audit.ts'
import { counted, readBaseline as readCoverageBaseline } from './coverage.ts'

const repoRoot = join(import.meta.dir, '..')

/* ---------- what it touches outside, so a test can stand in for it ---------- */

export type RunResult = { stdout: string; stderr: string; exitCode: number }
/** one process: its output, never its state */
export type Run = (args: string[], opts?: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number }) => RunResult
export type Entry = { name: string; dir: boolean; mtime: number }

export type Deps = {
  root: string
  home: string
  /** /tmp, where a proof server's home and a test's folders land */
  tmpdir: string
  clock: () => number
  run: Run
  read: (file: string) => string | null
  exists: (path: string) => boolean
  list: (dir: string) => Entry[]
  write: (file: string, text: string) => void
  /** whether a process is still there: a proof server of a finished task is not */
  alive: (pid: number) => boolean
  log: (line: string) => void
  /** the prefix that puts a child last in line for the CPU and the disk, as the check and the tests do */
  lowPriority: string[]
}

/** the one real process call: a test stands in for it, and a missing command is one failed process, never a crash */
export const realRun: Run = (args, o = {}) => {
  try {
    const r = Bun.spawnSync(args, {
      cwd: o.cwd ?? repoRoot,
      env: { ...process.env, ...o.env },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: o.timeout,
    })
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.exitCode ?? 1 }
  } catch (e) {
    return { stdout: '', stderr: String(e), exitCode: 1 }
  }
}

/** nice 19 and idle I/O where this host has them: the weekly run never pushes the machine */
export function lowPriorityArgs(which: (cmd: string) => boolean = (c) => !!Bun.which(c)): string[] {
  const out: string[] = []
  if (which('nice')) out.push('nice', '-n', '19')
  if (which('ionice')) out.push('ionice', '-c', '3')
  return out
}

/** whether a process is still there (signal 0 asks, it does not send) */
export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** a file's age, or 0 for one that went while its folder was being listed */
export const mtimeOf = (file: string): number => {
  try {
    return lstatSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** a folder's entries with their age; a folder that is not there is nothing */
const listDir = (dir: string): Entry[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory(), mtime: mtimeOf(join(dir, e.name)) }))
  } catch {
    return []
  }
}

const defaults = (): Deps => ({
  root: repoRoot,
  home: process.env.HOME ?? '/tmp',
  tmpdir: '/tmp',
  clock: Date.now,
  run: realRun,
  read: (file) => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return null
    }
  },
  exists: (path) => existsSync(path),
  alive: processAlive,
  list: listDir,
  write: (file, text) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  },
  log: (line) => console.log(line),
  lowPriority: lowPriorityArgs(),
})

/* ---------- the gate's verdict, as the runner leaves it ---------- */

export type Part = { name: string; status: 'ok' | 'skipped' | 'failed'; secs: number; note: string }
export type GateResult = {
  /** it got to run its checks at all: false when it gave up waiting, or ended before its first step */
  ran: boolean
  passed: boolean
  parts: Part[]
  failed: string[]
  /** the parts that did not run: a week that did not check them is not a full week */
  skipped: string[]
  /** the runner's own `! note` lines: what it says did not happen, outside a step */
  notes: string[]
  /** `PASSED in 2m03s` or `FAILED in ...: types tests` */
  line: string
  branch: string
  commit: string
  logs: string
  exitCode: number
}

/** a match's group as text: a regex that matched always has it, but the type does not know */
const group = (m: RegExpMatchArray, i: number): string => m[i] ?? ''

/** `12s` or `2m03s` as seconds */
export function parseDur(text: string): number {
  const m = text.trim().match(/^(?:(\d+)m)?(\d+)s$/)
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : 0
}

/** the runner's verdict.txt: one part per line, a skipped reason into it, the closing verdict line */
export function parseVerdict(text: string): Omit<GateResult, 'logs' | 'exitCode'> {
  const parts: Part[] = []
  const notes: string[] = []
  let line = ''
  let passed = false
  let branch = ''
  let commit = ''
  for (const raw of text.split('\n')) {
    const head = raw.match(/^check:local(?: QUICK)? · (\S+) at (\S+)/)
    if (head) {
      branch = group(head, 1)
      commit = group(head, 2)
      continue
    }
    const note = raw.match(/^\s*! (.+)$/)
    if (note) {
      notes.push(note[1] ?? '')
      continue
    }
    const step = raw.match(/^(\d+)\/(\d+) ([\w-]+) (ok|skipped|FAILED|STOPPED|TIMED OUT, killed|TIMED OUT|KILLED)(?: \(([^)]*)\))?(.*)$/)
    if (step) {
      const said = group(step, 4)
      const status = said === 'ok' ? 'ok' : said === 'skipped' ? 'skipped' : 'failed'
      parts.push({
        name: group(step, 3),
        status,
        secs: parseDur(group(step, 5)),
        note: group(step, 6)
          .replace(/^:\s*|\s+/g, ' ')
          .trim(),
      })
      continue
    }
    const end = raw.match(/^(PASSED|FAILED|NOT A FULL VERDICT) in (\d+(?:m\d+)?s)(.*)$/)
    if (end) {
      passed = end[1] === 'PASSED'
      line = raw.replace(/ · logs: .*$/, '')
    }
  }
  const failed = parts.filter((p) => p.status === 'failed').map((p) => p.name)
  const skipped = parts.filter((p) => p.status === 'skipped').map((p) => p.name)
  return { ran: parts.length > 0, passed, parts, failed, skipped, notes, line, branch, commit }
}

/** where the runner keeps this worktree's verdict and step logs */
export const logsOf = (d: Deps) => join(d.home, '.cache', 'shepherdr', 'check-local', basename(d.root))

/** the full gate, the longest part: the whole check, the whole tree's language scan (the weekly run's), nice 19 */
export function runGate(d: Deps): GateResult {
  const logs = logsOf(d)
  const r = d.run(['bash', join(d.root, 'scripts', 'check-local.sh')], {
    cwd: d.root,
    env: { SHEPHERDR_LANGUAGE_SCOPE: 'tree' },
    timeout: 3 * 60 * 60_000,
  })
  const parsed = parseVerdict(d.read(join(logs, 'verdict.txt')) ?? r.stdout)
  // a verdict that says it passed but a runner that failed is red: the code is what a task's tool reads
  const passed = parsed.passed && r.exitCode === 0
  return { ...parsed, passed, logs, exitCode: r.exitCode }
}

/* ---------- dependencies ---------- */

export type AuditInfo = { fresh: string[]; known: number; offline: boolean }

/** `bun audit --json`, weighed against the ids the default branch accepted (the gate's own step, said again here so the
 *  report carries the advisories' lines even when the step was not the thing that failed) */
export function auditInfo(d: Deps, common: string): AuditInfo {
  const r = d.run(['bun', 'audit', '--json'], { cwd: d.root, timeout: 120_000 })
  const report = parseAudit(r.stdout)
  if (!report) return { fresh: [], known: 0, offline: true }
  const base = readAuditBaseline(join(common, 'shepherdr-audit', 'accepted.json'))
  const c = compare(report, base?.ids ?? [])
  return { fresh: c.fresh, known: c.known.length, offline: false }
}

export type Outdated = { pkg: string; current: string; update: string; latest: string; dev: boolean }

/** the rows of `bun outdated`' table: what could move, never moved here (each update is weighed and pinned by hand) */
export function parseOutdated(text: string): Outdated[] {
  const out: Outdated[] = []
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/)
    if (!m) continue
    const first = group(m, 1)
    const dev = / \(dev\)$/.test(first)
    const pkg = first.replace(/ \(dev\)$/, '')
    if (pkg === 'Package' || pkg.startsWith('-') || group(m, 2).startsWith('-')) continue
    out.push({ pkg, current: group(m, 2), update: group(m, 3), latest: group(m, 4), dev })
  }
  return out
}

export type OutdatedInfo = { rows: Outdated[]; offline: boolean }

/** what could move; a registry that cannot be reached is a note, never "nothing to move" */
export function outdatedInfo(d: Deps): OutdatedInfo {
  const r = d.run(['bun', 'outdated'], { cwd: d.root, timeout: 180_000 })
  return r.exitCode === 0 ? { rows: parseOutdated(r.stdout), offline: false } : { rows: [], offline: true }
}

/* ---------- the flaky probe ---------- */

/** how many times the probe repeats a file's tests: a file that fails once in five is the flaky one */
export const REPEATS = 5

/** the test files that open a browser (they import test/web.ts or the layout, native or browser helpers) */
export function browserTests(d: Deps): string[] {
  return d
    .list(join(d.root, 'test'))
    .filter((e) => !e.dir && /\.test\.tsx?$/.test(e.name))
    .map((e) => `test/${e.name}`)
    .filter((f) => /['"]\.\/(web|layout|native|chromium)\.ts['"]/.test(d.read(join(d.root, f)) ?? ''))
    .sort()
}

/** the browser test files, the slowest first, from the timings `scripts/test.ts` keeps (unknown ones last, by name) */
export function orderBySlowest(files: string[], timings: Record<string, number> | null): string[] {
  const ms = (f: string) => timings?.[f] ?? timings?.[f.replace(/^test\//, '')] ?? 0
  return [...files].sort((a, b) => ms(b) - ms(a) || a.localeCompare(b))
}

/** the next sample: five files from the slowest-first list, the window moving on past last week's last pick and
 *  wrapping, so the whole set is reached over the weeks and the slowest are probed again on the next turn of the list */
export function pickSample(ordered: string[], previous: string[], size: number): string[] {
  if (!ordered.length || size < 1) return []
  const at = previous.length ? ordered.indexOf(previous[previous.length - 1] ?? '') : -1
  const from = at < 0 ? 0 : (at + 1) % ordered.length
  const out: string[] = []
  for (let i = 0; i < Math.min(size, ordered.length); i++) out.push(ordered[(from + i) % ordered.length] ?? '')
  return out
}

export type ProbeFile = { file: string; ok: boolean; repeats: number; detail: string[] }
export type Probe = { files: ProbeFile[]; skipped: string }

/** the failing tests a `bun test` run named, for the report and a task's brief */
export function failingTests(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const m = raw.match(/\(fail\) (.+?) \[[0-9.]+ms\]$/)
    if (m?.[1]) out.push(m[1])
  }
  return [...new Set(out)].slice(0, 5)
}

/** repeat each file's tests five times: a failure in any repeat is the file that is flaky */
export function runProbe(d: Deps, files: string[]): ProbeFile[] {
  return files.map((file) => {
    // --parallel: a plain `bun test` is sent through scripts/test.ts by test/preload.ts, which rewrites the timings that
    // order this very list; its own worker leaves them alone
    const r = d.run([...d.lowPriority, 'bun', 'test', '--parallel=1', `--rerun-each=${REPEATS}`, '--timeout=20000', `./${file}`], {
      cwd: d.root,
      timeout: 30 * 60_000,
      // as the runner gives them to the suite: a test that makes a commit needs somebody to make it
      env: { GIT_AUTHOR_NAME: 'CI', GIT_AUTHOR_EMAIL: 'ci@localhost', GIT_COMMITTER_NAME: 'CI', GIT_COMMITTER_EMAIL: 'ci@localhost' },
    })
    const detail = r.exitCode === 0 ? [] : failingTests(`${r.stdout}\n${r.stderr}`)
    return { file, ok: r.exitCode === 0, repeats: REPEATS, detail: detail.length ? detail : [`exit ${r.exitCode}`] }
  })
}

type State = { at: number; commit: string; sample: string[] }

export const weeklyDir = (common: string) => join(common, 'shepherdr-weekly')

function readState(file: string, read: (f: string) => string | null): State | null {
  try {
    const s = JSON.parse(read(file) ?? '') as State
    return Array.isArray(s?.sample) ? s : null
  } catch {
    return null
  }
}

/* ---------- the coverage trend ---------- */

export type CoverageTrend = { commit: string; at: number | null; ageDays: number | null; summary: string; top: string[]; exempt: number }

/** `measured`: this run reached its coverage step; a report left by an earlier run is not this week's trend */
export function coverageTrend(d: Deps, common: string, logs: string, measured = true): CoverageTrend {
  const base = readCoverageBaseline(join(common, 'shepherdr-test', 'coverage.json'))
  const lines = measured ? (d.read(join(logs, 'coverage', 'report.txt')) ?? '').split('\n').filter(Boolean) : []
  const files = git(d, 'ls-files').split('\n').filter(counted)
  let exempt = 0
  for (const f of files) for (const line of (d.read(join(d.root, f)) ?? '').split('\n')) if (/(^|\s)(\/\/|#|\*)\s*coverage-exempt:/.test(line)) exempt++
  return {
    commit: base?.commit ?? '',
    at: base?.at ?? null,
    ageDays: base?.at ? Math.floor((d.clock() - base.at) / 86_400_000) : null,
    summary: lines[0] ?? '',
    top: lines
      .slice(1)
      .filter((l) => l.includes('missed'))
      .slice(0, 5),
    exempt,
  }
}

/* ---------- the leftovers ---------- */

export type Leftovers = {
  worktrees: number
  dead: string[]
  /** worktrees whose task already landed: by ancestry, or by the task id its branch and the base both name */
  done: string[]
  /** /tmp proof scratch of finished tasks: files and folders, a running server's home left out */
  tmpHomes: string[]
  logFolders: string[]
  uncommitted: string[]
}

/** a /tmp entry counts as leftover proof scratch once it is this old: a running task's is younger */
export const TMP_AGE = 2 * 60 * 60_000
/** a gate log folder nothing is likely to read again */
export const LOG_AGE = 7 * 86_400_000
/** a worktree of a landed task counts once it has sat this long: an hour-old one may still be the task at work */
export const DONE_AGE = 24 * 60 * 60_000

export function parseWorktrees(text: string): { path: string; branch: string }[] {
  const out: { path: string; branch: string }[] = []
  let path = ''
  let branch = ''
  for (const raw of text.split('\n')) {
    if (raw.startsWith('worktree ')) {
      if (path) out.push({ path, branch })
      path = raw.slice('worktree '.length).trim()
      branch = ''
    } else if (raw.startsWith('branch '))
      branch = raw
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '')
  }
  if (path) out.push({ path, branch })
  return out
}

/** the task a commit belongs to, from this repo's subject convention (`SHE-90: ...`), or '' */
export function taskOf(subject: string): string {
  return subject.match(/^([A-Z][A-Z0-9]*-\d+):/)?.[1] ?? ''
}

/** whether a /tmp folder is a Shepherdr home whose server still runs (its server.json names the pid) */
function serverRunning(d: Deps, name: string): boolean {
  const home = join(d.tmpdir, name)
  if (!d.exists(join(home, 'server.json'))) return false
  try {
    const pid = (JSON.parse(d.read(join(home, 'server.json')) ?? '') as { pid?: number }).pid
    return typeof pid === 'number' && d.alive(pid)
  } catch {
    return false
  }
}

/** the default branch: origin/HEAD when the checkout has it, else the branch it is on */
export function baseBranch(d: Deps): string {
  const head = git(d, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  return head ? head.replace(/^origin\//, '') : git(d, 'rev-parse', '--abbrev-ref', 'HEAD') || 'main'
}

/** what work of finished tasks left behind: nothing is deleted here, the report only names it for the operator */
export function leftovers(d: Deps, base: string, branch: string): Leftovers {
  const trees = parseWorktrees(git(d, 'worktree', 'list', '--porcelain'))
  const merged = new Set(
    git(d, 'branch', '--merged', base)
      .split('\n')
      .map((l) => l.replace(/^[*+]\s+/, '').trim())
      .filter(Boolean),
  )
  // a task lands as one squashed commit under the same task id, so ancestry alone sees none of them: the base's
  // subjects are the other half, and a branch whose own subject already sits there is a task that landed
  const landed = new Set(git(d, 'log', '--format=%s', base).split('\n').map(taskOf).filter(Boolean))
  const done = (w: { path: string; branch: string }) => {
    if (!w.branch || w.branch === branch || w.branch === base) return false
    // the subject and the time in one call: a live follow-up on an id that already landed is not a leftover
    const [subject = '', at = '0'] = git(d, 'log', '-1', '--format=%s%x00%ct', w.branch).split('\u0000')
    if (d.clock() - Number(at) * 1000 < DONE_AGE) return false
    return merged.has(w.branch) || landed.has(taskOf(subject))
  }
  return {
    worktrees: trees.length,
    dead: trees.filter((w) => !d.exists(w.path)).map((w) => w.path),
    done: trees.filter(done).map((w) => w.branch),
    uncommitted: git(d, 'status', '--porcelain').split('\n').filter(Boolean),
    tmpHomes: d
      .list(d.tmpdir)
      .filter((e) => e.name.toLowerCase().includes('proof') && d.clock() - e.mtime > TMP_AGE && !serverRunning(d, e.name))
      .map((e) => e.name)
      .sort(),
    logFolders: d
      .list(join(d.home, '.cache', 'shepherdr', 'check-local'))
      .filter((e) => e.dir && e.name !== 'verdicts' && d.clock() - e.mtime > LOG_AGE)
      .map((e) => e.name)
      .sort(),
  }
}

/* ---------- the report ---------- */

export type WeeklyRun = {
  at: number
  root: string
  branch: string
  commit: string
  base: string
  /** the base's tip, and how many of its commits this run does not have (null when git cannot say) */
  tip: string
  behind: number | null
  report: string
  browsers: { engine: string; line: string }[]
  gate: GateResult
  audit: AuditInfo
  outdated: OutdatedInfo
  probe: Probe
  coverage: CoverageTrend
  leftovers: Leftovers
  took: number
}

/** a task's title fits one line on a phone: at most 32 characters */
export const TITLE_MAX = 32
export const fitTitle = (text: string) => (text.length <= TITLE_MAX ? text : text.slice(0, TITLE_MAX))
/** a long file name keeps its tail, where two of them usually differ */
export const fitFlakyTitle = (name: string) => {
  const title = `Weekly: flaky ${name}`
  if (title.length <= TITLE_MAX) return title
  const keep = TITLE_MAX - 'Weekly: flaky …'.length
  return `Weekly: flaky …${name.slice(-keep)}`
}

export type RedTask = { area: string; title: string; brief: string }

/** one task per red area, named and unambiguous: the gate's own step names one, a flaky file another */
export function redTasks(run: WeeklyRun): RedTask[] {
  const out: RedTask[] = []
  const seen = new Set<string>()
  const at = new Date(run.at).toISOString().slice(0, 10)
  const head = `The weekly full check of ${at} on ${run.branch} at ${run.commit} (report: ${run.report})`
  const add = (area: string, title: string, what: string) => {
    if (seen.has(area)) return
    seen.add(area)
    out.push({
      area,
      title,
      brief: `${head} found ${what}. Run bun run check:local in a worktree of ${run.base} and fix it: the full check is where nothing may be missed, and nothing merges over a red one. Look upstream first, as AGENTS.md asks.`,
    })
  }
  const gate = run.gate
  // a gate that never ran, or ended without a pass it could name a step for (gave up, stopped, killed, or passed on paper
  // with a failing runner), is red as a whole: a task per step is only possible when a step says it failed
  if (!gate.ran) add('gate', fitTitle('Weekly: the gate did not run'), 'the full gate unable to run (it gave up or ended before its first step)')
  else if (!gate.passed && !gate.failed.length) add('gate', fitTitle('Weekly: the gate did not pass'), `the full gate ending without a pass (${gate.line || 'no verdict line'}, exit ${gate.exitCode})`)
  for (const name of gate.failed) {
    const advisories = name === 'audit' && run.audit.fresh.length ? ` New advisories: ${run.audit.fresh.join(' · ')}.` : ''
    add(name, fitTitle(`Weekly: ${name} red`), `the ${name} step of the full gate red.${advisories}`)
  }
  // a part the runner skipped was not checked this week at all: the week where nothing may be missed is where that is news
  for (const name of gate.skipped) {
    const reason = gate.parts.find((p) => p.name === name)?.note ?? 'no reason given'
    add(`${name} not run`, fitTitle(`Weekly: ${name} did not run`), `the ${name} step of the full gate did not run this week (${reason})`)
  }
  if (run.audit.fresh.length && !seen.has('audit')) add('audit', fitTitle('Weekly: audit red'), `new advisories: ${run.audit.fresh.join(' · ')}`)
  // the gate opens both browsers before its tests: one that cannot start means its tests skip silently inside it, and no
  // browser line at all means the probe did not get to run
  if (!run.browsers.length) add('browsers', fitTitle('Weekly: browsers not checked'), 'the gate left no browser probe line, so nobody knows whether its browser tests ran')
  for (const b of run.browsers.filter((b) => !/^ok\b/.test(b.line))) {
    add(`browser ${b.engine}`, fitTitle(`Weekly: ${b.engine} did not start`), `the ${b.engine} browser could not start (${b.line || 'no line from the probe'}), so every test of its engine would skip`)
  }
  // the runner's own notes: what did not happen outside a step (the skipped steps and the browsers are named above)
  const covered = new Set([...gate.skipped, ...run.browsers.map((b) => b.engine)])
  const loose = gate.notes.filter((n) => !covered.has(n.split(':')[0]?.trim() ?? ''))
  if (loose.length) add('notes', fitTitle('Weekly: the run skipped parts'), `the runner named what did not happen: ${loose.join(' · ')}`)
  for (const f of run.probe.files.filter((p) => !p.ok)) {
    const name = f.file.replace(/^test\//, '').replace(/\.test\.tsx?$/, '')
    add(`flaky ${f.file}`, fitFlakyTitle(name), `${f.file} failing at least once in ${f.repeats} repeats (${f.detail.join(' · ')})`)
  }
  return out
}

const dur = (secs: number) => (secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s` : `${secs}s`)

/** the one markdown report: the numbers this run measured, and the red areas' tasks */
export function buildReport(run: WeeklyRun, reds: RedTask[] = redTasks(run)): string {
  const gate = run.gate
  const probe = run.probe
  const cov = run.coverage
  const left = run.leftovers
  const audit = run.audit
  const parts = gate.parts.map((p) => {
    const took = p.secs ? ` (${dur(p.secs)})` : ''
    const status = p.status === 'ok' ? 'ok' : p.status === 'skipped' ? 'skipped' : 'FAILED'
    return `- ${p.name} ${status}${took}${p.note ? `: ${p.note}` : ''}`
  })
  const outdated = run.outdated.rows.map((o) => `${o.pkg} ${o.current} → ${o.latest}${o.dev ? ' (dev)' : ''}`)
  const shown = (names: string[], cap = 10) => [...names.slice(0, cap).map((n) => `  - ${n}`), ...(names.length > cap ? [`  - …and ${names.length - cap} more`] : [])]
  const baseTip =
    run.behind === null
      ? `- base \`${run.base}\`: its tip could not be read`
      : run.behind === 0
        ? `- base \`${run.base}\` at \`${run.tip.slice(0, 7)}\`: this run is its tip`
        : `- base \`${run.base}\` at \`${run.tip.slice(0, 7)}\`: ${run.behind} commit${run.behind === 1 ? '' : 's'} this run does not have`
  return [
    `# Weekly full check · ${new Date(run.at).toISOString()}`,
    '',
    `Branch \`${run.branch}\` at \`${run.commit}\` (base \`${run.base}\`), run in \`${run.root}\`.`,
    baseTip,
    `Took ${dur(run.took)}. Written by \`scripts/weekly.ts\` into the repository's own .git, never into the tree.`,
    '',
    '## Gate',
    gate.line || '(no verdict)',
    '',
    ...(parts.length ? parts : ['- nothing ran']),
    ...(gate.exitCode === 0 ? [] : ['', `Exit code ${gate.exitCode}. Logs: \`${gate.logs}\`.`]),
    '',
    '## Browsers',
    ...(run.browsers.length ? run.browsers.map((b) => `- ${b.engine}: ${b.line}`) : ['- the probe said nothing']),
    '',
    '## Dependencies',
    audit.offline ? '- audit: the registry could not be read, advisories not checked' : `- audit: ${audit.fresh.length} new, ${audit.known} accepted advisories`,
    ...(audit.fresh.length ? audit.fresh.map((f) => `  - new: ${f}`) : []),
    run.outdated.offline
      ? '- outdated: the registry could not be read, nothing weighed'
      : `- outdated: ${outdated.length} package${outdated.length === 1 ? '' : 's'} could move (weighed and pinned by hand, never bumped blind)`,
    ...(run.outdated.offline ? [] : outdated.map((o) => `  - ${o}`)),
    '',
    '## Flaky probe',
    probe.skipped ? `Not run: ${probe.skipped}.` : `Repeated ${REPEATS} times each, once more next week:`,
    ...(probe.skipped ? [] : probe.files.map((f) => `- ${f.file} ${f.ok ? 'ok' : `FAILED${f.detail.length ? `: ${f.detail.join(' · ')}` : ''}`}`)),
    '',
    '## Coverage trend',
    cov.at === null ? '- no baseline recorded on the default branch yet' : `- baseline from \`${cov.commit.slice(0, 7)}\`, ${cov.ageDays} day${cov.ageDays === 1 ? '' : 's'} old`,
    `- ${cov.summary || 'no coverage measured (the gate did not reach its coverage step)'}`,
    ...(cov.top.length ? ['- the files with lines no test runs:', ...cov.top.map((l) => `  - ${l.trim()}`)] : []),
    `- \`coverage-exempt:\` markers in the tree: ${cov.exempt}`,
    '',
    '## Leftovers (report only: nothing is deleted here)',
    `- worktrees: ${left.worktrees}, ${left.dead.length} dead, ${left.done.length} of done tasks`,
    ...(left.dead.length ? left.dead.map((p) => `  - dead: ${p}`) : []),
    ...(left.done.length ? left.done.map((b) => `  - done: ${b}`) : []),
    `- /tmp proof scratch of finished tasks (older than 2 h): ${left.tmpHomes.length}`,
    ...shown(left.tmpHomes),
    `- gate log folders older than 7 days: ${left.logFolders.length}`,
    `- uncommitted files in this checkout: ${left.uncommitted.length}`,
    ...shown(left.uncommitted),
    '',
    reds.length ? `## Red: ${reds.length} area${reds.length === 1 ? '' : 's'}, one task each` : '## Red',
    ...(reds.length ? reds.flatMap((r) => ['', `### ${r.title}`, r.brief]) : ['None: the gate passed and nothing else is red.']),
    '',
  ].join('\n')
}

/* ---------- the run ---------- */

const git = (d: Deps, ...args: string[]): string => {
  const r = d.run(['git', ...args], { cwd: d.root })
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

/** `--no-probe` and `--sample N` (at most five, the weekly probe's size) for a trial run */
export function parseArgs(argv: string[]): { probe: boolean; sample: number } {
  let probe = true
  let sample = 5
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-probe') probe = false
    else if (argv[i] === '--sample') {
      const n = Number(argv[++i])
      if (Number.isInteger(n) && n > 0) sample = Math.min(n, 5)
    }
  }
  return { probe, sample }
}

function pickProbe(d: Deps, common: string, sample: number): Probe {
  const files = browserTests(d)
  if (!files.length) return { files: [], skipped: 'no browser test file found' }
  let timings: Record<string, number> | null = null
  try {
    const t = JSON.parse(d.read(join(d.root, 'node_modules', '.cache', 'shepherdr-test', 'timings.json')) ?? 'null') as { files?: Record<string, number> } | null
    timings = t?.files ?? null
  } catch {
    /* no timings yet: the files go in by name */
  }
  const previous = readState(join(weeklyDir(common), 'state.json'), d.read)?.sample ?? []
  return { files: runProbe(d, pickSample(orderBySlowest(files, timings), previous, sample)), skipped: '' }
}

export function main(argv: string[], overrides: Partial<Deps> = {}): number {
  const opts = parseArgs(argv)
  const d: Deps = { ...defaults(), ...overrides }
  const started = d.clock()
  const root = d.root
  const common = git(d, 'rev-parse', '--path-format=absolute', '--git-common-dir') || join(root, '.git')
  const branch = git(d, 'rev-parse', '--abbrev-ref', 'HEAD') || 'HEAD'
  const commit = git(d, 'rev-parse', '--short', 'HEAD')
  if (!commit) {
    d.log(`weekly: ${root} is not a git checkout, so there is nothing to check`)
    return 2
  }
  const base = baseBranch(d)
  const tip = git(d, 'rev-parse', '--verify', '--quiet', `origin/${base}`)
  const behind = tip ? Number(git(d, 'rev-list', '--count', `HEAD..origin/${base}`)) : null
  const logs = logsOf(d)
  const gate = runGate(d)
  const browsers = gateBrowsers(d, logs)
  const audit = auditInfo(d, common)
  const outdated = outdatedInfo(d)
  let probe: Probe
  if (!opts.probe) probe = { files: [], skipped: 'asked not to run (--no-probe)' }
  else if (!gate.passed) probe = { files: [], skipped: 'the gate did not pass: the suite it already ran is the thing to fix first' }
  else probe = pickProbe(d, common, opts.sample)
  const run: WeeklyRun = {
    at: started,
    root,
    branch,
    commit,
    base,
    tip,
    behind: behind === null || Number.isNaN(behind) ? null : behind,
    report: join(weeklyDir(common), 'report.md'),
    browsers,
    gate,
    audit,
    outdated,
    probe,
    coverage: coverageTrend(
      d,
      common,
      logs,
      gate.parts.some((p) => p.name === 'coverage' && p.status === 'ok'),
    ),
    leftovers: leftovers(d, base, branch),
    took: Math.round((d.clock() - started) / 1000),
  }
  const reds = redTasks(run)
  try {
    d.write(run.report, buildReport(run, reds))
    // a week without a probe keeps the last sample: the rotation is the weekly run's, not a trial run's
    if (probe.files.length) d.write(join(weeklyDir(common), 'state.json'), JSON.stringify({ at: run.at, commit, sample: probe.files.map((f) => f.file) } satisfies State))
  } catch (e) {
    d.log(`weekly: the report could not be written (${e instanceof Error ? e.message : String(e)}): nothing was recorded`)
    return 2
  }
  if (!reds.length) {
    d.log(
      `weekly: green · ${gate.line || 'gate passed'} · audit ${audit.offline ? 'not checked (registry unreachable)' : `${audit.fresh.length} new, ${audit.known} accepted`} · outdated ${outdated.offline ? 'not checked (registry unreachable)' : outdated.rows.length} · probe ${probe.skipped ? `not run (${probe.skipped})` : `${probe.files.length} file${probe.files.length === 1 ? '' : 's'} ok`} · coverage ${run.coverage.summary || 'not measured'} · leftovers ${run.leftovers.worktrees} worktrees, ${run.leftovers.tmpHomes.length} proof scratch, ${run.leftovers.logFolders.length} old logs · report: ${run.report}`,
    )
    return 0
  }
  for (const red of reds) d.log(`weekly: red · ${red.area} · file one task: ${red.title}`)
  d.log(`weekly: ${reds.length} red area${reds.length === 1 ? '' : 's'} · report: ${run.report}`)
  return 1
}

/** both browsers as the gate opened them, from the probe log it keeps in the run's folder: it runs the probe right
 *  after installing the dependencies, which is the first moment playwright-core can be imported */
export function gateBrowsers(d: Deps, logs: string): { engine: string; line: string }[] {
  return (d.read(join(logs, 'browsers.log')) ?? '')
    .split('\n')
    .map((l) => l.match(/^(chromium|webkit): (.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ engine: group(m, 1), line: group(m, 2) }))
}

// coverage-exempt: the command's entry point; test/weekly.test.ts drives main() directly
if (import.meta.main) process.exit(main(process.argv.slice(2)))
