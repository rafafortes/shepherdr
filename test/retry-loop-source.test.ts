// biome-ignore-all lint/style/noNonNullAssertion: the index and regex captures were checked just above
// A coordinator whose CLI retries inside its turn: no cut reaches the log, and yet the retry window ends in its own
// backup chain. A real LiveSource with its starts stubbed (no herdr socket), as backup.test.ts. The same pass that
// reads an agent's own retry state is checked here too.
import { afterAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('retry-loop-source')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { Retries, WAITS } = await import('../server/live/retry.ts')
type LoopState = import('../server/live/retry.ts').LoopState
type Retry = import('../server/live/retry.ts').Retry

const src = new LiveSource()
src.engine.installed = () => true
afterAll(() => src.stop())
type Side = { coordinatorCantGoOn(key: string, r: Retry): Promise<void> }
const sides = src as unknown as Side
const WINDOW = WAITS.reduce((a, b) => a + b, 0)
const T0 = Date.UTC(2026, 10, 24, 12, 0)
const state = (attempt: number, message = 'Rate limit exceeded. Please try again later.', next?: number): LoopState => ({
  attempt,
  message,
  ...(next !== undefined ? { next } : {}),
  source: 'screen',
})
const until = async (f: () => boolean, ms = 5_000) => {
  for (const t0 = Date.now(); !f(); await Bun.sleep(10)) if (Date.now() - t0 > ms) throw new Error('timed out')
}

async function coordinatorSpace(name: string) {
  const dir = tmp('retry-loop-repo')
  execSync('git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init', { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, name)
  const key = placeId.space(p.name)
  src.agents.records[key] = { key, name: `shep-${p.name}`, kind: 'claude', cwd: dir, workspace: p.name, logs: [], started: Date.now() } as never
  return { p, key }
}

describe("a coordinator's loop", () => {
  test('a loop past the window goes to its own fallback, as a cut would', async () => {
    const { p, key } = await coordinatorSpace('coordinator-loop')
    const restart = src.agents.restart
    try {
      expect(src.settings.set('coordinator.fallback', 'codex', { space: p.name }).ok).toBe(true)
      const starts: { key: string; kind: string; first?: string }[] = []
      src.agents.restart = (async (s: { key: string; kind: string }, before?: () => Promise<string | undefined>) => {
        starts.push({ key: s.key, kind: s.kind, first: (await before?.()) as string | undefined })
        return null
      }) as never
      const retries = new Retries(
        {
          nudge: () => undefined,
          over: (k, r) => void sides.coordinatorCantGoOn(k, r).catch(() => undefined),
          changed: () => undefined,
        },
        WAITS,
      )
      retries.loop(key, state(8, 'Rate limit exceeded. Please try again later.', T0 + 800_000), T0)
      expect(retries.get(key)).toMatchObject({ inTurn: true, attempt: 8, reason: 'Rate limited' })
      expect(starts).toEqual([])
      retries.loop(key, state(9, undefined, T0 + WINDOW + 60_000), T0 + WINDOW + 60_000)
      await until(() => starts.length > 0)
      expect(starts[0]).toMatchObject({ key, kind: 'codex' })
      expect(starts[0]!.first).toContain('rate limited, still after 9 tries')
      expect(src.agents.tookOver(key)).toMatchObject({ from: 'claude', to: 'codex' })
      retries.stop()
    } finally {
      src.agents.restart = restart
      src.settings.set('coordinator.fallback', null, { space: p.name })
    }
  })

  test('the pass reads a CLI state through loopReader and keeps it for the status line', async () => {
    const { key } = await coordinatorSpace('watch-loop')
    src.agents.records[key] = { key, name: 'shep', kind: 'opencode', cwd: tmp('coord'), logs: [], started: Date.now() } as never
    const status = src.agents.status
    const reader = src.loopReader
    src.agents.status = ((k: string) => (k === key ? 'working' : 'gone')) as never
    src.loopReader = async () => state(6, 'Rate limit exceeded. Please try again later.', T0 + 700_000)
    try {
      await src.watchRetryLoops(T0)
      expect(src.retries.get(key)).toMatchObject({ inTurn: true, attempt: 6, reason: 'Rate limited', source: 'screen' })
    } finally {
      src.agents.status = status
      src.loopReader = reader
      src.retries.clear(key)
      delete src.agents.records[key]
    }
  })
})
