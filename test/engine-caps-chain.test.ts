// The caps decide where a task starts (engine.ts taskChoice, startTask, cantGoOn, release): a task whose primary is full or
// out starts on the first backup of its chain with room, is held with its chain named when none has, and starts on the
// first of them to free up. A cut-off's takeover skips full backups and waits for one with room. Leases count toward the
// caps like runs, and a space's own sub-limit sits inside the machine's total.
import { describe, expect, test } from 'bun:test'
import { repo, until, world } from './engine-world.ts'

const SPARK = 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold'

/** a fresh world: its spacing off, the CLIs all installed (so the backups are real), and models.maxAtOnce as given */
function fresh(caps = 'off') {
  const w = world()
  w.engine.tasks.splice(0)
  for (const k of ['machine.maxTasks', 'machine.startLoad', 'machine.startMemory', 'machine.startEvery', 'machine.startPressure']) w.settings.set(k, null)
  w.settings.set('machine.startEvery', '0')
  w.settings.set('machine.maxTasks', '10')
  w.engine.installed = () => true
  expect(w.settings.set('models.maxAtOnce', caps, 'all').ok).toBe(true)
  return w
}

/** no backup for a test that is about the primary alone */
const noBackup = (w: ReturnType<typeof world>) => expect(w.settings.set('task.fallback', 'off', 'machine').ok).toBe(true)

/** the kind an agent was started on, by its key (the last start of it) */
const kindOf = (w: ReturnType<typeof world>, key: string) => ([...w.started].reverse().find((s) => s.key === key) as { kind?: string } | undefined)?.kind
const startedOn = (w: ReturnType<typeof world>, id: string) => w.started.some((s) => s.key === `${id}/Agent`)

/** a task on a pi model (its own agent) that is started at once and reads its brief */
async function running(w: ReturnType<typeof world>, dir: string, name: string, title: string, model = SPARK, set?: Record<string, string>) {
  const p = await w.places.add(dir, name)
  const t = w.engine.add({ project: p.name, title, desc: `Add ${title}.txt.`, by: 'test', agent: { kind: 'pi', model }, ...(set ? { set } : {}) })
  await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
  w.records[`${t.id}/Agent`] = { ...w.records[`${t.id}/Agent`], model } as never
  w.brief(`${t.id}/Agent`)
  return { p, t, key: `${t.id}/Agent` }
}

/** a task added on a pi model: it starts or is held as the caps say */
const add = (w: ReturnType<typeof world>, p: { name: string }, title: string, model = SPARK, set?: Record<string, string>) =>
  w.engine.add({ project: p.name, title, desc: `Add ${title}.txt.`, by: 'test', agent: { kind: 'pi', model }, ...(set ? { set } : {}) })

const cards = (w: ReturnType<typeof world>, key: string) => w.posted.filter((x) => x.key === key && x.card).map((x) => x.card!.text)

