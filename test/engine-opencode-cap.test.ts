// OpenCode's agents under models.maxAtOnce, in the engine: a task on an OpenCode model counts toward that model's entry and
// its provider's, the way any other agent does, and an OpenCode backup is a harness of its chain like the others. The
// world's starts are stubbed (no herdr, no OpenCode): what counts is the model each task's agent runs on.
import { describe, expect, test } from 'bun:test'
import { setModels, opencodeList } from '../server/live/models.ts'
import { choose } from '../server/live/engine/choose.ts'
import { parseMaxAtOnce } from '../shared/model-caps.ts'
import { repo, until, world } from './engine-world.ts'

const GO = 'opencode-go/deepseek-v4.1-flash'
const ZEN = 'opencode/minimax-m3.1-flash-free'
/** the keys those models run under: OpenCode's own harness and provider in front of the model id */
const GO_KEY = 'opencode.opencode-go/deepseek-v4.1-flash'
const ZEN_KEY = 'opencode.opencode/minimax-m3.1-flash-free'

/** a fresh world with OpenCode's list, its spacing off, and models.maxAtOnce as given */
function fresh(caps: string, machine = '3') {
  const w = world()
  w.engine.tasks.splice(0)
  for (const k of ['machine.maxTasks', 'machine.startLoad', 'machine.startMemory', 'machine.startEvery', 'machine.startPressure']) w.settings.set(k, null)
  w.settings.set('machine.startEvery', '0')
  expect(w.settings.set('machine.maxTasks', machine).ok).toBe(true)
  expect(w.settings.set('models.maxAtOnce', caps, 'all').ok).toBe(true)
  setModels('opencode', { ...opencodeList([{ id: GO, label: GO, efforts: [] }, { id: ZEN, label: ZEN, efforts: [] }], GO), at: Date.now() })
  return w
}

/** a task on OpenCode's model, started at once: its agent runs on that model */
async function startOn(w: ReturnType<typeof world>, dir: string, name: string, title: string, model = GO) {
  const p = await w.places.add(dir, name)
  const t = w.engine.add({ project: p.name, title, desc: `Add ${title}.txt.`, by: 'test', agent: { kind: 'opencode', model } })
  await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
  ;(w.records[`${t.id}/Agent`] as { model?: string }).model = model
  w.brief(`${t.id}/Agent`)
  return { p, t, key: `${t.id}/Agent` }
}

describe('OpenCode under models.maxAtOnce', () => {
  test("an OpenCode model's agents count toward its provider's entry, and a task past it is held, as for any CLI", async () => {
    const w = fresh('opencode.opencode-go=1')
    try {
      const dir = repo()
      const a = await startOn(w, dir, 'oc-cap-a', 'OC1')
      expect(w.engine.runs().filter((r) => r.key === GO_KEY)).toHaveLength(1)
      const b = w.engine.add({ project: a.p.name, title: 'OC2', desc: 'Add OC2.txt.', by: 'test', agent: { kind: 'opencode', model: GO } })
      expect(b.held?.why).toBe('model')
      expect(w.engine.room(b)).toEqual({ why: 'model' })
      // another OpenCode model (the Zen one, its own provider) is not held by Go's entry
      const z = await startOn(w, dir, 'oc-cap-z', 'OZ1', ZEN)
      expect(z.t.held).toBeUndefined()
      expect(w.engine.runs().map((r) => r.key).sort()).toEqual([GO_KEY, ZEN_KEY].sort())
    } finally {
      setModels('opencode', undefined)
    }
  })

  test("an OpenCode task whose model is the CLI's own default counts under the model that default is", async () => {
    const w = fresh('opencode.opencode-go=1')
    try {
      const p = await w.places.add(repo(), 'oc-default')
      const t = w.engine.add({ project: p.name, title: 'Default', desc: 'Add Default.txt.', by: 'test', agent: { kind: 'opencode' } })
      expect(w.engine.modelOfTask(t)).toBe(GO_KEY)
    } finally {
      setModels('opencode', undefined)
    }
  })

  test('a backup on OpenCode is one more harness of a chain: a primary at its cap goes past it to OpenCode, out or full skips it', () => {
    const capped = parseMaxAtOnce('codex=1, opencode.opencode-go=1')
    const cap = capped.ok ? capped.entries : []
    const options = [
      { harness: 'codex', key: 'codex/gpt-6-sol' },
      { harness: 'opencode', key: GO_KEY },
    ]
    const running = [{ key: 'codex/gpt-6-sol', space: 'app', role: 'task' as const }]
    const c = choose({ space: 'app', options, runs: running, machine: cap, own: [] })
    expect(c).toMatchObject({ harness: 'opencode', index: 1, skipped: [{ harness: 'codex', why: 'full' }] })
    // out (its provider's allowance is spent) skips it the same way, and a full OpenCode model waits for both
    const out = choose({ space: 'app', options: [{ ...options[0]!, out: { until: '5pm' } }, options[1]!], runs: [{ key: GO_KEY, space: 'app', role: 'task' }], machine: cap, own: [] })
    expect(out).toMatchObject({ wait: [{ harness: 'codex', why: 'out' }, { harness: 'opencode', why: 'full', name: 'opencode.opencode-go' }] })
  })
})
