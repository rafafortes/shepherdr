// On GitHub (a stand-in, test/fake-gh.ts): one pull request per task, its title, its body, and what ready says once
// its work is in main — by a squash, a merge commit or a hand merge — or its pull request merged already.
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { described, PR_BODY_END, PR_BODY_START } from '../server/live/engine/merge.ts'
import { resolveTakenPr } from '../server/live/engine/taken-pr.ts'
import { SETTINGS_HEAD } from '../shared/brief.ts'
import { G, repo, Settings, sh, started, until, world } from './engine-world.ts'
import type { FakeGitHub, FakePr } from './fake-gh.ts'
import { tmp } from './tmp.ts'

// each test runs git dozens of times and gh (a bun process of its own) up to fifty: a few seconds alone, past 20 on a
// machine as busy as a CI runner can get
setDefaultTimeout(60_000)

/** a GitHub stand-in: a bare repo is GitHub, gh is test/fake-gh.ts; the clone's origin reads as GitHub's */
const ghBin = tmp('ghbin')
writeFileSync(join(ghBin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, 'fake-gh.ts')}" "$@"\n`, { mode: 0o755 })

function onGitHub(o: { authed?: boolean; down?: boolean; checks?: FakeGitHub['checks']; remote?: string; listUnreadable?: boolean; tipListUnreadable?: boolean; viewUnreadable?: boolean } = {}) {
  process.env.PATH = `${ghBin}:${process.env.PATH}`
  const bare = tmp('gh-origin')
  sh('git init -q --bare -b main', bare)
  sh(`git push -q ${bare} main`, repo())
  const dir = tmp('gh-clone')
  const remote = o.remote ?? 'https://github.com/acme/app.git'
  sh(`git clone -q ${bare} . && git config user.email t@t && git config user.name T && git remote set-url origin ${remote} && git config url.${bare}.insteadOf ${remote}`, dir)
  const file = join(tmp('gh-state'), 'github.json')
  writeFileSync(
    file,
    JSON.stringify({
      origin: bare,
      repo: 'acme/app',
      prs: [],
      calls: [],
      authed: o.authed,
      down: o.down,
      checks: o.checks,
      listUnreadable: o.listUnreadable,
      tipListUnreadable: o.tipListUnreadable,
      viewUnreadable: o.viewUnreadable,
    }),
  )
  process.env.FAKE_GH_STATE = file
  const gh = () => JSON.parse(readFileSync(file, 'utf8')) as FakeGitHub
  const set = (patch: Partial<FakeGitHub>) => writeFileSync(file, JSON.stringify({ ...gh(), ...patch }))
  return { bare, dir, gh, set }
}

afterEach(() => void new Settings().set('brief.merge', null))

/**
 * The person merging a task's pull request by hand on GitHub, with the squash button: main there gets the squash and
 * the pull request says it merged at the commit it was at, while the branch keeps its own commits (a squash merge
 * leaves them out of the base). Returns that commit.
 */
function mergedByHand(g: ReturnType<typeof onGitHub>, branch: string, subject = 'Say hello (#1)') {
  const tip = sh(`git rev-parse refs/heads/${branch}`, g.bare)
  const dir = tmp('gh-byhand')
  sh(
    `git clone -q ${g.bare} . && git config user.email t@t && git config user.name T && git fetch -q origin ${branch} && git merge -q --squash FETCH_HEAD && git commit -qm "${subject}" && git push -q origin main`,
    dir,
  )
  g.set({ prs: g.gh().prs.map((p) => (p.head === branch ? { ...p, state: 'MERGED' as const, at: tip } : p)) })
  return tip
}

/** how many pull requests the engine asked GitHub to open (a second one for the same branch is the bug) */
const opened = (g: ReturnType<typeof onGitHub>) => g.gh().calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create').length

/** the pull-request lookups, in order: the branch's, then — only when that was empty — the one by exact tip */
const lists = (g: ReturnType<typeof onGitHub>) => g.gh().calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'list')

/** push the task's exact tip onto a fix-forward branch, the way a reviewer or the coordinator would */
const fixForward = (wt: string) => sh('git push -q origin HEAD:refs/heads/fix-forward', wt)

/** narrow a task's worktree and branch once; the ratchet on non-null assertions in this file stays at its baseline */
const worktreeOf = (t: { worktree?: string }) => {
  if (!t.worktree) throw new Error('task has no worktree')
  return t.worktree
}
const branchOf = (t: { branch?: string }) => {
  if (!t.branch) throw new Error('task has no branch')
  return t.branch
}

