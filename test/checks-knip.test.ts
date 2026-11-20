// The knip step (audit 2026-11-18, QG-03): it runs `knip --reporter compact` and passes its exit code through, so a new
// unused export, file or dependency fails and a baselined one does not. The last tests drive the real pinned knip over a
// tiny fixture tree: an unused export added exits 1, a @knip-baseline tag on it makes the ignore hold and exits 0. No
// network and no browser; nothing here reads this repo's baseline.
import { describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { countFindings, knipBin, main, probeKnip, runKnip, type Spawn } from '../scripts/checks/knip.ts'
import { tmp } from './tmp.ts'

const repo = join(import.meta.dir, '..')
const REAL = knipBin(repo) ?? ''

/** a stub run, so no test but the real ones needs a binary: --version answers as the real one does */
const stub =
  (stdout: string, stderr = '', exitCode = 0): Spawn =>
  (cmd) =>
    cmd.includes('--version') ? { stdout: '6.46.1', stderr: '', exitCode: 0 } : { stdout, stderr, exitCode }

/** a binary that is there but cannot run here */
const broken: Spawn = () => ({ stdout: '', stderr: 'knip: not found', exitCode: 127 })

/** a compact report with two findings in one file and one in another */
const found = ['Unused exports (2)', 'src/a.ts: first, second', 'src/b.ts: third']

/** a tiny fixture tree with its own knip.json, no node_modules and no git */
function knipTree() {
  const dir = tmp('checks-knip-fixture')
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0","type":"module"}\n')
  writeFileSync(join(dir, 'knip.json'), '{"entry":["main.ts"],"project":["*.ts"],"tags":["-@knip-baseline"]}\n')
  writeFileSync(join(dir, 'main.ts'), 'import { used } from "./a.ts"\nconsole.log(used)\n')
  writeFileSync(join(dir, 'a.ts'), 'export const used = 1\n')
  return dir
}

describe('the compact report', () => {
  test('the findings are the names on the file lines, not the issue-type headers', () => {
    expect(countFindings(found.join('\n'))).toBe(3)
    expect(countFindings('Unused files (1)\nsrc/b.ts: src/b.ts')).toBe(1)
    expect(countFindings('')).toBe(0)
    expect(countFindings('knip is clean')).toBe(0)
  })
})

describe('the binary', () => {
  test('this tree has the pinned one; a fixture tree has none', () => {
    expect(knipBin(repo)).toContain(join('node_modules', '.bin', 'knip'))
    expect(knipBin(tmp('checks-knip-nobin'))).toBeNull()
  })

  test('a binary that answers --version can run; one that does not says why', () => {
    expect(probeKnip('knip', stub(''), repo)).toBeNull()
    expect(probeKnip('knip', broken, repo)).toBe('knip: not found')
    expect(probeKnip('knip', () => ({ stdout: '', stderr: '', exitCode: 127 }), repo)).toBe('it exited 127')
  })
})

describe('the step', () => {
  test('a clean report passes and the note says the baseline is in knip.json', () => {
    const notes: string[] = []
    expect(runKnip({ root: repo, bin: 'knip', run: stub(''), note: (n) => notes.push(n) })).toBe(0)
    expect(notes[0]).toBe('knip: no unused code · baseline in knip.json')
  })

  test('findings fail, naming how many in the note and printing the report in the log', () => {
    const lines: string[] = []
    const notes: string[] = []
    expect(runKnip({ root: repo, bin: 'knip', run: stub(found.join('\n'), '', 1), log: (l) => lines.push(l), note: (n) => notes.push(n) })).toBe(1)
    expect(lines.join('\n')).toContain('src/a.ts: first, second')
    expect(notes[0]).toBe('knip: 3 unused — fix each, or baseline it with a reason in knip.json')
  })

  test('knip that reports nothing but fails still says so', () => {
    const lines: string[] = []
    expect(runKnip({ root: repo, bin: 'knip', run: stub('', 'the config is broken', 1), log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('the config is broken')
    expect(runKnip({ root: repo, bin: 'knip', run: stub('', '', 1), log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('said nothing')
  })

  test('a host without knip skips with what installs it, never a red failure', () => {
    const notes: string[] = []
    const skips: string[] = []
    expect(runKnip({ root: repo, bin: null, note: (n) => notes.push(n), skip: (s) => skips.push(s) })).toBe(0)
    expect(notes[0]).toBe('knip: skipped, knip is missing')
    expect(skips[0]).toContain('run bun install')
    // the default is this fixture's own binary, and the fixture has none
    expect(runKnip({ root: knipTree(), note: () => {}, skip: () => {} })).toBe(0)
  })

  test('a binary that cannot run here is a skip too, never a red failure', () => {
    const notes: string[] = []
    const skips: string[] = []
    expect(runKnip({ root: repo, bin: 'knip', run: broken, note: (n) => notes.push(n), skip: (s) => skips.push(s) })).toBe(0)
    expect(notes[0]).toBe('knip: skipped, knip cannot run here')
    expect(skips[0]).toContain('knip: not found')
  })

  test('the runner entry point reads its environment and writes its note and its skip', () => {
    const dir = knipTree()
    const note = join(dir, 'note.txt')
    const skip = join(dir, 'skip.txt')
    expect(main({ SHEPHERDR_CHECK_ROOT: dir, SHEPHERDR_CHECK_NOTE: note }, { bin: 'knip', run: stub('') })).toBe(0)
    expect(existsSync(note) && !existsSync(skip)).toBe(true)
    expect(main({ SHEPHERDR_CHECK_ROOT: dir, SHEPHERDR_CHECK_SKIP: skip }, { bin: null })).toBe(0)
    expect(existsSync(skip)).toBe(true)
  })
})

describe.skipIf(!REAL)('the real knip', () => {
  test('a new unused export fails; the ignore list holds once it is baselined', () => {
    const dir = knipTree()
    // the fixture is clean to start with: main.ts imports the one export a.ts has
    expect(runKnip({ root: dir, bin: REAL, note: () => {}, skip: () => {} })).toBe(0)
    // a newly unused export fails the step
    writeFileSync(join(dir, 'a.ts'), 'export const used = 1\nexport const newlyDead = 2\n')
    const lines: string[] = []
    expect(runKnip({ root: dir, bin: REAL, log: (l) => lines.push(l), note: () => {}, skip: () => {} })).toBe(1)
    expect(lines.join('\n')).toContain('newlyDead')
    // tagging it with a reason is how the ignore list holds it
    writeFileSync(join(dir, 'a.ts'), 'export const used = 1\n/** @knip-baseline dead export, handed to MAINT */\nexport const newlyDead = 2\n')
    expect(runKnip({ root: dir, bin: REAL, note: () => {}, skip: () => {} })).toBe(0)
  })
})
