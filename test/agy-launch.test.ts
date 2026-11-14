// Starting and resuming an agy agent: its flags (the model with its effort in the id, never --effort; --conversation to
// resume; --dangerously-skip-permissions unless it asks), its instructions as the hidden first message, and finding its
// conversation's log (discoverLog, follow). A fixture store stands in for agy's (SHEPHERDR_AGY_HOME); herdr.start is spied.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { headlessJob } from '../server/live/activity.ts'
import { agyLogPath, MIRROR_HEAD } from '../server/live/agy.ts'
import { hidden, type AgentRecord, type Spec } from '../server/live/agents.ts'
import { makeConversation, makeSummaries, userPayload } from './agy-fixture.ts'
import { tmp } from './tmp.ts'

const { Agents } = await import('../server/live/agents.ts')
const { herdr } = await import('../server/live/herdr.ts')
const { home } = await import('../server/store.ts')

const dir = tmp('agy-launch')
const store = join(dir, 'agy-store')
const cwd = join(dir, 'app')
const savedHome = process.env.SHEPHERDR_AGY_HOME

beforeAll(() => {
  process.env.SHEPHERDR_AGY_HOME = store
  mkdirSync(join(store, 'conversations'), { recursive: true })
  makeConversation(join(store, 'conversations', 'conv-found.db'), [{ idx: 0, step_type: 14, payload: userPayload('found it') }])
  makeConversation(join(store, 'conversations', 'conv-bad.db'), [{ idx: 0, step_type: 14, payload: userPayload('bad') }])
  makeSummaries(join(store, 'conversation_summaries.db'), [
    // changed just now: a look since a minute ago finds it
    { id: 'conv-found', uris: JSON.stringify([`file://${cwd}`]), last: new Date().toISOString().replace('T', ' ').replace('Z', '+00:00') },
    { id: 'conv-bad', uris: JSON.stringify([`file://${join(dir, 'bad')}`]), last: '2026-11-13 18:00:00+00:00' },
  ])
})

afterAll(() => {
  if (savedHome === undefined) delete process.env.SHEPHERDR_AGY_HOME
  else process.env.SHEPHERDR_AGY_HOME = savedHome
  rmSync(dir, { recursive: true, force: true })
})

/** an Agents server that starts nothing real: herdr.start is the spy's, refresh and routing are no-ops, and what is
 *  queued is kept for the test to read */
function harness() {
  const a = new Agents()
  const queued: string[][] = []
  Object.assign(a, {
    refresh: async () => undefined,
    bindRoute: async () => undefined,
    queue: (_key: string, texts: string[]) => queued.push(texts),
  })
  return { a, queued }
}

const key = 'AGY-1/Agent'
const base = (o: Partial<Spec> = {}): Spec =>
  ({
    key,
    name: 'shep-agy-test',
    kind: 'agy',
    cwd,
    workspace: 'test',
    access: 'full',
    pane: async () => 'fake-pane',
    ...o,
  }) as Spec

