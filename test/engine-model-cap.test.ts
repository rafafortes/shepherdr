// models.maxAtOnce in the engine: the most agents at once per model or provider on this machine. A task whose model is at
// its cap is held as Waiting for a free slot of that model (or provider), and the other tasks start past it; the held
// ones start in turn as the model frees up. What counts: this machine's tasks that hold a slot, each on the model it
// runs, and its coordinators working on a model now. A model's own entry counts its agents, a provider's every agent of it.
import { describe, expect, test } from 'bun:test'
import { placeId, repo, until, world } from './engine-world.ts'

const SPARK = 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold'
const CODE = 'commandcode/deepseek/deepseek-v4.1-flash'

/** a fresh world: the machine's limits as given, its spacing off, and models.maxAtOnce as given (none: off) */
function fresh(limits: Record<string, string> = {}, caps = 'off') {
  const w = world()
  w.engine.tasks.splice(0)
  for (const k of ['machine.maxTasks', 'machine.startLoad', 'machine.startMemory', 'machine.startEvery', 'machine.startPressure']) w.settings.set(k, null)
  w.settings.set('machine.startEvery', '0')
  for (const [k, v] of Object.entries(limits)) expect(w.settings.set(k, v).ok).toBe(true)
  expect(w.settings.set('models.maxAtOnce', caps, 'all').ok).toBe(true)
  return w
}

/** the model an agent's record says it runs on (the real registry keeps it; the test world's records do not) */
const modelOf = (w: ReturnType<typeof world>, key: string, model: string) => ((w.records[key] as { model?: string }).model = model)

/** a task added on a pi model (its own agent, so its model is the one it starts on) and started at once */
async function startOn(w: ReturnType<typeof world>, dir: string, name: string, title: string, model: string) {
  const p = await w.places.add(dir, name)
  const t = w.engine.add({ project: p.name, title, desc: `Add ${title}.txt.`, by: 'test', agent: { kind: 'pi', model } })
  await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
  modelOf(w, `${t.id}/Agent`, model)
  w.brief(`${t.id}/Agent`)
  return { p, t, key: `${t.id}/Agent` }
}

/** a task added on a pi model that waits (held or queued): nothing is started for it */
function addOn(w: ReturnType<typeof world>, p: { name: string }, title: string, model: string, priority = false) {
  return w.engine.add({ project: p.name, title, desc: `Add ${title}.txt.`, by: 'test', agent: { kind: 'pi', model }, ...(priority ? { priority: true } : {}) })
}

/** how many of this machine's agents run on a model now (models.maxAtOnce's count) */
const loadOf = (w: ReturnType<typeof world>, key: string) => w.engine.runs().filter((r) => r.key === key).length

const startedOf = (w: ReturnType<typeof world>, id: string) => w.started.some((s) => s.key === `${id}/Agent`)

