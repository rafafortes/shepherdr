// 0 blocks a model (models.maxAtOnce=0, and the same at a space's own level): nothing starts on it, in any role, and it is
// never waited for. In the engine: a task starts on the first backup of its chain that is not blocked, is held as Blocked
// when every model it may use is (and stays held until a limit changes), and the other limits read 0 the same way: a
// machine or a space set to 0 tasks starts none, while off (no cap) starts as many as there is room for. A run that is
// working when its model becomes blocked keeps running.
import { describe, expect, test } from 'bun:test'
import { repo, until, world } from './engine-world.ts'

const SPARK = 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold'

/** a fresh world: its spacing off, the CLIs all installed (so the backups are real), the machine's task limits as given,
 *  and models.maxAtOnce as given (none: off) */
function fresh(caps = 'off', limits: Record<string, string | null> = {}) {
  const w = world()
  w.engine.tasks.splice(0)
  for (const k of ['machine.maxTasks', 'machine.startLoad', 'machine.startMemory', 'machine.startEvery', 'machine.startPressure']) w.settings.set(k, null)
  w.settings.set('machine.startEvery', '0')
  w.settings.set('machine.maxTasks', '10')
  w.engine.installed = () => true
  for (const [k, v] of Object.entries(limits)) expect(w.settings.set(k, v).ok).toBe(true)
  expect(w.settings.set('models.maxAtOnce', caps, 'all').ok).toBe(true)
  return w
}

/** no backup for a test that is about the primary alone */
const noBackup = (w: ReturnType<typeof world>) => expect(w.settings.set('task.fallback', 'off', 'machine').ok).toBe(true)

const kindOf = (w: ReturnType<typeof world>, key: string) => ([...w.started].reverse().find((s) => s.key === key) as { kind?: string } | undefined)?.kind
const startedOn = (w: ReturnType<typeof world>, id: string) => w.started.some((s) => s.key === `${id}/Agent`)
const cards = (w: ReturnType<typeof world>, key: string) => w.posted.filter((x) => x.key === key && x.card).map((x) => x.card!.text)

/** a task on a pi model (its own agent): started at once when it can be, and its brief read */
async function running(w: ReturnType<typeof world>, dir: string, name: string, title: string, model = SPARK) {
  const p = await w.places.add(dir, name)
  const t = w.engine.add({ project: p.name, title, desc: `Add ${title}.txt.`, by: 'test', agent: { kind: 'pi', model } })
  await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
  w.records[`${t.id}/Agent`] = { ...w.records[`${t.id}/Agent`], model } as never
  w.brief(`${t.id}/Agent`)
  return { p, t, key: `${t.id}/Agent` }
}

/** a task added on a pi model: it starts or is held as the limits say */
const add = (w: ReturnType<typeof world>, p: { name: string }, title: string, model = SPARK) => w.engine.add({ project: p.name, title, desc: `Add ${title}.txt.`, by: 'test', agent: { kind: 'pi', model } })

const ALL_BLOCKED = 'waiting: every model it may use is blocked (0 allowed): change its agent or a limit'

describe('0 blocks a model: a task starts on the first backup that is not blocked', () => {
  test('its primary is blocked: it starts on Backup 1, and its chat says the block', async () => {
    const w = fresh('spark=0')
    const dir = repo()
    const s = add(w, await w.places.add(dir, 'blk-backup'), 'S1')
    await until(() => startedOn(w, s.id))
    expect(kindOf(w, `${s.id}/Agent`)).toBe('codex')
    expect(s.onBackup).toEqual({ step: 1, kind: 'codex', at: expect.any(Number) })
    expect(cards(w, `${s.id}/Agent`)).toContain('Started on Codex: spark is blocked (0 allowed)')
    expect(s.held).toBeUndefined()
  })

  test('its primary is blocked and its backup is full: it waits for the backup, not as blocked', async () => {
    const w = fresh('spark=0, openai=1')
    const dir = repo()
    const busy = await running(w, dir, 'blk-busy', 'Busy', 'openai/gpt-5.5')
    void busy
    const s = add(w, await w.places.add(dir, 'blk-full'), 'S2')
    expect(s.held?.why).toBe('model')
    expect(w.engine.subOf(s)).toMatch(/^Waiting: /)
    expect(w.engine.holdLine(s)).toContain('(1 of 1 at once)')
    expect(w.engine.holdLine(s)).not.toContain('blocked')
  })
})

