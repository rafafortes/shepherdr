// Check 2 of the gate, after dependencies: scan the committed tree and its history for secrets (audit 2026-11-18,
// QG-06). The runner discovers the executable shim scripts/checks/15-secrets; the logic and its fixture tests live
// here. gitleaks reads .gitleaksignore at the repo root, where findings that predate the check are baselined with the
// reason each one is a fake token in a test. A new finding fails the step and names its file and rule, never its
// value (--redact). On a host without gitleaks the step skips with the install command, like a browser that cannot
// start, so the verdict still says which part did not run. gitleaks detect reads commits, not uncommitted files, so
// commit before the gate: a key left only in the working tree is picked up by the next run once it is committed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** the note a host without gitleaks gets: how to install it, never a red failure */
export const INSTALL = 'gitleaks is not installed; install it in ~/.local/bin (https://github.com/gitleaks/gitleaks#installation)'

/** one line of gitleaks' JSON report */
export type Finding = { File: string; RuleID: string; StartLine: number; Fingerprint: string }

/** a repo to scan, a place for the report outside it, and the binary (null when it is missing) */
export type Options = {
  root: string
  logs: string
  /** where the report goes; default <logs>/gitleaks.json, and the run's own log name when the runner names one */
  report?: string
  binary: string | null
  log?: (line: string) => void
  note?: (line: string) => void
  skip?: (reason: string) => void
}

/** scan <root> and its history: 0 on a clean tree or a skip, non-zero on a finding. The report is always redacted. */
export function runSecrets(o: Options): number {
  if (!o.binary) {
    o.skip?.(INSTALL)
    o.log?.(INSTALL)
    return 0
  }
  const report = o.report ?? join(o.logs, 'gitleaks.json')
  mkdirSync(o.logs, { recursive: true })
  const r = Bun.spawnSync(
    [o.binary, 'detect', '--source', '.', '--redact', '--report-path', report, '--report-format', 'json', '--no-banner'],
    { cwd: o.root, stdout: 'pipe', stderr: 'pipe' },
  )
  if (r.exitCode === 0) {
    o.note?.('no secrets found in the committed tree or its history')
    return 0
  }
  if (r.exitCode !== 1) {
    o.log?.(`gitleaks could not scan: ${r.stderr.toString().trim() || `exit ${r.exitCode}`}`)
    return r.exitCode ?? 1
  }
  let findings: Finding[] = []
  try {
    findings = JSON.parse(readFileSync(report, 'utf8')) as Finding[]
  } catch {
    o.log?.('gitleaks found secrets but its report could not be read')
    return 1
  }
  for (const f of findings) o.log?.(`${f.File}:${f.StartLine} · rule ${f.RuleID}`)
  o.log?.(`${findings.length} secret${findings.length === 1 ? '' : 's'} found (fingerprints: ${findings.map((f) => f.Fingerprint).join(', ')})`)
  return 1
}

/** the runner's environment, gathered in one place so a test can drive the same entry point */
export function main(env: Record<string, string | undefined> = process.env): number {
  const root = env.SHEPHERDR_CHECK_ROOT ?? join(import.meta.dir, '..', '..')
  const logs = env.SHEPHERDR_CHECK_LOGS ?? join(root, 'node_modules', '.cache', 'secrets')
  // the report takes the name of this run's own log: a --quick run can run beside a full run of the same worktree, and
  // neither may overwrite the other's report (SHE-172)
  const report = env.SHEPHERDR_CHECK_LOG ? `${env.SHEPHERDR_CHECK_LOG}.json` : undefined
  const write = (file: string | undefined, text: string) => {
    if (file) writeFileSync(file, `${text}\n`)
  }
  return runSecrets({
    root,
    logs,
    report,
    binary: Bun.which('gitleaks') ?? null,
    log: (line) => console.log(line),
    note: (line) => write(env.SHEPHERDR_CHECK_NOTE, line),
    skip: (reason) => write(env.SHEPHERDR_CHECK_SKIP, reason),
  })
}

// coverage-exempt: the runner executes this entry point; the tests drive main() and runSecrets() directly
if (import.meta.main) process.exit(main())
