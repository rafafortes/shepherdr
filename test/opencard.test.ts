// A card Shepherdr posted for an agent (its plan, a choice card) is why it waits on you only while it is unanswered
// and nothing that reached it since answered it: the human's own words, a hidden Shepherdr line carrying them, or
// another agent's relay (POL-442). The CLI's own question tool is settled the same way.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME ??= tmp('card')
const { Chats, menuId } = await import('../server/live/chats.ts')

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

test('the cheap open cards spot menus, posted cards and CLI questions without building the chat', () => {
  const key = 'T-open-check/Agent'
  const chats = chatsWith(key)
  const ids = () => chats.openCardsQuick(key).map((m) => m.question.id)
  const at = Date.now()
  expect(ids()).toEqual([])
  // a startup menu counts as open until cleared
  const menu = { title: 'Trust folder?', choices: ['Yes'], cursor: 0, screen: 'Trust folder?', all: 'Trust folder?' }
  chats.showStartMenu(key, menu)
  expect(ids()).toEqual([menuId(key, menu)])
  chats.clearStartMenu(key)
  expect(ids()).toEqual([])
  // a posted question counts as open until answered; a note beside the questions and an advisor's own note never
  chats.post(key, { id: 'ask:fast', at, question: question('ask:fast') })
  chats.post(key, { id: 'note:aside', at, card: { id: 'note:aside', aside: true }, question: question('note:aside') } as never)
  chats.post(key, { id: 'advice-note:mine', at, card: { id: 'advice-note:mine' }, question: question('advice-note:mine') } as never)
  expect(ids()).toEqual(['ask:fast'])
  chats.answer(key, 'ask:fast', 0)
  expect(ids()).toEqual([])
  // posted plan/ask cards closed by a user message, peer relay, hidden browser note, or `you` post are no longer open
  chats.post(key, { id: 'plan:typed', at: at + 200, question: question('plan:typed') })
  expect(ids()).toEqual(['plan:typed'])
  reached(chats, key, { kind: 'user', id: 'u-plan', at: at + 300, text: 'Go ahead.' })
  expect(ids()).toEqual([])
  chats.post(key, { id: 'ask:relay', at: at + 400, question: question('ask:relay') })
  expect(ids()).toEqual(['ask:relay'])
  reached(chats, key, { kind: 'peer', id: 'p-relay', at: at + 500, text: 'Relayed: yes.' })
  expect(ids()).toEqual([])
  chats.post(key, { id: 'ask:note', at: at + 600, question: question('ask:note') })
  expect(ids()).toEqual(['ask:note'])
  reached(chats, key, { kind: 'user', id: 'u-note', at: at + 700, text: '<shepherdr><browser from="Elias">Use blue</browser></shepherdr>' })
  expect(ids()).toEqual([])
  chats.post(key, { id: 'plan:you', at: at + 900, question: question('plan:you') })
  expect(ids()).toEqual(['plan:you'])
  chats.post(key, { id: 'you:app', at: at + 950, who: 'you', answered: 'Approved' })
  expect(ids()).toEqual([])
  // a CLI question counts as open until answered or closed by a later human/peer message
  reached(chats, key, { kind: 'question', id: 'q-open', at: at + 1000, tool: 'AskUserQuestion', items: [{ question: 'Pick?', options: [{ label: 'A' }], multiSelect: false }] })
  expect(ids()).toEqual(['q-open'])
  reached(chats, key, { kind: 'user', id: 'u-close', at: at + 2000, text: 'Pick A.' })
  expect(ids()).toEqual([])
  // a card posted with no words rides the agent reply of its turn: a line of yours between the reply and the post
  // closes it here as it does on the screen (chat(): hostFor) — the card carries the reply's time, not its own post's
  reached(chats, key, { kind: 'agent', id: 'a-host', at: at + 3000, text: 'Ready when you are.' })
  reached(chats, key, { kind: 'user', id: 'u-host', at: at + 3050, text: 'Then go.' })
  chats.post(key, { id: 'plan:ride', at: at + 3100, question: question('plan:ride') })
  expect(ids()).toEqual([])
  // without a line in between it stays open, riding that reply
  reached(chats, key, { kind: 'agent', id: 'a-host2', at: at + 4000, text: 'Once more.' })
  chats.post(key, { id: 'plan:ride2', at: at + 4100, question: question('plan:ride2') })
  expect(ids()).toEqual(['plan:ride2'])
  // forget() clears cached closing state alongside events and logs
  chats.forget(key)
  expect(ids()).toEqual([])
})

test('the cheap open cards Needs you reads are the cards, closed the same way (SHE-56)', async () => {
  const key = 'T-56/Agent'
  const chats = chatsWith(key)
  const ids = () => chats.openCardsQuick(key).map((m) => m.question.id).sort()
  expect(ids()).toEqual([])
  chats.post(key, { id: 'ask:card', question: question('ask:card') })
  chats.post(key, { id: 'plan:card', question: question('plan:card') })
  reached(chats, key, { kind: 'question', id: 'q1', at: Date.now(), tool: 'AskUserQuestion', items: [{ question: 'Which?', options: [{ label: 'A' }], multiSelect: false }] })
  expect(ids()).toEqual(['ask:card', 'plan:card', 'q1'].sort())
  reached(chats, key, { kind: 'answered', id: 'q1', at: Date.now() })
  expect(ids()).toEqual(['ask:card', 'plan:card'].sort())
  // a relay from another agent, then the person's own words, answer the cards that came before them
  reached(chats, key, { kind: 'peer', id: 'peer-1', at: Date.now() + 1, text: 'The operator said: do it.' })
  expect(ids()).toEqual([])
  chats.post(key, { id: 'you:1', who: 'you', text: 'Do it.' })
  expect(ids()).toEqual([])
  await Bun.sleep(6)
  chats.post(key, { id: 'ask:new', question: question('ask:new') })
  expect(ids()).toEqual(['ask:new'])
  chats.answer(key, 'ask:new', 0)
  expect(ids()).toEqual([])
})

test('SHE-68: repeated chat reads leave the cheap open cards, and so Needs, unchanged', () => {
  const key = 'T-68/Agent'
  const chats = new Chats({
    record: () => undefined, sentLately: () => [], waiting: () => [], holdOf: () => undefined,
    status: () => 'blocked', failedLately: () => [], info: () => undefined, runtime: () => undefined,
    runtimeHook: () => undefined, background: () => false, unreadable: () => undefined,
    stillRuns: () => false, procs: { list: () => [] },
  } as never, (k) => k, () => 'You')
  const ids = () => chats.openCardsQuick(key).map((m) => m.question.id)
  chats.post(key, { id: 'ask:1', question: question('ask:1') })
  const before = ids()
  chats.chat(key)
  chats.chat(key)
  chats.chat(key)
  expect(ids()).toEqual(before)
  chats.answer(key, 'ask:1', 0)
  chats.chat(key)
  expect(ids()).toEqual([])
  chats.post(key, { id: 'ask:2', question: question('ask:2') })
  const after = ids()
  chats.chat(key)
  expect(ids()).toEqual(after)
  expect(after).toEqual(['ask:2'])
})
