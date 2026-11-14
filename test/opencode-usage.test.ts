// The usage feed on OpenCode's agents: their calls are read from the log copy of their session (opencode.ts mirrorSession),
// which is made by the read itself, so a session whose copy does not exist yet is counted too. A call is counted once,
// by its message id, across passes and restarts; an unfinished reply counts when it is finished, and an error or a user's
// abort carries no tokens of its own.
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentRecord } from '../server/live/agents.ts'
import { opencodeLogPath } from '../server/live/opencode.ts'
import { UsageFeed } from '../server/live/usage-feed.ts'
import { UsageLedger, HOUR } from '../server/live/usage-ledger.ts'
import { home } from '../server/store.ts'
import { tmp } from './tmp.ts'

const NOW = Date.now()
const GO = 'opencode.opencode-go/deepseek-v4.1-flash'

/** an OpenCode database with the rows of one session (id, type, seq, data); the session is its own per test, so a log
 *  copy from another test never stands in for it. OpenCode's database is the one SHEPHERDR_OPENCODE_DB names */
function database(session: string, rows: { id: string; type: string; seq: number; data: object }[]): string {
  const file = join(tmp('opencode-usage-db'), 'opencode.db')
  const d = new Database(file, { create: true })
  d.run('CREATE TABLE session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)')
  const ins = d.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (const r of rows) ins.run(r.id, session, r.type, r.seq, NOW, NOW, JSON.stringify(r.data))
  d.close()
  process.env.SHEPHERDR_OPENCODE_DB = file
  return file
}

/** an assistant reply of the session, an hour ago, with its model and tokens */
const reply = (id: string, seq: number, model: { providerID: string; id: string }, tokens: number, extra: object = {}) => ({
  id,
  type: 'assistant',
  seq,
  data: {
    model,
    content: [{ type: 'text', text: 'done' }],
    finish: 'stop',
    cost: 0,
    tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: NOW - HOUR, completed: NOW - HOUR + 2000 },
    ...extra,
  },
})

const agent = (key: string, log: string, session: string): Record<string, AgentRecord> => ({ [key]: { key, name: key, kind: 'opencode', cwd: '/x', workspace: 'w', logs: [log], started: NOW, sessionId: session } as AgentRecord })

describe("OpenCode's agents count their calls in the usage ledger", () => {
  test('the first pass makes the log copy and counts each finished reply on its model; a later pass counts the new ones once', () => {
    const session = 'ses_feed1'
    const db = database(session, [
      { id: 'u1', type: 'user', seq: 1, data: { text: 'go', time: { created: NOW - HOUR } } },
      { id: 'a1', type: 'assistant', seq: 2, data: reply('a1', 2, { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' }, 120).data },
    ])
    const dir = tmp('opencode-usage-ledger')
    const log = opencodeLogPath(home(), session)
    const ledger = new UsageLedger(dir, true)
    const feed = new UsageFeed(ledger, () => agent('T-9/Agent', log, session))
    expect(existsSync(log)).toBe(false)
    expect(feed.pass(NOW)).toBe(false)
    expect(existsSync(log)).toBe(true)
    expect(ledger.byKey(NOW - 24 * HOUR).get(GO)).toEqual({ tokens: 120, calls: 1, cost: 0 })
    // nothing new: nothing counted again
    feed.pass(NOW)
    expect(ledger.byKey(NOW - 24 * HOUR).get(GO)!.calls).toBe(1)
    // a reply that is written since, on a free model: counted once, and the copy of the others is not counted again
    const d = new Database(db)
    d.run('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      'a2',
      session,
      'assistant',
      3,
      NOW,
      NOW,
      JSON.stringify(reply('a2', 3, { providerID: 'opencode', id: 'minimax-m3.1-flash-free' }, 40).data),
    ])
    d.close()
    feed.pass(NOW)
    expect(ledger.byKey(NOW - 24 * HOUR).get('opencode.opencode/minimax-m3.1-flash-free')).toEqual({ tokens: 40, calls: 1, cost: 0 })
    expect(ledger.byKey(NOW - 24 * HOUR).get(GO)!.calls).toBe(1)
  })

  test('a restart reads on from the saved position: nothing is counted twice, and an error or an abort adds no tokens', () => {
    const session = 'ses_feed2'
    const dir = tmp('opencode-usage-restart')
    const log = opencodeLogPath(home(), session)
    const a = new UsageLedger(dir)
    database(session, [
      { id: 'a3', type: 'assistant', seq: 1, data: reply('a3', 1, { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' }, 70).data },
      // a provider's quota error: no tokens, the error is in the chat
      { id: 'a4', type: 'assistant', seq: 2, data: reply('a4', 2, { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' }, 0, { finish: 'error', error: { type: 'provider.quota', message: 'Go usage limit exceeded', status: 429 } }).data },
      // the user's abort: the same, with its own type
      { id: 'a5', type: 'assistant', seq: 3, data: reply('a5', 3, { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' }, 0, { finish: 'error', error: { type: 'aborted', message: 'Step interrupted' } }).data },
    ])
    new UsageFeed(a, () => agent('T-8/Agent', log, session)).pass(NOW)
    a.flush(NOW)
    expect(a.byKey(NOW - 24 * HOUR).get(GO)).toEqual({ tokens: 70, calls: 1, cost: 0 })
    // a new process reads on from the saved position: no call is counted again
    const b = new UsageLedger(dir)
    new UsageFeed(b, () => agent('T-8/Agent', log, session)).pass(NOW)
    expect(b.byKey(NOW - 24 * HOUR).get(GO)).toEqual({ tokens: 70, calls: 1, cost: 0 })
  })
})