describe('on GitHub: a pull request per task', () => {
  test('its origin is read as written and as git rewrites it: github.com mapped to github.localhost talks to github.localhost', async () => {
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

  test('shepherdr pr refuses a worktree switched to another branch, naming both and pushing nothing', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'foreign-pr')
    const branch = branchOf(t)
    const wt = worktreeOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm work', wt)
    sh('git switch -q -c other', wt)
    writeFileSync(join(wt, 'other.txt'), 'other\n')
    sh('git add -A && git commit -qm other', wt)
    const r = await w.engine.openPr(t.id)
    expect(r.ok).toBe(false)
    expect(r.text).toContain('HEAD is on other')
    expect(r.text).toContain(branch)
    expect(r.text).toContain('git switch')
    expect(r.text).toContain('ask your coordinator')
    expect(g.gh().prs).toHaveLength(0)
    expect(sh("git for-each-ref --format='%(refname)' refs/heads", g.bare)).toBe('refs/heads/main') // nothing was pushed
    expect(sh('git rev-parse HEAD', wt)).toBe(sh('git rev-parse other', wt)) // the work is still there
  })

  test('shepherdr merge refuses a worktree switched to another branch and lands nothing', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'foreign-merge')
    const wt = worktreeOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm work', wt)
    sh('git switch -q -c other', wt)
    writeFileSync(join(wt, 'other.txt'), 'other\n')
    sh('git add -A && git commit -qm other', wt)
    const main = sh('git rev-parse main', g.bare)
    const r = await w.engine.merge(t.id, { self: true })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('HEAD is on other')
    expect(r.error).toContain(branchOf(t))
    expect(sh('git rev-parse main', g.bare)).toBe(main)
    expect(sh("git for-each-ref --format='%(refname)' refs/heads", g.bare)).toBe('refs/heads/main')
  })

  test('a detached HEAD at the task branch tip is allowed; another detached commit is refused', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'detached-head')
    const wt = worktreeOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm work', wt)
    // a check run detaches HEAD at the task branch's own tip: that commit is the task's, so it may be pushed
    sh('git checkout -q --detach', wt)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    expect(g.gh().prs[0].head).toBe(branchOf(t))
    sh('git checkout -q --detach HEAD~1', wt)
    const r = await w.engine.openPr(t.id)
    expect(r.ok).toBe(false)
    expect(r.text).toContain('detached commit')
    expect(r.text).toContain(branchOf(t))
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

  test('ready marks a pull request merged by hand before the review gate would refuse its unreviewed commit', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'test', bucket: 'pass' }] })
    const { t } = await started(w, g.dir, 'ghbyhand-gate')
    const wt = worktreeOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', wt)
    // a round counted but never recorded: the gate would say the final commit is unreviewed
    await w.engine.reviewRound(t.id)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    mergedByHand(g, t.branch ?? '')
    expect(await w.engine.done(t.id, 'Added hello.txt.')).toEqual({ state: 'merged', note: 'PR #1 was merged on GitHub' })
    expect(t.merged).toBe(true)
    expect(opened(g)).toBe(1)
  })

  test('merge marks a pull request merged by hand before the review gate would refuse its unreviewed commit', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghbyhand-merge-gate')
    const wt = worktreeOf(t)
    writeFileSync(join(wt, 'y.txt'), 'y\n')
    sh('git add -A && git commit -qm y', wt)
    await w.engine.reviewRound(t.id) // no --done: the gate would refuse
    await w.engine.openPr(t.id)
    mergedByHand(g, t.branch ?? '')
    expect(await w.engine.merge(t.id, { self: true })).toEqual({ ok: true, note: 'PR #1 was merged on GitHub already' })
    expect(t.merged).toBe(true)
    expect(sh('git rev-parse main', g.dir)).toBe(sh('git rev-parse main', g.bare))
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

  test('the watch sees a pull request merged on GitHub by hand: Done (merged), never Ready for ever', async () => {
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

  test('shepherdr pr keeps an open pull request on another branch at the exact tip, never opening a second one', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghtip')
    const wt = worktreeOf(t)
    const branch = branchOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', wt)
    const tip = sh('git rev-parse HEAD', wt)
    // a reviewer pushed the exact tip onto a fix-forward branch and opened that branch's pull request
    fixForward(wt)
    g.set({ prs: [{ number: 7, head: 'fix-forward', base: 'main', title: 'Fix forward', body: '', isDraft: false, state: 'OPEN' }] })
    const r = await w.engine.openPr(t.id)
    expect(r.ok).toBe(true)
    expect(r.text).toContain('PR #7')
    expect(t.pr).toEqual({ number: 7, url: 'https://github.com/acme/app/pull/7' })
    expect(g.gh().prs.length).toBe(1)
    expect(opened(g)).toBe(0)
    // its own branch was still pushed, and the pull request it continues stays the one on the fix-forward branch
    expect(sh(`git rev-parse refs/heads/${branch}`, g.bare)).toBe(tip)
    expect(sh('git rev-parse refs/heads/fix-forward', g.bare)).toBe(tip)
    // two lookups: the branch's came back empty, then the tip's — bounded, with no branch in it
    expect(lists(g).length).toBe(2)
    expect(lists(g)[1].args).toContain('open')
    expect(lists(g)[1].args).toContain('30')
    expect(lists(g)[1].args).not.toContain('--head')
  })

  test('an open pull request on the task’s own branch wins over one at the same tip on another branch', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghown')
    const wt = worktreeOf(t)
    const branch = branchOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', wt)
    fixForward(wt)
    g.set({
      prs: [
        { number: 1, head: branch, base: 'main', title: 'Its own', body: '', isDraft: false, state: 'OPEN' },
        { number: 7, head: 'fix-forward', base: 'main', title: 'Fix forward', body: '', isDraft: false, state: 'OPEN' },
      ],
    })
    const r = await w.engine.openPr(t.id)
    expect(r.ok).toBe(true)
    expect(r.text).toContain('PR #1')
    expect(t.pr?.number).toBe(1)
    expect(opened(g)).toBe(0)
    expect(lists(g).length).toBe(1) // the branch's own open pull request answered: no tip lookup
  })

  test('a merged pull request on another branch at the exact tip is never adopted', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghmergedtip')
    const wt = worktreeOf(t)
    const branch = branchOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', wt)
    const tip = sh('git rev-parse HEAD', wt)
    fixForward(wt)
    g.set({ prs: [{ number: 7, head: 'fix-forward', base: 'main', title: 'Fix forward', body: '', isDraft: false, state: 'MERGED', at: tip }] })
    const r = await w.engine.openPr(t.id)
    expect(r.ok).toBe(true)
    expect(lists(g).length).toBe(2)
    expect(opened(g)).toBe(1)
    expect(g.gh().prs.length).toBe(2)
    const made = g.gh().prs.filter((p) => p.number !== 7)[0]
    expect(made?.head).toBe(branch)
    expect(t.pr?.number).toBe(made?.number)
  })

  test('the tip lookup is made only when the branch lookup came back empty', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghlookups')
    const wt = worktreeOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', wt)
    await w.engine.openPr(t.id)
    expect(lists(g).length).toBe(2) // no pull request at all: the branch's lookup, then the tip's
    // the branch has an open pull request now; forget the recorded number so findPr runs again
    t.pr = undefined
    const before = lists(g).length
    await w.engine.openPr(t.id)
    expect(lists(g).length).toBe(before + 1) // only the branch's lookup this time
    expect((t.pr as { number: number } | undefined)?.number).toBe(1)
  })

  test('an unreadable GitHub answer leaves no pull request, so the caller opens one', async () => {
    const w = world()
    const g = onGitHub({ listUnreadable: true })
    const { t } = await started(w, g.dir, 'ghjunk')
    const wt = worktreeOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', wt)
    const r = await w.engine.openPr(t.id)
    expect(r.ok).toBe(true)
    expect(t.pr?.number).toBe(1)
    expect(opened(g)).toBe(1)
    expect(lists(g).length).toBe(1) // nothing readable came back, so there is no tip lookup
  })

  test('an unreadable tip answer still leaves the branch’s merged pull request in place', async () => {
    const w = world()
    const g = onGitHub({ tipListUnreadable: true })
    const { t } = await started(w, g.dir, 'ghtipjunk')
    const wt = worktreeOf(t)
    const branch = branchOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', wt)
    g.set({ prs: [{ number: 1, head: branch, base: 'main', title: 'Merged', body: '', isDraft: false, state: 'MERGED', at: sh('git rev-parse HEAD', wt) }] })
    const r = await w.engine.openPr(t.id)
    expect(r.ok).toBe(false)
    expect(r.text).toContain('PR #1 is merged on GitHub already')
    expect(opened(g)).toBe(0)
    expect(lists(g).length).toBe(2) // the branch's list was readable; only the tip's was junk
  })
})

