// The format step (audit 2026-11-18, QG-02): only the code files the diff from the default branch touches are checked,
// so an old file is formatted when it is next edited and a whole-tree reformat never lands in one pull request. The
// tests drive the selection with a stub git, then the real pinned biome over fixture trees: a touched file that is not
// formatted fails, an untouched one that is not formatted passes, and formatting the touched one makes it green.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { filesToFormat, main, runFormat } from '../scripts/checks/format.ts'
import { biomeBin } from '../scripts/checks/lint.ts'
import { tmp } from './tmp.ts'

const repo = join(import.meta.dir, '..')
const REAL = biomeBin(repo) ?? ''

/** a report as `biome format --reporter=json` prints it: a diagnostic per file it would rewrite */
const report = (...files: string[]) => JSON.stringify({ summary: {}, diagnostics: files.map((path) => ({ category: 'format', location: { path, start: { line: 1 } } })) })

/** a stub run, so no test but the real ones needs a binary: --version answers as the real one does */
const stub =
  (stdout: string, stderr = '', exitCode = 0) =>
  (cmd: string[]) =>
    cmd.includes('--version') ? { stdout: 'Version: 2.6.8', stderr: '', exitCode: 0 } : { stdout, stderr, exitCode }

/** a binary that is installed but cannot run here */
const broken = () => ({ stdout: '', stderr: 'node: not found', exitCode: 127 })

/** a stub git: a base ref only when named, a merge base, and a diff of changed file names (as the language tests do) */
function stubGit(base: string | null, merged: string, changed: string[]) {
  return (...args: string[]) => {
    if (args[0] === 'rev-parse') return base && args.includes(`${base}^{commit}`) ? base : ''
    if (args[0] === 'merge-base') return merged
    if (args[0] === 'diff') return changed.join('\n')
    return ''
  }
}

/** a fixture tree with the config the check reads, and the code files a test names */
function tree(files: Record<string, string>) {
  const dir = tmp('checks-format')
  writeFileSync(join(dir, 'biome.json'), readFileSync(join(repo, 'biome.json'), 'utf8'))
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  return dir
}

describe('the files a run checks', () => {
  test('the code files of the diff that exist in the tree; markdown, JSON and a file since removed stay out', () => {
    const dir = tree({ 'src/a.ts': 'export const a = 1\n', 'src/b.tsx': 'export const b = 1\n', 'src/gone.ts': 'export const g = 1\n' })
    expect(filesToFormat(dir, ['src/a.ts', 'src/b.tsx', 'docs/x.md', 'package.json', 'src/gone.ts'])).toEqual(['src/a.ts', 'src/b.tsx', 'src/gone.ts'])
    const missing = dir.replace(/[^/]+$/, 'not-there') // a diff of a file the tree no longer holds
    expect(filesToFormat(missing, ['src/a.ts'])).toEqual([])
  })
})

