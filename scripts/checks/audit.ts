// Check 2 of the gate, after dependencies and before types: audit the locked tree (audit 2026-11-18, QG-05).
// The runner discovers the executable shim scripts/checks/12-audit; the logic and its fixture tests live here.
//
// `bun audit --json` reads bun.lock (no node_modules needed) and prints the npm advisory report as a flat map of
// package name -> advisories. Bun's own command keeps the toolset at one runtime; osv-scanner was rejected because it
// needs a pinned external binary and its own toml ignores. Advisory ids already accepted are kept in the repo's .git
// (coverage.ts's baselineFile pattern, recorded on the default branch): a NEW id fails the step with its package and
// fix hint, a known one is only a comment. Licences come from each locked package's installed package.json (bun.lock
// carries no licence field) and must be on the allowlist below. A registry that cannot be reached is a note, never a
// red step: offline work must not be blocked by a gate that needs the network.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = join(import.meta.dir, '..', '..')

/** one advisory in `bun audit --json` (the npm bulk report: package -> advisories) */
export type Advisory = { id?: number | string; url?: string; title?: string; severity?: string; vulnerable_versions?: string }
export type Report = Record<string, Advisory[]>
export type AuditResult = { stdout: string; exitCode: number; stderr: string }
export type Spawn = (args: string[], opts: { cwd: string; stdout: 'pipe'; stderr: 'pipe' }) => { stdout?: unknown; stderr?: unknown; exitCode?: number | null }
/** advisory ids the default branch has accepted, with the commit that recorded them */
export type Baseline = { commit: string; at: number; ids: string[] }
/** one advisory flattened out of the report, with the package it belongs to */
export type Found = { pkg: string; id: string; advisory: Advisory }

/** permissive licences allowed in the tree. MPL-2.0 (web-push, lightningcss) and OFL-1.1 (the Inter font) are in
 *  the current lockfile: the shorter list in the finding would leave a clean herdr-tui red. Both are permissive —
 *  MPL is file-level copyleft, OFL covers fonts. Anything else, an unknown licence included, fails the step. */
export const ALLOWED = ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unlicense', 'Python-2.0', 'MPL-2.0', 'OFL-1.1']

/** the id bun audit gives an advisory: its numeric id, or the GHSA in its link when there is no id */
export function advisoryId(a: Advisory): string {
  if (a.id !== undefined) return String(a.id)
  return a.url?.match(/GHSA-[a-z0-9-]+/i)?.[0] ?? 'unknown'
}

/** a parsed report, or null when bun did not answer with advisories (offline or a broken registry) */
export function parseAudit(text: string): Report | null {
  try {
    const v: unknown = JSON.parse(text)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const report = v as Report
    // a proxy's error object is also JSON, but it is not package -> advisories; treat it as no answer
    for (const list of Object.values(report)) if (!Array.isArray(list)) return null
    return report
  } catch {
    return null
  }
}

/** the report's advisories, one flat row each */
export function found(report: Report): Found[] {
  const out: Found[] = []
  for (const [pkg, list] of Object.entries(report)) for (const advisory of list ?? []) out.push({ pkg, id: advisoryId(advisory), advisory })
  return out
}

/** a readable line for one advisory, with the fix hint: the affected range and the advisory link */
export function describe(f: Found): string {
  const a = f.advisory
  return `${f.pkg} · advisory ${f.id}${a.severity ? ` (${a.severity})` : ''}${a.title ? `: ${a.title}` : ''} · affected ${a.vulnerable_versions ?? 'unknown'} · fix: ${a.url ?? 'see the npm advisory database'}`
}

/** new advisories fail; accepted ones are only a comment */
export function compare(report: Report, accepted: string[]): { fresh: string[]; known: string[] } {
  const fresh: string[] = []
  const known: string[] = []
  for (const f of found(report).sort((a, b) => a.pkg.localeCompare(b.pkg) || a.id.localeCompare(b.id))) {
    const line = describe(f)
    if (accepted.includes(f.id)) known.push(line)
    else fresh.push(line)
  }
  return { fresh, known }
}

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return r.success ? r.stdout.toString() : null
}

/** where the baseline is kept: the repo's own .git, shared by all its worktrees (coverage.ts's pattern) */
export function baselineFile(repo = root): string {
  const common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')?.trim()
  return join(common || join(repo, 'node_modules', '.cache'), 'shepherdr-audit', 'accepted.json')
}

export function readBaseline(file: string): Baseline | null {
  try {
    const b = JSON.parse(readFileSync(file, 'utf8')) as Baseline
    return Array.isArray(b?.ids) ? b : null
  } catch {
    return null
  }
}

export function recordBaseline(file: string, ids: string[], commit: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ commit, at: Date.now(), ids } satisfies Baseline))
}

/** SPDX: a choice (OR) needs one allowed option, a conjunction (AND) needs them all; a bare id must be listed */
export function allows(license: string | undefined, allow: readonly string[] = ALLOWED): boolean {
  if (!license) return false
  const text = license.replace(/[()]/g, '').trim()
  if (/\s+OR\s+/i.test(text)) return text.split(/\s+OR\s+/i).some((x) => allows(x, allow))
  if (/\s+AND\s+/i.test(text)) return text.split(/\s+AND\s+/i).every((x) => allows(x, allow))
  return allow.includes(text)
}

/** a package.json's licence, as a string (some packages carry it as { type: ... }) */
export function licenseOf(text: string): string | undefined {
  try {
    const p = JSON.parse(text) as { license?: string | { type?: string } }
    return typeof p.license === 'string' ? p.license : p.license?.type
  } catch {
    return undefined
  }
}

