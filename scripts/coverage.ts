// How much of the code the tests run, and the ratchet that keeps it from falling: `bun run check:local`'s coverage step.
//
//   bun scripts/coverage.ts <dir>            read what a covered test run left in <dir> (scripts/test.ts --cover=<dir>),
//                                            say it, and compare it with the baseline: exit 1 where it fell
//   bun scripts/coverage.ts <dir> --record   the same, then keep it as the baseline (the check on the default branch)
//
// <dir>/server/lcov.info is Bun's own coverage of what the test processes load (the server, shared, scripts); each
// <dir>/screen/<test file>.json is what a browser test ran of the screen's own files (test/screen-map.ts record): the
// two make one count per file of the lines no test runs. The ratchet holds that count, file by file: no file may gain
// a line no test runs, a new file comes in with none, and a file a test ran must still be run. A line is let off only
// where it, or the line just above it, says `coverage-exempt: <why>` (an error path a test can't reach on this host).
//
// The baseline is the default branch's, kept in the repo's own .git for every worktree (as the screen map), recorded by
// the check there from a clean tree whose tests passed. Until the first such run there is none, and nothing is compared.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = join(import.meta.dir, '..')

/** each file's lines that run code, and whether a test ran them (1) or none did (0) */
export type Cover = Map<string, Map<number, 0 | 1>>

/** what the baseline keeps: per file, how many of its lines no test runs (null: no test loaded it then) */
export type Baseline = { commit: string; at: number; files: Record<string, number | null> }

/** one file's count: how many lines run code, which of them no test runs (past those let off), whether any test loaded it */
export type FileCount = { lines: number; missed: number[]; measured: boolean }

/** Bun's lcov: each file's DA lines, by line */
export function readLcov(text: string, into: Cover = new Map()): Cover {
  let file: Map<number, 0 | 1> | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('SF:')) file = into.get(line.slice(3)) ?? into.set(line.slice(3), new Map()).get(line.slice(3))
    else if (line.startsWith('DA:') && file) {
      const [n, count] = line.slice(3).split(',').map(Number)
      if (count > 0) file.set(n, 1)
      else if (!file.has(n)) file.set(n, 0)
    } else if (line === 'end_of_record') file = undefined
  }
  return into
}

/** a browser test's lines (test/screen-map.ts Lines), into the same count: a line any test ran is run */
export function addScreen(lines: Record<string, Record<string, 0 | 1>>, into: Cover = new Map()): Cover {
  for (const [file, ls] of Object.entries(lines)) {
    const own = into.get(file) ?? into.set(file, new Map()).get(file)!
    for (const [n, ran] of Object.entries(ls)) if (ran || !own.has(+n)) own.set(+n, ran ? 1 : own.get(+n) ?? 0)
  }
  return into
}

/** the files the ratchet holds: the code, never the tests, generated files or a library's */
export const counted = (file: string) => /^(server|shared|src|plugins|scripts)\/.+\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes('/generated/')

/** a line let off: it, or the line just above it, says why no test runs it */
export const exempt = (text: string[], n: number) => /coverage-exempt:/.test(text[n - 1] ?? '') || /coverage-exempt:/.test(text[n - 2] ?? '')

/** each file's count, for the files it is told of (the ones tracked here), measured or not */
export function count(cover: Cover, files: string[], read: (f: string) => string): Record<string, FileCount> {
  const out: Record<string, FileCount> = {}
  for (const f of files) {
    const ls = cover.get(f)
    if (!ls) {
      out[f] = { lines: 0, missed: [], measured: false }
      continue
    }
    let text: string[] = []
    try {
      text = read(f).split('\n')
    } catch {
      /* gone since the run: what it said still counts */
    }
    const missed = [...ls].filter(([n, ran]) => !ran && !exempt(text, n)).map(([n]) => n).sort((a, b) => a - b)
    out[f] = { lines: ls.size, missed, measured: true }
  }
  return out
}

