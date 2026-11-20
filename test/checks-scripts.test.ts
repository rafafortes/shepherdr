// The shell and Perl lint step (audit 2026-11-18, QG-07): a planted warning in a fixture shell file fails and names
// its file, line and rule; a disable comment passes; a perl -c syntax error fails; a host without a tool skips just
// that part. These drive the real module over fixture trees under /tmp, never this repo's scripts or helpers.
import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NO_PERL, NO_SHELLCHECK, main, runScripts } from '../scripts/checks/scripts.ts'
import { tmp } from './tmp.ts'

const shellcheck = Bun.which('shellcheck') ?? ''
const perl = Bun.which('perl') ?? ''

/** a fixture tree with a clean shell file, three commands, the gate's own check shim and two Perl helpers, plus an
 *  optional planted bad file */
function tree(plantShell?: string, plantPerl?: string) {
  const dir = tmp('checks-scripts')
  for (const d of ['scripts/checks', 'bin', 'helper']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'gate.sh'), '#!/usr/bin/env bash\nset -uo pipefail\necho "gate"\n')
  writeFileSync(join(dir, 'scripts', 'checks', '10-one'), '#!/usr/bin/env bash\nset -uo pipefail\nexec true\n')
  writeFileSync(join(dir, 'bin', 'shepherdr'), '#!/bin/sh\necho "command"\n')
  writeFileSync(join(dir, 'bin', 'agent-browser'), '#!/bin/sh\necho "browser"\n')
  writeFileSync(join(dir, 'helper', 'agent-browser'), '#!/bin/sh\necho "browser"\n')
  writeFileSync(join(dir, 'helper', 'health.pl'), 'print "ok\\n";\n')
  writeFileSync(join(dir, 'helper', 'shepherdr'), 'print "ok\\n";\n')
  if (plantShell !== undefined) writeFileSync(join(dir, 'scripts', 'bad.sh'), plantShell)
  if (plantPerl !== undefined) writeFileSync(join(dir, 'helper', 'bad.pl'), plantPerl)
  return dir
}

