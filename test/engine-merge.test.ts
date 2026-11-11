// shepherdr merge on a real git repo (engine-world.ts): it squash-merges into main and cleans up, here (rebased) or
// through a pull request on GitHub (a stand-in; rebased only on a conflict).
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { sh, repo, world, until, started, G, Settings } from './engine-world.ts'
import type { FakeGitHub } from './fake-gh.ts'
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
    expect(r.error).toBe("main here holds work of its own that would be overwritten: README.md. Nothing was changed there. That work is not the task's: an agent leaves it alone and says so, and whoever works in that folder commits, moves or removes it first, then merge again.")
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
    expect(r.error).toBe("main here holds work of its own that would be overwritten: notes.txt. Nothing was changed there. That work is not the task's: an agent leaves it alone and says so, and whoever works in that folder commits, moves or removes it first, then merge again.")
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

  describe("the space's merge gate", () => {
    /** a task with a commit of its own, reported done, and its space's gate set to `cmd` */
    async function gated(name: string, cmd: string) {
      const w = world()
      const dir = repo()
      const s = await started(w, dir, name)
      writeFileSync(join(s.t.worktree!, 'hello.txt'), 'hello\n')
      sh('git add -A && git commit -qm "add hello"', s.t.worktree!)
      expect(w.settings.set('merge.gate', cmd, { space: s.p.name }).ok).toBe(true)
      await w.engine.done(s.t.id, 'Added hello.txt.')
      return { w, dir, ...s }
    }

    test('it runs in the worktree after the rebase: exit 0 lets it in, and its last line goes into the merge commit', async () => {
      const { w, dir, t } = await gated('gate-ok', 'test -f hello.txt && echo checking && echo "Merge gate: green for $SHEPHERDR_TASK on $SHEPHERDR_BASE"')
      expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
      expect(sh('git log -1 --format=%b', dir)).toBe(`Added hello.txt.\n\nMerge gate: green for ${t.id} on main`)
      // a run's files go once its outcome is read
      expect(readdirSync(join(process.env.SHEPHERDR_HOME!, 'gates'))).toEqual([])
      expect(w.engine.statusOf(t)).toBe('done')
    })

    test('anything but exit 0 refuses the merge with the end of its output; main is as it was, and the task is Ready again', async () => {
      const { w, dir, t } = await gated('gate-red', 'echo building; echo "2 tests failed" >&2; exit 3')
      const main = sh('git rev-parse main', dir)
      const r = await w.engine.merge(t.id, { self: true })
      expect(r.ok).toBe(false)
      expect(r.error).toBe(`${t.id}'s merge gate (echo building; echo "2 tests failed" >&2; exit 3) failed (exit 3): nothing was merged, and main is as it was. Its output ends:\nbuilding\n2 tests failed\nThe merge gate is the merge's full check: fix what its lines name, prove the fix with targeted tests, then run shepherdr merge again; no full check of your own first.`)
      expect(sh('git rev-parse main', dir)).toBe(main)
      expect(sh('git status --porcelain', dir)).toBe('')
      expect(t.merged).toBeFalsy()
      expect(t.landing).toBeUndefined()
      // its row says why until its next merge starts: the last line the gate printed
      expect(w.engine.statusOf(t)).not.toBe('merging')
      // the last line it wrote, its errors included
      expect(w.engine.subOf(t)).toBe('Refused by the gate: 2 tests failed')
      w.settings.set('merge.gate', 'echo fine', { space: w.engine.view(t).place.split(':').pop()! })
      expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
      expect(t.mergeStop).toBeUndefined()
    })

    test('two merges into one repo: the one gating says so, the next waits for its runs; a conflict is no merging', async () => {
      const go = join(tmp('gate-go'), 'go')
      const w = world()
      const dir = repo()
      const a = await started(w, dir, 'gate-line', 'First', 'Add a.txt.')
      writeFileSync(join(a.t.worktree!, 'a.txt'), 'a\n')
      sh('git add -A && git commit -qm "add a"', a.t.worktree!)
      expect(w.settings.set('merge.gate', `while [ ! -f ${go} ]; do sleep 0.05; done; echo ok`, { space: a.p.name }).ok).toBe(true)
      const b = w.engine.add({ project: a.p.name, title: 'Second', desc: 'Add b.txt.', by: 'test' })
      await until(() => !!b.worktree)
      writeFileSync(join(b.worktree!, 'b.txt'), 'b\n')
      sh('git add -A && git commit -qm "add b"', b.worktree!)
      await w.engine.done(a.t.id, 'Added a.txt.')
      await w.engine.done(b.id, 'Added b.txt.')
      const first = w.engine.merge(a.t.id, { self: true })
      await until(() => a.t.landing?.step === 'gate')
      expect(w.engine.subOf(a.t)).toBe('Running the merge gate')
      const second = w.engine.merge(b.id, { self: true })
      expect(w.engine.statusOf(b)).toBe('merging')
      expect(w.engine.subOf(b)).toBe(`Waiting for the merge gate (${a.t.id}'s runs)`)
      writeFileSync(go, 'go\n')
      expect((await first).ok).toBe(true)
      expect((await second).ok).toBe(true)
      // without a gate, the words say whose merge it waits for
      expect((await import('../server/live/engine/engine.ts')).landingLine({ step: 'queue', at: 0, behind: 'X-1' })).toBe("Waiting for X-1's merge")
      // a conflict hands the rebase to its agent: its own status, and the row says why
      const c = w.engine.add({ project: a.p.name, title: 'Third', desc: 'Change README.md.', by: 'test' })
      await until(() => !!c.worktree)
      writeFileSync(join(c.worktree!, 'README.md'), 'theirs\n')
      sh('git commit -qam theirs', c.worktree!)
      writeFileSync(join(dir, 'README.md'), 'mine\n')
      sh('git commit -qam mine', dir)
      await w.engine.done(c.id, 'Changed README.md.')
      expect((await w.engine.merge(c.id, { self: true })).error).toContain('Conflict with main')
      expect(c.landing?.step).toBe('rebase')
      expect(w.engine.statusOf(c)).not.toBe('merging')
      expect(w.engine.subOf(c)).toBe('Merge stopped on a conflict with main: rebasing by hand')
    })

    test('one that runs too long is stopped and refuses the merge; while it runs, merge says so and goes on', async () => {
      const { w, t } = await gated('gate-slow', 'sleep 5')
      w.engine.gateTimeout = 1500
      const first = w.engine.merge(t.id, { self: true })
      await until(() => t.landing?.step === 'gate')
      // asked again while the gate runs: it waits for the same one, and by its deadline says the gate still runs
      w.engine.mergeDeadline = 100
      expect((await w.engine.merge(t.id, { self: true })).error).toContain('its merge gate still runs')
      w.engine.mergeDeadline = 30_000
      expect((await first).error).toContain(`${t.id}'s merge gate (sleep 5) didn't finish in 2 s: nothing was merged`)
    })

    test('main moved while it ran: the branch is rebased on it and the gate runs again; a conflict then stops it', async () => {
      const mark = join(tmp('gate-mark'), 'ran')
      const { w, dir, t } = await gated('gate-moved', `echo run >> ${mark}; if [ $(wc -l < ${mark}) = 1 ]; then (cd ${'$'}MAIN && echo other > other.txt && git add -A && git commit -qm "moved meanwhile"); fi; echo "gate ok"`)
      process.env.MAIN = dir
      expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
      expect(readFileSync(mark, 'utf8').trim().split('\n')).toHaveLength(2)
      expect(sh('git log --format=%s -n 3', dir).split('\n')).toEqual([`${t.id}: Say hello`, 'moved meanwhile', 'init'])
      // a conflicting change on main meanwhile: nothing goes in, and the agent rebases by hand
      const c = await gated('gate-conflict', `cd ${'$'}MAIN2 && test -f moved || (touch moved && echo theirs > hello.txt && git add hello.txt && git commit -qm "theirs too")`)
      process.env.MAIN2 = c.dir
      const r = await c.w.engine.merge(c.t.id, { self: true })
      expect(r.error).toStartWith('Conflict with main, which moved while the merge gate ran')
      expect(c.t.landing?.step).toBe('rebase')
      delete process.env.MAIN
      delete process.env.MAIN2
    })

    test('main that keeps moving while it runs: after a few rounds the merge gives up for now', async () => {
      const { w, dir, t } = await gated('gate-busy', `(cd ${'$'}MAIN3 && date +%s%N > busy.txt && git add -A && git commit -qm busy)`)
      process.env.MAIN3 = dir
      const r = await w.engine.merge(t.id, { self: true })
      expect(r.error).toBe(`main kept moving while ${t.id}'s merge gate ran (3 times): nothing was merged. Run shepherdr merge ${t.id} again.`)
      delete process.env.MAIN3
    })

    test('a merge that runs past its deadline tells its agent to end its turn, then wakes it with how it went', async () => {
      const go = join(tmp('gate-late'), 'go')
      const { w, t, key } = await gated('gate-late', `while [ ! -f ${go} ]; do sleep 0.05; done; echo "Gate: green"`)
      const run = w.engine.merge(t.id, { self: true })
      // in its gate (a loaded machine takes a while to get there): asked now, its deadline says so
      await until(() => t.landing?.step === 'gate')
      w.engine.mergeDeadline = 100
      const first = await w.engine.merge(t.id, { self: true })
      expect(first.error).toContain(`${t.id}'s merge is in its gate: its merge gate still runs`)
      expect(first.error).toContain('end your turn now, without polling or sleeping')
      // waiting in its gate, it holds none of the machine's slots
      expect(w.engine.working()).toBe(0)
      writeFileSync(go, 'go\n')
      await until(() => w.sent.some((x) => x.key === key && x.text.includes('Your merge went in')))
      expect(w.engine.statusOf(t)).toBe('done')
      expect((await run).ok).toBe(true)
    })

    test('a restart leaves its gate running: the Shepherdr that comes back goes on from it, and its agent hears how it went', async () => {
      const go = join(tmp('gate-resume'), 'go')
      const { w, dir, t, key } = await gated('gate-resume', `while [ ! -f ${go} ]; do sleep 0.05; done; echo "Gate: green after the restart"`)
      const { startGate } = await import('../server/live/engine/engine.ts')
      // as a restart leaves it: its merge in its gate, its gate's process going on by itself
      sh(`git rebase -q main`, t.worktree!)
      const head = sh('git rev-parse HEAD', t.worktree!)
      const tip = sh('git rev-parse main', dir)
      t.landing = { step: 'gate', at: Date.now() }
      t.gateRun = startGate(`while [ ! -f ${go} ]; do sleep 0.05; done; echo "Gate: green after the restart"`, t.worktree!, {}, tmp('gate-files'), t.id, { head, tip })
      w.engine.resumeMerges()
      await until(() => t.landing?.step === 'gate')
      writeFileSync(go, 'go\n')
      await until(() => w.sent.some((x) => x.key === key && x.text.includes('Your merge went in')))
      expect(sh('git log -1 --format=%b', dir)).toContain('Gate: green after the restart')
    })

    test('a merge a restart cut short with nothing left of it is back at its turn: its row and its agent say to merge again', async () => {
      const { w, t, key } = await gated('gate-lost', 'echo fine')
      t.landing = { step: 'gate', at: Date.now() }
      t.gateRun = { pid: 999_999_999, log: '/nonexistent/log', exit: '/nonexistent/exit', at: Date.now(), head: 'x', tip: 'y' }
      w.engine.resumeMerges()
      expect(t.landing).toBeUndefined()
      expect(t.gateRun).toBeUndefined()
      expect(w.engine.subOf(t)).toBe('Merge gate interrupted by a restart: run shepherdr merge again')
      expect(w.sent.filter((x) => x.key === key).at(-1)!.text).toContain(`Shepherdr restarted while your merge ran (its gate was stopped): nothing was merged. Run shepherdr merge ${t.id} again.`)
      t.landing = { step: 'merge', at: Date.now() }
      w.engine.resumeMerges()
      expect(w.engine.subOf(t)).toBe('Merge interrupted by a restart: run shepherdr merge again')
    })

    test('a run the merge does not pick up is thrown away with its files, its process left to end: the gates folder keeps none of them', async () => {
      const go = join(tmp('gate-stale-merge'), 'go')
      const { w, t } = await gated('gate-stale-merge', 'echo green')
      const { startGate } = await import('../server/live/engine/engine.ts')
      const gates = join(process.env.SHEPHERDR_HOME!, 'gates')
      // a run a restart left going at another head: the merge starts its own, and drops that one
      const stale = startGate(`while [ ! -f ${go} ]; do sleep 0.05; done; echo stale`, t.worktree!, {}, gates, t.id, { head: 'old-head', tip: 'old-tip' })
      t.gateRun = stale
      expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
      expect(readdirSync(gates)).toEqual([])
      // its process is not killed: it goes on, and as it ends it writes its exit code, which goes too
      const running = () => {
        try {
          process.kill(stale.pid, 0)
          return true
        } catch {
          return false
        }
      }
      expect(running()).toBe(true)
      writeFileSync(go, 'go\n')
      await until(() => !running())
      await until(() => readdirSync(gates).length === 0)
    })

    test('a restart that finds a gate run dead with no exit code drops it with its files', async () => {
      const { w, t } = await gated('gate-dead', 'echo fine')
      const gates = join(process.env.SHEPHERDR_HOME!, 'gates')
      mkdirSync(gates, { recursive: true })
      // what a run left when it died before its exit code: its log, and a half-written exit file
      const log = join(gates, 'dead.log')
      writeFileSync(log, 'partial\n')
      writeFileSync(join(gates, 'dead.exit.tmp'), '')
      t.landing = { step: 'gate', at: Date.now() }
      t.gateRun = { pid: 999_999_999, log, exit: join(gates, 'dead.exit'), at: Date.now(), head: 'x', tip: 'y' }
      w.engine.resumeMerges()
      expect(t.gateRun).toBeUndefined()
      expect(readdirSync(gates)).toEqual([])
      expect(w.engine.subOf(t)).toBe('Merge gate interrupted by a restart: run shepherdr merge again')
    })

    test('a stale run of the same task, still going after a newer one began, never writes over the newer run\'s exit code', async () => {
      const { startGate, waitGate } = await import('../server/live/engine/engine.ts')
      const dir = tmp('gate-stale')
      const goOld = join(dir, 'go-old')
      const goNew = join(dir, 'go-new')
      // the run a restart left going (its head is no longer the one a merge asks for), and the one that replaced it
      const old = startGate(`while [ ! -f ${goOld} ]; do sleep 0.05; done; echo old; exit 0`, dir, {}, dir, 'STALE-1', { head: 'h1', tip: 't' })
      const fresh = startGate(`while [ ! -f ${goNew} ]; do sleep 0.05; done; echo new; exit 3`, dir, {}, dir, 'STALE-1', { head: 'h2', tip: 't' })
      expect(fresh.exit).not.toBe(old.exit)
      writeFileSync(goOld, 'go\n')
      await until(() => existsSync(old.exit))
      writeFileSync(goNew, 'go\n')
      expect(await waitGate(fresh, 10_000)).toEqual({ code: 3, out: 'new' })
      expect(readFileSync(old.exit, 'utf8').trim()).toBe('0')
    })

    /** `n` tasks of one repo, each with a file of its own committed and reported done; its gate waits for `go-<id>` */
    async function line(name: string, n: number) {
      const w = world()
      const dir = repo()
      const gates = tmp(`${name}-go`)
      const a = await started(w, dir, name, 'Task 1', 'Add 1.txt.')
      expect(w.settings.set('merge.gate', `while [ ! -f ${gates}/go-$SHEPHERDR_TASK ]; do sleep 0.05; done; echo "Gate: green for $SHEPHERDR_TASK"`, { space: a.p.name }).ok).toBe(true)
      const ts = [a.t]
      for (let i = 2; i <= n; i++) ts.push(w.engine.add({ project: a.p.name, title: `Task ${i}`, desc: `Add ${i}.txt.`, by: 'test' }))
      await until(() => ts.every((t) => !!t.worktree))
      for (const [i, t] of ts.entries()) {
        writeFileSync(join(t.worktree!, `${i + 1}.txt`), `${i + 1}\n`)
        sh(`git add -A && git commit -qm "add ${i + 1}"`, t.worktree!)
        await w.engine.done(t.id, `Added ${i + 1}.txt.`)
      }
      const go = (t: { id: string }) => writeFileSync(join(gates, `go-${t.id}`), 'go\n')
      return { w, dir, ts, go, gates }
    }

    test('in line, its row names the merge that runs now, and moves on to the next as each one ends', async () => {
      const { w, ts, go } = await line('gate-now', 3)
      const [a, b, c] = ts
      const runs = [w.engine.merge(a.id, { self: true })]
      await until(() => a.landing?.step === 'gate')
      runs.push(w.engine.merge(b.id, { self: true }), w.engine.merge(c.id, { self: true }))
      expect(w.engine.subOf(b)).toBe(`Waiting for the merge gate (${a.id}'s runs)`)
      expect(w.engine.subOf(c)).toBe(`Waiting for the merge gate (${a.id}'s runs)`)
      go(a)
      await until(() => b.landing?.step === 'gate')
      // the one ahead is through: the last in line now waits on the one gating, not on the one it first stood behind
      expect(w.engine.subOf(c)).toBe(`Waiting for the merge gate (${b.id}'s runs)`)
      go(b)
      go(c)
      expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true])
    })

    test("written to after it reported, its own merge still puts it on its way into main: never Needs you while it waits", async () => {
      // a coordinator's "rebase on main and run shepherdr merge" makes it work again, not done; its agent then merges
      const { w, ts, go } = await line('gate-asked', 3)
      const [a, b, c] = ts
      const first = w.engine.merge(a.id, { self: true })
      await until(() => a.landing?.step === 'gate')
      w.engine.youWrote(`${b.id}/Agent`)
      expect(b.reported).toBe(false)
      const second = w.engine.merge(b.id, { self: true })
      expect(b.reported).toBe(true)
      expect(w.engine.statusOf(b)).toBe('merging')
      expect(w.engine.subOf(b)).toBe(`Waiting for the merge gate (${a.id}'s runs)`)
      // a restart finds it in line, as any other
      expect(b.landing?.step).toBe('queue')
      // asked by you or a coordinator, with its agent at rest: once it goes in, it is merging too
      w.engine.youWrote(`${c.id}/Agent`)
      w.agentIs(`${c.id}/Agent`, 'idle')
      const third = w.engine.merge(c.id)
      expect(c.reported).toBe(false)
      for (const t of [a, b]) go(t)
      await until(() => c.landing?.step === 'gate')
      expect(c.reported).toBe(true)
      expect(w.engine.statusOf(c)).toBe('merging')
      go(c)
      expect((await Promise.all([first, second, third])).map((r) => r.ok)).toEqual([true, true, true])
    })

    test('a merge that only waited in line goes on by itself after a restart, behind the gate that went on, as it stood', async () => {
      const { w, dir, ts, go, gates } = await line('gate-requeue', 3)
      const [g, q1, q2] = ts
      const { startGate } = await import('../server/live/engine/engine.ts')
      // as a restart leaves them: g in its gate, its process going on by itself; q1 and q2 in line (q2 first), though
      // their places come after g's
      sh('git rebase -q main', g.worktree!)
      const head = sh('git rev-parse HEAD', g.worktree!)
      g.landing = { step: 'gate', at: 3 }
      g.gateRun = startGate(`while [ ! -f ${gates}/go-${g.id} ]; do sleep 0.05; done; echo "Gate: green for ${g.id}"`, g.worktree!, {}, tmp('gate-requeue-files'), g.id, { head, tip: sh('git rev-parse main', dir) })
      q1.landing = { step: 'queue', at: 2, behind: 'GONE-1', gate: true }
      q2.landing = { step: 'queue', at: 1, behind: 'GONE-1', gate: true }
      w.engine.resumeMerges()
      await until(() => w.engine.subOf(q1) === `Waiting for the merge gate (${g.id}'s runs)`)
      expect(w.engine.subOf(q2)).toBe(`Waiting for the merge gate (${g.id}'s runs)`)
      for (const t of ts) go(t)
      await until(() => ts.every((t) => w.engine.statusOf(t) === 'done'))
      // g first, then the two in the order they stood in line
      expect(sh('git log --format=%s -n 4', dir).split('\n')).toEqual([`${q1.id}: Task 2`, `${q2.id}: Task 3`, `${g.id}: Task 1`, 'init'])
      for (const t of ts) {
        const said = w.sent.filter((x) => x.key === `${t.id}/Agent`).map((x) => x.text)
        await until(() => w.sent.some((x) => x.key === `${t.id}/Agent` && x.text.includes('Your merge went in')))
        // nobody was asked to merge again
        expect(said.some((x) => x.includes('Run shepherdr merge'))).toBe(false)
      }
    })

    describe('a merge train', () => {
      /** a line of `n` with its gate logging each run (`runs`), waiting for go-<the task it gates for>, then green */
      async function train(name: string, n: number, k: string, gate = '') {
        const l = await line(name, n)
        const runs = join(l.gates, 'runs')
        const space = l.w.engine.view(l.ts[0]).place.split(':').pop()!
        expect(l.w.settings.set('merge.gate', `echo "$SHEPHERDR_TASK" >> ${runs}; ${gate}while [ ! -f ${l.gates}/go-$SHEPHERDR_TASK ]; do sleep 0.05; done; echo "Gate: green on $(git rev-parse --short HEAD^{tree})"`, { space }).ok).toBe(true)
        expect(l.w.settings.set('merge.train', k, { space }).ok).toBe(true)
        // their agents at rest, as told while their merges wait
        for (const t of l.ts) l.w.agentIs(`${t.id}/Agent`, 'idle')
        const ran = () => (existsSync(runs) ? readFileSync(runs, 'utf8').trim().split('\n') : [])
        return { ...l, ran }
      }

      test('the first in line take the next ones along on one gate run, each going in as its own commit with its line', async () => {
        const { w, dir, ts, go, ran } = await train('train-go', 4, '3')
        const [x, a, b, c] = ts
        // a worktree a train's gate left at the top of its stack (a restart while it ran) is back on its branch first
        sh('git checkout -q --detach', x.worktree!)
        const runs = [w.engine.merge(x.id, { self: true })]
        await until(() => x.landing?.step === 'gate')
        for (const t of [a, b, c]) runs.push(w.engine.merge(t.id, { self: true }))
        expect(w.engine.subOf(c)).toBe(`Waiting for the merge gate (${x.id}'s runs)`)
        go(x)
        // a's turn: b and c go in with it, on one run
        await until(() => a.landing?.cars === 3)
        expect(w.engine.subOf(a)).toBe('Running the merge gate (a train of 3)')
        expect(w.engine.subOf(b)).toBe(`Going in with ${a.id}'s merge train`)
        expect(w.engine.subOf(c)).toBe(`Going in with ${a.id}'s merge train`)
        // a's worktree is at the top of the stack while the gate runs: all three changes there
        expect(['2.txt', '3.txt', '4.txt'].every((f) => existsSync(join(a.worktree!, f)))).toBe(true)
        go(a)
        const said = await Promise.all(runs)
        expect(said.map((r) => r.ok)).toEqual([true, true, true, true])
        expect(said[2].note).toBe(`it went in with ${a.id}'s merge train`)
        expect(ran()).toEqual([x.id, a.id])
        expect(sh('git log --format=%s -n 5', dir).split('\n')).toEqual([`${c.id}: Task 4`, `${b.id}: Task 3`, `${a.id}: Task 2`, `${x.id}: Task 1`, 'init'])
        for (const t of [a, b, c]) {
          const body = sh(`git log -1 --format=%b ${t.squash}`, dir)
          expect(body).toContain(`Added ${ts.indexOf(t) + 1}.txt.`)
          expect(body).toContain('Gate: green on ')
          expect(body).toContain(`Merge train: ${a.id}, ${b.id}, ${c.id} (one merge gate run)`)
          expect(w.engine.statusOf(t)).toBe('done')
        }
        expect(b.train).toBe(a.id)
      })

      test("one that conflicts stays out for its own turn; a refusal goes back to one at a time", async () => {
        // the gate refuses whenever 4.txt (the last task's) is in the tree it checks
        const { w, ts, go, ran } = await train('train-red', 4, '4', 'test -f 4.txt && { echo "4.txt is not wanted"; exit 1; }; ')
        const [x, a, b, c] = ts
        // b adds 2.txt too, as a does, with other words: it can't stack on a
        writeFileSync(join(b.worktree!, '2.txt'), 'b too\n')
        sh('git add -A && git commit -qm "b adds 2.txt"', b.worktree!)
        const runs = [w.engine.merge(x.id, { self: true })]
        await until(() => x.landing?.step === 'gate')
        for (const t of [a, b, c]) runs.push(w.engine.merge(t.id, { self: true }))
        for (const t of [x, a, c]) go(t)
        const [rx, ra, rb, rc] = await Promise.all(runs)
        expect([rx.ok, ra.ok]).toEqual([true, true])
        // the train (a and c) was refused, so a went alone; b then conflicted with a on its own turn; c was refused alone
        expect(ran()).toEqual([x.id, a.id, a.id, c.id])
        expect(rb.error).toContain('Conflict with main')
        expect(rc.error).toContain(`${c.id}'s merge gate`)
        expect(rc.error).toContain('4.txt is not wanted')
        expect(c.landing?.train).toBeUndefined()
      })

      /** the gate refuses while bad.txt is in the tree (a task's commit of its own) */
      const REFUSE_BAD = 'test -f bad.txt && { echo "bad.txt is not wanted"; exit 1; }; '

      test('a refused train: each member goes alone once, only the one whose change fails is told, and it rides again after its turn alone', async () => {
        const { w, dir, ts, go, ran } = await train('train-refused', 4, '3', REFUSE_BAD)
        const [x, a, b, c] = ts
        const space = w.engine.view(x).place.split(':').pop()!
        writeFileSync(join(c.worktree!, 'bad.txt'), 'bad\n')
        sh('git add -A && git commit -qm "c adds bad.txt"', c.worktree!)
        const runs = [w.engine.merge(x.id, { self: true })]
        await until(() => x.landing?.step === 'gate')
        for (const t of [a, b, c]) runs.push(w.engine.merge(t.id, { self: true }))
        go(x)
        go(a)
        go(b)
        const [rx, ra, rb, rc] = await Promise.all(runs)
        expect([rx.ok, ra.ok, rb.ok]).toEqual([true, true, true])
        // the train of a, b and c is refused by c's change: a goes alone and goes in, then b, then c alone is refused
        expect(ran()).toEqual([x.id, a.id, a.id, b.id, c.id])
        expect(rc.error).toContain(`${c.id}'s merge gate`)
        expect(rc.error).toContain('bad.txt is not wanted')
        expect(rb.error).toBeUndefined()
        // nobody but c heard about a refused train: none of the three was sent a word on it
        expect(w.sent.filter((m) => m.text.includes('train'))).toEqual([])
        expect([a, b, c].map((t) => t.alone)).toEqual([undefined, undefined, undefined])
        expect(c.landing).toBeUndefined()
        // c fixes its change: it rides again, behind d (its train's head, queued first) while e's gate runs
        sh('git rm -q bad.txt && git commit -qm "c drops bad.txt"', c.worktree!)
        const more = async (title: string, file: string) => {
          const t = w.engine.add({ project: space, title, desc: `Add ${file}.`, by: 'test' })
          await until(() => !!t.worktree)
          writeFileSync(join(t.worktree!, file), `${file}\n`)
          sh(`git add -A && git commit -qm "add ${file}"`, t.worktree!)
          await w.engine.done(t.id, `Added ${file}.`)
          w.agentIs(`${t.id}/Agent`, 'idle')
          return t
        }
        const e = await more('Task 5', '5.txt')
        const d = await more('Task 6', '6.txt')
        go(d)
        const runE = w.engine.merge(e.id, { self: true })
        await until(() => e.landing?.step === 'gate')
        const runD = w.engine.merge(d.id, { self: true })
        const runC = w.engine.merge(c.id, { self: true })
        go(e)
        const [re, rd, rc2] = await Promise.all([runE, runD, runC])
        expect([re.ok, rd.ok, rc2.ok]).toEqual([true, true, true])
        expect(rc2.note).toBe(`it went in with ${d.id}'s merge train`)
        expect(c.train).toBe(d.id)
        expect(ran()).toEqual([x.id, a.id, a.id, b.id, c.id, e.id, d.id])
        expect(sh(`git log -1 --format=%b ${c.squash}`, dir)).toContain(`Merge train: ${d.id}, ${c.id} (one merge gate run)`)
      })

      test('a refused train\'s members keep their turn alone across a restart: the Shepherdr that comes back reads the marks', async () => {
        const { w, ts, go, ran } = await train('train-mark', 4, '3', REFUSE_BAD)
        const [x, a, b, c] = ts
        writeFileSync(join(c.worktree!, 'bad.txt'), 'bad\n')
        sh('git add -A && git commit -qm "c adds bad.txt"', c.worktree!)
        const runs = [w.engine.merge(x.id, { self: true })]
        await until(() => x.landing?.step === 'gate')
        for (const t of [a, b, c]) runs.push(w.engine.merge(t.id, { self: true }))
        go(x)
        // a's turn alone waits for its go: until then the three are marked, a in its turn and b and c in line
        await until(() => ran().length === 3 && !!b.alone && !!c.alone)
        const second = world()
        expect([a, b, c].map((t) => second.engine.task(t.id)!.alone)).toEqual([true, true, true])
        go(a)
        go(b)
        expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true, false])
        expect(ran()).toEqual([x.id, a.id, a.id, b.id, c.id])
        expect([a, b, c].map((t) => t.alone)).toEqual([undefined, undefined, undefined])
      })

      test("main moves while the train's gate runs: nothing lands as a train, the head goes alone, its riders wait in line with no mark", async () => {
        const { w, dir, ts, go, ran } = await train('train-moved', 4, '3')
        const [g, x, a, b] = ts
        const runs = [w.engine.merge(g.id, { self: true })]
        await until(() => g.landing?.step === 'gate')
        runs.push(w.engine.merge(x.id, { self: true }), w.engine.merge(a.id, { self: true }), w.engine.merge(b.id, { self: true }))
        go(g)
        // x heads a train with a and b on its gate run; main moves on while that run goes on
        await until(() => x.landing?.cars === 3)
        sh('git commit -q --allow-empty -m "main moves on"', dir)
        go(x)
        // the stack is no longer main's next commit: x goes alone, and a and b wait in line, plain
        await until(() => x.landing?.cars === undefined && x.landing?.step === 'gate')
        expect(a.landing?.train).toBeUndefined()
        expect(b.landing?.train).toBeUndefined()
        expect([a, b, x].map((t) => t.alone)).toEqual([undefined, undefined, undefined])
        go(a)
        expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true, true])
        // g, then x's train run and its own alone run, then a's train with b
        expect(ran()).toEqual([g.id, x.id, x.id, a.id])
        expect(sh(`git log -1 --format=%b ${x.squash}`, dir)).not.toContain('Merge train:')
        expect(sh(`git log -1 --format=%b ${a.squash}`, dir)).toContain(`Merge train: ${a.id}, ${b.id} (one merge gate run)`)
        expect(b.train).toBe(a.id)
      })

      test('a marked task whose turn a restart cut short keeps the mark: its next merge goes alone, behind the train it could ride', async () => {
        const { w, ts, go, ran } = await train('train-cut', 4, '3')
        const [g, x, a, b] = ts
        const runs = [w.engine.merge(g.id, { self: true })]
        await until(() => g.landing?.step === 'gate')
        // x was marked by a refused train; a restart cut its turn alone short (its gate never ended, nothing left running)
        x.alone = true
        x.landing = { step: 'gate', at: Date.now() }
        x.gateRun = { pid: 999_999_999, log: '/nonexistent/log', exit: '/nonexistent/exit', at: Date.now(), head: 'x', tip: 'y' }
        w.engine.resumeMerges()
        expect(x.landing).toBeUndefined()
        expect(x.alone).toBe(true)
        // a and b wait behind g, x last in line: a rides with b, while x, marked, waits for its own turn alone
        runs.push(w.engine.merge(a.id, { self: true }), w.engine.merge(b.id, { self: true }), w.engine.merge(x.id, { self: true }))
        expect(w.engine.subOf(x)).toBe(`Waiting for the merge gate (${g.id}'s runs)`)
        go(g)
        await until(() => a.landing?.cars === 2)
        expect(w.engine.subOf(b)).toBe(`Going in with ${a.id}'s merge train`)
        expect(w.engine.subOf(x)).toBe(`Waiting for the merge gate (${a.id}'s runs)`)
        go(a)
        // x's turn: a gate of its own, no train
        await until(() => x.landing?.step === 'gate')
        expect(x.landing!.cars).toBeUndefined()
        go(x)
        expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true, true])
        expect(ran()).toEqual([g.id, a.id, x.id])
        expect(x.alone).toBeUndefined()
        expect(b.train).toBe(a.id)
        expect(x.train).toBeUndefined()
      })

      test("a rider whose merge passes its deadline while it rides hears it goes in with the train's gate", async () => {
        const { w, ts, go, ran } = await train('train-late', 4, '3')
        const [x, a, b, c] = ts
        const runs = [w.engine.merge(x.id, { self: true })]
        await until(() => x.landing?.step === 'gate')
        runs.push(w.engine.merge(a.id, { self: true }), w.engine.merge(b.id, { self: true }), w.engine.merge(c.id, { self: true }))
        go(x)
        // a's train takes b and c along: their mark is on, and a's gate runs
        await until(() => b.landing?.train === a.id && a.landing?.cars === 3)
        expect(w.engine.subOf(b)).toBe(`Going in with ${a.id}'s merge train`)
        // b asked again, its deadline short: by then it rides, and says so (its first merge still waits for the same one)
        w.engine.mergeDeadline = 100
        const late = await w.engine.merge(b.id, { self: true })
        w.engine.mergeDeadline = 30_000
        expect(late.ok).toBe(false)
        expect(late.error).toContain(`${b.id}'s merge goes in with ${a.id}'s merge train (its gate runs)`)
        expect(late.error).not.toContain('waits in line')
        go(a)
        expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true, true])
        expect(ran()).toEqual([x.id, a.id])
      })

      test('a restart while the train\'s gate runs: the head re-attaches to its run, the riders resume in line, and the train lands', async () => {
        const { w, dir, ts, go, ran } = await train('train-restart', 3, '3')
        const [a, b, c] = ts
        const space = w.engine.view(a).place.split(':').pop()!
        const { startGate } = await import('../server/live/engine/engine.ts')
        // the train's stack, built as the engine builds it: each rider's squash commit on the one before, dated as main's tip
        const at = sh('git rev-parse main', dir)
        const date = sh('git log -1 --format=%cI main', dir)
        let top = at
        for (const x of [a, b, c]) {
          const tree = sh(`git merge-tree --write-tree ${top} ${x.branch}`, dir).split('\n')[0]
          top = sh(`GIT_AUTHOR_DATE='${date}' GIT_COMMITTER_DATE='${date}' git commit-tree ${tree} -p ${top} -m '${x.id}: ${x.title}'`, dir)
        }
        // as a restart leaves it: a's worktree at the top of the stack, its gate going on by itself, and b and c in line
        // with the mark of the train they ride
        sh(`git checkout -q --detach ${top}`, a.worktree!)
        a.landing = { step: 'gate', at: 1, cars: 3 }
        a.gateRun = startGate(w.settings.get('merge.gate', space), a.worktree!, { SHEPHERDR_TASK: a.id, SHEPHERDR_BASE: 'main' }, join(process.env.SHEPHERDR_HOME!, 'gates'), a.id, { head: top, tip: at })
        b.landing = { step: 'queue', at: 2, behind: a.id, gate: true, train: a.id }
        c.landing = { step: 'queue', at: 3, behind: a.id, gate: true, train: a.id }
        await until(() => ran().length === 1)
        // a while later, the stack is built again on the same tip: the same commits, so the same run is found again
        await Bun.sleep(1100)
        w.engine.resumeMerges()
        // a's merge is back: it has rebuilt the stack and its row says the train's gate runs
        await until(() => a.landing?.step === 'gate' && a.landing.at > 1)
        expect(w.engine.subOf(a)).toBe('Running the merge gate (a train of 3)')
        expect(w.engine.subOf(b)).toBe(`Going in with ${a.id}'s merge train`)
        expect(b.landing?.train).toBe(a.id)
        expect(c.landing?.train).toBe(a.id)
        expect(ran()).toEqual([a.id])
        go(a)
        await until(() => ts.every((t) => w.sent.some((x) => x.key === `${t.id}/Agent` && x.text.includes('Your merge went in'))))
        // one gate run in all: the one a restart left, found again; the three go in on it, in line order
        expect(ran()).toEqual([a.id])
        expect(sh('git log --format=%s -n 4', dir).split('\n')).toEqual([`${c.id}: Task 3`, `${b.id}: Task 2`, `${a.id}: Task 1`, 'init'])
        for (const t of [a, b, c]) {
          expect(sh(`git log -1 --format=%b ${t.squash}`, dir)).toContain(`Merge train: ${a.id}, ${b.id}, ${c.id} (one merge gate run)`)
          expect(w.engine.statusOf(t)).toBe('done')
        }
        expect([b.train, c.train]).toEqual([a.id, a.id])
        expect(w.sent.filter((x) => x.key === `${b.id}/Agent`).at(-1)!.text).toContain(`it went in with ${a.id}'s merge train`)
      })
    })

    test('a gate killed from outside is no answer: the merge says it was stopped, and nothing went in', async () => {
      const { w, dir, t } = await gated('gate-killed', 'sleep 30')
      const main = sh('git rev-parse main', dir)
      // a marked task's lone turn: a gate that never ended keeps the mark
      t.alone = true
      const run = w.engine.merge(t.id, { self: true })
      await until(() => !!t.gateRun?.pid)
      process.kill(-t.gateRun!.pid, 'SIGKILL')
      expect((await run).error).toContain(`${t.id}'s merge gate (sleep 30) was stopped before it ended`)
      expect(sh('git rev-parse main', dir)).toBe(main)
      expect(t.alone).toBe(true)
    })

    test('off, or none set: no gate', async () => {
      const { w, t } = await gated('gate-off', 'off')
      expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    })
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

