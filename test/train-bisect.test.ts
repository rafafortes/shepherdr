// The halves of a refused merge train (server/live/engine/train-bisect.ts), and a small model of the whole search that pins
// what it costs in gate runs: the engine's own sequences are in engine-merge-train-bisect*.test.ts.
import { describe, expect, test } from 'bun:test'
import { firstHalf, groupId, halves, rideBlock, type Bisect } from '../server/live/engine/train-bisect.ts'

describe('the halves of a refused train', () => {
  test('the first half is the smaller one and at least one: a pair or a trio goes on with its head alone', () => {
    expect([2, 3, 4, 5, 6, 7, 8].map(firstHalf)).toEqual([1, 1, 2, 2, 3, 3, 4])
  })

  test('a suspect set goes by its first half, the rest waits; anything else goes whole', () => {
    expect(halves(['a', 'b', 'c', 'd', 'e'], true)).toEqual({ go: ['a', 'b'], rest: ['c', 'd', 'e'] })
    expect(halves(['a', 'b'], true)).toEqual({ go: ['a'], rest: ['b'] })
    expect(halves(['a', 'b', 'c'], false)).toEqual({ go: ['a', 'b', 'c'], rest: [] })
  })

  test('a group is named by its head and the stack that was refused', () => {
    expect(groupId('POL-12', '0123456789abcdef')).toBe('POL-12@0123456')
  })

  test('a merge rides only with its group, in its own state; an unmarked one only with unmarked ones', () => {
    const suspect: Bisect = { id: 'g', suspect: true }
    const unknown: Bisect = { id: 'g' }
    expect(rideBlock(undefined, undefined)).toBeUndefined()
    expect(rideBlock(undefined, unknown)).toBe('group')
    expect(rideBlock(suspect, undefined)).toBe('group')
    expect(rideBlock(suspect, { id: 'other', suspect: true })).toBe('group')
    expect(rideBlock(suspect, suspect)).toBeUndefined()
    expect(rideBlock(unknown, unknown)).toBeUndefined()
    expect(rideBlock(suspect, unknown)).toBe('half')
    expect(rideBlock(unknown, suspect)).toBe('half')
  })
})

/**
 * The whole search on a line of `n` merges (1..n) the gate refuses whenever a faulty one is in the stack: the gate runs it
 * takes, and who is told. The engine's turn for turn (train, then mergeNow's lone gate), with line order kept.
 */
function search(n: number, bad: number[]) {
  type M = { id: number; mark?: Bisect; alone?: boolean; done?: boolean; told?: boolean }
  const line: M[] = Array.from({ length: n }, (_, i) => ({ id: i + 1 }))
  let runs = 0
  let groups = 0
  const refused = (ms: M[]) => ms.some((m) => bad.includes(m.id))
  const lone = (m: M) => {
    runs++
    m.told = refused([m])
    m.done = true
  }
  while (line.some((m) => !m.done)) {
    const [head, ...others] = line.filter((m) => !m.done)
    const riders = head.alone ? [] : others.filter((m) => !m.alone && !rideBlock(head.mark, m.mark))
    if (!riders.length) {
      lone(head)
      continue
    }
    let cur = [head, ...riders]
    let suspect = !!head.mark?.suspect
    let group = head.mark?.id
    for (;;) {
      const { go, rest } = halves(cur, suspect)
      if (go.length < 2) {
        for (const m of rest) {
          m.mark = undefined
          m.alone = true
        }
        lone(head)
        break
      }
      runs++
      if (!refused(go)) {
        for (const m of go) m.done = true
        break
      }
      group ??= `g${++groups}`
      for (const m of go) m.mark = { id: group, suspect: true }
      for (const m of rest) m.mark = { id: group }
      cur = go
      suspect = true
    }
  }
  return { runs, told: line.filter((m) => m.told).map((m) => m.id) }
}

describe('what the search costs, in gate runs', () => {
  test('one fault never costs more than sending each member to its own gate (a train of n and then n runs), and costs clearly fewer from five up', () => {
    for (let n = 2; n <= 8; n++)
      for (let at = 1; at <= n; at++) {
        const { runs, told } = search(n, [at])
        expect(told).toEqual([at])
        expect(runs).toBeLessThanOrEqual(n + 1)
        if (n >= 5) expect(runs).toBeLessThanOrEqual(n)
        if (n === 8) expect(runs).toBeLessThanOrEqual(6)
      }
  })

  test('the model gives the counts the engine tests assert', () => {
    expect([search(4, [4]).runs, search(4, [1]).runs, search(5, [3]).runs, search(8, [1]).runs, search(8, [8]).runs]).toEqual([4, 5, 5, 6, 5])
    // two faults cost more than one, and only they are told
    expect(search(4, [1, 4])).toEqual({ runs: 7, told: [1, 4] })
    expect(search(5, [2, 3])).toEqual({ runs: 8, told: [2, 3] })
    // nothing wrong: nothing to search
    expect(search(6, []).runs).toBe(1)
  })
})
