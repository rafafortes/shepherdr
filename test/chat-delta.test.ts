// A chat push used to carry every message ever written, about once a second per watched chat (PERFC-03). The server
// now diffs the chat it built against the one it last sent: new rows go in `added`, changed flags in `changed`, and
// anything a delta cannot express sends the whole chat. This file tests that diff and measures both wire sizes.
import { describe, expect, test } from 'bun:test'
import { Chats } from '../server/live/chats.ts'
import type { Chat, Message } from '../shared/types.ts'

const KEY = 'p:m:delta'
/** a fresh Chats so each test owns its diff base and sequence */
const fresh = () => new Chats({} as never, () => 'Agent', () => 'you')
const msg = (id: string, more: Partial<Message> = {}): Message => ({ id, who: 'agent', at: 1000 + Number(id.slice(1) || 0), text: `line ${id}`, ...more })
const chat = (messages: Message[]): Chat => ({ key: KEY, messages, cli: 'claude' })

describe('the server diff', () => {
  test('a rebuild that adds one message emits a delta with exactly that message', () => {
    const chats = fresh()
    const base = chat([msg('m1'), msg('m2')])
    const first = chats.chatUpdate(KEY, base)
    expect(first.delta).toBeNull() // nobody has a base yet: the first chat goes whole
    expect(first.full).toMatchObject({ type: 'chat', through: 1 })
    expect(first.full.chat.messages).toHaveLength(2)

    const next = chat([msg('m1'), msg('m2'), msg('m3')])
    const { delta } = chats.chatUpdate(KEY, next)
    expect(delta).not.toBeNull()
    expect(delta?.added).toEqual([msg('m3')])
    expect(delta?.changed).toEqual([])
    expect(delta?.through).toBe(2)
    // the non-message part still travels with the delta, so working/live/jobs stay current
    expect(delta?.chat.messages).toEqual([])
    expect(delta?.chat.key).toBe(KEY)
    expect(delta?.chat.cli).toBe('claude')
  })

  test('a rebuild that only marks a message answered emits a changed patch', () => {
    const chats = fresh()
    const question = { id: 'q1', title: 'Merge it?', kind: 'Question' as const, choices: [], to: 'Agent' }
    const base = chat([msg('m1'), msg('m2', { question })])
    chats.chatUpdate(KEY, base)
    const answered = chat([msg('m1'), msg('m2', { question, answered: 'Answered “Merge it?”' })])
    const { delta } = chats.chatUpdate(KEY, answered)
    expect(delta?.added).toEqual([])
    expect(delta?.changed).toEqual([{ id: 'm2', patch: { answered: 'Answered “Merge it?”' } }])
    expect(delta?.through).toBe(2)
  })

  test('a reaction on an old row is a patch, not a second copy of the row', () => {
    const chats = fresh()
    const base = chat([msg('m1'), msg('m2', { reactions: [{ emoji: '👀', by: 'me' }] })])
    chats.chatUpdate(KEY, base)
    const next = chat([msg('m1'), msg('m2', { reactions: [{ emoji: '👀', by: 'both' }] })])
    expect(chats.chatUpdate(KEY, next).delta?.changed).toEqual([{ id: 'm2', patch: { reactions: [{ emoji: '👀', by: 'both' }] } }])
  })

  test('a rebuild with nothing new is still tiny: no added and no changed rows', () => {
    const chats = fresh()
    const base = chat([msg('m1')])
    chats.chatUpdate(KEY, base)
    // a rebuilt-but-equal object is not a change: fields are compared by value, not identity
    const { delta } = chats.chatUpdate(KEY, chat([msg('m1')]))
    expect(delta).toMatchObject({ added: [], changed: [], through: 2 })
  })

  test('a row going away, or a field going away, falls back to the full chat', () => {
    const chats = fresh()
    chats.chatUpdate(KEY, chat([msg('m1'), msg('m2')]))
    expect(chats.chatUpdate(KEY, chat([msg('m1')])).delta).toBeNull()
    chats.chatUpdate(KEY, chat([msg('m1', { answered: 'Answered' })]))
    expect(chats.chatUpdate(KEY, chat([msg('m1')])).delta).toBeNull()
  })

  test('a new arrival can land before an old row without any id being removed', () => {
    const chats = fresh()
    chats.chatUpdate(KEY, chat([msg('m1'), msg('m3')]))
    // backfilled activity rows get an earlier `at`; the client re-sorts, so this is still a delta
    const { delta } = chats.chatUpdate(KEY, chat([msg('m1'), msg('m2', { at: 1500 }), msg('m3')]))
    expect(delta?.added).toEqual([msg('m2', { at: 1500 })])
  })

  test('one chat cannot borrow another chat’s base', () => {
    const chats = fresh()
    const a = chat([msg('m1')])
    chats.chatUpdate(KEY, a)
    const other = { ...a, key: 'p:m:other', messages: [...a.messages, msg('m2')] }
    expect(chats.chatUpdate(other.key, other).delta).toBeNull()
    expect(chats.chatUpdate(KEY, chat([...a.messages, msg('m3')])).delta?.added).toEqual([msg('m3')])
  })
})

describe('the bytes of one update', () => {
  test('a thousand-message chat: the whole form against the delta for one new line', () => {
    const chats = fresh()
    const history = Array.from({ length: 1000 }, (_, i) =>
      msg(`m${i}`, { at: 1_700_000_000_000 + i * 1000, text: `Step ${i}: checked the chat's log and its cached message array for anything new since the last push.` }),
    )
    const before = chats.chatUpdate(KEY, chat(history))
    const after = chats.chatUpdate(KEY, chat([...history, msg('m1000', { at: 1_700_000_001_000, text: 'One more line from the agent.' })]))
    if (!after.delta) throw new Error('a single added line must fit in a delta')
    const fullBytes = JSON.stringify(before.full).length
    const deltaBytes = JSON.stringify(after.delta).length
    console.log(`chat update bytes (1000 messages): full ${fullBytes}, delta ${deltaBytes}`)
    expect(fullBytes).toBeGreaterThan(100_000)
    expect(deltaBytes).toBeLessThan(fullBytes / 10)
  })
})
