// A space's own cap (space.maxTasks), inside the machine's limit: a task starts only when the machine and its space both
// have room. A space at its cap holds its next task as Waiting for a free slot of its space, and no other space waits
// for it; a first in line passes neither limit (engine-world.ts).
import { describe, expect, test } from 'bun:test'
import { placeId, repo, started, until, world } from './engine-world.ts'

/** a fresh world with nothing from earlier tests; the machine's limits as given, its spacing off unless set */
function fresh(limits: Record<string, string> = {}) {
  const w = world()
  w.engine.tasks.splice(0)
  for (const k of ['machine.maxTasks', 'machine.startLoad', 'machine.startMemory', 'machine.startEvery', 'machine.startPressure']) w.settings.set(k, null)
  w.settings.set('machine.startEvery', '0')
  for (const [k, v] of Object.entries(limits)) expect(w.settings.set(k, v).ok).toBe(true)
  return w
}

/** a space's own cap, set on this machine for that space alone */
const cap = (w: ReturnType<typeof world>, space: string, value: string | null) => expect(w.settings.set('space.maxTasks', value, { space }).ok).toBe(true)

const startedOf = (w: ReturnType<typeof world>, id: string) => w.started.some((s) => s.key === `${id}/Agent`)

describe("a space's own cap inside the machine's limit", () => {
  test("a space at its cap holds its next task as Waiting for a free slot of its space; another space's task starts in the same pass", async () => {
    const w = fresh({ 'machine.maxTasks': '3' })
    const a = await started(w, repo(), 'cap-pass-a', 'A1', 'Add a1.txt.')
    cap(w, a.p.name, '1')
    w.brief(a.key)
    // the machine has room, its space does not: the space is the reason
    const a2 = w.engine.add({ project: a.p.name, title: 'A2', desc: 'Add a2.txt.', by: 'test' })
    expect(a2.held?.why).toBe('space')
    expect(w.engine.subOf(a2)).toBe(`Waiting for a free slot of ${a.p.name}`)
    expect(w.posted.some((x) => x.key === `${a2.id}/Agent` && x.id.startsWith('held:') && x.card?.text === `waiting for a free slot of ${a.p.name} (1 of 1 of its tasks working)`)).toBe(true)
    expect(startedOf(w, a2.id)).toBe(false)
    // the machine fills with two tasks of other spaces, so the next one of another space is held by the machine
    const x = await started(w, repo(), 'cap-pass-x', 'X1', 'Add x1.txt.')
    const y = await started(w, repo(), 'cap-pass-y', 'Y1', 'Add y1.txt.')
    w.brief(x.key)
    w.brief(y.key)
    const b = w.engine.add({ project: x.p.name, title: 'X2', desc: 'Add x2.txt.', by: 'test' })
    expect(b.held?.why).toBe('slots')
    // y is done: the machine has a slot. The space-capped task waits for its own space; the other space's starts
    await w.engine.done(y.t.id, 'Nothing to change.')
    w.agentIs(y.key, 'idle')
    await until(() => startedOf(w, b.id))
    expect(startedOf(w, a2.id)).toBe(false)
    // the machine is full again (a, x, b): a2 waits for the machine too, as its line says
    expect(w.engine.room(a2)).toEqual({ why: 'slots' })
    // x is done: the machine has a slot, its space still has none, so the reason is the space's again
    await w.engine.done(x.t.id, 'Nothing to change.')
    w.agentIs(x.key, 'idle')
    await until(() => a2.held?.why === 'space')
    expect(w.engine.subOf(a2)).toBe(`Waiting for a free slot of ${a.p.name}`)
    expect(startedOf(w, a2.id)).toBe(false)
  })

  test("when one of the capped space's tasks ends, its held task starts", async () => {
    const w = fresh()
    const a = await started(w, repo(), 'cap-end', 'A1', 'Add a1.txt.')
    cap(w, a.p.name, '1')
    w.brief(a.key)
    const a2 = w.engine.add({ project: a.p.name, title: 'A2', desc: 'Add a2.txt.', by: 'test' })
    expect(w.engine.statusOf(a2)).toBe('queued')
    expect(w.engine.subOf(a2)).toBe(`Waiting for a free slot of ${a.p.name}`)
    expect(startedOf(w, a2.id)).toBe(false)
    await w.engine.done(a.t.id, 'Nothing to change.')
    w.agentIs(a.key, 'idle')
    await until(() => startedOf(w, a2.id))
    expect(a2.held).toBeUndefined()
    expect(w.posted.some((x) => x.key === `${a2.id}/Agent` && x.id.startsWith('go:') && x.card?.text === 'started: a slot of its space is free')).toBe(true)
  })

  test("the machine's limit still wins when it is lower than the space's cap: the reason is a slot of the machine", async () => {
    const w = fresh({ 'machine.maxTasks': '1' })
    const a = await started(w, repo(), 'cap-machine', 'A1', 'Add a1.txt.')
    cap(w, a.p.name, '5')
    w.brief(a.key)
    const a2 = w.engine.add({ project: a.p.name, title: 'A2', desc: 'Add a2.txt.', by: 'test' })
    expect(a2.held?.why).toBe('slots')
    expect(w.engine.subOf(a2)).toBe('Waiting for a free slot')
    expect(w.engine.room(a2)).toEqual({ why: 'slots' })
  })

  test('off, at every level, is the machine\'s limit alone: two tasks of one space work at once on a machine of two', async () => {
    const w = fresh({ 'machine.maxTasks': '2' })
    const a = await started(w, repo(), 'cap-off', 'A1', 'Add a1.txt.')
    expect(w.engine.spaceCap(a.t)).toBeUndefined()
    w.brief(a.key)
    const a2 = w.engine.add({ project: a.p.name, title: 'A2', desc: 'Add a2.txt.', by: 'test' })
    await until(() => startedOf(w, a2.id))
    expect(a2.held).toBeUndefined()
    // a cap set, then off again: the same
    cap(w, a.p.name, '1')
    expect(w.engine.spaceCap(a.t)).toEqual({ space: a.p.name, shown: a.p.name, max: 1, working: 2 })
    cap(w, a.p.name, 'off')
    expect(w.engine.spaceCap(a.t)).toBeUndefined()
    expect(w.engine.room(a.t)).toEqual({ why: 'slots' })
  })

  test("a first in line waits for its space's cap too: it starts when the space has a slot, ahead of the older ones", async () => {
    const w = fresh({ 'machine.maxTasks': '10' })
    const a = await started(w, repo(), 'cap-prio', 'A1', 'Add a1.txt.')
    cap(w, a.p.name, '1')
    w.brief(a.key)
    const older = w.engine.add({ project: a.p.name, title: 'Older', desc: 'Add b.txt.', by: 'test' })
    const fix = w.engine.add({ project: a.p.name, title: 'Fix main', desc: 'Fix it.', by: 'test', priority: true })
    expect(fix.held?.why).toBe('space')
    expect(w.engine.subOf(fix)).toBe(`First in line · Waiting for a free slot of ${a.p.name}`)
    expect(w.engine.heldTasks().map((t) => t.id)).toEqual([fix.id, older.id])
    // the one at work is done: the first in line takes the slot, the older one keeps waiting
    await w.engine.done(a.t.id, 'Nothing to change.')
    w.agentIs(a.key, 'idle')
    await until(() => startedOf(w, fix.id))
    expect(startedOf(w, older.id)).toBe(false)
    expect(older.held?.why).toBe('space')
  })

  test('a space cap set on another space does not hold this one, and Everywhere sets every space without its own', async () => {
    const w = fresh({ 'machine.maxTasks': '10' })
    const a = await started(w, repo(), 'cap-other', 'A1', 'Add a1.txt.')
    const b = await started(w, repo(), 'cap-other-b', 'B1', 'Add b1.txt.')
    cap(w, a.p.name, '1')
    expect(w.engine.spaceCap(b.t)).toBeUndefined()
    expect(w.engine.room(b.t)).toEqual({})
    // Everywhere's 1 caps the space that has none of its own, not a space with its own value
    expect(w.settings.set('space.maxTasks', '1', 'all').ok).toBe(true)
    expect(w.engine.spaceCap(b.t)).toEqual({ space: b.p.name, shown: b.p.name, max: 1, working: 1 })
    expect(w.engine.spaceCap(a.t)).toEqual({ space: a.p.name, shown: a.p.name, max: 1, working: 1 })
    cap(w, a.p.name, '4')
    expect(w.engine.spaceCap(a.t)).toEqual({ space: a.p.name, shown: a.p.name, max: 4, working: 1 })
  })
})

