// The link layer owns the socket, its retry and the push endpoint. A dropped socket must be tried again and the new
// one must send the same watch message - including this device's push subscription - or alerts stop being suppressed
// while the app is on screen. A socket of its own stands in for the browser (as in kernel-hidden.test.ts); the timers
// the link sets are caught and run by hand so the retry, the lost-link notice and the build reload need no clock.
import { describe, expect, spyOn, test } from 'bun:test'
import type { Chat, Snapshot } from '../shared/types.ts'

const stored = new Map<string, string>()
const storage = {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => void stored.set(k, v),
  removeItem: (k: string) => void stored.delete(k),
}
const noop = () => {}
const listeners = new Map<string, ((e: unknown) => void)[]>()
const doc = {
  head: { innerHTML: '<script src="/assets/index.abc123.js"></script>' },
  activeElement: null,
  visibilityState: 'visible',
  addEventListener: (name: string, fn: (e: unknown) => void) => {
    const list = listeners.get(name) ?? []
    list.push(fn)
    listeners.set(name, list)
  },
  removeEventListener: noop,
}
class Socket {
  static OPEN = 1
  readyState = 1
  sent: string[] = []
  url: unknown
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(url: unknown) {
    this.url = url
  }
  send(s: string) {
    this.sent.push(s)
  }
  close() {}
}
const sockets: Socket[] = []
Object.assign(globalThis, {
  location: { search: '', href: 'http://localhost/', pathname: '/', reload: noop },
  localStorage: storage,
  sessionStorage: storage,
  innerWidth: 1280,
  history: { state: null, replaceState: noop, pushState: noop },
  document: doc,
  addEventListener: noop,
  dispatchEvent: noop,
  matchMedia: () => ({ matches: false }),
  WebSocket: class extends Socket {
    constructor(url: unknown) {
      super(url)
      sockets.push(this)
    }
  },
})

const link = await import('../src/link.ts')
const kernel = await import('../src/kernel.ts')

/** run the timers the link schedules at one delay while `during` runs, then fire them; `bump` ages the clock */
function fireTimers(delay: number, during: () => void, bump = 0) {
  const pending: (() => void)[] = []
  const realTimeout = globalThis.setTimeout
  const realNow = Date.now
  let extra = 0
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === delay) {
      pending.push(() => cb(...args))
      return pending.length as unknown as ReturnType<typeof setTimeout>
    }
    return realTimeout(cb as never, ms, ...args)
  }) as typeof setTimeout)
  const nowSpy = spyOn(Date, 'now').mockImplementation(() => realNow() + extra)
  try {
    during()
    extra = bump
    for (const run of [...pending]) run()
  } finally {
    timerSpy.mockRestore()
    nowSpy.mockRestore()
  }
}

const fire = (name: string) => {
  for (const fn of listeners.get(name) ?? []) fn({ type: name })
}
const lastSocket = () => {
  const sock = sockets.at(-1)
  if (!sock) throw new Error('connect opened no socket')
  return sock
}
const watchOf = (sock: Socket) => JSON.parse(sock.sent.filter((s) => s.includes('"type":"watch"')).at(-1) ?? 'null')
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await Bun.sleep(5)
  if (!f()) throw new Error('timed out waiting for the link')
}

const place = { id: 'all', name: 'all', machine: 'm', level: 0, status: 'idle', mode: 'regular', chat: 'p:m:~' } as const
const snapshot: Snapshot = {
  rev: 1,
  name: 'Shepherdr',
  host: 'm',
  places: [{ ...place }],
  machines: [],
  tasks: [],
  automations: {},
  artifacts: [],
  asks: {},
  needs: [],
  settings: [],
  user: 'you',
}
const chat = (key: string): Chat => ({ key, messages: [{ id: 'm1', who: 'agent', text: 'base' }], cli: 'claude' })

