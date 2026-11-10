// A task going back to work in the worktree it had (its agent starts again, the way back moves it to its primary, or a
// queued task gets its go) is brought up to its base first, so what was merged meanwhile (build settings, the check,
// AGENTS.md) reaches it at once instead of at its merge. A clean worktree is rebased; one with work not committed, or
// whose rebase conflicts, is left as it was, and its agent is told what to do at its next good point. On a real git repo.
import { describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repo, sh, started, until, world } from './engine-world.ts'

/** a commit on main in the space's own checkout: what a merge of another task leaves there */
const onMain = (dir: string, file: string, text: string, subject: string) => {
  writeFileSync(join(dir, file), text)
  sh(`git add -A && git commit -qm "${subject}"`, dir)
}
const commit = (wt: string, file: string, text: string, subject: string) => {
  writeFileSync(join(wt, file), text)
  sh(`git add -A && git commit -qm "${subject}"`, wt)
}
/** main is in the branch's history */
const onTop = (wt: string) => sh('git merge-base --is-ancestor main HEAD && echo yes || echo no', wt) === 'yes'

describe('back to work on a base that moved', () => {
  test('a clean worktree is rebased on its base before its agent starts again; it hears what came in, AGENTS.md among it', async () => {
    const w = world()
    const dir = repo()
    const a = await started(w, dir, 'rb-clean', 'Work', 'Add a.txt.')
    commit(a.t.worktree!, 'a.txt', 'a\n', 'Add a.txt')
    onMain(dir, 'AGENTS.md', '# Rules\nRun the check.\n', 'Say how to run the check')
    onMain(dir, 'build.txt', 'cache on\n', 'Turn the build cache on')
    expect(onTop(a.t.worktree!)).toBe(false)
    w.agentIs(a.key, 'gone')
    await w.engine.resume(a.t.id)
    // rebased: main under its own commit, which is still there
    expect(onTop(a.t.worktree!)).toBe(true)
    expect(sh('git log --format=%s -1', a.t.worktree!)).toBe('Add a.txt')
    expect(existsSync(join(a.t.worktree!, 'build.txt'))).toBe(true)
    const first = w.started.filter((s) => s.key === a.key).at(-1)!.first!
    expect(first).toContain('<shepherdr><base>Before you went back to work, Shepherdr rebased your branch on main: 2 commits came into main since your branch began')
    expect(first).toContain('Turn the build cache on; ')
    expect(first).toContain('AGENTS.md changed among them: read it again before you go on.')
    expect(w.posted.some((p) => p.key === a.key && p.card?.text === 'Rebased on main: 2 new commits in main')).toBe(true)
  })

  test('its base did not move: nothing to do, nothing said', async () => {
    const w = world()
    const a = await started(w, repo(), 'rb-still', 'Work', 'Add a.txt.')
    const posts = w.posted.length
    w.agentIs(a.key, 'gone')
    await w.engine.resume(a.t.id)
    expect(w.started.filter((s) => s.key === a.key).at(-1)!.first ?? '').not.toContain('<base>')
    expect(w.posted.slice(posts).some((p) => p.id.startsWith('base:'))).toBe(false)
  })

  test('work not committed is left alone, and its agent is told to commit and rebase at its next good point', async () => {
    const w = world()
    const dir = repo()
    const a = await started(w, dir, 'rb-dirty', 'Work', 'Add a.txt.')
    writeFileSync(join(a.t.worktree!, 'half.txt'), 'half done\n')
    onMain(dir, 'build.txt', 'cache on\n', 'Turn the build cache on')
    const head = sh('git rev-parse HEAD', a.t.worktree!)
    w.agentIs(a.key, 'gone')
    await w.engine.resume(a.t.id)
    expect(sh('git rev-parse HEAD', a.t.worktree!)).toBe(head)
    expect(existsSync(join(a.t.worktree!, 'half.txt'))).toBe(true)
    const first = w.started.filter((s) => s.key === a.key).at(-1)!.first!
    expect(first).toContain("Your worktree has changes not committed, so Shepherdr didn't rebase it: at your next good point, commit, rebase on main (git rebase main) and run the checks.")
    expect(w.posted.some((p) => p.card?.text === 'Not rebased (changes not committed): 1 new commit in main; its agent rebases at a good point')).toBe(true)
  })

  test('a rebase that conflicts is undone: the worktree is as it was, and its agent resolves it at its next good point', async () => {
    const w = world()
    const dir = repo()
    const a = await started(w, dir, 'rb-conflict', 'Work', 'Change README.md.')
    commit(a.t.worktree!, 'README.md', 'mine\n', 'Change the readme')
    onMain(dir, 'README.md', 'theirs\n', 'Change the readme too')
    const head = sh('git rev-parse HEAD', a.t.worktree!)
    w.agentIs(a.key, 'gone')
    await w.engine.resume(a.t.id)
    expect(sh('git rev-parse HEAD', a.t.worktree!)).toBe(head)
    expect(sh('git status --porcelain', a.t.worktree!)).toBe('')
    expect(sh('git rev-parse --verify --quiet REBASE_HEAD >/dev/null && echo mid || echo none', a.t.worktree!)).toBe('none')
    const first = w.started.filter((s) => s.key === a.key).at(-1)!.first!
    expect(first).toContain('Rebasing your branch on it conflicts, so Shepherdr left your worktree as it was: at your next good point, rebase on main (git rebase main), resolve the conflicts and run the checks.')
    expect(w.posted.some((p) => p.card?.text === 'Not rebased (it conflicts): 1 new commit in main; its agent rebases at a good point')).toBe(true)
  })

  test('the way back to its primary rebases it too, and its first message after the restart says so', async () => {
    const w = world()
    const dir = repo()
    const a = await started(w, dir, 'rb-back', 'Work', 'Add a.txt.')
    commit(a.t.worktree!, 'a.txt', 'a\n', 'Add a.txt')
    onMain(dir, 'build.txt', 'cache on\n', 'Turn the build cache on')
    w.agentIs(a.key, 'idle')
    w.engine.installed = () => true
    await w.engine.restart(a.t.id, { kind: 'claude' }, 'backup')
    expect(onTop(a.t.worktree!)).toBe(true)
    expect(w.started.filter((s) => s.key === a.key).at(-1)!.first).toContain('Shepherdr rebased your branch on main: 1 commit came into main')
  })

  test('words that take an agent at rest back to work bring its branch up to its base first, and carry the note', async () => {
    const w = world()
    const dir = repo()
    const a = await started(w, dir, 'rb-words', 'Work', 'Add a.txt.')
    commit(a.t.worktree!, 'a.txt', 'a\n', 'Add a.txt')
    onMain(dir, 'AGENTS.md', '# Rules\n', 'Say the rules')
    // its turn ended without reporting done: it waits on you, its agent there
    w.agentIs(a.key, 'idle')
    expect(w.engine.statusOf(a.t)).toBe('need')
    await w.engine.tell(a.t.id, 'Go on with b.txt.')
    expect(onTop(a.t.worktree!)).toBe(true)
    const said = w.sent.filter((s) => s.key === a.key).at(-1)!.text
    expect(said).toStartWith('Go on with b.txt.\n\n<shepherdr><base>Before you went back to work, Shepherdr rebased your branch on main: 1 commit came into main')
    expect(said).toContain('AGENTS.md changed among them')
    // the next words find it on its base already: the words alone
    await w.engine.tell(a.t.id, 'And c.txt.')
    expect(w.sent.filter((s) => s.key === a.key).at(-1)!.text).toBe('And c.txt.')
  })

  test('never under an agent mid-turn (a permission, its own question) or at work: the words go in as they are', async () => {
    const w = world()
    const dir = repo()
    const a = await started(w, dir, 'rb-midturn', 'Work', 'Add a.txt.')
    onMain(dir, 'build.txt', 'cache on\n', 'Turn the build cache on')
    const head = sh('git rev-parse HEAD', a.t.worktree!)
    for (const st of ['blocked', 'working']) {
      w.agentIs(a.key, st)
      expect(await w.engine.beforeWords(a.t.id)).toBeUndefined()
    }
    w.agentIs(a.key, 'working')
    await w.engine.tell(a.t.id, 'Also d.txt.')
    expect(w.sent.filter((s) => s.key === a.key).at(-1)!.text).toBe('Also d.txt.')
    expect(sh('git rev-parse HEAD', a.t.worktree!)).toBe(head)
    // nor a task done, or one that isn't there
    expect(await w.engine.beforeWords('NOPE-1')).toBeUndefined()
  })

  test('a To do task told to go is brought up to its base too', async () => {
    const w = world()
    const dir = repo()
    const a = await started(w, dir, 'rb-todo', 'Later', "Add a.txt. Don't start yet, wait for a go.")
    w.engine.todo(a.t.id)
    w.agentIs(a.key, 'idle')
    onMain(dir, 'build.txt', 'cache on\n', 'Turn the build cache on')
    await w.engine.tell(a.t.id, 'Go.')
    expect(onTop(a.t.worktree!)).toBe(true)
    expect(w.sent.filter((s) => s.key === a.key).at(-1)!.text).toContain('<base>Before you went back to work')
  })

  test('a queued task whose agent waits in the worktree it had gets its go once it is rebased on what the one before it merged', async () => {
    const w = world()
    const dir = repo()
    const a = await started(w, dir, 'rb-go', 'First', 'Add a.txt.')
    const b = w.engine.add({ project: a.p.name, title: 'Second', desc: 'Use a.txt.', by: 'test', after: [a.t.id] })
    const bkey = `${b.id}/Agent`
    // as a task queued by an older Shepherdr waits: its agent at the brief, in a worktree from before
    await w.engine.tell(b.id, 'Read the brief.')
    await until(() => w.started.some((s) => s.key === bkey) && !!b.worktree)
    w.agentIs(bkey, 'idle')
    commit(a.t.worktree!, 'a.txt', 'a\n', 'Add a.txt')
    await w.engine.done(a.t.id, 'Added a.txt.')
    expect((await w.engine.merge(a.t.id, { self: true })).ok).toBe(true)
    await until(() => w.sent.some((s) => s.key === bkey && s.text.includes('<go>')))
    const go = w.sent.find((s) => s.key === bkey && s.text.includes('<go>'))!.text
    expect(go).toContain(`Go: ${a.t.id} is done, start now.`)
    expect(go).toContain('<base>Before you went back to work, Shepherdr rebased your branch on main')
    expect(existsSync(join(b.worktree!, 'a.txt'))).toBe(true)
  })
})