describe('starting an agy agent', () => {
  test('a fresh start: no session id of its own (agy names it), the model and no effort, permissions skipped, the instructions first', async () => {
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    const h = harness()
    try {
      await h.a.ensure(base({ model: 'gemini-3.8-flash', effort: 'low', system: 'Be brief.', first: 'first' }))
      const [name, kind, pane, args] = start.mock.calls[0] as unknown as [string, string, string, string[]]
      expect([name, kind, pane]).toEqual(['shep-agy-test', 'agy', 'fake-pane'])
      expect(args).toEqual(['--settings', JSON.stringify({ trustedWorkspaces: [cwd] }), '--model', 'gemini-3.8-flash', '--dangerously-skip-permissions'])
      const r = h.a.record(key)!
      expect(r.sessionId).toBeUndefined()
      expect(r.logs).toEqual([])
      expect(h.queued).toHaveLength(1)
      expect(h.queued[0][0]).toBe(hidden('Be brief.'))
      expect(h.queued[0][1]).toBe('first')
    } finally {
      h.a.stop()
      start.mockRestore()
      timer.mockRestore()
    }
  })

  test('access ask: no skip flag', async () => {
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    const h = harness()
    try {
      await h.a.ensure(base({ key: 'AGY-4/Agent', name: 'shep-agy-ask', access: 'ask', first: 'first' }))
      expect((start.mock.calls[0] as unknown as unknown[])[3]).toEqual(['--settings', JSON.stringify({ trustedWorkspaces: [cwd] })])
    } finally {
      h.a.stop()
      start.mockRestore()
      timer.mockRestore()
    }
  })

  test('the flags of a run: --conversation only when resuming with an id, --model when it has one, never --effort', () => {
    const h = harness()
    try {
      const r = { ...base(), logs: [], started: 0 } as unknown as AgentRecord
      const settings = ['--settings', JSON.stringify({ trustedWorkspaces: [cwd] })]
      expect(h.a.args({ ...r, model: 'gemini-3.8-flash', effort: 'high', sessionId: 'conv-9' }, true)).toEqual([...settings, '--conversation', 'conv-9', '--model', 'gemini-3.8-flash', '--dangerously-skip-permissions'])
      expect(h.a.args({ ...r, sessionId: 'conv-9' }, false)).toEqual([...settings, '--dangerously-skip-permissions'])
      expect(h.a.args({ ...r, sessionId: undefined }, true)).toEqual([...settings, '--dangerously-skip-permissions'])
      expect(h.a.args({ ...r, access: 'ask', model: 'default' }, false)).toEqual(settings)
    } finally {
      h.a.stop()
    }
  })

  test('the trust is for the run only: --settings carries the folder as trusted, quotes and spaces in its path intact', () => {
    const h = harness()
    const tricky = join(dir, 'my "worktree" folder')
    try {
      const r = { ...base({ cwd: tricky }), logs: [], started: 0 } as unknown as AgentRecord
      const a = h.a.args(r, false)
      expect(a[0]).toBe('--settings')
      expect(JSON.parse(a[1])).toEqual({ trustedWorkspaces: [tricky] })
    } finally {
      h.a.stop()
    }
  })
})

describe('reading an agy agent\'s log', () => {
  test('discoverLog: the newest conversation of its folder, its id taken from the log\'s name', () => {
    const h = harness()
    try {
      h.a.adopt(key, { name: 'shep-agy-found', cwd } as never, 'agy', 'test')
      const r = h.a.record(key)!
      r.started = 0
      h.a.discoverLog(key)
      expect(r.sessionId).toBe('conv-found')
      expect(r.logs).toEqual([agyLogPath(home(), 'conv-found')])
    } finally {
      h.a.stop()
    }
  })

  test('discoverLog of a conversation it has: its mirror, and a mirror that cannot be read is logged', () => {
    const err = spyOn(console, 'error').mockImplementation(() => undefined)
    // a mirror whose last line is no JSON: the copy cannot go on from it
    mkdirSync(join(home(), 'agy'), { recursive: true })
    writeFileSync(agyLogPath(home(), 'conv-bad'), `${MIRROR_HEAD}\n{"idx":0}\nnot json\n`)
    const h = harness()
    try {
      h.a.adopt('AGY-2/Agent', { name: 'shep-agy-bad', cwd: join(dir, 'bad') } as never, 'agy', 'test')
      const r = h.a.record('AGY-2/Agent')!
      r.sessionId = 'conv-bad'
      h.a.discoverLog('AGY-2/Agent')
      expect(r.logs).toEqual([agyLogPath(home(), 'conv-bad')])
      expect(err.mock.calls.some((c) => /could not mirror agy conversation conv-bad/.test(String(c[0])))).toBe(true)
    } finally {
      h.a.stop()
      err.mockRestore()
    }
  })

  test('follow takes the conversation id of the mirrored log, not a uuid', () => {
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn()
      return 0
    }) as never)
    const h = harness()
    try {
      h.a.adopt('AGY-3/Agent', { name: 'shep-agy-follow', cwd } as never, 'agy', 'test')
      const r = h.a.record('AGY-3/Agent')!
      r.sessionId = 'conv-before'
      h.a.follow('AGY-3/Agent', Date.now() - 60_000)
      expect(r.sessionId).toBe('conv-found')
      expect(r.logs).toEqual([agyLogPath(home(), 'conv-found')])
    } finally {
      h.a.stop()
      timer.mockRestore()
    }
  })

  test('a headless agy run (agy -p) is background work, titled by its prompt', () => {
    expect(headlessJob({ argv: ['agy', '-p', 'Review the change in detail please'], at: 1 }, []).title).toBe('agy -p: Review the change in detail please')
  })
})
