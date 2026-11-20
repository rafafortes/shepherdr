// The screen keeps the full chat it got when it started watching and applies the deltas that follow to it (PERFC-03).
// A socket of its own stands in for the browser: push a full chat, then a delta, and compare what the store holds with
// what the same chat looks like when it arrives whole. A reconnect's full chat replaces the base.
import { describe, expect, test } from 'bun:test'
import type { Chat, Message } from '../shared/types.ts'

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
const opened = () => {
  kernel.connect()
  const socket = sockets.at(-1)
  if (!socket) throw new Error('connect opened no socket')
  socket.onopen?.()
  return socket
}
let socket = opened()

const KEY = 'p:m:apply'
const OTHER = 'p:m:whole'
const msg = (id: string, more: Partial<Message> = {}): Message => ({ id, who: 'agent', at: 1000 + Number(id.slice(1) || 0), text: `line ${id}`, ...more })
const chat = (key: string, messages: Message[]): Chat => ({ key, messages, cli: 'claude' })
const full = (key: string, messages: Message[], through: number) => socket.onmessage?.({ data: JSON.stringify({ type: 'chat', chat: chat(key, messages), through }) })
const delta = (messages: Message[], changes: { id: string; patch: Partial<Message> }[], through: number, key = KEY) =>
  socket.onmessage?.({
    data: JSON.stringify({
      type: 'chat-delta',
      chat: chat(key, []),
      added: messages,
      changed: changes,
      through,
    }),
  })
const shown = (key = KEY) => kernel.getState().chats[key]

describe('applying a chat delta', () => {
  test('an added row and a changed flag render exactly as the whole chat', () => {
    const base = [msg('m1'), msg('m2')]
    full(KEY, base, 1)
    const expected = [msg('m1'), msg('m2', { answered: 'Answered “Merge it?”' }), msg('m3')]
    delta([msg('m3')], [{ id: 'm2', patch: { answered: 'Answered “Merge it?”' } }], 2)
    expect(shown()?.messages).toEqual(expected)

    // the other path: the same messages in one full push, as an older peer or a fresh watch would receive them
    full(OTHER, expected, 3)
    expect(shown(KEY)?.messages).toEqual(shown(OTHER)?.messages)
  })

  test('a field that went away goes away on screen too', () => {
    full(KEY, [msg('m1')], 4)
    const withWork: Chat = { ...chat(KEY, [msg('m1')]), working: true, live: { id: 'turn-1', at: 1, rows: [], steps: 1 } }
    socket.onmessage?.({ data: JSON.stringify({ type: 'chat', chat: withWork, through: 5 }) })
    expect(shown()?.working).toBe(true)
    expect(shown()?.live?.id).toBe('turn-1')
    // the agent stopped: the next delta carries the chat with those fields absent
    socket.onmessage?.({
      data: JSON.stringify({ type: 'chat-delta', chat: chat(KEY, []), added: [], changed: [], through: 6 }),
    })
    expect(shown()?.working).toBeUndefined()
    expect(shown()?.live).toBeUndefined()
  })

  test('a new row that sorts before an old one lands in its place', () => {
    full(KEY, [msg('m1'), msg('m3')], 7)
    delta([msg('m2', { at: 1002 })], [], 8)
    expect(shown()?.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  test('a terminal menu stays ahead of the queued rows it belongs to', () => {
    const menu: Message = { id: 'menu-1', who: 'agent', at: 2000, question: { id: 'menu-1', title: 'Pick one', kind: 'Form', choices: [], to: 'Agent', terminal: true } }
    const waiting: Message = { id: 'w1', who: 'you', at: 1500, text: 'typed while the menu was up', waiting: true }
    full(KEY, [msg('m1'), menu, waiting], 9)
    // the server appends a new log row after the built rows and before the menu/queue tail
    delta([msg('m4', { at: 3000 })], [], 10)
    expect(shown()?.messages.map((m) => m.id)).toEqual(['m1', 'm4', 'menu-1', 'w1'])
  })

  test('a delta for a chat with no full base is left alone', () => {
    const unknown = 'p:m:never-watched'
    socket.onmessage?.({ data: JSON.stringify({ type: 'chat-delta', chat: chat(unknown, []), added: [msg('m9')], changed: [], through: 9 }) })
    expect(shown(unknown)).toBeUndefined()
  })

  test('a delta already applied, or one from before a reconnect, changes nothing', () => {
    full(KEY, [msg('m1')], 10)
    delta([msg('m2')], [], 10) // same sequence: already seen
    expect(shown()?.messages.map((m) => m.id)).toEqual(['m1'])
    delta([msg('m3')], [], 9) // older still
    expect(shown()?.messages.map((m) => m.id)).toEqual(['m1'])
  })

  test('a reconnect brings a full chat first, and the deltas after it apply to that base', () => {
    full(KEY, [msg('m1')], 11)
    // the socket came back: a fresh watch gets the whole chat, which becomes the new base
    socket = opened()
    full(KEY, [msg('m1'), msg('m2')], 12)
    expect(shown()?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    delta([], [{ id: 'm2', patch: { answered: 'Answered' } }], 13)
    expect(shown()?.messages).toEqual([msg('m1'), msg('m2', { answered: 'Answered' })])
  })

  test('a hidden tab keeps a delta that arrives with no full chat buffered', () => {
    full(KEY, [msg('m1')], 14)
    doc.visibilityState = 'hidden'
    delta([msg('m2')], [], 15)
    expect(shown()?.messages.map((m) => m.id)).toEqual(['m1'])
    doc.visibilityState = 'visible'
    for (const fn of listeners.get('visibilitychange') ?? []) fn({})
    expect(shown()?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  test('a hidden tab folds a delta into the chat it buffers, and applies both on wake', () => {
    full(KEY, [msg('m1')], 12)
    doc.visibilityState = 'hidden'
    // nothing reaches the store while the tab is away (PERFC-07): the delta is folded into the buffered full chat
    const before = shown()
    full(KEY, [msg('m1'), msg('m2'), msg('m3')], 16)
    delta([], [{ id: 'm1', patch: { answered: 'Answered' } }], 17)
    expect(shown()).toBe(before)
    doc.visibilityState = 'visible'
    for (const fn of listeners.get('visibilitychange') ?? []) fn({})
    expect(shown()?.messages).toEqual([msg('m1', { answered: 'Answered' }), msg('m2'), msg('m3')])
  })
})