/** lines as short spans: "12-14, 40" */
export function spans(ns: number[]): string {
  const out: string[] = []
  for (let i = 0; i < ns.length; i++) {
    let j = i
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++
    out.push(i === j ? `${ns[i]}` : `${ns[i]}-${ns[j]}`)
    i = j
  }
  return out.join(', ')
}

/** how many more missed lines a file may show than at the baseline: none for the server's (Bun counts the same lines
 *  every run); a little for the screen's, whose browser tests take a branch or two by timing (a card a moment late),
 *  so the same code reads a few lines up or down from one run to the next */
export const slack = (f: string, c: FileCount) => (isScreen(f) ? Math.max(3, Math.ceil(c.lines * 0.005)) : 0)

/** what fell since the baseline, one line per file, in words; none: it held */
export function compare(now: Record<string, FileCount>, base: Baseline): string[] {
  const fell: string[] = []
  for (const [f, c] of Object.entries(now)) {
    const was = base.files[f]
    const lines = (ns: number[]) => `line${ns.length === 1 ? '' : 's'} ${spans(ns).slice(0, 120)}`
    const leeway = slack(f, c)
    if (!(f in base.files)) {
      if (!c.measured) fell.push(`${f}: a new file no test runs at all`)
      else if (c.missed.length > leeway) fell.push(`${f}: a new file with ${c.missed.length} line${c.missed.length === 1 ? '' : 's'} no test runs (${lines(c.missed)})`)
    } else if (was !== null && was !== undefined) {
      if (!c.measured) fell.push(`${f}: no test runs it any more (it had ${was} line${was === 1 ? '' : 's'} no test ran)`)
      else if (c.missed.length > was + leeway) fell.push(`${f}: ${c.missed.length - was} more line${c.missed.length - was === 1 ? '' : 's'} no test runs (${c.missed.length} now, ${was} at the baseline${leeway ? `, ${leeway} allowed for the screen's run-to-run wobble` : ''}; ${lines(c.missed)})`)
    }
  }
  return fell
}

/** the counts in a line: the server's and the screen's share of lines run, and the files run whole */
export function summary(now: Record<string, FileCount>): string {
  const part = (screen: boolean) => {
    const fs = Object.entries(now).filter(([f, c]) => c.measured && isScreen(f) === screen)
    const lines = fs.reduce((a, [, c]) => a + c.lines, 0)
    const missed = fs.reduce((a, [, c]) => a + c.missed.length, 0)
    return lines ? `${(((lines - missed) / lines) * 100).toFixed(1)}% of the ${screen ? "screen's" : "server's"} lines (${lines - missed} of ${lines})` : `none of the ${screen ? 'screen' : 'server'} measured`
  }
  const all = Object.values(now)
  const whole = all.filter((c) => c.measured && !c.missed.length).length
  const unmeasured = all.filter((c) => !c.measured).length
  return `Coverage: ${part(false)}, ${part(true)}; ${whole} of ${all.length} files run whole${unmeasured ? `, ${unmeasured} no test loads` : ''}`
}

/** the screen's own code: what runs in the browser (src/, and each plugin's client) */
export const isScreen = (f: string) => f.startsWith('src/') || /^plugins\/[^/]+\/client\.tsx?$/.test(f) || (f.startsWith('plugins/') && f.endsWith('.tsx'))

/** every file's count for a reader, worst first: "file  92.1%  missed: 12-14, 40" */
export function report(now: Record<string, FileCount>): string {
  const rows = Object.entries(now).sort(([a, x], [b, y]) => y.missed.length - x.missed.length || (x.measured === y.measured ? a.localeCompare(b) : x.measured ? 1 : -1))
  return rows
    .map(([f, c]) => (c.measured ? `${f.padEnd(48)} ${(c.lines ? ((c.lines - c.missed.length) / c.lines) * 100 : 100).toFixed(1).padStart(5)}%  ${c.missed.length ? `missed ${c.missed.length}: ${spans(c.missed)}` : 'whole'}` : `${f.padEnd(48)}     -   no test loads it`))
    .join('\n')
}

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return r.success ? r.stdout.toString() : null
}

