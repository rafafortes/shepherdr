// On GitHub (a stand-in, test/fake-gh.ts): one pull request per task, its title, its body, and what ready says once
// its work is in main — by a squash, a merge commit or a hand merge — or its pull request merged already.
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
    expect(pr).toMatchObject({ head: t.branch, base: 'main', title: `${t.id}: Say hello`, isDraft: true })
    expect(pr.body).toContain(`Task: ${t.id}`)
    expect(pr.body).toContain('## Summary')
    expect(pr.body).toContain('Work in progress: the summary comes when the task is done.')
    expect(pr.body).not.toContain('## Proof')
    // what was asked stays reachable from the pull request
    expect(pr.body).toContain('> Add hello.txt. Merge when done.')
    expect(pr.body).toContain('Generated with [Claude Code]')
    // gh is told the host git really talks to
    expect(g.gh().calls.every((c) => c.host === 'github.localhost')).toBe(true)
    expect(sh(`git rev-parse refs/heads/${t.branch}`, g.bare)).toBe(sh('git rev-parse HEAD', t.worktree!))
    // no checks on this repo: nothing to wait for
    expect((await w.engine.checks(t.id, 0)).text).toContain('no checks')
    await w.engine.done(t.id, 'Added hello.txt.')
    await until(() => !g.gh().prs[0].isDraft)
    expect(g.gh().prs[0].body).toContain('## Summary\n\nAdded hello.txt.')
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

  test("a pull request's title names the task and its body is the summary, the proof and the brief", async () => {
    const w = world()
    const g = onGitHub({ remote: 'http://github.localhost/acme/app.git' })
    const { t } = await started(w, g.dir, 'prshape', 'Fix the keyboard', 'Make the keys stop jumping.')
    writeFileSync(join(t.worktree!, 'fix.txt'), 'fix\n')
    sh('git add -A && git commit -qm fix', t.worktree!)
    // opened as a draft, before the task reported ready: no summary, no proof yet, but the brief is reachable
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    const pr = g.gh().prs[0]
    expect(pr.title).toBe(`${t.id}: Fix the keyboard`)
    expect(pr.body).toContain(`Task: ${t.id}`)
    expect(pr.body).toContain('## Summary\n\nWork in progress: the summary comes when the task is done.')
    expect(pr.body).not.toContain('## Proof')
    expect(pr.body).toContain('> Make the keys stop jumping.')
    expect(pr.body).not.toContain(SETTINGS_HEAD) // the brief's Settings block is not "what was asked"
    expect(pr.body).toContain('Generated with [Claude Code]')
    // ready rewrites the body with the summary and the proof, in that order, brief still reachable
    t.facts = 'PR #1 · commit abc123 · not proven: iOS Safari'
    await w.engine.done(t.id, 'The keys stay put now.')
    await until(() => !g.gh().prs[0].isDraft)
    const body = g.gh().prs[0].body
    expect(body).toContain(`Task: ${t.id}`)
    expect(body).toContain('## Summary\n\nThe keys stay put now.')
    expect(body).toContain('## Proof\n\nPR #1 · commit abc123 · not proven: iOS Safari')
    expect(body).toContain('> Make the keys stop jumping.')
    expect(body.indexOf('## Summary')).toBeLessThan(body.indexOf('## Proof'))
    expect(body.indexOf('## Proof')).toBeLessThan(body.indexOf('**Brief**'))
    expect(body.indexOf('**Brief**')).toBeLessThan(body.indexOf('Generated with'))
    expect(g.gh().prs[0].title).toBe(`${t.id}: Fix the keyboard`)
  })

  test('a pull request title that already names the task is not named twice, and extra spaces collapse', async () => {
    const w = world()
    const g = onGitHub({ remote: 'http://github.localhost/acme/app.git' })
    const named = await started(w, g.dir, 'prnamed', undefined, 'Work.')
    writeFileSync(join(named.t.worktree!, 'a.txt'), 'a\n')
    sh('git add -A && git commit -qm a', named.t.worktree!)
    named.t.title = `${named.t.id}: Already named`
    expect((await w.engine.openPr(named.t.id)).ok).toBe(true)
    expect(g.gh().prs[0].title).toBe(`${named.t.id}: Already named`)
    const spaced = await started(w, g.dir, 'prspaced', undefined, 'Work.')
    writeFileSync(join(spaced.t.worktree!, 'b.txt'), 'b\n')
    sh('git add -A && git commit -qm b', spaced.t.worktree!)
    spaced.t.title = 'Two   spaces'
    expect((await w.engine.openPr(spaced.t.id)).ok).toBe(true)
    expect(g.gh().prs[1].title).toBe(`${spaced.t.id}: Two spaces`)
  })

  test("ready leaves a pull request's title the human edited by hand alone", async () => {
    const w = world()
    const g = onGitHub({ remote: 'http://github.localhost/acme/app.git' })
    const { t } = await started(w, g.dir, 'prhand', undefined, 'Add a header.')
    writeFileSync(join(t.worktree!, 'h.txt'), 'h\n')
    sh('git add -A && git commit -qm h', t.worktree!)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    // the human renamed the pull request on GitHub; Shepherdr only sets a title when it opens one
    g.set({ prs: g.gh().prs.map((p) => ({ ...p, title: 'A title the human picked' })) })
    t.reported = true
    t.said = 'The header is in.'
    t.facts = 'commit abc123'
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    expect(g.gh().prs[0].title).toBe('A title the human picked')
    const body = g.gh().prs[0].body
    expect(body).toContain('## Summary\n\nThe header is in.')
    expect(body).toContain('## Proof\n\ncommit abc123')
    expect(body).toContain('> Add a header.')
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
})
