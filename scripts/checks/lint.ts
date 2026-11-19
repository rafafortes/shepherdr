// Check after the language one (audit 2026-11-18, QG-02): Biome lints the whole tree — floating promises, unused
// variables and imports, `any`, stale React hook dependencies and the rest of its recommended rules — where nothing
// mechanical stopped them before. Biome and not ESLint: one Rust binary and one biome.json, lint and format in the same
// tool, about a second over this tree against a typescript-eslint stack that needs its plugin ecosystem kept in step.
//
// A ratchet, like the coverage one (scripts/coverage.ts): what the tree carries today is recorded, per file and rule, as
// the baseline in the repo's .git, recorded by the check on the default branch; a file fails only when it has MORE
// findings of a rule than at the baseline, and a file the baseline does not know (a new one) may carry none. A finding
// is fixed, or let off with a `biome-ignore` comment saying why, never in one mass rewrite. A host without the pinned
// binary (bun install has not run here) skips the step with what installs it, as the secrets step does for gitleaks.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = join(import.meta.dir, '..', '..')

/** where the pinned binary lives, installed by the dependencies step (10-dependencies) */
export const BIOME_BIN = ['node_modules', '.bin', 'biome']

/** one finding of the linter: the file it is in and the rule that found it */
export type Diagnostic = { file: string; rule: string }

/** how many findings of each rule a file carries: file -> rule -> count */
export type Counts = Record<string, Record<string, number>>

/** what the baseline keeps: the counts of the default branch, and the commit they were recorded at */
export type Baseline = { commit: string; at: number; files: Counts }

/** one run of a command: its output and its exit code */
export type Run = { stdout: string; stderr: string; exitCode: number }

/** how a run is made: injected by the tests, so a fixture needs no binary */
export type Spawn = (cmd: string[], cwd: string) => Run

/** the real run: the binary's stdout and stderr as text, never thrown away */
export function spawnRun(cmd: string[], cwd: string): Run {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.exitCode ?? 1 }
}

/** the binary this tree installed, or null when bun install has not run here yet */
export function biomeBin(repo: string): string | null {
  const bin = join(repo, ...BIOME_BIN)
  return existsSync(bin) ? bin : null
}

/** why the binary that is there cannot run here (the wrapper needs node, the platform's package may be missing), or null */
export function probeBiome(bin: string, run: Spawn, root: string): string | null {
  const v = run([bin, '--version'], root)
  return v.exitCode === 0 ? null : v.stderr.trim() || `it exited ${v.exitCode}`
}

/** the findings of a `--reporter=json` report (lint or format), or null when the text is not one (a config error) */
export function parseDiagnostics(text: string): Diagnostic[] | null {
  try {
    const v = JSON.parse(text) as { diagnostics?: unknown }
    if (!Array.isArray(v?.diagnostics)) return null
    const out: Diagnostic[] = []
    for (const d of v.diagnostics as Array<{ category?: unknown; location?: { path?: unknown } }>) {
      const file = d?.location?.path
      const rule = d?.category
      if (typeof file === 'string' && typeof rule === 'string') out.push({ file, rule })
    }
    return out
  } catch {
    return null
  }
}

/** how many findings of each rule each file carries */
export function count(diagnostics: Diagnostic[]): Counts {
  const out: Counts = {}
  for (const d of diagnostics) {
    if (!out[d.file]) out[d.file] = {}
    const rules = out[d.file]
    rules[d.rule] = (rules[d.rule] ?? 0) + 1
  }
  return out
}

/** a count with its noun in the right number, for the notes: "1 finding", "3 rules" */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** the rules the tree carries, for the step's note */
export function rulesOf(now: Counts): number {
  const rules = new Set<string>()
  for (const counts of Object.values(now)) for (const rule of Object.keys(counts)) rules.add(rule)
  return rules.size
}

/** what grew since the baseline: a line per file and rule, sorted, naming the counts; empty when the ratchet held */
export function compare(now: Counts, base: Counts): string[] {
  const out: string[] = []
  for (const file of Object.keys(now).sort()) {
    const isNew = !(file in base)
    const was = base[file] ?? {}
    for (const rule of Object.keys(now[file]).sort()) {
      const n = now[file][rule]
      const before = was[rule] ?? 0
      if (n <= before) continue
      out.push(isNew ? `${file}: ${rule} ${n} (a file the baseline does not know)` : `${file}: ${rule} ${n} (${before} at the baseline)`)
    }
  }
  return out
}

const git = (repo: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
  return r.success ? r.stdout.toString() : null
}

/** where the baseline is kept: the repo's own .git, shared by all its worktrees (coverage.ts's pattern) */
export function baselineFile(repo = root): string {
  const common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')?.trim()
  return join(common || join(repo, 'node_modules', '.cache'), 'shepherdr-lint', 'baseline.json')
}

