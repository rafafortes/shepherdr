// biome-ignore-all lint/style/noNonNullAssertion: the index and regex captures were checked just above
// A task whose CLI retries inside its turn: herdr says "working", no cut reaches the log, and yet the retry window
// ends in the same backup chain as a cut. The engine's own test world (a real repo and worktree, its agents stubbed),
// with retry.ts's hook wired as source.ts wires it.
import { describe, expect, test } from 'bun:test'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('retry-loop-engine')
const { world, repo, until } = await import('./engine-world.ts')
const { Retries, WAITS } = await import('../server/live/retry.ts')
type LoopState = import('../server/live/retry.ts').LoopState

const WINDOW = WAITS.reduce((a, b) => a + b, 0)
const T0 = Date.UTC(2026, 10, 24, 12, 0)
const state = (attempt: number, message = 'Rate limit exceeded. Please try again later.', next?: number): LoopState => ({
  attempt,
  message,
  ...(next !== undefined ? { next } : {}),
  source: 'screen',
})

function taskWorld(w: ReturnType<typeof world>) {
  const retries = new Retries(
    {
      nudge: () => undefined,
      over: (key, r) => void w.engine.cantGoOn(key.split('/')[0], r.reason, r.lasting, r.blocked).catch(() => undefined),
      changed: () => w.engine.emit('changed'),
    },
    WAITS,
  )
  w.engine.retry = (key) => retries.get(key)
  return retries
}

describe('an OpenCode task agent retrying inside its turn', () => {
  test('past the window it goes to backup.model, then on along the chain if that one is limited too', async () => {
    const w = world()
    w.engine.installed = () => true
    const p = await w.places.add(repo(), 'task-chain')
    for (const [k, v] of [
      ['task.fallback', 'claude'],
      ['backup.model', 'Sonnet 5.5'],
      ['task.fallback2', 'codex'],
      ['task.fallback2Model', 'gpt-6-sol'],
    ])
      expect(w.settings.set(k, v, { space: p.name }).ok).toBe(true)
    const t = w.engine.add({ project: p.name, title: 'Say hello', desc: 'Add hello.txt.', by: 'test' })
    const key = `${t.id}/Agent`
    await until(() => w.started.some((s) => s.key === key))
    const mine = () => w.started.filter((s) => s.key === key)
    const retries = taskWorld(w)

    // a short retry inside the window: no takeover, and the row says what it waits for, not "Working"
    retries.loop(key, state(7, 'Rate limit exceeded. Please try again later.', T0 + 836_000), T0)
    expect(w.engine.view(t).sub).toContain('Rate limited, retrying (attempt 7)')
    expect(mine()).toHaveLength(1)
    expect(t.tookOver).toBeUndefined()

    // past the window: the backup takes over, closing the pane the retry ran in (agents.ts restart)
    retries.loop(key, state(9, undefined, T0 + WINDOW + 60_000), T0 + WINDOW + 60_000)
    await until(() => mine().length === 2)
    expect(mine()[1]).toMatchObject({ kind: 'claude', model: 'claude-sonnet-5-5' })
    expect(t.tookOver).toMatchObject({ to: 'claude', why: 'rate limited, still after 9 tries' })
    expect(mine()[1]!.first).toContain('rate limited, still after 9 tries')

    // Backup 1 is limited too: the next model of the chain goes in. The handover's first message clears the old
    // retry in source.ts (agents.on('sent')); the engine's test world has no such hook, so do it here.
    retries.clear(key)
    retries.loop(key, state(1, 'Go usage limit exceeded'), T0 + WINDOW + 2 * 60_000)
    await until(() => mine().length === 3)
    expect(mine()[2]!.kind).toBe('codex')
    expect(t.tookOver).toMatchObject({ to: 'codex', step: 2 })
    retries.stop()
  })

  test('a retry that recovers before the window leaves the task on its primary', async () => {
    const w = world()
    w.engine.installed = () => true
    const p = await w.places.add(repo(), 'task-short')
    expect(w.settings.set('task.fallback', 'codex', { space: p.name }).ok).toBe(true)
    const t = w.engine.add({ project: p.name, title: 'Say hello', desc: 'Add hello.txt.', by: 'test' })
    const key = `${t.id}/Agent`
    await until(() => w.started.some((s) => s.key === key))
    const retries = taskWorld(w)
    retries.loop(key, state(3, 'Rate limit exceeded. Please try again later.', T0 + 40_000), T0)
    // two quiet reads are a request in flight; the third is a recovery, so nothing to hand over
    retries.loopEnded(key)
    retries.loopEnded(key)
    expect(retries.get(key)).toMatchObject({ attempt: 3, loopMisses: 2 })
    retries.loopEnded(key)
    expect(retries.get(key)).toBeUndefined()
    expect(w.started.filter((s) => s.key === key)).toHaveLength(1)
    expect(t.tookOver).toBeUndefined()
    expect(w.engine.view(t).sub).toBe('Working')
    retries.stop()
  })
})
