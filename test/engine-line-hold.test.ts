// Holding the merge line (engine.lineHold, lineRelease, line; merge.ts, line-hold.ts): a hold taken while a gate runs waits for
// it and then holds, merges asked for meanwhile queue in order and do not start, a release or an expiry starts the next one, a
// restart keeps the hold and its expiry, and a train does not form under one. Real git, the engine's own world (train-world.ts).
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { trainLog, trainWorld } from './train-world.ts'
import { sh, until, type world } from './engine-world.ts'
import { tmp } from './tmp.ts'

setDefaultTimeout(120_000)

const { lines, decisions } = trainLog()

const who = { by: 'you (terminal)', why: 'land the hotfix' }

/** the space a test world made, as the engine's line reads it */
const spaceOf = (w: ReturnType<typeof world>, name: string) => {
  const p = w.places.byName(name)
  if (!p) throw new Error(`no space ${name}`)
  return p
}

describe('holding the merge line', () => {
  test('a hold taken while a gate runs waits for it and then holds; merges asked for meanwhile queue in order and start nothing; a release starts the next one', async () => {
    const { w, dir, ts, blocker, riders, space, go, ran } = await trainWorld('hold-line', 2, 'off')
    const p = spaceOf(w, space)
    const [a, b] = riders
    const first = w.engine.merge(blocker.id, { self: true })
    await until(() => blocker.landing?.step === 'gate')
    // the line as it stands: the blocker's gate runs, nobody waits, nothing is held
    expect(w.engine.line(p)).toMatchObject({ name: space, base: 'main', running: { id: blocker.id, step: 'gate', train: [blocker.id] }, waiting: [], checking: [], hold: undefined })
    expect(w.engine.line(p).running?.since).toBeGreaterThan(0)
    // the hold is asked for: it waits for the gate, and reserves the next turn
    let held = false
    const holding = w.engine.lineHold(p, who, 600_000, 30_000).then((r) => {
      held = true
      return r
    })
    expect(w.engine.line(p).hold).toMatchObject({ state: 'waiting', by: who.by, why: who.why })
    const askedA = w.engine.merge(a.id, { self: true })
    await until(() => a.landing?.step === 'queue')
    expect(w.engine.subOf(a)).toBe(`Merge line about to be held by ${who.by}: ${who.why}`)
    await Bun.sleep(100)
    expect(held).toBe(false)
    // the gate ends: its merge lands, and then the hold is in effect, with the base's tip at that moment
    go(blocker)
    expect((await first).ok).toBe(true)
    const r = await holding
    expect(r).toMatchObject({ ok: true, after: blocker.id })
    expect(r.ok && r.tip).toBe(sh('git rev-parse main', dir))
    expect(sh('git log -1 --format=%s', dir)).toBe(`${blocker.id}: ${blocker.title}`)
    // more merges are asked for: they queue behind the hold, in the order they asked, and none starts its turn
    const askedB = w.engine.merge(b.id, { self: true })
    await until(() => b.landing?.step === 'queue')
    for (const t of ts) go(t)
    await Bun.sleep(400)
    expect(ran()).toEqual([blocker.id])
    expect(sh('git rev-parse main', dir)).toBe(r.ok ? r.tip : '')
    for (const t of [a, b]) expect(w.engine.subOf(t)).toMatch(new RegExp(`^Merge line held by ${who.by.replace(/[()]/g, '\\$&')} until \\d\\d:\\d\\d: ${who.why}$`))
    expect(w.engine.line(p)).toMatchObject({ running: undefined, waiting: [a.id, b.id], hold: { state: 'held', by: who.by, why: who.why } })
    // released: the next merge in line takes its turn, then the one behind it
    expect(w.engine.lineRelease(p, who.by)).toMatchObject({ state: 'held', by: who.by, why: who.why })
    expect((await Promise.all([askedA, askedB])).map((x) => x.ok)).toEqual([true, true])
    expect(ran()).toEqual([blocker.id, a.id, b.id])
    expect(sh('git log --format=%s -n 3', dir).split('\n')).toEqual([`${b.id}: ${b.title}`, `${a.id}: ${a.title}`, `${blocker.id}: ${blocker.title}`])
    expect(lines().filter((l) => l.includes('line hold on'))).toEqual([
      `shepherdr: line hold on ${space}: ${who.by} waits for the merge in flight to end, and keeps the next turn from starting (${who.why})`,
      expect.stringMatching(new RegExp(`^shepherdr: line hold on ${space}: .* holds the merge line until \\d\\d:\\d\\d \\(${who.why}\\)$`)),
      expect.stringMatching(new RegExp(`^shepherdr: line hold on ${space} released by ${who.by.replace(/[()]/g, '\\$&')} `)),
    ])
  })

  test('a merge asked for under a hold says so when its caller stops waiting, and is told how it went once the line is released', async () => {
    const { w, space, blocker, key, go } = await trainWorld('hold-late', 0, 'off').then((x) => ({ ...x, key: `${x.blocker.id}/Agent` }))
    const p = spaceOf(w, space)
    expect((await w.engine.lineHold(p, who, 600_000, 30_000)).ok).toBe(true)
    w.engine.mergeDeadline = 200
    go(blocker)
    const r = await w.engine.merge(blocker.id, { self: true })
    expect(r.ok).toBe(false)
    expect(r.error).toContain(`${blocker.id}'s merge waits in line: the merge line is held by ${who.by} until`)
    expect(r.error).toContain(`${who.why}. Shepherdr goes on with it and tells you here how it went`)
    w.engine.lineRelease(p, who.by)
    await until(() => w.sent.some((x) => x.key === key && x.text.includes('Your merge went in')), 30_000)
  })

  test('a hold on an idle line returns at once with the base branch tip, and holds until released', async () => {
    const { w, dir, space, blocker, go, ran } = await trainWorld('hold-idle', 0, 'off')
    const p = spaceOf(w, space)
    const r = await w.engine.lineHold(p, who, 600_000, 30_000)
    expect(r).toMatchObject({ ok: true, tip: sh('git rev-parse main', dir) })
    expect(r.ok && r.after).toBeUndefined()
    expect(r.ok && r.hold.until - r.hold.at).toBe(600_000)
    expect(w.engine.line(p).hold).toMatchObject({ state: 'held', by: who.by })
    // the blocker's merge asked for now waits for the release
    go(blocker)
    const asked = w.engine.merge(blocker.id, { self: true })
    await Bun.sleep(300)
    expect(ran()).toEqual([])
    w.engine.lineRelease(p, who.by)
    expect((await asked).ok).toBe(true)
    expect(ran()).toEqual([blocker.id])
  })

  test('a second hold says who holds the line, until when and why, and a line that is not held says so when released', async () => {
    const { w, space } = await trainWorld('hold-twice', 0, 'off')
    const p = spaceOf(w, space)
    expect(w.engine.lineRelease(p, who.by)).toBeUndefined()
    const first = await w.engine.lineHold(p, who, 600_000, 30_000)
    expect(first.ok).toBe(true)
    const second = await w.engine.lineHold(p, { by: 'Atena', why: 'another fix' }, 600_000, 30_000)
    expect(second.ok).toBe(false)
    expect(!second.ok && second.error).toMatch(new RegExp(`^${space}'s merge line is already held by ${who.by.replace(/[()]/g, '\\$&')} until \\d\\d:\\d\\d: ${who.why}\\. Release it first`))
    expect(w.engine.lineRelease(p, who.by)).toMatchObject({ state: 'held' })
    expect(w.engine.lineRelease(p, who.by)).toBeUndefined()
  })

  test('it ends by itself at its time: the next merge goes and the expiry is in the server log', async () => {
    const { w, space, blocker, go, ran } = await trainWorld('hold-expiry', 0, 'off')
    const p = spaceOf(w, space)
    expect((await w.engine.lineHold(p, who, 700, 30_000)).ok).toBe(true)
    go(blocker)
    const asked = w.engine.merge(blocker.id, { self: true })
    await until(() => blocker.landing?.step === 'queue')
    await Bun.sleep(200)
    expect(ran()).toEqual([])
    expect((await asked).ok).toBe(true)
    expect(ran()).toEqual([blocker.id])
    expect(w.engine.line(p).hold).toBeUndefined()
    expect(lines().filter((l) => l.includes('expired'))).toEqual([
      expect.stringMatching(
        new RegExp(`^shepherdr: line hold on ${space} expired at \\d\\d:\\d\\d \\(held by ${who.by.replace(/[()]/g, '\\$&')} since \\d\\d:\\d\\d: ${who.why}\\): the line goes on$`),
      ),
    ])
  })

  test('a wait for the merge in flight that does not end in time leaves no hold behind, and the line goes on as it was', async () => {
    const { w, ts, space, blocker, riders, go, ran } = await trainWorld('hold-bound', 1, 'off')
    const p = spaceOf(w, space)
    const [a] = riders
    const first = w.engine.merge(blocker.id, { self: true })
    await until(() => blocker.landing?.step === 'gate')
    const r = await w.engine.lineHold(p, who, 600_000, 300)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('did not end in 1 s')
    expect(w.engine.line(p).hold).toBeUndefined()
    expect(lines().some((l) => l.includes('gave up waiting for the merge in flight to end'))).toBe(true)
    // the next merge in line is not held back by it
    const asked = w.engine.merge(a.id, { self: true })
    await until(() => a.landing?.step === 'queue')
    for (const t of ts) go(t)
    expect((await Promise.all([first, asked])).map((x) => x.ok)).toEqual([true, true])
    expect(ran()).toEqual([blocker.id, a.id])
  })

  test('releasing a hold that still waits for the merge in flight cancels it: nothing is held, and the next turn is not kept back', async () => {
    const { w, ts, space, blocker, riders, go } = await trainWorld('hold-cancel', 1, 'off')
    const p = spaceOf(w, space)
    const first = w.engine.merge(blocker.id, { self: true })
    await until(() => blocker.landing?.step === 'gate')
    const holding = w.engine.lineHold(p, who, 600_000, 30_000)
    expect(w.engine.lineRelease(p, 'Atena')).toMatchObject({ state: 'waiting', by: who.by })
    const r = await holding
    expect(!r.ok && r.error).toContain('released the wait')
    const asked = w.engine.merge(riders[0].id, { self: true })
    for (const t of ts) go(t)
    expect((await Promise.all([first, asked])).map((x) => x.ok)).toEqual([true, true])
  })

  test('a command that goes away while its hold waits for the merge in flight takes the reservation with it: nothing is held, the log says so, and the next turn is not kept back', async () => {
    const { w, ts, space, blocker, riders, go, ran } = await trainWorld('hold-gone', 1, 'off')
    const p = spaceOf(w, space)
    const first = w.engine.merge(blocker.id, { self: true })
    await until(() => blocker.landing?.step === 'gate')
    const gone = new AbortController()
    const holding = w.engine.lineHold(p, who, 600_000, 30_000, gone.signal)
    // asked for while it waits: the next merge queues behind the reservation, as it would behind a hold
    const asked = w.engine.merge(riders[0].id, { self: true })
    await until(() => riders[0].landing?.step === 'queue')
    expect(w.engine.line(p).hold).toMatchObject({ state: 'waiting', by: who.by })
    expect(w.engine.subOf(riders[0])).toBe(`Merge line about to be held by ${who.by}: ${who.why}`)
    gone.abort()
    const r = await holding
    expect(!r.ok && r.error).toContain('is gone: nothing is held')
    expect(w.engine.line(p).hold).toBeUndefined()
    expect(lines().filter((l) => l.includes('went away'))).toEqual([
      `shepherdr: line hold on ${space}: ${who.by}'s command went away while the hold waited for the merge in flight to end: nothing is held`,
    ])
    // the end of the merge in flight holds nothing, and the merge that queued goes on
    for (const t of ts) go(t)
    expect((await Promise.all([first, asked])).map((x) => x.ok)).toEqual([true, true])
    expect(ran()).toEqual([blocker.id, riders[0].id])
    expect(w.engine.line(p).hold).toBeUndefined()
  })

  test('a command that is gone already reserves nothing; one that goes away after the hold took effect leaves it held', async () => {
    const { w, space } = await trainWorld('hold-gone-late', 0, 'off')
    const p = spaceOf(w, space)
    const before = new AbortController()
    before.abort()
    const none = await w.engine.lineHold(p, who, 600_000, 30_000, before.signal)
    expect(!none.ok && none.error).toBe(`The command that asked to hold ${space}'s merge line is gone: nothing is held.`)
    expect(w.engine.line(p).hold).toBeUndefined()
    const gone = new AbortController()
    const held = await w.engine.lineHold(p, who, 600_000, 30_000, gone.signal)
    expect(held.ok).toBe(true)
    gone.abort()
    expect(w.engine.line(p).hold).toMatchObject({ state: 'held', by: who.by })
    expect(lines().filter((l) => l.includes('went away'))).toEqual([])
    expect(w.engine.lineRelease(p, who.by)).toMatchObject({ state: 'held' })
  })

  test('a merge that went in with a train on the turn a hold waited for has nothing left to wait for: its own request ends under the hold', async () => {
    const { w, dir, ts, blocker, riders, space, go, ran } = await trainWorld('hold-rider', 2, '2')
    const p = spaceOf(w, space)
    const [head, rider] = riders
    const first = w.engine.merge(blocker.id, { self: true })
    await until(() => blocker.landing?.step === 'gate')
    const askedHead = w.engine.merge(head.id, { self: true })
    await until(() => head.landing?.step === 'queue')
    const askedRider = w.engine.merge(rider.id, { self: true })
    await until(() => rider.landing?.step === 'queue')
    go(blocker)
    await first
    // the head's turn forms a train with the rider: the line shows it, and the hold waits for that turn
    await until(() => head.landing?.step === 'gate' && head.landing.cars === 2)
    expect(w.engine.line(p).running).toMatchObject({ id: head.id, step: 'gate', train: [head.id, rider.id] })
    expect(w.engine.line(p).waiting).toEqual([])
    const holding = w.engine.lineHold(p, who, 600_000, 30_000)
    go(head)
    // both went in on one gate run, the hold is in effect, and the rider's own request is answered without waiting for it
    expect((await askedHead).ok).toBe(true)
    expect((await holding).ok).toBe(true)
    expect(await askedRider).toMatchObject({ ok: true, note: `it went in with ${head.id}'s merge train` })
    expect(ran()).toEqual([blocker.id, head.id])
    expect(sh('git log --format=%s -n 3', dir).split('\n')).toEqual([`${rider.id}: ${rider.title}`, `${head.id}: ${head.title}`, `${blocker.id}: ${blocker.title}`])
    expect(w.engine.line(p).hold).toMatchObject({ state: 'held' })
    w.engine.lineRelease(p, who.by)
    expect(ts.length).toBe(3)
  })

  test('a train does not form under a hold: its members queue, and after the release they go in together on one gate run', async () => {
    const { w, ts, blocker, riders, space, go, ran } = await trainWorld('hold-train', 3, '3')
    const p = spaceOf(w, space)
    const first = w.engine.merge(blocker.id, { self: true })
    await until(() => blocker.landing?.step === 'gate')
    const holding = w.engine.lineHold(p, who, 600_000, 30_000)
    const asked = riders.map((t) => w.engine.merge(t.id, { self: true }))
    for (const t of riders) await until(() => t.landing?.step === 'queue')
    for (const t of ts) go(t)
    expect((await first).ok).toBe(true)
    expect((await holding).ok).toBe(true)
    await Bun.sleep(400)
    // nothing started its turn: no gate, and no train decision
    expect(ran()).toEqual([blocker.id])
    expect(decisions(ts.map((t) => t.id))).toEqual([])
    w.engine.lineRelease(p, who.by)
    expect((await Promise.all(asked)).map((r) => r.ok)).toEqual([true, true, true])
    expect(ran()).toEqual([blocker.id, riders[0].id])
    expect(decisions(ts.map((t) => t.id))[0]).toContain(`${riders[0].id}'s merge train: ${riders.map((t) => t.id).join(', ')}`)
  })

  test('merges in their pre-flight are on the line view and hold nobody up: they queue once they pass, under a hold as ever', async () => {
    const dir = tmp('hold-pre')
    const world2 = await trainWorld('hold-checking', 1, 'off', [], undefined, `i=0; while [ ! -f ${dir}/go-$SHEPHERDR_TASK ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done`)
    const { w, ts, blocker, riders, space, go } = world2
    const p = spaceOf(w, space)
    writeFileSync(join(dir, `go-${blocker.id}`), 'go\n')
    const first = w.engine.merge(blocker.id, { self: true })
    await until(() => blocker.landing?.step === 'gate')
    const [a] = riders
    const asked = w.engine.merge(a.id, { self: true })
    await until(() => a.landing?.pre === true)
    expect(w.engine.line(p)).toMatchObject({ running: { id: blocker.id }, waiting: [], checking: [a.id] })
    writeFileSync(join(dir, `go-${a.id}`), 'go\n')
    await until(() => a.landing?.step === 'queue')
    expect(w.engine.line(p)).toMatchObject({ waiting: [a.id], checking: [] })
    for (const t of ts) go(t)
    expect((await Promise.all([first, asked])).map((r) => r.ok)).toEqual([true, true])
    expect(readFileSync(join(dir, `go-${a.id}`), 'utf8')).toBe('go\n')
  })
})
