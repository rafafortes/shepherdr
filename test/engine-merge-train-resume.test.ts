// A restart while a merge gate runs, with merge trains on (engine.train, resumeMerges): the run a restart found is taken up by
// the merge that goes on from it, and is ended only when what it gated is no longer what the merge would gate. Real git, real
// gate commands, the engine's own world (train-world.ts). The runs are made as a restart leaves them: started by hand, the
// task records written as the server wrote them, then resumeMerges.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { trainLog, trainWorld, wtOf } from './train-world.ts'
import { ledger, probes } from './train-preflight-world.ts'
import { sh, until } from './engine-world.ts'
import { killGroup } from '../server/procs.ts'
import type { GateRun } from '../server/live/engine/engine.ts'

setDefaultTimeout(120_000)

const { decisions, lines } = trainLog()

/** every gate this file starts by hand, so a failing or interrupted test cannot leave one behind */
const gatesStarted: number[] = []
afterEach(() => {
  for (const pid of gatesStarted.splice(0)) killGroup(pid)
})

type World = Awaited<ReturnType<typeof trainWorld>>
type Task = World['ts'][number]

/** the gate runs of the ledger, in order: the task, how each ended and the merges it gated (a pre-flight's lines are left out) */
const gateLines = () => ledger().flatMap((l) => (l.kind === 'gate' ? [[l.task, l.end, l.members] as const] : []))

/** a gate run started by hand, as the server starts one: in its own session, its words and exit code in files of their own */
async function start(world: World, t: Task, at: { head: string; tip: string; members?: string[] }) {
  const { startGate } = await import('../server/live/engine/engine.ts')
  const run = startGate(world.w.settings.get('merge.gate', world.space), wtOf(t), { SHEPHERDR_TASK: t.id, SHEPHERDR_BASE: 'main' }, join(process.env.SHEPHERDR_HOME ?? '', 'gates'), t.id, {
    ...at,
    space: world.space,
  })
  gatesStarted.push(run.pid)
  t.gateRun = run
  return run
}

/** as a restart leaves a lone merge: `t` in its gate, a run of its own going on by itself on its branch */
async function leaveLone(world: World, t: Task, ahead = 1) {
  sh('git rebase -q main', wtOf(t))
  t.landing = { step: 'gate', at: ahead }
  return start(world, t, { head: sh('git rev-parse HEAD', wtOf(t)), tip: sh('git rev-parse main', world.dir) })
}

/** the cars' stack as the engine builds it: each squash commit on the one before, dated as main's tip */
function stackOf(dir: string, cars: Task[]) {
  const at = sh('git rev-parse main', dir)
  const date = sh('git log -1 --format=%cI main', dir)
  let top = at
  for (const x of cars) {
    const tree = sh(`git merge-tree --write-tree ${top} ${x.branch}`, dir).split('\n')[0]
    top = sh(`GIT_AUTHOR_DATE='${date}' GIT_COMMITTER_DATE='${date}' git commit-tree ${tree} -p ${top} -m '${x.id}: ${x.title}'`, dir)
  }
  return { at, top }
}

/** as a restart leaves a train: the head's worktree at the top of the stack of `cars`, its run going on by itself, and the other
 *  cars in line with the mark of the train they ride */
async function leaveTrain(world: World, cars: Task[]) {
  const [head, ...rest] = cars
  const { at, top } = stackOf(world.dir, cars)
  sh(`git checkout -q --detach ${top}`, wtOf(head))
  head.landing = { step: 'gate', at: 1, cars: cars.length }
  const run = await start(world, head, { head: top, tip: at, members: cars.map((c) => c.id) })
  for (const [i, c] of rest.entries()) c.landing = { step: 'queue', at: i + 2, behind: head.id, gate: true, train: head.id }
  return run
}

/** every task of the world has landed */
const landed = (world: World, ts: Task[]) => until(() => ts.every((t) => world.w.engine.statusOf(t) === 'done'), 30_000)

