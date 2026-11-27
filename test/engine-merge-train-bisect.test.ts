// A refused merge train is searched by halves, not dissolved (engine.train, train-bisect.ts): the sequences that matter,
// with the gate runs counted. Before, a refusal sent every member to a gate of its own (a train of n cost n + 1 runs).
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { bisectRows, trainWorld, REFUSE_OVER } from './train-world.ts'
import { sh } from './engine-world.ts'

setDefaultTimeout(120_000)

// the server's log while these run: its lines about a train's decisions are what the tests read
let log: string[] = []
const stderr = console.error
beforeEach(() => {
  log = []
  console.error = (m: unknown) => void log.push(String(m))
})
afterEach(() => {
  console.error = stderr
})
const decisions = (ids: string[]) => log.filter((l) => /merge (train|goes alone)/.test(l) && ids.some((id) => l.startsWith(`shepherdr: ${id}'s `)))

describe('a refused merge train is searched by halves', () => {
  // one fault: never more gate runs than the old way, and clearly fewer as the train grows (the larger trains: the -large file)
  bisectRows([
    [2, [1], 3, 3],
    [2, [2], 3, 3],
    [3, [1], 4, 4],
    [3, [2], 4, 4],
    [3, [3], 4, 4],
  ])

  test('a fault that only a long stack has: every half passes on its own, so everything lands and nothing is refused', async () => {
    // the gate refuses a stack that adds more than two files to main: the train of four is refused, its halves are not
    const { w, ts, riders, ran, merged } = await trainWorld('bisect-long', 4, '4', [], REFUSE_OVER(2))
    const said = await merged()
    expect(said.map((r) => r.ok)).toEqual([true, true, true, true, true])
    // the blocker; the train of four (refused); its first half (two); then each of the second half alone, never the whole of
    // it again (it holds the fault, or an interaction)
    expect(ran().length - 1).toBe(4)
    expect(ran().slice(1)).toEqual([riders[0].id, riders[0].id, riders[2].id, riders[3].id])
    expect(riders.map((t) => w.engine.statusOf(t))).toEqual(['done', 'done', 'done', 'done'])
    expect(decisions(ts.map((t) => t.id)).filter((l) => l.includes('merge train refused'))).toHaveLength(1)
  })

  test('an exit with no words and no time: the same search, the faulty one told with no output to show', async () => {
    // a gate that fails at once with exit 2 and prints nothing (the cause of a refusal that left no log)
    const { w, riders, ran, merged } = await trainWorld('bisect-silent', 4, '4', [2], 'for f in bad-*.txt; do [ -e "$f" ] && exit 2; done; ')
    const said = await merged()
    expect(said.map((r) => r.ok)).toEqual([true, true, false, true, true])
    expect(said[2].error).toContain(`${riders[1].id}'s merge gate`)
    expect(said[2].error).toContain('failed (exit 2)')
    expect(riders[1].mergeStop).toBe('Refused by the gate: exit 2')
    expect(ran().length - 1).toBe(5)
    expect(w.engine.statusOf(riders[0])).toBe('done')
  })

  test('the lines say what each decision was: the train, its refusal, its halves, who waits unproven and what went in', async () => {
    const { dir, ts, riders, ran, heads, merged } = await trainWorld('bisect-lines', 4, '4', [4])
    await merged()
    const [a, b, c, d] = riders
    const short = (ref: string | undefined) => sh(`git rev-parse --short=7 ${ref}`, dir)
    const at = short(ts[0].squash)
    expect(ran().length - 1).toBe(4)
    expect(decisions(ts.map((t) => t.id))).toEqual([
      `shepherdr: ${a.id}'s merge train: ${a.id}, ${b.id}, ${c.id}, ${d.id} (one gate run on ${heads()[1]}, main at ${at})`,
      `shepherdr: ${a.id}'s merge train refused (exit 1): ${a.id}, ${b.id}, ${c.id}, ${d.id} are searched by halves, ${a.id}, ${b.id} first and ${c.id}, ${d.id} after`,
      `shepherdr: ${a.id}'s merge train: ${a.id}, ${b.id} (one gate run on ${heads()[2]}, main at ${at}): the first half of ${a.id}, ${b.id}, ${c.id}, ${d.id}, which a gate run refused together`,
      `shepherdr: ${a.id}'s merge train went in: ${a.id} ${short(a.squash)}, ${b.id} ${short(b.squash)}. ${c.id}, ${d.id} hold the fault the first half did not (or an interaction): they are split before their gate`,
      `shepherdr: ${c.id}'s merge goes alone: the first half of ${c.id}, ${d.id} is ${c.id}; ${d.id} goes alone after it`,
      `shepherdr: ${d.id}'s merge goes alone (its turn alone after a refused train)`,
    ])
  })
})
