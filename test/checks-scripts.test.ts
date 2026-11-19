// The shell and Perl lint step (audit 2026-11-18, QG-07): a planted warning in a fixture shell file fails and names
// its file, line and rule; a disable comment passes; a perl -c syntax error fails; a host without a tool skips just
// that part. These drive the real module over fixture trees under /tmp, never this repo's scripts or helpers.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NO_PERL, NO_SHELLCHECK, main, runScripts } from '../scripts/checks/scripts.ts'
import { tmp } from './tmp.ts'

const shellcheck = Bun.which('shellcheck') ?? ''
const perl = Bun.which('perl') ?? ''

/** a fixture tree with a clean shell file, a command and two Perl helpers, plus an optional planted bad file */
function tree(plantShell?: string, plantPerl?: string) {
  const dir = tmp('checks-scripts')
  for (const d of ['scripts', 'bin', 'helper']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'gate.sh'), '#!/usr/bin/env bash\nset -uo pipefail\necho "gate"\n')
  writeFileSync(join(dir, 'bin', 'shepherdr'), '#!/bin/sh\necho "command"\n')
  writeFileSync(join(dir, 'helper', 'health.pl'), 'print "ok\\n";\n')
  writeFileSync(join(dir, 'helper', 'shepherdr'), 'print "ok\\n";\n')
  if (plantShell !== undefined) writeFileSync(join(dir, 'scripts', 'bad.sh'), plantShell)
  if (plantPerl !== undefined) writeFileSync(join(dir, 'helper', 'bad.pl'), plantPerl)
  return dir
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
    expect(notes.join('\n')).toContain('shell files clean')
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
