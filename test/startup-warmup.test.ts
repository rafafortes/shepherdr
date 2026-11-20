// The listener opens before the first snapshot. While the first read of every chat's log is still going, /api/version
// answers at once (the cheap probe the plugin's start action uses), /api/snapshot says "building" to retry, and a
// screen's first socket gets its snapshot as soon as the warm-up settles — never a closed port or an unbounded wait.
import { describe, expect, test } from 'bun:test'
import { startApp } from '../server/app.ts'
import { Emitter, type Source, type SourceEvents } from '../server/source.ts'
import type { Snapshot, ServerEvent } from '../shared/types.ts'

const view = (): Snapshot => ({ name: 'Shepherdr', host: 'h', places: [], machines: [], tasks: [], automations: {}, artifacts: [], asks: {}, needs: [], settings: [], user: 'u' })

/** a live source whose first (cold) snapshot waits on a gate; the ones a route or socket builds later are instant */
class Warming extends Emitter<SourceEvents> {
  kind = 'live' as const
  release!: () => void
  gate = new Promise<void>((r) => (this.release = r))
  cold = true
  /** how many times a caller built a snapshot itself (the socket after the cap, the poll after warm-up) */
  built = 0
  snapshot(): Snapshot {
    if (this.cold) {
      this.cold = false
      // the real live source reads logs synchronously; a Promise here stands in for that slow first read and lets the
      // test hold the warm-up open while it checks the routes that must not depend on it
      return this.gate.then(() => view()) as unknown as Snapshot
    }
    this.built++
    return view()
  }
  chat() {
    return undefined
  }
  watch() {}
}

function warming() {
  const source = new Warming()
  const server = startApp({ source: source as unknown as Source, dist: '/nonexistent', port: 0, warmup: () => source.snapshot() })
  return { source, server, url: `http://127.0.0.1:${server.port}` }
}

/** wait for a socket's snapshot, with a bounded loop (a miss is a failure the assertion below reports) */
async function snapshotOn(ws: WebSocket) {
  const seen: ServerEvent[] = []
  ws.onmessage = (e) => seen.push(JSON.parse(String(e.data)) as ServerEvent)
  for (let i = 0; i < 400 && !seen.some((m) => m.type === 'snapshot'); i++) await Bun.sleep(5)
  return seen.find((m) => m.type === 'snapshot')
}

describe('serving before the first snapshot', () => {
  test('/api/version answers in the first second while the first snapshot is still building', async () => {
    const { source, server, url } = warming()
    try {
      const began = performance.now()
      const r = await fetch(`${url}/api/version`)
      expect(r.status).toBe(200)
      expect(await r.json()).toMatchObject({ version: expect.any(String), root: expect.any(String) })
      expect(performance.now() - began).toBeLessThan(1000)
      // the warm-up is still gated, so the cheap probe answered without waiting for the snapshot
      expect(source.cold).toBe(false)
      expect(source.built).toBe(0)
    } finally {
      source.release()
      server.stop(true)
    }
  })

  test('/api/snapshot says building during warm-up, then carries a revision once it settles', async () => {
    const { source, server, url } = warming()
    try {
      const building = await fetch(`${url}/api/snapshot`)
      expect(building.status).toBe(503)
      expect(await building.json()).toEqual({ building: true })
      source.release()
      for (let i = 0; i < 200; i++) {
        if (await fetch(`${url}/api/snapshot`).then((r) => r.status === 200)) break
        await Bun.sleep(5)
      }
      const ready = await fetch(`${url}/api/snapshot`)
      expect(ready.status).toBe(200)
      expect(typeof ((await ready.json()) as Snapshot).rev).toBe('number')
    } finally {
      source.release()
      server.stop(true)
    }
  })

  test("a screen's first socket waits for the warming snapshot instead of a closed port", async () => {
    const { source, server } = warming()
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws`)
    try {
      await new Promise<void>((r) => (ws.onopen = () => r()))
      source.release()
      const first = await snapshotOn(ws)
      expect(first?.type).toBe('snapshot')
      expect((first as Extract<ServerEvent, { type: 'snapshot' }>).snapshot.name).toBe('Shepherdr')
    } finally {
      source.release()
      ws.close()
      server.stop(true)
    }
  })

  test('a socket that leaves during warm-up is not sent a snapshot when it settles', async () => {
    const { source, server } = warming()
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws`)
    try {
      await new Promise<void>((r) => (ws.onopen = () => r()))
      ws.close()
      // let the server's close handler drop it before the warm-up settles
      await Bun.sleep(20)
      source.release()
      // the deferred send checks the socket is still live; a closed one must not throw here
      await Bun.sleep(30)
    } finally {
      source.release()
      server.stop(true)
    }
  })

  test('a source that never warms still gets a snapshot after the short cap', async () => {
    const source = new Warming()
    // snapshot() stays cold forever without a release, but every built-on-demand call is a real synchronous snapshot
    source.snapshot = () => view()
    const server = startApp({ source: source as unknown as Source, dist: '/nonexistent', port: 0, warmup: () => new Promise<void>(() => {}) })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws`)
    try {
      await new Promise<void>((r) => (ws.onopen = () => r()))
      const first = await snapshotOn(ws)
      expect(first?.type).toBe('snapshot')
    } finally {
      ws.close()
      server.stop(true)
    }
  })
})