export function readBaseline(file: string): Baseline | null {
  try {
    const b = JSON.parse(readFileSync(file, 'utf8')) as Baseline
    return b.commit && b.files ? b : null
  } catch {
    return null
  }
}

export function recordBaseline(file: string, files: Counts, commit: string): void {
  mkdirSync(dirname(file), { recursive: true })
  // written beside then moved over it: a reader (another worktree's check) sees the old baseline or the new, never half
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ commit, at: Date.now(), files } satisfies Baseline))
  renameSync(tmp, file)
}

export type Options = {
  root: string
  /** the biome binary; the default is this tree's node_modules/.bin/biome, null when there is none */
  bin?: string | null
  run?: Spawn
  /** where the baseline lives; the default is this repo's .git */
  baseline?: string
  /** the default branch's check keeps the counts of the tree it read as the baseline */
  record?: boolean
  log?: (line: string) => void
  note?: (line: string) => void
  skip?: (line: string) => void
}

/** the step: 0 when no file carries a finding its baseline does not have, 1 when one does (or biome cannot run) */
export function runLint(o: Options): number {
  const log = o.log ?? (() => {})
  const note = o.note ?? (() => {})
  const skip = o.skip ?? (() => {})
  const bin = o.bin === undefined ? biomeBin(o.root) : o.bin
  if (!bin) {
    const why = 'biome is not installed here: run bun install (it is pinned as @biomejs/biome)'
    log(why)
    note('lint: skipped, biome is missing')
    skip(why)
    return 0
  }
  const run = o.run ?? spawnRun
  const broken = probeBiome(bin, run, o.root)
  if (broken) {
    const why = `biome cannot run here (${broken}): run bun install, or fix what it needs on this host`
    log(why)
    note('lint: skipped, biome cannot run here')
    skip(why)
    return 0
  }
  const result = run([bin, 'lint', '--reporter=json', '--max-diagnostics=none'], o.root)
  const diagnostics = parseDiagnostics(result.stdout)
  if (!diagnostics) {
    log(`biome lint could not run: ${result.stderr.trim() || `it exited ${result.exitCode} with no report`}`)
    return 1
  }
  const now = count(diagnostics)
  const files = Object.keys(now).length
  const file = o.baseline ?? baselineFile(o.root)
  const base = readBaseline(file)
  const grew = base ? compare(now, base.files) : []
  if (!base) log('No lint baseline yet: the default branch records one, and from then no file may carry more findings of a rule than it does there.')
  if (o.record) {
    const dirty = git(o.root, 'status', '--porcelain')?.trim()
    const commit = dirty ? '' : (git(o.root, 'rev-parse', 'HEAD')?.trim() ?? '')
    if (grew.length) log('No lint baseline recorded: findings grew since the last one, whatever the branch.')
    else if (dirty) log('No lint baseline recorded: the tree holds what is not committed.')
    else if (!commit) log('No lint baseline recorded: the tree is not a git repository.')
    else {
      recordBaseline(file, now, commit)
      log(`Lint baseline recorded at ${commit.slice(0, 7)}: ${plural(diagnostics.length, 'finding', 'findings')} of ${plural(rulesOf(now), 'rule', 'rules')} in ${plural(files, 'file', 'files')}.`)
    }
  }
  for (const line of grew) log(line)
  const at = base ? ` since ${base.commit.slice(0, 7)}` : ''
  const found = `lint: ${plural(diagnostics.length, 'finding', 'findings')} of ${plural(rulesOf(now), 'rule', 'rules')} in ${plural(files, 'file', 'files')}`
  if (grew.length) {
    log(`lint: ${plural(grew.length, 'finding', 'findings')} more than at the baseline: fix each, or let it off with a biome-ignore comment saying why.`)
    note(`lint: ${grew.length} grew${at}`)
    return 1
  }
  note(base ? `${found}; none grew${at}` : `${found}; no baseline to hold it against yet`)
  return 0
}

/** the runner's environment, gathered in one place so a test can drive the same entry point */
export function main(env: Record<string, string | undefined> = process.env, o: Partial<Options> = {}): number {
  const dir = env.SHEPHERDR_CHECK_ROOT ?? root
  const write = (file: string | undefined, text: string) => {
    if (file) writeFileSync(file, `${text}\n`)
  }
  return runLint({
    root: dir,
    record: env.SHEPHERDR_CHECK_RECORD === '1',
    log: (line) => console.log(line),
    note: (line) => write(env.SHEPHERDR_CHECK_NOTE, line),
    skip: (line) => write(env.SHEPHERDR_CHECK_SKIP, line),
    ...o,
  })
}

// coverage-exempt: the runner executes this entry point, and --record is its flag; the tests drive runLint() and main()
if (import.meta.main) process.exit(main(process.env, { record: process.argv.includes('--record') }))
