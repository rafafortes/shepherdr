// On GitHub (a stand-in, test/fake-gh.ts): the merge itself, from the pull request it opens to the rebase a conflict
// needs, and a merge that is Merging, not Ready, until its work is in.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { sh, repo, world, until, started, G, Settings } from './engine-world.ts'
import type { FakeGitHub } from './fake-gh.ts'
import { tmp } from './tmp.ts'
import { killGroup, processes } from '../server/procs.ts'
import { SETTINGS_HEAD } from '../shared/brief.ts'

// each test runs git dozens of times and gh (a bun process of its own) up to fifty: a few seconds alone, past 20 on a
// machine as busy as a CI runner can get
setDefaultTimeout(60_000)

/** a waiting gate command that ends by itself: when its folder goes, when the test process that started it goes (even
 *  one killed without cleanup), or after 1200 turns (about a minute), rather than forking sleep for days (LEAD-01).
 *  `dir` holds `go`; `after` is what it says when it ends. A production gate has no test pid: its own hard limit stops it. */
const waitFor = (go: string, dir: string, after = 'echo ok') =>
  `i=0; while [ ! -f ${go} ] && [ -d ${dir} ] && kill -0 ${process.pid} 2>/dev/null && [ \$i -lt 1200 ]; do sleep 0.05; i=\$((i+1)); done; ${after}`

/** every gate this file starts by hand, so a failing or interrupted test cannot leave one behind */
const gatesStarted: number[] = []
async function gate(cmd: string, wt: string, env: Record<string, string>, dir: string, id: string, at: { head: string; tip: string }, limitMs?: number, hasTimeout?: boolean) {
  const { startGate } = await import('../server/live/engine/engine.ts')
  const run = startGate(cmd, wt, env, dir, id, at, limitMs, hasTimeout)
  gatesStarted.push(run.pid)
  return run
}
const groupAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** a gate is gone only when no process still runs its command: `timeout` may lead a group of its own, so the leader's
 *  pid alone cannot tell (LEAD-01). Its log path is unique to this run and survives in the command line. */
const gateGone = (run: { log: string; exit: string }) =>
  !processes().some((p) => p.cmd.includes(run.log) || p.cmd.includes(run.exit))
afterEach(() => {
  for (const pid of gatesStarted.splice(0)) killGroup(pid)
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
})
