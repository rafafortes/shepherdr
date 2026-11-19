// Check after secrets (audit 2026-11-18, QG-07): shellcheck -S warning over the shell files the gate and the agent
// commands run, and perl -c over the helpers copied to other machines. A warning or a syntax error fails with its
// file and line; a host without one of the tools skips just that part, naming it, rather than failing. perlcritic is
// deliberately not gated on: its opinionated style rules would make this about taste, not about breakage.
// The runner discovers the executable shim scripts/checks/17-scripts; the logic and its fixture tests live here.
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** the note a host without a tool gets: its name and how to install it, never a red failure */
export const NO_SHELLCHECK = 'shellcheck is not installed; install it (https://www.shellcheck.net/#install)'
export const NO_PERL = 'perl is not installed; install it with your package manager'

export type Options = {
  root: string
  shellcheck?: string | null
  perl?: string | null
  log?: (line: string) => void
  note?: (line: string) => void
  skip?: (reason: string) => void
}

/** the files under <root> this check reads, relative to it: the gate's shell, the agent commands, the Perl helpers */
function files(root: string) {
  const listed = (dir: string, want: (name: string) => boolean) =>
    existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter(want).sort().map((n) => `${dir}/${n}`) : []
  const shell = [...listed('scripts', (n) => n.endsWith('.sh')), ...['bin/shepherdr', 'bin/agent-browser'].filter((n) => existsSync(join(root, n)))]
  const perl = listed('helper', (n) => n.endsWith('.pl') || n === 'shepherdr')
  return { shell, perl }
}

/** lint <root>: 0 on a clean tree or a missing tool, non-zero on a shellcheck warning or a perl syntax error */
export function runScripts(o: Options): number {
  const found = files(o.root)
  const notes: string[] = []
  const missing: string[] = []
  let failed = 0
  if (o.shellcheck) {
    const r = Bun.spawnSync([o.shellcheck, '-S', 'warning', '-f', 'gcc', '--', ...found.shell.map((f) => join(o.root, f))], {
      cwd: o.root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const lines = `${r.stdout.toString()}${r.stderr.toString()}`.split('\n').filter(Boolean)
    if (r.exitCode === 0) notes.push(`shellcheck: ${found.shell.length} shell files clean`)
    else {
      failed = 1
      for (const line of lines) o.log?.(line)
      o.log?.(`shellcheck: ${lines.length} warning${lines.length === 1 ? '' : 's'} in ${found.shell.join(', ')}`)
    }
  } else {
    missing.push(NO_SHELLCHECK)
    o.log?.(NO_SHELLCHECK)
  }
  if (o.perl) {
    const bad: string[] = []
    for (const f of found.perl) {
      const r = Bun.spawnSync([o.perl, '-c', join(o.root, f)], { cwd: o.root, stdout: 'pipe', stderr: 'pipe' })
      if (r.exitCode !== 0) {
        bad.push(f)
        o.log?.(`${f}: ${r.stderr.toString().trim() || r.stdout.toString().trim() || `exit ${r.exitCode}`}`)
      }
    }
    if (bad.length) {
      failed = 1
      o.log?.(`perl -c: syntax errors in ${bad.join(', ')}`)
    } else notes.push(`perl -c: ${found.perl.length} helpers syntax OK`)
  } else {
    missing.push(NO_PERL)
    o.log?.(NO_PERL)
  }
  if (notes.length) o.note?.(notes.join(' · '))
  if (missing.length) o.skip?.(missing.join(' · '))
  return failed
}

/** the runner's environment, gathered in one place so a test can drive the same entry point */
export function main(env: Record<string, string | undefined> = process.env): number {
  const root = env.SHEPHERDR_CHECK_ROOT ?? join(import.meta.dir, '..', '..')
  const write = (file: string | undefined, text: string) => {
    if (file) writeFileSync(file, `${text}\n`)
  }
  return runScripts({
    root,
    shellcheck: Bun.which('shellcheck') ?? null,
    perl: Bun.which('perl') ?? null,
    log: (line) => console.log(line),
    note: (line) => write(env.SHEPHERDR_CHECK_NOTE, line),
    skip: (reason) => write(env.SHEPHERDR_CHECK_SKIP, reason),
  })
}

// coverage-exempt: the runner executes this entry point; the tests drive main() and runScripts() directly
if (import.meta.main) process.exit(main())