describe('the step', () => {
  test('a touched file the formatter would rewrite fails, naming it', () => {
    const dir = tree({ 'src/a.ts': 'export const a = 1\n' })
    const lines: string[] = []
    const notes: string[] = []
    const git = stubGit('main', 'abc', ['src/a.ts'])
    expect(runFormat({ root: dir, git, bin: 'biome', run: stub(report('src/a.ts')), log: (l) => lines.push(l), note: (n) => notes.push(n) })).toBe(1)
    expect(lines).toEqual(['src/a.ts: not formatted', 'format: 1 code file the diff touches is not formatted: run bunx biome format --write on it.'])
    expect(notes[0]).toBe('format: 1 of 1 not formatted')
  })

  test('two files say it in the plural', () => {
    const dir = tree({ 'src/a.ts': 'export const a = 1\n', 'src/b.ts': 'export const b = 1\n' })
    const lines: string[] = []
    const git = stubGit('main', 'abc', ['src/a.ts', 'src/b.ts'])
    expect(runFormat({ root: dir, git, bin: 'biome', run: stub(report('src/b.ts', 'src/a.ts')), log: (l) => lines.push(l), note: () => {} })).toBe(1)
    expect(lines.slice(0, 2)).toEqual(['src/a.ts: not formatted', 'src/b.ts: not formatted'])
    expect(lines[2]).toBe('format: 2 code files the diff touches are not formatted: run bunx biome format --write on them.')
  })

  test('nothing to format passes: a formatted diff, no code file in it, and no default branch to ask', () => {
    const dir = tree({ 'src/a.ts': 'export const a = 1\n', 'src/b.ts': 'export const b = 1\n' })
    const notes: string[] = []
    const lines: string[] = []
    const log = (l: string) => lines.push(l)
    const note = (n: string) => notes.push(n)
    expect(runFormat({ root: dir, git: stubGit('main', 'abc', ['src/a.ts']), bin: 'biome', run: stub(report()), log, note })).toBe(0)
    expect(notes[0]).toBe('format: 1 code file the diff touches, all formatted')
    expect(runFormat({ root: dir, git: stubGit('main', 'abc', ['src/a.ts', 'src/b.ts']), bin: 'biome', run: stub(report()), note })).toBe(0)
    expect(notes[1]).toBe('format: 2 code files the diff touches, all formatted')
    expect(runFormat({ root: dir, git: stubGit('main', 'abc', ['docs/x.md']), bin: 'biome', run: stub(report()), note })).toBe(0)
    expect(notes[2]).toBe('format: no code file of the diff to format')
    expect(runFormat({ root: dir, git: stubGit(null, '', []), bin: 'biome', run: stub(report()), log, note })).toBe(0)
    expect(notes[3]).toBe('format: nothing checked (no default branch to diff)')
    expect(lines.join('\n')).toContain('No default branch to diff against')
  })

  test('a host without the binary skips the step with what installs it, never a red failure', () => {
    const dir = tree({ 'src/a.ts': 'export const a = 1\n' })
    const notes: string[] = []
    const skips: string[] = []
    expect(runFormat({ root: dir, bin: null, note: (n) => notes.push(n), skip: (s) => skips.push(s) })).toBe(0)
    expect(notes[0]).toBe('format: skipped, biome is missing')
    expect(skips[0]).toContain('run bun install')
    // the default is this tree's own binary, and a fixture tree has none
    expect(runFormat({ root: dir, log: () => {}, note: () => {}, skip: () => {} })).toBe(0)
  })

  test('a binary that is there but cannot run here is a skip too, never a red failure', () => {
    const dir = tree({ 'src/a.ts': 'export const a = 1\n' })
    const notes: string[] = []
    const skips: string[] = []
    expect(runFormat({ root: dir, bin: 'biome', run: broken, note: (n) => notes.push(n), skip: (s) => skips.push(s) })).toBe(0)
    expect(notes[0]).toBe('format: skipped, biome cannot run here')
    expect(skips[0]).toContain('node: not found')
  })

  test('a biome that cannot produce a report fails with what it said', () => {
    const dir = tree({ 'src/a.ts': 'export const a = 1\n' })
    const git = stubGit('main', 'abc', ['src/a.ts'])
    const lines: string[] = []
    expect(runFormat({ root: dir, git, bin: 'biome', run: stub('{"error":"bad config"}', 'the config is broken', 1), log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('biome format could not run: the config is broken')
    const silent: string[] = []
    expect(runFormat({ root: dir, git, bin: 'biome', run: stub(''), log: (l) => silent.push(l) })).toBe(1)
    expect(silent.join('\n')).toContain('it exited 0 with no report')
  })

  test('the runner entry point reads its environment and writes its note and its skip', () => {
    const dir = tree({ 'src/a.ts': 'export const a = 1\n' })
    const note = join(dir, 'note.txt')
    const skip = join(dir, 'skip.txt')
    const git = stubGit('main', 'abc', ['src/a.ts'])
    const run = stub(report())
    expect(main({ SHEPHERDR_CHECK_ROOT: dir, SHEPHERDR_CHECK_NOTE: note }, { git, bin: 'biome', run })).toBe(0)
    expect(readFileSync(note, 'utf8')).toBe('format: 1 code file the diff touches, all formatted\n')
    expect(main({ SHEPHERDR_CHECK_ROOT: dir, SHEPHERDR_CHECK_SKIP: skip }, { git, bin: null })).toBe(0)
    expect(readFileSync(skip, 'utf8')).toContain('run bun install')
    // no environment at all: the default root is this repo, and the stub git keeps its real history out
    expect(main({}, { git: stubGit('main', 'abc', ['src/App.tsx']), bin: 'biome', run })).toBe(0)
    expect(main({}, { git: stubGit('main', 'abc', ['src/App.tsx']), bin: 'biome', run: stub('nope') })).toBe(1)
  })
})

describe.skipIf(!REAL)('the real biome', () => {
  test('a touched file that is not formatted fails and an untouched one that is not formatted passes', () => {
    // the semicolon is what the config removes: an unformatted file both times
    const dir = tree({ 'src/untouched.ts': 'export const old = 2;\n', 'src/touched.ts': 'export const touched = 1;\n' })
    const lines: string[] = []
    const git = stubGit('main', 'abc', ['src/touched.ts'])
    expect(runFormat({ root: dir, git, bin: REAL, log: (l) => lines.push(l), note: () => {} })).toBe(1)
    expect(lines).toEqual(['src/touched.ts: not formatted', 'format: 1 code file the diff touches is not formatted: run bunx biome format --write on it.'])
    writeFileSync(join(dir, 'src', 'touched.ts'), 'export const touched = 1\n')
    expect(runFormat({ root: dir, git, bin: REAL, log: () => {}, note: () => {} })).toBe(0)
    // the untouched file is still not formatted, and that is not this branch's failure
    expect(readFileSync(join(dir, 'src', 'untouched.ts'), 'utf8')).toBe('export const old = 2;\n')
  })

  test('the real git it reads: an untouched committed file passes, an untracked one the branch adds is checked', () => {
    // the semicolon is what the config removes, so this file is not formatted either way
    const dir = tree({ 'src/committed.ts': 'export const old = 2;\n' })
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
      expect(r.exitCode, r.stderr.toString()).toBe(0)
      return r.stdout.toString()
    }
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-qm', 'init')
    // nothing of the branch's diff touches it
    expect(runFormat({ root: dir, bin: REAL, log: () => {}, note: () => {} })).toBe(0)
    // a file the branch added, still untracked as a task's worktree holds it before its commit
    writeFileSync(join(dir, 'src', 'added.ts'), 'export const added = 3;\n')
    const lines: string[] = []
    expect(runFormat({ root: dir, bin: REAL, log: (l) => lines.push(l), note: () => {} })).toBe(1)
    expect(lines).toContain('src/added.ts: not formatted')
  })

  test('the config the repo ships is the one the formatter is held to', () => {
    const dir = tree({ 'src/a.ts': 'export const a = 1\n' })
    const git = stubGit('main', 'abc', ['src/a.ts'])
    expect(runFormat({ root: dir, git, bin: REAL, log: () => {}, note: () => {} })).toBe(0)
    // double quotes and a semicolon are what a formatter with another config would leave alone
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = "x";\n')
    expect(runFormat({ root: dir, git, bin: REAL, log: () => {}, note: () => {} })).toBe(1)
  })
})
