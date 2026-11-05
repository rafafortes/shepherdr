// Review rounds as a limit, and the one round its coordinator may add past it (SHEP-29, ported): a task's agent
// counts each round it starts, so one that has used them all is refused and asks its coordinator, which gives exactly
// one more — only once they are used, and never from the task's own agent.
import { describe, expect, test } from 'bun:test'
import { repo, until, world } from './engine-world.ts'

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
    expect(w.engine.reviewRound(t.id)).toEqual({ round: 1, rounds: 2 })
    expect(w.engine.reviewRound(t.id)).toEqual({ round: 2, rounds: 2 })
    expect(() => w.engine.reviewRound(t.id)).toThrow(`All 2 of ${t.id}'s review rounds are used`)

    const r = await w.engine.reviewMore(t.id, t.project)
    expect(r).toEqual({ rounds: 3 })
    expect(w.engine.roundsOf(t)).toBe(3)
    expect(t.reviewsAdded).toBe(1)
    // its agent hears it in its chat, and the chat shows why it woke
    expect(w.sent.at(-1)).toMatchObject({ key: `${t.id}/Agent` })
    expect(w.sent.at(-1)!.text).toContain('one review round: 3 in all')
    expect(w.posted.at(-1)!.card!.text).toContain('one review round')
    // the added round is the last: counted, then all of them are used again
    expect(w.engine.reviewRound(t.id)).toEqual({ round: 3, rounds: 3 })
    expect(() => w.engine.reviewRound(t.id)).toThrow(`All 3 of ${t.id}'s review rounds are used`)
  })

  test('refused a second time, before or after the round it added is used', async () => {
    const w = world()
    const t = await twoRounds(w, 'granted-once')
    w.engine.reviewRound(t.id)
    w.engine.reviewRound(t.id)
    await w.engine.reviewMore(t.id, t.project)
    // one, ever: asked again while its added round is still unused, and after it is used and they are all gone again
    await expect(w.engine.reviewMore(t.id, t.project)).rejects.toThrow('already added its one more review round')
    expect(w.engine.reviewRound(t.id)).toEqual({ round: 3, rounds: 3 })
    await expect(w.engine.reviewMore(t.id, t.project)).rejects.toThrow('already added its one more review round')
    expect(t.reviewsAdded).toBe(1)
    expect(w.engine.roundsOf(t)).toBe(3)
  })

  test('refused before the rounds are used', async () => {
    const w = world()
    const t = await twoRounds(w, 'before-they-are-used')
    await expect(w.engine.reviewMore(t.id, t.project)).rejects.toThrow(`has used 0 of 2 review rounds; it takes one more only once they are all used (its agent counts each round: shepherdr review ${t.id})`)
    w.engine.reviewRound(t.id)
    await expect(w.engine.reviewMore(t.id, t.project)).rejects.toThrow(`has used 1 of 2 review rounds`)
    expect(t.reviewsAdded).toBeUndefined()
    expect(w.engine.roundsOf(t)).toBe(2)
  })

  test("refused from the task's own agent, its reviewer, or another space's coordinator", async () => {
    const w = world()
    const t = await twoRounds(w, 'not-from-the-worker')
    w.engine.reviewRound(t.id)
    w.engine.reviewRound(t.id)
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
    w.engine.reviewRound(t.id)
    w.engine.reviewRound(t.id)
    t.merged = true
    await expect(w.engine.reviewMore(t.id, t.project)).rejects.toThrow('needs no more review')
  })
})