/** where the baseline is kept: the repo's own .git, shared by all its worktrees */
export function baselineFile(repo = root) {
  const common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')?.trim()
  return join(common || join(repo, 'node_modules', '.cache'), 'shepherdr-test', 'coverage.json')
}

export function readBaseline(file: string): Baseline | null {
  try {
    const b = JSON.parse(readFileSync(file, 'utf8')) as Baseline
    return b.commit && b.files ? b : null
  } catch {
    return null
  }
}

/** what a covered run left in <dir>: the server's lcov and each browser test's lines */
export function gatherRun(dir: string): Cover | null {
  const lcov = join(dir, 'server', 'lcov.info')
  if (!existsSync(lcov)) return null
  const cover = readLcov(readFileSync(lcov, 'utf8'))
  const screen = join(dir, 'screen')
  for (const n of existsSync(screen) ? readdirSync(screen).filter((x) => x.endsWith('.json')) : []) addScreen(JSON.parse(readFileSync(join(screen, n), 'utf8')), cover)
  return cover
}

/** the command: what a run left in <dir>, said, held against the baseline and, with --record, kept as it; its exit code.
 *  repo and baseline are this repo's and its .git's, unless a test names its own */
export function main(args: string[], o: { repo?: string; baseline?: string; log?: (s: string) => void } = {}): number {
  const repo = o.repo ?? root
  const log = o.log ?? ((x: string) => console.log(x))
  const [dir, ...rest] = args
  if (!dir) {
    log('bun scripts/coverage.ts <dir> [--record]: <dir> is what scripts/test.ts --cover=<dir> left')
    return 2
  }
  const cover = gatherRun(dir)
  if (!cover) {
    log(`No coverage in ${dir}: run the tests with scripts/test.ts --cover=${dir} first.`)
    return 2
  }
  const tracked = (git(repo, 'ls-files') ?? '').split('\n').filter(counted)
  const now = count(cover, tracked, (f) => readFileSync(join(repo, f), 'utf8'))
  writeFileSync(join(dir, 'report.txt'), `${summary(now)}\n\n${report(now)}\n`)
  log(summary(now))
  log(`Each file's lines no test runs: ${join(dir, 'report.txt')}`)
  const file = o.baseline ?? baselineFile(repo)
  const base = readBaseline(file)
  let code = 0
  if (!base) log('No coverage baseline yet: the check on the default branch records one, and from then no file may lose coverage.')
  else {
    const fell = compare(now, base)
    if (fell.length) {
      log(`\nCoverage fell since the baseline (${base.commit.slice(0, 7)}): ${fell.length} file${fell.length === 1 ? '' : 's'}. Test what you added or changed, or mark a line no test can reach here with a coverage-exempt: comment saying why.`)
      for (const f of fell) log(`  ${f}`)
      code = 1
    } else log(`Coverage held: no file has more lines no test runs than at ${base.commit.slice(0, 7)}.`)
  }
  if (rest.includes('--record')) {
    const commit = git(repo, 'rev-parse', 'HEAD')?.trim() ?? ''
    if (git(repo, 'status', '--porcelain')?.trim()) log("No coverage baseline recorded: the tree holds what is not committed, and a baseline is a commit's.")
    else {
      const files = Object.fromEntries(Object.entries(now).map(([f, c]) => [f, c.measured ? c.missed.length : null]))
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ commit, at: Date.now(), files } satisfies Baseline))
      log(`Coverage baseline of ${commit.slice(0, 7)}: recorded in ${file}.`)
    }
  }
  return code
}

// coverage-exempt: the command itself, which test/coverage.test.ts runs through main()
if (import.meta.main) process.exit(main(process.argv.slice(2)))
