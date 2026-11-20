// A hidden tab keeps doing full work on every per-second chat push: it parses it, replaces the store's chat and runs
// every React subscriber even though nothing is painted (PERFC-07). The tab now holds back the frequent messages —
// the latest chat per key and one terminal — and applies them together on wake, through the same path a live push
// takes so the outbox still settles. Snapshots stay live: the alerts plugin reads the wait count from them to keep
// the icon's badge and the window title right while the tab is away, and the service worker owns its own path.
// A socket of its own and a visibility stub stand in for the browser and the tab switching (as kernel-snapshot does).
import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { Chat, Snapshot } from '../shared/types.ts'
import type { Outgoing } from '../src/outbox.ts'

const stored = new Map<string, string>()
const storage = {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => void stored.set(k, v),
  removeItem: (k: string) => void stored.delete(k),
}
const listeners = new Map<string, ((e: unknown) => void)[]>()
const doc = {
  head: { innerHTML: '' },
  activeElement: null,
  visibilityState: 'visible',
  addEventListener: (name: string, fn: (e: unknown) => void) => {
    const list = listeners.get(name) ?? []
    list.push(fn)
    listeners.set(name, list)
  },
  removeEventListener: () => {},
}
class Socket {
  static OPEN = 1
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  send(s: string) {
    this.sent.push(s)
  }
  close() {}
}
const sockets: Socket[] = []
const noop = () => {}
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
      super()
      void url
      sockets.push(this)
    }
  },
})

// Count the settle calls the held-back chats make on wake: the proof that they go through the live apply path. The
// kernel imports the same module by its own path; mocking it here (before the kernel loads) wraps that one binding.
const outbox = await import('../src/outbox.ts')
let settles = 0
const realSettle = outbox.settle
mock.module('../src/outbox.ts', () => ({
  ...outbox,
  settle: (...args: Parameters<typeof outbox.settle>) => {
    settles++
    return realSettle(...args)
  },
}))

const kernel = await import('../src/kernel.ts')
kernel.connect()
const socket = sockets.at(-1)
if (!socket) throw new Error('connect opened no socket')
socket.onopen?.()

