import { coordinatorRequestIds } from '../shared/attention.ts'
import { openCards } from '../shared/alerts.ts'
import type { Chat, Message } from '../shared/types.ts'
import { expect, test } from 'bun:test'
import { attentionCounts } from '../src/attention.ts'
import { DemoWorld } from '../server/demo/world.ts'

test('a count is its own list: needs are the Needs you view rows, Ready the Ready tasks, all within the named scope', () => {
  const snap = new DemoWorld().snapshot()
  const all = snap.places.map((p) => p.id)
  const needs = snap.needs.filter((n) => all.includes(n.place))
  const ready = snap.tasks.filter((t) => t.status === 'ready' && !t.archived)
  expect(attentionCounts(snap, all)).toEqual({ need: needs.length, ready: ready.length })
  // a place named twice, or all of them with a task copied in, never counts twice; archived work never counts
  snap.tasks.push({ ...ready[0], id: 'ARCHIVED', archived: 1 })
  expect(attentionCounts(snap, [...all, ...all])).toEqual({ need: needs.length, ready: ready.length })
  const p = ready[0].place
  expect(attentionCounts(snap, [p])).toEqual({ need: needs.filter((n) => n.place === p).length, ready: ready.filter((t) => t.place === p).length })
  expect(attentionCounts(snap, [])).toEqual({ need: 0, ready: 0 })
})

test('one row per card: a task with two open questions counts twice, a coordinator question once, each once in its place', () => {
  const world = new DemoWorld()
  const snap = world.snapshot()
  const t = snap.tasks.find((x) => x.status === 'need')!
  const p = snap.places.find((x) => x.id === t.place)!
  const key = t.agent?.chat ?? `${t.id}/Agent`
  const q = (id: string): Message => ({ id, who: 'agent', question: { id, kind: 'Question', title: id, choices: [], to: 'you' } })
  world.chat(key).messages = [q('task-1'), q('task-2')]
  world.chat(p.chat).messages = [q('coordinator-1')]
  const now = world.snapshot()
  const mine = now.needs.filter((n) => n.place === p.id)
  expect(mine.map((n) => n.id)).toEqual(expect.arrayContaining(['task-1', 'task-2', 'coordinator-1']))
  // what the Needs you view lists for that place is what its badges count
  expect(attentionCounts(now, [p.id]).need).toBe(mine.length)
  expect(attentionCounts(now, [p.id]).ready).toBe(now.tasks.filter((x) => x.place === p.id && x.status === 'ready' && !x.archived).length)
})

test('coordinator questions survive later news, count separately and stop counting when answered or relayed', () => {
  const q = (id: string): Message => ({ id, who: 'agent', question: { id, kind: 'Question', title: id, choices: [], to: 'you' } })
  const chat = (messages: Message[]): Chat => ({ key: 'p', cli: 'Claude Code', messages })
  const open = (messages: Message[]) => openCards(chat(messages)).map((m) => m.question.id)
  const posted: Message[] = [q('ask:1'), { id: 'news', who: 'agent', card: { id: 'news', task: 'T-1', status: 'ready', text: 'Ready' } }, q('ask:2'), { id: 'health', who: 'agent', text: 'Disk recovered.' }]
  // later news from the agent does not close a card that still waits
  expect(open(posted)).toEqual(['ask:1', 'ask:2'])
  expect(coordinatorRequestIds(open(posted), {}, false)).toEqual(['ask:1', 'ask:2'])
  expect(coordinatorRequestIds(open(posted), { 'ask:1': 0 }, false)).toEqual(['ask:2'])
  expect(coordinatorRequestIds(open(posted), { 'ask:1': 0, 'ask:2': 0 }, false)).toEqual([])
  expect(coordinatorRequestIds([], {}, true)).toEqual(['blocked'])
  expect(coordinatorRequestIds(['ask:1', 'menu'], {}, true)).toEqual(['ask:1', 'menu'])
  // but another agent's relay after the cards closes them everywhere, a coordinator's as much as a task's (POL-442)
  const relayed: Message[] = [...posted, { id: 'p1', who: 'peer', peer: { name: 'Another agent' }, text: 'The operator says pick the first.' }]
  expect(open(relayed)).toEqual([])
  expect(coordinatorRequestIds(open(relayed), {}, false)).toEqual([])
})