/** a stand-in tool that fails a run in a chosen way, for the paths the real one cannot take here */
function fakeBinary(body: string) {
  const dir = tmp('checks-scripts-bin')
  const file = join(dir, 'tool')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

describe.skipIf(!shellcheck)('shellcheck -S warning over the shell files', () => {
  test('an unquoted variable fails, naming the file, the line and the rule', () => {
    const root = tree('#!/usr/bin/env bash\necho $unquoted\n')
    const lines: string[] = []
    expect(runScripts({ root, shellcheck, perl, log: (l) => lines.push(l) })).toBe(1)
    const out = lines.join('\n')
    expect(out).toContain('scripts/bad.sh:2:')
    expect(out).toContain('warning:')
    expect(out).toContain('[SC2154]')
  })

  test('a disable comment on the same file passes, with a note that says shellcheck ran', () => {
    const root = tree('#!/usr/bin/env bash\n# shellcheck disable=SC2154\necho $unquoted\n')
    const notes: string[] = []
    expect(runScripts({ root, shellcheck, perl, note: (n) => notes.push(n) })).toBe(0)
    expect(notes.join('\n')).toContain('shellcheck: 6 shell files clean')
  })

  test("a warning inside one of the gate's own check shims fails, naming it like any other file", () => {
    const root = tree()
    writeFileSync(join(root, 'scripts', 'checks', '20-two'), '#!/usr/bin/env bash\nset -uo pipefail\necho $unquoted\n')
    const lines: string[] = []
    expect(runScripts({ root, shellcheck, perl: null, log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('scripts/checks/20-two:3:')
  })

  test('what the runner would not run is not linted: a dotfile, a folder, a check in another language', () => {
    const root = tree()
    // each of these would fail shellcheck, and none of them is a shell check the runner discovers
    writeFileSync(join(root, 'scripts', 'checks', '.hidden-shim'), '#!/usr/bin/env bash\necho $unquoted\n')
    mkdirSync(join(root, 'scripts', 'checks', 'sub'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'checks', 'sub', '10-nested'), '#!/usr/bin/env bash\necho $unquoted\n')
    writeFileSync(join(root, 'scripts', 'checks', '20-bun'), '#!/usr/bin/env bun\necho $unquoted\n')
    const notes: string[] = []
    expect(runScripts({ root, shellcheck, perl: null, note: (n) => notes.push(n) })).toBe(0)
    expect(notes.join('\n')).toContain('shellcheck: 5 shell files clean')
  })
  test('a check whose first line merely contains "sh" is no shell check', () => {
    const root = tree()
    writeFileSync(join(root, 'scripts', 'checks', '20-python'), '#!/usr/bin/env python3 # bash is a word\nprint(1)\n')
    const notes: string[] = []
    expect(runScripts({ root, shellcheck, perl: null, note: (n) => notes.push(n) })).toBe(0)
    expect(notes.join('\n')).toContain('shellcheck: 5 shell files clean')
  })

  test('a check it cannot read fails the step naming it, never crashes the module', () => {
    const root = tree()
    const unreadable = join(root, 'scripts', 'checks', '25-locked')
    writeFileSync(unreadable, '#!/usr/bin/env bash\nset -uo pipefail\necho "locked"\n')
    chmodSync(unreadable, 0o000)
    const lines: string[] = []
    expect(runScripts({ root, shellcheck, perl: null, log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('did not finish a lint pass')
  })
})

describe('when shellcheck cannot lint', () => {
  test('an exit that is not a lint result (2: a file it could not read) is not called a warning', () => {
    const root = tree()
    const lines: string[] = []
    const broken = fakeBinary('echo "tool: cannot read that" >&2\nexit 2')
    expect(runScripts({ root, shellcheck: broken, perl: null, log: (l) => lines.push(l) })).toBe(1)
    const out = lines.join('\n')
    expect(out).toContain('cannot read that')
    expect(out).toContain('shellcheck did not finish a lint pass: exit 2')
    expect(out).not.toContain('finding')
  })
})

describe.skipIf(!perl)('perl -c over the helpers', () => {
  test('a syntax error fails, naming the helper and the error', () => {
    const root = tree(undefined, 'my $x = ;\n')
    const lines: string[] = []
    expect(runScripts({ root, shellcheck: null, perl, log: (l) => lines.push(l) })).toBe(1)
    const out = lines.join('\n')
    expect(out).toContain('helper/bad.pl')
    expect(out).toContain('syntax error')
    expect(out).toContain('syntax errors in helper/bad.pl')
  })

  test('valid helpers pass, with a note that says perl ran', () => {
    const root = tree()
    const notes: string[] = []
    expect(runScripts({ root, shellcheck: null, perl, note: (n) => notes.push(n) })).toBe(0)
    expect(notes.join('\n')).toContain('perl -c: 2 helpers syntax OK')
  })
})

test.skipIf(!shellcheck || !perl)('a tree with none of these folders is a clean pass, not a crash', () => {
  // no scripts/, scripts/checks/ or helper/: nothing to lint, and shellcheck must not be given an empty file list
  const root = tmp('checks-scripts-none')
  mkdirSync(root, { recursive: true })
  const notes: string[] = []
  expect(runScripts({ root, shellcheck, perl, note: (n) => notes.push(n) })).toBe(0)
  expect(notes.join('\n')).toContain('no shell files to lint')
  expect(notes.join('\n')).toContain('perl -c: no Perl files to check')
})

describe('a host without a tool', () => {
  test('both missing: skips with both names, never fails', () => {
    const root = tree()
    const lines: string[] = []
    const skipped: string[] = []
    expect(runScripts({ root, shellcheck: null, perl: null, log: (l) => lines.push(l), skip: (s) => skipped.push(s) })).toBe(0)
    expect(skipped.join('\n')).toContain(NO_SHELLCHECK)
    expect(skipped.join('\n')).toContain(NO_PERL)
    expect(lines.join('\n')).toContain('shellcheck')
  })

  test('one missing: the other still runs and the gap is named', () => {
    const root = tree()
    const notes: string[] = []
    const skipped: string[] = []
    expect(runScripts({ root, shellcheck: null, perl, note: (n) => notes.push(n), skip: (s) => skipped.push(s) })).toBe(0)
    expect(notes.join('\n')).toContain('perl -c: 2 helpers syntax OK')
    expect(skipped.join('\n')).toContain(NO_SHELLCHECK)
  })

  test('one missing and the other failing: the log still ends by naming what was not checked', () => {
    const root = tree(undefined, 'my $x = ;\n')
    const lines: string[] = []
    const skipped: string[] = []
    expect(runScripts({ root, shellcheck: null, perl, log: (l) => lines.push(l), skip: (s) => skipped.push(s) })).toBe(1)
    expect(lines.at(-1)).toBe(`not checked here: ${NO_SHELLCHECK}`)
    expect(skipped.join('\n')).toContain(NO_SHELLCHECK)
  })
})

describe.skipIf(!shellcheck || !perl)('the runner entry point', () => {
  test('main reads its environment and writes its note on a clean tree', () => {
    const root = tree()
    const note = join(root, 'note.txt')
    expect(main({ SHEPHERDR_CHECK_ROOT: root, SHEPHERDR_CHECK_NOTE: note })).toBe(0)
    expect(readFileSync(note, 'utf8')).toContain('shellcheck')
  })

  test('main fails on a planted warning and writes no skip', () => {
    const root = tree('#!/usr/bin/env bash\necho $unquoted\n')
    const skip = join(root, 'skip.txt')
    expect(main({ SHEPHERDR_CHECK_ROOT: root, SHEPHERDR_CHECK_SKIP: skip })).toBe(1)
    expect(existsSync(skip), 'no skip when both tools are there').toBe(false)
  })
})
