// The language step (audit 2026-11-18, QG-09): a Portuguese sentence in a planted .ts file fails naming its line, while
// a test fixture, emoji data, a marker on the line and typography pass. Diff mode reads a fixture git repo; whole-tree
// mode needs no git. These drive the real module over fixture trees under /tmp, never this repo's own history.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { allCodeFiles, allowed, changedFiles, foreignWords, gitIn, main, runLanguage } from '../scripts/checks/language.ts'
import { tmp } from './tmp.ts'

const PT = 'const msg = "Este é um teste em português com acentuação."\n'

/** a fixture tree, optionally holding a Portuguese line in a given code file */
function tree(file?: string, body = PT) {
  const dir = tmp('checks-language')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'ok.ts'), 'export const ok = 1\n')
  writeFileSync(join(dir, 'README.md'), '# Fixture\n')
  if (file) {
    const path = join(dir, file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }
  return dir
}

/** a stub git: a base ref only when named, a merge base, and a diff of changed file names */
function stubGit(base: string | null, merged: string, changed: string[]) {
  return (...args: string[]) => {
    if (args[0] === 'rev-parse') return base && args.includes(`${base}^{commit}`) ? base : ''
    if (args[0] === 'merge-base') return merged
    if (args[0] === 'diff') return changed.join('\n')
    return ''
  }
}

/** a real git repo with one commit and uncommitted + untracked code files, for the default git function */
function gitRepo() {
  const dir = tmp('checks-language-repo')
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    return r.stdout.toString().trim()
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  writeFileSync(join(dir, 'src.ts'), 'const ok = 1\n')
  git('add', '-A')
  git('-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-qm', 'init')
  writeFileSync(join(dir, 'src.ts'), 'const ok = 2\n') // uncommitted change
  writeFileSync(join(dir, 'new.ts'), 'export const x = 1\n') // untracked
  writeFileSync(join(dir, 'notes.md'), 'Portuguese prose, not code\n')
  return { dir, git }
}

describe('foreign prose detection', () => {
  test('a Portuguese sentence and CJK are prose; English, em dash, curly quotes, ellipsis and emoji are not', () => {
    expect(foreignWords(PT)).toContain('português')
    expect(foreignWords(PT)).toContain('é')
    expect(foreignWords('你好世界')).toEqual(['你好世界'])
    expect(foreignWords('const ok = 1 // — “quoted” … → 👍 •')).toEqual([])
  })

  test('the allowlist: test fixtures, emoji data, a line marker and a file-head marker', () => {
    expect(allowed('test/dictate.test.ts', PT)).toBe(true)
    expect(allowed('plugins/reactions/emoji-data.ts', PT)).toBe(true)
    expect(allowed('src/a.ts', `${PT}// language-allow: quoted source (author name)\n`)).toBe(true)
    expect(allowed('src/a.ts', PT, '// language-allow: a user-facing string\n')).toBe(true)
    expect(allowed('src/a.ts', PT)).toBe(false)
  })
})

describe('the files a run reads', () => {
  test('allCodeFiles walks code files and skips libraries and markdown', () => {
    const dir = tree()
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dep', 'x.ts'), PT)
    const files = allCodeFiles(dir).map((f) => f.slice(dir.length + 1))
    expect(files).toContain('src/ok.ts')
    expect(files).not.toContain('README.md')
    expect(files).not.toContain('node_modules/dep/x.ts')
  })

  test('changedFiles uses the default git on a real repo: committed base, uncommitted and untracked files', () => {
    const { dir } = gitRepo()
    const changed = changedFiles(gitIn(dir))
    expect(changed).toContain('src.ts')
    expect(changed).toContain('new.ts')
    expect(changed).not.toContain('README.md')
    // changedFiles lists every touched name; runLanguage is what filters to code files (.md stays out there)
  })

  test('changedFiles is null when there is no base or no merge base', () => {
    expect(changedFiles(stubGit(null, 'abc', ['a.ts']))).toBeNull()
    expect(changedFiles(stubGit('main', '', ['a.ts']))).toBeNull()
    expect(changedFiles(stubGit('main', 'abc', ['a.ts', 'b.ts', 'a.ts']))).toEqual(['a.ts', 'b.ts'])
  })

  test('gitIn returns empty on a failing call', () => {
    const { dir } = gitRepo()
    expect(gitIn(dir)('rev-parse', '--verify', '--quiet', 'nope^{commit}')).toBe('')
  })
})

describe('the whole step', () => {
  test('a planted Portuguese sentence in a .ts file fails, naming the file and line', () => {
    const root = tree('src/bad.ts', `export const a = 1\n${PT}`)
    const lines: string[] = []
    expect(runLanguage({ root, all: true, log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('src/bad.ts:2: non-English prose:')
    expect(lines.join('\n')).toContain('português')
  })

  test('allowlisted fixtures and a marked line pass over the whole tree', () => {
    const root = tree()
    mkdirSync(join(root, 'test'), { recursive: true })
    writeFileSync(join(root, 'test', 'case.ts'), PT)
    mkdirSync(join(root, 'plugins', 'reactions'), { recursive: true })
    writeFileSync(join(root, 'plugins', 'reactions', 'emoji-data.ts'), PT)
    writeFileSync(join(root, 'src', 'quoted.ts'), `${PT}// language-allow: quoted source\n`)
    const notes: string[] = []
    expect(runLanguage({ root, all: true, note: (n) => notes.push(n) })).toBe(0)
    expect(notes.join('\n')).toContain('whole tree')
  })

  test('diff mode scans only the files the diff touches', () => {
    const root = tree('src/bad.ts')
    const lines: string[] = []
    const git = stubGit('main', 'abc', ['src/bad.ts'])
    expect(runLanguage({ root, git, log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('src/bad.ts:1:')
  })

  test('no base falls back to the whole tree and says so', () => {
    const root = tree()
    const notes: string[] = []
    expect(runLanguage({ root, git: stubGit(null, '', []), note: (n) => notes.push(n) })).toBe(0)
    expect(notes.join('\n')).toContain('no default branch to diff')
  })

  test('the runner entry point reads its environment, writes its note and fails on planted prose', () => {
    const clean = tree()
    const planted = tree('src/bad.ts')
    const note = join(clean, 'note.txt')
    expect(main({ SHEPHERDR_CHECK_ROOT: clean, SHEPHERDR_CHECK_NOTE: note, SHEPHERDR_LANGUAGE_SCOPE: 'tree' })).toBe(0)
    expect(readFileSync(note, 'utf8')).toContain('whole tree')
    expect(main({ SHEPHERDR_CHECK_ROOT: clean, SHEPHERDR_LANGUAGE_SCOPE: 'tree' })).toBe(0) // no note file
    expect(main({ SHEPHERDR_CHECK_ROOT: planted, SHEPHERDR_LANGUAGE_SCOPE: 'tree' })).toBe(1)
  })
})
