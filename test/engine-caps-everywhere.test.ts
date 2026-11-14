// The caps hold every new run of a task's agent, not only a task's first start (engine.ts runs, claim, launchHold,
// restart, resume, taskChain): two cut-offs at once never both take a backup's last slot; a restart onto a full model is
// refused before anything stops; an agent that is gone is not started again on a full model; a task whose agent is there
// already is judged on the model it runs; and an agent at work counts on its model at any step of its task.
import { describe, expect, test } from 'bun:test'
import { repo, until, world } from './engine-world.ts'

const SPARK = 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold'
/** the key pi's model runs under */
const KEY = `pi.${SPARK}`

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

/** a task on a pi model (its own agent) that is started at once and reads its brief */
async function running(w: ReturnType<typeof world>, dir: string, name: string, title: string, model = SPARK) {
  const p = await w.places.add(dir, name)
  const t = w.engine.add({ project: p.name, title, desc: `Add ${title}.txt.`, by: 'test', agent: { kind: 'pi', model } })
  await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
  w.records[`${t.id}/Agent`] = { ...w.records[`${t.id}/Agent`], model } as never
  w.brief(`${t.id}/Agent`)
  return { p, t, key: `${t.id}/Agent` }
}

const startsOf = (w: ReturnType<typeof world>, key: string) => w.started.filter((s) => s.key === key).length
const kindOf = (w: ReturnType<typeof world>, key: string) => ([...w.started].reverse().find((s) => s.key === key) as { kind?: string } | undefined)?.kind

describe('two cut-offs at once share the backups as the caps say', () => {
  test("the backup's last slot goes to one of them; the other waits for it, and takes it over once it frees", async () => {
    const w = fresh('openai=1')
    const dir = repo()
    const a = await running(w, dir, 'race-a', 'A1')
    const b = await running(w, dir, 'race-b', 'B1')
    // both run out together: each chooses its backup before the other's agent is there
    await Promise.all([w.engine.cantGoOn(a.t.id, 'out of allowance', false), w.engine.cantGoOn(b.t.id, 'out of allowance', false)])
    expect(kindOf(w, a.key)).toBe('codex')
    expect(a.t.tookOver).toMatchObject({ to: 'codex', step: 1 })
    // the second saw the first one's slot taken: held for it, not a second agent past the cap
    expect(kindOf(w, b.key)).toBe('pi')
    expect(b.t.held?.why).toBe('model')
    expect(b.t.held?.takeover).toMatchObject({ why: 'out of allowance', step: 0 })
    expect(w.engine.runs().filter((r) => r.key.startsWith('codex/'))).toHaveLength(1)
    // the first one ends: the backup frees, and the second takes it over from release
    await w.engine.done(a.t.id, 'Nothing to change.')
    w.agentIs(a.key, 'idle')
    w.engine.release()
    await until(() => kindOf(w, b.key) === 'codex' && b.t.held === undefined)
    expect(b.t.tookOver).toMatchObject({ to: 'codex', step: 1 })
  })

  test("a claim counts its run on the model it goes to until it is over, and a chat's own claim is not held against it", () => {
    const w = fresh('spark=1')
    w.engine.claim('X-1/Agent', { key: KEY, space: 'x', role: 'task', id: 'X-1' })
    expect(w.engine.capHold('x', KEY)).toMatchObject([{ why: 'full', name: 'pi.spark' }])
    expect(w.engine.capHold('x', KEY, 'X-1')).toBeUndefined()
    expect(w.engine.capHold('x', KEY, 'X-1/Agent')).toBeUndefined()
    w.engine.unclaim('X-1/Agent')
    expect(w.engine.capHold('x', KEY)).toBeUndefined()
  })
})