describe('0 blocks a model: a task whose every model is blocked is held, and nothing starts until a limit changes', () => {
  test('every model blocked: held as Blocked with the words, never waiting for a slot', async () => {
    const w = fresh('spark=0')
    noBackup(w)
    const dir = repo()
    const s = add(w, await w.places.add(dir, 'blk-held'), 'S1')
    expect(s.held?.why).toBe('blocked')
    expect(cards(w, `${s.id}/Agent`)).toContain(ALL_BLOCKED)
    expect(w.engine.holdLine(s)).toBe('Blocked: every model it may use is 0 allowed')
    expect(w.engine.room(s)).toEqual({ why: 'blocked' })
    expect(w.engine.waitingFor(s)).toEqual(['spark'])
    expect(startedOn(w, s.id)).toBe(false)
  })

  test('release does not start it while the block stands, and starts it once the limit is taken off', async () => {
    const w = fresh('spark=0')
    noBackup(w)
    const dir = repo()
    const s = add(w, await w.places.add(dir, 'blk-release'), 'S1')
    w.engine.release()
    w.engine.release()
    expect(s.held?.why).toBe('blocked')
    expect(startedOn(w, s.id)).toBe(false)
    expect(w.settings.set('models.maxAtOnce', null, 'all').ok).toBe(true)
    w.engine.release()
    await until(() => startedOn(w, s.id))
    expect(s.held).toBeUndefined()
  })

  test('a block at a space’s own level holds that space’s tasks only', async () => {
    const w = fresh('off')
    noBackup(w)
    const a = await w.places.add(repo(), 'blk-space-a')
    const b = await w.places.add(repo(), 'blk-space-b')
    expect(w.settings.set('models.maxAtOnce', 'spark=0', { space: a.name }).ok).toBe(true)
    const ta = add(w, a, 'A1')
    const tb = add(w, b, 'B1')
    expect(ta.held?.why).toBe('blocked')
    await until(() => startedOn(w, tb.id))
    expect(tb.held).toBeUndefined()
    // and the block counts nothing of the other space's runs: it holds only what is in its own space
    expect(w.engine.room(ta)).toEqual({ why: 'blocked' })
  })

  test('a block that is full beside a block: only the full one is waited for', async () => {
    // the backup is full (one codex run of this machine), the primary is blocked: the task waits for that backup
    const w = fresh('spark=0, openai=1')
    const dir = repo()
    await running(w, dir, 'blk-mixed-busy', 'Busy', 'openai/gpt-5.5')
    noBackup(w)
    expect(w.settings.set('task.fallback', 'Codex', 'machine').ok).toBe(true)
    const s = add(w, await w.places.add(dir, 'blk-mixed'), 'S3')
    expect(s.held?.why).toBe('model')
    expect(w.engine.waitingFor(s)).toEqual(['openai'])
  })
})

describe('0 on the task counts: this machine or this space starts none, and off is no cap', () => {
  test('machine.maxTasks=0: every task is held as set to 0 tasks, and off starts them again', async () => {
    const w = fresh('off', { 'machine.maxTasks': '0' })
    const dir = repo()
    const s = add(w, await w.places.add(dir, 'zero-machine'), 'Z1')
    expect(s.held?.why).toBe('zero')
    expect(cards(w, `${s.id}/Agent`)).toContain('waiting: this machine is set to 0 tasks')
    expect(w.engine.holdLine(s)).toBe('This machine is set to 0 tasks')
    expect(w.engine.freeSlots()).toBe(0)
    expect(startedOn(w, s.id)).toBe(false)
    expect(w.settings.set('machine.maxTasks', 'off').ok).toBe(true)
    w.engine.release()
    await until(() => startedOn(w, s.id))
  })

  test('machine.maxTasks off is no cap: as many as there is room for', async () => {
    const w = fresh('off', { 'machine.maxTasks': 'off' })
    const dir = repo()
    const p = await w.places.add(dir, 'zero-off')
    const ts = [add(w, p, 'O1'), add(w, p, 'O2'), add(w, p, 'O3')]
    await until(() => ts.every((t) => startedOn(w, t.id)))
    expect(ts.every((t) => !t.held)).toBe(true)
  })

  test('space.maxTasks=0: the space’s tasks are held as its space is set to 0 tasks; another space still starts', async () => {
    const w = fresh('off')
    noBackup(w)
    const a = await w.places.add(repo(), 'zero-space-a')
    const b = await w.places.add(repo(), 'zero-space-b')
    expect(w.settings.set('space.maxTasks', '0', { space: a.name }).ok).toBe(true)
    const ta = add(w, a, 'A1')
    expect(ta.held?.why).toBe('spaceZero')
    expect(w.engine.holdLine(ta)).toBe(`${w.places.shownName(a.name)} is set to 0 tasks`)
    expect(cards(w, `${ta.id}/Agent`)).toContain(`waiting: ${w.places.shownName(a.name)} is set to 0 tasks`)
    const tb = add(w, b, 'B1')
    await until(() => startedOn(w, tb.id))
    expect(tb.held).toBeUndefined()
    // off at the space is no cap of its own: its held task starts
    expect(w.settings.set('space.maxTasks', 'off', { space: a.name }).ok).toBe(true)
    w.engine.release()
    await until(() => startedOn(w, ta.id))
  })

  test('space.maxTasks=0 at Everywhere holds every space; a space’s own off lifts it there', async () => {
    const w = fresh('off')
    noBackup(w)
    const a = await w.places.add(repo(), 'zero-every-a')
    expect(w.settings.set('space.maxTasks', '0', 'all').ok).toBe(true)
    const ta = add(w, a, 'A2')
    expect(ta.held?.why).toBe('spaceZero')
    expect(w.settings.set('space.maxTasks', 'off', { space: a.name }).ok).toBe(true)
    w.engine.release()
    await until(() => startedOn(w, ta.id))
  })
})

