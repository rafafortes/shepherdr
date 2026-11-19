// The chat's plain rules: day lines and search in a chat; and the built chat's cache (SHE-68).
import { describe, expect, test } from 'bun:test'
import { dayLabel, findIn } from '../plugins/chat/days.ts'
import type { Message } from '../shared/types.ts'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME ??= tmp('chat')
const { Chats, nextClose, rememberReply } = await import('../server/live/chats.ts')

describe('day lines', () => {
  const now = new Date(2026, 9, 25, 9, 30)
  test('today, yesterday, a weekday this week, else the date; the year only when it is not this one', () => {
    expect(dayLabel(new Date(2026, 9, 25, 0, 5).getTime(), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 9, 24, 23, 59).getTime(), now)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 9, 21, 12).getTime(), now)).toBe(new Date(2026, 9, 21).toLocaleDateString([], { weekday: 'long' }))
    const old = dayLabel(new Date(2026, 8, 2).getTime(), now)
    expect(old).not.toContain('2026')
    expect(dayLabel(new Date(2025, 8, 2).getTime(), now)).toContain('2025')
  })
})

describe('search in a chat', () => {
  const msgs: Message[] = [
    { id: 'a', who: 'you', text: 'Is the Clock mocked?' },
    { id: 'b', who: 'agent', text: 'No.' },
    { id: 'c', who: 'you', file: { name: 'clock.png', path: '/x/clock.png' } },
    { id: 'd', who: 'you', text: 'clock again', waiting: true },
    { id: 'e', who: 'agent', question: { id: 'q', title: 'Fix the clock?', kind: 'Question', choices: [], to: 'x' } },
  ]
  test('words in any case, file names and card titles; nothing still waiting to go in', () => {
    expect(findIn(msgs, '  CLOCK ')).toEqual(['a', 'c', 'e'])
    expect(findIn(msgs, '')).toEqual([])
    expect(findIn(msgs, 'zebra')).toEqual([])
    // markdown aside: a link by its words, not its address; no ** in the way
    const md: Message[] = [{ id: 'm', who: 'agent', text: 'See **the** [docs](https://example.com/clockwork)' }]
    expect(findIn(md, 'see the docs')).toEqual(['m'])
    expect(findIn(md, 'clockwork')).toEqual([])
  })
})

/* SHE-68: the message array is built once per change of the sources it reads, not on every chat() call */

const agentsForChat = () => {
  const outbox: object[] = []
  const delivered: object[] = []
  return {
    outbox,
    delivered,
    record: () => undefined,
    sentLately: () => delivered,
    waiting: () => outbox,
    holdOf: () => undefined,
    status: () => 'blocked',
    failedLately: () => [],
    info: () => undefined,
    runtime: () => undefined,
    runtimeHook: () => undefined,
    background: () => false,
    unreadable: () => undefined,
    stillRuns: () => false,
    procs: { list: () => [] },
  }
}
const chatWith = (agents = agentsForChat()) => new Chats(agents as never, (k) => k, () => 'You')

/** what a CLI's reader left in the log, with the revision a real read would have bumped */
const reached = (chats: InstanceType<typeof Chats>, key: string, ...ev: object[]) => {
  const state = chats as unknown as { events: Map<string, object[]>; revs: Map<string, number> }
  state.events.set(key, [...(state.events.get(key) ?? []), ...ev])
  state.revs.set(key, (state.revs.get(key) ?? 0) + 1)
}
const question = (id: string) => ({ id, title: 'Pick one', kind: 'Plan' as const, choices: [{ label: 'Yes' }], to: 'T agent' })

