// What a task's agent runs on (engine.ts view → TaskAgent.run): the provider, its name, the model and the effort its
// record keeps, while its agent is up; the row's line under the status reads it (src/ui.tsx runLine).
import { describe, expect, test } from 'bun:test'
import { repo, until, world } from './engine-world.ts'

const SPARK = 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold'

/** a task started at once on pi with that model, its agent's record as the real registry keeps it */
async function started(model?: string, effort?: string) {
  const w = world()
  w.engine.tasks.splice(0)
  w.settings.set('machine.startEvery', '0')
  const p = await w.places.add(repo(), `run-${Math.random().toString(36).slice(2, 8)}`)
  const t = w.engine.add({ project: p.name, title: 'R1', desc: 'Add r1.txt.', by: 'test', agent: { kind: 'pi', ...(model ? { model } : {}) } })
  await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
  const key = `${t.id}/Agent`
  w.records[key] = { ...w.records[key], ...(model ? { model } : {}), ...(effort ? { effort } : {}) } as never
  return { w, t, key }
}

describe('a task says what its agent runs on', () => {
  test('its provider (and its name), its model and its effort, while its agent is up', async () => {
    const { w, t } = await started(SPARK, 'high')
    expect(w.engine.view(t).agent?.run).toEqual({ provider: 'pi.spark', providerName: 'Spark (local)', model: 'qwen3.8-flash-next-mlx4-mtp-tensorfold', effort: 'high' })
  })

  test("a CLI that picks its own model says default, and no effort when none was set", async () => {
    const { w, t, key } = await started()
    delete (w.records[key] as { model?: string }).model
    expect(w.engine.view(t).agent?.run).toMatchObject({ provider: 'pi', model: 'default' })
    expect(w.engine.view(t).agent?.run?.effort).toBeUndefined()
  })

  test('an agent that is gone runs on nothing: no run', async () => {
    const { w, t, key } = await started(SPARK)
    w.agentIs(key, 'gone')
    expect(w.engine.view(t).agent?.run).toBeUndefined()
  })
})