describe('a renamed space: its cap, held line and card name it as it shows; its settings keep the name it was added under', () => {
  test('a space added as site-cap and renamed lyvora-site: the cap holds, and the held line and the card say lyvora-site', async () => {
    const w = fresh({ 'machine.maxTasks': '3' })
    const a = await started(w, repo(), 'site-cap', 'A1', 'Add a1.txt.')
    w.places.rename(placeId.space(a.p.name), 'lyvora-site')
    expect(w.places.shownName(a.p.name)).toBe('lyvora-site')
    cap(w, a.p.name, '1')
    w.brief(a.key)
    const a2 = w.engine.add({ project: a.p.name, title: 'A2', desc: 'Add a2.txt.', by: 'test' })
    expect(a2.held?.why).toBe('space')
    expect(w.engine.subOf(a2)).toBe('Waiting for a free slot of lyvora-site')
    expect(w.posted.some((x) => x.key === `${a2.id}/Agent` && x.id.startsWith('held:') && x.card?.text === 'waiting for a free slot of lyvora-site (1 of 1 of its tasks working)')).toBe(true)
    expect(startedOf(w, a2.id)).toBe(false)
    // the cap is found by the name it was added under: it is that space's, and not a space called lyvora-site's
    expect(w.engine.spaceCap(a.t)).toEqual({ space: a.p.name, shown: 'lyvora-site', max: 1, working: 1 })
    expect(w.settings.get('space.maxTasks', a.p.name)).toBe('1')
    expect(w.settings.get('space.maxTasks', 'lyvora-site')).toBe('off')
    expect(w.engine.room(a2)).toEqual({ why: 'space' })
    // its task ends: the held one starts, as before the rename
    await w.engine.done(a.t.id, 'Nothing to change.')
    w.agentIs(a.key, 'idle')
    await until(() => startedOf(w, a2.id))
    expect(a2.held).toBeUndefined()
  })

  test('a space with no name of its own shows the name it was added under, and so does a name no space has', async () => {
    const w = fresh()
    const a = await started(w, repo(), 'plain-cap', 'A1', 'Add a1.txt.')
    expect(w.places.shownName(a.p.name)).toBe(a.p.name)
    expect(w.places.shownName('nowhere')).toBe('nowhere')
  })
})
