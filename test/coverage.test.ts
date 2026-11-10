// The coverage ratchet (scripts/coverage.ts): one count per file of the lines no test runs, from Bun's lcov and the
// browser tests' lines of the screen, held file by file against the default branch's baseline. Its command runs here
// against a git repo of its own and a baseline file of its own: never this repo's .git.
import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const C = await import('../scripts/coverage.ts')

const lcov = (file: string, da: [number, number][]) => `TN:\nSF:${file}\n${da.map(([n, c]) => `DA:${n},${c}`).join('\n')}\nLF:${da.length}\nLH:${da.filter(([, c]) => c).length}\nend_of_record\n`

describe('reading what the tests ran', () => {
  test("Bun's lcov: a line any record ran is run; the screen's lines add to it the same way", () => {
    const cover = C.readLcov(lcov('server/a.ts', [[1, 0], [2, 3], [3, 0]]) + lcov('server/a.ts', [[1, 2]]) + 'DA:9,1\n')
    expect([...cover.get('server/a.ts')!]).toEqual([[1, 1], [2, 1], [3, 0]])
    C.addScreen({ 'server/a.ts': { 3: 1, 4: 0 }, 'src/b.tsx': { 10: 0, 11: 1 } }, cover)
    C.addScreen({ 'src/b.tsx': { 10: 0, 11: 0 } }, cover)
    expect([...cover.get('server/a.ts')!]).toEqual([[1, 1], [2, 1], [3, 1], [4, 0]])
    expect([...cover.get('src/b.tsx')!]).toEqual([[10, 0], [11, 1]])
  })

  test('what counts: the code, never the tests, generated files or other kinds of file', () => {
    expect(['server/live/x.ts', 'shared/y.ts', 'src/App.tsx', 'plugins/chat/client.tsx', 'scripts/test.ts'].every(C.counted)).toBe(true)
    expect(['test/x.test.ts', 'server/a.test.ts', 'plugins/x/generated/y.ts', 'docs/a.md', 'server/a.json', 'README.md'].some(C.counted)).toBe(false)
    expect(['src/kernel.ts', 'plugins/chat/client.tsx', 'plugins/places/row.tsx'].every(C.isScreen)).toBe(true)
    expect(['server/live/x.ts', 'plugins/chat/server.ts'].some(C.isScreen)).toBe(false)
  })

  test('a line is let off where it, or the line above it, says coverage-exempt: and why', () => {
    const text = ['a()', '// coverage-exempt: no herdr here', 'b()', 'c() // coverage-exempt: a race', 'd()']
    expect([1, 2, 3, 4, 5].map((n) => C.exempt(text, n))).toEqual([false, true, true, true, true])
    expect(C.exempt(['x()', 'y()'], 2)).toBe(false)
  })

  test('each file counted: its lines, the ones no test runs past those let off, and the files no test loads', () => {
    const cover = C.readLcov(lcov('server/a.ts', [[1, 1], [2, 0], [3, 0], [5, 0]]))
    const text: Record<string, string> = { 'server/a.ts': 'a()\nb()\n// coverage-exempt: unreachable here\nc()\nd()' }
    const now = C.count(cover, ['server/a.ts', 'server/never.ts', 'server/gone.ts'], (f) => {
      if (f === 'server/gone.ts') throw new Error('gone')
      return text[f]
    })
    expect(now['server/a.ts']).toEqual({ lines: 4, missed: [2, 5], measured: true })
    expect(now['server/never.ts']).toEqual({ lines: 0, missed: [], measured: false })
    // one that went since the run still counts as the run saw it
    const gone = C.count(C.readLcov(lcov('server/gone.ts', [[1, 0]])), ['server/gone.ts'], () => {
      throw new Error('gone')
    })
    expect(gone['server/gone.ts'].missed).toEqual([1])
  })

  test('lines as spans, and the counts said in a line and, worst first, in a report', () => {
    expect(C.spans([1, 2, 3, 7, 9, 10])).toBe('1-3, 7, 9-10')
    expect(C.spans([])).toBe('')
    const now = {
      'server/a.ts': { lines: 10, missed: [3, 4], measured: true },
      'server/b.ts': { lines: 5, missed: [], measured: true },
      'src/c.tsx': { lines: 20, missed: [1], measured: true },
      'server/d.ts': { lines: 0, missed: [], measured: false },
    }
    expect(C.summary(now)).toBe("Coverage: 86.7% of the server's lines (13 of 15), 95.0% of the screen's lines (19 of 20); 1 of 4 files run whole, 1 no test loads")
    expect(C.summary({ 'server/b.ts': { lines: 5, missed: [], measured: true } })).toBe("Coverage: 100.0% of the server's lines (5 of 5), none of the screen measured; 1 of 1 files run whole")
    const r = C.report(now).split('\n')
    expect(r[0]).toStartWith('server/a.ts')
    expect(r[0]).toContain('80.0%  missed 2: 3-4')
    expect(r.find((x) => x.startsWith('server/b.ts'))).toContain('100.0%  whole')
    // after the ones with lines missed, before the whole ones: what no test loads is not known to be fine
    expect(r.findIndex((x) => x.startsWith('server/d.ts'))).toBeLessThan(r.findIndex((x) => x.startsWith('server/b.ts')))
    expect(r.find((x) => x.startsWith('server/d.ts'))).toContain('no test loads it')
    expect(C.report({ 'server/e.ts': { lines: 0, missed: [], measured: true } })).toContain('100.0%  whole')
  })
})

