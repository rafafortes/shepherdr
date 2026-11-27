// The pre-flight when a merge train forms, with a fault between every two cars, the bound on the runs of a turn, and a group the
// gate is searching by halves (engine.preflightTrain). The single faulty car at each position, the faults found one after the
// other and the whole-stack fault are in the other engine-merge-train-preflight*.test.ts files.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { trainLog, trainWorld } from './train-world.ts'
import { asked, ledger, OVER, probes, WRONG_AFTER_BLOCKER } from './train-preflight-world.ts'

setDefaultTimeout(120_000)

const { decisions } = trainLog()

describe('the pre-flight when a merge train forms, where it must give way', () => {
  test('a fault between every two cars: each is taken out in turn, the head goes alone, and every gate still runs', async () => {
    const world = await trainWorld('pre-train-pairs', 3, '3', [], undefined, OVER(1))
    const { w, ts, riders, ran } = world
    const [a, b, c] = riders
    const said = await asked(world)
    expect(said.map((r) => r.ok)).toEqual([true, true, true, true])
    // no stack of two passes: the train dissolves into single merges, as the gate itself would have sent them
    expect(ran()).toEqual([ts[0].id, a.id, b.id, c.id])
    expect(probes()).toEqual([
      [`${a.id},${b.id},${c.id}`, 'refused'],
      [`${a.id},${b.id}`, 'refused'],
      [a.id, 'passed'],
      [`${a.id},${c.id}`, 'refused'],
    ])
    expect(decisions(ts.map((t) => t.id)).filter((l) => l.includes('goes alone')).length).toBeGreaterThanOrEqual(3)
    for (const t of ts) expect([t.alone, t.bisect]).toEqual([undefined, undefined])
    expect(w.engine.statusOf(c)).toBe('done')
  })

  test('the runs of a turn are bounded: when they are spent the head goes alone, and a later turn has its own', async () => {
    const world = await trainWorld('pre-train-bound', 5, '5', [2, 4], undefined, WRONG_AFTER_BLOCKER)
    const { w, riders, ts, ran } = world
    w.engine.preflightRuns = 3
    const [a, b, c, d, e] = riders
    const said = await asked(world)
    // nothing lands that a gate did not pass: b and d are told by their own gates, the others go in
    expect(said.map((r) => r.ok)).toEqual([true, true, false, true, false, true])
    expect(ran().slice(0, 2)).toEqual([ts[0].id, a.id])
    // the first turn made three runs and no more, and said why it stopped; the car the search had not reached was not marked
    const lines = ledger()
    const blockerGate = lines.findIndex((l) => l.kind === 'gate')
    const nextGate = lines.findIndex((l, i) => i > blockerGate && l.kind === 'gate')
    expect(lines.slice(blockerGate + 1, nextGate).map((l) => [l.kind, !!l.members])).toEqual([
      ['preflight', true],
      ['preflight', true],
      ['preflight', true],
    ])
    expect(decisions(ts.map((t) => t.id))).toContain(`shepherdr: ${a.id}'s merge train: the pre-flight's 3 runs for this turn are spent`)
    for (const t of [a, b, c, d, e]) expect([t.alone, t.bisect]).toEqual([undefined, undefined])
  })

  test('a group the gate refused and is searching by halves is not looked at again: its head has a mark, and the search is the gate runs', async () => {
    // a pre-flight that passes everything: the gate refuses the train for b's bad file, and the halves go on without it
    const world = await trainWorld('pre-train-marked', 4, '4', [2], undefined, 'exit 0')
    const { riders, ran } = world
    const [, b] = riders
    const said = await asked(world)
    expect(said.map((r) => r.ok)).toEqual([true, true, false, true, true])
    expect(ran().length).toBeGreaterThan(3)
    // the train's own stack was looked at once; the halves that followed went to the gate without another look
    expect(probes()).toEqual([[riders.map((t) => t.id).join(','), 'passed']])
    expect(said[2].error).toContain(`${b.id}'s merge gate`)
  })
})
