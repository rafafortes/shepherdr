// Finding OpenCode's session in its database, its log kind, and the log's refresh on every read. A fixture database
// keeps OpenCode's session_v2 and session_message tables; rows added to it between two reads show up in the tail.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { opencodeLogPath } from '../server/live/opencode.ts'
import { findOpencodeLog, LOG_FINDERS, logKind } from '../server/live/readers/find.ts'
import { LogTail, readerFor } from '../server/live/readers/index.ts'
import { home } from '../server/store.ts'
import { tmp } from './tmp.ts'

let dir = ''
let db = ''
const savedDb = process.env.SHEPHERDR_OPENCODE_DB

beforeAll(() => {
  dir = tmp('opencode-finder')
  db = join(dir, 'opencode.db')
  const d = new Database(db, { create: true })
  d.run('CREATE TABLE session_v2 (id text primary key, directory text, parent_id text, time_archived integer, time_updated integer)')
  d.run('CREATE TABLE session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)')
  const s = d.prepare('INSERT INTO session_v2 (id, directory, parent_id, time_archived, time_updated) VALUES (?, ?, ?, ?, ?)')
  s.run('ses_old', '/w/app', null, null, 100)
  s.run('ses_new', '/w/app', null, null, 300)
  // a subagent's session, newer than the top-level one: never the folder's log
  s.run('ses_child', '/w/app', 'ses_new', null, 900)
  // archived: never the folder's log
  s.run('ses_archived', '/w/app', null, 500, 800)
  s.run('ses_other', '/w/other', null, null, 1000)
  d.close()
  process.env.SHEPHERDR_OPENCODE_DB = db
})

afterAll(() => {
  if (savedDb === undefined) delete process.env.SHEPHERDR_OPENCODE_DB
  else process.env.SHEPHERDR_OPENCODE_DB = savedDb
  rmSync(dir, { recursive: true, force: true })
})

/** a row of a session, added to the fixture database as OpenCode would write it */
function addMessage(sid: string, seq: number, type: string, data: object, file = db) {
  const d = new Database(file)
  d.run('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)', [`${sid}-${seq}`, sid, type, seq, 1, 1, JSON.stringify(data)])
  d.close()
}

describe('finding the OpenCode session of a folder', () => {
  test('the newest top-level session of the folder, mirrored into Shepherdr\'s home; a trailing slash does not matter', () => {
    addMessage('ses_new', 1, 'user', { time: { created: 310 }, text: 'hello', files: [] })
    const path = opencodeLogPath(home(), 'ses_new')
    expect(findOpencodeLog('/w/app/')).toBe(path)
    expect(readFileSync(path, 'utf8')).toContain('hello')
    expect(findOpencodeLog('/w/app')).toBe(path)
  })

  test('a folder with no session, and a folder with only archived or subagent sessions, has no log', () => {
    expect(findOpencodeLog('/w/nowhere')).toBeUndefined()
    expect(findOpencodeLog('  ')).toBeUndefined()
  })

  test('sinceMs: only a session changed at or after it', () => {
    expect(findOpencodeLog('/w/app', 300)).toBe(opencodeLogPath(home(), 'ses_new'))
    expect(findOpencodeLog('/w/app', 301)).toBeUndefined()
    expect(findOpencodeLog('/w/other', 1000)).toBe(opencodeLogPath(home(), 'ses_other'))
  })

  test('no database, or one that is not a database: no log, and no throw', () => {
    process.env.SHEPHERDR_OPENCODE_DB = join(dir, 'none.db')
    expect(findOpencodeLog('/w/app')).toBeUndefined()
    const broken = join(dir, 'broken.db')
    writeFileSync(broken, 'not a database')
    process.env.SHEPHERDR_OPENCODE_DB = broken
    expect(findOpencodeLog('/w/app')).toBeUndefined()
    process.env.SHEPHERDR_OPENCODE_DB = db
  })

  test('a session whose rows cannot be mirrored still has its log path, and no throw', () => {
    const noMessages = join(dir, 'no-messages.db')
    const d = new Database(noMessages, { create: true })
    d.run('CREATE TABLE session_v2 (id text primary key, directory text, parent_id text, time_archived integer, time_updated integer)')
    d.run("INSERT INTO session_v2 VALUES ('ses_m', '/w/m', NULL, NULL, 5)")
    d.close()
    process.env.SHEPHERDR_OPENCODE_DB = noMessages
    expect(findOpencodeLog('/w/m')).toBe(opencodeLogPath(home(), 'ses_m'))
    process.env.SHEPHERDR_OPENCODE_DB = db
  })

  test('OpenCode is a log finder, and its logs are told by where they lie', () => {
    expect(LOG_FINDERS.opencode).toBe(findOpencodeLog)
    expect(logKind(opencodeLogPath(home(), 'ses_x'))).toBe('opencode')
    expect(logKind(join(home(), 'elsewhere', 'ses_x.jsonl'))).toBeUndefined()
  })
})

describe('the OpenCode log is read again as its session grows', () => {
  test('a tail over the mirrored log picks up rows added to the database between two reads', () => {
    const path = findOpencodeLog('/w/app')!
    const tail = new LogTail(path, readerFor('opencode')!)
    const first = tail.read().map((e) => e.kind)
    expect(first).toEqual(['session', 'turn-start', 'user'])
    expect(tail.read()).toEqual([])
    addMessage('ses_new', 2, 'assistant', { time: { created: 320, completed: 325 }, model: { id: 'm', providerID: 'opencode' }, content: [{ type: 'text', text: 'HERON' }], finish: 'stop', tokens: { input: 2, output: 1 } })
    const got = tail.read()
    expect(got.find((e) => e.kind === 'agent')).toMatchObject({ kind: 'agent', text: 'HERON' })
    expect(got.map((e) => e.kind)).toContain('turn-end')
    addMessage('ses_new', 3, 'user', { time: { created: 330 }, text: 'second', files: [] })
    expect(tail.read().map((e) => e.kind)).toEqual(['turn-start', 'user'])
    // readAll starts from the top of the mirrored log, the rows it has so far
    expect(tail.readAll().map((e) => e.kind)).toEqual(['session', 'turn-start', 'user', 'runtime', 'agent', 'usage', 'turn-end', 'turn-start', 'user'])
  })

  test('a database that cannot be read never breaks the read of the log it has already written', () => {
    const path = findOpencodeLog('/w/app')!
    const tail = new LogTail(path, readerFor('opencode')!)
    const broken = join(dir, 'broken-again.db')
    writeFileSync(broken, 'not a database')
    process.env.SHEPHERDR_OPENCODE_DB = broken
    try {
      expect(() => tail.read()).not.toThrow()
      expect(tail.read()).toEqual([])
    } finally {
      process.env.SHEPHERDR_OPENCODE_DB = db
    }
  })
})