describe('the marked part of a pull request body', () => {
  const want = `${PR_BODY_START}\nTask: T-1\n\n## Summary\n\nNew words.\n${PR_BODY_END}`

  test('an unmarked body is rewritten whole, rather than guessing which words are ours', () => {
    expect(described('A person wrote this.', want)).toBe(want)
    expect(described('', want)).toBe(want)
    expect(described(undefined, want)).toBe(want)
  })

  test('a half-marked body is left alone: a broken block must not cost the words around it', () => {
    expect(described(`A note.\n\n${PR_BODY_START}\nOld words.`, want)).toBeUndefined()
    expect(described(`Old words.\n\n${PR_BODY_END}\n\nA note.`, want)).toBeUndefined()
    expect(described(`${PR_BODY_END}\n\nA note.\n\n${PR_BODY_START}`, want)).toBeUndefined()
  })

  test('between the marks only: words around them survive and the marks stay for the next ready', () => {
    const current = `Look at this.\n\n${PR_BODY_START}\nOld words.\n${PR_BODY_END}\n\nSigned, a reviewer.`
    const once = described(current, want)
    expect(once).toBe(`Look at this.\n\n${want}\n\nSigned, a reviewer.`)
    const twice = described(`${once}\n\nOne more note.`, want)
    expect(twice).toBe(`Look at this.\n\n${want}\n\nSigned, a reviewer.\n\nOne more note.`)
  })

  test('ready keeps a reviewer’s words above and below our marked part', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'prmarked')
    const wt = worktreeOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', wt)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    const marked = g.gh().prs[0].body
    expect(marked).toContain(PR_BODY_START)
    expect(marked).toContain(PR_BODY_END)
    // the reviewer adds words around Shepherdr's block on GitHub
    g.set({ prs: g.gh().prs.map((p) => ({ ...p, body: `Reviewer note above.\n\n${marked}\n\nReviewer note below.` })) })
    await w.engine.done(t.id, 'Added a hello.')
    await until(() => g.gh().prs[0].body.includes('## Summary\n\nAdded a hello.'))
    const body = g.gh().prs[0].body
    expect(body).toStartWith('Reviewer note above.')
    expect(body).toEndWith('Reviewer note below.')
    expect(body).toContain(`${PR_BODY_START}\n\nTask: ${t.id}`)
    expect(body.split(PR_BODY_START)).toHaveLength(2)
    expect(body.split(PR_BODY_END)).toHaveLength(2)
    expect(body).not.toContain('Work in progress')
  })

  test('merge keeps a person’s words around our marked part too', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'prmergedbody')
    const wt = worktreeOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', wt)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    const marked = g.gh().prs[0].body
    g.set({ prs: g.gh().prs.map((p) => ({ ...p, body: `A note before ready.\n\n${marked}` })) })
    await w.engine.done(t.id, 'Added a hello.')
    await until(() => g.gh().prs[0].body.includes('Added a hello.'))
    // another note arrives between ready and the merge's own rewrite
    g.set({ prs: g.gh().prs.map((p) => ({ ...p, body: `${p.body}\n\nA note before merge.` })) })
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    const body = g.gh().prs[0].body
    expect(body).toStartWith('A note before ready.')
    expect(body).toContain('A note before merge.')
    expect(body).toContain('## Summary\n\nAdded a hello.')
  })

  test('a mark quoted in the summary cannot close our block early on a later report', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'prquoted')
    const wt = worktreeOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', wt)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    const said = `I wrote ${PR_BODY_END} literally.`
    const facts = `and ${PR_BODY_START} too`
    await w.engine.done(t.id, said, facts)
    await until(() => g.gh().prs[0].body.includes('literally.'))
    const first = g.gh().prs[0].body
    expect(first.split(PR_BODY_END)).toHaveLength(2)
    expect(first).toContain('&lt;!-- /shepherdr --&gt;')
    expect(first).toContain('&lt;!-- shepherdr --&gt;')
    // a second report on the same pull request must not leave a second copy of the quoted tail behind
    g.set({ prs: g.gh().prs.map((p) => ({ ...p, body: `A note.\n\n${p.body}` })) })
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    await until(() => g.gh().prs[0].body.includes('A note.'))
    const second = g.gh().prs[0].body
    expect(second).toStartWith('A note.')
    expect(second.split(PR_BODY_END)).toHaveLength(2)
    expect(second).not.toContain('literally.\n\nA note.')
  })

  test('a body with a broken mark is left alone, and the skip is logged', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'prhalfmarked')
    const wt = worktreeOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', wt)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    const calls = (verb: string) => g.gh().calls.filter((c) => c.args[0] === 'pr' && c.args[1] === verb).length
    const edits = calls('edit')
    const logged: string[] = []
    const stderr = spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logged.push(a.join(' ')))
    try {
      // the human removed the end mark while editing our block
      g.set({ prs: g.gh().prs.map((p) => ({ ...p, body: `A note.\n\n${PR_BODY_START}\nOld words.` })) })
      await w.engine.done(t.id, 'Added a hello.')
      await until(() => logged.some((l) => l.includes('marks are incomplete')))
      expect(calls('edit')).toBe(edits)
      expect(logged).toContain(`shepherdr: ${t.id}: pull request description not updated: its Shepherdr marks are incomplete`)
      expect(g.gh().prs[0].body).toBe(`A note.\n\n${PR_BODY_START}\nOld words.`)
    } finally {
      stderr.mockRestore()
    }
  })

  test('a body GitHub will not show is left alone, and the skip is logged', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'prunreadable')
    const wt = worktreeOf(t)
    writeFileSync(join(wt, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', wt)
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    const calls = (verb: string) => g.gh().calls.filter((c) => c.args[0] === 'pr' && c.args[1] === verb).length
    const views = calls('view')
    const edits = calls('edit')
    const logged: string[] = []
    const stderr = spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logged.push(a.join(' ')))
    try {
      g.set({ prs: [] }) // pr view cannot find it now
      await w.engine.done(t.id, 'Added a hello.')
      await until(() => logged.some((l) => l.includes('description not updated')))
      expect(calls('view')).toBeGreaterThan(views)
      expect(calls('edit')).toBe(edits)
      expect(logged).toContain(`shepherdr: ${t.id}: pull request description not updated: GitHub did not show it`)
    } finally {
      stderr.mockRestore()
    }
  })
})

