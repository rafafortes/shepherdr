// shepherdr merge through a GitHub pull request with its space's merge gate set: the gate runs on the branch on
// GitHub's base before anything is pushed, and nothing goes up or in that did not pass it.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sh, repo, world, until, started } from './engine-world.ts'
import type { FakeGitHub } from './fake-gh.ts'
import { tmp } from './tmp.ts'
import { killGroup } from '../server/procs.ts'

// each test runs git dozens of times and gh (a bun process of its own): a few seconds alone, past 20 on a machine as
// busy as a CI runner can get
setDefaultTimeout(60_000)

/** a waiting gate command that ends by itself: when its folder goes, when the test process that started it goes (even
 *  one killed without cleanup), or after 1200 turns (about a minute), rather than forking sleep for days (LEAD-01).
 *  `dir` holds `go`; `after` is what it says when it ends. */
const waitFor = (go: string, dir: string, after = 'echo ok') =>
  `i=0; while [ ! -f ${go} ] && [ -d ${dir} ] && kill -0 ${process.pid} 2>/dev/null && [ \$i -lt 1200 ]; do sleep 0.05; i=\$((i+1)); done; ${after}`

/** every gate this file starts by hand, so a failing or interrupted test cannot leave one behind */
const gatesStarted: number[] = []
afterEach(() => {
  for (const pid of gatesStarted.splice(0)) killGroup(pid)
})

/** a GitHub stand-in: a bare repo is GitHub, gh is test/fake-gh.ts; the clone's origin reads as GitHub's */
const ghBin = tmp('ghbin-prgate')
writeFileSync(join(ghBin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, 'fake-gh.ts')}" "$@"\n`, { mode: 0o755 })

function onGitHub(o: { checks?: FakeGitHub['checks'] } = {}) {
  process.env.PATH = `${ghBin}:${process.env.PATH}`
  const bare = tmp('gh-origin')
  sh('git init -q --bare -b main', bare)
  sh(`git push -q ${bare} main`, repo())
  const dir = tmp('gh-clone')
  const remote = 'https://github.com/acme/app.git'
  sh(`git clone -q ${bare} . && git config user.email t@t && git config user.name T && git remote set-url origin ${remote} && git config url.${bare}.insteadOf ${remote}`, dir)
  const file = join(tmp('gh-state'), 'github.json')
  writeFileSync(file, JSON.stringify({ origin: bare, repo: 'acme/app', prs: [], calls: [], checks: o.checks }))
  process.env.FAKE_GH_STATE = file
  const gh = () => JSON.parse(readFileSync(file, 'utf8')) as FakeGitHub
  const set = (patch: Partial<FakeGitHub>) => writeFileSync(file, JSON.stringify({ ...gh(), ...patch }))
  return { bare, dir, gh, set }
}

/** a commit on main, pushed to GitHub, from a clone of its own: what moves the base while a gate runs */
function commitOnGitHub(g: ReturnType<typeof onGitHub>, what = 'other') {
  const other = tmp('gh-other')
  sh(`git clone -q ${g.bare} . && git config user.email t@t && git config user.name T && echo ${what} > ${what}.txt && git add -A && git commit -qm ${what} && git push -q origin main`, other)
  return other
}

/** the space's name, for a Settings change of it */
const spaceOf = (w: ReturnType<typeof world>, t: Parameters<ReturnType<typeof world>['engine']['view']>[0]) => w.engine.view(t).place.split(':').pop()!