describe('the caps and the backup chain: a task starts on the first backup with room', () => {
  test('its primary is full: it starts on Backup 1, and its chat says why', async () => {
    const w = fresh('spark=1')
    const dir = repo()
    const s1 = await running(w, dir, 'chain-s1', 'S1')
    const s2 = add(w, s1.p, 'S2')
    await until(() => startedOn(w, s2.id))
    expect(kindOf(w, `${s2.id}/Agent`)).toBe('codex')
    expect(s2.held).toBeUndefined()
    expect(s2.onBackup).toEqual({ step: 1, kind: 'codex', at: expect.any(Number) })
    expect(cards(w, `${s2.id}/Agent`)).toContain('Started on Codex: spark is at its limit (1 of 1 at once)')
    // the agent is told it runs on a backup, with the same brief
    expect(w.started.find((s) => s.key === `${s2.id}/Agent`)?.first).toContain('Shepherdr started you on')
    // the primary's model still runs one task: the count is the backup's own
    expect(w.engine.runs().filter((r) => r.key === SPARK)).toHaveLength(1)
    expect(s1.t.onBackup).toBeUndefined()
  })

  test('a task whose primary has room starts on it, with no card and no backup mark', async () => {
    const w = fresh('spark=2')
    const dir = repo()
    const s1 = await running(w, dir, 'chain-room', 'R1')
    expect(kindOf(w, s1.key)).toBe('pi')
    expect(s1.t.onBackup).toBeUndefined()
    expect(cards(w, s1.key).filter((x) => x.startsWith('Started on'))).toEqual([])
  })

  test('the primary and Backup 1 are full: Backup 2 starts (the chain as the task keeps it)', async () => {
    const w = fresh('spark=1, openai=1')
    const dir = repo()
    const p = await w.places.add(dir, 'chain-two')
    await running(w, dir, 'chain-two-a', 'A1')
    // a pi run on an OpenAI model fills openai=1: Backup 1 (Codex, the default) is full too
    await running(w, dir, 'chain-two-x', 'X1', 'openai/gpt-5.5')
    const c1 = add(w, p, 'C1', SPARK, { 'task.fallback': 'Codex', 'task.fallback2': 'pi' })
    await until(() => startedOn(w, c1.id))
    expect(kindOf(w, `${c1.id}/Agent`)).toBe('pi')
    expect(c1.onBackup?.step).toBe(2)
    expect(cards(w, `${c1.id}/Agent`)).toContain('Started on pi: spark is at its limit (1 of 1 at once)')
  })

  test("a task's own --set chain: the backups it keeps, in its order, are tried in that order", async () => {
    const w = fresh('spark=1, openai=1')
    const dir = repo()
    await running(w, dir, 'set-busy', 'Busy')
    await running(w, dir, 'set-x', 'X1', 'openai/gpt-5.5')
    const p = await w.places.add(dir, 'set-chain')
    // the task's own backups: Codex then pi (the Settings default of Backup 1 is Codex too, but the task keeps pi first)
    const t = add(w, p, 'Chain', SPARK, { 'task.fallback': 'pi', 'task.fallback2': 'Codex' })
    await until(() => startedOn(w, t.id))
    // pi (its Backup 1) has room: the order the task keeps is the order it tries them in
    expect(kindOf(w, `${t.id}/Agent`)).toBe('pi')
    expect(t.onBackup?.step).toBe(1)
  })
})

describe('the caps and the backup chain: held with the chain named, and started when one frees', () => {
  test('every model full or out: held, the row and card name each harness; the first to free starts it', async () => {
    const w = fresh('spark=1, openai=1')
    const dir = repo()
    const s1 = await running(w, dir, 'held-s1', 'S1')
    const s2 = add(w, s1.p, 'S2')
    await until(() => startedOn(w, s2.id))
    expect(kindOf(w, `${s2.id}/Agent`)).toBe('codex')
    const s3 = add(w, s1.p, 'S3')
    expect(s3.held?.why).toBe('model')
    expect(w.engine.subOf(s3)).toBe('Waiting: spark (1 of 1 at once), openai (1 of 1 at once)')
    expect(cards(w, `${s3.id}/Agent`)).toContain('waiting: spark (1 of 1 at once), openai (1 of 1 at once) — every model it may use is full or out')
    expect(startedOn(w, s3.id)).toBe(false)
    // the codex one ends: the held task starts on the first that frees, its backup (openai) with room
    await w.engine.done(s2.id, 'Nothing to change.')
    w.agentIs(`${s2.id}/Agent`, 'idle')
    await until(() => startedOn(w, s3.id))
    expect(kindOf(w, `${s3.id}/Agent`)).toBe('codex')
    expect(s3.held).toBeUndefined()
  })

  test('a backup out of quota is named as out in the wait, with its time', async () => {
    const w = fresh('spark=1')
    w.engine.outNow = (key) => (key.startsWith('openai') ? { until: '17:00' } : undefined)
    const dir = repo()
    const s1 = await running(w, dir, 'out-s1', 'S1')
    const s2 = add(w, s1.p, 'S2')
    expect(s2.held?.why).toBe('model')
    expect(w.engine.subOf(s2)).toBe('Waiting: spark (1 of 1 at once), openai (out until 17:00)')
    // the out backup is never the one a start goes in on, and the wait says so
    expect(w.engine.taskChoice(s2)).toMatchObject({ wait: [{ why: 'full' }, { why: 'out', until: '17:00' }] })
    w.engine.outNow = () => undefined
    w.engine.release()
    await until(() => startedOn(w, s2.id))
    expect(kindOf(w, `${s2.id}/Agent`)).toBe('codex')
  })

  test('an out primary: the task starts on Backup 1 at once, its card says the primary is out', async () => {
    const w = fresh('off')
    w.engine.outNow = (key) => (key === SPARK ? { until: '18:00' } : undefined)
    const dir = repo()
    const p = await w.places.add(dir, 'out-primary')
    const t = add(w, p, 'P1')
    await until(() => startedOn(w, t.id))
    expect(kindOf(w, `${t.id}/Agent`)).toBe('codex')
    expect(cards(w, `${t.id}/Agent`)).toContain('Started on Codex: spark is out until 18:00')
  })

  test('a lease of the advisor or the reviewer counts toward the caps like a run, and unleases', async () => {
    const w = fresh('spark=1')
    noBackup(w)
    const dir = repo()
    const p = await w.places.add(dir, 'lease-space')
    w.engine.lease('advisor-1', 'advisor', SPARK, p.name)
    const t = add(w, p, 'L1')
    expect(t.held?.why).toBe('model')
    expect(w.engine.subOf(t)).toBe('Waiting: spark (1 of 1 at once)')
    w.engine.unlease('advisor-1')
    w.engine.release()
    await until(() => startedOn(w, t.id))
    expect(kindOf(w, `${t.id}/Agent`)).toBe('pi')
  })
})

