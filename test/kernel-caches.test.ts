// A tab open for days kept the last full chat of every place it ever watched and the last full ANSI screen of every
// terminal (PERFC-06). On the next watch change the store drops what it no longer shows, except chats the outbox still
// settles. A socket of its own and a two-place snapshot stand in for the browser and for navigating between places.
import { describe, expect, test } from 'bun:test'
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
  history: { state: null, replaceState: noop, pushState: noop, back: noop, forward: noop },
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

const kernel = await import('../src/kernel.ts')
kernel.connect()
const socket = sockets.at(-1)
if (!socket) throw new Error('connect opened no socket')
socket.onopen?.()

const first = { id: 'all', name: 'all', machine: 'm', level: 0, status: 'idle', mode: 'regular', chat: 'p:m:~' } as const
const second = { id: 'two', name: 'two', machine: 'm', level: 2, status: 'idle', mode: 'regular', chat: 'p:m:other' } as const
const snapshot = (rev: number): Snapshot => ({
  rev,
  name: 'Shepherdr',
  host: 'm',
  places: [{ ...first }, { ...second }],
  machines: [],
  tasks: [],
  automations: {},
  artifacts: [],
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
const pushSnap = (rev: number) => socket.onmessage?.({ data: JSON.stringify({ type: 'snapshot', snapshot: snapshot(rev) }) })
const pushChat = (c: Chat) => socket.onmessage?.({ data: JSON.stringify({ type: 'chat', chat: c }) })
const pushTerm = (key: string, ansi: string) => socket.onmessage?.({ data: JSON.stringify({ type: 'terminal', chat: key, ansi, cols: 80, rows: 24 }) })
const visible = () => {
  const snap = kernel.getState().snap
  return snap ? kernel.visibleChats(kernel.getState().ui, snap) : []
}

describe('the client caches', () => {
  test('a chat that is no longer watched is gone on the next watch change', () => {
    kernel.setUI({ place: 'all' })
    pushSnap(1)
    const stale = 'p:m:stale'
    pushChat(chat(stale, 'hello'))
    expect(kernel.getState().chats[stale]).toBeDefined()

    // navigating to the other place changes the watched key set, which is when the store trims
    kernel.setUI({ place: 'two' })
    expect(visible()).toEqual(['p:m:other'])
    expect(kernel.getState().chats[stale]).toBeUndefined()
  })

  test('a chat the outbox still needs stays even though it is no longer watched', () => {
    kernel.setUI({ place: 'all' })
    pushSnap(2)
    const pending = 'p:m:pending'
    const out: Outgoing = { cid: 'c-pending', chat: pending, text: 'hi', files: [], at: 1, state: 'sent' }
    kernel.setOutbox(() => [out])
    pushChat(chat(pending, 'hi'))
    expect(kernel.getState().outbox.some((o) => o.cid === 'c-pending')).toBe(true)

    kernel.setUI({ place: 'two' })
    expect(kernel.getState().chats[pending]).toBeDefined()
    kernel.setOutbox(() => [])
  })

  test('kept chats keep their identity, and an evicted one comes back with the same messages', () => {
    kernel.setUI({ place: 'all' })
    pushSnap(3)
    const shown = visible()[0]
    pushChat(chat(shown, 'shown'))
    const before = kernel.getState().chats[shown]
    kernel.setPushEndpoint('push-1')
    expect(kernel.getState().chats[shown]).toBe(before)

    const again = 'p:m:again'
    pushChat(chat(again, 'same text'))
    kernel.setPushEndpoint('push-2')
    expect(kernel.getState().chats[again]).toBeUndefined()
    pushChat(chat(again, 'same text'))
    expect(kernel.getState().chats[again]?.messages[0]?.text).toBe('same text')
  })

  test('a terminal screen no longer watched goes; the one still shown stays', () => {
    kernel.setUI({ place: 'all', term: null })
    pushSnap(4)
    const shown = visible()[0]
    const old = 'p:m:old-term'
    pushTerm(shown, 'here now')
    pushTerm(old, 'long gone')
    expect(kernel.getState().terms[old]).toBeDefined()

    kernel.setPushEndpoint('push-3')
    expect(kernel.getState().terms[shown]?.ansi).toBe('here now')
    expect(kernel.getState().terms[old]).toBeUndefined()
  })

  test('fifty browsed chats leave no trace after a watch change', () => {
    kernel.setUI({ place: 'all', term: null })
    pushSnap(5)
    const browsed = Array.from({ length: 50 }, (_, i) => `p:m:browse-${i}`)
    for (const key of browsed) pushChat(chat(key, 'a day of browsing'))
    const before = browsed.filter((k) => kernel.getState().chats[k]).length
    kernel.setPushEndpoint('push-4')
    const after = browsed.filter((k) => kernel.getState().chats[k]).length
    expect(before).toBe(50)
    expect(after).toBe(0)
  })
})
