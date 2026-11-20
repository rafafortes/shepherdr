// Check after secrets (audit 2026-11-18, QG-07): shellcheck -S warning over the shell files the gate, its own check
// shims and the agent commands run, and perl -c over the helpers copied to other machines. A finding or a syntax error
// fails with its file and line; a host without one of the tools skips just that part, naming it, rather than failing.
// perlcritic is deliberately not gated on: its opinionated style rules would make this about taste, not breakage.
// The runner discovers the executable shim scripts/checks/17-scripts; the logic and its fixture tests live here.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/** the files under <root> this check reads, relative to it: the gate's shell, its own check shims (a shell typo in one
 *  of them breaks the whole gate), the agent commands and the Perl helpers */
function files(root: string) {
  // a regular file, not a dotfile: what a shell glob and the runner's own discovery see
  const listed = (dir: string, want: (name: string) => boolean) =>
    existsSync(join(root, dir))
      ? readdirSync(join(root, dir), { withFileTypes: true })
          .filter((e) => e.isFile() && !e.name.startsWith('.') && want(e.name))
          .map((e) => e.name)
          .sort()
          .map((n) => `${dir}/${n}`)
      : []
  const present = (names: string[]) => names.filter((n) => existsSync(join(root, n)))
  /** whether a check's first line names a shell: the runner runs any executable check, so only shell shims are linted.
   *  Anchored on the interpreter, so a shebang that merely contains "sh" is no shell; one that cannot be read is handed
   *  to shellcheck, which fails the step naming it instead of crashing here. */
  const shellScript = (file: string) => {
    let first: string
    try {
      first = readFileSync(join(root, file), 'utf8').split('\n', 1)[0] ?? ''
    } catch {
      return true
    }
    return /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:ba|da|k)?sh\b/.test(first)
  }
  const shell = [
    ...listed('scripts', (n) => n.endsWith('.sh')),
    ...present(['bin/shepherdr', 'bin/agent-browser', 'helper/agent-browser']),
    // the gate's own checks, with the runner's discovery rule (a regular file, no dotfile, not a .ts module) and a
    // shell shebang: a check written in another language is that language's to lint
    ...listed('scripts/checks', (n) => !n.endsWith('.ts') && shellScript(`scripts/checks/${n}`)),
  ]
  const perl = listed('helper', (n) => n.endsWith('.pl') || n === 'shepherdr')
  return { shell, perl }
}

/** lint <root>: 0 on a clean tree or a missing tool, non-zero on a shellcheck finding or a perl syntax error */
export function runScripts(o: Options): number {
  const found = files(o.root)
  const notes: string[] = []
  const missing: string[] = []
  let failed = 0
  if (o.shellcheck) {
    if (!found.shell.length) notes.push('shellcheck: no shell files to lint')
    else {
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
        if (r.exitCode === 1) {
          // 1 is "findings": anything else (2: a file it could not read, a bad invocation) is not a lint result
          const findings = lines.filter((l) => /:\d+:\d+: (warning|error): /.test(l)).length
          o.log?.(`shellcheck: ${findings} finding${findings === 1 ? '' : 's'} in ${found.shell.length} shell files`)
        } else o.log?.(`shellcheck did not finish a lint pass: exit ${r.exitCode}`)
      }
    }
  } else missing.push(NO_SHELLCHECK)
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
    } else notes.push(found.perl.length ? `perl -c: ${found.perl.length} helpers syntax OK` : 'perl -c: no Perl files to check')
  } else missing.push(NO_PERL)
  if (notes.length) o.note?.(notes.join(' · '))
  if (missing.length) {
    // one line for what did not run, at the end of the log where a failure's tail shows it
    const line = missing.join(' · ')
    o.log?.(`not checked here: ${line}`)
    o.skip?.(line)
  }
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
