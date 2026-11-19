// A snapshot is made synchronously, so one that takes 200 ms stops everything else for 200 ms, and with many agents
// changing there is always another wanted: the server spaces them by what the last one cost (app.ts), and names them to
// the stall watch (stall.ts). With no screen and no other machine's link open it builds none at all, and a screen that
// opens in that gap gets one then.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startApp } from '../server/app.ts'
import type { Push } from '../server/push.ts'
import { Emitter, type Source, type SourceEvents } from '../server/source.ts'

const labels: string[] = []
class Stub extends Emitter<SourceEvents> {
  kind = 'demo' as const
  /** what the next snapshot costs, ms */
  cost = 0
  made = 0
  /** the chats the server asked to watch, one entry per ask: a screen's close makes one with nothing in it */
  watching: number[] = []
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
  watch(chats: string[]) {
    this.watching.push(chats.length)
  }
}

const source = new Stub()
const server = startApp({ source: source as unknown as Source, dist: '/nonexistent', push: { publicKey: 'k', send: async () => undefined } as unknown as Push, port: 0 })
afterAll(() => server.stop(true))

/** a screen, or another machine's link (link: true), connected to the server; the messages it got so far */
async function connect(watch?: { link: true }) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws`)
  const got: { type: string }[] = []
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)))
  await new Promise((r) => (ws.onopen = r))
  // it sends a snapshot, then the build and the update, as it opens: no fixed sleep to race (an open asks the source to
  // watch nothing, which a plain screen does not, so that ask is the link's own)
  for (let i = 0; i < 1000 && !got.some((m) => m.type === 'update'); i++) await Bun.sleep(5)
  expect(got.some((m) => m.type === 'snapshot')).toBe(true)
  if (watch) {
    const was = source.watching.length
    ws.send(JSON.stringify({ type: 'watch', chats: [], term: null, ...watch }))
    for (let i = 0; i < 1000 && source.watching.length === was; i++) await Bun.sleep(5)
  }
  return { ws, got }
}

/** the server has dropped it: a close asks the source to watch nothing, which is a new ask (no fixed sleep to race) */
async function closed(ws: WebSocket) {
  const was = source.watching.length
  ws.close()
  for (let i = 0; i < 500 && source.watching.length === was; i++) await Bun.sleep(10)
  expect(source.watching.length).toBeGreaterThan(was)
}

/** news of a change every 5 ms for `ms`, then what the server made meanwhile */
async function burst(ms: number) {
  const before = source.made
  for (const end = Date.now() + ms; Date.now() < end; ) {
    source.emit('snapshot')
    await Bun.sleep(5)
  }
  return source.made - before
}

/** a change, and the snapshot it wants made: returns once that one is being made */
async function madeOnce() {
  const before = source.made
  source.emit('snapshot')
  while (source.made === before) await Bun.sleep(5)
  return source.made
}

describe('snapshots under many changes', () => {
  // a screen is on: it is the one the server builds and spaces them for
  let screen: WebSocket
  beforeAll(async () => {
    screen = (await connect()).ws
  })
  afterAll(() => closed(screen))

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

  test('each is named to the stall watch', async () => {
    const made = source.made
    const named = labels.filter((l) => l === 'snapshot').length
    source.cost = 0
    await burst(300) // no screen comes or goes meanwhile: every one of these is a timer's
    await Bun.sleep(100)
    expect(labels.filter((l) => l === 'snapshot').length - named).toBe(source.made - made)
    expect(source.made - made).toBeGreaterThan(0) // the burst above made some, and each of those was named
  })
})

describe('with no screen connected', () => {
  test('a change builds nothing at all, and the first screen to open gets one at once', async () => {
    source.cost = 0
    const made = source.made
    const named = labels.length
    for (let i = 0; i < 5; i++) {
      source.emit('snapshot')
      await Bun.sleep(20)
    }
    await Bun.sleep(300) // past the wait a build would have kept
    expect(source.made).toBe(made)
    // not even one the stall watch would have had to account for
    expect(labels.length).toBe(named)
    const { ws, got } = await connect()
    expect(source.made).toBe(made + 1) // its own, made as it opens
    expect(got.find((m) => m.type === 'snapshot')).toBeTruthy()
    await closed(ws)
  })

  test('a screen that opens in the gap gets a snapshot at once, and the spacing goes on', async () => {
    // a costly build sets the spacing: the next one waits nearly a second
    const { ws: first } = await connect()
    source.cost = 250
    const built = await madeOnce()
    source.cost = 0
    source.emit('snapshot')
    const { ws, got } = await connect() // a second screen opens inside that gap
    expect(source.made).toBe(built + 1) // its own, made as it opens
    expect(got.find((m) => m.type === 'snapshot')).toBeTruthy()
    await closed(ws)
    expect(source.made).toBe(built + 1) // and nothing was built early for the one that opened
    await Bun.sleep(1100) // the spaced one comes due, for the screen still on
    expect(source.made).toBe(built + 2)
    await closed(first)
  })

  test('the last screen leaving while a build waits means that build is not made', async () => {
    const { ws } = await connect()
    source.cost = 250
    const built = await madeOnce() // that one is made, at 250 ms
    source.cost = 0
    source.emit('snapshot') // the next one waits about a second, from when that build ended
    await closed(ws) // gone before it comes due
    await Bun.sleep(1200)
    expect(source.made).toBe(built)
  })

  test('a link to another machine is a watcher like a screen: its mirror stays fresh', async () => {
    source.cost = 0
    const { ws, got } = await connect({ link: true })
    const made = source.made
    source.emit('snapshot')
    await Bun.sleep(200)
    expect(source.made).toBeGreaterThan(made)
    expect(got.filter((m) => m.type === 'snapshot').length).toBeGreaterThan(1) // the change reached it, not only the open
    await closed(ws)
  })
})