/** switch the tab and fire the real visibilitychange listeners the kernel registered */
const setVisible = (visible: boolean) => {
  doc.visibilityState = visible ? 'visible' : 'hidden'
  for (const fn of listeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' })
}

const place = { id: 'all', name: 'all', machine: 'm', level: 0, status: 'idle', mode: 'regular', chat: 'p:m:~' } as const
const artifact = { id: 'a', title: 'Board', place: place.id, v: 1, at: 1, when: 'now', by: 'you', keeper: 'you', versions: [] } as const
const snapshot = (rev: number): Snapshot => ({
  rev,
  name: 'Shepherdr',
  host: 'm',
  places: [{ ...place }],
  machines: [],
  tasks: [],
  automations: {},
  artifacts: [{ ...artifact, versions: [] }],
  asks: {},
  needs: [],
  settings: [],
  user: 'you',
})
const chat = (key: string, text: string, cid?: string): Chat => ({
  key,
  messages: [{ id: `m-${text}`, who: 'you', text, ...(cid ? { cid } : {}) }],
  cli: 'claude',
})
const pushChat = (c: Chat) => socket.onmessage?.({ data: JSON.stringify({ type: 'chat', chat: c }) })
const pushTerm = (key: string, ansi: string) => socket.onmessage?.({ data: JSON.stringify({ type: 'terminal', chat: key, ansi, cols: 80, rows: 24 }) })
const pushSnap = (s: Snapshot) => socket.onmessage?.({ data: JSON.stringify({ type: 'snapshot', snapshot: s }) })

let notified = 0
const off = kernel.subscribeStore(() => notified++)

describe('a hidden tab', () => {
  test('a visible tab applies every push (the cost the hidden tab avoids)', () => {
    const a = 'p:m:live-a'
    const b = 'p:m:live-b'
    setVisible(true)
    notified = 0
    settles = 0

    pushChat(chat(a, 'one'))
    pushChat(chat(a, 'two'))
    pushChat(chat(b, 'three'))

    // the before picture, measured the same way as the hidden ones below: three pushes, three redraws, three settles
    expect(notified).toBe(3)
    expect(settles).toBe(3)
  })

  test('defers a pushed chat until visibilitychange', () => {
    const key = 'p:m:hidden-1'
    setVisible(false)
    notified = 0
    expect(kernel.getState().chats[key]).toBeUndefined()

    pushChat(chat(key, 'first'))

    // the store did not change and no subscriber was told to redraw while the tab is hidden
    expect(kernel.getState().chats[key]).toBeUndefined()
    expect(notified).toBe(0)

    setVisible(true)

    expect(kernel.getState().chats[key]?.messages[0]?.text).toBe('first')
    expect(notified).toBe(1)
  })

  test('settles the buffered chat exactly once, through the live apply path, on wake', () => {
    const key = 'p:m:hidden-2'
    const out: Outgoing = { cid: 'c-2', chat: key, text: 'hi', files: [], at: 1, state: 'sent' }
    kernel.setOutbox(() => [out])
    setVisible(false)
    notified = 0
    settles = 0

    pushChat(chat(key, 'hi', 'c-2'))

    expect(kernel.getState().outbox.some((o) => o.cid === 'c-2')).toBe(true)
    expect(settles).toBe(0)
    expect(notified).toBe(0)

    setVisible(true)

    expect(kernel.getState().outbox.some((o) => o.cid === 'c-2')).toBe(false)
    expect(settles).toBe(1)
    expect(notified).toBe(1)
  })

  test('loses no message: the latest per key, and every key, is applied on wake', () => {
    const a = 'p:m:hidden-3a'
    const b = 'p:m:hidden-3b'
    setVisible(false)
    notified = 0
    settles = 0

    // several pushes for one key, and one for another: the tab keeps only the latest of each
    pushChat(chat(a, 'older'))
    pushChat(chat(a, 'latest'))
    pushChat(chat(b, 'other'))

    expect(kernel.getState().chats[a]).toBeUndefined()
    expect(kernel.getState().chats[b]).toBeUndefined()
    expect(notified).toBe(0)
    expect(settles).toBe(0)

    setVisible(true)

    expect(kernel.getState().chats[a]?.messages[0]?.text).toBe('latest')
    expect(kernel.getState().chats[b]?.messages[0]?.text).toBe('other')
    // three pushes became one redraw and two settles, one per key actually applied
    expect(notified).toBe(1)
    expect(settles).toBe(2)
  })

  test('defers a terminal push and applies it on wake', () => {
    const key = 'p:m:hidden-4'
    setVisible(false)
    notified = 0
    expect(kernel.getState().terms[key]).toBeUndefined()

    pushTerm(key, 'while away')

    expect(kernel.getState().terms[key]).toBeUndefined()
    expect(notified).toBe(0)

    setVisible(true)

    expect(kernel.getState().terms[key]?.ansi).toBe('while away')
    expect(notified).toBe(1)
  })

  test('applies a chat and a terminal buffered together in one redraw', () => {
    const key = 'p:m:hidden-5'
    setVisible(false)
    notified = 0

    pushChat(chat(key, 'together'))
    pushTerm(key, 'screen')

    expect(kernel.getState().chats[key]).toBeUndefined()
    expect(kernel.getState().terms[key]).toBeUndefined()
    expect(notified).toBe(0)

    setVisible(true)

    expect(kernel.getState().chats[key]?.messages[0]?.text).toBe('together')
    expect(kernel.getState().terms[key]?.ansi).toBe('screen')
    expect(notified).toBe(1)
  })

  test('a wake while still hidden leaves the buffer for the real one', () => {
    const key = 'p:m:hidden-6'
    setVisible(false)
    notified = 0
    pushChat(chat(key, 'still away'))

    // another visibilitychange while the document is hidden (a wake from 'online', say) must not flush
    for (const fn of listeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' })
    expect(kernel.getState().chats[key]).toBeUndefined()
    expect(notified).toBe(0)

    setVisible(true)

    expect(kernel.getState().chats[key]?.messages[0]?.text).toBe('still away')
    expect(notified).toBe(1)
  })

  test('still applies snapshots while hidden, so the badge count and the service worker stay right', () => {
    kernel.setOutbox(() => [])
    setVisible(false)
    notified = 0

    pushSnap(snapshot(1))

    expect(kernel.getState().snap?.rev).toBe(1)
    expect(notified).toBe(1)

    notified = 0
    pushSnap(snapshot(2))

    expect(kernel.getState().snap?.rev).toBe(2)
    expect(notified).toBe(1)
    setVisible(true)
  })
})

afterAll(() => off())
