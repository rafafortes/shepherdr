// On GitHub (a stand-in, test/fake-gh.ts): the checks on a pull request's way in — green, red, not started yet, or
// unreadable — the news they bring, and a merge that waits for its answer or stays stuck.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sh, repo, world, until, started, Settings, G } from './engine-world.ts'
import type { FakeGitHub } from './fake-gh.ts'
import { tmp } from './tmp.ts'

// each test runs git dozens of times and gh (a bun process of its own) up to fifty: a few seconds alone, past 20 on a
// machine as busy as a CI runner can get
setDefaultTimeout(60_000)

/** a task's worktree, or a test failure (new tests keep to the lint ratchet's no-non-null rule) */
const wt = (t: { id: string; worktree?: string }) => {
  if (!t.worktree) throw new Error(`${t.id} has no worktree`)
  return t.worktree
}

/** a GitHub stand-in: a bare repo is GitHub, gh is test/fake-gh.ts; the clone's origin reads as GitHub's */
const ghBin = tmp('ghbin')
writeFileSync(join(ghBin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, 'fake-gh.ts')}" "$@"\n`, { mode: 0o755 })

function onGitHub(o: { authed?: boolean; down?: boolean; checks?: FakeGitHub['checks']; requiredChecks?: string[]; remote?: string } = {}) {
  process.env.PATH = `${ghBin}:${process.env.PATH}`
  const bare = tmp('gh-origin')
  sh('git init -q --bare -b main', bare)
  sh(`git push -q ${bare} main`, repo())
  const dir = tmp('gh-clone')
  const remote = o.remote ?? 'https://github.com/acme/app.git'
  sh(`git clone -q ${bare} . && git config user.email t@t && git config user.name T && git remote set-url origin ${remote} && git config url.${bare}.insteadOf ${remote}`, dir)
  const file = join(tmp('gh-state'), 'github.json')
  writeFileSync(file, JSON.stringify({ origin: bare, repo: 'acme/app', prs: [], calls: [], authed: o.authed, down: o.down, checks: o.checks, requiredChecks: o.requiredChecks }))
  process.env.FAKE_GH_STATE = file
  const gh = () => JSON.parse(readFileSync(file, 'utf8')) as FakeGitHub
  const set = (patch: Partial<FakeGitHub>) => writeFileSync(file, JSON.stringify({ ...gh(), ...patch }))
  return { bare, dir, gh, set }
}

/** Settings → How tasks work → Merge after GitHub checks, for one test (it is kept on disk: back to its default after) */
const waitForChecks = (w: ReturnType<typeof world>) => w.settings.set('brief.merge', 'after GitHub checks')
afterEach(() => void new Settings().set('brief.merge', null))

