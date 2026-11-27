// A refused merge train is searched by halves, not dissolved (engine.train, train-bisect.ts): the sequences that matter,
// with the gate runs counted. Before, a refusal sent every member to a gate of its own (a train of n cost n + 1 runs).
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bisectRows, trainLog, trainWorld, REFUSE_OVER } from './train-world.ts'
import { sh } from './engine-world.ts'

setDefaultTimeout(120_000)

const { decisions, lines } = trainLog()

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
    // what a refusal with no words leaves is its log (empty) and its line: the code, no last line, no time to speak of
    const refused = ledger().filter((l) => l.end === 'refused')
    expect(refused.map((l) => [l.code, l.last, l.seconds < 5])).toEqual([
      [2, '', true],
      [2, '', true],
      [2, '', true],
    ])
    for (const l of refused) expect(readFileSync(join(gatesDir(), l.log), 'utf8')).toBe('')
    expect(said[2].error).toContain(`Its full log is kept at ${join(gatesDir(), refused[2].log)}`)
    // the train's own line names the log of the run it was refused on
    expect(lines().find((l) => l.includes('merge train refused'))).toContain(`log ${refused[0].log})`)
    expect(w.engine.statusOf(riders[0])).toBe('done')
  })

  /** the ledger of this test's home: one line a gate run, in the order they ended */
  const ledger = (): { task: string; members?: string[]; end: string; code: number | null; log: string; last: string; seconds: number; head: string; base: string }[] =>
    readFileSync(join(process.env.SHEPHERDR_HOME ?? '', 'gates', 'ledger.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
  const gatesDir = () => join(process.env.SHEPHERDR_HOME ?? '', 'gates')

  test('every gate run of a search keeps its log and has its line: the train, its halves, the lone gates, with who each was for and how it ended', async () => {
    const { w, ts, riders, ran, heads, merged } = await trainWorld('bisect-ledger', 4, '4', [4])
    const [a, b, c, d] = riders
    const said = await merged()
    // the blocker, the train of four (refused), its first half (passed, went in), then c alone (passed) and d alone (refused)
    const lines = ledger()
    expect(lines.map((l) => [l.task, l.members, l.end, l.code])).toEqual([
      [ts[0].id, undefined, 'passed', 0],
      [a.id, [a.id, b.id, c.id, d.id], 'refused', 1],
      [a.id, [a.id, b.id], 'passed', 0],
      [c.id, undefined, 'passed', 0],
      [d.id, undefined, 'refused', 1],
    ])
    expect(lines.map((l) => l.head.slice(0, 7))).toEqual(heads())
    expect(lines.map((l) => l.last.replace(/[0-9a-f]{7,}$/, '<tree>'))).toEqual([
      'Gate: green on <tree>',
      'bad-4.txt is not wanted',
      'Gate: green on <tree>',
      'Gate: green on <tree>',
      'bad-4.txt is not wanted',
    ])
    // each run's log is there, and says what the gate said
    for (const l of lines) expect(existsSync(join(gatesDir(), l.log))).toBe(true)
    expect(readFileSync(join(gatesDir(), lines[1].log), 'utf8')).toContain('bad-4.txt is not wanted')
    expect(ran()).toHaveLength(5)
    // d, whose change fails alone, is told where its log is; the others heard nothing
    expect(said[4].error).toContain(`Its full log is kept at ${join(gatesDir(), lines[4].log)}`)
    expect(w.sent.filter((m) => /train|refus|log/i.test(m.text))).toEqual([])
  })

  test('only the newest logs of a space are kept, the ledger names every run', async () => {
    const { w, riders, merged } = await trainWorld('bisect-keep', 4, '4', [4])
    w.engine.gateLedger.keep = 2
    await merged()
    const runs = ledger()
    expect(runs).toHaveLength(5)
    expect(
      readdirSync(gatesDir())
        .filter((f) => f.endsWith('.log'))
        .sort(),
    ).toEqual(
      runs
        .slice(-2)
        .map((l) => l.log)
        .sort(),
    )
    expect(riders).toHaveLength(4)
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
      `shepherdr: ${a.id}'s merge train refused (exit 1; log <file>): ${a.id}, ${b.id}, ${c.id}, ${d.id} are searched by halves, ${a.id}, ${b.id} first and ${c.id}, ${d.id} after`,
      `shepherdr: ${a.id}'s merge train: ${a.id}, ${b.id} (one gate run on ${heads()[2]}, main at ${at}): the first half of ${a.id}, ${b.id}, ${c.id}, ${d.id}, which a gate run refused together`,
      `shepherdr: ${a.id}'s merge train went in: ${a.id} ${short(a.squash)}, ${b.id} ${short(b.squash)}. ${c.id}, ${d.id} hold the fault the first half did not (or an interaction): they are split before their gate`,
      `shepherdr: ${c.id}'s merge goes alone: the first half of ${c.id}, ${d.id} is ${c.id}; ${d.id} goes alone after it`,
      `shepherdr: ${d.id}'s merge goes alone (its turn alone after a refused train)`,
    ])
  })
})