/** a GitHub stand-in: a bare repo is GitHub, gh is test/fake-gh.ts; the clone's origin reads as GitHub's */
const ghBin = tmp('ghbin')
writeFileSync(join(ghBin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, 'fake-gh.ts')}" "$@"\n`, { mode: 0o755 })

function onGitHub(o: { authed?: boolean; down?: boolean; checks?: FakeGitHub['checks']; remote?: string } = {}) {
  process.env.PATH = `${ghBin}:${process.env.PATH}`
  const bare = tmp('gh-origin')
  sh('git init -q --bare -b main', bare)
  sh(`git push -q ${bare} main`, repo())
  const dir = tmp('gh-clone')
  const remote = o.remote ?? 'https://github.com/acme/app.git'
  sh(`git clone -q ${bare} . && git config user.email t@t && git config user.name T && git remote set-url origin ${remote} && git config url.${bare}.insteadOf ${remote}`, dir)
  const file = join(tmp('gh-state'), 'github.json')
  writeFileSync(file, JSON.stringify({ origin: bare, repo: 'acme/app', prs: [], calls: [], authed: o.authed, down: o.down, checks: o.checks }))
  process.env.FAKE_GH_STATE = file
  const gh = () => JSON.parse(readFileSync(file, 'utf8')) as FakeGitHub
  const set = (patch: Partial<FakeGitHub>) => writeFileSync(file, JSON.stringify({ ...gh(), ...patch }))
  return { bare, dir, gh, set }
}

