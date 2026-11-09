// A repo's stable id, and the space found again by it (SHE-37): a folder renamed or moved, one reached through a
// symlink, a worktree (a copy that shares its .git) and the worktree of a task, each as this code sees it. Real git
// repos under /tmp, each test in a Shepherdr home of its own.
import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const { Places } = await import('../server/live/places.ts')
const { ensureRepoId, repoId, repoIdentity, REPO_ID } = await import('../server/live/engine/repo-id.ts')

const sh = (cmd: string, cwd: string) => {
  try {
    return execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8', timeout: 30_000 }).trim()
  } catch (e) {
    throw new Error(`\`${cmd}\` in ${cwd}: ${(e as Error).message.trim()}`, { cause: e })
  }
}

/** a git call that may fail (a key that isn't there): '' when it does */
const shOr = (cmd: string, cwd: string) => {
  try {
    return sh(cmd, cwd)
  } catch {
    return ''
  }
}

/** a git repo of its own in a folder of its own, with one commit */
function repo(name = 'shop') {
  const dir = join(tmp('repo-id'), name)
  mkdirSync(dir, { recursive: true })
  sh('git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init', dir)
  return dir
}

/** a Shepherdr world of its own: its spaces are this test's, whatever another test wrote */
function world() {
  process.env.SHEPHERDR_HOME = tmp('repo-id-home')
  return new Places()
}

/** the folder a repo is renamed to, next to it */
const beside = (path: string, name: string) => join(path, '..', name)

describe('a repo’s id', () => {
  test('is written in its own .git/config, once', async () => {
    const dir = repo()
    expect(await repoId(dir)).toBeNull()
    const first = await ensureRepoId(dir)
    expect(first?.own).toBe(true)
    expect(first?.id).toBeTruthy()
    expect(sh(`git config --local --get ${REPO_ID}`, dir)).toBe(first!.id!)
    // asked again, the same one: never a new id for a repo that has one
    expect((await ensureRepoId(dir))?.id).toBe(first!.id!)
    // and nothing of it is in the working tree, so a commit never carries it
    expect(sh('git status --porcelain', dir)).toBe('')
  })

  test('is left out of a folder that is not a repo, and out of a worktree', async () => {
    const plain = tmp('repo-id-plain')
    expect(await repoIdentity(plain)).toBeNull()
    expect(await ensureRepoId(plain)).toBeNull()
    expect(readdirSync(plain)).toEqual([])

    const dir = repo()
    const wt = beside(dir, 'worktree')
    sh(`git worktree add -q ${JSON.stringify(wt)}`, dir)
    // a worktree's .git is a file: not a repo of its own, so it is never given one (its config is its repo's)
    const at = await repoIdentity(wt)
    expect(at?.own).toBe(false)
    expect(at?.gitDir).toBe((await repoIdentity(dir))!.gitDir)
    expect(await ensureRepoId(wt)).toMatchObject({ own: false, id: null })
    expect(shOr(`git config --local --get ${REPO_ID}`, wt)).toBe('')
  })
})

