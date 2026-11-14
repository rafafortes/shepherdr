// A takeover that a restart of Shepherdr cuts short (engine.ts cantGoOn, resumeTakeovers): while it is on its way, the task
// keeps its handover; it is cleared once the backup is up or the takeover failed, and a restart that finds it takes the
// takeover again from where it stood before it. The takeover is the same code for every CLI: a pi agent taken over by
// Codex stands for all of them.
import { describe, expect, test } from 'bun:test'
import { repo, until, world } from './engine-world.ts'

const SPARK = 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold'

/** a fresh world with its spacing off and every CLI installed (so the backups are real) */
function fresh() {
  const w = world()
  w.engine.tasks.splice(0)
  for (const k of ['machine.maxTasks', 'machine.startLoad', 'machine.startMemory', 'machine.startEvery', 'machine.startPressure']) w.settings.set(k, null)
  w.settings.set('machine.startEvery', '0')
  w.settings.set('machine.maxTasks', '10')
  w.engine.installed = () => true
  return w
}

/** a task on pi, started at once */
async function running(w: ReturnType<typeof world>, name: string) {
  const p = await w.places.add(repo(), name)
  const t = w.engine.add({ project: p.name, title: 'T1', desc: 'Add t1.txt.', by: 'test', agent: { kind: 'pi', model: SPARK } })
  await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
  w.records[`${t.id}/Agent`] = { ...w.records[`${t.id}/Agent`], model: SPARK } as never
  w.brief(`${t.id}/Agent`)
  return { t, key: `${t.id}/Agent` }
}

const kindOf = (w: ReturnType<typeof world>, key: string) => ([...w.started].reverse().find((s) => s.key === key) as { kind?: string } | undefined)?.kind

describe('a takeover on its way keeps its handover until the backup is up', () => {
  test('kept while the backup starts, cleared once it is up', async () => {
    const w = fresh()
    const { t, key } = await running(w, 'handover-up')
    const ensure = w.agents.ensure
    let during: unknown
    w.agents.ensure = (async (s: { key: string }) => {
      if (s.key === key) during = t.handover
      return ensure(s as never)
    }) as never
    await w.engine.cantGoOn(t.id, 'Out of allowance', true)
    expect(during).toMatchObject({ why: 'Out of allowance', lasting: true })
    expect(t.handover).toBeUndefined()
    expect(kindOf(w, key)).toBe('codex')
    expect(t.tookOver).toMatchObject({ to: 'codex', step: 1 })
  })

  test('cleared too when the backup does not start', async () => {
    const w = fresh()
    const { t, key } = await running(w, 'handover-fail')
    const ensure = w.agents.ensure
    w.agents.ensure = (async (s: { key: string; kind: string }) => {
      if (s.key === key && s.kind === 'codex') throw new Error('herdr is not answering')
      return ensure(s as never)
    }) as never
    await w.engine.cantGoOn(t.id, 'Out of allowance', true)
    expect(t.handover).toBeUndefined()
    expect(t.tookOver).toBeUndefined()
    expect(t.trouble).toContain('herdr is not answering')
  })
})

describe('a restart that cut a takeover short takes it again', () => {
  test('from where it stood before it, with the same reason: the backup goes in', async () => {
    const w = fresh()
    const { t, key } = await running(w, 'resume-take')
    // as a restart leaves it: the takeover marked, its handover kept, the agent still the one cut off
    t.tookOver = { from: 'pi', to: 'codex', why: 'out of allowance', at: Date.now(), step: 1 }
    t.handover = { why: 'Out of allowance', lasting: true, at: Date.now() }
    w.engine.resumeTakeovers()
    await until(() => kindOf(w, key) === 'codex')
    await until(() => t.handover === undefined && t.tookOver?.step === 1)
    expect(t.tookOver).toMatchObject({ from: 'pi', to: 'codex', step: 1 })
  })

  test('a task stopped meanwhile gets its takeover before back, and nothing starts', async () => {
    const w = fresh()
    const { t, key } = await running(w, 'resume-stopped')
    const before = { from: 'claude', to: 'pi', why: 'rate limited', at: 1, step: 1 }
    t.tookOver = { from: 'pi', to: 'codex', why: 'out of allowance', at: Date.now(), step: 2 }
    t.handover = { why: 'Out of allowance', lasting: true, prior: before, at: Date.now() }
    t.stopped = true
    const starts = w.started.filter((s) => s.key === key).length
    w.engine.resumeTakeovers()
    await Bun.sleep(50)
    expect(t.handover).toBeUndefined()
    expect(t.tookOver).toEqual(before)
    expect(w.started.filter((s) => s.key === key)).toHaveLength(starts)
  })
})