describe('models.maxAtOnce: a model at its cap holds its next task, and the others start past it', () => {
  test('a provider at its cap holds the next of its models as Waiting for a free slot of spark; a commandcode task starts in the same pass', async () => {
    const w = fresh({ 'machine.maxTasks': '3' }, 'spark=2')
    const dir = repo()
    const s1 = await startOn(w, dir, 'cap-s1', 'S1', SPARK)
    const s2 = await startOn(w, dir, 'cap-s2', 'S2', SPARK)
    // the machine has room, its spark models do not: the model is the reason
    const s3 = addOn(w, s1.p, 'S3', SPARK)
    expect(s3.held?.why).toBe('model')
    expect(w.engine.subOf(s3)).toBe('Waiting: spark (2 of 2 at once)')
    expect(w.posted.some((x) => x.key === `${s3.id}/Agent` && x.id.startsWith('held:') && x.card?.text === 'waiting: spark (2 of 2 at once) — every model it may use is full or out')).toBe(true)
    expect(startedOf(w, s3.id)).toBe(false)
    expect(w.engine.room(s3)).toEqual({ why: 'model' })
    // another provider's task starts past it: the machine has room for it (two of three slots)
    const c = await startOn(w, dir, 'cap-code', 'C1', CODE)
    expect(c.t.held).toBeUndefined()
    expect(startedOf(w, c.t.id)).toBe(true)
    // the machine is full now (S1, S2, C1): the spark task's reason is the machine's, as the row says first
    expect(s3.held?.why).toBe('slots')
    expect(w.engine.heldTasks().map((t) => t.id)).toEqual([s3.id])
    expect(startedOf(w, s2.t.id)).toBe(true)
  })

  test('when one of the capped model’s tasks ends, its held task starts, in the same pass as the others', async () => {
    const w = fresh({ 'machine.maxTasks': '3' }, 'spark=2')
    const dir = repo()
    const s1 = await startOn(w, dir, 'end-s1', 'S1', SPARK)
    await startOn(w, dir, 'end-s2', 'S2', SPARK)
    // the machine is full (S1, S2 and a commandcode task): the spark task waits for the machine first, as its line says
    const x = await startOn(w, dir, 'end-x', 'X1', CODE)
    const s3 = addOn(w, s1.p, 'S3', SPARK)
    expect(s3.held?.why).toBe('slots')
    // the commandcode task ends first: the machine has a slot, the spark model is still at its cap, so the reason is the model
    await w.engine.done(x.t.id, 'Nothing to change.')
    w.agentIs(x.key, 'idle')
    await until(() => s3.held?.why === 'model')
    expect(startedOf(w, s3.id)).toBe(false)
    expect(w.engine.subOf(s3)).toBe('Waiting: spark (2 of 2 at once)')
    // a commandcode task added now starts past the spark one
    const c2 = addOn(w, s1.p, 'C2', CODE)
    expect(c2.held).toBeUndefined()
    // one spark task ends: the held one starts, with the card that says why
    await w.engine.done(s1.t.id, 'Nothing to change.')
    w.agentIs(s1.key, 'idle')
    await until(() => startedOf(w, s3.id))
    expect(s3.held).toBeUndefined()
    expect(w.posted.some((p) => p.key === `${s3.id}/Agent` && p.id.startsWith('go:') && p.card?.text === 'started: a slot of its model is free')).toBe(true)
  })

  test('a model that is not capped, or a cap of another model, holds nothing', async () => {
    const w = fresh({ 'machine.maxTasks': '10' }, 'spark/other-model=1')
    const dir = repo()
    const a = await startOn(w, dir, 'free-a', 'A1', SPARK)
    const b = addOn(w, a.p, 'A2', SPARK)
    expect(b.held).toBeUndefined()
    expect(w.engine.taskChoice(a.t)).toMatchObject({ index: 0, skipped: [] })
    expect(w.engine.room(b)).toEqual({})
  })

  test('the Settings value is read when a start is decided: a cap set while a task waits lets it go on the next release', async () => {
    const w = fresh({ 'machine.maxTasks': '10' }, 'spark=1')
    const dir = repo()
    const a = await startOn(w, dir, 'set-a', 'A1', SPARK)
    const b = addOn(w, a.p, 'A2', SPARK)
    expect(b.held?.why).toBe('model')
    expect(w.settings.set('models.maxAtOnce', 'spark=2', 'machine').ok).toBe(true)
    w.engine.release()
    await until(() => startedOf(w, b.id))
    expect(b.held).toBeUndefined()
  })
})

