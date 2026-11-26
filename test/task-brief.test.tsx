// A task's scope as a card on its page (SHE-202, the 2.0 port of upstream SHEP-330): the words the Assistant wrote,
// the Settings folded away, a long brief folded with Show all, and under it whether the agent has the brief.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SETTINGS_HEAD } from '../shared/brief.ts'
import type { Chat, Message, Task } from '../shared/types.ts'
import { briefFrom, briefMessageOf, briefOf, briefState, type BriefState, deliveryWord, hasBrief, isBriefMessage, looksLong, startWords, StartWords, TaskBriefCard } from '../src/task-brief.tsx'

const scope = 'Make the card bigger. Keep the colours.'
const settings = `${SETTINGS_HEAD}\n- Review: on. On. (your setting for every machine)\n- Merge: on its own (this space's setting)`
const desc = `${scope}\n\n${settings}`
const task = (x: Partial<Task> = {}): Task => ({ id: 'SHE-3', name: 'Bigger card', status: 'work', place: 'shepherdr', age: '', state: 'Working', on: 'pi', created: '', desc, ...x }) as Task
const agent = { chat: 'SHE-3/Agent', role: 'Agent', cli: 'pi', status: 'work' as const, age: '', note: '' }
const msg = (x: Partial<Message>): Message => ({ id: 'm', who: 'you', ...x })
const chat = (messages: Message[], x: Partial<Chat> = {}): Chat => ({ key: 'SHE-3/Agent', cli: 'pi', messages, ...x })
const draw = (t: Task, state: BriefState = 'waiting') => renderToStaticMarkup(<TaskBriefCard task={t} state={state} />)

test('briefOf splits the human words from the Settings block, keeping who set a line', () => {
  const b = briefOf(task())
  expect(b.scope).toBe(scope)
  expect(b.settings).toEqual(['Review: on. On. (your setting for every machine)', "Merge: on its own (this space's setting)"])
  // an old brief with no block is all scope
  expect(briefOf(task({ desc: 'Just fix it.' }))).toEqual({ scope: 'Just fix it.', settings: [] })
})

test('who wrote it and whether the agent has it are plain words', () => {
  expect(briefFrom(undefined)).toBe('From the Assistant')
  expect(briefFrom('shepherdr')).toBe('From the Assistant in #shepherdr')
  expect([deliveryWord('waiting'), deliveryWord('sent'), deliveryWord('read')]).toEqual(['Not sent yet', 'Sent', 'Read'])
  expect(hasBrief(task())).toBe(true)
  expect(hasBrief(task({ desc: undefined }))).toBe(false)
  expect(hasBrief(task({ desc: 'No brief yet.' }))).toBe(false)
})

test('the card shows the name, the words and the delivery, with the Settings folded away', () => {
  const html = draw(task(), 'read')
  expect(html).toContain('data-task-brief="SHE-3"')
  expect(html).toContain('From the Assistant')
  expect(html).toContain('Bigger card')
  expect(html).toContain(scope)
  expect(html).toContain('Read')
  expect(html).toContain('Settings')
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('Review: on')
})

test('a long scope starts folded with Show all; a short one shows whole', () => {
  const long = `${scope}\n\nDo:\n${Array.from({ length: 12 }, (_, i) => `- step ${i + 1}`).join('\n')}`
  expect(looksLong(long)).toBe(true)
  expect(looksLong(scope)).toBe(false)
  expect(looksLong(`Make the card bigger. Keep the colours.\n\n${'x'.repeat(400)}`)).toBe(true)
  const folded = draw(task({ desc: `${long}\n\n${settings}` }))
  expect(folded).toContain('Show all')
  expect(folded).toContain('max-h-36')
  expect(folded).toContain('mask-image')
  const short = draw(task())
  expect(short).not.toContain('Show all')
  expect(short).not.toContain('mask-image')
})

test('the launch message holding the brief is recognised, and its delivery follows it', () => {
  const launched = msg({ text: `Bigger card\n\n${desc}\n\nQueued: wait for the go.` })
  expect(isBriefMessage(launched, scope, desc)).toBe(true)
  expect(isBriefMessage(undefined, scope, desc)).toBe(false)
  expect(isBriefMessage(msg({ text: 'On it.' }), scope, desc)).toBe(false)
  expect(isBriefMessage(msg({ who: 'agent', text: `Bigger card\n\n${desc}` }), scope, desc)).toBe(false)
  // a card or a wake line may come before the launch message: still found, still read
  const withCard = chat([msg({ id: 'c', card: { id: 'c', text: 'started' } }), launched])
  expect(briefMessageOf(withCard, scope, desc)?.id).toBe('m')
  expect(briefState(task({ agent }), withCard)).toBe('read')
  expect(briefMessageOf(chat([launched]), scope, desc)?.id).toBe('m')
  expect(briefMessageOf(undefined, scope, desc)).toBeUndefined()
  expect(briefState(task(), undefined)).toBe('waiting')
  expect(briefState(task({ agent }), undefined)).toBe('sent')
  expect(briefState(task({ agent }), chat([launched]))).toBe('read')
  expect(briefState(task({ agent }), chat([msg({ who: 'agent', text: 'Got it.' })]))).toBe('read')
})

test('before the agent is at work, words say what the task waits for', () => {
  expect(startWords(task({ status: 'queued', after: ['SHE-2'] }), undefined)).toBe('Queued. It starts when SHE-2 is done.')
  expect(startWords(task({ status: 'queued', after: ['SHE-2', 'SHE-5'] }), undefined)).toBe('Queued. It starts when SHE-2, SHE-5 are done.')
  expect(startWords(task({ status: 'queued' }), undefined)).toBe('Queued. It starts when the tasks before it are done.')
  expect(startWords(task({ status: 'scheduled', sub: 'Starts Fri 9:00' }), undefined)).toBe('Scheduled. Starts Fri 9:00.')
  expect(startWords(task({ status: 'scheduled' }), undefined)).toBe('Scheduled. It starts by itself.')
  expect(startWords(task({ status: 'todo' }), undefined)).toBe('Not started yet. It starts when you say go.')
  expect(startWords(task({ agent }), chat([msg({ text: `Bigger card\n\n${desc}` })]))).toBe('Its agent is starting.')
  expect(startWords(task({ agent }), undefined)).toBe('')
  expect(startWords(task({ agent }), chat([msg({ text: `Bigger card\n\n${desc}` }), msg({ who: 'agent', text: 'On it.' })]))).toBe('')
  expect(startWords(task({ status: 'ready', agent }), undefined)).toBe('')
})

test('the waiting words show as one quiet line, and never when there is nothing to say', () => {
  const html = renderToStaticMarkup(<StartWords task={task({ status: 'todo' })} chat={undefined} />)
  expect(html).toContain('Not started yet. It starts when you say go.')
  expect(html).toContain('role="status"')
  expect(renderToStaticMarkup(<StartWords task={task({ status: 'ready' })} chat={undefined} />)).toBe('')
})