/** Settings → How tasks work → Merge after GitHub checks, for one test (it is kept on disk: back to its default after) */
const waitForChecks = (w: ReturnType<typeof world>) => w.settings.set('brief.merge', 'after GitHub checks')
afterEach(() => void new Settings().set('brief.merge', null))

/**
 * The person merging a task's pull request by hand on GitHub, with the squash button: main there gets the squash and
 * the pull request says it merged at the commit it was at, while the branch keeps its own commits (a squash merge
 * leaves them out of the base). Returns that commit.
 */
function mergedByHand(g: ReturnType<typeof onGitHub>, branch: string, subject = 'Say hello (#1)') {
  const tip = sh(`git rev-parse refs/heads/${branch}`, g.bare)
  const dir = tmp('gh-byhand')
  sh(`git clone -q ${g.bare} . && git config user.email t@t && git config user.name T && git fetch -q origin ${branch} && git merge -q --squash FETCH_HEAD && git commit -qm "${subject}" && git push -q origin main`, dir)
  g.set({ prs: g.gh().prs.map((p) => (p.head === branch ? { ...p, state: 'MERGED' as const, at: tip } : p)) })
  return tip
}

/** how many pull requests the engine asked GitHub to open (a second one for the same branch is the bug) */
const opened = (g: ReturnType<typeof onGitHub>) => g.gh().calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create').length

