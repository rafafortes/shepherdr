// A refused merge train searched by halves, in the line it leaves: who may ride with whom while it lasts, what main moving
// under a half does, and what a restart between the halves finds (engine.train, train-bisect.ts).
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { trainLog, trainWorld, wtOf } from './train-world.ts'
import { sh, until, world } from './engine-world.ts'
import { killGroup } from '../server/procs.ts'

setDefaultTimeout(120_000)

const { decisions } = trainLog()

/** every gate this file starts by hand, so a failing or interrupted test cannot leave one behind */
const gatesStarted: number[] = []
afterEach(() => {
  for (const pid of gatesStarted.splice(0)) killGroup(pid)
})

describe('a refused merge train searched by halves, in its line', () => {
  test('merge.train takes 2 to 8', async () => {
    const { w, space } = await trainWorld('bisect-cap', 0, '2')
    for (const k of ['2', '8', 'off']) expect(w.settings.set('merge.train', k, { space }).ok).toBe(true)
    for (const k of ['1', '9']) expect(w.settings.set('merge.train', k, { space }).ok).toBe(false)
  })

  test("the marks are on disk before the next gate starts: the Shepherdr that comes back reads the group's halves", async () => {
    const { w, ts, blocker, riders, go, ran } = await trainWorld('bisect-marks', 4, '4', [4])
    const [a, b, c, d] = riders
    const asked = [w.engine.merge(blocker.id, { self: true })]
    await until(() => blocker.landing?.step === 'gate')
    for (const t of riders) asked.push(w.engine.merge(t.id, { self: true }))
    for (const t of [blocker, b, c, d]) go(t)
    // the train of four is refused at once and its first half waits for go-a: all four are marked suspect (the second half
    // turns unproven only if the first half is refused too)
    await until(() => a.landing?.cars === 2 && ran().length === 3)
    const second = world()
    const marks = riders.map((t) => second.engine.task(t.id)?.bisect)
    const group = marks[0]?.id ?? ''
    expect(group).toMatch(new RegExp(`^${a.id}@[0-9a-f]{7}$`))
    expect(marks).toEqual([
      { id: group, suspect: true },
      { id: group, suspect: true },
      { id: group, suspect: true },
      { id: group, suspect: true },
    ])
    go(a)
    expect((await Promise.all(asked)).map((r) => r.ok)).toEqual([true, true, true, true, false])
    expect(ts.map((t) => t.bisect)).toEqual([undefined, undefined, undefined, undefined, undefined])
  })

  test('main moves while a half goes on its gate run: nothing lands as a train, the head goes alone, and the search goes on with the marks it had', async () => {
    const { w, dir, blocker, riders, go, ran } = await trainWorld('bisect-moved', 4, '4', [4])
    const [a, b, c, d] = riders
    const asked = [w.engine.merge(blocker.id, { self: true })]
    await until(() => blocker.landing?.step === 'gate')
    for (const t of riders) asked.push(w.engine.merge(t.id, { self: true }))
    for (const t of [blocker, b, c, d]) go(t)
    // the train of four is refused at once; its first half (a and b) waits for go-a, and main moves on meanwhile
    await until(() => a.landing?.cars === 2)
    sh('git commit -q --allow-empty -m "main moves on"', dir)
    go(a)
    const said = await Promise.all(asked)
    expect(said.map((r) => r.ok)).toEqual([true, true, true, true, false])
    // a goes alone on the base as it is; what the first half said is lost with the base it ran on, so the three that are left
    // keep the marks they had (suspect) and are split: b alone, then c and d, each alone: the blocker, M, A, a, b, c, d
    expect(ran()).toEqual([blocker.id, a.id, a.id, a.id, b.id, c.id, d.id])
    const lines = decisions([a, b, c, d].map((t) => t.id))
    expect(lines).toContain(`shepherdr: ${a.id}'s merge train: main moved while its gate ran: ${a.id} goes alone`)
    expect(lines).toContain(`shepherdr: ${b.id}'s merge goes alone: the first half of ${b.id}, ${c.id}, ${d.id} is ${b.id}; ${c.id}, ${d.id} go alone after it`)
    // nothing landed as a train, and only d, whose change fails, was refused
    expect(lines.filter((l) => l.includes('went in'))).toEqual([])
    expect(w.engine.statusOf(d)).not.toBe('done')
  })

  test("a restart between the halves: the head finds its half's gate run again, the others take their places, and nobody skips a gate", async () => {
    const { w, dir, riders, space, go, ran } = await trainWorld('bisect-restart', 4, '4')
    const [a, b, c, d] = riders
    // the stack of the first half (a and b), built as the engine builds it: each squash commit on the one before, dated as
    // main's tip
    const at = sh('git rev-parse main', dir)
    const date = sh('git log -1 --format=%cI main', dir)
    let top = at
    for (const x of [a, b]) {
      const tree = sh(`git merge-tree --write-tree ${top} ${x.branch}`, dir).split('\n')[0]
      top = sh(`GIT_AUTHOR_DATE='${date}' GIT_COMMITTER_DATE='${date}' git commit-tree ${tree} -p ${top} -m '${x.id}: ${x.title}'`, dir)
    }
    // as a restart leaves it: the four of a refused train suspect, a at the top of its half's stack with its gate going on
    // by itself, and the others in line as they stood
    const { startGate } = await import('../server/live/engine/engine.ts')
    sh(`git checkout -q --detach ${top}`, wtOf(a))
    const group = { id: `${a.id}@${top.slice(0, 7)}`, suspect: true as const }
    for (const t of riders) t.bisect = group
    a.landing = { step: 'gate', at: 1, cars: 2 }
    a.gateRun = startGate(w.settings.get('merge.gate', space), wtOf(a), { SHEPHERDR_TASK: a.id, SHEPHERDR_BASE: 'main' }, join(process.env.SHEPHERDR_HOME ?? '', 'gates'), a.id, {
      head: top,
      tip: at,
      space,
      members: [a.id, b.id],
    })
    gatesStarted.push(a.gateRun.pid)
    b.landing = { step: 'queue', at: 2, behind: a.id, gate: true, train: a.id }
    c.landing = { step: 'queue', at: 3, behind: a.id, gate: true }
    d.landing = { step: 'queue', at: 4, behind: a.id, gate: true }
    await until(() => ran().length === 1, 20_000)
    // a while later: the stack is built again on the same tip, the first half found again, the second half waits as it did
    await Bun.sleep(1100)
    w.engine.resumeMerges()
    await until(() => a.landing?.step === 'gate' && a.landing.at > 1, 20_000)
    expect(w.engine.subOf(a)).toBe('Running the merge gate (a train of 2)')
    expect(w.engine.subOf(b)).toBe(`Going in with ${a.id}'s merge train`)
    expect(ran()).toEqual([a.id])
    for (const t of riders) go(t)
    await until(() => riders.every((t) => w.sent.some((x) => x.key === `${t.id}/Agent` && x.text.includes('Your merge went in'))))
    // the run a restart left went in for a and b; c and d, the suspect second half, were split: each its own gate
    expect(ran()).toEqual([a.id, c.id, d.id])
    expect(sh('git log --format=%s -n 5', dir).split('\n')).toEqual([`${d.id}: ${d.title}`, `${c.id}: ${c.title}`, `${b.id}: ${b.title}`, `${a.id}: ${a.title}`, 'init'])
    expect(riders.map((t) => [w.engine.statusOf(t), t.bisect, t.alone])).toEqual(riders.map(() => ['done', undefined, undefined]))
  })

  test('the rest of a refused train goes in together; tasks outside its group never ride with it, and it never rides with them', async () => {
    const { dir, ts, riders, more, ran, heads, merged } = await trainWorld('bisect-outside', 4, '4', [2])
    const [a, b, c, d] = riders
    const z1 = await more('Task 5', '5.txt')
    const z2 = await more('Task 6', '6.txt')
    // z1 and z2 wait behind a train that is full at four: the refused group's turns come before theirs
    const said = await merged([z1, z2])
    expect(said.map((r) => r.ok)).toEqual([true, true, false, true, true, true, true])
    // M, its first half (refused for b), a alone, b alone (refused), c and d together, z1 and z2 together
    expect(ran().slice(1)).toEqual([a.id, a.id, a.id, b.id, c.id, z1.id])
    const short = (ref: string | undefined) => sh(`git rev-parse --short=7 ${ref}`, dir)
    const lines = decisions([...ts, z1, z2].map((t) => t.id))
    expect(lines).toContain(
      `shepherdr: ${a.id}'s merge train: ${a.id}, ${b.id}, ${c.id}, ${d.id} (one gate run on ${heads()[1]}, main at ${short(ts[0].squash)}). Left out: ${z1.id} waits (the train is full at 4); ${z2.id} waits (the train is full at 4)`,
    )
    expect(lines).toContain(`shepherdr: ${c.id}'s merge train: ${c.id}, ${d.id} (one gate run on ${heads()[5]}, main at ${short(a.squash)}) (the rest of a refused train, tried together)`)
    expect(lines).toContain(`shepherdr: ${z1.id}'s merge train: ${z1.id}, ${z2.id} (one gate run on ${heads()[6]}, main at ${short(d.squash)})`)
    expect(sh('git log --format=%s -n 7', dir).split('\n')).toEqual([z2, z1, d, c, a, ts[0]].map((t) => `${t.id}: ${t.title}`).concat('init'))
  })

  test("a task that is not marked, taking its turn between the group's, says which of them are held and why, and goes on its own", async () => {
    const { w, dir, ts, blocker, riders, more, go, ran } = await trainWorld('bisect-held', 4, '4', [2])
    const [a, b, c, d] = riders
    // z's agent is at work, so it cannot ride, and its turn comes between a's and b's
    const z = await more('Task 5', '5.txt')
    w.agentIs(`${z.id}/Agent`, 'working')
    const asked = [w.engine.merge(blocker.id, { self: true })]
    await until(() => blocker.landing?.step === 'gate')
    for (const t of [a, z, b, c, d]) asked.push(w.engine.merge(t.id, { self: true }))
    for (const t of [...ts, z]) go(t)
    const said = await Promise.all(asked)
    // the blocker, a, z, b (refused), c, d
    expect(said.map((r) => r.ok)).toEqual([true, true, true, false, true, true])
    // M and its first half, a alone, z alone (nothing could ride with it), b alone, and c and d together
    expect(ran().slice(1)).toEqual([a.id, a.id, a.id, z.id, b.id, c.id])
    expect(decisions([...ts, z].map((t) => t.id))).toContain(
      `shepherdr: ${z.id}'s merge goes alone: ${b.id} is marked alone (its turn after a refused train); ${c.id} is held with the rest of a refused train (it goes in with them, or alone); ${d.id} is held with the rest of a refused train (it goes in with them, or alone)`,
    )
    expect(sh('git log --format=%s -n 5', dir).split('\n')).toEqual(
      [d, c, z, a, ts[0]]
        .map((t) => `${t.id}: ${t.title}`)
        .concat('init')
        .slice(0, 5),
    )
  })
})