describe('taking a pull request that is already open', () => {
  type Hub = ReturnType<typeof onGitHub>
  /** a branch on GitHub with one commit, for a pull request a task can take */
  const bump = (g: Hub, branch = 'dep/bump', subject = 'Bump a dependency') => {
    sh(`git switch -q -c ${branch} main && echo dep > dep.txt && git add -A && git commit -qm "${subject}" && git push -q origin ${branch} && git switch -q main`, g.dir)
    return sh(`git rev-parse refs/heads/${branch}`, g.bare)
  }
  const open = (n: number, branch = 'dep/bump', base = 'main'): FakePr => ({ number: n, head: branch, base, title: 'Bump', body: '', isDraft: false, state: 'OPEN' })
  const resolve = async (g: Hub, number: string, base = 'main', tasks: Parameters<typeof resolveTakenPr>[0]['tasks'] = [], self?: string) => {
    const hub = await G.github(g.dir)
    if (!hub) throw new Error('the test repo has no GitHub remote')
    return resolveTakenPr({ g: hub, cwd: g.dir, number, base, tasks, self })
  }
  const refusal = async (f: () => Promise<unknown>) => {
    try {
      await f()
    } catch (e) {
      return (e as Error).message
    }
    throw new Error('expected a refusal')
  }
  /** a task whose worktree started on the taken pull request's branch */
  const taking = async (w: ReturnType<typeof world>, g: Hub, name: string, n = 5) => {
    const p = await w.places.add(g.dir, name)
    const taken = await w.engine.prToTake(p.name, String(n), 'main')
    const t = w.engine.add({ project: p.name, title: 'Take the bump', by: 'test', pr: taken })
    await until(() => {
      try {
        return existsSync(worktreeOf(t))
      } catch {
        return false
      }
    })
    return { p, t, taken }
  }

  test('a number is read from GitHub with its head branch, and a wrong number or an unreadable answer is refused', async () => {
    const g = onGitHub()
    const tip = bump(g)
    g.set({ prs: [open(5)] })
    const taken = await resolve(g, ' #5 ')
    expect(taken).toMatchObject({ number: 5, branch: 'dep/bump', base: 'main', repo: 'acme/app', url: 'https://github.com/acme/app/pull/5' })
    expect(taken.head).toBe(tip)
    for (const bad of ['', 'abc', '5x', '#', '5.2']) expect(await refusal(() => resolve(g, bad))).toContain('--pr takes')
    expect(await refusal(() => resolve(g, '9'))).toContain('Could not find pull request #9')
    g.set({ viewUnreadable: true })
    expect(await refusal(() => resolve(g, '5'))).toContain('readable pull request')
    g.set({ viewUnreadable: false, viewFail: 'Resource not accessible' })
    expect(await refusal(() => resolve(g, '5'))).toContain('Resource not accessible')
    g.set({ viewFail: undefined, noHeadRef: true })
    expect(await refusal(() => resolve(g, '5'))).toContain('has no head branch')
  })

  test('a closed pull request, a fork, another repo or another base is refused with why', async () => {
    const g = onGitHub()
    bump(g)
    g.set({ prs: [{ ...open(5), state: 'CLOSED' }] })
    expect(await refusal(() => resolve(g, '5'))).toContain('is closed')
    g.set({ prs: [{ ...open(5), isCrossRepository: true }] })
    expect(await refusal(() => resolve(g, '5'))).toContain('comes from a fork')
    g.set({ prs: [{ ...open(5), url: 'https://github.com/other/repo/pull/5' }] })
    expect(await refusal(() => resolve(g, '5'))).toContain('is not in github.com/acme/app')
    g.set({ prs: [{ ...open(5), url: 'not a url' }] })
    expect(await refusal(() => resolve(g, '5'))).toContain('is not in github.com/acme/app')
    g.set({ prs: [open(6, 'dep/bump', 'develop')] })
    expect(await refusal(() => resolve(g, '6'))).toContain('merges into develop')
  })

  test('a pull request held by another task is refused, by number, taken head or own branch; a done one, one’s own or another repo’s is not', async () => {
    const g = onGitHub()
    bump(g)
    g.set({ prs: [open(5)] })
    const mine = { repo: 'acme/app' }
    expect(await refusal(() => resolve(g, '5', 'main', [{ ...mine, id: 'X-1', pr: { number: 5, url: 'x' } }]))).toContain("already X-1's")
    expect(await refusal(() => resolve(g, '5', 'main', [{ ...mine, id: 'X-2', pr: { number: 6, url: 'x', taken: true, branch: 'dep/bump' } }]))).toContain("already X-2's")
    expect(await refusal(() => resolve(g, '5', 'main', [{ ...mine, id: 'X-4', branch: 'dep/bump' }]))).toContain("already X-4's")
    expect(await refusal(() => resolve(g, '5', 'main', [{ id: 'X-5', branch: 'dep/bump', pr: { number: 9, url: 'x', taken: true } }]))).toContain("already X-5's")
    for (const gone of [{ merged: true }, { closed: true }, { doneAt: Date.now() }])
      expect((await resolve(g, '5', 'main', [{ ...mine, id: 'X-3', pr: { number: 5, url: 'x' }, ...gone }])).number).toBe(5)
    expect((await resolve(g, '5', 'main', [{ ...mine, id: 'X-1', pr: { number: 5, url: 'x' } }], 'X-1')).number).toBe(5)
    // the same number in another repo belongs to a different pull request, and does not block this one
    expect((await resolve(g, '5', 'main', [{ repo: 'other/repo', id: 'Y-1', pr: { number: 5, url: 'x', repo: 'other/repo' } }])).number).toBe(5)
  })

  test('task add and task start refuse --pr without a GitHub remote, or an unknown project', async () => {
    const w = world()
    expect(await refusal(() => w.engine.prToTake('nope', '5'))).toContain('No project called nope')
    const p = await w.places.add(repo(), 'plain')
    expect(await refusal(() => w.engine.prToTake(p.name, '5'))).toContain('has no GitHub remote')
  })

  test('the worktree starts on the taken branch, the agent knows, and ready, pr and merge follow that pull request', async () => {
    const w = world()
    const g = onGitHub()
    const tip = bump(g)
    g.set({ prs: [open(5)] })
    const { t, taken } = await taking(w, g, 'take-flow')
    expect(t.pr).toMatchObject({ number: 5, url: 'https://github.com/acme/app/pull/5', taken: true, branch: 'dep/bump', repo: 'acme/app', headRefOid: tip })
    expect(taken.head).toBe(tip)
    expect(sh('git rev-parse HEAD', worktreeOf(t))).toBe(tip)
    const system = w.started.find((s) => s.key === `${t.id}/Agent`)?.system
    expect(system).toContain('took pull request #5 (branch dep/bump)')
    expect(system).toContain('never opening a second one')
    writeFileSync(join(worktreeOf(t), 'work.txt'), 'work')
    sh('git add -A && git commit -qm work', worktreeOf(t))
    const r = await w.engine.openPr(t.id)
    expect(r.ok).toBe(true)
    expect(r.text).toContain('Pushed to PR #5')
    expect(g.gh().prs).toHaveLength(1)
    expect(opened(g)).toBe(0)
    expect(sh('git rev-parse refs/heads/dep/bump', g.bare)).toBe(sh('git rev-parse HEAD', worktreeOf(t)))
    expect(sh(`git branch --list ${branchOf(t)}`, g.bare)).toBe('')
    await w.engine.done(t.id, 'Took the bump.')
    await until(() => g.gh().prs[0].isDraft === false)
    const m = await w.engine.merge(t.id, { self: true })
    expect(m.ok).toBe(true)
    expect(g.gh().prs[0].state).toBe('MERGED')
    expect(sh('git show main:work.txt', g.bare)).toBe('work')
  })

  test('a taken branch gone from GitHub is refused before any worktree is made', async () => {
    const w = world()
    const g = onGitHub()
    const p = await w.places.add(g.dir, 'take-gone')
    const t = w.engine.add({
      project: p.name,
      title: 'Gone branch',
      by: 'test',
      pr: { number: 9, url: 'https://github.com/acme/app/pull/9', branch: 'gone/branch', head: sh('git rev-parse main', g.bare), base: 'main', repo: 'acme/app' },
    })
    await until(() => !!t.trouble)
    expect(t.trouble).toContain('Could not fetch pull request #9')
    expect(t.worktree).toBeUndefined()
  })

  test('merge itself pushes to the taken branch, never opening a second pull request', async () => {
    const w = world()
    const g = onGitHub()
    bump(g)
    g.set({ prs: [open(5)] })
    const { t } = await taking(w, g, 'take-merge')
    writeFileSync(join(worktreeOf(t), 'work.txt'), 'work')
    sh('git add -A && git commit -qm work', worktreeOf(t))
    const head = sh('git rev-parse HEAD', worktreeOf(t))
    // no shepherdr pr first: merge must push to the pull request's branch, not the task's own
    await w.engine.done(t.id, 'Ready to merge.')
    const m = await w.engine.merge(t.id, { self: true })
    expect(m.ok).toBe(true)
    expect(sh('git rev-parse refs/heads/dep/bump', g.bare)).toBe(head)
    expect(sh('git branch --list work/*', g.bare)).toBe('')
    expect(g.gh().prs).toHaveLength(1)
    expect(opened(g)).toBe(0)
    expect(g.gh().prs[0].state).toBe('MERGED')
  })

  test('a taken pull request behind its base is brought up to date with a merge, not a rebase, and merges', async () => {
    const w = world()
    const g = onGitHub()
    bump(g)
    g.set({ prs: [open(5)] })
    const { t } = await taking(w, g, 'take-behind')
    writeFileSync(join(worktreeOf(t), 'work.txt'), 'work')
    sh('git add -A && git commit -qm work', worktreeOf(t))
    // main moves on GitHub, so the gate would otherwise rebase the branch and break the non-forced push
    sh('git checkout -q main && echo base > base.txt && git add -A && git commit -qm "base moved" && git push -q origin main && git fetch -q origin && git checkout -q dep/bump', g.dir)
    expect(w.settings.set('merge.gate', 'echo gate ok', { space: w.engine.view(t).place.split(':').pop() ?? '' }).ok).toBe(true)
    await w.engine.done(t.id, 'Ready.')
    const before = sh('git rev-parse HEAD', worktreeOf(t))
    // the branch is behind: the base was not its ancestor, so a rebase would rewrite the commit GitHub has
    expect((await G.git(worktreeOf(t), 'merge-base', '--is-ancestor', 'origin/main', 'HEAD')).ok).toBe(false)
    const r = await w.engine.merge(t.id, { self: true })
    expect(r.ok).toBe(true)
    // the merge, not a rebase, brought the base into the taken branch: its new tip holds both changes
    const pushedTip = sh('git rev-parse refs/heads/dep/bump', g.bare)
    expect(pushedTip).not.toBe(before)
    expect(sh(`git show ${pushedTip}:base.txt`, g.bare)).toBe('base')
    expect(sh(`git show ${pushedTip}:work.txt`, g.bare)).toBe('work')
    expect(sh('git show main:base.txt', g.bare)).toBe('base')
    expect(sh('git show main:work.txt', g.bare)).toBe('work')
    expect(g.gh().prs).toHaveLength(1)
    expect(opened(g)).toBe(0)
    expect(g.gh().prs[0].state).toBe('MERGED')
  })

  test('a taken pull request that conflicts with its base is refused with how to resolve it', async () => {
    const w = world()
    const g = onGitHub()
    bump(g)
    g.set({ prs: [open(5)] })
    const { t } = await taking(w, g, 'take-conflict')
    writeFileSync(join(worktreeOf(t), 'dep.txt'), 'task version\n')
    sh('git add -A && git commit -qm "task dep"', worktreeOf(t))
    sh('git checkout -q main && echo "base version" > dep.txt && git add -A && git commit -qm "base dep" && git push -q origin main && git fetch -q origin && git checkout -q dep/bump', g.dir)
    expect(w.settings.set('merge.gate', 'echo gate ok', { space: w.engine.view(t).place.split(':').pop() ?? '' }).ok).toBe(true)
    await w.engine.done(t.id, 'Ready.')
    const r = await w.engine.merge(t.id, { self: true })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('conflicts with main')
    expect(r.error).toContain('dep/bump')
    expect(r.error).toContain('Nothing was merged')
    expect(g.gh().prs[0].state).toBe('OPEN')
    expect(opened(g)).toBe(0)
  })

  test('a taken branch that moved on GitHub is not overwritten with a forced push', async () => {
    const w = world()
    const g = onGitHub()
    bump(g)
    g.set({ prs: [open(5)] })
    const { t } = await taking(w, g, 'take-noforce')
    writeFileSync(join(worktreeOf(t), 'work.txt'), 'work')
    sh('git add -A && git commit -qm work', worktreeOf(t))
    // someone else advances the pull request's branch; a force push would destroy their commit
    sh('git switch -q dep/bump && echo other > other.txt && git add -A && git commit -qm other && git push -q origin dep/bump', g.dir)
    const theirs = sh('git rev-parse refs/heads/dep/bump', g.bare)
    const r = await w.engine.openPr(t.id)
    expect(r.ok).toBe(false)
    expect(r.text).toContain('Could not push')
    expect(sh('git rev-parse refs/heads/dep/bump', g.bare)).toBe(theirs)
    expect(g.gh().prs).toHaveLength(1)
    expect(opened(g)).toBe(0)
  })

  test('a closed or vanished taken pull request is refused before a push, never replaced with a new one', async () => {
    const w = world()
    const g = onGitHub()
    const tip = bump(g)
    g.set({ prs: [open(5)] })
    const { t } = await taking(w, g, 'take-closed')
    writeFileSync(join(worktreeOf(t), 'work.txt'), 'work')
    sh('git add -A && git commit -qm work', worktreeOf(t))
    g.set({ prs: [{ ...open(5), state: 'CLOSED' }] })
    const r = await w.engine.openPr(t.id)
    expect(r.ok).toBe(false)
    expect(r.text).toContain('is closed on GitHub')
    expect(r.text).toContain('--pr <n>')
    const m = await w.engine.merge(t.id, { self: true })
    expect(m.ok).toBe(false)
    expect(m.error).toContain('is closed on GitHub')
    g.set({ prs: [] })
    expect((await w.engine.openPr(t.id)).text).toContain('Could not read pull request #5')
    expect(g.gh().prs).toHaveLength(0)
    expect(opened(g)).toBe(0)
    expect(sh('git rev-parse refs/heads/dep/bump', g.bare)).toBe(tip)
  })

  test('ready takes a pull request by number, lets it go with an empty --pr, and refuses one whose tip the branch lacks', async () => {
    const w = world()
    const g = onGitHub()
    bump(g)
    bump(g, 'dep/other', 'Other dependency')
    g.set({ prs: [open(5), open(7, 'dep/other')] })
    const { t } = await started(w, g.dir, 'take-ready')
    writeFileSync(join(worktreeOf(t), 'work.txt'), 'work')
    sh('git add -A && git commit -qm work', worktreeOf(t))
    // this task's branch is on main, not on the pull request's branch: taking it would overwrite theirs
    expect(await refusal(() => w.engine.done(t.id, 'No.', undefined, '5'))).toContain('does not hold pull request #5')
    // release with no take is a no-op; an unknown number is refused before the task is marked ready
    await w.engine.done(t.id, 'Released.', undefined, '')
    expect(t.pr).toBeUndefined()
    expect(await refusal(() => w.engine.done(t.id, 'No.', undefined, '8'))).toContain('Could not find pull request #8')
    // a task whose worktree started on the branch keeps the pull request through ready
    const { t: t2 } = await taking(w, g, 'take-ready-on-branch', 7)
    writeFileSync(join(worktreeOf(t2), 'two.txt'), 'two')
    sh('git add -A && git commit -qm two', worktreeOf(t2))
    await w.engine.done(t2.id, 'Took the other one.', undefined, '7')
    expect(t2.pr).toMatchObject({ number: 7, taken: true, branch: 'dep/other' })
    await w.engine.done(t2.id, 'Let go.', undefined, '')
    expect(t2.pr).toBeUndefined()
  })

  test('a task start takes --pr before making its worktree; a detached gate still allows a taken pull request', async () => {
    const w = world()
    const g = onGitHub()
    bump(g)
    g.set({ prs: [open(5)] })
    const p = await w.places.add(g.dir, 'take-start')
    const waiting = w.engine.add({ project: p.name, title: 'Wait then take', desc: 'x', by: 'test', later: true })
    await w.engine.takePr(waiting.id, '5')
    expect(waiting.pr).toMatchObject({ number: 5, taken: true, branch: 'dep/bump' })
    await w.engine.takePr(waiting.id, '')
    expect(waiting.pr).toBeUndefined()
    await w.engine.takePr(waiting.id, '#5')
    expect(waiting.pr).toMatchObject({ number: 5, taken: true })
    await w.engine.takePr(waiting.id, '')
    expect(waiting.pr).toBeUndefined()
    const { t } = await taking(w, g, 'take-detached')
    writeFileSync(join(worktreeOf(t), 'work.txt'), 'work')
    sh('git add -A && git commit -qm work', worktreeOf(t))
    sh('git checkout -q --detach', worktreeOf(t))
    expect((await w.engine.openPr(t.id)).ok).toBe(true)
    expect(g.gh().prs).toHaveLength(1)
  })
})
