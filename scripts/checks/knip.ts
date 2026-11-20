// Check after the format one (audit 2026-11-18, QG-03): knip finds code nothing uses — unused exports, whole dead files,
// dependencies package.json no longer imports and binaries nothing declares. The baseline is knip.json's documented
// ignore lists plus a @knip-baseline tag on each export the first pass named; any NEW unused code makes knip exit 1.
// Knip is TS-native (no separate type collection) and takes seconds here. The step runs `knip --reporter compact` and
// passes its exit code through; a host without the pinned binary is a named skip, as the lint and audit steps do.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')

/** where the pinned binary lives, installed by the dependencies step (10-dependencies) */
export const KNIP_BIN = ['node_modules', '.bin', 'knip']

/** one run of a command: its output and its exit code */
export type Run = { stdout: string; stderr: string; exitCode: number }

/** how a run is made: injected by the tests, so a fixture needs no installed binary */
export type Spawn = (cmd: string[], cwd: string) => Run

/** the real run: the binary's stdout and stderr as text, never thrown away */
export function spawnRun(cmd: string[], cwd: string): Run {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.exitCode ?? 1 }
}

/** the binary this tree installed, or null when bun install has not run here yet */
export function knipBin(repo: string): string | null {
  const bin = join(repo, ...KNIP_BIN)
  return existsSync(bin) ? bin : null
}

/** why the binary that is there cannot run here (a wrapper whose runtime is missing), or null */
export function probeKnip(bin: string, run: Spawn, root: string): string | null {
  const v = run([bin, '--version'], root)
  return v.exitCode === 0 ? null : v.stderr.trim() || `it exited ${v.exitCode}`
}

/** the findings in a compact report: each issue type prints "file: name, name" lines under its header */
export function countFindings(stdout: string): number {
  let n = 0
  for (const line of stdout.split('\n')) {
    const i = line.indexOf(': ')
    if (i < 1) continue
    for (const name of line.slice(i + 2).split(',')) if (name.trim()) n++
  }
  return n
}

export type Options = {
  root: string
  /** the knip binary; the default is this tree's node_modules/.bin/knip, null when there is none */
  bin?: string | null
  run?: Spawn
  log?: (line: string) => void
  note?: (line: string) => void
  skip?: (line: string) => void
}

/** the step: 0 when knip finds nothing new (or it is missing), 1 on any finding in its compact report */
export function runKnip(o: Options): number {
  const log = o.log ?? (() => {})
  const note = o.note ?? (() => {})
  const skip = o.skip ?? (() => {})
  const bin = o.bin === undefined ? knipBin(o.root) : o.bin
  if (!bin) {
    const why = 'knip is not installed here: run bun install (it is pinned as knip)'
    log(why)
    note('knip: skipped, knip is missing')
    skip(why)
    return 0
  }
  const run = o.run ?? spawnRun
  const broken = probeKnip(bin, run, o.root)
  if (broken) {
    const why = `knip cannot run here (${broken}): run bun install, or fix what it needs on this host`
    log(why)
    note('knip: skipped, knip cannot run here')
    skip(why)
    return 0
  }
  const result = run([bin, '--reporter', 'compact', '--no-config-hints'], o.root)
  if (result.exitCode !== 0) {
    const said = `${result.stdout}${result.stderr}`.trim()
    log(said || 'knip reported unused code but said nothing')
    note(`knip: ${countFindings(result.stdout)} unused — fix each, or baseline it with a reason in knip.json`)
    return 1
  }
  note('knip: no unused code · baseline in knip.json')
  return 0
}

/** the runner's environment, gathered in one place so a test can drive the same entry point */
export function main(env: Record<string, string | undefined> = process.env, o: Partial<Options> = {}): number {
  const dir = env.SHEPHERDR_CHECK_ROOT ?? root
  const write = (file: string | undefined, text: string) => {
    if (file) writeFileSync(file, `${text}\n`)
  }
  return runKnip({
    root: dir,
    log: (line) => console.log(line),
    note: (line) => write(env.SHEPHERDR_CHECK_NOTE, line),
    skip: (line) => write(env.SHEPHERDR_CHECK_SKIP, line),
    ...o,
  })
}

// coverage-exempt: the runner executes this entry point; the tests drive runKnip() and main() directly
if (import.meta.main) process.exit(main())