describe('the built chat is cached per revision', () => {
  test('two chat() calls with no change build the messages once, and the built array is never handed out', () => {
    const key = 'cache-hit/Agent'
    const chats = chatWith()
    reached(chats, key, { kind: 'agent', id: 'a1', at: 1000, text: 'Hello.' })
    chats.post(key, { id: 'ask:1', at: 1100, question: question('ask:1') })
    const first = chats.chat(key)
    const built = chats.chatBuilds
    const second = chats.chat(key)
    expect(chats.chatBuilds).toBe(built)
    expect(second.messages).toEqual(first.messages)
    expect(second.messages).not.toBe(first.messages)
    expect(second.closedAt).toEqual(first.closedAt)
  })

  test('a post, an answer, a pulled log line and a menu each rebuild the chat', () => {
    const key = 'cache-miss/Agent'
    const chats = chatWith()
    reached(chats, key, { kind: 'agent', id: 'a1', at: 1000, text: 'Hello.' })
    const before = chats.chatBuilds
    chats.chat(key)
    expect(chats.chatBuilds).toBe(before + 1)
    chats.chat(key)
    expect(chats.chatBuilds).toBe(before + 1)
    chats.post(key, { id: 'ask:1', at: 1100, question: question('ask:1') })
    const posted = chats.chat(key)
    expect(chats.chatBuilds).toBe(before + 2)
    expect(posted.messages.some((m) => m.question?.id === 'ask:1')).toBe(true)
    chats.answer(key, 'ask:1', 0)
    const answered = chats.chat(key)
    expect(chats.chatBuilds).toBe(before + 3)
    expect(answered.messages.find((m) => m.question?.id === 'ask:1')?.question?.sent).toBe(0)
    reached(chats, key, { kind: 'agent', id: 'a2', at: 1200, text: 'A new reply.' })
    const pulled = chats.chat(key)
    expect(chats.chatBuilds).toBe(before + 4)
    expect(pulled.messages.some((m) => m.text === 'A new reply.')).toBe(true)
    chats.showStartMenu(key, { title: 'Trust folder?', choices: ['Yes'], cursor: 0, screen: 'Trust folder?', all: 'Trust folder?' })
    const menu = chats.chat(key)
    expect(chats.chatBuilds).toBe(before + 5)
    expect(menu.messages.some((m) => m.question?.terminal)).toBe(true)
  })

  test('a queued reaction and a reply linked from a space decorate a copy, never the built messages', () => {
    const key = 'cache-copy/Agent'
    const agents = agentsForChat()
    const chats = chatWith(agents)
    reached(chats, key, { kind: 'agent', id: 'a1', at: 1000, text: 'Hello.' })
    const first = chats.chat(key)
    const built = chats.chatBuilds
    agents.outbox.push({ id: 'w1', at: 2000, text: '👍', reaction: { message: 'a1', emoji: '👍' } })
    const withReaction = chats.chat(key)
    expect(chats.chatBuilds).toBe(built)
    expect(withReaction.messages.find((m) => m.id === 'a1')?.reactions?.[0]?.emoji).toBe('👍')
    expect(first.messages.find((m) => m.id === 'a1')?.reactions).toBeUndefined()
    agents.outbox.length = 0
    const line = '<reply from="You" to="Hello.">Yes, do it.</reply>'
    rememberReply(line, 'a1')
    reached(chats, key, { kind: 'user', id: 'u1', at: 1300, text: line })
    const beforeLink = chats.chat(key)
    expect(beforeLink.messages.find((m) => m.who === 'you' && m.reply?.id === 'a1')).toBeDefined()
    chats.repliedFrom(key, 'a1', 'space')
    const withLink = chats.chat(key)
    expect(withLink.messages.find((m) => m.who === 'you')?.answered).toBe('Answered')
    expect(beforeLink.messages.find((m) => m.who === 'you')?.answered).toBeUndefined()
  })

  test('forget drops the built chat with the rest of it', () => {
    const key = 'cache-forget/Agent'
    const chats = chatWith()
    reached(chats, key, { kind: 'agent', id: 'a1', at: 1000, text: 'Hello.' })
    chats.chat(key)
    const built = chats.chatBuilds
    chats.forget(key)
    const after = chats.chat(key)
    expect(chats.chatBuilds).toBe(built + 1)
    expect(after.messages).toHaveLength(0)
  })

  test('nextClose finds the first close strictly after a time, on a sorted list', () => {
    expect(nextClose([10, 20, 20, 50], 0)).toBe(10)
    expect(nextClose([10, 20, 20, 50], 10)).toBe(20)
    expect(nextClose([10, 20, 20, 50], 20)).toBe(50)
    expect(nextClose([10, 20, 20, 50], 50)).toBeUndefined()
    expect(nextClose([], 5)).toBeUndefined()
  })

  test('a 2,000-event chat with 200 cards builds once, within a time bound', () => {
    const key = 'cache-big/Agent'
    const chats = chatWith()
    const at = Date.now()
    const ev: object[] = []
    for (let i = 0; i < 2000; i++) {
      const kind = i % 3 === 0 ? 'peer' : i % 3 === 1 ? 'agent' : 'question'
      ev.push(kind === 'question'
        ? { kind, id: `e${i}`, at: at + i, items: [{ question: 'Pick?', options: [{ label: 'A' }], multiSelect: false }] }
        : { kind, id: `e${i}`, at: at + i, text: kind === 'peer' ? 'Relayed: go.' : 'A reply.' })
    }
    reached(chats, key, ...ev)
    for (let i = 0; i < 200; i++) chats.post(key, { id: `ask:${i}`, at: at + i * 10, question: question(`ask:${i}`) })
    const t0 = performance.now()
    const chat = chats.chat(key)
    const buildMs = performance.now() - t0
    expect(chat.messages.length).toBeGreaterThan(200)
    expect(buildMs).toBeLessThan(1000)
    const built = chats.chatBuilds
    chats.chat(key)
    chats.chat(key)
    expect(chats.chatBuilds).toBe(built)
  })
})