describe('shepherdr merge through a pull request, with a merge gate', () => {
  test('a gate that fails refuses the merge: the pull request stays open at its commit, and the task is Ready again', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pass' }] })
    const { t, key } = await started(w, g.dir, 'pr-gate-red')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm "add hello"', t.worktree!)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    const at = sh(`git rev-parse refs/heads/${t.branch}`, g.bare)
    expect(w.settings.set('merge.gate', 'echo building; echo "2 tests failed" >&2; exit 3', { space: spaceOf(w, t) }).ok).toBe(true)
    await w.engine.done(t.id, 'Added hello.txt.')
    w.agentIs(key, 'idle')
    const r = await w.engine.merge(t.id)
    expect(r.ok).toBe(false)
    expect(r.error).toContain(`${t.id}'s merge gate (echo building; echo "2 tests failed" >&2; exit 3) failed (exit 3): nothing was merged, and main is as it was.`)
    expect(r.error).toContain('Its output ends:\nbuilding\n2 tests failed')
    // nothing was pushed over the pull request's head, and nothing merged
    expect(sh(`git rev-parse refs/heads/${t.branch}`, g.bare)).toBe(at)
    expect(g.gh().prs[0]).toMatchObject({ state: 'OPEN' })
    expect(g.gh().calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false)
    // Ready again, its row saying the last line the gate printed
    expect(t.merged).toBeFalsy()
    expect(t.landing).toBeUndefined()
    expect(w.engine.statusOf(t)).toBe('ready')
    expect(w.engine.subOf(t)).toBe('Refused by the gate: 2 tests failed')
    // a gate that passes afterwards lets the very same commit in
    w.settings.set('merge.gate', 'echo fine', { space: spaceOf(w, t) })
    expect((await w.engine.merge(t.id)).ok).toBe(true)
    expect(g.gh().prs[0].state).toBe('MERGED')
  })

  test('a gate that passes: the pull request merges at exactly the commit it gated, its last line in the squash commit', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pass' }] })
    const log: string[] = []
    const stderr = console.error
    console.error = (m: unknown) => void log.push(String(m))
    try {
      const { t } = await started(w, g.dir, 'pr-gate-ok')
      writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
      sh('git add -A && git commit -qm "add hello"', t.worktree!)
      expect((await w.engine.openPr(t.id)).ok).toBe(true)
      const gated = join(tmp('pr-gate-ok-head'), 'head')
      const space = spaceOf(w, t)
      expect(w.settings.set('merge.gate', `test -f hello.txt && git rev-parse HEAD > ${gated} && echo "Gate: green for $SHEPHERDR_TASK on $SHEPHERDR_BASE"`, { space }).ok).toBe(true)
      // a merge train set on a space whose merges go through a pull request is not a train, and the server's log says so
      expect(w.settings.set('merge.train', '3', { space }).ok).toBe(true)
      await w.engine.done(t.id, 'Added hello.txt.')
      const m = await w.engine.merge(t.id, { self: true })
      expect(m.ok).toBe(true)
      const at = readFileSync(gated, 'utf8').trim()
      // merged at exactly the commit the gate ran on
      expect(g.gh().prs[0].state).toBe('MERGED')
      expect(g.gh().prs[0].at).toBe(at)
      const args = g.gh().calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'merge')!.args
      expect(args[args.indexOf('--match-head-commit') + 1]).toBe(at)
      // its last line is in the squash commit, where a merge made here keeps it
      expect(sh('git log -1 --format=%b main', g.bare)).toBe(`Added hello.txt.\n\nGate: green for ${t.id} on main`)
      // its branch there is gone, and main here is GitHub's
      expect(sh(`git branch --list ${t.branch}`, g.bare)).toBe('')
      expect(sh('git rev-parse main', g.dir)).toBe(sh('git rev-parse main', g.bare))
      expect(log.filter((l) => l.startsWith(`shepherdr: ${t.id}'s `))).toEqual([`shepherdr: ${t.id}'s merge goes alone: ${space} merges through a pull request, and a merge train is for merges made here`])
    } finally {
      console.error = stderr
    }
  })

  test('the base moved on GitHub while the gate ran: the branch is rebased and the gate runs again on the new commit', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pass' }] })
    const goDir = tmp('pr-gate-moved')
    const go = join(goDir, 'go')
    const runs = join(tmp('pr-gate-moved-runs'), 'runs')
    const { t } = await started(w, g.dir, 'pr-gate-moved')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm "add hello"', t.worktree!)
    // each run says the commit it gated, and whether the branch had been rebased on what moved; then it ends
    const logged = `echo "$(git rev-parse HEAD) $(test -f other.txt && echo with-other || echo without)" >> ${runs}`
    expect(w.settings.set('merge.gate', `${logged}; ${waitFor(go, goDir, 'echo "Gate: green"')}`, { space: spaceOf(w, t) }).ok).toBe(true)
    await w.engine.done(t.id, 'Added hello.txt.')
    w.agentIs(`${t.id}/Agent`, 'idle')
    const merging = w.engine.merge(t.id)
    await until(() => existsSync(runs) && readFileSync(runs, 'utf8').includes('without'), 20_000)
    commitOnGitHub(g)
    writeFileSync(go, 'go\n')
    expect((await merging).ok).toBe(true)
    const gated = readFileSync(runs, 'utf8').trim().split('\n').map((l) => l.split(' '))
    // twice: the first on the branch as it was, the second on it rebased on what moved meanwhile
    expect(gated.map(([head, on]) => on)).toEqual(['without', 'with-other'])
    expect(gated[0][0]).not.toBe(gated[1][0])
    // and the pull request merged the commit that second run gated, on top of what moved
    expect(g.gh().prs[0].at).toBe(gated[1][0])
    expect(sh('git log --format=%s -n 2 main', g.bare).split('\n')).toEqual([`${t.id}: Say hello (#1)`, 'other'])
    expect(g.gh().prs[0].state).toBe('MERGED')
  })

  test('a base that keeps moving while the gate runs: after a few rounds the merge gives up for now', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pass' }] })
    const { t } = await started(w, g.dir, 'pr-gate-busy')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm "add hello"', t.worktree!)
    const other = tmp('pr-gate-busy-other')
    sh(`git clone -q ${g.bare} . && git config user.email t@t && git config user.name T`, other)
    // every run moves GitHub's main, as a busy repository would
    expect(w.settings.set('merge.gate', `(cd ${other} && date +%s%N > busy.txt && git add -A && git commit -qm busy && git push -q origin main)`, { space: spaceOf(w, t) }).ok).toBe(true)
    await w.engine.done(t.id, 'Added hello.txt.')
    w.agentIs(`${t.id}/Agent`, 'idle')
    const r = await w.engine.merge(t.id)
    expect(r.error).toBe(`main kept moving while ${t.id}'s merge gate ran (3 times): nothing was merged. Run shepherdr merge ${t.id} again.`)
    // nothing was opened or merged on GitHub: main there has only the commits the gate's runs made
    expect(g.gh().prs).toEqual([])
    expect(sh('git log --format=%s', g.bare)).not.toContain(`${t.id}:`)
    expect(t.merged).toBeFalsy()
  })

  test('the base moves after its gate ran: nothing merges on a base the gate did not check', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pass' }] })
    const { t, key } = await started(w, g.dir, 'pr-gate-after')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm "add hello"', t.worktree!)
    expect(w.settings.set('merge.gate', 'echo "Gate: green"', { space: spaceOf(w, t) }).ok).toBe(true)
    await w.engine.done(t.id, 'Added hello.txt.')
    w.agentIs(key, 'idle')
    // GitHub is slow to answer on the checks, and the test moves main while the merge waits for them
    g.set({ checksSlow: 2000 })
    const merging = w.engine.merge(t.id)
    await until(() => g.gh().calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'checks'), 20_000)
    commitOnGitHub(g)
    const r = await merging
    expect(r.ok).toBe(false)
    expect(r.error).toBe(`main moved on GitHub after ${t.id}'s merge gate ran: nothing was merged, since the gate checks the branch on the base it will land on. Run shepherdr merge ${t.id} again, and the gate runs again on the new main.`)
    expect(g.gh().prs[0]).toMatchObject({ state: 'OPEN' })
    expect(t.merged).toBeFalsy()
    // with the base still: the next merge gates the branch on it and goes in
    g.set({ checksSlow: 0 })
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    expect(g.gh().prs[0].state).toBe('MERGED')
    expect(sh('git log -1 --format=%b main', g.bare)).toBe('Added hello.txt.\n\nGate: green')
  })

  test('a merge that runs past its deadline tells its agent to end its turn, then wakes it with how it went', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pass' }] })
    const goDir = tmp('pr-gate-late')
    const go = join(goDir, 'go')
    const { t, key } = await started(w, g.dir, 'pr-gate-late')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm "add hello"', t.worktree!)
    expect(w.settings.set('merge.gate', waitFor(go, goDir, 'echo "Gate: green"'), { space: spaceOf(w, t) }).ok).toBe(true)
    await w.engine.done(t.id, 'Added hello.txt.')
    w.agentIs(key, 'idle')
    const run = w.engine.merge(t.id)
    // in its gate (a loaded machine takes a while to get there): asked now, its deadline says so
    await until(() => t.landing?.step === 'gate', 20_000)
    expect(w.engine.subOf(t)).toBe('Running the merge gate')
    w.engine.mergeDeadline = 100
    const late = await w.engine.merge(t.id)
    expect(late.error).toContain(`${t.id}'s merge is in its gate: its merge gate still runs`)
    expect(late.error).toContain('end your turn now, without polling or sleeping')
    // waiting in its gate, it holds none of the machine's slots
    expect(w.engine.working()).toBe(0)
    writeFileSync(go, 'go\n')
    await until(() => w.sent.some((x) => x.key === key && x.text.includes('Your merge went in')), 20_000)
    expect((await run).ok).toBe(true)
    expect(w.engine.statusOf(t)).toBe('done')
    expect(g.gh().prs[0].state).toBe('MERGED')
  })

  test('a restart leaves its gate running: the Shepherdr that comes back goes on from it, and its agent hears how it went', async () => {
    const { startGate } = await import('../server/live/engine/engine.ts')
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pass' }] })
    const goDir = tmp('pr-gate-resume')
    const go = join(goDir, 'go')
    const cmd = waitFor(go, goDir, 'echo "Gate: green after the restart"')
    const { t, key } = await started(w, g.dir, 'pr-gate-resume')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm "add hello"', t.worktree!)
    expect(w.settings.set('merge.gate', cmd, { space: spaceOf(w, t) }).ok).toBe(true)
    await w.engine.done(t.id, 'Added hello.txt.')
    w.agentIs(key, 'idle')
    // as a restart leaves it: its merge in its gate, its branch on GitHub's base, its gate's process going on by itself
    sh('git fetch -q origin main && git rebase -q origin/main', t.worktree!)
    const head = sh('git rev-parse HEAD', t.worktree!)
    const tip = sh('git rev-parse refs/remotes/origin/main', g.dir)
    t.landing = { step: 'gate', at: Date.now() }
    const run = startGate(cmd, t.worktree!, {}, tmp('pr-gate-files'), t.id, { head, tip })
    gatesStarted.push(run.pid)
    t.gateRun = run
    w.engine.resumeMerges()
    await until(() => t.landing?.step === 'gate')
    // young, and of a task that still wants it: the restart leaves it running and finds it again
    expect(() => process.kill(run.pid, 0)).not.toThrow()
    writeFileSync(go, 'go\n')
    await until(() => w.sent.some((x) => x.key === key && x.text.includes('Your merge went in')), 20_000)
    expect(t.merged).toBe(true)
    expect(g.gh().prs[0].state).toBe('MERGED')
    expect(sh('git log -1 --format=%b main', g.bare)).toContain('Gate: green after the restart')
  })
})