describe("the screen's lines (test/screen-map.ts)", () => {
  test('an offset takes the count of the innermost range that holds it: a function never called, a branch never taken, are 0', async () => {
    const { countsAt } = await import('./screen-map.ts')
    // the script (0-100) ran; f (10-40) ran, its branch 20-30 never did; g (50-70) was never called, though a function
    // in it (55-60) is listed with a count of its own; nothing holds 120
    const ranges = [
      { startOffset: 50, endOffset: 70, count: 0 },
      { startOffset: 0, endOffset: 100, count: 1 },
      { startOffset: 10, endOffset: 40, count: 3 },
      { startOffset: 20, endOffset: 30, count: 0 },
      { startOffset: 55, endOffset: 60, count: 2 },
    ]
    expect(countsAt(ranges, [5, 12, 25, 35, 52, 57, 65, 80, 120])).toEqual([1, 3, 0, 3, 0, 2, 0, 1, 0])
    expect(countsAt([], [1])).toEqual([0])
  })
})

describe('the ratchet', () => {
  const base: import('../scripts/coverage.ts').Baseline = { commit: 'abc1234def', at: 1, files: { 'server/a.ts': 2, 'server/b.ts': 0, 'server/c.ts': null, 'server/gone.ts': 1, 'server/out.ts': 3 } }
  const c = (missed: number[], measured = true) => ({ lines: 10, missed, measured })

  test('held: no file has more lines no test runs, a file no test loaded then may be anything, a covered new file comes in', () => {
    expect(C.compare({ 'server/a.ts': c([1, 2]), 'server/b.ts': c([]), 'server/c.ts': c([1, 2, 3]), 'server/new.ts': c([]), 'server/d.ts': c([], false) }, { ...base, files: { ...base.files, 'server/d.ts': null } })).toEqual([])
    // fewer is fine: the baseline goes down with it on the default branch
    expect(C.compare({ 'server/a.ts': c([1]) }, base)).toEqual([])
  })

  test('fell: a file with more of them, one no test runs any more, a new file with some or none run at all', () => {
    expect(C.compare({ 'server/a.ts': c([1, 2, 5]), 'server/out.ts': c([], false), 'server/new.ts': c([4]), 'server/new2.ts': c([1, 2]), 'server/new3.ts': c([], false) }, base)).toEqual([
      'server/a.ts: 1 more line no test runs (3 now, 2 at the baseline; lines 1-2, 5)',
      'server/out.ts: no test runs it any more (it had 3 lines no test ran)',
      'server/new.ts: a new file with 1 line no test runs (line 4)',
      'server/new2.ts: a new file with 2 lines no test runs (lines 1-2)',
      'server/new3.ts: a new file no test runs at all',
    ])
    expect(C.compare({ 'server/b.ts': c([1, 2]), 'server/gone.ts': c([], false) }, base)).toEqual(['server/b.ts: 2 more lines no test runs (2 now, 0 at the baseline; lines 1-2)', 'server/gone.ts: no test runs it any more (it had 1 line no test ran)'])
  })
})

