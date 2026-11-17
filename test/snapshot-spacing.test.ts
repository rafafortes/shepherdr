// A snapshot is made synchronously, so one that takes 200 ms stops everything else for 200 ms, and with many agents
// changing there is always another wanted: the server spaces them by what the last one cost (app.ts), and names them to
// the stall watch (stall.ts).
import { afterAll, describe, expect, test } from 'bun:test'
import { startApp } from '../server/app.ts'
import type { Push } from '../server/push.ts'
import { Emitter, type Source, type SourceEvents } from '../server/source.ts'

const labels: string[] = []
class Stub extends Emitter<SourceEvents> {
  kind = 'demo' as const
  /** what the next snapshot costs, ms */
  cost = 0
  made = 0
  stall = { run: <T>(label: string, f: () => T): T => (labels.push(label), f()) }
  snapshot() {
    this.made++
    const end = Date.now() + this.cost
    while (Date.now() < end);
    return { name: 'x', host: 'h', places: [], tasks: [], automations: {}, artifacts: [], asks: {}, settings: [], user: 'u' }
  }
  chat() {
    return undefined
  }
  watch() {}
}

const source = new Stub()
const server = startApp({ source: source as unknown as Source, dist: '/nonexistent', push: { publicKey: 'k', send: async () => undefined } as unknown as Push, port: 0 })
afterAll(() => server.stop(true))

/** news of a change every 5 ms for `ms`, then what the server made meanwhile */
async function burst(ms: number) {
  const before = source.made
  for (const end = Date.now() + ms; Date.now() < end; ) {
    source.emit('snapshot')
    await Bun.sleep(5)
  }
  return source.made - before
}

describe('snapshots under many changes', () => {
  test('a quick one is made again soon: the wait is the old 30 ms', async () => {
    source.cost = 0
    expect(await burst(600)).toBeGreaterThanOrEqual(10)
  })

  test('a costly one is made less often: it takes about a fifth of the time', async () => {
    source.cost = 100
    const made = await burst(1500)
    // without the spacing, 100 ms of work and 30 ms of wait would make about a dozen; with it, one per 400 ms, so four
    expect(made).toBeLessThanOrEqual(6)
    expect(made).toBeGreaterThanOrEqual(2)
  })

  test('the last change is not lost: a snapshot comes after the burst', async () => {
    source.cost = 100
    await burst(300)
    const after = source.made
    source.emit('snapshot')
    await Bun.sleep(700)
    expect(source.made).toBeGreaterThan(after)
  })

  test('each is named to the stall watch', () => {
    expect(labels.filter((l) => l === 'snapshot').length).toBe(source.made)
  })
})
