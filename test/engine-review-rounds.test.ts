// Review rounds as a limit, and the one round its coordinator may add past it (SHEP-29, ported): a task's agent
// counts each round it starts, so one that has used them all is refused and asks its coordinator, which gives exactly
// one more — only once they are used, and never from the task's own agent.
import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repo, sh, until, world } from './engine-world.ts'

/** a started task whose brief said at most two review rounds */
async function twoRounds(w: ReturnType<typeof world>, name: string) {
  const p = await w.places.add(repo(), name)
  const t = w.engine.add({ project: p.name, title: 'Reviewed change', by: 'test', set: { 'review.rounds': '2' } })
  await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
  return t
}

describe('review rounds a coordinator may add', () => {
  test("its coordinator adds exactly one, once the task's own are used, and its agent is told to run it", async () => {
    const w = world()
    const t = await twoRounds(w, 'granted')
    // the rounds its brief said, and each one its agent starts is counted
    expect(t.rounds).toBe(2)
    expect(await w.engine.reviewRound(t.id)).toMatchObject({ round: 1, rounds: 2 })
    expect(await w.engine.reviewRound(t.id)).toMatchObject({ round: 2, rounds: 2 })
    await expect(w.engine.reviewRound(t.id)).rejects.toThrow(`All 2 of ${t.id}'s review rounds are used`)

    const r = await w.engine.reviewMore(t.id, t.project)
    expect(r).toEqual({ rounds: 3 })
    expect(w.engine.roundsOf(t)).toBe(3)
    expect(t.reviewsAdded).toBe(1)
    // its agent hears it in its chat, and the chat shows why it woke
    expect(w.sent.at(-1)).toMatchObject({ key: `${t.id}/Agent` })
    expect(w.sent.at(-1)!.text).toContain('one review round: 3 in all')
    expect(w.posted.at(-1)!.card!.text).toContain('one review round')
    // the added round is the last: counted, then all of them are used again
    expect(await w.engine.reviewRound(t.id)).toMatchObject({ round: 3, rounds: 3 })
    await expect(w.engine.reviewRound(t.id)).rejects.toThrow(`All 3 of ${t.id}'s review rounds are used`)
  })

  test('refused a second time, before or after the round it added is used', async () => {
    const w = world()
    const t = await twoRounds(w, 'granted-once')
    await w.engine.reviewRound(t.id)
    await w.engine.reviewRound(t.id)
    await w.engine.reviewMore(t.id, t.project)
    // one, ever: asked again while its added round is still unused, and after it is used and they are all gone again
    await expect(w.engine.reviewMore(t.id, t.project)).rejects.toThrow('already added its one more review round')
    expect(await w.engine.reviewRound(t.id)).toMatchObject({ round: 3, rounds: 3 })
    await expect(w.engine.reviewMore(t.id, t.project)).rejects.toThrow('already added its one more review round')
    expect(t.reviewsAdded).toBe(1)
    expect(w.engine.roundsOf(t)).toBe(3)
  })

  test('refused before the rounds are used', async () => {
    const w = world()
    const t = await twoRounds(w, 'before-they-are-used')
    await expect(w.engine.reviewMore(t.id, t.project)).rejects.toThrow(
      `has used 0 of 2 review rounds; it takes one more only once they are all used (its agent counts each round: shepherdr review ${t.id})`,
    )
    await w.engine.reviewRound(t.id)
    await expect(w.engine.reviewMore(t.id, t.project)).rejects.toThrow(`has used 1 of 2 review rounds`)
    expect(t.reviewsAdded).toBeUndefined()
    expect(w.engine.roundsOf(t)).toBe(2)
  })

  test("refused from the task's own agent, its reviewer, or another space's coordinator", async () => {
    const w = world()
    const t = await twoRounds(w, 'not-from-the-worker')
    await w.engine.reviewRound(t.id)
    await w.engine.reviewRound(t.id)
    for (const from of [`${t.id}/Agent`, `${t.id}/Reviewer`]) await expect(w.engine.reviewMore(t.id, from)).rejects.toThrow('never its own agent')
    await expect(w.engine.reviewMore(t.id, 'p:elsewhere:other')).rejects.toThrow(`Only ${w.places.nameOf(t.project)}'s coordinator`)
    expect(t.reviewsAdded).toBeUndefined()
    // nothing it said woke it, and its own rounds were all used
    expect(w.sent.some((s) => s.text.includes('one review round'))).toBe(false)
    // the task's own coordinator is the one that can
    expect(await w.engine.reviewMore(t.id, t.project)).toEqual({ rounds: 3 })
  })

  test('a task that is done needs no more review', async () => {
    const w = world()
    const t = await twoRounds(w, 'already-done')
    await w.engine.reviewRound(t.id)
    await w.engine.reviewRound(t.id)
    t.merged = true
    await expect(w.engine.reviewMore(t.id, t.project)).rejects.toThrow('needs no more review')
  })

  test('a task on its way into main is told to retry after the merge, not that it needs no review', async () => {
    const w = world()
    const t = await twoRounds(w, 'landing')
    await w.engine.reviewRound(t.id)
    await w.engine.reviewRound(t.id)
    t.reported = true
    t.landing = { step: 'merge', at: Date.now() }
    // a merge really in flight: the runner holds its landing, or a detached gate run is on the task record
    const run = new Promise<{ ok: boolean }>(() => undefined)
    const landings = (w.engine as unknown as { runner: { landings: Map<string, unknown> } }).runner.landings
    landings.set(t.id, run)
    expect(t.landing?.step).toBe('merge')
    const failed = await w.engine.reviewMore(t.id, t.project).catch((e: Error) => e.message)
    expect(failed).toContain('on its way into main')
    expect(failed).toContain('Merging')
    expect(failed).toContain('Retry after the merge finishes')
    expect(t.reviewsAdded).toBeUndefined()
    expect(t.landing?.step).toBe('merge')

    t.landing = { step: 'gate', at: Date.now() }
    landings.delete(t.id)
    t.gateRun = { at: Date.now(), pid: 1, exit: 'gate.exit', log: 'gate.log' } as never
    const gated = await w.engine.reviewMore(t.id, t.project).catch((e: Error) => e.message)
    expect(gated).toContain('Running the merge gate')
    expect(gated).toContain('Retry after the merge finishes')
    expect(t.reviewsAdded).toBeUndefined()
  })

  test('a merge stopped on a conflict, rebased by hand with its rounds used, gets the added round and merges', async () => {
    const w = world()
    const dir = repo()
    const p = await w.places.add(dir, 'rebase-round')
    const t = w.engine.add({ project: p.name, title: 'Reviewed change', by: 'test', set: { 'review.rounds': '1' } })
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
    const wt = t.worktree
    if (!wt) throw new Error('the task has no worktree')
    writeFileSync(join(wt, 'README.md'), 'mine\n')
    sh('git add -A && git commit -qm "change the readme"', wt)
    expect(await w.engine.reviewRound(t.id)).toMatchObject({ round: 1, rounds: 1 })
    expect(w.engine.reviewDone(t.id)).toBe(true)
    expect(w.engine.reviewsLeft(t)).toBe(0)

    // main moves to a clashing readme: the merge stops on the conflict and parks its landing on the agent
    writeFileSync(join(dir, 'README.md'), 'theirs\n')
    sh('git add -A && git commit -qm "main changes the readme"', dir)
    expect(await w.engine.done(t.id, 'Changed the readme.')).toMatchObject({ state: 'ready' })
    const stopped = await w.engine.merge(t.id, { self: true })
    expect(stopped.error).toContain('Conflict with main')
    expect(t.landing?.step).toBe('rebase')
    expect(w.engine.subOf(t)).toBe('Merge stopped on a conflict with main: rebasing by hand')
    expect(w.engine.statusOf(t)).not.toBe('merging')

    // nothing is in flight: the round the rebased head needs is no longer refused, and the parked landing is gone
    expect(await w.engine.reviewMore(t.id, t.project)).toEqual({ rounds: 2 })
    expect(t.reviewsAdded).toBe(1)
    expect(t.landing).toBeUndefined()
    expect(t.reported).toBe(false)

    // the agent rebases by hand, resolves into new work of its own, and records the round it was just given
    expect(sh('git rebase main || true', wt)).toContain('CONFLICT')
    writeFileSync(join(wt, 'README.md'), 'mine and theirs\n')
    sh('git add -A && GIT_EDITOR=true git rebase --continue', wt)
    const unreviewed = await w.engine.reviewGate(t)
    expect(unreviewed).toContain('your final commit')
    expect(unreviewed).toContain(`shepherdr review ${t.id}`)
    expect(unreviewed).toContain('1 of 2 rounds left') // the coordinator's added round is there to be used
    expect(await w.engine.reviewRound(t.id)).toMatchObject({ round: 2, rounds: 2 })
    expect(w.engine.reviewDone(t.id)).toBe(true)
    expect(await w.engine.reviewGate(t)).toBeUndefined()
    expect(await w.engine.done(t.id, 'Rebased and resolved the conflict.')).toMatchObject({ state: 'ready' })
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    expect(w.engine.statusOf(t)).toBe('done')
  })
})
