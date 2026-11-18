// A card Shepherdr posted for an agent (its plan, a choice card) is why it waits on you only while it is unanswered
// and nothing that reached it since answered it: the human's own words, a hidden Shepherdr line carrying them, or
// another agent's relay (POL-442). The CLI's own question tool is settled the same way.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME ??= tmp('card')
const { Chats } = await import('../server/live/chats.ts')

const question = (id: string) => ({ id, title: 'x', kind: 'Plan' as const, choices: [{ label: 'Yes' }], to: 'T agent' })
const chatsWith = (key: string) => new Chats({ record: () => undefined } as never, (k) => k, () => 'You')

/** what a CLI's reader found in its log, standing in for it */
const reached = (chats: InstanceType<typeof Chats>, key: string, e: object) =>
  (chats as unknown as { events: Map<string, unknown[]> }).events.set(key, [...((chats as unknown as { events: Map<string, unknown[]> }).events.get(key) ?? []), e])

test('an open plan or choice card, until it is answered or you write', async () => {
  const chats = chatsWith('T-1/Agent')
  const key = `T-${Date.now()}/Agent`
  expect(chats.openCard(key)).toBeUndefined()
  chats.post(key, { id: 'plan:1', question: question('plan:T:1') })
  expect(chats.openCard(key)).toBe('plan')
  chats.answer(key, 'plan:T:1', 0)
  expect(chats.openCard(key)).toBeUndefined()
  await Bun.sleep(2)
  chats.post(key, { id: 'ask:1', question: question('ask:1') })
  expect(chats.openCard(key)).toBe('ask')
  await Bun.sleep(2)
  chats.post(key, { id: 'you:1', who: 'you', text: 'Something else' })
  expect(chats.openCard(key)).toBeUndefined()
})

test('POL-442: a card is answered by any message that reached the agent after it, a peer’s relay as well', async () => {
  const key = 'T-442/Agent'
  const chats = chatsWith(key)
  chats.post(key, { id: 'ask:372d2a44', question: question('ask:372d2a44') })
  expect(chats.openCard(key)).toBe('ask')
  expect(chats.asksInTurn(key)).toBe(true)
  // a herdr agent-to-agent message relaying the operator's answer, as Claude Code logs it: an event of kind peer
  reached(chats, key, { kind: 'turn-start', id: 'start-1', at: Date.now() + 1000 })
  reached(chats, key, { kind: 'peer', id: 'u-1', at: Date.now() + 1000, text: 'Relayed from the operator: Your pick is "keep it".' })
  expect(chats.openCard(key)).toBeUndefined()
  expect(chats.asksInTurn(key)).toBe(false)
})

test('a card asked in the turn running now is yours, one asked before it began is not', () => {
  const key = 'T-444/Agent'
  const chats = chatsWith(key)
  reached(chats, key, { kind: 'turn-start', id: 'start-1', at: Date.now() })
  chats.post(key, { id: 'ask:in', question: question('ask:in') })
  // asked after the turn began, and that turn runs still: it waits on you in it
  expect(chats.openCard(key)).toBe('ask')
  expect(chats.asksInTurn(key)).toBe(true)
  // that turn ended: what it asked before is no longer the running turn's, so a working agent is not held by it
  reached(chats, key, { kind: 'turn-end', id: 'turn-1', at: Date.now() + 1000 })
  expect(chats.asksInTurn(key)).toBe(false)
})

test('Shepherdr’s own hidden line that carries the human’s words answers it too, and so does a question tool’s answer', async () => {
  const key = 'T-443/Agent'
  const chats = chatsWith(key)
  chats.post(key, { id: 'ask:1', question: question('ask:1') })
  // what Shepherdr types in for the human: their words inside a tag the chat does not show
  reached(chats, key, { kind: 'user', id: 'u-1', at: Date.now() + 1000, text: '<shepherdr><browser from="Elias">Make the button say Save</browser></shepherdr>' })
  expect(chats.openCard(key)).toBeUndefined()
  // the CLI's own question, settled by the tool result its CLI writes (answered), or by a message after it
  reached(chats, key, { kind: 'question', id: 'q1', at: Date.now() + 2000, tool: 'AskUserQuestion', items: [{ question: 'Which?', options: [{ label: 'A' }], multiSelect: false }] })
  expect(chats.openQuestion(key)?.id).toBe('q1')
  reached(chats, key, { kind: 'answered', id: 'q1', at: Date.now() + 3000 })
  expect(chats.openQuestion(key)).toBeUndefined()
  reached(chats, key, { kind: 'question', id: 'q2', at: Date.now() + 4000, tool: 'AskUserQuestion', items: [{ question: 'Which now?', options: [{ label: 'A' }], multiSelect: false }] })
  expect(chats.openQuestion(key)?.id).toBe('q2')
  // nothing reached it after q2 yet: a message from before it is no answer
  expect(chats.openQuestion(key)?.at).toBeGreaterThan(Date.now())
  // Shepherdr's own hidden news arrives as a line of the human's, and it answers nothing: the CLI still waits on its tool
  reached(chats, key, { kind: 'user', id: 'u-news', at: Date.now() + 4500, text: '<shepherdr><news task="T">Its reviewer reported.</news></shepherdr>' })
  expect(chats.openQuestion(key)?.id).toBe('q2')
  reached(chats, key, { kind: 'peer', id: 'u-2', at: Date.now() + 5000, text: 'Relayed from the operator: B.' })
  expect(chats.openQuestion(key)).toBeUndefined()
  // with nothing after the question, it is still open
  reached(chats, key, { kind: 'question', id: 'q3', at: Date.now() + 6000, tool: 'AskUserQuestion', items: [{ question: 'And this one?', options: [{ label: 'A' }], multiSelect: false }] })
  expect(chats.openQuestion(key)?.id).toBe('q3')
  // their notes on a page are their words, hidden in a tag of Shepherdr's: typed at the question, they answer it
  reached(chats, key, { kind: 'user', id: 'u-notes', at: Date.now() + 7000, text: '<shepherdr><browser from="Elias">Make the button say Save</browser></shepherdr>' })
  expect(chats.openQuestion(key)).toBeUndefined()
  // and so does a plain line of theirs
  reached(chats, key, { kind: 'question', id: 'q4', at: Date.now() + 8000, tool: 'AskUserQuestion', items: [{ question: 'Both?', options: [{ label: 'A' }], multiSelect: false }] })
  reached(chats, key, { kind: 'user', id: 'u-typed', at: Date.now() + 9000, text: 'Both of them, Aldo first.' })
  expect(chats.openQuestion(key)).toBeUndefined()
})