describe('the caps and a cut-off: the takeover skips the full backups, and waits for one with room', () => {
  test('Backup 1 is full: the takeover goes to Backup 2', async () => {
    const w = fresh('openai=1')
    const dir = repo()
    const s1 = await running(w, dir, 'take-s1', 'S1', SPARK, { 'task.fallback2': 'pi' })
    const busy = add(w, s1.p, 'Busy', 'openai/gpt-5.5')
    await until(() => startedOn(w, busy.id))
    await w.engine.cantGoOn(s1.t.id, 'out of allowance', false)
    expect(kindOf(w, s1.key)).toBe('pi')
    expect(s1.t.tookOver).toMatchObject({ to: 'pi', step: 2 })
  })

  test('no backup has room: the cut-off task is held, and takes over the first backup that frees', async () => {
    const w = fresh('openai=1')
    const dir = repo()
    const s1 = await running(w, dir, 'wait-s1', 'S1')
    const busy = add(w, s1.p, 'Busy', 'openai/gpt-5.5')
    await until(() => startedOn(w, busy.id))
    await w.engine.cantGoOn(s1.t.id, 'out of allowance', false)
    expect(s1.t.held?.why).toBe('model')
    expect(s1.t.held?.takeover).toMatchObject({ why: 'out of allowance', step: 0 })
    expect(s1.t.tookOver).toBeUndefined()
    // the backup frees: the takeover goes in on it, from release
    await w.engine.done(busy.id, 'Nothing to change.')
    w.agentIs(`${busy.id}/Agent`, 'idle')
    w.engine.release()
    await until(() => kindOf(w, s1.key) === 'codex' && s1.t.held === undefined)
    expect(s1.t.tookOver).toMatchObject({ to: 'codex', step: 1 })
  })
})

describe("a space's own sub-limit sits inside the machine's total", () => {
  test('a space at its sub-limit holds its own task, another space still starts on the same model', async () => {
    const w = fresh('spark=4')
    noBackup(w)
    const dir = repo()
    const a = await running(w, dir, 'sub-a', 'A1')
    expect(w.settings.set('models.maxAtOnce', 'spark=1', { space: a.p.name }).ok).toBe(true)
    const a2 = add(w, a.p, 'A2')
    expect(a2.held?.why).toBe('model')
    expect(w.engine.subOf(a2)).toBe(`Waiting: spark in ${a.p.name} (1 of 1 at once)`)
    // another space: its own sub-limit has room, and the machine's total has room
    const b = await w.places.add(repo(), 'sub-b')
    const b1 = add(w, b, 'B1')
    expect(b1.held).toBeUndefined()
    await until(() => startedOn(w, b1.id))
  })

  test("the machine's total holds a space with room of its own", async () => {
    const w = fresh('spark=1')
    noBackup(w)
    const dir = repo()
    const a = await running(w, dir, 'total-a', 'A1')
    expect(w.settings.set('models.maxAtOnce', 'spark=4', { space: 'total-b' }).ok).toBe(true)
    const b = await w.places.add(repo(), 'total-b')
    const b1 = add(w, b, 'B1')
    expect(b1.held?.why).toBe('model')
    expect(w.engine.subOf(b1)).toBe('Waiting: spark (1 of 1 at once)')
    expect(a.t.id).toBeTruthy()
  })
})
