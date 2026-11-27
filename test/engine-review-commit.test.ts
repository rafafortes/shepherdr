// biome-ignore-all lint/style/noNonNullAssertion: the test world's task and worktree are known to exist once started
// A review belongs to the commit it reviewed (the 3.1.45/3.1.46 idea, ported to 2.0): `--done` records the commit,
// the round and the reviewer; ready and merge refuse a final commit no round was recorded on, name the last reviewed
// commit and what came after, and spend no round on a clean base merge or an identical tree. A later round's prompt and
// answer name both the incremental range and the whole change.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keyOf } from '../server/live/models-summary.ts'
import { reviewerPromptPath } from '../server/live/reviewer-prompt.ts'
import { repo, sh, started, world } from './engine-world.ts'

setDefaultTimeout(60_000)

type Task = Awaited<ReturnType<typeof started>>['t']
type World = ReturnType<typeof world>

/** a started task with one commit of its own, as the human would have it reviewed */
async function withCommit(w: World, name: string) {
  const dir = repo()
  const { t } = await started(w, dir, name)
  writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
  sh('git add -A && git commit -qm "add hello"', t.worktree!)
  return { t, dir }
}

/** count and finish one round on the worktree's HEAD, as `shepherdr review` then `--done` do */
async function round(w: World, t: Task) {
  const counted = await w.engine.reviewRound(t.id)
  if ('wait' in counted) throw new Error('no reviewer free for the round')
  expect(w.engine.reviewDone(t.id)).toBe(true)
  return t.reviewed!.at(-1)!
}

const head = (t: Task) => sh('git rev-parse HEAD', t.worktree!)

/**
 * The documents of a conflict over counts (POL-673's README): a total, a table, a paragraph wrapped over lines and, apart
 * from them, a line of its own. The task adds a group (its row, its share of the total, a sentence) and raises the line's
 * count; meanwhile the base adds a group of its own and recounts the same lines, so the rebase conflicts on all of them,
 * and a resolution keeps both sides with the numbers recomputed.
 */
const cases = (total: string, rows: string[], run: string[], stop: string) =>
  ['# Cases', '', total, '', '| group | cases |', '| --- | --- |', ...rows, '', ...run, '', '## Stop', '', stop, ''].join('\n')
const ADV = '| adversarial | 400 |'
const SIL = '| silence | 96 |'
const MEM = '| memory | 60 |'
const L1 = '| l1_correction | 300 |'
const STOP = (n: number | string) => `stop when a < b after ${n} seconds`
const ORIGINAL = cases('496 cases in six groups.', [ADV, SIL], ['A default run sends 58 of the 496 cases', '(29 adversarial, 16 lesson flow) and the slices are walked with --offset.'], STOP(10))
const MINE = cases(
  '796 cases in seven groups: 496 authored and 300 generated.',
  [ADV, SIL, L1],
  ['A default run sends 58 of the 496 authored', 'cases (29 adversarial, 16 lesson flow), and the l1_correction', 'group needs its own --only; the slices are walked with --offset.'],
  STOP(30),
)
const THEIRS = cases(
  '556 cases in seven groups.',
  [ADV, SIL, MEM],
  ['A default run sends 57 of the 556 cases', '(26 adversarial, 13 lesson flow, 7 memory) and the slices are walked with --offset.'],
  STOP(10),
)
/** both sides kept, the totals recomputed ("eight groups", 856) and the paragraph wrapped again */
const MERGED = cases(
  '856 cases in eight groups: 556 authored and 300 generated.',
  [ADV, SIL, MEM, L1],
  ['A default run sends 57 of the 556 authored', 'cases (26 adversarial, 13 lesson flow, 7 memory), and the l1_correction', 'group needs its own --only; the slices are walked with --offset.'],
  STOP(30),
)

/** a task with its one round spent on `mine`, the base moved to `theirs`, and the rebase's conflicts resolved as `resolved` */
async function conflict(w: World, name: string, original: string, mine: string, theirs: string, resolved: string) {
  const dir = repo()
  writeFileSync(join(dir, 'cases.md'), original)
  sh('git add -A && git commit -qm "add cases"', dir)
  const { t } = await started(w, dir, name)
  writeFileSync(join(t.worktree!, 'cases.md'), mine)
  sh('git add -A && git commit -qm "change cases"', t.worktree!)
  t.rounds = 1
  await round(w, t)
  expect(w.engine.reviewsLeft(t)).toBe(0)
  writeFileSync(join(dir, 'cases.md'), theirs)
  sh('git add -A && git commit -qm "base changes cases"', dir)
  expect(sh('git rebase main || true', t.worktree!)).toContain('CONFLICT')
  writeFileSync(join(t.worktree!, 'cases.md'), resolved)
  sh('git add -A && GIT_EDITOR=true git rebase --continue', t.worktree!)
  return t
}

