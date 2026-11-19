// Room on the machine: new tasks, and tasks told to go, wait as Queued while the machine has its max tasks working or
// is too loaded, and start by themselves once there's room, oldest first (engine-world.ts).
import { describe, expect, test } from 'bun:test'
import { writeJson, placeId, repo, sh, started, until, world } from './engine-world.ts'

/** a fresh world with nothing from earlier tests, its machine's limits set */
function fresh(limits: Record<string, string>) {
  const w = world()
  w.engine.tasks.splice(0)
  for (const k of ['machine.maxTasks', 'machine.startLoad', 'machine.startMemory', 'machine.startEvery', 'machine.startPressure']) w.settings.set(k, null)
  for (const [k, v] of Object.entries(limits)) expect(w.settings.set(k, v).ok).toBe(true)
  return w
}

describe('room on the machine', () => {
  test('older waiting tasks keep their target across a settings change and two restarts', async () => {
    const w = fresh({ 'machine.maxTasks': '1' })
    const dir = repo()
    sh('git branch develop', dir)
    const p = await w.places.add(dir, 'legacy-base')
    writeJson('tasks.json', { next: { [p.key]: 1 }, tasks: [{ id: `${p.key}-1`, n: 1, project: placeId.space(p.name), title: 'Old queued task', desc: '', by: 'test', created: Date.now(), updated: Date.now(), told: 'queued', held: { why: 'slots', since: Date.now() } }] })
    const first = world()
    expect(first.engine.task(`${p.key}-1`)!.base).toBe('main')
    await first.places.setBase(p.name, 'develop')
    const second = world()
    expect(second.engine.task(`${p.key}-1`)!.base).toBe('main')
    expect(second.places.byName(p.name)!.base).toBe('develop')
  })

  test('space changes affect new tasks only, including tasks waiting for room; bad settings leave the old target', async () => {
    const w = fresh({ 'machine.maxTasks': '1' })
    const dir = repo()
    sh('git branch develop && git branch feature/topic', dir)
    const a = await started(w, dir, 'base-snapshot')
    w.brief(a.key)
    const b = w.engine.add({ project: a.p.name, title: 'Waiting', by: 'test' })
    expect(b.base).toBe('main')
    await w.places.setBase(a.p.name, 'develop')
    expect(a.t.base).toBe('main')
    expect(b.base).toBe('main')
    const c = w.engine.add({ project: a.p.name, title: 'New default', by: 'test' })
    const d = w.engine.add({ project: a.p.name, title: 'Override', base: 'feature/topic', by: 'test' })
    expect(c.base).toBe('develop')
    expect(d.base).toBe('feature/topic')
    await expect(w.places.setBase(a.p.name, 'missing')).rejects.toThrow('No local branch missing')
    await expect(w.places.setBase(a.p.name, '--all')).rejects.toThrow('Choose a branch name')
    expect(a.p.base).toBe('develop')
    expect(sh('git branch --show-current', dir)).toBe('main')
    await w.engine.done(a.t.id, 'Nothing to change.')
    w.agentIs(a.key, 'idle')
    await until(() => w.started.some((s) => s.key === `${b.id}/Agent`))
    expect(b.base).toBe('main')
    expect(w.started.find((s) => s.key === `${b.id}/Agent`)!.system).toContain('(from main)')
  })

  test('past the max working, a new task waits as Queued with no agent yet; one waiting on you keeps its slot, and the next starts once it is done', async () => {
    const w = fresh({ 'machine.maxTasks': '1' })
    const a = await started(w, repo(), 'room-a', 'First', 'Add a.txt.')
    w.brief(a.key)
    expect(w.engine.working()).toBe(1)
    const b = w.engine.add({ project: a.p.name, title: 'Second', desc: 'Add b.txt.', by: 'test' })
    const c = w.engine.add({ project: a.p.name, title: 'Third', desc: 'Add c.txt.', by: 'test' })
    expect(w.engine.statusOf(b)).toBe('queued')
    expect(w.engine.subOf(b)).toBe('Waiting for a free slot')
    expect(w.engine.view(b).after).toBeUndefined()
    // no worktree or agent while it waits, and no news that it needs you
    expect(b.worktree).toBeUndefined()
    expect(w.started.some((s) => s.key === `${b.id}/Agent`)).toBe(false)
    expect(w.posted.some((x) => x.key === `${b.id}/Agent` && x.id.startsWith('held:'))).toBe(true)
    expect(w.news.some((n) => n.includes(`${b.id} needs you`))).toBe(false)
    // the first one waits on you now: it keeps its slot (your answer takes it back to work within the limit), so the held
    // ones still wait, and the line says why
    w.agentIs(a.key, 'idle')
    await Bun.sleep(50)
    expect(w.engine.statusOf(a.t)).toBe('need')
    expect(w.started.some((s) => s.key === `${b.id}/Agent`)).toBe(false)
    expect(w.engine.slotsWords()).toBe('1 of 1 working, 1 of them waiting on you')
    // it reports done: its slot is free, and the oldest held one starts, on its brief
    await w.engine.done(a.t.id, 'Nothing to change.')
    w.agentIs(a.key, 'idle')
    await until(() => w.started.some((s) => s.key === `${b.id}/Agent`))
    expect(w.started.find((s) => s.key === `${b.id}/Agent`)!.first).toStartWith('Second\n\nAdd b.txt.')
    expect(w.posted.some((x) => x.key === `${b.id}/Agent` && x.id.startsWith('go:'))).toBe(true)
    // the next waits for b's slot
    expect(w.engine.statusOf(c)).toBe('queued')
    expect(c.worktree).toBeUndefined()
  })

  test("a task waiting on you keeps its slot, so answering it never goes past the limit; one cut off for good holds none", async () => {
    const w = fresh({ 'machine.maxTasks': '2' })
    const a = await started(w, repo(), 'room-wait', 'First', 'Add a.txt.')
    w.brief(a.key)
    const b = w.engine.add({ project: a.p.name, title: 'Second', desc: 'Add b.txt.', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${b.id}/Agent`))
    w.brief(`${b.id}/Agent`)
    // a asks you something: it waits on you, and keeps its slot, so a new task waits
    w.agentIs(a.key, 'blocked')
    expect(w.engine.statusOf(a.t)).toBe('need')
    const c = w.engine.add({ project: a.p.name, title: 'Third', desc: 'Add c.txt.', by: 'test' })
    expect(w.engine.statusOf(c)).toBe('queued')
    expect(w.engine.slotsWords()).toBe('2 of 2 working, 1 of them waiting on you')
    expect(w.engine.waitingOnYou()).toBe(1)
    // you answer: back to work, two of two, never three
    w.agentIs(a.key, 'working')
    await Bun.sleep(50)
    expect(w.engine.working()).toBe(2)
    expect(w.started.some((s) => s.key === `${c.id}/Agent`)).toBe(false)
    // cut off for good by its provider: the way back brings it at a free slot, so meanwhile it holds none
    w.engine.retry = (k: string) => (k === a.key ? { cut: 'x', tries: 1, reason: 'Out of allowance', words: 'out', over: true, lasting: true } : undefined)
    w.agentIs(a.key, 'idle')
    await until(() => w.started.some((s) => s.key === `${c.id}/Agent`))
    expect(w.engine.slotsWords()).toBe('2 of 2 working')
  })

  test('a task for later reads its brief at once: only work waits for room', async () => {
    const w = fresh({ 'machine.maxTasks': '1' })
    const a = await started(w, repo(), 'room-later', 'First', 'Add a.txt.')
    w.brief(a.key)
    const b = w.engine.add({ project: a.p.name, title: 'Later', desc: 'Add b.txt.', by: 'test', later: true })
    expect(b.held).toBeUndefined()
    await until(() => w.started.some((s) => s.key === `${b.id}/Agent`))
  })

  test("a queued task's go waits for room; a coordinator's go to a To do task waits too, yours goes in at once", async () => {
    const w = fresh({ 'machine.maxTasks': '1' })
    const a = await started(w, repo(), 'room-go', 'First', 'Add a.txt.')
    w.brief(a.key)
    const b = w.engine.add({ project: a.p.name, title: 'After', desc: 'Add b.txt.', by: 'test', after: [a.t.id] })
    const bkey = `${b.id}/Agent`
    // it waits with no agent
    expect(w.started.some((s) => s.key === bkey)).toBe(false)
    // a later for-later task, already started and waiting for its go
    const t = w.engine.add({ project: a.p.name, title: 'Saved', desc: 'Add t.txt.', by: 'test', later: true })
    const tkey = `${t.id}/Agent`
    await until(() => w.started.some((s) => s.key === tkey))
    w.engine.todo(t.id)
    w.agentIs(tkey, 'idle')
    // what b waits for is cleared, but a holds the one slot: b's go waits
    expect(w.engine.queue(b.id, [])).toEqual({ queued: [], went: true })
    expect(b.after).toBeUndefined()
    expect(w.engine.statusOf(b)).toBe('queued')
    expect(w.engine.subOf(b)).toBe('Waiting for a free slot')
    expect(w.sent.some((s) => s.key === bkey && s.text.includes('Go:'))).toBe(false)
    // the coordinator's go to the To do one waits behind it, and says so
    const r = await w.engine.tell(t.id, 'Go ahead.', { gate: true })
    expect(r.held).toBe('slots')
    expect(w.sent.some((s) => s.key === tkey)).toBe(false)
    expect(w.engine.statusOf(t)).toBe('queued')
    // a is done: b, the oldest, gets its go; t still waits
    await w.engine.done(a.t.id, 'Nothing to change.')
    w.agentIs(a.key, 'idle')
    await until(() => w.sent.some((s) => s.key === bkey && s.text.includes(`Go: you no longer wait for ${a.t.id}, start now.`)), 12_000)
    expect(w.engine.statusOf(t)).toBe('queued')
    // yours goes in at once, past the limit
    await w.engine.tell(t.id, 'Go on, please.')
    expect(w.sent.at(-1)).toEqual({ key: tkey, text: 'Go on, please.' })
    expect(t.held).toBeUndefined()
    expect(w.engine.statusOf(t)).toBe('work')
  }, 20_000)

  test('a busy machine holds new tasks ("Waiting for the machine") and lets them go one at a time, machine.startEvery apart', async () => {
    const w = fresh({})
    let m: { busy?: 'cpu' | 'memory'; herdr: boolean } = { busy: 'cpu', herdr: true }
    w.engine.machine = () => m
    const p = await w.places.add(repo(), 'room-load')
    const a = w.engine.add({ project: p.name, title: 'One', desc: 'Add a.txt.', by: 'test' })
    const b = w.engine.add({ project: p.name, title: 'Two', desc: 'Add b.txt.', by: 'test' })
    expect(w.engine.subOf(a)).toBe('Waiting for the machine')
    expect(w.engine.heldTasks().map((t) => t.id)).toEqual([a.id, b.id])
    // herdr not answering holds them too
    m = { herdr: false }
    w.engine.release()
    expect(a.worktree).toBeUndefined()
    m = { herdr: true }
    const now = Date.now()
    w.engine.release(now)
    await until(() => w.started.some((s) => s.key === `${a.id}/Agent`))
    expect(w.engine.statusOf(b)).toBe('queued')
    // two minutes apart by default: the load averages show a's load before b starts
    w.engine.release(now + 60_000)
    expect(b.held).toBeTruthy()
    expect(w.engine.startsNow(now + 60_000)).toBe(0)
    w.engine.release(now + 121_000)
    await until(() => w.started.some((s) => s.key === `${b.id}/Agent`))
  })

  test('starts spaced out as Settings says: 0 lets every held task go at once; a way back start counts too', async () => {
    const w = fresh({ 'machine.startEvery': '0' })
    expect(w.engine.startsNow()).toBe(Infinity)
    const p = await w.places.add(repo(), 'room-burst')
    let m: { busy?: 'cpu' | 'memory'; herdr: boolean } = { busy: 'cpu', herdr: true }
    w.engine.machine = () => m
    const ts = [1, 2, 3].map((n) => w.engine.add({ project: p.name, title: `T${n}`, desc: 'Add t.txt.', by: 'test' }))
    m = { herdr: true }
    w.engine.release()
    await until(() => ts.every((t) => w.started.some((s) => s.key === `${t.id}/Agent`)))
    // 5 minutes apart: a start the way back made holds the next one back until then
    w.settings.set('machine.startEvery', '5 min', 'machine')
    w.engine.noteStart(1_000_000)
    expect([w.engine.startsNow(1_000_000 + 4 * 60_000), w.engine.startsNow(1_000_000 + 5 * 60_000)]).toEqual([0, 1])
  })
})

/** two spaces of this machine, added under their own names (the names their settings are keyed by) */
async function twoSpaces(w: ReturnType<typeof world>) {
  const a = await w.places.add(repo(), 'prio-a')
  const b = await w.places.add(repo(), 'prio-b')
  return { a, b }
}

/** all tasks wait for the same thing: the machine's load. Its spacing is off, so release() can start them one by one */
function busy(w: ReturnType<typeof world>) {
  w.engine.machine = () => ({ busy: 'cpu' as const, herdr: true })
}

describe('the order between spaces in the shared queue', () => {
  test('with nothing set it is by age; a numbered space goes first whatever its age, and the later line names it', async () => {
    const w = fresh({ 'machine.maxTasks': '1', 'machine.startEvery': '0' })
    const { a, b } = await twoSpaces(w)
    // one task at work holds the only slot, so the two that follow wait for the machine's room by age
    const atWork = w.engine.add({ project: b.name, title: 'B work', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${atWork.id}/Agent`))
    w.brief(`${atWork.id}/Agent`)
    const old = w.engine.add({ project: b.name, title: 'B old', by: 'test' })
    const young = w.engine.add({ project: a.name, title: 'A young', by: 'test' })
    expect(w.engine.heldTasks().map((t) => t.id)).toEqual([old.id, young.id])
    expect(w.engine.subOf(old)).toBe('Waiting for a free slot')
    expect(w.posted.some((x) => x.key === `${old.id}/Agent` && x.card?.text === 'waiting for a free slot (1 of 1 working)')).toBe(true)
    // the human gives A the first place: it leads despite being younger, and B says what it waits behind
    expect(w.settings.set('space.priority', '1', { space: a.name }).ok).toBe(true)
    expect(w.engine.heldTasks().map((t) => t.id)).toEqual([young.id, old.id])
    expect(w.engine.subOf(old)).toBe(`Waiting for a free slot · after ${a.name}'s tasks`)
    // a task held after the setting is made gets the same words in its chat card (the line above is read live)
    const later = w.engine.add({ project: b.name, title: 'B later', by: 'test' })
    expect(w.posted.some((x) => x.key === `${later.id}/Agent` && x.card?.text === `waiting for a free slot (1 of 1 working) · after ${a.name}'s tasks`)).toBe(true)
    // the slot frees: A's task starts first, B's still waits
    await w.engine.done(atWork.id, 'Nothing to change.')
    w.agentIs(`${atWork.id}/Agent`, 'idle')
    await until(() => w.started.some((s) => s.key === `${young.id}/Agent`))
    expect(w.started.some((s) => s.key === `${old.id}/Agent`)).toBe(false)
  })

  test('the order is decided before any agent starts: it holds for tasks on different CLIs too', async () => {
    const w = fresh({ 'machine.maxTasks': '1', 'machine.startEvery': '0' })
    const { a, b } = await twoSpaces(w)
    const atWork = w.engine.add({ project: b.name, title: 'B work', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${atWork.id}/Agent`))
    w.brief(`${atWork.id}/Agent`)
    const claude = w.engine.add({ project: b.name, title: 'B Claude Code', by: 'test', agent: { kind: 'claude' } })
    const pi = w.engine.add({ project: a.name, title: 'A pi', by: 'test', agent: { kind: 'pi' } })
    expect(w.settings.set('space.priority', '1', { space: a.name }).ok).toBe(true)
    expect(w.engine.heldTasks().map((t) => t.id)).toEqual([pi.id, claude.id])
    await w.engine.done(atWork.id, 'Nothing to change.')
    w.agentIs(`${atWork.id}/Agent`, 'idle')
    await until(() => w.started.some((s) => s.key === `${pi.id}/Agent`))
    expect(w.started.some((s) => s.key === `${claude.id}/Agent`)).toBe(false)
  })

  test('lower numbers first, equal numbers by age, unset spaces last, and first in line ahead of every space', async () => {
    const w = fresh({ 'machine.startEvery': '0' })
    busy(w)
    const { a, b } = await twoSpaces(w)
    const third = await w.places.add(repo(), 'prio-c')
    expect(w.settings.set('space.priority', '2', { space: a.name }).ok).toBe(true)
    expect(w.settings.set('space.priority', '1', { space: third.name }).ok).toBe(true)
    const b1 = w.engine.add({ project: b.name, title: 'B unset', by: 'test' })
    const a1 = w.engine.add({ project: a.name, title: 'A two', by: 'test' })
    const c1 = w.engine.add({ project: third.name, title: 'C one', by: 'test' })
    const b2 = w.engine.add({ project: b.name, title: 'B unset 2', by: 'test' })
    // controlled ages: the first added is the oldest of the unset spaces, and the two numbered spaces are younger
    b1.held!.since = 1_000
    a1.held!.since = 2_000
    c1.held!.since = 3_000
    b2.held!.since = 4_000
    expect(w.engine.heldTasks().map((t) => t.id)).toEqual([c1.id, a1.id, b1.id, b2.id])
    expect(w.engine.subOf(b1)).toBe(`Waiting for the machine · after ${third.name}'s tasks`)
    // a task marked first in line goes ahead of every space, unaffected by the setting. It passes load, but not a herdr
    // that does not answer, so that is what holds it here
    w.engine.machine = () => ({ herdr: false })
    const fix = w.engine.add({ project: b.name, title: 'Fix main', by: 'test', priority: true })
    fix.held!.since = 5_000
    expect(w.engine.heldTasks().map((t) => t.id)).toEqual([fix.id, c1.id, a1.id, b1.id, b2.id])
    expect(w.engine.subOf(c1)).toBe('Waiting for the machine')
    // two spaces with the same number keep the old age order within their place
    expect(w.settings.set('space.priority', '1', { space: a.name }).ok).toBe(true)
    a1.held!.since = 10
    c1.held!.since = 20
    expect(w.engine.heldTasks().map((t) => t.id)).toEqual([fix.id, a1.id, c1.id, b1.id, b2.id])
  })

  test('a first space at its own Max tasks cap is stepped over, so a later space starts in the same pass', async () => {
    const w = fresh({ 'machine.maxTasks': '2', 'machine.startEvery': '0' })
    const { a, b } = await twoSpaces(w)
    expect(w.settings.set('space.priority', '1', { space: a.name }).ok).toBe(true)
    expect(w.settings.set('space.maxTasks', '1', { space: a.name }).ok).toBe(true)
    const aWork = w.engine.add({ project: a.name, title: 'A work', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${aWork.id}/Agent`))
    w.brief(`${aWork.id}/Agent`)
    const aHeld = w.engine.add({ project: a.name, title: 'A next', by: 'test' })
    expect(aHeld.held?.why).toBe('space')
    // fill the machine with another space's task, so B's next one waits for a slot
    const x = await w.places.add(repo(), 'prio-x')
    const xWork = w.engine.add({ project: x.name, title: 'X work', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${xWork.id}/Agent`))
    w.brief(`${xWork.id}/Agent`)
    const bHeld = w.engine.add({ project: b.name, title: 'B next', by: 'test' })
    expect(bHeld.held?.why).toBe('slots')
    expect(w.engine.heldTasks().map((t) => t.id)).toEqual([aHeld.id, bHeld.id])
    // X frees a machine slot: A cannot use it (still at its cap), but B starts in the same pass
    await w.engine.done(xWork.id, 'Nothing to change.')
    w.agentIs(`${xWork.id}/Agent`, 'idle')
    await until(() => w.started.some((s) => s.key === `${bHeld.id}/Agent`))
    expect(w.started.some((s) => s.key === `${aHeld.id}/Agent`)).toBe(false)
    // B's start filled the machine again, so A's row now names the machine's slots as the first thing holding it
    expect(w.engine.room(aHeld)).toEqual({ why: 'slots' })
  })

  test('a first space whose model is full is stepped over too', async () => {
    const w = fresh({ 'machine.maxTasks': '2', 'machine.startEvery': '0' })
    expect(w.settings.set('models.maxAtOnce', 'codex=1', 'all').ok).toBe(true)
    const { a, b } = await twoSpaces(w)
    expect(w.settings.set('space.priority', '1', { space: a.name }).ok).toBe(true)
    w.engine.lease('advisor:busy', 'advisor', 'codex/unknown', a.name)
    const aHeld = w.engine.add({ project: a.name, title: 'A codex', by: 'test', agent: { kind: 'codex' } })
    expect(aHeld.held?.why).toBe('model')
    // fill the machine, so B's task waits for a slot behind A's capped model
    const x = await w.places.add(repo(), 'prio-x-model')
    const y = await w.places.add(repo(), 'prio-y-model')
    const xWork = w.engine.add({ project: x.name, title: 'X work', by: 'test' })
    const yWork = w.engine.add({ project: y.name, title: 'Y work', by: 'test' })
    await until(() => [xWork, yWork].every((t) => w.started.some((s) => s.key === `${t.id}/Agent`)))
    w.brief(`${xWork.id}/Agent`)
    w.brief(`${yWork.id}/Agent`)
    const bHeld = w.engine.add({ project: b.name, title: 'B plain', by: 'test' })
    expect(bHeld.held?.why).toBe('slots')
    await w.engine.done(xWork.id, 'Nothing to change.')
    w.agentIs(`${xWork.id}/Agent`, 'idle')
    await until(() => w.started.some((s) => s.key === `${bHeld.id}/Agent`))
    expect(w.started.some((s) => s.key === `${aHeld.id}/Agent`)).toBe(false)
  })
})
