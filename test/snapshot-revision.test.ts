// The server stamps a revision on every snapshot it sends. A change emit advances it even when the snapshot's bytes do
// not (a profile lives in its own store); the 30-second heartbeat keeps it when the bytes are the same, so the screen
// keeps the object it drew. A heartbeat that finds different bytes still advances, as the old blanket refresh did.
import { afterAll, describe, expect, test } from 'bun:test'
import { startApp } from '../server/app.ts'
import { Emitter, SnapshotRevisions, type Source, type SourceEvents } from '../server/source.ts'
import type { Snapshot } from '../shared/types.ts'

class Stub extends Emitter<SourceEvents> {
  kind = 'demo' as const
  name = 'first'
  snapshot(): Snapshot {
    return { name: this.name, host: 'h', places: [], machines: [], tasks: [], automations: {}, artifacts: [], asks: {}, needs: [], settings: [], user: 'u' }
  }
  chat() {
    return undefined
  }
  watch() {}
}

const source = new Stub()
const server = startApp({ source: source as unknown as Source, dist: '/nonexistent', port: 0 })
afterAll(() => server.stop(true))

/** the revisions the screen saw, in order */
async function screen() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws`)
  const seen: number[] = []
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as { type: string; snapshot?: { rev?: number } }
    if (msg.type === 'snapshot') seen.push(msg.snapshot?.rev ?? 0)
  }
  await new Promise<void>((r) => (ws.onopen = () => r()))
  for (let i = 0; i < 1000 && !seen.length; i++) await Bun.sleep(5)
  return { ws, seen }
}
/** wait until one more snapshot has been broadcast, then say its revision */
async function next(seen: number[], n: number) {
  for (let i = 0; i < 1000 && seen.length <= n; i++) await Bun.sleep(5)
  return seen.at(-1)
}

describe('the revision on the wire', () => {
  test('a change advances it; a heartbeat that says the same thing does not', async () => {
    const { ws, seen } = await screen()
    try {
      expect(seen[0]).toBeGreaterThan(0)
      const open = seen.length
      source.emit('snapshot')
      expect(await next(seen, open)).toBe(seen[0] + 1)
      const changed = seen.length
      source.emit('heartbeat')
      expect(await next(seen, changed)).toBe(seen[0] + 1)
    } finally {
      ws.close()
    }
  })

  test('a heartbeat still catches a change no emit named', async () => {
    const { ws, seen } = await screen()
    try {
      const open = seen.at(-1)
      if (open === undefined) throw new Error('no snapshot was broadcast')
      const before = seen.length
      source.name = 'second'
      source.emit('heartbeat')
      expect(await next(seen, before)).toBeGreaterThan(open)
    } finally {
      ws.close()
    }
  })
})

describe('the stamp itself', () => {
  test('every change advances, even one with the same bytes; a refresh keeps them', () => {
    const revisions = new SnapshotRevisions()
    const a = revisions.changed({ name: 'x' } as Snapshot)
    const b = revisions.changed({ name: 'x' } as Snapshot) // a profile changed, not this snapshot's bytes
    const c = revisions.refresh({ name: 'x' } as Snapshot)
    const d = revisions.refresh({ name: 'y' } as Snapshot)
    const first = a.rev
    if (first === undefined) throw new Error('the stamp gave no revision')
    expect([b.rev, c.rev, d.rev]).toEqual([first + 1, first + 1, first + 2])
  })
})