const recounted = (w: World, name: string, resolved: string) => conflict(w, name, ORIGINAL, MINE, THEIRS, resolved)

describe('a review is tied to the commit it reviewed', () => {
  test('ready refuses an unreviewed final commit and names the last reviewed commit and what came after', async () => {
    const w = world()
    const { t } = await withCommit(w, 'unreviewed')
    // a counted round with no --done leaves the final commit unreviewed: refusal, and nothing reported
    await w.engine.reviewRound(t.id)
    await expect(w.engine.done(t.id, 'done', 'facts')).rejects.toThrow('No round has been recorded')
    expect(t.reported).toBeUndefined()
    w.engine.reviewDone(t.id)

    const first = t.reviewed![0]
    expect(t.reviewed).toHaveLength(1)
    expect(t.reviewed![0]).toMatchObject({ round: first.round, commit: head(t), reviewer: first.reviewer })
    expect(t.reviews).toBe(1)

    // a fix after the round is a new final commit: the refusal says which round was last and what came after it
    writeFileSync(join(t.worktree!, 'fix.txt'), 'fix\n')
    sh('git add -A && git commit -qm "fix the finding"', t.worktree!)
    const failed = await w.engine.done(t.id, 'done', 'facts').catch((e: Error) => e.message)
    expect(failed).toContain(`last round on ${t.reviewed![0].commit.slice(0, 7)}`)
    expect(failed).toContain('fix the finding')
    expect(failed).toContain(`git diff ${t.reviewed![0].commit.slice(0, 7)}..HEAD`)
    expect(failed).toContain('shepherdr review')
    expect(failed).toContain('rounds left')
    expect(t.reported).toBeUndefined()

    await round(w, t)
    expect(await w.engine.done(t.id, 'done', 'facts')).toMatchObject({ state: 'ready' })
    expect(t.reported).toBe(true)
  })

  test('ready refuses a worktree switched to another branch, and takes it once back on the task branch', async () => {
    const w = world()
    const { t } = await withCommit(w, 'foreign-ready')
    const branch = t.branch!
    sh('git switch -q -c other', t.worktree!)
    writeFileSync(join(t.worktree!, 'other.txt'), 'other\n')
    sh('git add -A && git commit -qm other', t.worktree!)
    const failed = await w.engine.done(t.id, 'done', 'facts').catch((e: Error) => e.message)
    expect(failed).toContain('HEAD is on other')
    expect(failed).toContain(branch)
    expect(failed).toContain('git switch')
    expect(t.reported).toBeUndefined()
    sh(`git switch -q ${branch}`, t.worktree!)
    await round(w, t)
    expect(await w.engine.done(t.id, 'done', 'facts')).toMatchObject({ state: 'ready' })
  })

  test("--done still records the commit when the round's lease is gone (a restart, REVIEW_TIMEOUT)", async () => {
    const w = world()
    const { t } = await withCommit(w, 'late-done')
    await w.engine.reviewRound(t.id)
    // the lease is in memory: a restart loses it, and the round's whole allowance is never lost with it
    w.engine.stop()
    const again = world()
    const back = again.engine.task(t.id)!
    expect(again.engine.reviewDone(back.id)).toBe(false) // nothing is leased to release
    expect(back.reviewed).toMatchObject([{ round: 1, commit: head(back) }])
    // the same round recorded once, never twice
    again.engine.reviewDone(back.id)
    expect(back.reviewed).toHaveLength(1)
    expect(await again.engine.reviewGate(back)).toBeUndefined()
  })

  test('--commit names the commit the round reviewed when fixes were committed since', async () => {
    const w = world()
    const { t } = await withCommit(w, 'named-commit')
    await round(w, t)
    const reviewed = head(t)
    writeFileSync(join(t.worktree!, 'fix.txt'), 'fix\n')
    sh('git add -A && git commit -qm fix', t.worktree!)
    await w.engine.reviewRound(t.id)
    expect(() => w.engine.reviewDone(t.id, 'deadbeef')).toThrow('not a commit on')
    expect(w.engine.reviewDone(t.id, reviewed)).toBe(true)
    expect(t.reviewed!.at(-1)).toMatchObject({ round: 2, commit: reviewed })
    // the round reviewed the earlier commit: the fix after it still needs one of its own
    expect(await w.engine.reviewGate(t)).toBeDefined()
  })

  test('a merge refuses an unreviewed final commit too, and takes a reviewed one', async () => {
    const w = world()
    const { t, dir } = await withCommit(w, 'merge-gate')
    await round(w, t)
    writeFileSync(join(t.worktree!, 'fix.txt'), 'fix\n')
    sh('git add -A && git commit -qm "fix after review"', t.worktree!)
    const refused = await w.engine.merge(t.id, { self: true })
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('is not reviewed')
    expect(sh('git log -1 --format=%s', dir)).toBe('init')

    await round(w, t)
    const merged = await w.engine.merge(t.id, { self: true })
    expect(merged).toMatchObject({ ok: true })
  })

  test('a clean merge of the base onto a reviewed commit needs no new round', async () => {
    const w = world()
    const { t, dir } = await withCommit(w, 'base-merge')
    await round(w, t)
    const reviewed = t.reviewed![0].commit
    const used = t.reviews

    writeFileSync(join(dir, 'other.txt'), 'other\n')
    sh('git add -A && git commit -qm other', dir)
    sh('git merge --no-ff -m "merge main" main', t.worktree!)
    expect(head(t)).not.toBe(reviewed)
    expect(await w.engine.reviewGate(t)).toBeUndefined()
    expect(await w.engine.done(t.id, 'done', 'facts')).toMatchObject({ state: 'ready' })
    expect(t.reviews).toBe(used) // no round was spent on the base's own commits
  })

  test('a merge with a conflict resolution is a change of its own and still needs a round', async () => {
    const w = world()
    const { t, dir } = await withCommit(w, 'conflict')
    writeFileSync(join(t.worktree!, 'README.md'), 'mine\n')
    sh('git add -A && git commit -qm "edit readme"', t.worktree!)
    await round(w, t)
    writeFileSync(join(dir, 'README.md'), 'theirs\n')
    sh('git add -A && git commit -qm "base readme"', dir)
    // leave the merge unresolved first: that is neither a reviewed tree nor a clean merge
    expect(() => sh('git merge main', t.worktree!)).toThrow()
    expect(sh('git status --porcelain', t.worktree!)).toContain('UU README.md')
    writeFileSync(join(t.worktree!, 'README.md'), 'both\n')
    sh('git add -A && git commit -qm "resolve merge"', t.worktree!)
    expect(await w.engine.reviewGate(t)).toBeDefined()
  })

  test('an identical tree after a new commit needs no round', async () => {
    const w = world()
    const { t } = await withCommit(w, 'same-tree')
    await round(w, t)
    const reviewed = t.reviewed![0].commit
    // a commit and its revert leave the very same tree the reviewer saw
    writeFileSync(join(t.worktree!, 'temp.txt'), 'temp\n')
    sh('git add -A && git commit -qm temp', t.worktree!)
    sh('git revert --no-edit HEAD', t.worktree!)
    expect(head(t)).not.toBe(reviewed)
    expect(await w.engine.reviewGate(t)).toBeUndefined()
  })

  test('a clean rebase onto a moved base keeps its review, and a resolution that moved its own lines needs one', async () => {
    const w = world()
    const { t, dir } = await withCommit(w, 'rebase')
    await round(w, t)
    writeFileSync(join(dir, 'other.txt'), 'other\n')
    sh('git add -A && git commit -qm other', dir)
    sh('git rebase main', t.worktree!)
    // its own change is the one the round read, however git replayed it: no round is spent on Shepherdr's or the agent's rebase
    expect(await w.engine.reviewGate(t)).toBeUndefined()

    // a rebase whose conflict resolution moved the task's own lines is work the review did not see
    const w2 = world()
    const { t: t2, dir: dir2 } = await withCommit(w2, 'rebase-resolution')
    writeFileSync(join(t2.worktree!, 'README.md'), 'mine\n')
    sh('git add -A && git commit -qm "edit readme"', t2.worktree!)
    await round(w2, t2)
    writeFileSync(join(dir2, 'README.md'), 'theirs\n')
    sh('git add -A && git commit -qm "base readme"', dir2)
    sh('git rebase main || true', t2.worktree!)
    writeFileSync(join(t2.worktree!, 'README.md'), 'both\n')
    sh('git add -A && GIT_EDITOR=true git rebase --continue', t2.worktree!)
    expect(await w2.engine.reviewGate(t2)).toBeDefined()
    // the round that fixes it says the reviewed commit is no longer on the branch, never that it is the first round
    const again = await w2.engine.reviewRound(t2.id)
    if ('wait' in again) throw new Error('no reviewer free')
    expect(w2.engine.reviewWords(t2.id, again)).toContain('the commit the last round reviewed is no longer on this branch')
    expect(readFileSync(reviewerPromptPath(t2.id, again.round), 'utf8')).toContain('is no longer on this branch (it was rebased)')
    expect(w2.engine.reviewWords(t2.id, again)).not.toContain('First round')
  })

  test('--done records the commit the round was counted on, not a fix committed before it', async () => {
    const w = world()
    const { t } = await withCommit(w, 'count-time-head')
    await w.engine.reviewRound(t.id)
    const reviewed = head(t)
    writeFileSync(join(t.worktree!, 'fix.txt'), 'fix\n')
    sh('git add -A && git commit -qm "fix after the review started"', t.worktree!)
    expect(w.engine.reviewDone(t.id)).toBe(true)
    expect(t.reviewed).toMatchObject([{ round: 1, commit: reviewed }])
    // the fix committed before --done never reached that reviewer
    expect(await w.engine.reviewGate(t)).toBeDefined()
  })

  test('--commit is resolved to its full sha, and only a commit on this branch is taken', async () => {
    const w = world()
    const { t } = await withCommit(w, 'named-commit')
    const first = head(t)
    writeFileSync(join(t.worktree!, 'fix.txt'), 'fix\n')
    sh('git add -A && git commit -qm fix', t.worktree!)
    // a revision, not just a sha: HEAD~1 and a short sha name this branch's earlier commit, stored as its full sha
    for (const ref of ['HEAD~1', first.slice(0, 7)]) {
      await w.engine.reviewRound(t.id)
      expect(w.engine.reviewDone(t.id, ref)).toBe(true)
      expect(t.reviewed!.at(-1)).toMatchObject({ commit: first })
    }
    // anything that is no commit of this branch is refused, before it can be stored as a review of something else
    for (const ref of ['--force', 'deadbeef', 'HEAD~9']) expect(() => w.engine.reviewDone(t.id, ref)).toThrow('not a commit on')
    expect(t.reviewed).toHaveLength(2)
    // and a fix committed after the round was counted is not what that round read: HEAD does not pass as its commit
    await w.engine.reviewRound(t.id)
    writeFileSync(join(t.worktree!, 'late.txt'), 'late\n')
    sh('git add -A && git commit -qm late', t.worktree!)
    expect(() => w.engine.reviewDone(t.id, 'HEAD')).toThrow('is not the commit')
    expect(t.reviewed).toHaveLength(2)
  })

  test('a tree identical to any reviewed one, not only the last, needs no round', async () => {
    const w = world()
    const { t } = await withCommit(w, 'older-tree')
    const first = await round(w, t)
    writeFileSync(join(t.worktree!, 'fix.txt'), 'fix\n')
    sh('git add -A && git commit -qm fix', t.worktree!)
    const second = await round(w, t)
    expect(second.commit).not.toBe(first.commit)
    // B's change undone: HEAD's tree is A's, which a round reviewed
    sh('git rm -q fix.txt && git commit -qm "take the fix out"', t.worktree!)
    expect(await w.engine.reviewGate(t)).toBeUndefined()
  })

  test('a task that never counted a round is left as it was (the rule starts with its first round)', async () => {
    const w = world()
    const { t } = await withCommit(w, 'never-reviewed')
    expect(t.reviews).toBeUndefined()
    expect(await w.engine.done(t.id, 'done', 'facts')).toMatchObject({ state: 'ready' })
  })

  test('a branch whose own work is gone has nothing to review or merge', async () => {
    const w = world()
    const { t } = await withCommit(w, 'net-zero')
    await round(w, t)
    // its own change undone: HEAD's tree is the base's, so no round is asked for work that adds nothing
    sh('git revert --no-edit HEAD', t.worktree!)
    expect(await w.engine.reviewGate(t)).toBeUndefined()
  })

  test('a second round names the change since the last reviewed commit and the whole change', async () => {
    const w = world()
    const { t } = await withCommit(w, 'second-round')
    const first = await round(w, t)
    writeFileSync(join(t.worktree!, 'fix.txt'), 'fix\n')
    sh('git add -A && git commit -qm "fix the finding"', t.worktree!)

    const second = await w.engine.reviewRound(t.id)
    if ('wait' in second) throw new Error('no reviewer free')
    const words = w.engine.reviewWords(t.id, second)
    expect(words).toContain('Round after an earlier one')
    expect(words).toContain(`git diff ${first.commit.slice(0, 7)}..HEAD`)
    expect(words).toContain('whole change')
    const prompt = readFileSync(reviewerPromptPath(t.id, second.round), 'utf8')
    expect(prompt).toContain("This round's focus")
    expect(prompt).toContain(`git diff ${first.commit}..HEAD`)
    expect(prompt).toContain('git log --oneline')
    // the whole diff against the merge base is still there for context
    expect(prompt).toContain('...HEAD')
    expect(prompt).not.toContain('{{')
    expect(w.engine.reviewDone(t.id)).toBe(true)
    expect(t.reviewed).toHaveLength(2)
    expect(t.reviewed![1]).toMatchObject({ round: 2, commit: head(t) })
  })

  test('a restart keeps the record, so the reviewed commit still passes and a new one still fails', async () => {
    const w = world()
    const { t } = await withCommit(w, 'restart')
    await round(w, t)
    const reviewed = t.reviewed![0]
    w.engine.stop()

    const again = world()
    const back = again.engine.task(t.id)!
    expect(back.reviewed).toEqual([reviewed])
    expect(await again.engine.reviewGate(back)).toBeUndefined()
    writeFileSync(join(back.worktree!, 'late.txt'), 'late\n')
    sh('git add -A && git commit -qm late', back.worktree!)
    expect(await again.engine.reviewGate(back)).toBeDefined()
  })

  test('old records with no reviewed commit, and a brief that says no review, are left as they were', async () => {
    const old = world()
    const { t: older } = await withCommit(old, 'old-records')
    older.reviews = 2
    expect(older.reviewed).toBeUndefined()
    expect(await old.engine.done(older.id, 'done', 'facts')).toMatchObject({ state: 'ready' })

    const w = world()
    const { t } = await withCommit(w, 'no-review')
    await round(w, t)
    writeFileSync(join(t.worktree!, 'fix.txt'), 'fix\n')
    sh('git add -A && git commit -qm fix', t.worktree!)
    expect(await w.engine.reviewGate(t)).toBeDefined()
    // the brief's own Review line wins over Settings, and so does a task's --set
    t.desc = t.desc.replace(/^- Review: on\..*$/m, "- Review: off. No review; the lines on reviewing below don't apply.")
    expect(t.desc).toContain('- Review: off.')
    expect(await w.engine.reviewGate(t)).toBeUndefined()
    // a task whose brief has no Review line follows its --set instead
    t.desc = t.desc.replace(/^- Review: off\..*\n/m, '')
    t.set = { 'brief.review': 'off' }
    expect(await w.engine.reviewGate(t)).toBeUndefined()
  })

  test('out of rounds, the refusal says why and only a coordinator can add one', async () => {
    const w = world()
    const { t } = await withCommit(w, 'out-of-rounds')
    t.rounds = 1
    await round(w, t)
    writeFileSync(join(t.worktree!, 'fix.txt'), 'fix\n')
    sh('git add -A && git commit -qm fix', t.worktree!)
    const failed = await w.engine.done(t.id, 'done', 'facts').catch((e: Error) => e.message)
    expect(failed).toContain('All 1 of')
    expect(failed).toContain('review rounds are used')
    expect(failed).toContain('last round on')
    expect(failed).toContain('fix')
    expect(failed).toContain(`shepherdr task review-more ${t.id}`)
    expect(await w.engine.reviewMore(t.id, t.project)).toEqual({ rounds: 2 })
    await round(w, t)
    expect(await w.engine.done(t.id, 'done', 'facts')).toMatchObject({ state: 'ready' })
  })

  test('a new own change after review still needs a normal round, even with no rounds left', async () => {
    const w = world()
    const { t } = await withCommit(w, 'own-after')
    t.rounds = 1
    await round(w, t)
    writeFileSync(join(t.worktree!, 'fix.txt'), 'fix\n')
    sh('git add -A && git commit -qm "own fix"', t.worktree!)
    const refusal = await w.engine.reviewGate(t)
    expect(refusal).toContain('All 1 of')
    expect(refusal).not.toContain('short rebase review')
    await expect(w.engine.reviewRound(t.id)).rejects.toThrow('review rounds are used')
  })

  test('a rebase that only moves a value derived from the base gets a short review outside the cap', async () => {
    const w = world()
    const dir = repo()
    const { t } = await started(w, dir, 'derived-value')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    writeFileSync(join(t.worktree!, 'hash.txt'), "const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\n")
    sh('git add -A && git commit -qm "add hello and bump derived hash"', t.worktree!)
    t.rounds = 1
    await round(w, t) // its one round is spent
    expect(w.engine.reviewsLeft(t)).toBe(0)
    const reviewed = t.reviewed![0].commit
    // another task merges and moves the derived value on the base
    writeFileSync(join(dir, 'hash.txt'), "const HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'\n")
    sh('git add -A && git commit -qm "base moves the hash"', dir)
    sh('git rebase main || true', t.worktree!)
    // resolve the conflict by taking the base's newer value
    writeFileSync(join(t.worktree!, 'hash.txt'), "const HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'\n")
    sh('git add -A && GIT_EDITOR=true git rebase --continue', t.worktree!)
    expect(head(t)).not.toBe(reviewed)
    const refusal = await w.engine.reviewGate(t)
    expect(refusal).toContain('base moved')
    expect(refusal).toContain('short review')
    expect(refusal).toContain('counted apart')
    expect(refusal).toContain("hash.txt: - const HASH = 'aaaa") // the exact differing line is named
    // out of normal rounds, the delta still gets its review, and it costs nothing against the cap
    const r = await w.engine.reviewRound(t.id)
    if ('wait' in r) throw new Error('no reviewer free')
    expect(r.rebase).toBe(true)
    expect(w.engine.reviewWords(t.id, r)).toContain('not counted against')
    const prompt = readFileSync(reviewerPromptPath(t.id, r.round), 'utf8')
    expect(prompt).toContain('Short rebase review: judge only the delta below')
    expect(prompt).toContain("hash.txt: - const HASH = 'aaaa")
    expect(prompt).not.toContain('review the whole change above again')
    expect(w.engine.reviewDone(t.id)).toBe(true)
    expect(t.reviewed!.at(-1)).toMatchObject({ commit: head(t), rebase: true })
    expect(t.rebaseReviews).toBe(1)
    expect(t.reviews).toBe(2)
    expect(w.engine.reviewsLeft(t)).toBe(0) // still no normal rounds left, and none were spent on the base move
    expect(await w.engine.reviewGate(t)).toBeUndefined()
    expect(await w.engine.done(t.id, 'done', 'facts')).toMatchObject({ state: 'ready' })
  })

  test('a rebase that drops an own change is refused with the exact lines and earns no rebase review', async () => {
    const w = world()
    const dir = repo()
    const { t } = await started(w, dir, 'dropped-row')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    writeFileSync(join(t.worktree!, 'notes.md'), 'mine: a row the task wrote\n')
    sh('git add -A && git commit -qm "add hello and my row"', t.worktree!)
    t.rounds = 1
    await round(w, t)
    // the base changes the same file (another task adds its own row)
    writeFileSync(join(dir, 'notes.md'), 'theirs: a row the base wrote\n')
    sh('git add -A && git commit -qm "base row"', dir)
    sh('git rebase main || true', t.worktree!)
    // resolve by taking theirs: the task's own row is gone
    writeFileSync(join(t.worktree!, 'notes.md'), 'theirs: a row the base wrote\n')
    sh('git add -A && GIT_EDITOR=true git rebase --continue', t.worktree!)
    const refusal = await w.engine.reviewGate(t)
    expect(refusal).toContain('dropped')
    expect(refusal).toContain('mine: a row the task wrote')
    expect(refusal).not.toContain('short review')
    // the gate catches it, so a cheap rebase review is not offered: restore the work and take a normal round
    await expect(w.engine.reviewRound(t.id)).rejects.toThrow('review rounds are used')
  })

  test('a conflict resolution that keeps both sides with the counts recomputed gets a short review outside the cap', async () => {
    const w = world()
    const t = await recounted(w, 'recounted-table', MERGED)
    const refusal = await w.engine.reviewGate(t)
    expect(refusal).toContain('base moved')
    expect(refusal).toContain('short review')
    expect(refusal).toContain('counted apart')
    // the recounted lines are named, so the short review judges exactly them
    expect(refusal).toContain('cases.md: + 856 cases in eight groups')
    // its one normal round is spent, and the delta still gets its review without it
    const r = await w.engine.reviewRound(t.id)
    if ('wait' in r) throw new Error('no reviewer free')
    expect(r.rebase).toBe(true)
    expect(w.engine.reviewDone(t.id)).toBe(true)
    expect(t.rebaseReviews).toBe(1)
    expect(w.engine.reviewsLeft(t)).toBe(0)
    expect(await w.engine.reviewGate(t)).toBeUndefined()
  })

  test('a resolution that merges the two sides but also changes a count, swaps words, drops a row or words a line anew is not a base move', async () => {
    // each resolution touches the task's own lines beyond a mechanical merge: a count raised or borrowed from another
    // line, a task number dropped, two task numbers traded, `a < b` made `b < a`, its row left out of the table the base
    // also grew, or a sentence worded anew
    for (const [name, resolved] of [
      ['raised-count', MERGED.replace(STOP(30), STOP(300))],
      ['reused-number', MERGED.replace(STOP(30), STOP(496))],
      ['dropped-number', MERGED.replace(STOP(30), 'stop when a < b after seconds')],
      ['swapped-numbers', MERGED.replace(L1, '| l1_correction | 30 |').replace(STOP(30), STOP(300))],
      ['swapped-words', MERGED.replace(STOP(30), 'stop when b < a after 30 seconds')],
      ['left-out-row', MERGED.replace(`${L1}\n`, '')],
      ['reworded-line', MERGED.replace('group needs its own --only; the slices are walked with --offset.', 'group needs its own --only; run it as an overnight batch.')],
    ] as const) {
      const w = world()
      const t = await recounted(w, name, resolved)
      const refusal = await w.engine.reviewGate(t)
      expect(refusal, name).toContain('All 1 of')
      expect(refusal, name).not.toContain('base moved')
      await expect(w.engine.reviewRound(t.id)).rejects.toThrow('review rounds are used')
    }
  })

  test('a negation inserted from a word the base carries is own work, not a merge', async () => {
    const w = world()
    const t = await conflict(w, 'inserted-negation', 'the run is fast.\n', 'the run is fast and quiet.\n', 'the run is not slow.\n', 'the run is not fast and quiet.\n')
    const refusal = await w.engine.reviewGate(t)
    expect(refusal).toContain('All 1 of')
    expect(refusal).not.toContain('base moved')
  })

  test('a word that only sits inside a base word cannot explain an inserted negation', async () => {
    const w = world()
    const t = await conflict(w, 'token-boundary', 'the run is fast.\n', 'the run is fast and quiet.\n', 'the run cannot be slow, 30 frames.\n', 'the run is not fast and quiet, 30 frames.\n')
    const refusal = await w.engine.reviewGate(t)
    expect(refusal).toContain('All 1 of')
    expect(refusal).not.toContain('base moved')
  })

  test('a number the task and the base share does not excuse an inserted word', async () => {
    const w = world()
    const t = await conflict(w, 'shared-number', 'fast 30 seconds.\n', 'fast quiet 30 seconds.\n', 'not slow, 30 seconds.\n', 'not fast quiet 30 seconds.\n')
    const refusal = await w.engine.reviewGate(t)
    expect(refusal).toContain('All 1 of')
    expect(refusal).not.toContain('base moved')
  })

  test('a word of an unrelated base line the resolution drops cannot explain a new own word', async () => {
    const w = world()
    const t = await conflict(
      w,
      'unrelated-base-words',
      'the run is fast.\nthe log is verbose.\n',
      'the run is fast and quiet.\nthe log is verbose.\n',
      'the run is quicker.\nthe log is not verbose.\n',
      'the run is not fast and quiet.\n',
    )
    const refusal = await w.engine.reviewGate(t)
    expect(refusal).toContain('All 1 of')
    expect(refusal).not.toContain('base moved')
  })

  test("a resolution that takes the base's side whole drops the task's own lines and is refused as dropped work", async () => {
    const w = world()
    const t = await recounted(w, 'dropped-rows-recount', THEIRS.replace(STOP(10), STOP(30)))
    const refusal = await w.engine.reviewGate(t)
    expect(refusal).toContain('dropped')
    expect(refusal).toContain('| l1_correction | 300 |')
    expect(refusal).not.toContain('short review')
    await expect(w.engine.reviewRound(t.id)).rejects.toThrow('review rounds are used')
  })

  test('a count the task changes itself, in a file the base touched elsewhere, is its own work', async () => {
    const w = world()
    const dir = repo()
    writeFileSync(join(dir, 'limits.md'), 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\ntimeout is 10 seconds\n')
    sh('git add -A && git commit -qm "add limits"', dir)
    const { t } = await started(w, dir, 'own-count')
    writeFileSync(join(t.worktree!, 'limits.md'), 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\ntimeout is 30 seconds\n')
    sh('git add -A && git commit -qm "raise the timeout"', t.worktree!)
    t.rounds = 1
    await round(w, t)
    // the base changes a distant line of the same file and the task rebases cleanly, then raises its own count again
    writeFileSync(join(dir, 'limits.md'), 'base a\nb\nc\nd\ne\nf\ng\nh\ni\nj\ntimeout is 10 seconds\n')
    sh('git add -A && git commit -qm "base a"', dir)
    sh('git rebase main', t.worktree!)
    writeFileSync(join(t.worktree!, 'limits.md'), 'base a\nb\nc\nd\ne\nf\ng\nh\ni\nj\ntimeout is 60 seconds\n')
    sh('git add -A && git commit -qm "raise it again"', t.worktree!)
    const refusal = await w.engine.reviewGate(t)
    expect(refusal).toContain('All 1 of')
    expect(refusal).not.toContain('base moved')
    await expect(w.engine.reviewRound(t.id)).rejects.toThrow('review rounds are used')
  })

  test('an own edit in a file the base also changed still needs a normal round', async () => {
    const w = world()
    const dir = repo()
    writeFileSync(join(dir, 'notes.md'), 'a\nb\nc\nd\ne\nf\n')
    sh('git add -A && git commit -qm "add notes"', dir)
    const { t } = await started(w, dir, 'own-in-base-file')
    writeFileSync(join(t.worktree!, 'notes.md'), 'task a\nb\nc\nd\ne\nf\n')
    sh('git add -A && git commit -qm "change a"', t.worktree!)
    t.rounds = 1
    await round(w, t)
    // the base changes a distant line; the task's rebase is clean, then it adds a new line of its own
    writeFileSync(join(dir, 'notes.md'), 'a\nb\nc\nd\ne\nbase f\n')
    sh('git add -A && git commit -qm "base f"', dir)
    sh('git rebase main', t.worktree!)
    writeFileSync(join(t.worktree!, 'notes.md'), 'task a\nb\nc\nd\ne\nbase f\nnew own line\n')
    sh('git add -A && git commit -qm "own edit after rebase"', t.worktree!)
    const refusal = await w.engine.reviewGate(t)
    expect(refusal).toContain('All 1 of')
    expect(refusal).not.toContain('base moved')
    await expect(w.engine.reviewRound(t.id)).rejects.toThrow('review rounds are used')
  })

  test("a resolution that undoes the task's own deletion is refused as dropped work", async () => {
    const w = world()
    const dir = repo()
    writeFileSync(join(dir, 'docs.md'), 'a\nb\nremove-me\nc\nd\ne\nf\n')
    sh('git add -A && git commit -qm "add docs"', dir)
    const { t } = await started(w, dir, 'restored-deletion')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    writeFileSync(join(t.worktree!, 'docs.md'), 'a\nb\nc\nd\ne\nf\n')
    sh('git add -A && git commit -qm "remove a line"', t.worktree!)
    t.rounds = 1
    await round(w, t)
    // the base changes a distant line; the rebase is clean, then a new commit puts the task's deletion back
    writeFileSync(join(dir, 'docs.md'), 'a\nb\nremove-me\nc\nd\ne\nbase f\n')
    sh('git add -A && git commit -qm "base f"', dir)
    sh('git rebase main', t.worktree!)
    writeFileSync(join(t.worktree!, 'docs.md'), 'a\nb\nremove-me\nc\nd\ne\nbase f\n')
    sh('git add -A && git commit -qm "restore the line"', t.worktree!)
    const refusal = await w.engine.reviewGate(t)
    expect(refusal).toContain('dropped')
    expect(refusal).toContain('remove-me')
    expect(refusal).not.toContain('short review')
  })

  test('an own line added to a file the base just created still needs a normal round', async () => {
    const w = world()
    const dir = repo()
    const { t } = await started(w, dir, 'new-in-base-file')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', t.worktree!)
    t.rounds = 1
    await round(w, t)
    // the base adds a file; the task rebases and then adds a line of its own to it
    writeFileSync(join(dir, 'notes.md'), 'base line\n')
    sh('git add -A && git commit -qm "base adds notes"', dir)
    sh('git rebase main', t.worktree!)
    writeFileSync(join(t.worktree!, 'notes.md'), 'base line\nsneaky own line\n')
    sh('git add -A && git commit -qm "own line"', t.worktree!)
    const refusal = await w.engine.reviewGate(t)
    expect(refusal).toContain('All 1 of')
    expect(refusal).not.toContain('base moved')
    await expect(w.engine.reviewRound(t.id)).rejects.toThrow('review rounds are used')
  })

  test('a deletion added to the own diff after review still needs a normal round', async () => {
    const w = world()
    const dir = repo()
    writeFileSync(join(dir, 'gone.txt'), 'a\nb\nc\n')
    sh('git add -A && git commit -qm "add gone"', dir)
    const { t } = await started(w, dir, 'new-deletion')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm hello', t.worktree!)
    t.rounds = 1
    await round(w, t)
    // with a base move elsewhere to offer a rebase review, the task also deletes a file of its own
    writeFileSync(join(dir, 'elsewhere.txt'), 'other\n')
    sh('git add -A && git commit -qm "base elsewhere"', dir)
    sh('git rebase main', t.worktree!)
    sh('git rm -q gone.txt && git commit -qm "delete gone"', t.worktree!)
    const refusal = await w.engine.reviewGate(t)
    expect(refusal).toContain('All 1 of')
    expect(refusal).not.toContain('base moved')
    await expect(w.engine.reviewRound(t.id)).rejects.toThrow('review rounds are used')
  })

  test('a rebase round that waited for a reviewer stays a rebase round when it is woken', async () => {
    const w = world()
    const dir = repo()
    const { t } = await started(w, dir, 'waited-rebase')
    writeFileSync(join(t.worktree!, 'hello.txt'), 'hello\n')
    writeFileSync(join(t.worktree!, 'hash.txt'), "const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\n")
    sh('git add -A && git commit -qm "add hello and derived hash"', t.worktree!)
    t.rounds = 1
    await round(w, t)
    writeFileSync(join(dir, 'hash.txt'), "const HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'\n")
    sh('git add -A && git commit -qm "base moves the hash"', dir)
    sh('git rebase main || true', t.worktree!)
    writeFileSync(join(t.worktree!, 'hash.txt'), "const HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'\n")
    sh('git add -A && GIT_EDITOR=true git rebase --continue', t.worktree!)
    // hold the reviewer so the rebase round has to wait, then wake it once it is free
    const h = w.engine.reviewChain(t)[0].h
    const key = keyOf(h.kind, h.model)
    expect(w.settings.set('models.maxAtOnce', `${h.kind}=1`, 'all').ok).toBe(true)
    w.engine.lease('hold-reviewer', 'reviewer', key, '')
    w.engine.reviewDeadline = 20
    w.engine.reviewPoll = 5
    const waited = await w.engine.reviewRound(t.id)
    expect('wait' in waited).toBe(true)
    expect(t.reviewWait?.rebase).toBe(true)
    w.engine.unlease('hold-reviewer')
    w.engine.retryReviews()
    expect(t.rebaseReviews).toBe(1)
    expect(t.reviews).toBe(2)
    expect(w.engine.reviewsLeft(t)).toBe(0)
    expect(w.engine.reviewWords(t.id, { round: 2, rounds: 1, reviewer: h, n: 0, key, rebase: true })).toContain('not counted against')
  })
})
