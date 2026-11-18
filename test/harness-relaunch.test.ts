// A task's own --agent/--model/--effort win over Settings for that task on every start, relaunch and recovery, and the
// record is written from the harness the launch actually used (SHE-56: POL-453's record said OpenCode while its pane ran
// Claude Sonnet, so the app showed a model that was not running). The route and the record are CLI-independent: this one
// shared path covers all five CLIs; the CLI's own startup wait and screen are unchanged by it.
import { describe, expect, test } from 'bun:test'
import { repo, until, world } from './engine-world.ts'

interface Started { key: string; kind: string; model?: string; effort?: string; set?: { kind: string; model?: string; effort?: string } }

function capture(w: ReturnType<typeof world>) {
  const specs: Started[] = []
  const agents = (w.engine as unknown as { agents: { ensure: (s: Started) => Promise<unknown>; restart: (s: Started) => Promise<unknown> } }).agents
  for (const verb of ['ensure', 'restart'] as const) {
    const original = agents[verb].bind(agents) as (...args: unknown[]) => Promise<unknown>
    agents[verb] = (async (s: Started, before?: unknown) => {
      specs.push(s)
      const result = before === undefined ? await original(s) : await original(s, before as never)
      // the real agents.launch writes effort into the record; the shared fake keeps only kind and model
      if (w.records[s.key] && s.effort) (w.records[s.key] as { effort?: string }).effort = s.effort
      return result
    }) as never
  }
  return specs
}

async function ownTask(w: ReturnType<typeof world>) {
  expect(w.settings.set('task.agent', 'opencode', 'machine').ok).toBe(true)
  const p = await w.places.add(repo(), 'own-harness')
  return w.engine.add({ project: p.name, title: 'Its own worker', desc: 'Do the work.', by: 'test', agent: { kind: 'claude', model: 'claude-sonnet-5-5', effort: 'high' } })
}

describe('a task keeps its own harness', () => {
  test('a first start writes the record from what launched, not from Settings', async () => {
    const w = world()
    const specs = capture(w)
    const t = await ownTask(w)
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
    const s = specs.find((x) => x.key === `${t.id}/Agent`)!
    expect([s.kind, s.model, s.effort]).toEqual(['claude', 'claude-sonnet-5-5', 'high'])
    // Settings are kept only as the "Settings say something else" hint, never as the running harness
    expect(s.set?.kind).toBe('opencode')
    expect([w.records[`${t.id}/Agent`]?.kind, w.records[`${t.id}/Agent`]?.model]).toEqual(['claude', 'claude-sonnet-5-5'])
  })

  test('a stop and a tell (the incident recovery) relaunch it on the same harness while Settings say another', async () => {
    const w = world()
    const specs = capture(w)
    const t = await ownTask(w)
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
    await w.engine.stopTask(t.id)
    await w.engine.tell(t.id, 'Carry on with the work.')
    await until(() => w.started.filter((s) => s.key === `${t.id}/Agent`).length >= 2)
    const again = specs.filter((x) => x.key === `${t.id}/Agent`).at(-1)!
    expect([again.kind, again.model, again.effort]).toEqual(['claude', 'claude-sonnet-5-5', 'high'])
    expect([w.records[`${t.id}/Agent`]?.kind, w.records[`${t.id}/Agent`]?.model]).toEqual(['claude', 'claude-sonnet-5-5'])
  })

  test('a restart on another harness still uses the one chosen for that launch, and keeps it on relaunch', async () => {
    const w = world()
    const specs = capture(w)
    const t = await ownTask(w)
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
    await w.engine.restart(t.id, { kind: 'pi', model: 'spark/local-model', effort: 'high' })
    const switched = specs.filter((x) => x.key === `${t.id}/Agent`).at(-1)!
    expect([switched.kind, switched.model, switched.effort]).toEqual(['pi', 'spark/local-model', 'high'])
    await w.engine.stopTask(t.id)
    await w.engine.tell(t.id, 'Carry on.')
    await until(() => w.started.filter((s) => s.key === `${t.id}/Agent`).length >= 3)
    const again = specs.filter((x) => x.key === `${t.id}/Agent`).at(-1)!
    expect([again.kind, again.model, again.effort]).toEqual(['pi', 'spark/local-model', 'high'])
  })
})