describe('a space', () => {
  test('records its repo’s id, and a restart reads it again', async () => {
    const places = world()
    const dir = repo()
    const p = await places.add(dir, 'shop')
    expect(p.path).toBe(dir)
    expect(p.repoId!).toBe((await repoId(dir))!)
    expect(p.repoId).toBeTruthy()
    const again = new Places()
    expect(again.spaces[0]!.repoId).toBe(p.repoId!)
  })

  test('whose folder is renamed is found again by its repo’s id, with its name, key and tasks', async () => {
    const places = world()
    const before = await places.add(repo(), 'shop')
    const key = before.key
    const was = before.path
    const to = beside(was, 'shop-renamed')
    renameSync(was, to)
    // nothing moves on its own: the space keeps the folder it was added with, and is what it was
    expect(places.spaces.length).toBe(1)
    expect(places.spaces[0]!.path).toBe(was)
    expect(existsSync(was)).toBe(false)

    const found = await places.add(to)
    expect(found.name).toBe('shop')
    expect(found.key).toBe(key)
    expect(found.path).toBe(to)
    expect(found.was).toBe(was)
    expect(found.base).toBe(before.base)
    expect(found.github).toBe(before.github)
    expect(places.spaces.length).toBe(1)
    // kept, so a restart finds it there too
    expect(new Places().spaces[0]!.path).toBe(to)
    // and it says so, in the space's own line and in the doctor
    expect(places.folderLine(found)).toContain(`it was ${was}`)
    const said = (await places.doctor()).join('\n')
    expect(said).toContain(`shop: found again at ${to} (it was ${was})`)
  })

  test('reached through a symlink is that space, not a second one', async () => {
    const places = world()
    const dir = repo()
    const p = await places.add(dir, 'shop')
    const link = beside(dir, 'link')
    symlinkSync(dir, link)
    const same = await places.add(link)
    expect(same.name).toBe(p.name)
    expect(same.path).toBe(dir)
    expect(places.spaces.length).toBe(1)
  })

  test('of a worktree, a copy that shares its .git, is refused: it is the space already and never a second one', async () => {
    const places = world()
    const dir = repo()
    const p = await places.add(dir, 'shop')
    const wt = beside(dir, 'worktree')
    sh(`git worktree add -q ${JSON.stringify(wt)}`, dir)
    // the same real .git through another visible path
    expect((await repoIdentity(wt))!.gitDir).toBe((await repoIdentity(dir))!.gitDir)
    let error = ''
    try {
      await places.add(wt)
    } catch (e) {
      error = (e as Error).message
    }
    expect(error).toContain('same repo through another folder')
    expect(error).toContain(p.path)
    expect(places.spaces.length).toBe(1)
  })

  test('from before this change is not found by an id nobody wrote, then gets one on its next add', async () => {
    const places = world()
    const dir = repo()
    const p = await places.add(dir, 'shop')
    // a space from before: neither its repo nor its record has an id
    delete p.repoId
    places.save()
    sh(`git config --local --unset ${REPO_ID}`, dir)
    expect(await repoId(dir)).toBeNull()
    // added again where it is: the same space, and now with its repo's id
    const again = await places.add(dir)
    expect(again.name).toBe('shop')
    expect(again.repoId!).toBe((await repoId(dir))!)
    expect(again.repoId).toBeTruthy()
    expect(places.spaces.length).toBe(1)
  })

  test('from before this change, with its folder renamed, is a new space: nothing lands on it by an id nobody wrote', async () => {
    const places = world()
    const p = await places.add(repo(), 'shop')
    delete p.repoId
    places.save()
    sh(`git config --local --unset ${REPO_ID}`, p.path)
    const was = p.path
    const to = beside(was, 'shop-renamed')
    renameSync(was, to)
    const fresh = await places.add(to)
    expect(fresh.name).not.toBe('shop')
    expect(places.spaces.length).toBe(2)
    expect(places.spaces.find((x) => x.name === 'shop')!.path).toBe(was)
    expect((await places.doctor()).join('\n')).toContain(`shop: its folder ${was} is gone`)
  })
})

describe('the doctor', () => {
  test('gives the repos that have none their id once, and changes nothing after', async () => {
    const places = world()
    const p = await places.add(repo(), 'shop')
    delete p.repoId
    places.save()
    sh(`git config --local --unset ${REPO_ID}`, p.path)
    expect(await repoId(p.path)).toBeNull()
    await places.doctor()
    const id = places.spaces[0]!.repoId!
    expect(await repoId(p.path)).toBe(id)
    expect((await places.doctor()).join('\n')).toContain(`its repo's id ${id.slice(0, 8)}`)
    expect(places.spaces[0]!.repoId).toBe(id)
  })

  test('says a folder is gone, and how adding the repo again finds the space', async () => {
    const places = world()
    const p = await places.add(repo(), 'shop')
    renameSync(p.path, beside(p.path, 'gone'))
    const said = (await places.doctor()).join('\n')
    expect(said).toContain(`shop: its folder ${p.path} is gone`)
    expect(said).toContain(`its id ${p.repoId!.slice(0, 8)} finds this space`)
  })
})

describe('a space found again', () => {
  test('moves no folder: a task’s worktree stays where it was made', async () => {
    const places = world()
    const p = await places.add(repo(), 'shop')
    // herdr makes a task's worktree next to the space's folder; what a task keeps is its own path
    const wt = beside(p.path, 'work-1-shop')
    mkdirSync(wt)
    writeFileSync(join(wt, 'task.txt'), 'the work of SHE-1')
    const was = p.path
    const to = beside(was, 'shop-renamed')
    renameSync(was, to)
    const found = await places.add(to)
    expect(found.path).toBe(to)
    // the worktree is where it was, with what it had, and nothing new appeared beside it
    expect(readFileSync(join(wt, 'task.txt'), 'utf8')).toBe('the work of SHE-1')
    expect(readdirSync(join(to, '..')).sort()).toEqual(['shop-renamed', 'work-1-shop'])
  })
})
