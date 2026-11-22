// biome-ignore-all lint/style/noNonNullAssertion: the test world's task and worktree are known to exist once started
// A review belongs to the commit it reviewed (the 3.1.45/3.1.46 idea, ported to 2.0): `--done` records the commit,
// the round and the reviewer; ready and merge refuse a final commit no round was recorded on, name the last reviewed
// commit and what came after, and spend no round on a clean base merge or an identical tree. A later round's prompt and
// answer name both the incremental range and the whole change.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

  test('a rebase onto a moved base changes the tree and needs a round', async () => {
    const w = world()
    const { t, dir } = await withCommit(w, 'rebase')
    await round(w, t)
    writeFileSync(join(dir, 'other.txt'), 'other\n')
    sh('git add -A && git commit -qm other', dir)
    sh('git rebase main', t.worktree!)
    expect(await w.engine.reviewGate(t)).toBeDefined()
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
})
