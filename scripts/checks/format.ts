// Check after the lint one (audit 2026-11-18, QG-02): the formatter, checked only for the code files the diff from the
// default branch touches, so an old file is formatted when it is next edited and a whole-tree reformat never lands in
// one pull request. A file the branch added is checked as well: a new file comes in formatted. Nothing is ever written
// here — `biome format --check` only reports — and the weekly run on the default branch has no diff, so it checks
// nothing and stays green. A host without the pinned binary skips the step with what installs it, as the lint step does.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { changedFiles, gitIn } from './language.ts'
import { biomeBin, parseDiagnostics, plural, probeBiome, type Spawn, spawnRun } from './lint.ts'

/** the files the formatter owns: the JS and TS of the tree, never markdown, JSON or the images and fonts beside them */
export const FORMATTED = /\.(ts|tsx|js|jsx)$/

export type Options = {
  root: string
  /** git in <root>, returning stdout; injected by the tests so a fixture needs no real history */
  git?: (...args: string[]) => string
  /** the biome binary; the default is this tree's node_modules/.bin/biome, null when there is none */
  bin?: string | null
  run?: Spawn
  log?: (line: string) => void
  note?: (line: string) => void
  skip?: (line: string) => void
}

/** the code files of a diff that exist in the tree, in the diff's order */
export function filesToFormat(root: string, changed: string[]): string[] {
  return changed.filter((f) => FORMATTED.test(f) && existsSync(join(root, f)))
}

/** the step: 0 when every code file the diff touches is formatted (or there is none), 1 when one is not */
export function runFormat(o: Options): number {
  const log = o.log ?? (() => {})
  const note = o.note ?? (() => {})
  const skip = o.skip ?? (() => {})
  const bin = o.bin === undefined ? biomeBin(o.root) : o.bin
  if (!bin) {
    const why = 'biome is not installed here: run bun install (it is pinned as @biomejs/biome)'
    log(why)
    note('format: skipped, biome is missing')
    skip(why)
    return 0
  }
  const run = o.run ?? spawnRun
  const broken = probeBiome(bin, run, o.root)
  if (broken) {
    const why = `biome cannot run here (${broken}): run bun install, or fix what it needs on this host`
    log(why)
    note('format: skipped, biome cannot run here')
    skip(why)
    return 0
  }
  const changed = changedFiles(o.git ?? gitIn(o.root))
  if (changed === null) {
    log('No default branch to diff against: nothing to format here.')
    note('format: nothing checked (no default branch to diff)')
    return 0
  }
  const files = filesToFormat(o.root, changed)
  if (!files.length) {
    note('format: no code file of the diff to format')
    return 0
  }
  // `biome format` without --write is the check: it only reports what it would rewrite
  const result = run([bin, 'format', '--reporter=json', '--max-diagnostics=none', ...files], o.root)
  const diagnostics = parseDiagnostics(result.stdout)
  if (!diagnostics) {
    log(`biome format could not run: ${result.stderr.trim() || `it exited ${result.exitCode} with no report`}`)
    return 1
  }
  const unformatted = [...new Set(diagnostics.map((d) => d.file))].sort()
  if (unformatted.length) {
    for (const file of unformatted) log(`${file}: not formatted`)
    log(
      `format: ${plural(unformatted.length, 'code file', 'code files')} the diff touches ${unformatted.length === 1 ? 'is' : 'are'} not formatted: run bunx biome format --write on ${unformatted.length === 1 ? 'it' : 'them'}.`,
    )
    note(`format: ${unformatted.length} of ${files.length} not formatted`)
    return 1
  }
  note(`format: ${plural(files.length, 'code file', 'code files')} the diff touches, all formatted`)
  return 0
}

/** the runner's environment, gathered in one place so a test can drive the same entry point */
export function main(env: Record<string, string | undefined> = process.env, o: Partial<Options> = {}): number {
  const dir = env.SHEPHERDR_CHECK_ROOT ?? join(import.meta.dir, '..', '..')
  const write = (file: string | undefined, text: string) => {
    if (file) writeFileSync(file, `${text}\n`)
  }
  return runFormat({
    root: dir,
    log: (line) => console.log(line),
    note: (line) => write(env.SHEPHERDR_CHECK_NOTE, line),
    skip: (line) => write(env.SHEPHERDR_CHECK_SKIP, line),
    ...o,
  })
}

// coverage-exempt: the runner executes this entry point; the tests drive runFormat() and main() directly
if (import.meta.main) process.exit(main())
