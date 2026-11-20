// The wire itself, on a real websocket against a live source with herdr standing in (PERFC-03): the first watch gets
// the whole chat, the pushes after it carry only what moved, a reconnect starts over with a whole one, and an older
// machine on the link path keeps getting whole chats.
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('chat-delta-ws')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN

const { LiveSource } = await import('../server/live/source.ts')
const { startApp } = await import('../server/app.ts')
const { fakeHerdr } = await import('./fake-herdr.ts')
import type { Chat, Message, ServerEvent } from '../shared/types.ts'

const src = new LiveSource()
const fake = fakeHerdr()
void fake // the stand-in owns a herdr-shaped worktree API; no agent is launched in this test
const app = startApp({ source: src, dist: '/nonexistent', port: 0 })
afterAll(() => {
  app.stop(true)
  src.stop()
})

const KEY = 'p:m:wire'
const msg = (id: string, more: Partial<Message> = {}): Message => ({ id, who: 'agent', at: 1000 + Number(id.slice(1) || 0), text: `line ${id}`, ...more })
let current: Chat = { key: KEY, messages: [msg('m1'), msg('m2')], cli: 'claude' }
spyOn(src.chats, 'chat').mockImplementation(() => current)

type ChatEvent = Extract<ServerEvent, { type: 'chat' }> | Extract<ServerEvent, { type: 'chat-delta' }>
async function screen(link = false) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/api/ws`)
  const seen: ChatEvent[] = []
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as ServerEvent
    if ((m.type === 'chat' || m.type === 'chat-delta') && m.chat.key === KEY) seen.push(m)
  }
  await new Promise<void>((r) => (ws.onopen = () => r()))
  ws.send(JSON.stringify({ type: 'watch', chats: [KEY], term: null, visible: true, push: null, link }))
  return { ws, seen }
}
async function nextChat(seen: ChatEvent[], from: number): Promise<ChatEvent> {
  for (let i = 0; i < 1000 && seen.length <= from; i++) await Bun.sleep(5)
  const got = seen[from]
  if (!got) throw new Error('no chat push arrived')
  return got
}
const change = (messages: Message[]) => {
  current = { ...current, messages }
  src.emit('chat', KEY)
}

describe('chat pushes over the wire', () => {
  test('a first watch gets the whole chat, then deltas carry only what moved', async () => {
    const { ws, seen } = await screen()
    try {
      const first = await nextChat(seen, 0)
      expect(first.type).toBe('chat')
      expect('added' in first).toBe(false)
      expect(first.chat.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
      expect(first.through).toBeGreaterThan(0)

      change([msg('m1'), msg('m2'), msg('m3')])
      const added = await nextChat(seen, 1)
      // its own event type: a screen on the previous build ignores it and keeps the chat it has
      expect(added.type).toBe('chat-delta')
      expect('added' in added).toBe(true)
      if (!('added' in added)) throw new Error('not a delta')
      expect(added.added).toEqual([msg('m3')])
      expect(added.changed).toEqual([])
      expect(added.chat.messages).toEqual([])
      expect(added.through).toBe((first.through ?? 0) + 1)

      change([msg('m1'), msg('m2', { answered: 'Answered' }), msg('m3')])
      const patch = await nextChat(seen, 2)
      if (!('changed' in patch)) throw new Error('not a delta')
      expect(patch.added).toEqual([])
      expect(patch.changed).toEqual([{ id: 'm2', patch: { answered: 'Answered' } }])
    } finally {
      ws.close()
    }
  })

  test('a second screen subscribing resets every screen to the same full base', async () => {
    current = { key: KEY, messages: [msg('m1')], cli: 'claude' }
    const a = await screen()
    try {
      expect('added' in (await nextChat(a.seen, 0))).toBe(false)
      change([msg('m1'), msg('m2')])
      expect('added' in (await nextChat(a.seen, 1))).toBe(true)
      // a new screen's watch sends the whole chat to both, so their bases agree before the next delta
      const b = await screen()
      try {
        const toB = await nextChat(b.seen, 0)
        const toA = await nextChat(a.seen, 2)
        expect(toA.type).toBe('chat')
        expect(toB.type).toBe('chat')
        expect(toA.through).toBe(toB.through)
        expect(toA.chat.messages).toEqual(toB.chat.messages)
        change([msg('m1'), msg('m2'), msg('m3')])
        const next = await nextChat(a.seen, 3)
        if (!('added' in next)) throw new Error('not a delta')
        expect(next.added).toEqual([msg('m3')])
      } finally {
        b.ws.close()
      }
    } finally {
      a.ws.close()
    }
  })

  test('a machine on the link path keeps receiving the whole chat', async () => {
    const { ws, seen } = await screen(true)
    try {
      const first = await nextChat(seen, 0)
      expect('added' in first).toBe(false)
      change([msg('m1'), msg('m2', { answered: 'Answered' }), msg('m3')])
      const second = await nextChat(seen, 1)
      expect('added' in second).toBe(false)
      expect(second.chat.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    } finally {
      ws.close()
    }
  })

  test('a reconnect starts with the whole chat, and only then resumes deltas', async () => {
    current = { key: KEY, messages: [msg('m1'), msg('m2')], cli: 'claude' }
    const { ws, seen } = await screen()
    try {
      expect('added' in (await nextChat(seen, 0))).toBe(false)
      change([msg('m1'), msg('m2'), msg('m3')])
      expect('added' in (await nextChat(seen, 1))).toBe(true)
    } finally {
      ws.close()
    }
    const back = await screen()
    try {
      const first = await nextChat(back.seen, 0)
      expect('added' in first).toBe(false)
      expect(first.chat.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
      change([msg('m1'), msg('m2'), msg('m3'), msg('m4')])
      const delta = await nextChat(back.seen, 1)
      if (!('added' in delta)) throw new Error('not a delta')
      expect(delta.added).toEqual([msg('m4')])
    } finally {
      back.ws.close()
    }
  })
})