describe('running agents are never stopped by a block', () => {
  test('a run on a model that becomes blocked keeps running; only the new starts avoid it', async () => {
    const w = fresh('off')
    noBackup(w)
    const dir = repo()
    const s1 = await running(w, dir, 'blk-run', 'Run')
    const before = w.started.length
    expect(w.settings.set('models.maxAtOnce', 'spark=0', 'all').ok).toBe(true)
    w.engine.release()
    expect(w.stopped).toEqual([])
    expect(w.started.length).toBe(before)
    expect(w.engine.runs().some((r) => r.id === s1.t.id && r.key === SPARK)).toBe(true)
    // and the next one, on the same model, is held
    const s2 = add(w, s1.p, 'R2')
    expect(s2.held?.why).toBe('blocked')
  })
})

describe('a review round, when every reviewer is blocked: no round counted, nothing waits', () => {
  test('the answer names the reviewer and says no review ran; the task keeps its rounds', async () => {
    const w = fresh('off')
    const dir = repo()
    const s = await running(w, dir, 'blk-review', 'Reviewed')
    expect(w.settings.set('reviewer.agent', 'Codex', 'all').ok).toBe(true)
    expect(w.settings.set('models.maxAtOnce', 'openai=0', 'all').ok).toBe(true)
    const r = await w.engine.reviewRound(s.t.id)
    expect('wait' in r).toBe(true)
    expect(w.engine.reviewWaitWords(s.t.id, (r as { wait: never }).wait)).toBe(
      `No reviewer may run under the limits: every reviewer ${s.t.id} may use is blocked (0 allowed). No round is counted, and nothing waits: say in your summary that this review did not run because of the limits, and report without it.`,
    )
    expect(s.t.reviews ?? 0).toBe(0)
    expect(s.t.reviewWait).toBeUndefined()
    expect(w.engine.reviewWaits()).toEqual([])
  })
})

describe('a review round whose reviewer is blocked goes to the backup reviewer, and says so', () => {
  test('the primary reviewer blocked (0 allowed): the round runs on the backup, counted, and says why', async () => {
    const w = fresh('off')
    const dir = repo()
    const s = await running(w, dir, 'blk-review-backup', 'Reviewed backup')
    expect(w.settings.set('reviewer.agent', 'Codex', 'all').ok).toBe(true)
    expect(w.settings.set('reviewer.fallback', 'pi', 'all').ok).toBe(true)
    expect(w.settings.set('models.maxAtOnce', 'openai=0', 'all').ok).toBe(true)
    const r = await w.engine.reviewRound(s.t.id)
    expect('wait' in r).toBe(false)
    if ('wait' in r) throw new Error('expected a round')
    expect(r).toMatchObject({ round: 1, n: 1, why: { why: 'blocked', name: 'openai' } })
    expect(w.engine.reviewWords(s.t.id, r)).toContain('(Codex (default) is blocked (0 allowed))')
    expect(s.t.reviews).toBe(1)
    w.engine.reviewDone(s.t.id)
  })
})
