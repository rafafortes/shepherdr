// The lint step (audit 2026-11-18, QG-02): the ratchet compares a file's findings per rule with the baseline, a finding
// more on a file fails, a file the baseline does not know may carry none, and the record path keeps the counts of a
// clean tree only. The last tests drive the real pinned biome over fixture trees, so a planted unused variable fails
// and a fixed or `biome-ignore`d one passes, with no network and no browser. Nothing here reads this repo's baseline.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baselineFile, biomeBin, compare, count, main, parseDiagnostics, plural, probeBiome, readBaseline, recordBaseline, rulesOf, runLint } from '../scripts/checks/lint.ts'
import { tmp } from './tmp.ts'

const repo = join(import.meta.dir, '..')
const REAL = biomeBin(repo) ?? ''

/** a report as `biome lint --reporter=json` prints it: one diagnostic per [file, rule] */
const report = (...found: [string, string][]) => JSON.stringify({ summary: {}, diagnostics: found.map(([path, category]) => ({ category, location: { path, start: { line: 1 } } })) })

/** a stub run, so no test but the real ones needs a binary: --version answers as the real one does */
const stub =
  (stdout: string, stderr = '', exitCode = 0) =>
  (cmd: string[]) =>
    cmd.includes('--version') ? { stdout: 'Version: 2.6.8', stderr: '', exitCode: 0 } : { stdout, stderr, exitCode }

/** a binary that is installed but cannot run here: a wrapper with no node, or a missing platform package */
const broken = () => ({ stdout: '', stderr: 'node: not found', exitCode: 127 })

/** a fixture tree with a git repo of its own, its commits made with CI's identity as the check's tests do */
function gitTree(files: Record<string, string> = {}) {
  const dir = tmp('checks-lint-repo')
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    return r.stdout.toString()
  }
  git('init', '-q', '-b', 'main')
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  git('add', '-A')
  git('-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-qm', 'init')
  return { dir, git }
}

/** a fixture tree the real biome can read: the repo's own biome.json, and the ignore file it needs, committed with the tree */
function biomeTree(files: Record<string, string>) {
  const tree = gitTree({ ...files, 'biome.json': readFileSync(join(repo, 'biome.json'), 'utf8'), '.gitignore': 'node_modules/\n' })
  return tree
}

describe('the report', () => {
  test('a report is its diagnostics by file and rule; another error, or no report at all, is not one', () => {
    expect(parseDiagnostics(report(['src/a.ts', 'lint/suspicious/noExplicitAny'], ['src/a.ts', 'lint/style/noNonNullAssertion']))).toEqual([
      { file: 'src/a.ts', rule: 'lint/suspicious/noExplicitAny' },
      { file: 'src/a.ts', rule: 'lint/style/noNonNullAssertion' },
    ])
    // a diagnostic without a file or a rule says nothing the ratchet can hold
    expect(parseDiagnostics(JSON.stringify({ diagnostics: [{ category: 'lint/x' }, { location: { path: 'a.ts' } }] }))).toEqual([])
    expect(parseDiagnostics('{"error":"the config is broken"}')).toBeNull()
    expect(parseDiagnostics('not json at all')).toBeNull()
  })

  test('the counts are per file and rule, and the note counts the rules', () => {
    const now = count([
      { file: 'b.ts', rule: 'r2' },
      { file: 'b.ts', rule: 'r2' },
      { file: 'a.ts', rule: 'r1' },
      { file: 'a.ts', rule: 'r2' },
    ])
    expect(now).toEqual({ 'a.ts': { r1: 1, r2: 1 }, 'b.ts': { r2: 2 } })
    expect(rulesOf(now)).toBe(2)
    expect(rulesOf({})).toBe(0)
    expect(plural(1, 'finding', 'findings')).toBe('1 finding')
    expect(plural(2, 'finding', 'findings')).toBe('2 findings')
  })
})

describe('the ratchet', () => {
  const base = { 'a.ts': { r1: 2, r2: 1 }, 'old.ts': {} }

  test('the same count holds, and a rule that fell is no failure', () => {
    expect(compare({ 'a.ts': { r1: 2, r2: 1 }, 'old.ts': {} }, base)).toEqual([])
    expect(compare({ 'a.ts': { r1: 1 } }, base)).toEqual([])
    expect(compare({}, base)).toEqual([])
  })

  test('one finding more of a rule fails, naming the file, the rule and both counts', () => {
    expect(compare({ 'a.ts': { r1: 3 } }, base)).toEqual(['a.ts: r1 3 (2 at the baseline)'])
    expect(compare({ 'a.ts': { r2: 2 } }, base)).toEqual(['a.ts: r2 2 (1 at the baseline)'])
  })

  test('a rule a file did not carry before fails too, and a new file may carry none', () => {
    expect(compare({ 'a.ts': { r3: 1 } }, base)).toEqual(['a.ts: r3 1 (0 at the baseline)'])
    expect(compare({ 'new.ts': { r1: 2 } }, base)).toEqual(['new.ts: r1 2 (a file the baseline does not know)'])
    expect(compare({ 'new.ts': {} as Record<string, number> }, base)).toEqual([])
  })

  test('every file and rule that grew is named, sorted', () => {
    expect(compare({ 'b.ts': { r2: 1 }, 'a.ts': { r2: 2, r1: 3 } }, base)).toEqual([
      'a.ts: r1 3 (2 at the baseline)',
      'a.ts: r2 2 (1 at the baseline)',
      'b.ts: r2 1 (a file the baseline does not know)',
    ])
    expect(compare({ 'old.ts': { r2: 1 } }, base)).toEqual(['old.ts: r2 1 (0 at the baseline)'])
  })
})

