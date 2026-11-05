// Merging a task's branch into main here, on real git repos: git builds the merge and moves main itself, a checkout of
// main is never rewritten over work of the human's, and a refusal names the file.
import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeHere, namedFiles } from '../server/live/engine/git.ts'

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8' }).trim()

/** a repo on main with a task's branch off it */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'shep-merge-'))
  sh('git init -q -b main && git config user.email t@t && git config user.name T && printf "hi\\n" > README.md && printf "a\\n" > a.txt && git add -A && git commit -qm init', dir)
  sh('git checkout -q -b work/task && printf "theirs\\n" > README.md && git commit -qam task && git checkout -q main', dir)
  return dir
}

describe('merging into main here', () => {
  test('a conflict stops it, and the edit you left in main is still there: nothing is reset', async () => {
    const dir = setup()
    // the task changed README.md, and so did main: a conflict
    sh('printf "mine\\n" > README.md && git commit -qam mine', dir)
    // work of the human's, uncommitted, in that same folder
    writeFileSync(join(dir, 'a.txt'), 'a, mine\n')
    const before = sh('git rev-parse main', dir)
    const r = await mergeHere(dir, 'work/task', 'main', 'SHE-1: Test', true)
    expect(r.ok).toBe(false)
    expect(r.err).toStartWith('conflict:')
    expect(sh('git rev-parse main', dir)).toBe(before)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a, mine\n')
    expect(sh('git status --porcelain', dir)).toBe('M a.txt')
  })

  test('main checked out elsewhere: its branch moves and that checkout is not touched', async () => {
    const dir = setup()
    sh('git checkout -q -b elsewhere', dir)
    const r = await mergeHere(dir, 'work/task', 'main', 'SHE-2: Test', true)
    expect(r.ok).toBe(true)
    expect(sh('git log --format=%s -n 1 main', dir)).toBe('SHE-2: Test')
    expect(sh('git rev-parse --abbrev-ref HEAD', dir)).toBe('elsewhere')
    expect(sh('git show --name-only --format= main', dir)).toBe('README.md')
  })

  test('a name git lists in its refusal is read off it, and a refusal about no file gives none', () => {
    expect(namedFiles('error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n\tb.txt\nPlease commit your changes or stash them before you merge.\nAborting')).toEqual(['a.txt', 'b.txt'])
    expect(namedFiles('fatal: Not possible to fast-forward, aborting.')).toEqual([])
  })
})