/** the packages bun.lock pins (it is JSONC: trailing commas are allowed) */
export function packagesOf(text: string): string[] {
  const lock = Bun.JSONC.parse(text) as { packages?: Record<string, unknown> }
  return Object.keys(lock?.packages ?? {})
}

/** where a locked package may be installed: at the root, or nested under any of its parents (bun.lock names those
 *  nested packages with a slash in the key, e.g. `@tailwindcss/node/lightningcss`) */
export function installedPaths(root: string, name: string): string[] {
  const parts = name.split('/')
  const paths: string[] = []
  for (let i = 0; i < parts.length; i++) paths.push(join(root, 'node_modules', ...parts.slice(0, i), ...(i ? ['node_modules'] : []), ...parts.slice(i), 'package.json'))
  return paths
}

/** read each locked package's installed licence; a package for another platform is simply not installed here */
export function checkLicenses(root: string, packages: string[], read: (f: string) => string): { bad: string[]; checked: number; missing: number } {
  const bad: string[] = []
  let checked = 0
  let missing = 0
  for (const name of packages) {
    let license: string | undefined
    let installed = false
    for (const file of installedPaths(root, name)) {
      try {
        license = licenseOf(read(file))
        installed = true
        break
      } catch {
        /* try the next parent */
      }
    }
    if (!installed) {
      missing++
      continue
    }
    checked++
    if (!allows(license)) bad.push(`${name}: ${license ?? 'no licence declared'}`)
  }
  return { bad, checked, missing }
}

/** the one call to the real command; a test passes a stand-in spawn and never needs the registry */
export function bunAudit(root: string, spawn: Spawn = Bun.spawnSync as Spawn): AuditResult {
  const r = spawn(['bun', 'audit', '--json'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  return { stdout: String(r.stdout ?? ''), exitCode: r.exitCode ?? 1, stderr: String(r.stderr ?? '') }
}

export type Options = {
  root: string
  audit?: (root: string) => AuditResult
  baseline?: string
  record?: boolean
  log?: (line: string) => void
  note?: (line: string) => void
  skip?: (line: string) => void
}

/** the check: 0 when the tree is clean (or the registry is unreachable), 1 on a new advisory or a bad licence */
export function runAudit(o: Options): number {
  const log = o.log ?? (() => {})
  const note = o.note ?? (() => {})
  const skip = o.skip ?? (() => {})
  const result = (o.audit ?? bunAudit)(o.root)
  const report = parseAudit(result.stdout)
  let fresh: string[] = []
  let known: string[] = []
  let offline = false
  if (report === null) {
    offline = true
    log(`bun audit could not read advisories (offline or the registry is down): ${result.stderr.trim() || `exit ${result.exitCode}`}; advisories not checked`)
  } else {
    const file = o.baseline ?? baselineFile(o.root)
    const base = readBaseline(file)
    if (!base) log('No audit baseline yet: the check on the default branch records the advisory ids it accepts.')
    const c = compare(report, base?.ids ?? [])
    fresh = c.fresh
    known = c.known
    if (o.record) {
      const dirty = git(o.root, 'status', '--porcelain')?.trim()
      if (dirty) log('No audit baseline recorded: the tree holds what is not committed.')
      else {
        const commit = git(o.root, 'rev-parse', 'HEAD')?.trim() ?? ''
        const ids = found(report).map((f) => f.id)
        recordBaseline(file, ids, commit)
        log(`Audit baseline recorded at ${commit.slice(0, 7)}: ${ids.length} advisory id${ids.length === 1 ? '' : 's'} accepted.`)
        fresh = []
      }
    } else {
      for (const line of known) log(`accepted: ${line}`)
    }
  }
  let bad: string[] = []
  let checked = 0
  let missing = 0
  try {
    const lic = checkLicenses(o.root, packagesOf(readFileSync(join(o.root, 'bun.lock'), 'utf8')), (f) => readFileSync(f, 'utf8'))
    bad = lic.bad
    checked = lic.checked
    missing = lic.missing
  } catch {
    log('bun.lock could not be read: licences not checked')
    return 1
  }
  for (const line of bad) log(`licence not allowed: ${line}`)
  for (const line of fresh) log(`new advisory: ${line}`)
  const offlineReason = `bun audit could not reach the registry: advisories not checked; licences checked in ${checked} packages (${missing} not installed here)`
  note(offline
    ? offlineReason
    : `${fresh.length} new, ${known.length} accepted advisories; licences: ${checked} checked, ${missing} not installed here`)
  // the verdict names a part that did not run, as it does for a browser that could not start
  if (offline) skip(offlineReason)
  return fresh.length || bad.length ? 1 : 0
}

/** the runner's environment, gathered in one place so a test can drive the same entry point */
export function main(env: Record<string, string | undefined> = process.env, o: Partial<Options> = {}): number {
  const dir = env.SHEPHERDR_CHECK_ROOT ?? root
  const write = (file: string | undefined, text: string) => {
    if (file) writeFileSync(file, `${text}\n`)
  }
  return runAudit({
    root: dir,
    audit: bunAudit,
    record: env.SHEPHERDR_CHECK_RECORD === '1',
    log: (line) => console.log(line),
    note: (line) => write(env.SHEPHERDR_CHECK_NOTE, line),
    skip: (line) => write(env.SHEPHERDR_CHECK_SKIP, line),
    ...o,
  })
}

// coverage-exempt: the runner executes this entry point; the tests drive runAudit() and main() directly
if (import.meta.main) process.exit(main())
