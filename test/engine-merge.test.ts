// shepherdr merge on a real git repo (engine-world.ts): the squash merge into main, a conflict, your own changes in
// the space's checkout, and closing a task that has nothing to merge. A gate, a train and GitHub have files of their own.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sh, repo, world, until, started } from './engine-world.ts'
import { tmp } from './tmp.ts'

// each test runs git dozens of times and gh (a bun process of its own) up to fifty: a few seconds alone, past 20 on a
// machine as busy as a CI runner can get
setDefaultTimeout(60_000)

describe('shepherdr merge', () => {
  test('rebases on main, squash-merges into main, marks it merged and cleans up once the turn ends', async () => {
    const w = world()
    const dir = repo()
    const { t, key } = await started(w, dir, 'merges')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm "add hello"', t.worktree!)
    // main moved on since the task started
    writeFileSync(join(dir, 'other.txt'), 'other\n')
    sh('git add -A && git commit -qm other', dir)
    await w.engine.done(t.id, 'Added hello.txt.')
    // the agent itself merges, mid-turn
    const r = await w.engine.merge(t.id, { self: true })
    expect(r).toEqual({ ok: true, note: undefined })
    expect(sh('git log --format=%s -n 3', dir).split('\n')).toEqual([`${t.id}: Say hello`, 'other', 'init'])
    expect(sh('git log -1 --format=%b', dir)).toBe('Added hello.txt.')
    expect(existsSync(join(dir, 'hello.txt'))).toBe(true)
    // its squash commit is recorded: what its branch is checked against when it is put away
    expect(t.squash).toBe(sh('git rev-parse main', dir))
    expect(w.engine.statusOf(t)).toBe('done')
    expect(w.engine.view(t).agent?.status).toBe('done')
    // its row says a few words; the summary is its card's
    expect(w.engine.subOf(t)).toBe('Merged')
    expect(w.engine.view(t).said).toBe('Added hello.txt.')
    // it keeps when it finished: the Done group's order and the row's age
    expect(Date.now() - t.doneAt!).toBeLessThan(5000)
    expect(w.engine.view(t)).toMatchObject({ doneAt: t.doneAt, age: 'now' })
    // its worktree stays while its turn runs, and goes once it ends
    expect(existsSync(t.worktree!)).toBe(true)
    w.agentIs(key, 'idle')
    // the branch goes last
    await until(() => !!t.cleaned)
    expect(existsSync(t.worktree!)).toBe(false)
    expect(w.records[key].finished).toBe(true)
    expect(sh('git branch --list "work/*"', dir)).toBe('')
    expect(w.news).toContain(`${t.id} was merged`)
    expect((await w.engine.merge(t.id)).ok).toBe(false)
    // one Done card for its project's chat, however often it settles again
    w.agentIs(key, 'idle')
    expect(w.cards.filter((c) => c.status === 'done')).toEqual([{ task: t.id, status: 'done', sub: 'Merged' }])
  })

  test('a caller that waits past its deadline hears that the merge goes on', async () => {
    const w = world()
    const origin = repo()
    const dir = tmp('clone')
    sh(`git clone -q ${origin} . && git config user.email t@t && git config user.name T`, dir)
    const { t, key } = await started(w, dir, 'deadline')
    if (!t.worktree) throw new Error('a task has no worktree')
    writeFileSync(join(t.worktree, 'slow.txt'), 'slow\n')
    w.agentIs(key, 'idle')
    // a remote that takes the connection and never answers: the merge waits on it well past the caller's deadline
    const sockets = new Set<Socket>()
    const dead = createServer((s) => {
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
    })
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const port = (dead.address() as AddressInfo).port
    try {
      sh(`git remote set-url origin git://127.0.0.1:${port}/repo.git`, dir)
      w.engine.mergeFetchMs = 2_000
      w.engine.mergeDeadline = 200
      const began = Date.now()
      const r = await w.engine.merge(t.id, { self: true })
      expect(Date.now() - began).toBeLessThan(5_000)
      // its caller hears that it goes on, and the merge itself is not cut: it goes in from main as it is here
      expect(r.ok).toBe(false)
      expect(r.error).toContain("isn't through after")
      const merging = (w.engine as unknown as { runner: { merging: Map<string, unknown> } }).runner.merging
      await until(() => !merging.has(dir), 20_000)
      expect(t.merged).toBe(true)
      expect(sh('git log --format=%s -n 1', dir)).toBe(`${t.id}: Say hello`)
    } finally {
      for (const s of sockets) s.destroy()
      dead.close()
    }
  })

  test('a merge waiting in line behind a slow one says so when its caller waits past the deadline', async () => {
    const w = world()
    const dir = repo()
    const { p, t, key } = await started(w, dir, 'inline')
    // the next merge into this repo, ready before the first is asked for
    const b = w.engine.add({ project: p.name, title: 'Second', desc: 'Second change', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${b.id}/Agent`))
    if (!t.worktree || !b.worktree) throw new Error('a task has no worktree')
    writeFileSync(join(t.worktree, 'one.txt'), 'one\n')
    writeFileSync(join(b.worktree, 'two.txt'), 'two\n')
    w.agentIs(key, 'idle')
    w.agentIs(`${b.id}/Agent`, 'idle')
    // a gate that takes its time: the second merge waits in line while the first runs it
    expect(w.settings.set('merge.gate', 'sleep 1', { space: p.name }).ok).toBe(true)
    const first = w.engine.merge(t.id, { self: true })
    await until(() => t.landing?.step === 'gate', 10_000)
    w.engine.mergeDeadline = 200
    const second = await w.engine.merge(b.id, { self: true })
    // its caller hears whose merge it waits behind, and goes on by itself
    expect(second.ok).toBe(false)
    expect(second.error).toContain(`waits in line behind ${t.id}'s`)
    expect((await first).ok).toBe(true)
    const merging = (w.engine as unknown as { runner: { merging: Map<string, unknown> } }).runner.merging
    await until(() => !merging.has(dir) && !!b.merged, 20_000)
    expect(sh('git log --format=%s -n 2', dir).split('\n')).toEqual([`${b.id}: Second`, `${t.id}: Say hello`])
  })

  test('merged by you while its agent waits: cleaned up at once', async () => {
    const w = world()
    const dir = repo()
    const { t, key } = await started(w, dir, 'byyou')
    writeFileSync(join(t.worktree!, 'x.txt'), 'x\n')
    // left uncommitted: the merge commits it
    w.agentIs(key, 'idle')
    expect((await w.engine.merge(t.id)).ok).toBe(true)
    expect(existsSync(join(dir, 'x.txt'))).toBe(true)
    expect(existsSync(t.worktree!)).toBe(false)
  })

  test('a conflict with main stops it with what to do, and main stays as it was', async () => {
    const w = world()
    const dir = repo()
    const { t } = await started(w, dir, 'conflicts')
    writeFileSync(join(t.worktree!, 'README.md'), 'theirs\n')
    sh('git commit -qam theirs', t.worktree!)
    writeFileSync(join(dir, 'README.md'), 'mine\n')
    sh('git commit -qam mine', dir)
    const before = sh('git rev-parse HEAD', dir)
    const r = await w.engine.merge(t.id, { self: true })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Conflict with main')
    expect(r.error).toContain(`shepherdr merge ${t.id} again`)
    expect(sh('git rev-parse HEAD', dir)).toBe(before)
    expect(sh('git status --porcelain', t.worktree!)).toBe('')
    expect(t.merged).toBeFalsy()
  })

  test('a change of yours in the space’s checkout that the merge does not touch: the merge goes in and that change stays', async () => {
    const w = world()
    const dir = repo()
    const { t } = await started(w, dir, 'stray')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', t.worktree!)
    // the space's folder is the operator's own working copy: an edit of theirs, never committed
    writeFileSync(join(dir, 'README.md'), 'mine, not committed\n')
    w.agentIs(`${t.id}/Agent`, 'idle')
    expect((await w.engine.merge(t.id)).ok).toBe(true)
    // the merge went in
    expect(sh('git log --format=%s -n 2', dir).split('\n')).toEqual([`${t.id}: Say hello`, 'init'])
    expect(existsSync(join(dir, 'hello.txt'))).toBe(true)
    // and their edit is still there, uncommitted, and not part of the merge commit
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('mine, not committed\n')
    expect(sh('git status --porcelain', dir)).toBe('M README.md')
    expect(sh('git show --name-only --format= HEAD', dir)).toBe('hello.txt')
  })

  test('a change of yours in the space’s checkout that the merge would overwrite stops it, naming the file, and is kept', async () => {
    const w = world()
    const dir = repo()
    const { t, key } = await started(w, dir, 'overwrites')
    // the task changes README.md, and so did the operator, uncommitted, in the space's own checkout
    writeFileSync(join(t.worktree!, 'README.md'), 'theirs\n')
    sh('git commit -qam theirs', t.worktree!)
    writeFileSync(join(dir, 'README.md'), 'mine, not committed\n')
    const before = sh('git rev-parse main', dir)
    w.agentIs(key, 'idle')
    const r = await w.engine.merge(t.id)
    expect(r.ok).toBe(false)
    expect(r.error).toBe(
      "main here holds work of its own that would be overwritten: README.md. Nothing was changed there. That work is not the task's: an agent leaves it alone and says so, and whoever works in that folder commits, moves or removes it first, then merge again.",
    )
    // nothing there was lost or changed: their edit, and main, are as they were
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('mine, not committed\n')
    expect(sh('git status --porcelain', dir)).toBe('M README.md')
    expect(sh('git rev-parse main', dir)).toBe(before)
    expect(t.merged).toBeFalsy()
  })

  test('a new file of yours in the space’s checkout that the task adds stops it too, naming it', async () => {
    const w = world()
    const dir = repo()
    const { t, key } = await started(w, dir, 'minefirst')
    writeFileSync(join(t.worktree!, 'notes.txt'), 'the task’s\n')
    sh('git add -A && git commit -qm notes', t.worktree!)
    // theirs, untracked, with the same name the merge would bring in
    writeFileSync(join(dir, 'notes.txt'), 'mine, untracked\n')
    w.agentIs(key, 'idle')
    const r = await w.engine.merge(t.id)
    expect(r.ok).toBe(false)
    expect(r.error).toBe(
      "main here holds work of its own that would be overwritten: notes.txt. Nothing was changed there. That work is not the task's: an agent leaves it alone and says so, and whoever works in that folder commits, moves or removes it first, then merge again.",
    )
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('mine, untracked\n')
  })

  test('a staged change of yours in the space’s checkout that the merge does not touch is neither lost nor taken in', async () => {
    const w = world()
    const dir = repo()
    const { t } = await started(w, dir, 'staged')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', t.worktree!)
    // staged in the operator's own checkout, never committed
    writeFileSync(join(dir, 'README.md'), 'staged, not committed\n')
    sh('git add README.md', dir)
    w.agentIs(`${t.id}/Agent`, 'idle')
    expect((await w.engine.merge(t.id)).ok).toBe(true)
    // still staged, and out of the merge commit
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('staged, not committed\n')
    expect(sh('git diff --cached --name-only', dir)).toBe('README.md')
    expect(sh('git status --porcelain', dir)).toBe('M  README.md')
    expect(sh('git show --name-only --format= HEAD', dir)).toBe('hello.txt')
  })

  test('a late message it has not read yet stops the merge until it has', async () => {
    const w = world()
    const dir = repo()
    const { t, key } = await started(w, dir, 'late')
    writeFileSync(join(t.worktree!, 'late.txt'), 'late\n')
    sh('git add -A && git commit -qm late', t.worktree!)
    // you wrote while it finished; it hasn't taken your words in yet
    w.chat.unseen = ['Also rename the button']
    const r = await w.engine.merge(t.id, { self: true })
    expect(r).toEqual({ ok: false, error: 'You have a new message in your chat: read and handle it, then merge again.' })
    expect(existsSync(join(dir, 'late.txt'))).toBe(false)
    expect(t.merged).toBeFalsy()
    w.agentIs(key, 'idle')
    expect((await w.engine.merge(t.id)).error).toBe(`${t.id}'s agent has a new message it hasn't read yet: let it handle that first.`)
    // it read it: the merge goes in
    w.chat.unseen = []
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    expect(existsSync(join(dir, 'late.txt'))).toBe(true)
  })

  test('anyone else waits for the agent to end its turn: no half-done work goes in', async () => {
    const w = world()
    const dir = repo()
    const { t, key } = await started(w, dir, 'busy')
    writeFileSync(join(t.worktree!, 'half.txt'), 'half\n')
    const r = await w.engine.merge(t.id)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('is working')
    expect(existsSync(join(dir, 'half.txt'))).toBe(false)
    w.agentIs(key, 'idle')
    expect((await w.engine.merge(t.id)).ok).toBe(true)
  })

  test('two merges into one repo at once both go in, one after the other', async () => {
    const w = world()
    const dir = repo()
    const a = await started(w, dir, 'two', 'First', 'a')
    const b = w.engine.add({ project: a.p.name, title: 'Second', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${b.id}/Agent`))
    writeFileSync(join(a.t.worktree!, 'a.txt'), 'a\n')
    writeFileSync(join(b.worktree!, 'b.txt'), 'b\n')
    const [ra, rb] = await Promise.all([w.engine.merge(a.t.id, { self: true }), w.engine.merge(b.id, { self: true })])
    expect([ra.ok, rb.ok]).toEqual([true, true])
    expect(existsSync(join(dir, 'a.txt')) && existsSync(join(dir, 'b.txt'))).toBe(true)
    expect(sh('git status --porcelain', dir)).toBe('')
  })

  test('with a remote, main here first catches up with it, so the merge sits on top of what is there', async () => {
    const w = world()
    const origin = repo()
    const dir = tmp('clone')
    sh(`git clone -q ${origin} . && git config user.email t@t && git config user.name T`, dir)
    const { t } = await started(w, dir, 'remote')
    // someone else's work lands on the remote; main here never pulled it
    writeFileSync(join(origin, 'theirs.txt'), 'theirs\n')
    sh('git add -A && git commit -qm theirs', origin)
    writeFileSync(join(t.worktree!, 'mine.txt'), 'mine\n')
    w.agentIs(`${t.id}/Agent`, 'idle')
    expect((await w.engine.merge(t.id)).ok).toBe(true)
    expect(sh('git log --format=%s -n 3', dir).split('\n')).toEqual([`${t.id}: Say hello`, 'theirs', 'init'])
    // the task's commit holds only its own change
    expect(sh('git show --name-only --format= HEAD', dir)).toBe('mine.txt')
  })

  test('a fetch that never answers ends the merge with words and frees the repo for the next one', async () => {
    const w = world()
    const origin = repo()
    const dir = tmp('clone')
    sh(`git clone -q ${origin} . && git config user.email t@t && git config user.name T`, dir)
    const { p, t, key } = await started(w, dir, 'hungfetch')
    // the next merge into this repo, ready before the first is asked for
    const b = w.engine.add({ project: p.name, title: 'Second', desc: 'Second change', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${b.id}/Agent`))
    if (!t.worktree || !b.worktree) throw new Error('a task has no worktree')
    writeFileSync(join(b.worktree, 'second.txt'), 'second\n')
    w.agentIs(`${b.id}/Agent`, 'idle')
    writeFileSync(join(t.worktree, 'mine.txt'), 'mine\n')
    // a remote that takes the connection and never answers: git fetch waits until the bound kills it
    const sockets = new Set<Socket>()
    const dead = createServer((s) => {
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
    })
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const port = (dead.address() as AddressInfo).port
    try {
      sh(`git remote set-url origin git://127.0.0.1:${port}/repo.git`, dir)
      w.engine.mergeFetchMs = 600
      w.engine.mergeDeadline = 5_000
      w.agentIs(key, 'idle')
      const began = Date.now()
      const r = await w.engine.merge(t.id, { self: true })
      expect(Date.now() - began).toBeLessThan(15_000)
      // offline is not a refusal: it merged from main as it is here, and the note says the remote did not answer
      expect(r.ok).toBe(true)
      expect(r.note).toContain('origin did not answer')
      expect(sh('git log --format=%s -n 1', dir)).toBe(`${t.id}: Say hello`)
      const merging = (w.engine as unknown as { runner: { merging: Map<string, unknown> } }).runner.merging
      await until(() => !merging.has(dir))
      // the next merge into this repo goes in on its own: it is not stuck behind the one that hung
      const second = Date.now()
      expect((await w.engine.merge(b.id, { self: true })).ok).toBe(true)
      expect(Date.now() - second).toBeLessThan(15_000)
      expect(sh('git log --format=%s -n 2', dir).split('\n')[1]).toBe(`${t.id}: Say hello`)
      await until(() => !merging.has(dir))
    } finally {
      for (const s of sockets) s.destroy()
      dead.close()
    }
  })

  test('a branch already merged by hand is only marked merged', async () => {
    const w = world()
    const dir = repo()
    const { t } = await started(w, dir, 'byhand')
    writeFileSync(join(t.worktree!, 'y.txt'), 'y\n')
    sh('git add -A && git commit -qm y', t.worktree!)
    sh(`git merge -q --squash ${t.branch} && git commit -qm "by hand"`, dir)
    const r = await w.engine.merge(t.id, { self: true })
    expect(r).toEqual({ ok: true, note: 'it was in main already' })
    expect(sh('git log --format=%s -n 1', dir)).toBe('by hand')
    expect(w.engine.statusOf(t)).toBe('done')
  })

  for (const how of ['squashed', 'with a merge commit'])
    test(`its pull request merged on GitHub ${how}, and main moved on since: only marked merged`, async () => {
      const w = world()
      const dir = repo()
      const { t } = await started(w, dir, `pr-${how.split(' ').at(-1)}`)
      // two commits, the second changing the first (a review fix)
      writeFileSync(join(t.worktree!, 'p.txt'), 'p\n')
      sh('git add -A && git commit -qm p', t.worktree!)
      writeFileSync(join(t.worktree!, 'p.txt'), 'p, fixed\n')
      sh('git add -A && git commit -qm fix', t.worktree!)
      sh(how === 'squashed' ? `git merge -q --squash ${t.branch} && git commit -qm "PR #1"` : `git merge -q --no-ff -m "PR #1" ${t.branch}`, dir)
      writeFileSync(join(dir, 'later.txt'), 'later\n')
      sh('git add -A && git commit -qm later', dir)
      const r = await w.engine.merge(t.id, { self: true })
      expect(r).toEqual({ ok: true, note: 'it was in main already' })
      expect(sh('git log --format=%s -n 2', dir).split('\n')).toEqual(['later', 'PR #1'])
      expect(w.engine.statusOf(t)).toBe('done')
    })

  test('nothing to merge is refused', async () => {
    const w = world()
    const { t } = await started(w, repo(), 'empty')
    const r = await w.engine.merge(t.id, { self: true })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('no changes')
  })
})

describe('closed with nothing to merge', () => {
  const branches = (dir: string) => sh('git branch --list "work/*" --format="%(refname:short)"', dir)

  test('done on a branch with no changes goes straight to Done, closed, and is put away once its turn ends', async () => {
    const w = world()
    const dir = repo()
    const { t, key } = await started(w, dir, 'answer', 'Answer a question', 'Find out why. Report done.')
    expect((await w.engine.done(t.id, 'It is the clock.')).state).toBe('closed')
    expect(t.closed).toBe(true)
    expect(t.merged).toBeFalsy()
    expect(w.engine.statusOf(t)).toBe('done')
    expect(w.engine.subOf(t)).toBe('Nothing to merge')
    expect(w.engine.view(t).said).toBe('It is the clock.')
    expect(w.engine.view(t).state).toStartWith('Done · nothing to merge')
    expect(w.news).toContain(`${t.id} is done, nothing to merge: It is the clock.`)
    // mid-turn: its worktree stays until the turn ends
    expect(existsSync(t.worktree!)).toBe(true)
    w.agentIs(key, 'idle')
    await until(() => !!t.cleaned)
    expect(existsSync(t.worktree!)).toBe(false)
    expect(branches(dir)).toBe('')
    expect(w.records[key].finished).toBe(true)
    w.agentIs(key, 'idle')
    expect(w.cards.filter((c) => c.status === 'done')).toEqual([{ task: t.id, status: 'done', sub: 'Nothing to merge' }])
    expect(sh('git log --format=%s', dir)).toBe('init')
    const r = await w.engine.merge(t.id, { self: true })
    expect(r.error).toContain('it had nothing to merge')
    expect((await w.engine.done(t.id, 'again')).state).toBe('ended')
    expect(() => w.engine.todo(t.id)).toThrow('Done already (nothing to merge)')
  })

  test('done with changes, committed or not, is Ready as before', async () => {
    const w = world()
    const { t } = await started(w, repo(), 'readyagain')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    expect((await w.engine.done(t.id, 'Added hello.txt.')).state).toBe('ready')
    sh('git add -A && git commit -qm hello', t.worktree!)
    expect((await w.engine.done(t.id, 'Added hello.txt.')).state).toBe('ready')
    expect(t.closed).toBeFalsy()
  })

  test('task close stops its agent, puts its worktree and branch away and marks it Done, Nothing to merge by default', async () => {
    const w = world()
    const dir = repo()
    const { t, key } = await started(w, dir, 'closes')
    // its agent is at work
    expect(await w.engine.close(t.id)).toEqual({ kept: [] })
    expect(w.records[key].finished).toBe(true)
    expect(w.engine.statusOf(t)).toBe('done')
    expect(w.engine.subOf(t)).toBe('Nothing to merge')
    // closed is when it finished, as merged is
    expect(w.engine.view(t)).toMatchObject({ doneAt: t.doneAt, age: 'now' })
    expect(existsSync(t.worktree!)).toBe(false)
    expect(branches(dir)).toBe('')
    expect(w.herdr.spaces.some((x) => x.label === `${t.id} Say hello`)).toBe(false)
    expect(w.news.some((n) => n.startsWith(`${t.id} is done, nothing to merge`))).toBe(true)
    expect(w.cards.filter((c) => c.status === 'done')).toEqual([{ task: t.id, status: 'done', sub: 'Nothing to merge' }])
    await expect(w.engine.close(t.id)).rejects.toThrow('Done already (nothing to merge)')
  })

  test('task close keeps unmerged work and says so; the sweep leaves it be', async () => {
    const w = world()
    const dir = repo()
    const { t } = await started(w, dir, 'closekeeps')
    writeFileSync(join(t.worktree!, 'wip.txt'), 'wip\n')
    sh('git add -A && git commit -qm wip', t.worktree!)
    const { kept } = await w.engine.close(t.id, 'Not needed any more.')
    expect(kept).toEqual([`${t.worktree!.replace(homedir(), '~')} (work on ${t.branch} that main lacks)`])
    expect(w.engine.view(t).said).toBe('Not needed any more.')
    expect(existsSync(join(t.worktree!, 'wip.txt'))).toBe(true)
    expect(branches(dir)).toBe(t.branch!)
    expect(w.engine.keptLeftovers()[0]).toStartWith(`${t.id} `)
    await w.engine.sweep()
    expect(existsSync(t.worktree!)).toBe(true)
  })

  test('a Ready task closed without a summary keeps what it said when done', async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'closeready')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    expect((await w.engine.done(t.id, 'Drafted it; not wanted after all.')).state).toBe('ready')
    w.agentIs(key, 'idle')
    const { kept } = await w.engine.close(t.id)
    expect(kept[0]).toEndWith('(uncommitted changes)')
    expect(w.engine.view(t).said).toBe('Drafted it; not wanted after all.')
  })

  test('the engine hands the merge to its own module and still says the task is gone', async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'delegate')
    writeFileSync(join(t.worktree as string, 'gone.txt'), 'gone\n')
    // the event a merge made in engine.ts always emitted, and the news with it: the delegate changes neither (SHE-159)
    const gone: { id: string; forget: boolean }[] = []
    w.engine.on('gone', (x, forget) => gone.push({ id: x.id, forget }))
    w.agentIs(key, 'idle')
    expect((await w.engine.merge(t.id)).ok).toBe(true)
    expect(gone).toEqual([{ id: t.id, forget: true }])
    expect(w.news).toContain(`${t.id} was merged`)
    expect(w.engine.statusOf(t)).toBe('done')
  })

  test('a stopped task stuck in To do, its worktree already gone, closes', async () => {
    const w = world()
    const dir = repo()
    const { t } = await started(w, dir, 'stuck', 'Look into it', "Don't start yet, wait for a go.")
    w.engine.todo(t.id)
    await w.engine.stopTask(t.id)
    expect(w.engine.statusOf(t)).toBe('todo')
    expect(await w.engine.close(t.id, 'Answered elsewhere.')).toEqual({ kept: [] })
    expect(w.engine.statusOf(t)).toBe('done')
    expect(t.cleaned).toBe(true)
  })
})