describe('on GitHub: a pull request per task', () => {
  test("its origin is read as written and as git rewrites it: github.com mapped to github.localhost talks to github.localhost", async () => {
    const dir = repo()
    sh('git remote add origin https://github.com/acme/app.git && git config url.http://github.localhost/.insteadOf https://github.com/', dir)
    expect(await G.github(dir)).toEqual({ host: 'github.localhost', repo: 'acme/app' })
    sh('git remote set-url origin http://github.localhost/eliasstravik/shepherdr.git && git config --unset url.http://github.localhost/.insteadOf', dir)
    expect(await G.github(dir)).toEqual({ host: 'github.localhost', repo: 'eliasstravik/shepherdr' })
    sh('git remote set-url origin ssh://git@github.com/acme/app.git', dir)
    expect(await G.github(dir)).toEqual({ host: 'github.com', repo: 'acme/app' })
    sh('git remote set-url origin https://gitlab.com/acme/app.git', dir)
    expect(await G.github(dir)).toBeNull()
  })

  test('a remote-only develop override starts there and merges there, preserving main and the space default', async () => {
    const w = world()
    const g = onGitHub()
    sh('git branch develop main && git push -q origin develop && git branch -D develop', g.dir)
    const main = sh('git rev-parse main', g.dir)
    const p = await w.places.add(g.dir, 'gitflow')
    const t = w.engine.add({ project: p.name, title: 'Develop work', by: 'test', base: 'develop' })
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
    expect(w.started.find((s) => s.key === `${t.id}/Agent`)!.system).toContain('(from develop)')
    expect(w.engine.view(t).base).toBe('develop')
    expect(p.base).toBe('main')
    writeFileSync(join(t.worktree!, 'develop.txt'), 'work')
    sh('git add -A && git commit -qm work', t.worktree!)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    expect(g.gh().prs[0].base).toBe('develop')
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    expect(sh('git show develop:develop.txt', g.bare)).toBe('work')
    expect(sh('git rev-parse main', g.bare)).toBe(main)
    expect(sh('git rev-parse develop', g.dir)).toBe(sh('git rev-parse develop', g.bare))
  })

  test('a pull request retargeted on GitHub cannot merge into a different branch', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'wrong-target')
    writeFileSync(join(t.worktree!, 'work.txt'), 'work')
    sh('git add -A && git commit -qm work', t.worktree!)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    g.set({ prs: g.gh().prs.map((p) => ({ ...p, base: 'develop' })) })
    const r = await w.engine.merge(t.id, { self: true })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('targets develop')
    expect(g.gh().calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false)
  })

  test('read-only GitHub permission and deleted remote branches refuse work before an agent starts', async () => {
    const w = world()
    const g = onGitHub()
    const p = await w.places.add(g.dir, 'read-only')
    g.set({ permission: 'READ' })
    const t = w.engine.add({ project: p.name, title: 'No write access', by: 'test' })
    await until(() => !!t.trouble)
    expect(t.trouble).toContain('permission')
    expect(t.worktree).toBeUndefined()
    expect(w.started.some((s) => s.key === `${t.id}/Agent`)).toBe(false)
    g.set({ permission: 'WRITE' })
    sh('git branch gone && git push -q origin gone && git push -q origin --delete gone', g.dir)
    const missing = w.engine.add({ project: p.name, title: 'Gone', by: 'test', base: 'gone' })
    await until(() => !!missing.trouble)
    expect(missing.trouble).toContain('Cannot fetch branch gone')
    expect(missing.worktree).toBeUndefined()
  })

  test('shepherdr pr opens a draft; done makes it ready with the summary; merge squash-merges it on GitHub and pulls main here', async () => {
    const w = world()
    const g = onGitHub({ remote: 'http://github.localhost/acme/app.git' })
    const { t, key } = await started(w, g.dir, 'gh')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm "add hello"', t.worktree!)
    const r = await w.engine.openPr(t.id)
    expect(r.ok).toBe(true)
    expect(r.text).toContain('Opened PR #1 as a draft')
    expect(r.text).toContain('https://github.com/acme/app/pull/1')
    expect(t.pr).toEqual({ number: 1, url: 'https://github.com/acme/app/pull/1' })
    expect(w.engine.view(t).pr).toEqual(t.pr)
    const pr = g.gh().prs[0]
    expect(pr).toMatchObject({ head: t.branch, base: 'main', title: 'Say hello', isDraft: true })
    expect(pr.body).toContain('> Add hello.txt. Merge when done.')
    expect(pr.body).toContain('Generated with [Claude Code]')
    // gh is told the host git really talks to
    expect(g.gh().calls.every((c) => c.host === 'github.localhost')).toBe(true)
    expect(sh(`git rev-parse refs/heads/${t.branch}`, g.bare)).toBe(sh('git rev-parse HEAD', t.worktree!))
    // no checks on this repo: nothing to wait for
    expect((await w.engine.checks(t.id, 0)).text).toContain('no checks')
    await w.engine.done(t.id, 'Added hello.txt.')
    await until(() => !g.gh().prs[0].isDraft)
    expect(g.gh().prs[0].body.startsWith('Added hello.txt.')).toBe(true)
    const m = await w.engine.merge(t.id, { self: true })
    expect(m).toEqual({ ok: true, note: 'merged PR #1 on GitHub, not waiting for its checks' })
    expect(g.gh().prs[0].state).toBe('MERGED')
    expect(sh('git log --format=%s -n 2 main', g.bare).split('\n')).toEqual([`${t.id}: Say hello (#1)`, 'init'])
    // its branch on GitHub is gone, and main here is GitHub's (what Shepherdr's own update watches)
    expect(sh(`git branch --list ${t.branch}`, g.bare)).toBe('')
    expect(sh('git rev-parse main', g.dir)).toBe(sh('git rev-parse main', g.bare))
    expect(existsSync(join(g.dir, 'hello.txt'))).toBe(true)
    expect(w.engine.statusOf(t)).toBe('done')
    w.agentIs(key, 'idle')
    await until(() => !!t.cleaned)
    expect(existsSync(t.worktree!)).toBe(false)
    expect(sh('git branch --list "work/*"', g.dir)).toBe('')
  })

  test('ready after its pull request was squash-merged on GitHub by hand: Done (merged), and no second pull request', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pass' }] })
    const { t, key } = await started(w, g.dir, 'ghbyhand')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', t.worktree!)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    expect(opened(g)).toBe(1)
    mergedByHand(g, t.branch!)
    // its work is in main there, though not as its commit: Done, merged, at once, and the words name the pull request
    expect(await w.engine.done(t.id, 'Added hello.txt.')).toEqual({ state: 'merged', note: 'PR #1 was merged on GitHub' })
    expect(t.merged).toBe(true)
    expect(w.engine.statusOf(t)).toBe('done')
    expect(w.engine.subOf(t)).toBe('Merged')
    expect(t.facts).toBeUndefined()
    // never a second pull request, and main here is GitHub's
    expect(opened(g)).toBe(1)
    expect(sh('git rev-parse main', g.dir)).toBe(sh('git rev-parse main', g.bare))
    // its worktree and its branch go once its turn ends: nothing of its is lost with them
    w.agentIs(key, 'idle')
    await until(() => !!t.cleaned)
    expect(existsSync(t.worktree!)).toBe(false)
    expect(sh('git branch --list "work/*"', g.dir)).toBe('')
  })

  test('ready with its work squashed into main by hand, no pull request ever: Done (merged), nothing opened', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghinmain')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', t.worktree!)
    sh(`git merge -q --squash ${t.branch} && git commit -qm "hello, by hand"`, g.dir)
    expect(await w.engine.done(t.id, 'Added hello.txt.')).toEqual({ state: 'merged', note: 'its work was in main already' })
    expect(t.merged).toBe(true)
    expect(w.engine.statusOf(t)).toBe('done')
    expect(g.gh().prs).toEqual([])
    expect(opened(g)).toBe(0)
  })

  test('ready with its work in main already while its pull request is open: the words never claim a merge that happened not', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghopenpr')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', t.worktree!)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    sh(`git merge -q --squash ${t.branch} && git commit -qm "hello, by hand"`, g.dir)
    expect(await w.engine.done(t.id, 'Added hello.txt.')).toEqual({ state: 'merged', note: 'its work was in main already' })
    expect(w.engine.statusOf(t)).toBe('done')
    expect(g.gh().prs[0].state).toBe('OPEN')
  })

  test('ready with its work in main already on a repo with no remote: Done (merged), nothing fetched', async () => {
    const w = world()
    const dir = repo()
    const { t } = await started(w, dir, 'ghnoremote')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', t.worktree!)
    sh(`git merge -q --squash ${t.branch} && git commit -qm "hello, by hand"`, dir)
    expect(await w.engine.done(t.id, 'Added hello.txt.')).toEqual({ state: 'merged', note: 'its work was in main already' })
    expect(w.engine.statusOf(t)).toBe('done')
  })

  test('ready with its work in main here and a remote that does not answer: Done (merged), its words saying main stayed behind', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghoffline')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', t.worktree!)
    sh(`git merge -q --squash ${t.branch} && git commit -qm "hello, by hand"`, g.dir)
    // GitHub is out of reach from this checkout: the fetch that would bring main up cannot run
    sh(`git remote set-url origin ${join(tmpdir(), 'no-such-origin-here')}`, g.dir)
    const r = await w.engine.done(t.id, 'Added hello.txt.')
    expect(r.state).toBe('merged')
    expect(r.note).toStartWith("its work was in main already; main here was not brought up to GitHub's:")
    expect(w.engine.statusOf(t)).toBe('done')
  })

  test('a branch with a commit after its merged pull request is not taken for merged: Ready, and left alone', async () => {
    const w = world()
    const g = onGitHub()
    const { t, key } = await started(w, g.dir, 'ghafter')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', t.worktree!)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    mergedByHand(g, t.branch!)
    writeFileSync(join(t.worktree!, 'later.txt'), 'later\n')
    sh('git add -A && git commit -qm later', t.worktree!)
    expect((await w.engine.done(t.id, 'More to come.')).state).toBe('ready')
    expect(t.merged).toBeFalsy()
    // what it has after the merge is not in main: no watch marks it, and no second pull request is opened
    w.agentIs(key, 'idle')
    await w.engine.watchPrs()
    expect(t.merged).toBeFalsy()
    expect(w.engine.statusOf(t)).toBe('ready')
    expect(opened(g)).toBe(1)
  })

  test("the watch sees a pull request merged on GitHub by hand: Done (merged), never Ready for ever", async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pass' }] })
    const { t, key } = await started(w, g.dir, 'ghwatch')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', t.worktree!)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    expect((await w.engine.done(t.id, 'Added hello.txt.')).state).toBe('ready')
    w.agentIs(key, 'idle')
    // still open: Ready, its checks read as any watch does
    await w.engine.watchPrs()
    expect(t.merged).toBeFalsy()
    expect(w.engine.statusOf(t)).toBe('ready')
    mergedByHand(g, t.branch!)
    await w.engine.watchPrs()
    expect(t.merged).toBe(true)
    expect(w.engine.statusOf(t)).toBe('done')
    expect(w.engine.subOf(t)).toBe('Merged')
    expect(opened(g)).toBe(1)
  })

  test('shepherdr pr never opens a second pull request for a branch whose pull request merged already', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghsecond')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', t.worktree!)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    mergedByHand(g, t.branch!)
    writeFileSync(join(t.worktree!, 'later.txt'), 'later\n')
    sh('git add -A && git commit -qm later', t.worktree!)
    const r = await w.engine.openPr(t.id)
    expect(r.ok).toBe(false)
    expect(r.text).toContain('PR #1 is merged on GitHub already')
    expect(g.gh().prs.length).toBe(1)
    expect(opened(g)).toBe(1)
  })

  test('merge opens the pull request itself when the agent never did, and merges it at the commit here', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pass' }] })
    const { t } = await started(w, g.dir, 'ghmerge')
    // main moved on GitHub since the task started
    const other = tmp('gh-other')
    sh(`git clone -q ${g.bare} . && git config user.email t@t && git config user.name T && echo o > other.txt && git add -A && git commit -qm other && git push -q origin main`, other)
    writeFileSync(join(t.worktree!, 'mine.txt'), 'mine\n')
    w.agentIs(`${t.id}/Agent`, 'idle')
    const m = await w.engine.merge(t.id)
    expect(m.ok).toBe(true)
    const pr = g.gh().prs[0]
    expect(pr).toMatchObject({ number: 1, isDraft: false, state: 'MERGED' })
    expect(g.gh().calls.find((c) => c.args[1] === 'merge')!.args).toContain('--match-head-commit')
    expect(g.gh().calls.every((c) => c.host === 'github.com')).toBe(true)
    expect(sh('git log --format=%s -n 3 main', g.dir).split('\n')).toEqual([`${t.id}: Say hello (#1)`, 'other', 'init'])
    expect(sh('git show --name-only --format= main', g.dir)).toBe('mine.txt')
  })

  test('main moved on GitHub without a conflict: merged as it is, its passed checks kept, no new push', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pass' }] })
    // its brief's Settings block says to wait: set before it is added
    waitForChecks(w)
    const { t } = await started(w, g.dir, 'ghbehind')
    writeFileSync(join(t.worktree!, 'mine.txt'), 'mine\n')
    sh('git add -A && git commit -qm mine', t.worktree!)
    await w.engine.openPr(t.id)
    const head = sh('git rev-parse HEAD', t.worktree!)
    const other = tmp('gh-other')
    sh(`git clone -q ${g.bare} . && git config user.email t@t && git config user.name T && echo o > other.txt && git add -A && git commit -qm other && git push -q origin main`, other)
    const pushes = g.gh().calls.length
    const m = await w.engine.merge(t.id, { self: true })
    expect(m).toEqual({ ok: true, note: 'merged PR #1 on GitHub' })
    // not rebased: GitHub merged the very commit its checks passed on
    expect(sh('git rev-parse HEAD', t.worktree!)).toBe(head)
    const merge = g.gh().calls.slice(pushes).find((c) => c.args[1] === 'merge')!.args
    expect(merge[merge.indexOf('--match-head-commit') + 1]).toBe(head)
    expect(sh('git log --format=%s -n 3 main', g.dir).split('\n')).toEqual([`${t.id}: Say hello (#1)`, 'other', 'init'])
    expect(existsSync(join(g.dir, 'other.txt')) && existsSync(join(g.dir, 'mine.txt'))).toBe(true)
  })

  test('a conflict with main is rebased here when git can, pushed, and waits for fresh checks; else it goes back', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pass' }] })
    waitForChecks(w)
    const { p: place, t } = await started(w, g.dir, 'ghclash')
    writeFileSync(join(t.worktree!, 'README.md'), 'mine\n')
    sh('git add -A && git commit -qm mine', t.worktree!)
    await w.engine.openPr(t.id)
    const head = sh('git rev-parse HEAD', t.worktree!)
    // main took this very change, then changed the line again: merging conflicts, but a rebase drops the change it has
    const other = tmp('gh-other')
    sh(`git clone -q ${g.bare} . && git config user.email t@t && git config user.name T && git fetch -q origin ${t.branch} && git cherry-pick -x FETCH_HEAD >/dev/null && echo again > README.md && git commit -qam again && git push -q origin main`, other)
    writeFileSync(join(t.worktree!, 'new.txt'), 'new\n')
    sh('git add -A && git commit -qm new', t.worktree!)
    g.set({ checks: [{ name: 'test', bucket: 'pending' }] })
    const p = await w.engine.merge(t.id, { self: true })
    expect(p.ok).toBe(false)
    expect(p.error).toContain('rebased on main for a conflict')
    expect(sh('git log --format=%s -n 4 HEAD', t.worktree!).split('\n')).toEqual(['new', 'again', 'mine', 'init'])
    expect(sh(`git rev-parse refs/heads/${t.branch}`, g.bare)).not.toBe(head)
    expect(sh(`git rev-parse refs/heads/${t.branch}`, g.bare)).toBe(sh('git rev-parse HEAD', t.worktree!))
    g.set({ checks: [{ name: 'test', bucket: 'pass' }] })
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    // the same lines changed on both sides: git can't rebase it, so its agent does, by hand
    const u = w.engine.add({ project: place.name, title: 'Say it too', desc: 'Change README.md.', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${u.id}/Agent`))
    writeFileSync(join(u.worktree!, 'README.md'), 'mine too\n')
    sh('git add -A && git commit -qm mine', u.worktree!)
    await w.engine.openPr(u.id)
    const at = sh('git rev-parse HEAD', u.worktree!)
    sh('git pull -q --rebase origin main && echo theirs > README.md && git commit -qam theirs && git push -q origin main', other)
    const c = await w.engine.merge(u.id, { self: true })
    expect(c.ok).toBe(false)
    expect(c.error).toContain('Conflict with main: rebase')
    expect(sh('git rev-parse HEAD', u.worktree!)).toBe(at)
    expect(g.gh().prs[1].state).toBe('OPEN')
  })

  test("failed checks go back to the agent; merging waits while they run, and never on what it can't read", async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'fail', link: 'https://github.com/acme/app/actions/runs/7' }, { name: 'lint', bucket: 'pass' }] })
    waitForChecks(w)
    const { t, key } = await started(w, g.dir, 'ghfail')
    writeFileSync(join(t.worktree!, 'x.txt'), 'x\n')
    sh('git add -A && git commit -qm x', t.worktree!)
    await w.engine.openPr(t.id)
    const c = await w.engine.checks(t.id, 0)
    expect(c.ok).toBe(false)
    expect(c.text).toContain("GitHub's checks failed on PR #1: test.")
    expect(c.text).toContain('actions/runs/7')
    await w.engine.done(t.id, 'x')
    w.agentIs(key, 'idle')
    // you (or a coordinator) merge: refused, and the agent is told what to fix
    const m = await w.engine.merge(t.id)
    expect(m.ok).toBe(false)
    expect(m.error).toContain('Sent back')
    expect(w.sent.at(-1)!.key).toBe(key)
    expect(w.sent.at(-1)!.text).toContain(`shepherdr pr ${t.id}`)
    expect(w.engine.statusOf(t)).toBe('work')
    expect(g.gh().prs[0].state).toBe('OPEN')
    // still running: wait for them
    g.set({ checks: [{ name: 'test', bucket: 'pending' }] })
    const p = await w.engine.merge(t.id, { self: true })
    expect(p.error).toContain(`shepherdr checks ${t.id}`)
    expect((await w.engine.checks(t.id, 0)).text).toContain('still run')
    // fixed and passed
    g.set({ checks: [{ name: 'test', bucket: 'pass' }] })
    expect((await w.engine.checks(t.id, 0)).text).toContain("checks passed on PR #1")
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    expect(t.merged).toBe(true)
  })

  test('Merging, not Ready, from its first merge until it is in: checks running, a rebase, the merge itself', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pending' }] })
    waitForChecks(w)
    // the checks of its last pull requests took 2, 3 and 9 minutes
    const run = (m: number) => ['2026-10-26T10:00:00Z', `2026-10-26T10:0${m}:00Z`]
    g.set({ api: { 'repos/acme/app/actions/runs': [run(2), run(9), run(3)] } })
    const { t, key } = await started(w, g.dir, 'lands')
    writeFileSync(join(t.worktree!, 'x.txt'), 'x\n')
    sh('git add -A && git commit -qm x', t.worktree!)
    await w.engine.done(t.id, 'Added x, a long summary that belongs in the chat card and never on the row.')
    w.chat.reply = 'Merging once the checks pass.'
    // reported ready, not yet merging: Ready, a few words on its row
    w.agentIs(key, 'idle')
    expect(w.engine.statusOf(t)).toBe('ready')
    expect(w.engine.subOf(t)).toBe('Ready to merge')
    w.agentIs(key, 'working')
    const r = await w.engine.merge(t.id, { self: true })
    expect(r.error).toContain(`shepherdr checks ${t.id}`)
    expect(w.engine.statusOf(t)).toBe('merging')
    expect(w.engine.subOf(t)).toBe('Checks running · ~3m')
    expect(w.engine.view(t)).toMatchObject({ status: 'merging', state: expect.stringMatching(/^Merging · /) })
    // its turn ends while it waits for them: still Merging, nothing for you
    w.agentIs(key, 'idle')
    expect(w.engine.statusOf(t)).toBe('merging')
    // a question in its words alone is no fact: still Merging
    w.chat.reply = 'Merge it anyway?'
    expect(w.engine.statusOf(t)).toBe('merging')
    // it asks you on a card meanwhile: waits on you, the card first
    w.chat.card = 'ask'
    expect(w.engine.statusOf(t)).toBe('need')
    w.chat.card = undefined
    w.chat.reply = 'Merging once the checks pass.'
    // the checks pass while it rests with nothing running to wake it: it is told once to merge
    g.set({ checks: [{ name: 'test', bucket: 'pass' }] })
    await w.engine.watchPrs()
    expect(w.sent.at(-1)!.text).toContain(`merge ${t.id} now (shepherdr merge ${t.id})`)
    const told = w.sent.length
    await w.engine.watchPrs()
    expect(w.sent.length).toBe(told)
    expect(w.engine.statusOf(t)).toBe('merging')
    // a message from you: back at work, no longer merging
    w.engine.youWrote(key)
    expect(t.landing).toBeUndefined()
    await w.engine.done(t.id, 'x')
    w.agentIs(key, 'working')
    expect((await w.engine.merge(t.id, { self: true })).error).toBeUndefined()
    expect(w.engine.statusOf(t)).toBe('done')
    expect(w.engine.subOf(t)).toBe('Merged')
  })

  test('failed checks on its way in: back at work, not Merging', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pending' }] })
    waitForChecks(w)
    const { t, key } = await started(w, g.dir, 'landfail')
    writeFileSync(join(t.worktree!, 'x.txt'), 'x\n')
    sh('git add -A && git commit -qm x', t.worktree!)
    await w.engine.done(t.id, 'x')
    w.agentIs(key, 'working')
    await w.engine.merge(t.id, { self: true })
    expect(w.engine.subOf(t)).toBe('Checks running')
    g.set({ checks: [{ name: 'test', bucket: 'fail' }] })
    expect((await w.engine.checks(t.id, 0)).ok).toBe(false)
    expect(t.landing).toBeUndefined()
    expect(w.engine.statusOf(t)).toBe('work')
  })

  test("a token that can't read GitHub's checks reads the Actions jobs of the pull request's commit instead", async () => {
    const w = world()
    const g = onGitHub()
    const { t, key } = await started(w, g.dir, 'ghjobs')
    writeFileSync(join(t.worktree!, 'x.txt'), 'x\n')
    sh('git add -A && git commit -qm x', t.worktree!)
    await w.engine.openPr(t.id)
    const head = sh('git rev-parse HEAD', t.worktree!)
    const job = (status: string, conclusion: string | null) => ({ name: 'check', status, conclusion, html_url: 'https://github.com/acme/app/actions/runs/7/job/9' })
    g.set({ noChecks: true, api: { 'repos/acme/app/actions/runs': [7], 'repos/acme/app/actions/runs/7/jobs': [job('in_progress', null)] } })
    expect((await w.engine.checks(t.id, 0)).text).toContain('still run')
    expect(g.gh().calls.some((c) => c.args.includes(`repos/acme/app/actions/runs?head_sha=${head}&per_page=100`))).toBe(true)
    // reported done while they run: a failure is news, with the end of its log
    await w.engine.done(t.id, 'x')
    g.set({ api: { 'repos/acme/app/actions/runs': [7], 'repos/acme/app/actions/runs/7/jobs': [job('completed', 'failure')] }, logs: { '9': '2026-10-26T10:00:00.1Z ##[error]boom' } })
    w.agentIs(key, 'idle')
    await w.engine.watchPrs()
    expect(w.sent.at(-1)!.text).toContain('- Check failed: check (https://github.com/acme/app/actions/runs/7/job/9). Its log ends:\n    ##[error]boom')
    const c = await w.engine.checks(t.id, 0)
    expect(c.ok).toBe(false)
    expect(c.text).toContain("GitHub's checks failed on PR #1: check.")
    // fixed: passed, a skipped job aside, and it merges
    g.set({ api: { 'repos/acme/app/actions/runs': [7], 'repos/acme/app/actions/runs/7/jobs': [job('completed', 'success'), { ...job('completed', 'skipped'), name: 'deploy' }] } })
    expect((await w.engine.checks(t.id, 0)).text).toContain('checks passed on PR #1 (1)')
    await w.engine.done(t.id, 'x')
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
  })

  test("news on a done task's pull request wakes its agent once: a failed check with its log's end, new comments", async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pass' }] })
    const { t, key } = await started(w, g.dir, 'ghnews')
    writeFileSync(join(t.worktree!, 'x.txt'), 'x\n')
    sh('git add -A && git commit -qm x', t.worktree!)
    await w.engine.openPr(t.id)
    // not done yet: nothing is watched
    g.set({ checks: [{ name: 'lint', bucket: 'fail' }] })
    w.agentIs(key, 'idle')
    await w.engine.watchPrs()
    expect(w.sent.length).toBe(0)
    // a failure it saw itself (shepherdr checks) and reported done with is no news
    expect((await w.engine.checks(t.id, 0)).ok).toBe(false)
    await w.engine.done(t.id, 'x; lint is red on main too')
    await w.engine.watchPrs()
    expect(w.sent.length).toBe(0)
    // a check fails and people write on it; a comment from before it was done is old news
    const pulls = 'repos/acme/app/pulls/1'
    g.set({
      checks: [{ name: 'test', bucket: 'fail', link: 'https://github.com/acme/app/actions/runs/7/job/9' }, { name: 'lint', bucket: 'pass' }],
      // as GitHub logs a whole job: what failed, then the clean-up steps after it
      logs: { '9': ['ok 1', 'expected 1 to be 2', '##[error]Process completed with exit code 1.', 'Post job cleanup.', 'Cleaning up orphan processes'].map((l) => `2026-10-26T10:00:00.1234567Z ${l}`).join('\n') },
      api: {
        [`${pulls}/reviews`]: [
          { id: 1, user: { login: 'ann' }, body: 'Please rename it.', state: 'CHANGES_REQUESTED', html_url: 'https://github.com/acme/app/pull/1#r1', submitted_at: '2099-01-01T00:00:00Z' },
          { id: 2, user: { login: 'bob' }, body: '', state: 'COMMENTED', html_url: 'https://github.com/acme/app/pull/1#r2', submitted_at: '2099-01-01T00:00:01Z' },
        ],
        // drafted long before its review was sent: news all the same
        [`${pulls}/comments`]: [{ id: 3, pull_request_review_id: 2, user: { login: 'bob' }, body: 'Typo here.', path: 'x.txt', line: 1, html_url: 'https://github.com/acme/app/pull/1#c3', created_at: '2000-01-01T00:00:00Z' }],
        ['repos/acme/app/issues/1/comments']: [{ id: 4, user: { login: 'cy' }, body: 'Old news.', html_url: 'https://github.com/acme/app/pull/1#i4', created_at: '2000-01-01T00:00:00Z' }],
      },
    })
    await w.engine.watchPrs()
    expect(w.sent.length).toBe(1)
    const told = w.sent[0]
    expect(told.key).toBe(key)
    expect(told.text).toMatch(/^<shepherdr><github task="[^"]+" pr="1">GitHub news on PR #1 \(https:\/\/github.com\/acme\/app\/pull\/1\)/)
    expect(told.text).toContain('- Check failed: test (https://github.com/acme/app/actions/runs/7/job/9). Its log ends:\n    ok 1\n    expected 1 to be 2\n    ##[error]Process completed with exit code 1.\n- ')
    expect(told.text).not.toContain('clean')
    expect(told.text).toContain('- Changes requested by ann (https://github.com/acme/app/pull/1#r1):\n    Please rename it.')
    expect(told.text).toContain('- Comment by bob on x.txt:1 (https://github.com/acme/app/pull/1#c3):\n    Typo here.')
    expect(told.text).not.toContain('Old news')
    expect(told.text).not.toContain('#r2')
    expect(told.text).toContain('shepherdr-agent skill')
    expect(w.posted.at(-1)).toMatchObject({ key, card: { status: 'work', text: 'woken: test failed and 2 new comments on PR #1' } })
    // it is at work again, and hears nothing more until it reports done
    expect(w.engine.statusOf(t)).toBe('work')
    await w.engine.watchPrs()
    expect(w.sent.length).toBe(1)
    // done again: the same failure and comments are not told twice
    await w.engine.done(t.id, 'x')
    await w.engine.watchPrs()
    expect(w.sent.length).toBe(1)
    // an agent at work hears news only once it rests
    const notes = g.gh().api!
    g.set({ api: { ...notes, ['repos/acme/app/issues/1/comments']: [{ id: 5, user: { login: 'cy' }, body: 'Ship it?', html_url: 'https://github.com/acme/app/pull/1#i5', created_at: '2099-01-02T00:00:00Z' }] } })
    w.agentIs(key, 'working')
    await w.engine.watchPrs()
    expect(w.sent.length).toBe(1)
    w.agentIs(key, 'idle')
    await w.engine.watchPrs()
    expect(w.sent.length).toBe(2)
    expect(w.sent[1].text).toContain('- Comment by cy (https://github.com/acme/app/pull/1#i5):\n    Ship it?')
    expect(w.sent[1].text).not.toContain('Check failed')
  })

  test('a branch just pushed whose repo has workflows on pull requests waits for its checks to show, never taking none as passed', async () => {
    const w = world()
    const g = onGitHub()
    waitForChecks(w)
    const { t } = await started(w, g.dir, 'ghwf')
    mkdirSync(join(t.worktree!, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(t.worktree!, '.github', 'workflows', 'ci.yml'), 'on:\n  pull_request:\n  push:\n')
    sh('git add -A && git commit -qm ci', t.worktree!)
    const m = await w.engine.merge(t.id, { self: true })
    expect(m.ok).toBe(false)
    expect(m.error).toContain('just pushed')
    expect(g.gh().prs[0].state).toBe('OPEN')
    // a while later still none: they didn't run on it after all, and it merges
    t.pushed!.at = 0
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
  })

  test('a branch just pushed whose workflows run only on main has no checks to wait for', async () => {
    const w = world()
    const g = onGitHub()
    waitForChecks(w)
    const { t } = await started(w, g.dir, 'ghmain')
    mkdirSync(join(t.worktree!, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(t.worktree!, '.github', 'workflows', 'ci.yml'), '# no run on pull requests\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\n')
    sh('git add -A && git commit -qm ci', t.worktree!)
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
  })

  test("by default it merges without waiting for GitHub's checks, but never on one already failed at its commit", async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pending' }] })
    const { t } = await started(w, g.dir, 'ghnowait')
    writeFileSync(join(t.worktree!, 'x.txt'), 'x\n')
    sh('git add -A && git commit -qm x', t.worktree!)
    expect((await w.engine.openPr(t.id)).text).toContain("Merging doesn't wait for GitHub's checks")
    g.set({ checks: [{ name: 'test', bucket: 'fail', link: 'https://github.com/acme/app/actions/runs/7' }] })
    const f = await w.engine.merge(t.id, { self: true })
    expect(f.ok).toBe(false)
    expect(f.error).toContain("GitHub's checks failed on PR #1: test.")
    expect(g.gh().prs[0].state).toBe('OPEN')
    // fixed: a new commit, its checks just started
    writeFileSync(join(t.worktree!, 'x.txt'), 'fixed\n')
    sh('git commit -qam fix', t.worktree!)
    g.set({ checks: [{ name: 'test', bucket: 'pending' }] })
    expect(await w.engine.merge(t.id, { self: true })).toEqual({ ok: true, note: 'merged PR #1 on GitHub, not waiting for its checks' })
    expect(g.gh().prs[0].state).toBe('MERGED')
    // the brief's Merge line says so too
    expect(t.desc).toContain("Don't wait for GitHub's checks.")
  })

  test("main going red on GitHub after merges tells its coordinator once, with the run and what merged since green", async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghred')
    writeFileSync(join(t.worktree!, 'x.txt'), 'x\n')
    sh('git add -A && git commit -qm x', t.worktree!)
    const green = sh('git rev-parse main', g.bare)
    // other tests' tasks merged lately too (one store): only this one's project is watched
    for (const x of w.engine.tasks) x.doneAt = 0
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    const red = sh('git rev-parse main', g.bare)
    const run = (headSha: string, conclusion: string, n: number, status = 'completed') => ({ headSha, status, conclusion, url: `https://github.com/acme/app/actions/runs/${n}`, workflowName: 'Check' })
    // still running on the merge: nothing yet
    g.set({ runs: [run(red, '', 3, 'in_progress'), run(green, 'success', 2)] })
    await w.engine.watchMains()
    const before = w.news.length
    expect(w.news.length).toBe(before)
    // a newer push cancelled one run; the other failed
    g.set({ runs: [run(red, 'cancelled', 4), run(red, 'failure', 3), run(green, 'success', 2)], api: { 'repos/acme/app/actions/runs/3/jobs': [9] }, logs: { '9': 'expected 1 to be 2\n##[error]Process completed with exit code 1.' } })
    await w.engine.watchMains()
    expect(w.news.length).toBe(before + 1)
    const told = w.news.at(-1)!
    expect(told).toContain(`main went red on GitHub at ${red.slice(0, 7)}: Check failed (https://github.com/acme/app/actions/runs/3).`)
    expect(told).toContain(`Merged since it was last green (${green.slice(0, 7)}): ${t.id}: Say hello (#1).`)
    expect(told).toContain('    expected 1 to be 2')
    expect(told).toContain('fix-forward task')
    // for the project's own coordinator, by its place id (a folder's path reached no chat)
    expect(w.newsTo.at(-1)).toBe(t.project)
    expect(w.places.space(t.project)).toBeDefined()
    // told once while it stays red
    await w.engine.watchMains()
    expect(w.news.length).toBe(before + 1)
    // green again, then red again: told again
    g.set({ runs: [run('b'.repeat(40), 'success', 5), run(red, 'failure', 3)] })
    await w.engine.watchMains()
    g.set({ runs: [run('c'.repeat(40), 'failure', 6), run('b'.repeat(40), 'success', 5)] })
    await w.engine.watchMains()
    expect(w.news.length).toBe(before + 2)
  })

  test("GitHub stuck on the merge: shepherdr merge still answers by its deadline, and asked again waits for that same merge", async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'mergeslow')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm "add hello"', t.worktree!)
    await w.engine.done(t.id, 'Added hello.txt.')
    g.set({ mergeSlow: 4000 })
    w.engine.mergeDeadline = 1000
    const first = await w.engine.merge(t.id, { self: true })
    expect(first.ok).toBe(false)
    expect(first.error).toContain(`${t.id}'s merge isn't through after 1 s`)
    // its agent ends its turn rather than polling: it is told how it went
    expect(first.error).toContain('end your turn now, without polling or sleeping')
    expect(first.error).toContain(`A shepherdr merge ${t.id} meanwhile only waits for this one.`)
    expect(w.engine.statusOf(t)).toBe('merging')
    // asked again while it still runs: no second merge beside it, the same one's answer
    w.engine.mergeDeadline = 30_000
    expect(await w.engine.merge(t.id, { self: true })).toEqual({ ok: true, note: 'merged PR #1 on GitHub, not waiting for its checks' })
    expect(g.gh().calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toHaveLength(1)
    expect(w.engine.statusOf(t)).toBe('done')
  })

  test('Shepherdr stopping for an update lets a merge on its way finish and answer first, and starts no new one', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'mergedrain')
    const other = w.engine.add({ project: t.project, title: 'Other', by: 'test' })
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm "add hello"', t.worktree!)
    await w.engine.done(t.id, 'Added hello.txt.')
    g.set({ mergeSlow: 1500 })
    const merging = w.engine.merge(t.id, { self: true })
    await until(() => g.gh().calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'view'))
    const drained = w.engine.drain()
    expect(await w.engine.merge(other.id)).toEqual({ ok: false, error: `Shepherdr is restarting: nothing was merged. Run shepherdr merge ${other.id} again in a minute.` })
    expect(await drained).toBe(true)
    // through by the time it may stop: merged on GitHub and marked so, its answer given
    expect(g.gh().prs[0].state).toBe('MERGED')
    expect(t.merged).toBe(true)
    expect((await merging).ok).toBe(true)
  })

  test("logged in but GitHub doesn't answer: nothing merges, here or there", async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghdown')
    g.set({ down: true })
    writeFileSync(join(t.worktree!, 'd.txt'), 'd\n')
    sh('git add -A && git commit -qm d', t.worktree!)
    const before = sh('git rev-parse main', g.dir)
    const r = await w.engine.openPr(t.id)
    expect(r.ok).toBe(false)
    expect(r.text).toContain("gh can't reach GitHub")
    const m = await w.engine.merge(t.id, { self: true })
    expect(m.ok).toBe(false)
    expect(m.error).toContain("gh can't reach GitHub now (github.com: Failed to log in")
    expect(sh('git rev-parse main', g.dir)).toBe(before)
    expect(sh('git rev-parse main', g.bare)).toBe(before)
    expect(t.merged).toBeFalsy()
    // its pull request open, and gh logged out here: never merged around it
    g.set({ down: false, authed: false })
    t.pr = { number: 9, url: 'https://github.com/acme/app/pull/9' }
    expect((await w.engine.merge(t.id, { self: true })).error).toContain('PR #9 is on GitHub')
    expect(sh('git rev-parse main', g.dir)).toBe(before)
  })

  test('shepherdr pr again pushes to the open one, and readies it once done; a merge GitHub refuses merges nothing', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghagain')
    writeFileSync(join(t.worktree!, 'a.txt'), 'a\n')
    sh('git add -A && git commit -qm a', t.worktree!)
    await w.engine.openPr(t.id)
    writeFileSync(join(t.worktree!, 'b.txt'), 'b\n')
    sh('git add -A && git commit -qm b', t.worktree!)
    t.reported = true
    t.said = 'Added a and b.'
    const r = await w.engine.openPr(t.id)
    expect(r.text).toContain('Pushed to PR #1')
    expect(g.gh().prs).toHaveLength(1)
    expect(g.gh().prs[0]).toMatchObject({ isDraft: false })
    expect(g.gh().prs[0].body.startsWith('Added a and b.')).toBe(true)
    expect(sh(`git rev-parse refs/heads/${t.branch}`, g.bare)).toBe(sh('git rev-parse HEAD', t.worktree!))
    g.set({ mergeError: 'Pull request #1 is not mergeable: the merge commit cannot be cleanly created.' })
    const m = await w.engine.merge(t.id, { self: true })
    expect(m.ok).toBe(false)
    expect(m.error).toContain('Conflict with main on GitHub')
    expect(t.merged).toBeFalsy()
    expect(g.gh().prs[0].state).toBe('OPEN')
  })

  test('a pull request merged on GitHub by hand: main here catches up and it is marked merged', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghhand')
    writeFileSync(join(t.worktree!, 'y.txt'), 'y\n')
    sh('git add -A && git commit -qm y', t.worktree!)
    await w.engine.openPr(t.id)
    const ready = tmp('gh-hand')
    g.set({ prs: g.gh().prs.map((p) => ({ ...p, isDraft: false })) })
    sh(`"${join(ghBin, 'gh')}" pr merge 1 --squash`, ready)
    const m = await w.engine.merge(t.id, { self: true })
    expect(m).toEqual({ ok: true, note: 'PR #1 was merged on GitHub already' })
    expect(existsSync(join(g.dir, 'y.txt'))).toBe(true)
  })

  test('main here ahead of GitHub\'s is refused before anything merges; work main has already closes its pull request', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghahead')
    writeFileSync(join(t.worktree!, 'v.txt'), 'v\n')
    sh('git add -A && git commit -qm v', t.worktree!)
    await w.engine.openPr(t.id)
    sh('echo l > local.txt && git add -A && git commit -qm local', g.dir)
    const m = await w.engine.merge(t.id, { self: true })
    expect(m.error).toContain('1 commit GitHub lacks')
    expect(g.gh().prs[0].state).toBe('OPEN')
    // pushed, and the same work landed on main another way: its pull request is closed, the task marked merged
    sh(`git push -q origin main && git merge -q --squash ${t.branch} && git commit -qm "by hand" && git push -q origin main`, g.dir)
    const r = await w.engine.merge(t.id, { self: true })
    expect(r).toEqual({ ok: true, note: 'it was in main already; closed PR #1' })
    expect(g.gh().calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'close')).toBe(true)
  })

  test("a GitHub remote gh isn't logged in to: merged here and main pushed, as before", async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghnoauth')
    g.set({ authed: false })
    writeFileSync(join(t.worktree!, 'z.txt'), 'z\n')
    sh('git add -A && git commit -qm z', t.worktree!)
    expect((await w.engine.openPr(t.id)).text).toContain('No pull request')
    const m = await w.engine.merge(t.id, { self: true })
    expect(m).toEqual({ ok: true, note: 'pushed main to GitHub' })
    expect(g.gh().prs).toEqual([])
    expect(sh('git log --format=%s -n 1 main', g.bare)).toBe(`${t.id}: Say hello`)
  })

  test('a project that gains its GitHub remote after it was added goes through a pull request', async () => {
    const w = world()
    const g = onGitHub()
    sh('git remote remove origin', g.dir)
    const { p, t } = await started(w, g.dir, 'ghlater')
    expect(p.github).toBeNull()
    sh(`git remote add origin https://github.com/acme/app.git && git fetch -q origin`, g.dir)
    writeFileSync(join(t.worktree!, 'w.txt'), 'w\n')
    sh('git add -A && git commit -qm w', t.worktree!)
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    expect(p.github).toBe('acme/app')
    expect(g.gh().prs[0].state).toBe('MERGED')
  })
})