describe('the command', () => {
  /** a repo of its own with one counted file, committed, and what a covered run of it left */
  function world() {
    const repo = tmp('cov-repo')
    mkdirSync(join(repo, 'server'), { recursive: true })
    writeFileSync(join(repo, 'server', 'a.ts'), 'export const a = 1\nexport function b() {\n  return 2\n}\n')
    writeFileSync(join(repo, 'README.md'), 'hi\n')
    execSync('git init -q -b main && git -c user.email=t@t -c user.name=T add -A && git -c user.email=t@t -c user.name=T commit -qm init', { cwd: repo, shell: '/bin/sh' })
    const dir = tmp('cov-run')
    const run = (da: [number, number][], screen?: object) => {
      mkdirSync(join(dir, 'server'), { recursive: true })
      writeFileSync(join(dir, 'server', 'lcov.info'), lcov('server/a.ts', da))
      if (screen) {
        mkdirSync(join(dir, 'screen'), { recursive: true })
        writeFileSync(join(dir, 'screen', 'layout-x.test.ts.json'), JSON.stringify(screen))
        writeFileSync(join(dir, 'screen', 'notes.txt'), 'not a test')
      }
    }
    const baseline = join(tmp('cov-base'), 'coverage.json')
    const said: string[] = []
    const main = (...args: string[]) => C.main(args, { repo, baseline, log: (x) => said.push(x) })
    return { repo, dir, run, baseline, said, main }
  }

  test('no folder, or no run in it: it says how to make one', () => {
    const w = world()
    expect(w.main()).toBe(2)
    expect(w.said.at(-1)).toContain('bun scripts/coverage.ts <dir> [--record]')
    expect(w.main(join(w.dir, 'none'))).toBe(2)
    expect(w.said.at(-1)).toContain('No coverage in')
  })

  test('no baseline yet: it says the counts and compares nothing; --record keeps them for a clean tree only', () => {
    const w = world()
    w.run([[1, 1], [2, 1], [3, 0]], { 'server/a.ts': { 3: 0 } })
    expect(w.main(w.dir)).toBe(0)
    expect(w.said[0]).toBe("Coverage: 66.7% of the server's lines (2 of 3), none of the screen measured; 0 of 1 files run whole")
    expect(w.said).toContain('No coverage baseline yet: the check on the default branch records one, and from then no file may lose coverage.')
    expect(readFileSync(join(w.dir, 'report.txt'), 'utf8')).toContain('server/a.ts')
    expect(existsSync(w.baseline)).toBe(false)
    // a tree with what isn't committed records nothing: a baseline is a commit's
    writeFileSync(join(w.repo, 'loose.txt'), 'x\n')
    expect(w.main(w.dir, '--record')).toBe(0)
    expect(w.said.at(-1)).toContain('No coverage baseline recorded')
    execSync('rm loose.txt', { cwd: w.repo })
    expect(w.main(w.dir, '--record')).toBe(0)
    expect(w.said.at(-1)).toMatch(/^Coverage baseline of [0-9a-f]{7}: recorded in /)
    expect(JSON.parse(readFileSync(w.baseline, 'utf8')).files).toEqual({ 'server/a.ts': 1 })
  })

  test('held against it: the same passes, one more line no test runs fails and names it', () => {
    const w = world()
    w.run([[1, 1], [2, 1], [3, 0]])
    w.main(w.dir, '--record')
    expect(w.main(w.dir)).toBe(0)
    expect(w.said.at(-1)).toMatch(/^Coverage held: /)
    w.run([[1, 1], [2, 0], [3, 0]])
    expect(w.main(w.dir)).toBe(1)
    expect(w.said.join('\n')).toContain('Coverage fell since the baseline')
    expect(w.said.at(-1)).toBe('  server/a.ts: 1 more line no test runs (2 now, 1 at the baseline; lines 2-3)')
  })

  test('where the baseline is kept: the repo\'s own .git, for every worktree; a broken one is none', () => {
    const w = world()
    expect(C.baselineFile(w.repo)).toBe(join(w.repo, '.git', 'shepherdr-test', 'coverage.json'))
    expect(C.baselineFile(tmp('cov-no-git'))).toEndWith(join('node_modules', '.cache', 'shepherdr-test', 'coverage.json'))
    writeFileSync(w.baseline, 'not json')
    expect(C.readBaseline(w.baseline)).toBeNull()
    writeFileSync(w.baseline, JSON.stringify({ at: 1 }))
    expect(C.readBaseline(w.baseline)).toBeNull()
  })
})
