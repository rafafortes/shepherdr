// The pre-flight when a merge train forms, one faulty car at each position (engine.preflightTrain): the car whose prefix fails is
// found whether it is the head, a middle car or the last, the others land on one gate run and it goes to its own gate. The
// stack that passes and a restart are in engine-merge-train-preflight.test.ts.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { trainLog, trainWorld } from './train-world.ts'
import { asked, ledger, probes, WRONG_AFTER_BLOCKER } from './train-preflight-world.ts'
import { sh } from './engine-world.ts'

setDefaultTimeout(120_000)

const { decisions } = trainLog()

describe('the pre-flight when a merge train forms, with one faulty car', () => {
  // [the faulty member (1-based), the gate runs after the blocker's, what its search looked at]: the car whose prefix fails
  // is the faulty one at every position; the others land on one gate run, the faulty car goes to its own gate and is told
  const rows: [string, number, string[], string[][]][] = [
    [
      'the first (the head itself)',
      1,
      ['a', 'b'],
      [
        ['a,b,c,d', 'refused'],
        ['a,b', 'refused'],
        ['a', 'refused'],
        ['b,c,d', 'passed'],
      ],
    ],
    [
      'a middle one',
      3,
      ['a', 'c'],
      [
        ['a,b,c,d', 'refused'],
        ['a,b', 'passed'],
        ['a,b,c', 'refused'],
        ['a,b,d', 'passed'],
      ],
    ],
    [
      'the last',
      4,
      ['a', 'd'],
      [
        ['a,b,c,d', 'refused'],
        ['a,b', 'passed'],
        ['a,b,c', 'passed'],
      ],
    ],
  ]
  for (const [where, bad, after, looked] of rows) {
    test(`one faulty car, ${where}: the others land on one gate run, and the faulty one goes alone and is told by its own gate`, async () => {
      const world = await trainWorld(`pre-train-${bad}`, 4, '4', [bad], undefined, WRONG_AFTER_BLOCKER)
      const { w, dir, ts, riders, ran, pre } = world
      const names = (s: string) => s.split(',').map((x) => riders['abcd'.indexOf(x)].id)
      const said = await asked(world)
      // the blocker, then the four: only the faulty one is told, and by its own gate
      expect(said.map((r) => r.ok)).toEqual([true, ...riders.map((_, i) => i + 1 !== bad)])
      const faulty = riders[bad - 1]
      expect(said[bad].error).toContain(`${faulty.id}'s merge gate`)
      expect(said[bad].error).toContain(`bad-${bad}.txt is not wanted`)
      // one gate run for the others and one for the faulty car (a head that fails goes first: its own turn is the next one)
      expect(ran()).toEqual([ts[0].id, ...after.map((x) => riders['abcd'.indexOf(x)].id)])
      // what the search looked at, in order (the second turn of a failing head is a pass on the rest)
      expect(probes()).toEqual(looked.map(([cars, end]) => [names(cars).join(','), end]))
      // each of the others went in as its own commit, in line order
      const fine = riders.filter((_, i) => i + 1 !== bad)
      expect(sh(`git log --format=%s -n ${fine.length + 2}`, dir).split('\n')).toEqual([...fine.map((t) => `${t.id}: ${t.title}`).reverse(), `${ts[0].id}: ${ts[0].title}`, 'init'])
      for (const t of ts) expect([t.alone, t.bisect, t.landing]).toEqual([undefined, undefined, undefined])
      // the fault never made a gate refuse a train: the only refusal in the ledger is the faulty car's own gate
      expect(
        ledger()
          .filter((l) => l.kind === 'gate' && l.end === 'refused')
          .map((l) => [l.task, l.members]),
      ).toEqual([[faulty.id, undefined]])
      // the decision is in the server's log, naming the pre-flight's log; the faulty car was never gated with the others
      const lines = decisions(ts.map((t) => t.id))
      expect(lines.some((l) => l.includes(`${faulty.id} goes alone, to its own gate`) || l.includes(`the pre-flight fails on ${faulty.id} itself`))).toBe(true)
      expect(pre().filter(([, ref]) => ref === 'HEAD').length).toBe(looked.length)
      for (const t of fine) expect(w.sent.filter((m) => m.key.startsWith(`${t.id}/`) && /refus|pre-flight|didn't go in/i.test(m.text))).toEqual([])
    })
  }
})