describe('the link', () => {
  test('a dropped socket retries and the new one re-registers the push endpoint with the same watch', async () => {
    link.connect()
    const first = lastSocket()
    first.onopen?.()
    first.onmessage?.({ data: JSON.stringify({ type: 'snapshot', snapshot }) })

    expect(watchOf(first)).toMatchObject({ type: 'watch', push: null })

    link.setPushEndpoint('device-push-key')
    const before = watchOf(first)
    expect(before).toMatchObject({ type: 'watch', push: 'device-push-key' })

    const n = sockets.length
    first.onclose?.()
    await until(() => sockets.length > n)
    const second = lastSocket()
    second.onopen?.()
    await until(() => watchOf(second) !== null)

    expect(second).not.toBe(first)
    expect(watchOf(second)).toEqual(before)
  })

  test('keeps the capability and folds a chat held back while hidden through the live apply path', () => {
    link.connect()
    const sock = lastSocket()
    sock.onopen?.()
    sock.onmessage?.({ data: JSON.stringify({ type: 'capability', capability: 'per-boot-cap' }) })

    const key = 'p:m:delta'
    sock.onmessage?.({ data: JSON.stringify({ type: 'chat', chat: chat(key) }) })
    doc.visibilityState = 'hidden'
    sock.onmessage?.({
      data: JSON.stringify({
        type: 'chat-delta',
        chat: { key, messages: [] },
        added: [{ id: 'm2', who: 'agent', text: 'added' }],
        changed: [{ id: 'm1', patch: { text: 'patched' } }],
        through: 2,
      }),
    })
    // a full chat and a terminal held back alongside the delta take the same buffer
    sock.onmessage?.({ data: JSON.stringify({ type: 'chat', chat: chat('p:m:full-hidden') }) })
    sock.onmessage?.({ data: JSON.stringify({ type: 'terminal', chat: key, ansi: 'hidden', cols: 80, rows: 24 }) })
    doc.visibilityState = 'visible'
    fireTimers(1500, () => fire('visibilitychange'))

    const applied = kernel.getState().chats[key]
    expect(applied?.messages.map((m) => m.text)).toEqual(['patched', 'added'])
    expect(kernel.getState().chats['p:m:full-hidden']?.messages[0]?.text).toBe('base')
    expect(kernel.getState().terms[key]?.ansi).toBe('hidden')
  })

  test('folds a delta straight into a chat on a visible tab', () => {
    link.connect()
    const sock = lastSocket()
    sock.onopen?.()
    const key = 'p:m:visible-delta'
    sock.onmessage?.({ data: JSON.stringify({ type: 'chat', chat: chat(key) }) })
    sock.onmessage?.({
      data: JSON.stringify({ type: 'chat-delta', chat: { key, messages: [] }, added: [{ id: 'm2', who: 'agent', text: 'live' }], changed: [], through: 2 }),
    })
    expect(kernel.getState().chats[key]?.messages.map((m) => m.text)).toEqual(['base', 'live'])
  })

  test('says the link is gone, and a wake starts a fresh try with the notice cleared', async () => {
    link.connect()
    const sock = lastSocket()
    sock.onopen?.()
    const n = sockets.length

    // the first notice fires while the socket is gone, so the top line says offline
    fireTimers(3000, () => sock.onclose?.())
    expect(kernel.getState().ui.offline).not.toBeNull()
    await until(() => sockets.length > n)
    const dead = lastSocket()
    dead.readyState = 3
    await Bun.sleep(1050) // past the guard that keeps a just-made try

    // a slept timer starts over, and the wake goes through the reconnect path
    fireTimers(3000, () => fire('visibilitychange'), 5000)
    await until(() => sockets.length > n + 1)
    expect(kernel.getState().ui.offline).toBeNull()
  })

  test('drops an open link that stops answering a ping', async () => {
    link.connect()
    const sock = lastSocket()
    sock.onopen?.()
    const n = sockets.length

    fireTimers(1500, () => fire('visibilitychange'))
    expect(sock.sent.some((s) => s.includes('"type":"ping"'))).toBe(true)
    await until(() => sockets.length > n)
  })

  test('reloads the screen when the server announces a new build', () => {
    link.connect()
    const sock = lastSocket()
    sock.onopen?.()

    const held: { tick: (() => void) | null } = { tick: null }
    const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => {
      held.tick = fn
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval)
    try {
      sock.onmessage?.({ data: JSON.stringify({ type: 'build', id: 'assets/new.xyz.js' }) })
      const run = held.tick
      if (!run) throw new Error('the build did not start a reload')
      run()
    } finally {
      intervalSpy.mockRestore()
    }
    expect(stored.has('shepherdr.kept')).toBe(true)
  })
})