describe('on GitHub: a pull request per task', () => {
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
      checks: [
        { name: 'test', bucket: 'fail', link: 'https://github.com/acme/app/actions/runs/7/job/9' },
        { name: 'lint', bucket: 'pass' },
      ],
      // as GitHub logs a whole job: what failed, then the clean-up steps after it
      logs: {
        '9': ['ok 1', 'expected 1 to be 2', '##[error]Process completed with exit code 1.', 'Post job cleanup.', 'Cleaning up orphan processes']
          .map((l) => `2026-10-26T10:00:00.1234567Z ${l}`)
          .join('\n'),
      },
      api: {
        [`${pulls}/reviews`]: [
          { id: 1, user: { login: 'ann' }, body: 'Please rename it.', state: 'CHANGES_REQUESTED', html_url: 'https://github.com/acme/app/pull/1#r1', submitted_at: '2099-01-01T00:00:00Z' },
          { id: 2, user: { login: 'bob' }, body: '', state: 'COMMENTED', html_url: 'https://github.com/acme/app/pull/1#r2', submitted_at: '2099-01-01T00:00:01Z' },
        ],
        // drafted long before its review was sent: news all the same
        [`${pulls}/comments`]: [
          {
            id: 3,
            pull_request_review_id: 2,
            user: { login: 'bob' },
            body: 'Typo here.',
            path: 'x.txt',
            line: 1,
            html_url: 'https://github.com/acme/app/pull/1#c3',
            created_at: '2000-01-01T00:00:00Z',
          },
        ],
        ['repos/acme/app/issues/1/comments']: [{ id: 4, user: { login: 'cy' }, body: 'Old news.', html_url: 'https://github.com/acme/app/pull/1#i4', created_at: '2000-01-01T00:00:00Z' }],
      },
    })
    await w.engine.watchPrs()
    expect(w.sent.length).toBe(1)
    const told = w.sent[0]
    expect(told.key).toBe(key)
    expect(told.text).toMatch(/^<shepherdr><github task="[^"]+" pr="1">GitHub news on PR #1 \(https:\/\/github.com\/acme\/app\/pull\/1\)/)
    expect(told.text).toContain(
      '- Check failed: test (https://github.com/acme/app/actions/runs/7/job/9). Its log ends:\n    ok 1\n    expected 1 to be 2\n    ##[error]Process completed with exit code 1.\n- ',
    )
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
    g.set({
      api: {
        ...notes,
        ['repos/acme/app/issues/1/comments']: [{ id: 5, user: { login: 'cy' }, body: 'Ship it?', html_url: 'https://github.com/acme/app/pull/1#i5', created_at: '2099-01-02T00:00:00Z' }],
      },
    })
    w.agentIs(key, 'working')
    await w.engine.watchPrs()
    expect(w.sent.length).toBe(1)
    w.agentIs(key, 'idle')
    await w.engine.watchPrs()
    expect(w.sent.length).toBe(2)
    expect(w.sent[1].text).toContain('- Comment by cy (https://github.com/acme/app/pull/1#i5):\n    Ship it?')
    expect(w.sent[1].text).not.toContain('Check failed')
  })

  test('a workflow that runs on every pull request is never none: it waits, says why, and merges when checks really pass', async () => {
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
    expect(m.error).toContain('not merging')
    expect(g.gh().prs[0].state).toBe('OPEN')
    // long past the 90 s window, still none: an unfiltered workflow is not "none set up", so no merge on the unknown
    t.pushed!.at = 0
    const later = await w.engine.merge(t.id, { self: true })
    expect(later.ok).toBe(false)
    expect(later.error).toContain('not merging')
    expect(t.landing?.step).toBe('checks')
    expect(t.landing?.why).toBe('Checks not started yet')
    expect(w.engine.subOf(t)).toContain('Checks not started yet')
    // the checks come: only now does it merge
    g.set({ checks: [{ name: 'ci', bucket: 'pass' }] })
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
  })

  test('a paths-filtered workflow that did not start is not decided on the first read, then merges like none', async () => {
    const w = world()
    const g = onGitHub()
    waitForChecks(w)
    const { t } = await started(w, g.dir, 'ghpaths')
    mkdirSync(join(t.worktree!, '.github', 'workflows'), { recursive: true })
    // this change is a doc, not backend/**: GitHub reports no checks for it
    writeFileSync(join(t.worktree!, '.github', 'workflows', 'ci.yml'), 'on:\n  pull_request:\n    paths:\n      - backend/**\n')
    sh('git add -A && git commit -qm ci', t.worktree!)
    const first = await w.engine.merge(t.id, { self: true })
    expect(first.ok).toBe(false)
    expect(first.error).toContain('paths or branches filters')
    expect(g.gh().prs[0].state).toBe('OPEN')
    // the same 90 s window passes with still none: the filter does not apply to this change, so it merges as none
    t.pushed!.at = 0
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
  })

  test('checks sends one interim line per poll while it waits, before its answer (UXD-08)', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'ci', bucket: 'pending' }] })
    const { t } = await started(w, g.dir, 'ghsteps')
    if (!t.worktree) throw new Error('ghsteps got no worktree')
    writeFileSync(join(t.worktree, 'x.txt'), 'x\n')
    sh('git add -A && git commit -qm x', t.worktree)
    await w.engine.openPr(t.id)
    const steps: string[] = []
    // 11 s of waiting crosses CHECKS_EVERY (10 s); the exact count depends on a busy machine, but every poll says
    // a line and there is at least one before the answer (the first is immediate, the second after 10 s)
    const c = await w.engine.checks(t.id, 11_000, (s) => steps.push(s))
    expect(c.ok).toBe(false)
    expect(c.text).toContain('still run')
    expect(steps.length).toBeGreaterThanOrEqual(1)
    expect(steps.every((s) => s === 'checks: 0 passed, still running')).toBe(true)
  }, 40_000)

  test("shepherdr checks says it is waiting, not merged, when a workflow's checks have not been reported yet", async () => {
    const w = world()
    const g = onGitHub()
    waitForChecks(w)
    const { t } = await started(w, g.dir, 'ghwaityet')
    mkdirSync(join(t.worktree!, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(t.worktree!, '.github', 'workflows', 'ci.yml'), 'on:\n  pull_request:\n')
    sh('git add -A && git commit -qm ci', t.worktree!)
    await w.engine.openPr(t.id)
    t.reported = true
    t.landing = { step: 'checks', at: Date.now() }
    const c = await w.engine.checks(t.id, 0)
    expect(c.ok).toBe(false)
    expect(c.text).toContain('not merging')
    expect(t.landing?.why).toBe('Checks not started yet')
    expect(w.engine.subOf(t)).toContain('Checks not started yet')
  })

  test('checks that started read green or red, and green merges while red does not', async () => {
    const w = world()
    const g = onGitHub({ checks: [{ name: 'ci', bucket: 'pass' }] })
    waitForChecks(w)
    const { t } = await started(w, g.dir, 'ghgreen')
    mkdirSync(join(t.worktree!, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(t.worktree!, '.github', 'workflows', 'ci.yml'), 'on:\n  pull_request:\n')
    sh('git add -A && git commit -qm ci', t.worktree!)
    await w.engine.openPr(t.id)
    const green = await w.engine.checks(t.id, 0)
    expect(green.ok).toBe(true)
    expect(green.text).toContain('passed')
    g.set({ checks: [{ name: 'ci', bucket: 'fail', link: 'https://github.com/acme/app/actions/runs/7' }] })
    const red = await w.engine.checks(t.id, 0)
    expect(red.ok).toBe(false)
    expect(red.text).toContain('failed')
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(false)
    g.set({ checks: [{ name: 'ci', bucket: 'pass' }] })
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

  test('on its own it waits only for required checks, but never merges on one of them already failed', async () => {
    const w = world()
    const g = onGitHub({
      checks: [
        { name: 'build', bucket: 'pass' },
        { name: 'test', bucket: 'pending' },
      ],
      requiredChecks: ['build'],
    })
    const { t } = await started(w, g.dir, 'ghnowait')
    writeFileSync(join(t.worktree!, 'x.txt'), 'x\n')
    sh('git add -A && git commit -qm x', t.worktree!)
    expect((await w.engine.openPr(t.id)).text).toContain('Merging waits only for checks your base branch requires')
    // the required one is red: the merge waits, even though the optional one is green
    g.set({
      checks: [
        { name: 'build', bucket: 'fail', link: 'https://github.com/acme/app/actions/runs/7' },
        { name: 'test', bucket: 'pass' },
      ],
    })
    const f = await w.engine.merge(t.id, { self: true })
    expect(f.ok).toBe(false)
    expect(f.error).toContain("GitHub's checks failed on PR #1: build.")
    expect(g.gh().prs[0].state).toBe('OPEN')
    // fixed: a new commit, its required check green and an optional one still running
    writeFileSync(join(t.worktree!, 'x.txt'), 'fixed\n')
    sh('git commit -qam fix', t.worktree!)
    g.set({
      checks: [
        { name: 'build', bucket: 'pass' },
        { name: 'test', bucket: 'pending' },
      ],
    })
    expect(await w.engine.merge(t.id, { self: true })).toEqual({ ok: true, note: 'merged PR #1 on GitHub, waiting only for required checks' })
    expect(g.gh().prs[0].state).toBe('MERGED')
    // the brief's Merge line says so too
    expect(t.desc).toContain('Wait only for checks your base branch requires')
  })

  test('required checks are read from status contexts as well as check runs', async () => {
    const g = onGitHub({ checks: [{ name: 'build', bucket: 'pass' }], requiredChecks: ['build'], requiredAsContexts: true })
    const hub = { repo: 'acme/app', host: 'github.com' }
    expect(await G.requiredChecks(hub, g.dir, 1)).toEqual(['build'])
    g.set({ requiredChecks: [], requiredAsContexts: false })
    expect(await G.requiredChecks(hub, g.dir, 1)).toBeUndefined()
  })

  test('a red or running optional check does not hold an automatic merge, but the same check required does', async () => {
    const w = world()
    const g = onGitHub({
      checks: [
        { name: 'build', bucket: 'pass' },
        { name: 'lint', bucket: 'fail', link: 'https://github.com/acme/app/actions/runs/7' },
      ],
      requiredChecks: ['build'],
    })
    const { t } = await started(w, g.dir, 'ghoptional')
    writeFileSync(join(wt(t), 'x.txt'), 'x\n')
    sh('git add -A && git commit -qm x', wt(t))
    expect(await w.engine.merge(t.id, { self: true })).toEqual({ ok: true, note: 'merged PR #1 on GitHub, waiting only for required checks' })
    expect(g.gh().prs[0].state).toBe('MERGED')
    const asked = g.gh().calls.find((c) => c.args.includes('graphql'))?.args ?? []
    expect(asked.some((a) => a.includes('isRequired'))).toBe(true)
    expect(asked).toContain('owner=acme')
    expect(asked).toContain('name=app')

    // the same red check is required on another pull request: it holds the merge
    const w2 = world()
    const g2 = onGitHub({
      checks: [
        { name: 'build', bucket: 'pass' },
        { name: 'lint', bucket: 'fail', link: 'https://github.com/acme/app/actions/runs/7' },
      ],
      requiredChecks: ['lint'],
    })
    const { t: t2 } = await started(w2, g2.dir, 'ghrequired')
    writeFileSync(join(wt(t2), 'x.txt'), 'x\n')
    sh('git add -A && git commit -qm x', wt(t2))
    const held = await w2.engine.merge(t2.id, { self: true })
    expect(held.ok).toBe(false)
    expect(held.error).toContain("GitHub's checks failed on PR #1: lint.")
    expect(g2.gh().prs[0].state).toBe('OPEN')
  })

  test('a required check still running holds an automatic merge; when it passes the agent hears it, even with a red optional one', async () => {
    const w = world()
    const g = onGitHub({
      checks: [
        { name: 'build', bucket: 'pending' },
        { name: 'lint', bucket: 'fail' },
      ],
      requiredChecks: ['build'],
    })
    const { t, key } = await started(w, g.dir, 'ghwaitrequired')
    writeFileSync(join(wt(t), 'x.txt'), 'x\n')
    sh('git add -A && git commit -qm x', wt(t))
    const held = await w.engine.merge(t.id, { self: true })
    expect(held.ok).toBe(false)
    expect(held.error).toContain('checks are running on PR #1')
    expect(t.landing?.step).toBe('checks')
    expect(g.gh().prs[0].state).toBe('OPEN')
    // the required one is green; the optional one is still red: no failure is sent, and the nudge goes out
    g.set({
      checks: [
        { name: 'build', bucket: 'pass' },
        { name: 'lint', bucket: 'fail' },
      ],
    })
    t.reported = true
    w.agentIs(key, 'idle')
    await w.engine.watchPrs()
    const told = w.sent.at(-1)?.text ?? ''
    expect(told).toContain('checks passed on PR #1: merge')
    expect(told).not.toContain('Check failed')
  })

  test('a red check holds an automatic merge when GitHub cannot say which are required, but an all-green one asks nothing', async () => {
    const w = world()
    const g = onGitHub({
      checks: [
        { name: 'build', bucket: 'pass' },
        { name: 'lint', bucket: 'fail' },
      ],
    })
    const { t } = await started(w, g.dir, 'ghunsaid')
    writeFileSync(join(wt(t), 'x.txt'), 'x\n')
    sh('git add -A && git commit -qm x', wt(t))
    // no protection at all: no check is marked required
    expect((await w.engine.merge(t.id, { self: true })).error).toContain('lint')
    // a permission error, an unreadable answer, and required names that name no reported check: all count
    for (const patch of [{ requiredChecksError: true }, { requiredChecksGarbage: true, requiredChecksError: false }, { requiredChecks: ['other'], requiredChecksGarbage: false }]) {
      g.set(patch)
      expect((await w.engine.merge(t.id, { self: true })).error).toContain('lint')
    }
    // every reported check required, so there is nothing to drop: still strict
    g.set({ requiredChecks: ['build', 'lint'] })
    expect((await w.engine.merge(t.id, { self: true })).error).toContain('lint')
    // with every check green no question is asked of GitHub at all
    g.set({
      checks: [
        { name: 'build', bucket: 'pass' },
        { name: 'lint', bucket: 'pass' },
      ],
      requiredChecks: ['build'],
    })
    const askedBefore = g.gh().calls.filter((c) => c.args.includes('graphql')).length
    expect(await w.engine.merge(t.id, { self: true })).toEqual({ ok: true, note: 'merged PR #1 on GitHub, not waiting for its checks' })
    expect(g.gh().calls.filter((c) => c.args.includes('graphql')).length).toBe(askedBefore)
  })

  test('shepherdr checks and after GitHub checks stay strict: a red optional check still holds them', async () => {
    const w = world()
    const g = onGitHub({
      checks: [
        { name: 'build', bucket: 'pass' },
        { name: 'lint', bucket: 'fail' },
      ],
      requiredChecks: ['build'],
    })
    waitForChecks(w)
    const { t } = await started(w, g.dir, 'ghstrict')
    writeFileSync(join(wt(t), 'x.txt'), 'x\n')
    sh('git add -A && git commit -qm x', wt(t))
    await w.engine.openPr(t.id)
    expect((await w.engine.checks(t.id, 0)).ok).toBe(false)
    expect((await w.engine.checks(t.id, 0)).text).toContain('lint')
    expect((await w.engine.merge(t.id, { self: true })).error).toContain('lint')
    expect(g.gh().calls.some((c) => c.args.includes('graphql'))).toBe(false)
  })

  test('main going red on GitHub after merges tells its coordinator once, with the run and what merged since green', async () => {
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
    g.set({
      runs: [run(red, 'cancelled', 4), run(red, 'failure', 3), run(green, 'success', 2)],
      api: { 'repos/acme/app/actions/runs/3/jobs': [9] },
      logs: { '9': 'expected 1 to be 2\n##[error]Process completed with exit code 1.' },
    })
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

  test('GitHub stuck on the merge: shepherdr merge still answers by its deadline, and asked again waits for that same merge', async () => {
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
    // shepherdr checks says the same, in words, instead of throwing: GitHub unreachable is no answer about the checks
    const c = await w.engine.checks(t.id)
    expect(c.ok).toBe(false)
    expect(c.text).toContain("gh can't reach GitHub")
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
    expect(g.gh().prs[0].body).toContain('## Summary\n\nAdded a and b.')
    expect(sh(`git rev-parse refs/heads/${t.branch}`, g.bare)).toBe(sh('git rev-parse HEAD', t.worktree!))
    g.set({ mergeError: 'Pull request #1 is not mergeable: the merge commit cannot be cleanly created.' })
    const m = await w.engine.merge(t.id, { self: true })
    expect(m.ok).toBe(false)
    expect(m.error).toContain('Conflict with main on GitHub')
    expect(t.merged).toBeFalsy()
    expect(g.gh().prs[0].state).toBe('OPEN')
  })

  test('a merge GitHub refuses for another reason than a conflict says so, and nothing merges', async () => {
    const w = world()
    const g = onGitHub()
    const { t } = await started(w, g.dir, 'ghrefuse')
    if (!t.worktree) throw new Error('a task has no worktree')
    writeFileSync(join(t.worktree, 'q.txt'), 'q\n')
    sh('git add -A && git commit -qm q', t.worktree)
    await w.engine.openPr(t.id)
    t.reported = true
    t.said = 'Added q.'
    const before = sh('git rev-parse main', g.dir)
    // a refusal that names no conflict: what GitHub said is told as it is, and main here and there stay as they were
    g.set({ mergeError: 'Pull request #1 could not be merged: the base branch policy prohibits the merge.' })
    const m = await w.engine.merge(t.id, { self: true })
    expect(m.ok).toBe(false)
    expect(m.error).toContain('GitHub did not merge PR #1: Pull request #1 could not be merged: the base branch policy prohibits the merge.')
    expect(t.merged).toBeFalsy()
    expect(sh('git rev-parse main', g.dir)).toBe(before)
    expect(sh('git rev-parse main', g.bare)).toBe(before)
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

  test("main here ahead of GitHub's is refused before anything merges; work main has already closes its pull request", async () => {
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
