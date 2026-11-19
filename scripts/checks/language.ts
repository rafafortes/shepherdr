// Check after types (audit 2026-11-18, QG-09): the fork's standing rule is English in every file; nothing flagged a
// Portuguese sentence committed into code, leaving reviewers to notice by hand. This scans the files the diff from the
// default branch touches (or the whole tree on the weekly run, SHEPHERDR_LANGUAGE_SCOPE=tree) for prose-like runs of
// foreign letters and fails with the file and line. Typography (em dash, curly quotes, ellipsis, arrows, emoji) is not
// a letter and is never flagged. The explicit allowlist covers test fixtures that exercise another language on
// purpose, emoji keyword data, and a `language-allow: <why>` marker for a quoted source or a user-facing UI string.
// The runner discovers the executable shim scripts/checks/21-language; the logic and its fixture tests live here.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export type Options = {
  root: string
  /** the whole tree instead of the diff (the weekly run sets SHEPHERDR_LANGUAGE_SCOPE=tree) */
  all?: boolean
  /** git in <root>, returning stdout; injected by the tests so a fixture needs no real history */
  git?: (...args: string[]) => string
  log?: (line: string) => void
  note?: (line: string) => void
}

/** code files are checked; .md is prose by nature and shell/CLI data files are checked too where they hold prose */
export const CODE = /\.(ts|tsx|js|jsx|sh|pl)$/

/** files where another language is the point, not an accident: test fixtures and the emoji keyword table */
export const ALLOW = [/^test\//, /^plugins\/reactions\/emoji-data\.ts$/]

const WORD = /[\p{L}\p{N}]+/gu
const NON_ASCII = /[^\x00-\x7F]/
const isForeignLetter = (c: string) => NON_ASCII.test(c) && /[\p{L}\p{N}]/u.test(c)

/** words in a line that carry a non-ASCII letter (a Latin accent, Cyrillic, CJK…), i.e. foreign prose, not typography */
export function foreignWords(line: string): string[] {
  const out: string[] = []
  for (const m of line.matchAll(WORD)) if ([...m[0]].some(isForeignLetter)) out.push(m[0])
  return out
}

/** a line is allowed by a path in ALLOW, a marker on the line, or a file-level marker near the top */
export function allowed(file: string, line: string, fileHead = ''): boolean {
  if (ALLOW.some((r) => r.test(file))) return true
  if (/language-allow:/.test(line)) return true
  return /language-allow:/.test(fileHead)
}

/** the default git: stdout of a git call in <root>, or '' when it fails (no repo, no such ref) */
export function gitIn(root: string): (...args: string[]) => string {
  return (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    return r.success ? r.stdout.toString() : ''
  }
}

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean)

/** code files the diff touches: commits since the default branch plus untracked files; null when there is no base */
export function changedFiles(git: (...args: string[]) => string): string[] | null {
  const base = ['origin/HEAD', 'origin/main', 'main'].find((b) => git('rev-parse', '--verify', '--quiet', `${b}^{commit}`))
  if (!base) return null
  const onto = git('merge-base', 'HEAD', base).trim()
  if (!onto) return null
  return [...new Set([...lines(git('diff', '--name-only', onto)), ...lines(git('ls-files', '--others', '--exclude-standard'))])]
}

/** every code file under <root>, skipping the folders that hold libraries and build output */
export function allCodeFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const n of readdirSync(dir).sort()) {
      if (['node_modules', '.git', 'dist', '.releases', 'public'].includes(n)) continue
      const p = join(dir, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (CODE.test(n)) out.push(p)
    }
  }
  walk(root)
  return out
}

/** scan the diff (or the whole tree) in <root>: 0 on clean prose, non-zero naming each file and line */
export function runLanguage(o: Options): number {
  const git = o.git ?? gitIn(o.root)
  const names = o.all ? allCodeFiles(o.root) : changedFiles(git)
  const wholeTree = names === null
  const files = (names ?? allCodeFiles(o.root)).map((f) => (f.startsWith(o.root) ? f : join(o.root, f)))
  let scanned = 0
  let bad = 0
  for (const file of files) {
    const rel = relative(o.root, file)
    if (!CODE.test(rel) || !existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const head = text.split('\n').slice(0, 5).join('\n')
    text.split('\n').forEach((line, i) => {
      scanned++
      if (allowed(rel, line, head)) return
      const words = foreignWords(line)
      if (words.length) {
        o.log?.(`${rel}:${i + 1}: non-English prose: ${words.join(', ')}`)
        bad++
      }
    })
  }
  if (bad) {
    o.log?.(`language: ${bad} line${bad === 1 ? '' : 's'} with foreign prose`)
    return 1
  }
  o.note?.(`language: ${scanned} lines scanned${wholeTree ? ' (whole tree: no default branch to diff)' : o.all ? ' (whole tree)' : ''}`)
  return 0
}

/** the runner's environment, gathered in one place so a test can drive the same entry point */
export function main(env: Record<string, string | undefined> = process.env): number {
  const root = env.SHEPHERDR_CHECK_ROOT ?? join(import.meta.dir, '..', '..')
  const write = (file: string | undefined, text: string) => {
    if (file) writeFileSync(file, `${text}\n`)
  }
  return runLanguage({
    root,
    all: env.SHEPHERDR_LANGUAGE_SCOPE === 'tree',
    log: (line) => console.log(line),
    note: (line) => write(env.SHEPHERDR_CHECK_NOTE, line),
  })
}

// coverage-exempt: the runner executes this entry point; the tests drive main() and runLanguage() directly
if (import.meta.main) process.exit(main())