describe('the baseline', () => {
  test("it lives in the repo's own .git, and in a folder of the tree's when there is no repo", () => {
    const { dir } = gitTree({ 'src/a.ts': 'export const a = 1\n' })
    expect(baselineFile(dir)).toContain(join('.git', 'shepherdr-lint', 'baseline.json'))
    expect(baselineFile(tmp('checks-lint-norepo'))).toContain(join('node_modules', '.cache', 'shepherdr-lint', 'baseline.json'))
  })

  test('a recorded baseline reads back, and an unreadable one is no baseline', () => {
    const file = join(tmp('checks-lint-baseline'), 'baseline.json')
    expect(readBaseline(file)).toBeNull()
    recordBaseline(file, { 'a.ts': { r1: 1 } }, 'abc1234')
    expect(readBaseline(file)).toEqual({ commit: 'abc1234', at: expect.any(Number), files: { 'a.ts': { r1: 1 } } })
    writeFileSync(file, '{')
    expect(readBaseline(file)).toBeNull()
    writeFileSync(file, '{"files":{}}')
    expect(readBaseline(file)).toBeNull()
  })
})

describe('the step', () => {
  test('the same findings as the baseline pass, and the note counts them with the baseline commit', () => {
    const { dir } = gitTree({ 'src/a.ts': 'export const a = 1\n' })
    const notes: string[] = []
    const same = stub(report(['src/a.ts', 'lint/style/noNonNullAssertion']))
    expect(runLint({ root: dir, bin: 'biome', run: same, record: true, note: (n) => notes.push(n) })).toBe(0)
    expect(runLint({ root: dir, bin: 'biome', run: same, note: (n) => notes.push(n) })).toBe(0)
    expect(notes[1]).toMatch(/^lint: 1 finding of 1 rule in 1 file; none grew since [0-9a-f]+$/)
  })

  test('a file with one finding more fails, naming the file, the rule and both counts', () => {
    const { dir } = gitTree({ 'src/a.ts': 'export const a = 1\n' })
    const lines: string[] = []
    const notes: string[] = []
    expect(runLint({ root: dir, bin: 'biome', run: stub(report(['src/a.ts', 'lint/style/noNonNullAssertion'])), record: true })).toBe(0)
    const more = stub(report(['src/a.ts', 'lint/style/noNonNullAssertion'], ['src/a.ts', 'lint/style/noNonNullAssertion']))
    expect(runLint({ root: dir, bin: 'biome', run: more, log: (l) => lines.push(l), note: (n) => notes.push(n) })).toBe(1)
    expect(lines.join('\n')).toContain('src/a.ts: lint/style/noNonNullAssertion 2 (1 at the baseline)')
    expect(lines.join('\n')).toContain('1 finding more than at the baseline')
    expect(notes[0]).toMatch(/^lint: 1 grew since [0-9a-f]+$/)
  })

  test('two findings more are named in the plural, across two files', () => {
    const { dir } = gitTree({ 'src/a.ts': 'export const a = 1\n' })
    const lines: string[] = []
    const notes: string[] = []
    expect(runLint({ root: dir, bin: 'biome', run: stub(report(['src/a.ts', 'lint/a'])), record: true })).toBe(0)
    const grown = stub(report(['src/a.ts', 'lint/a'], ['src/a.ts', 'lint/b'], ['src/b.ts', 'lint/b']))
    expect(runLint({ root: dir, bin: 'biome', run: grown, log: (l) => lines.push(l), note: (n) => notes.push(n) })).toBe(1)
    expect(lines.join('\n')).toContain('2 findings more than at the baseline')
    expect(notes[0]).toMatch(/^lint: 2 grew since [0-9a-f]+$/)
  })

  test("the record path keeps a clean tree's counts, and says why it kept nothing otherwise", () => {
    const { dir } = gitTree({ 'src/a.ts': 'export const a = 1\n' })
    const file = baselineFile(dir)
    const lines: string[] = []
    const run = stub(report(['src/a.ts', 'lint/style/noNonNullAssertion']))
    expect(runLint({ root: dir, bin: 'biome', run, record: true, log: (l) => lines.push(l) })).toBe(0)
    expect(lines.join('\n')).toContain('Lint baseline recorded at')
    expect(readBaseline(file)?.commit).toBeTruthy()
    // a tree that holds what is not committed keeps no baseline
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2\n')
    expect(runLint({ root: dir, bin: 'biome', run, record: true, log: (l) => lines.push(l) })).toBe(0)
    expect(lines.join('\n')).toContain('the tree holds what is not committed')
    // a tree with no repo to name a commit has nothing to keep either
    const noRepo = tmp('checks-lint-record-norepo')
    expect(runLint({ root: noRepo, bin: 'biome', run, record: true, log: (l) => lines.push(l) })).toBe(0)
    expect(lines.join('\n')).toContain('the tree is not a git repository')
    expect(readBaseline(baselineFile(noRepo))).toBeNull()
  })

  test('a baseline is never recorded over findings that grew', () => {
    const { dir } = gitTree({ 'src/a.ts': 'export const a = 1\n' })
    const lines: string[] = []
    expect(runLint({ root: dir, bin: 'biome', run: stub(report(['src/a.ts', 'lint/a'])), record: true })).toBe(0)
    const grown = stub(report(['src/a.ts', 'lint/a'], ['src/a.ts', 'lint/a']))
    expect(runLint({ root: dir, bin: 'biome', run: grown, record: true, log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('findings grew since the last one')
    expect(readBaseline(baselineFile(dir))?.files).toEqual({ 'src/a.ts': { 'lint/a': 1 } })
  })

  test('without a baseline the step says so and passes: nothing holds the tree against anything yet', () => {
    const { dir } = gitTree({ 'src/a.ts': 'export const a = 1\n' })
    const lines: string[] = []
    const notes: string[] = []
    const run = stub(report(['src/a.ts', 'lint/a'], ['src/b.ts', 'lint/b']))
    expect(runLint({ root: dir, bin: 'biome', run, log: (l) => lines.push(l), note: (n) => notes.push(n) })).toBe(0)
    expect(lines.join('\n')).toContain('No lint baseline yet')
    expect(notes[0]).toBe('lint: 2 findings of 2 rules in 2 files; no baseline to hold it against yet')
  })

  test('a host without the binary skips the step with what installs it, never a red failure', () => {
    const { dir } = gitTree({ 'src/a.ts': 'export const a = 1\n' })
    const notes: string[] = []
    const skips: string[] = []
    expect(runLint({ root: dir, bin: null, note: (n) => notes.push(n), skip: (s) => skips.push(s) })).toBe(0)
    expect(notes[0]).toBe('lint: skipped, biome is missing')
    expect(skips[0]).toContain('run bun install')
    // the default is this tree's own binary, and a fixture tree has none
    expect(runLint({ root: dir, log: () => {}, note: () => {}, skip: () => {} })).toBe(0)
  })

  test('a binary that is there but cannot run here is a skip too, never a red failure', () => {
    const { dir } = gitTree({ 'src/a.ts': 'export const a = 1\n' })
    const notes: string[] = []
    const skips: string[] = []
    expect(runLint({ root: dir, bin: 'biome', run: broken, note: (n) => notes.push(n), skip: (s) => skips.push(s) })).toBe(0)
    expect(notes[0]).toBe('lint: skipped, biome cannot run here')
    expect(skips[0]).toContain('node: not found')
    expect(probeBiome('biome', broken, dir)).toBe('node: not found')
    expect(probeBiome('biome', () => ({ stdout: '', stderr: '', exitCode: 127 }), dir)).toBe('it exited 127')
    expect(probeBiome('biome', stub(report()), dir)).toBeNull()
  })

  test('a biome that cannot produce a report fails with what it said', () => {
    const { dir } = gitTree({ 'src/a.ts': 'export const a = 1\n' })
    const lines: string[] = []
    expect(runLint({ root: dir, bin: 'biome', run: stub('{"error":"bad config"}', 'the config is broken', 1), log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('biome lint could not run: the config is broken')
    const silent: string[] = []
    expect(runLint({ root: dir, bin: 'biome', run: stub(''), log: (l) => silent.push(l) })).toBe(1)
    expect(silent.join('\n')).toContain('it exited 0 with no report')
  })

  test('the runner entry point reads its environment and writes its note and its skip', () => {
    const { dir } = gitTree({ 'src/a.ts': 'export const a = 1\n' })
    const note = join(dir, 'note.txt')
    const skip = join(dir, 'skip.txt')
    const none = join(dir, 'no-baseline-here.json')
    // this fixture tree's own baseline, and the repo's when no environment is set (a stub run keeps the real binary out)
    const run = stub(report(['src/a.ts', 'lint/a']))
    expect(main({ SHEPHERDR_CHECK_ROOT: dir, SHEPHERDR_CHECK_NOTE: note, SHEPHERDR_CHECK_RECORD: '1' }, { bin: 'biome', run })).toBe(0)
    // the run that records had no baseline to compare with yet
    expect(readFileSync(note, 'utf8')).toContain('no baseline to hold it against yet')
    // a run with nothing to skip writes no skip file at all
    expect(main({ SHEPHERDR_CHECK_ROOT: dir, SHEPHERDR_CHECK_SKIP: skip }, { bin: 'biome', run })).toBe(0)
    expect(existsSync(skip)).toBe(false)
    expect(main({ SHEPHERDR_CHECK_ROOT: dir, SHEPHERDR_CHECK_NOTE: note, SHEPHERDR_CHECK_SKIP: skip }, { bin: null })).toBe(0)
    expect(readFileSync(note, 'utf8')).toBe('lint: skipped, biome is missing\n')
    expect(readFileSync(skip, 'utf8')).toContain('run bun install')
    expect(main({}, { bin: 'biome', run, baseline: none })).toBe(0)
    expect(main({}, { bin: 'biome', run: stub('nope'), baseline: none })).toBe(1)
  })
})

describe.skipIf(!REAL)('the real biome', () => {
  test('a new file with an unused variable fails, the fixed one passes, and a biome-ignore with a reason lets one off', () => {
    const { dir } = biomeTree({ 'src/ok.ts': 'export const ok = 1\n' })
    expect(runLint({ root: dir, bin: REAL, record: true, log: () => {}, note: () => {} })).toBe(0)
    const lines: string[] = []
    writeFileSync(join(dir, 'src', 'bad.ts'), 'export function f() {\n  const unused = 1\n  return 2\n}\n')
    expect(runLint({ root: dir, bin: REAL, log: (l) => lines.push(l), note: () => {} })).toBe(1)
    expect(lines.join('\n')).toContain('src/bad.ts: lint/correctness/noUnusedVariables 1 (a file the baseline does not know)')
    writeFileSync(join(dir, 'src', 'bad.ts'), 'export function f() {\n  return 2\n}\n')
    expect(runLint({ root: dir, bin: REAL, log: () => {}, note: () => {} })).toBe(0)
    writeFileSync(join(dir, 'src', 'let-off.ts'), 'export function g() {\n  // biome-ignore lint/correctness/noUnusedVariables: kept for the fixture\n  const kept = 1\n  return 2\n}\n')
    expect(runLint({ root: dir, bin: REAL, log: (l) => lines.push(l), note: () => {} })).toBe(0)
  })

  test('the --record flag is the command-line way to keep a baseline, as scripts/coverage.ts has it', () => {
    const { dir, git } = biomeTree({ 'src/ok.ts': 'export const ok = 1\n' })
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    symlinkSync(REAL, join(dir, 'node_modules', '.bin', 'biome'))
    const note = join(dir, 'note.txt')
    const r = Bun.spawnSync([process.execPath, join(repo, 'scripts', 'checks', 'lint.ts'), '--record'], {
      cwd: dir,
      env: { ...process.env, SHEPHERDR_CHECK_ROOT: dir, SHEPHERDR_CHECK_NOTE: note },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    expect(readBaseline(baselineFile(dir))?.commit).toBe(git('rev-parse', 'HEAD').trim())
    expect(readFileSync(note, 'utf8')).toContain('no baseline to hold it against yet')
  })

  test('the config this repo ships is the one the step reads: the four rules it names all fire', () => {
    const { dir } = biomeTree({ 'src/ok.ts': 'export const ok = 1\n' })
    const lines: string[] = []
    expect(runLint({ root: dir, bin: REAL, record: true, log: () => {}, note: () => {} })).toBe(0)
    writeFileSync(
      join(dir, 'src', 'probe.tsx'),
      'import { useEffect, useState } from "react"\n\nexport function Probe({ id }: { id: string }) {\n  const [n, setN] = useState(0)\n  const stale = 1\n  useEffect(() => {\n    load(id)\n  }, [])\n  const v = n as any\n  return <div>{v}</div>\n}\n\nasync function load(id: string) {\n  return id\n}\n',
    )
    expect(runLint({ root: dir, bin: REAL, log: (l) => lines.push(l), note: () => {} })).toBe(1)
    const said = lines.join('\n')
    for (const rule of ['noExplicitAny', 'useExhaustiveDependencies', 'noUnusedVariables', 'noFloatingPromises']) expect(said).toContain(rule)
    expect(said).toContain('src/probe.tsx')
  })
})
