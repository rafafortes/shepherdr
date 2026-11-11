// Merging a task's branch into main here, on real git repos: git builds the merge and moves main itself, a checkout of
// main is never rewritten over work of the human's, and a refusal names the file.
import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { catchUp, landStack, mergeHere, namedFiles } from '../server/live/engine/git.ts'
import { tmp } from './tmp.ts'

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8' }).trim()

/** a repo on main */
function fresh() {
  const dir = tmp('merge')
  sh('git init -q -b main && git config user.email t@t && git config user.name T && printf "hi\\n" > README.md && printf "a\\n" > a.txt && git add -A && git commit -qm init', dir)
  return dir
}

/** a repo on main, and a task's branch off it that changes README.md */
function setup() {
  const dir = fresh()
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

  test('an ignored file of yours is not silently written over: the merge stops and names it', async () => {
    const dir = tmp('merge-ignored')
    sh('git init -q -b main && git config user.email t@t && git config user.name T && printf "secret.txt\\n" > .gitignore && git add -A && git commit -qm init', dir)
    sh('git checkout -q -b work/task && printf "theirs\\n" > secret.txt && git add -f secret.txt && git commit -qm theirs && git checkout -q main', dir)
    writeFileSync(join(dir, 'secret.txt'), 'mine\n')
    const r = await mergeHere(dir, 'work/task', 'main', 'SHE-9: Test', true)
    expect(r.ok).toBe(false)
    expect(r.err).toBe("main here holds work of its own that would be overwritten: secret.txt. Nothing was changed there. That work is not the task's: an agent leaves it alone and says so, and whoever works in that folder commits, moves or removes it first, then merge again.")
    expect(readFileSync(join(dir, 'secret.txt'), 'utf8')).toBe('mine\n')
  })

  test('a repository set to autostash still refuses work of yours in main, and stashes nothing', async () => {
    const dir = setup()
    sh('git config merge.autoStash true', dir)
    // the task changed README.md, and this is the operator's uncommitted version of it
    writeFileSync(join(dir, 'README.md'), 'mine\n')
    const r = await mergeHere(dir, 'work/task', 'main', 'SHE-5: Test', true)
    expect(r.ok).toBe(false)
    expect(r.err).toContain('README.md')
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('mine\n')
    expect(sh('git stash list', dir)).toBe('')
  })

  test('a branch main already has all of is refused, not an empty commit on main', async () => {
    const dir = fresh()
    sh('git checkout -q -b work/task && git checkout -q main', dir)
    const before = sh('git rev-parse main', dir)
    const r = await mergeHere(dir, 'work/task', 'main', 'SHE-3: Test', true)
    expect(r.ok).toBe(false)
    expect(r.err).toBe('main already has this work: nothing was merged')
    expect(sh('git rev-parse main', dir)).toBe(before)
  })

  test('a merge git cannot build at all is not called a conflict', async () => {
    const dir = fresh()
    const r = await mergeHere(dir, 'work/missing', 'main', 'SHE-4: Test', true)
    expect(r.ok).toBe(false)
    expect(r.err).toStartWith('could not build the merge: ')
  })

  test('a name git lists in its refusal is read off it, and a refusal about no file gives none', () => {
    expect(namedFiles('error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n\tb.txt\nPlease commit your changes or stash them before you merge.\nAborting')).toEqual(['a.txt', 'b.txt'])
    expect(namedFiles('fatal: Not possible to fast-forward, aborting.')).toEqual([])
  })
})

describe('catching main up with its remote', () => {
  test('a file of yours the remote also brings stops it, naming the file and what to do here', async () => {
    const dir = fresh()
    const bare = tmp('merge-origin')
    sh('git init -q --bare -b main', bare)
    sh(`git remote add origin ${bare} && git push -q origin main`, dir)
    // someone else's work lands on the remote, bringing the very name the checkout has of its own
    const clone = tmp('merge-clone')
    sh(`git clone -q ${bare} . && git config user.email t@t && git config user.name T && printf "theirs\\n" > notes.txt && git add -A && git commit -qm theirs && git push -q origin main`, clone)
    writeFileSync(join(dir, 'notes.txt'), 'mine\n')
    const r = await catchUp(dir, 'main', 'then merge again')
    expect(r.ok).toBe(false)
    expect(r.err).toBe("main here holds work of its own that would be overwritten: notes.txt. Nothing was changed there. That work is not the task's: an agent leaves it alone and says so, and whoever works in that folder commits, moves or removes it first, then merge again.")
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('mine\n')
  })
})

describe('a merge train going in', () => {
  /** the tree the stack's first commit has: main with work/task merged, built by git (no checkout touched) */
  const treeOf = (dir: string) => sh('git merge-tree --write-tree main work/task', dir).split('\n')[0]

  test('main not checked out here: its branch moves by update-ref, and the checkout here is not touched', async () => {
    const dir = setup()
    sh('git checkout -q -b elsewhere', dir)
    // work of the human's in the folder, uncommitted
    writeFileSync(join(dir, 'a.txt'), 'a, mine\n')
    const at = sh('git rev-parse main', dir)
    const ids = await landStack(dir, 'main', at, [{ tree: treeOf(dir), message: 'SHE-7: Test' }])
    expect(ids).toHaveLength(1)
    expect(sh('git rev-parse main', dir)).toBe(ids![0])
    expect(sh('git rev-parse main^', dir)).toBe(at)
    expect(sh('git log -1 --format=%s main', dir)).toBe('SHE-7: Test')
    expect(sh('git rev-parse --abbrev-ref HEAD', dir)).toBe('elsewhere')
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('hi\n')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a, mine\n')
    expect(sh('git status --porcelain', dir)).toBe('M a.txt')
  })

  test('main moved since the stack was built, checked out here: nothing changes, not the branch nor the checkout', async () => {
    const dir = setup()
    const at = sh('git rev-parse main', dir)
    const tree = treeOf(dir)
    // main moves on by a commit of its own (here, in the checkout) while the stack waits for its gate
    sh('printf "moved\n" > b.txt && git add -A && git commit -qm moved', dir)
    writeFileSync(join(dir, 'a.txt'), 'a, mine\n')
    const before = sh('git rev-parse main', dir)
    expect(await landStack(dir, 'main', at, [{ tree, message: 'SHE-8: Test' }])).toBeUndefined()
    expect(sh('git rev-parse main', dir)).toBe(before)
    expect(sh('git rev-parse --abbrev-ref HEAD', dir)).toBe('main')
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('moved\n')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a, mine\n')
    expect(sh('git status --porcelain', dir)).toBe('M a.txt')
  })

  test('main moved since the stack was built, not checked out here: its ref stays where it moved to', async () => {
    const dir = setup()
    sh('git checkout -q -b elsewhere', dir)
    const at = sh('git rev-parse main', dir)
    const tree = treeOf(dir)
    sh('git checkout -q main && printf "moved\n" > b.txt && git add -A && git commit -qm moved && git checkout -q elsewhere', dir)
    const before = sh('git rev-parse main', dir)
    expect(before).not.toBe(at)
    expect(await landStack(dir, 'main', at, [{ tree, message: 'SHE-9: Test' }])).toBeUndefined()
    expect(sh('git rev-parse main', dir)).toBe(before)
    expect(sh('git rev-parse --abbrev-ref HEAD', dir)).toBe('elsewhere')
    expect(sh('git status --porcelain', dir)).toBe('')
  })
})
