// The pre-flight when a merge train forms, with more than one faulty car and with a fault only the whole stack has
// (engine.preflightTrain). The single faulty car at each position, the stack that passes, a restart, the bound and the faults
// that leave no car to blame are in the other engine-merge-train-preflight*.test.ts files.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { trainLog, trainWorld } from './train-world.ts'
import { asked, OVER, probes, WRONG_AFTER_BLOCKER } from './train-preflight-world.ts'
import { sh } from './engine-world.ts'

setDefaultTimeout(120_000)

// the server's log, kept out of the test output
trainLog()

describe('the pre-flight when a merge train forms, with more than one thing wrong', () => {
  test('two faulty cars: each is found in turn, and the rest still go on one gate run', async () => {
    const world = await trainWorld('pre-train-two', 5, '5', [2, 4], undefined, WRONG_AFTER_BLOCKER)
    const { dir, ts, riders, ran } = world
    const [a, b, c, d, e] = riders
    const said = await asked(world)
    expect(said.map((r) => r.ok)).toEqual([true, true, false, true, false, true])
    // the train of a, c and e on one run, then b and d each on a gate run of its own
    expect(ran()).toEqual([ts[0].id, a.id, b.id, d.id])
    // eight runs: the stack, its search (b), the new stack, its search (d), the stack that passed
    expect(probes()).toEqual([
      [`${a.id},${b.id},${c.id},${d.id},${e.id}`, 'refused'],
      [`${a.id},${b.id},${c.id}`, 'refused'],
      [`${a.id},${b.id}`, 'refused'],
      [a.id, 'passed'],
      [`${a.id},${c.id},${d.id},${e.id}`, 'refused'],
      [`${a.id},${c.id},${d.id}`, 'refused'],
      [`${a.id},${c.id}`, 'passed'],
      [`${a.id},${c.id},${e.id}`, 'passed'],
    ])
    expect(sh('git log --format=%s -n 4', dir).split('\n')).toEqual([`${e.id}: ${e.title}`, `${c.id}: ${c.title}`, `${a.id}: ${a.title}`, `${ts[0].id}: ${ts[0].title}`])
    for (const t of ts) expect([t.alone, t.bisect]).toEqual([undefined, undefined])
  })

  test('a failure only the whole stack has: the car whose prefix is the first to fail goes alone, and the rest go on', async () => {
    const world = await trainWorld('pre-train-whole', 4, '4', [], undefined, OVER(3))
    const { dir, ts, riders, ran } = world
    const [a, b, c, d] = riders
    const said = await asked(world)
    // nobody is faulty: d only made the stack too long, so it goes on its own gate, which passes
    expect(said.map((r) => r.ok)).toEqual([true, true, true, true, true])
    expect(ran()).toEqual([ts[0].id, a.id, d.id])
    // the top fails, d's prefix is the first to; with it out the three left are the prefix that passed, not run again
    expect(probes()).toEqual([
      [`${a.id},${b.id},${c.id},${d.id}`, 'refused'],
      [`${a.id},${b.id}`, 'passed'],
      [`${a.id},${b.id},${c.id}`, 'passed'],
    ])
    expect(sh(`git log -1 --format=%b ${c.squash}`, dir)).toContain(`Merge train: ${a.id}, ${b.id}, ${c.id} (one merge gate run)`)
    expect(sh(`git log -1 --format=%b ${d.squash}`, dir)).not.toContain('Merge train')
  })
})