describe('models.maxAtOnce: which entry caps a model, and what counts', () => {
  test("a model's own entry counts its own agents, and the provider's entry still holds the provider's total", async () => {
    const w = fresh({ 'machine.maxTasks': '10' }, 'spark=2, spark/qwen3.8-flash-next-mlx4-mtp-tensorfold=3')
    const dir = repo()
    const q1 = await startOn(w, dir, 'own-q1', 'Q1', SPARK)
    const o1 = await startOn(w, dir, 'own-o1', 'O1', 'spark/other-model')
    // spark=2 is full (qwen and the other model): the qwen model's own 3 do not pass the provider's 2
    const q2 = addOn(w, q1.p, 'Q2', SPARK)
    expect(q2.held?.why).toBe('model')
    expect(w.engine.subOf(q2)).toBe('Waiting: spark (2 of 2 at once)')
    expect(w.engine.taskChoice(q2)).toMatchObject({ wait: [{ name: 'spark', cap: { scope: 'machine', count: 2, max: 2 } }] })
    // one of the two ends: the provider has room, the qwen model its own 3 with room too, so Q2 starts
    await w.engine.done(o1.t.id, 'Nothing to change.')
    w.agentIs(o1.key, 'idle')
    await until(() => startedOf(w, q2.id))
    expect(q2.held).toBeUndefined()
  })

  test("a model's own entry names the model it holds: the held line says the model's name and count", async () => {
    const w = fresh({ 'machine.maxTasks': '10' }, `spark=4, ${SPARK}=1`)
    const dir = repo()
    const q1 = await startOn(w, dir, 'name-q1', 'Q1', SPARK)
    const q2 = addOn(w, q1.p, 'Q2', SPARK)
    expect(q2.held?.why).toBe('model')
    expect(w.engine.subOf(q2)).toBe(`Waiting: ${SPARK} (1 of 1 at once)`)
    expect(w.posted.some((x) => x.key === `${q2.id}/Agent` && x.card?.text === `waiting: ${SPARK} (1 of 1 at once) — every model it may use is full or out`)).toBe(true)
  })

  test('a model entry is matched by its model key, a provider entry by its provider, and a claude model by its anthropic key', async () => {
    const w = fresh({ 'machine.maxTasks': '10' }, 'anthropic/claude-opus-5-5=1')
    const dir = repo()
    const p = await w.places.add(dir, 'claude-cap')
    const t1 = w.engine.add({ project: p.name, title: 'O1', desc: 'Add o1.txt.', by: 'test', agent: { kind: 'claude', model: 'claude-opus-5-5' } })
    await until(() => w.started.some((s) => s.key === `${t1.id}/Agent`))
    expect(w.engine.modelOfTask(t1)).toBe('anthropic/claude-opus-5-5')
    const t2 = w.engine.add({ project: p.name, title: 'O2', desc: 'Add o2.txt.', by: 'test', agent: { kind: 'claude', model: 'claude-opus-5-5' } })
    expect(t2.held?.why).toBe('model')
    expect(w.engine.subOf(t2)).toBe('Waiting: anthropic/claude-opus-5-5 (1 of 1 at once)')
    // another claude model is not capped by it
    const t3 = w.engine.add({ project: p.name, title: 'S1', desc: 'Add s1.txt.', by: 'test', agent: { kind: 'claude', model: 'claude-sonnet-5' } })
    expect(t3.held).toBeUndefined()
  })

  test('the coordinators working on a model count, and an idle one does not; a reviewer run or a coordinator at rest is not counted', async () => {
    const w = fresh({ 'machine.maxTasks': '10' }, 'spark=1')
    const dir = repo()
    const p = await w.places.add(dir, 'coord-cap')
    // a coordinator of this machine, working on spark: the one slot of spark is its
    const chat = placeId.space(p.name)
    w.records[chat] = { kind: 'pi', started: Date.now(), logs: [] }
    modelOf(w, chat, SPARK)
    w.agentIs(chat, 'working')
    const t = addOn(w, p, 'Waits', SPARK)
    expect(t.held?.why).toBe('model')
    expect(w.engine.subOf(t)).toBe('Waiting: spark (1 of 1 at once)')
    // at rest, it is not counted
    w.agentIs(chat, 'idle')
    expect(w.engine.room(t)).toEqual({})
    // a reviewer run of a task (its key has a slash) is not counted, even when working on spark
    w.records['t-1/Reviewer'] = { kind: 'pi', started: Date.now(), logs: [] }
    modelOf(w, 't-1/Reviewer', SPARK)
    w.agentIs('t-1/Reviewer', 'working')
    expect(loadOf(w, SPARK)).toBe(0)
  })

  test('a task merging in line or in its gate holds no slot, so it is not counted; a task that needs you with its agent there is', async () => {
    const w = fresh({ 'machine.maxTasks': '10' }, 'spark=1')
    const dir = repo()
    const a = await startOn(w, dir, 'merge-a', 'A1', SPARK)
    expect(loadOf(w, SPARK)).toBe(1)
    // in line for its merge: it holds nothing, so the next one may start
    ;(a.t as { landing?: unknown }).landing = { step: 'queue', at: Date.now(), behind: 'X-1' }
    expect(loadOf(w, SPARK)).toBe(0)
    expect(addOn(w, a.p, 'A2', SPARK).held).toBeUndefined()
    // back at work, asking a question with its agent there: it counts again (A1 and A2 now)
    delete (a.t as { landing?: unknown }).landing
    w.chat.question = true
    w.agentIs(a.key, 'working')
    expect(w.engine.statusOf(a.t)).toBe('need')
    expect(loadOf(w, SPARK)).toBe(2)
    w.chat.question = false
  })

  test('a task counts on the model its live agent runs, else on the one it starts on; a stopped or ended one counts nothing', async () => {
    const w = fresh({ 'machine.maxTasks': '10' }, 'spark=5')
    const dir = repo()
    const a = await startOn(w, dir, 'live-a', 'A1', SPARK)
    // its live agent reports another model (it was switched): the live one is what it runs on
    modelOf(w, a.key, 'radeon/other-model')
    expect(w.engine.modelOfTask(a.t)).toBe('radeon/other-model')
    expect(loadOf(w, 'radeon/other-model')).toBe(1)
    expect(loadOf(w, SPARK)).toBe(0)
    // an agent that is gone counts on what the task starts on
    w.agentIs(a.key, 'gone')
    expect(w.engine.modelOfTask(a.t)).toBe(SPARK)
    expect(loadOf(w, SPARK)).toBe(0)
  })

  test('a first in line passes neither a model cap nor the held order: it waits for its model, ahead of the older ones', async () => {
    const w = fresh({ 'machine.maxTasks': '10' }, 'spark=1')
    const dir = repo()
    const a = await startOn(w, dir, 'prio-a', 'A1', SPARK)
    const older = addOn(w, a.p, 'Older', SPARK)
    const fix = addOn(w, a.p, 'Fix main', SPARK, true)
    expect(fix.held?.why).toBe('model')
    expect(w.engine.subOf(fix)).toBe('First in line · Waiting: spark (1 of 1 at once)')
    expect(w.engine.heldTasks().map((t) => t.id)).toEqual([fix.id, older.id])
    await w.engine.done(a.t.id, 'Nothing to change.')
    w.agentIs(a.key, 'idle')
    await until(() => startedOf(w, fix.id))
    expect(startedOf(w, older.id)).toBe(false)
    expect(older.held?.why).toBe('model')
  })

  test('the machine’s limit comes first, then the space’s cap, then the model’s: the row names the first that blocks', async () => {
    const w = fresh({ 'machine.maxTasks': '1' }, 'spark=1')
    const dir = repo()
    const a = await startOn(w, dir, 'order-a', 'A1', SPARK)
    expect(addOn(w, a.p, 'A2', SPARK).held?.why).toBe('slots')
    w.settings.set('machine.maxTasks', '5')
    expect(addOn(w, a.p, 'A3', SPARK).held?.why).toBe('model')
    // a space at its own cap is named before the model
    expect(w.settings.set('space.maxTasks', '1', { space: a.p.name }).ok).toBe(true)
    const a4 = addOn(w, a.p, 'A4', SPARK)
    expect(a4.held?.why).toBe('space')
    expect(w.engine.subOf(a4)).toBe(`Waiting for a free slot of ${a.p.name}`)
  })
})