describe('a restart, a relaunch and a resume obey the caps', () => {
  test('a restart onto a full model is refused before its turn is stopped; onto the model it already runs, its own run is no hold', async () => {
    const w = fresh('spark=1, openai=1')
    const dir = repo()
    const a = await running(w, dir, 'restart-a', 'A1')
    const b = await running(w, dir, 'restart-b', 'B1', 'openai/gpt-5.5')
    const err = await w.engine.restart(b.t.id, { kind: 'pi', model: SPARK }).catch((e: Error) => e)
    expect((err as Error).message).toBe('Not restarted: pi · spark is at its limit (1 of 1 at once): wait for a free slot, or pick another model.')
    expect(w.stopped).not.toContain(b.key)
    expect(startsOf(w, b.key)).toBe(1)
    // the spark task restarted on spark again: it frees its own slot first, so it may
    await w.engine.restart(a.t.id, { kind: 'pi', model: SPARK })
    expect(startsOf(w, a.key)).toBe(2)
    // and a blocked model says what to change instead
    expect(w.settings.set('models.maxAtOnce', 'spark=0', 'all').ok).toBe(true)
    const blocked = await w.engine.restart(b.t.id, { kind: 'pi', model: SPARK }).catch((e: Error) => e)
    expect((blocked as Error).message).toBe('Not restarted: pi · spark is blocked (0 allowed): change its agent or a limit in Settings → Limits.')
  })

  test('an agent that is gone is not started again on a full model: no failed start, and it starts once there is room', async () => {
    const w = fresh('spark=1')
    const dir = repo()
    const a = await running(w, dir, 'resume-a', 'A1')
    const b = await running(w, dir, 'resume-b', 'B1', 'openai/gpt-5.5')
    // B's agent stopped; meanwhile it was moved to spark by hand (its record says so), where A works
    w.records[b.key] = { ...w.records[b.key], kind: 'pi', model: SPARK } as never
    w.agentIs(b.key, 'gone')
    const err = await w.engine.resume(b.t.id).catch((e: Error) => e)
    expect((err as Error).message).toBe('Not started: pi · spark is at its limit (1 of 1 at once): wait for a free slot, or pick another model.')
    expect(startsOf(w, b.key)).toBe(1)
    expect(b.t.trouble).toBeUndefined()
    expect(w.engine.startFailedAt(b.key)).toBeUndefined()
    // A goes idle: spark has room, and B starts again on it
    w.agentIs(a.key, 'idle')
    a.t.reported = true
    await w.engine.resume(b.t.id)
    expect(startsOf(w, b.key)).toBe(2)
    // an agent that runs is only found again: no hold is looked at, and nothing new starts
    w.agentIs(b.key, 'idle')
    await w.engine.resume(b.t.id)
    expect(w.engine.launchHold(b.t)).toBeUndefined()
  })

  test('a go that went in to an agent that is gone does not start it on a full model', async () => {
    const w = fresh('spark=1')
    const dir = repo()
    await running(w, dir, 'go-a', 'A1')
    const b = await running(w, dir, 'go-b', 'B1', 'openai/gpt-5.5')
    w.records[b.key] = { ...w.records[b.key], kind: 'pi', model: SPARK } as never
    w.agentIs(b.key, 'gone')
    ;(b.t as { going?: string }).going = 'Go: start the work.'
    w.engine.resumeQueue()
    await Bun.sleep(50)
    expect(startsOf(w, b.key)).toBe(1)
  })
})

describe('a task whose agent is there already is judged on the model it runs', () => {
  test('its chain is what its agent runs (its backup, at its step), or the worker it is started on now; a waiting takeover still chooses', async () => {
    const w = fresh()
    const dir = repo()
    const a = await running(w, dir, 'chain-a', 'A1')
    w.records[a.key] = { ...w.records[a.key], kind: 'codex', model: 'gpt-5.5' } as never
    a.t.tookOver = { from: 'pi', to: 'codex', why: 'out of allowance', at: Date.now(), step: 1 }
    expect(w.engine.taskChain(a.t)).toEqual([{ step: 1, h: { kind: 'codex', model: 'gpt-5.5', effort: undefined } }])
    a.t.switchTo = { kind: 'claude', model: 'claude-opus-5-5' }
    expect(w.engine.taskChain(a.t)).toEqual([{ step: 0, h: { kind: 'claude', model: 'claude-opus-5-5' } }])
    a.t.switchTo = undefined
    a.t.held = { why: 'model', since: Date.now(), takeover: { why: 'out of allowance', step: 0 } }
    expect(w.engine.taskChain(a.t)[0]).toMatchObject({ step: 1, h: { kind: 'codex' } })
  })
})

describe('an agent at work counts on its model at any step of its task', () => {
  test('reported, it still counts while its agent works; in line for its merge, or done, it does not', async () => {
    const w = fresh('spark=4')
    const dir = repo()
    const a = await running(w, dir, 'count-a', 'A1')
    a.t.reported = true
    expect(w.engine.statusOf(a.t)).toBe('work')
    w.agentIs(a.key, 'idle')
    expect(w.engine.statusOf(a.t)).toBe('ready')
    expect(w.engine.runs().filter((r) => r.key === KEY)).toHaveLength(0)
    // told to fix something after it reported: its agent works again, on spark
    w.agentIs(a.key, 'working')
    ;(a.t as { landing?: unknown }).landing = { step: 'rebase', at: Date.now() }
    expect(w.engine.runs().filter((r) => r.key === KEY)).toHaveLength(1)
    ;(a.t as { landing?: unknown }).landing = { step: 'queue', at: Date.now(), behind: 'X-1' }
    expect(w.engine.runs().filter((r) => r.key === KEY)).toHaveLength(0)
    ;(a.t as { landing?: unknown }).landing = undefined
    a.t.merged = true
    expect(w.engine.runs().filter((r) => r.key === KEY)).toHaveLength(0)
  })

  test("a chat of no task of this machine's, or not its task's own, counts nothing", () => {
    const w = fresh()
    w.records['NOPE-1/Agent'] = { kind: 'pi', model: SPARK, started: Date.now(), logs: [] } as never
    w.agentIs('NOPE-1/Agent', 'working')
    expect(w.engine.runs()).toEqual([])
  })
})
