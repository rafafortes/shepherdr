// A snapshot whose revision the server did not advance says what the screen already drew: the store keeps the object,
// every picker keeps its identity and no subscriber is told to look again. That is the whole cost of the 30-second
// heartbeat, which pushes a snapshot whether or not anything changed (PERFC-01). The revision comes from the server;
// here the screen is given a socket of its own and a clock that can stand in for the next heartbeat.
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import type { Artifact, Chat, Place, Snapshot, Task } from '../shared/types.ts'

const stored = new Map<string, string>()
const storage = {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => void stored.set(k, v),
  removeItem: (k: string) => void stored.delete(k),
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
  document: { head: { innerHTML: '' }, addEventListener: noop, activeElement: null, visibilityState: 'visible' },
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

// the modules read the globals above as they load, so they are imported after the stubs are in place
const kernel = await import('../src/kernel.ts')
kernel.connect()
const socket = sockets.at(-1)
if (!socket) throw new Error('connect opened no socket')
socket.onopen?.()

const place: Place = { id: 'all', name: 'all', machine: 'm', level: 0, status: 'idle', mode: 'regular', chat: 'p:m:~' }
const artifact: Artifact = { id: 'a', title: 'Board', place: place.id, v: 1, at: 1, when: 'now', by: 'you', keeper: 'you', versions: [] }
const task: Task = { id: 'T-1', name: 'A task', status: 'work', place: place.id, base: 'main' } as Task
const snapshot = (rev: number): Snapshot => ({
  rev,
  name: 'Shepherdr',
  host: 'm',
  places: [place],
  machines: [],
  tasks: [],
  automations: {},
  artifacts: [artifact],
  asks: {},
  needs: [],
  settings: [],
  user: 'you',
})
/** push one snapshot; the result is the object the store now holds (the socket's JSON parse made it a fresh one) */
const push = (snap: Snapshot): Snapshot => {
  socket.onmessage?.({ data: JSON.stringify({ type: 'snapshot', snapshot: snap }) })
  return onScreen()
}
/** the snapshot on screen, once one has arrived */
const onScreen = () => {
  const s = kernel.getState().snap
  if (!s) throw new Error('no snapshot on screen')
  return s
}
const pushChat = () => socket.onmessage?.({ data: JSON.stringify({ type: 'chat', chat: { key: place.chat, messages: [], cli: 'claude' } satisfies Chat }) })

let notified = 0
const off = kernel.subscribeStore(() => notified++)

describe('the store on a snapshot push', () => {
  test('a new revision takes the snapshot and tells its subscribers', () => {
    notified = 0
    const first = push(snapshot(1))
    expect(kernel.getState().snap).toBe(first)
    expect(notified).toBe(1)
  })

  test('an unchanged revision keeps the object and tells nobody, even with a chat push in between', () => {
    const first = onScreen()
    notified = 0
    pushChat() // chat data travels in its own message, not by replacing the snapshot
    expect(notified).toBe(1)
    const afterChat = onScreen()
    expect(afterChat).toBe(first)

    notified = 0
    push({ ...snapshot(1), last: { [place.chat]: 42 } }) // the 30 s heartbeat: same content, same revision
    expect(kernel.getState().snap).toBe(first)
    expect(onScreen().artifacts).toBe(first.artifacts)
    expect(notified).toBe(0)
  })

  test('the next heartbeat, thirty seconds later by a stub clock, still redraws nothing', () => {
    const first = onScreen()
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000)
    try {
      notified = 0
      push(snapshot(1))
      expect(kernel.getState().snap).toBe(first)
      expect(notified).toBe(0)
    } finally {
      clock.mockRestore()
    }
  })

  test('a changed revision updates the screen and replaces the lists', () => {
    const first = onScreen()
    notified = 0
    const next = push({ ...snapshot(2), tasks: [task] })
    expect(kernel.getState().snap).toBe(next)
    expect(kernel.getState().snap).not.toBe(first)
    expect(notified).toBe(1)
  })

  test('a source with no revision is taken as new, as an older server', () => {
    notified = 0
    const next = snapshot(0)
    delete next.rev
    const received = push(next)
    expect(kernel.getState().snap).toBe(received)
    expect(notified).toBe(1)
  })
})

afterAll(() => off())