describe('a restart while a merge gate runs, with merge trains on: the run a restart found is taken up, not thrown away', () => {
  test("a lone merge's run with two merges in line behind it: the head goes on alone on it, and the two go in as a train after it", async () => {
    const world = await trainWorld('resume-lone', 2, '4')
    const { w, dir, ts, riders, go, ran } = world
    const [x] = ts
    const [a, b] = riders
    const run = await leaveLone(world, x, 3)
    a.landing = { step: 'queue', at: 2, behind: x.id, gate: true }
    b.landing = { step: 'queue', at: 3, behind: x.id, gate: true }
    await until(() => ran().length === 1, 20_000)
    w.engine.resumeMerges()
    await until(() => decisions([x.id]).length === 1)
    expect(decisions([x.id])).toEqual([`shepherdr: ${x.id}'s merge goes alone: its gate run, which a restart found, goes on; ${a.id}, ${b.id} wait for their turns`])
    // the same run is taken up: no train is stacked over it, and it is still the record's
    expect(x.gateRun).toBe(run)
    expect(ran()).toEqual([x.id])
    go(x)
    await until(() => w.engine.statusOf(x) === 'done')
    await until(() => a.landing?.cars === 2)
    go(a)
    await landed(world, ts)
    expect(ran()).toEqual([x.id, a.id])
    // one line for the head's run, ended passed (never stopped), then the train's
    expect(gateLines()).toEqual([
      [x.id, 'passed', undefined],
      [a.id, 'passed', [a.id, b.id]],
    ])
    expect(sh('git log --format=%s -n 4', dir).split('\n')).toEqual([b, a, x].map((t) => `${t.id}: ${t.title}`).concat('init'))
  })

  test('the same with the pre-flight on: the head is not looked at again, the train that forms behind it is', async () => {
    const world = await trainWorld('resume-lone-pre', 2, '4', [], undefined, 'exit 0')
    const { w, ts, riders, go, ran, pre } = world
    const [x] = ts
    const [a, b] = riders
    await leaveLone(world, x, 3)
    a.landing = { step: 'queue', at: 2, behind: x.id, gate: true }
    b.landing = { step: 'queue', at: 3, behind: x.id, gate: true }
    await until(() => ran().length === 1, 20_000)
    w.engine.resumeMerges()
    await until(() => decisions([x.id]).length === 1)
    // the resumed merges took their places after one pass: nobody is looked at at the door again
    expect(pre()).toEqual([])
    go(x)
    await until(() => w.engine.statusOf(x) === 'done')
    await until(() => a.landing?.cars === 2)
    go(a)
    await landed(world, ts)
    expect(ran()).toEqual([x.id, a.id])
    expect(gateLines()).toEqual([
      [x.id, 'passed', undefined],
      [a.id, 'passed', [a.id, b.id]],
    ])
    // the train's stack was looked at once, when it formed
    expect(probes()).toEqual([[`${a.id},${b.id}`, 'passed']])
  })

  test('a lone run an older Shepherdr started (no task, no members) is kept as well: the head goes on alone on it', async () => {
    const world = await trainWorld('resume-lone-old', 2, '4')
    const { w, ts, riders, go, ran } = world
    const [x] = ts
    const [a, b] = riders
    const run = await leaveLone(world, x, 3)
    // 2.0.85 and before kept neither the run's task nor its members
    const old = run as Partial<GateRun>
    old.task = undefined
    old.members = undefined
    old.space = undefined
    a.landing = { step: 'queue', at: 2, behind: x.id, gate: true }
    b.landing = { step: 'queue', at: 3, behind: x.id, gate: true }
    await until(() => ran().length === 1, 20_000)
    w.engine.resumeMerges()
    await until(() => decisions([x.id]).length === 1)
    expect(x.gateRun).toBe(run)
    go(x)
    await until(() => w.engine.statusOf(x) === 'done')
    await until(() => a.landing?.cars === 2)
    go(a)
    await landed(world, ts)
    expect(ran()).toEqual([x.id, a.id])
    expect(gateLines().map(([, end]) => end)).toEqual(['passed', 'passed'])
  })

  test('a lone run whose base moved while the server was down is ended, with its line and its why, and the merge gates again as a train', async () => {
    const world = await trainWorld('resume-lone-moved', 2, '4')
    const { w, dir, ts, riders, go, ran } = world
    const [x] = ts
    const [a, b] = riders
    await leaveLone(world, x, 3)
    a.landing = { step: 'queue', at: 2, behind: x.id, gate: true }
    b.landing = { step: 'queue', at: 3, behind: x.id, gate: true }
    await until(() => ran().length === 1, 20_000)
    const was = sh('git rev-parse --short=7 main', dir)
    sh('git commit -q --allow-empty -m "main moves on"', dir)
    const now = sh('git rev-parse --short=7 main', dir)
    w.engine.resumeMerges()
    // x's run is ended; the three go on one run, as they would have without a run to find
    await until(() => x.landing?.cars === 3)
    expect(lines().filter((l) => l.includes('cannot go on'))).toEqual([
      `shepherdr: ${x.id}'s merge gate run, which a restart found, cannot go on (main moved while Shepherdr was down: the run gated on ${was}, main is at ${now}): it is ended, and the merge goes on as without it`,
    ])
    go(x)
    await landed(world, ts)
    expect(ran()).toEqual([x.id, x.id])
    expect(gateLines()).toEqual([
      [x.id, 'stopped', undefined],
      [x.id, 'passed', [x.id, a.id, b.id]],
    ])
  })

  test('a lone run whose branch changed while the server was down is ended too, whatever the base did', async () => {
    const world = await trainWorld('resume-lone-changed', 0, '4')
    const { w, ts, go, ran } = world
    const [x] = ts
    await leaveLone(world, x)
    await until(() => ran().length === 1, 20_000)
    writeFileSync(join(wtOf(x), 'more.txt'), 'more\n')
    sh('git add -A && git commit -qm "more"', wtOf(x))
    w.engine.resumeMerges()
    await until(() => lines().some((l) => l.includes('cannot go on')))
    expect(lines().filter((l) => l.includes('cannot go on'))).toEqual([
      `shepherdr: ${x.id}'s merge gate run, which a restart found, cannot go on (its branch is no longer the commit the run gated): it is ended, and the merge goes on as without it`,
    ])
    await until(() => ran().length === 2)
    go(x)
    await landed(world, ts)
    expect(gateLines()).toEqual([
      [x.id, 'stopped', undefined],
      [x.id, 'passed', undefined],
    ])
  })

  test("a train's run with a merge queued after the train formed: the same run is taken up by the same cars, and the one that came later waits", async () => {
    const world = await trainWorld('resume-third', 4, '4', [], undefined, 'exit 0')
    const { w, dir, riders, go, ran, pre, heads } = world
    const [a, b, c, d] = riders
    await leaveTrain(world, [a, b, c])
    d.landing = { step: 'queue', at: 4, behind: a.id, gate: true }
    await until(() => ran().length === 1, 20_000)
    w.engine.resumeMerges()
    await until(() => a.landing?.step === 'gate' && a.landing.at > 1, 20_000)
    const at = sh('git rev-parse --short=7 main', dir)
    expect(w.engine.subOf(a)).toBe('Running the merge gate (a train of 3)')
    expect(w.engine.subOf(b)).toBe(`Going in with ${a.id}'s merge train`)
    expect(d.landing?.train).toBeUndefined()
    expect(decisions([a.id])).toEqual([
      `shepherdr: ${a.id}'s merge train: ${a.id}, ${b.id}, ${c.id} (one gate run on ${heads()[0]}, main at ${at}); its gate run, which a restart found, goes on. Left out: ${d.id} waits (its turn comes after the train whose gate run a restart found)`,
    ])
    go(a)
    await until(() => [a, b, c].every((t) => w.engine.statusOf(t) === 'done'))
    // d's turn, alone, on a run of its own
    await until(() => ran().length === 2)
    go(d)
    await landed(world, riders)
    expect(ran()).toEqual([a.id, d.id])
    expect(gateLines()).toEqual([
      [a.id, 'passed', [a.id, b.id, c.id]],
      [d.id, 'passed', undefined],
    ])
    // the train had passed its pre-flight before its gate began: nobody is looked at again
    expect(pre()).toEqual([])
    expect(sh('git log --format=%s -n 5', dir).split('\n')).toEqual([d, c, b, a].map((t) => `${t.id}: ${t.title}`).concat('init'))
  })

  test("a train's run an older Shepherdr started (no task, no members) still goes on as before when the cars are the same", async () => {
    const world = await trainWorld('resume-train-old', 3, '3')
    const { w, riders, go, ran } = world
    const [a, b, c] = riders
    const run = await leaveTrain(world, [a, b, c])
    const old = run as Partial<GateRun>
    old.task = undefined
    old.members = undefined
    old.space = undefined
    await until(() => ran().length === 1, 20_000)
    w.engine.resumeMerges()
    await until(() => a.landing?.step === 'gate' && a.landing.at > 1, 20_000)
    go(a)
    await landed(world, riders)
    // the stack is built again the same: one run in all, the one a restart left
    expect(ran()).toEqual([a.id])
    expect(gateLines().map(([, end]) => end)).toEqual(['passed'])
  })

  test("a train's run whose member was withdrawn while the server was down is ended with its why, and the turn goes on as without it", async () => {
    const world = await trainWorld('resume-gone', 3, '3')
    const { w, dir, riders, go, ran } = world
    const [a, b, c] = riders
    await leaveTrain(world, [a, b, c])
    // c left the line (its agent took it back to work, say)
    c.landing = undefined
    await until(() => ran().length === 1, 20_000)
    w.engine.resumeMerges()
    await until(() => a.landing?.cars === 2, 20_000)
    const at = sh('git rev-parse --short=7 main', dir)
    const said = decisions([a.id])
    expect(said[0]).toBe(
      `shepherdr: ${a.id}'s merge train: its gate run, which a restart found (${a.id}, ${b.id}, ${c.id}), cannot go on: ${c.id} is no longer in line. It is ended, and the turn goes on as without it`,
    )
    expect(said[1]).toContain(`${a.id}'s merge train: ${a.id}, ${b.id} (one gate run on `)
    expect(said[1]).toContain(`main at ${at})`)
    go(a)
    await until(() => [a, b].every((t) => w.engine.statusOf(t) === 'done'))
    // the run a restart left was stopped, and the two went in on one of their own; c was never merged
    expect(ran()).toEqual([a.id, a.id])
    expect(gateLines()).toEqual([
      [a.id, 'stopped', [a.id, b.id, c.id]],
      [a.id, 'passed', [a.id, b.id]],
    ])
    expect(w.engine.statusOf(c)).not.toBe('done')
  })

  test("a train's run whose base moved while the server was down is ended with its why, and the same cars gate again on the base as it is", async () => {
    const world = await trainWorld('resume-train-moved', 3, '3')
    const { w, dir, riders, go, ran } = world
    const [a, b, c] = riders
    await leaveTrain(world, [a, b, c])
    await until(() => ran().length === 1, 20_000)
    const was = sh('git rev-parse --short=7 main', dir)
    sh('git commit -q --allow-empty -m "main moves on"', dir)
    const now = sh('git rev-parse --short=7 main', dir)
    w.engine.resumeMerges()
    await until(() => a.landing?.cars === 3 && ran().length === 2, 20_000)
    expect(decisions([a.id])[0]).toBe(
      `shepherdr: ${a.id}'s merge train: its gate run, which a restart found (${a.id}, ${b.id}, ${c.id}), cannot go on: main moved while Shepherdr was down: the run gated on ${was}, main is at ${now}. It is ended, and the turn goes on as without it`,
    )
    go(a)
    await landed(world, riders)
    expect(gateLines()).toEqual([
      [a.id, 'stopped', [a.id, b.id, c.id]],
      [a.id, 'passed', [a.id, b.id, c.id]],
    ])
  })

  test("a train's run whose car changed while the server was down is ended too: what the run gated is not what would land", async () => {
    const world = await trainWorld('resume-train-changed', 3, '3')
    const { w, riders, go, ran } = world
    const [a, b, c] = riders
    await leaveTrain(world, [a, b, c])
    await until(() => ran().length === 1, 20_000)
    // b's agent made one more commit meanwhile
    writeFileSync(join(wtOf(b), 'more.txt'), 'more\n')
    sh('git add -A && git commit -qm "more"', wtOf(b))
    w.engine.resumeMerges()
    await until(() => a.landing?.cars === 3 && ran().length === 2, 20_000)
    expect(decisions([a.id])[0]).toBe(
      `shepherdr: ${a.id}'s merge train: its gate run, which a restart found (${a.id}, ${b.id}, ${c.id}), cannot go on: the stack is not the one the run gated (a car's change differs). It is ended, and the turn goes on as without it`,
    )
    go(a)
    await landed(world, riders)
    expect(gateLines().map(([, end]) => end)).toEqual(['stopped', 'passed'])
  })

  test("a train's run whose only other car cannot ride any more: ended with that car's own reason, and the head goes alone", async () => {
    const world = await trainWorld('resume-train-blocked', 2, '3')
    const { w, riders, go, ran } = world
    const [a, b] = riders
    await leaveTrain(world, [a, b])
    await until(() => ran().length === 1, 20_000)
    // b's agent is at work again: it may not ride
    w.agentIs(`${b.id}/Agent`, 'working')
    w.engine.resumeMerges()
    await until(() => a.landing?.step === 'gate' && a.landing.at > 1, 20_000)
    expect(decisions([a.id])).toEqual([
      `shepherdr: ${a.id}'s merge train: its gate run, which a restart found (${a.id}, ${b.id}), cannot go on: ${b.id}'s agent is working. It is ended, and the turn goes on as without it`,
      `shepherdr: ${a.id}'s merge goes alone: ${b.id}'s agent is working`,
    ])
    go(a)
    await until(() => w.engine.statusOf(a) === 'done')
    go(b)
    await landed(world, riders)
    expect(ran()).toEqual([a.id, a.id, b.id])
    expect(gateLines()).toEqual([
      [a.id, 'stopped', [a.id, b.id]],
      [a.id, 'passed', undefined],
      [b.id, 'passed', undefined],
    ])
  })
})
