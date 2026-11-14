// agy's store, read by Shepherdr (server/live/agy.ts): the protobuf decoder on hand-made and malformed bytes, the newest
// conversation of a folder in the summaries database, and the mirror of a conversation's final steps into a JSONL log.
// Every database is a fixture built here (agy-fixture.ts); SHEPHERDR_AGY_HOME points at a folder of the test's own.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agyLogPath, agyModelId, field, fields, MIRROR_HEAD, mirrorConversation, newestConversation, stepTime, summaryTime, text } from '../server/live/agy.ts'
import { findAgyLog, LOG_FINDERS, logKind } from '../server/live/readers/find.ts'
import { CHAT_KINDS, chatProblem, LogTail, readerFor } from '../server/live/readers/index.ts'
import { home, writeJson } from '../server/store.ts'
import { agentPayload, genRow, makeConversation, makeSummaries, noticePayload, pb, stepAt, toolPayload, userPayload, type StepRow } from './agy-fixture.ts'
import { tmp } from './tmp.ts'

const store = tmp('agy-store')
const savedHome = process.env.SHEPHERDR_AGY_HOME
const convs = join(store, 'conversations')

beforeAll(() => {
  process.env.SHEPHERDR_AGY_HOME = store
  mkdirSync(convs, { recursive: true })
  // the summaries of the folders the tests ask about (the bad rows default to the newest time: they must not match)
  const app = JSON.stringify(['file:///w/app'])
  makeSummaries(join(store, 'conversation_summaries.db'), [
    { id: 'conv-old', uris: app, last: '2026-11-10 10:00:00.000+00:00' },
    { id: 'conv-new', uris: app, last: '2026-11-12 10:00:00.5+00:00' },
    { id: 'conv-sub', uris: app, depth: 1, last: '2026-11-13 15:00:00+00:00' },
    { id: 'conv-killed', uris: app, killed: 1, last: '2026-11-13 16:00:00+00:00' },
    { id: 'conv-ours', uris: app, last: '2026-11-13 12:00:00+00:00' },
    { id: 'conv-enc', uris: JSON.stringify(['file:///w/my%20app']), last: '2026-11-11 10:00:00+00:00' },
    { id: 'conv-nulls', uris: app, depth: null, last: null },
    { id: 'conv-badjson', uris: 'not json' },
    { id: 'conv-notlist', uris: '"file:///w/app"' },
    { id: 'conv-nouris', uris: null },
    { id: 'conv-other', uris: JSON.stringify(['file:///w/other']), last: '2026-11-13 13:00:00+00:00' },
    { id: 'conv-f', uris: JSON.stringify(['file:///w/agy-app']), last: '2026-11-13 14:00:00+00:00' },
  ])
})

afterAll(() => {
  if (savedHome === undefined) delete process.env.SHEPHERDR_AGY_HOME
  else process.env.SHEPHERDR_AGY_HOME = savedHome
  rmSync(store, { recursive: true, force: true })
})

/** a fresh folder for one test's files (headless.json lives in it) */
const folder = (name: string) => tmp(`agy-${name}`)

describe('the protobuf decoder', () => {
  test('fields in order, with their wire types: varints, 64- and 32-bit fixed values, length-delimited bytes', () => {
    // field 1 varint 150; field 2 fixed64; field 3 fixed32; field 2 bytes "hi"
    const buf = Uint8Array.from([0x08, 0x96, 0x01, 0x11, 1, 2, 3, 4, 5, 6, 7, 8, 0x1d, 9, 8, 7, 6, 0x12, 0x02, 0x68, 0x69])
    const parts = fields(buf)!
    expect(parts.map((f) => [f.field, f.wire])).toEqual([[1, 0], [2, 1], [3, 5], [2, 2]])
    expect(parts[0].value).toBe(150)
    expect(text(parts[3].value)).toBe('hi')
    expect(fields(new Uint8Array(0))).toEqual([])
  })

  test('a path reads the first value it finds, through nested messages; field numbers past 15 have longer tags', () => {
    const buf = pb({ '140.2.1': 'output', '19.2': 'hello' })
    expect(text(field(buf, '140.2.1'))).toBe('output')
    expect(text(field(buf, '19.2'))).toBe('hello')
    expect(field(buf, '9')).toBeUndefined()
    expect(field(buf, '140.2.9')).toBeUndefined()
    // two values of field 1: the first is read
    expect(field(Uint8Array.from([0x08, 1, 0x08, 2]), '1')).toBe(1)
    // a path past a plain number finds nothing
    expect(field(pb({ '1': 5 }), '1.2')).toBeUndefined()
  })

  test('bytes that are no message are undefined, and never throw', () => {
    const bad: number[][] = [
      [0x80], // a key that is cut short
      [0x00, 0x01], // field 0
      [0x0b], // wire type 3 (groups are not kept)
      [0x0c], // wire type 4
      [0x08, 0x80], // a varint cut short
      [0x08, ...Array(10).fill(0x80)], // a varint that goes on too long
      [0x09, 1, 2], // a 64-bit value cut short
      [0x0d, 1], // a 32-bit value cut short
      [0x0a], // a length that is missing
      [0x0a, 0x05, 0x61], // a length longer than the bytes left
      [0x0a, 0x80], // a length cut short
    ]
    for (const b of bad) {
      const buf = Uint8Array.from(b)
      expect(fields(buf)).toBeUndefined()
      expect(field(buf, '1')).toBeUndefined()
    }
  })

  test('text: printable UTF-8 with at least 95% printable characters; nothing else', () => {
    expect(text(new TextEncoder().encode('line one\nline two'))).toBe('line one\nline two')
    expect(text(new TextEncoder().encode('naïve'))).toBe('naïve')
    expect(text(Uint8Array.from([0xff, 0xfe]))).toBeUndefined()
    expect(text(new Uint8Array(0))).toBeUndefined()
    expect(text(new TextEncoder().encode('\u0001\u0002'))).toBeUndefined()
    expect(text(new TextEncoder().encode(`${'a'.repeat(19)}\u0001`))).toBeUndefined()
    expect(text(new TextEncoder().encode(`${'a'.repeat(39)}\u0001`))).toBe(`${'a'.repeat(39)}\u0001`)
    expect(text(0)).toBeUndefined()
    expect(text(undefined)).toBeUndefined()
  })

  test('a step time from its seconds and nanoseconds; none when it has none', () => {
    expect(stepTime(pb({ ...stepAt(10, 500_000_000) }))).toBe(10_500)
    expect(stepTime(pb({ '5.1.1': 10 }))).toBe(10_000)
    expect(stepTime(new Uint8Array(0))).toBe(0)
    expect(stepTime(Uint8Array.from([0x0a, 0x05, 0x61]))).toBe(0)
  })

  test('the summaries\' time as ms, nanoseconds cut; nothing that is no time is 0', () => {
    expect(summaryTime('2026-11-13 19:55:57.91895555+00:00')).toBe(Date.UTC(2026, 10, 13, 19, 55, 57, 918))
    expect(summaryTime('soon')).toBe(0)
    expect(summaryTime(undefined)).toBe(0)
  })

  test('an agy model id with its effort appended, when the models list has that id', () => {
    expect(agyModelId('gemini-3.8-flash', 'low', ['gemini-3.8-flash-low'])).toBe('gemini-3.8-flash-low')
    // an effort the model has no id for takes the model's own default variant
    expect(agyModelId('gemini-3.8-flash', 'high', ['gemini-3.8-flash-low'])).toBe('gemini-3.8-flash-low')
    // a model with no effort given takes its medium variant, else its lowest one: never a base id agy does not list
    expect(agyModelId('gemini-3.8-flash', undefined, ['gemini-3.8-flash-low'])).toBe('gemini-3.8-flash-low')
    expect(agyModelId('gemini-3.8-flash', undefined, ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium'])).toBe('gemini-3.8-flash-medium')
    expect(agyModelId('gemini-3.8-flash', 'max', ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'])).toBe('gemini-3.8-flash-low')
    // a full id stands as it is, and a model with no variants too
    expect(agyModelId('gemini-3.8-flash-high', undefined, ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'])).toBe('gemini-3.8-flash-high')
    expect(agyModelId('gemini-pro-orchestrator-g1-pro', 'low', ['gemini-pro-orchestrator-g1-pro'])).toBe('gemini-pro-orchestrator-g1-pro')
    expect(agyModelId('gemini-9', undefined, [])).toBe('gemini-9')
  })
})

describe('the newest conversation of a folder', () => {
  test('the newest top-level conversation whose workspace is the folder, a trailing slash aside', () => {
    const dir = folder('newest')
    expect(newestConversation('/w/app/', 0, dir)).toBe('conv-ours')
    expect(newestConversation('/w/app', 0, dir)).toBe('conv-ours')
  })

  test('the folder in its URI-encoded form too', () => {
    expect(newestConversation('/w/my app', 0, folder('enc'))).toBe('conv-enc')
  })

  test('sinceMs: only a conversation changed at or after it', () => {
    const dir = folder('since')
    expect(newestConversation('/w/app', Date.UTC(2026, 10, 13, 12), dir)).toBe('conv-ours')
    expect(newestConversation('/w/app', Date.UTC(2026, 10, 13, 12, 30), dir)).toBeUndefined()
  })

  test('subagents, killed conversations and Shepherdr\'s own headless runs are left out', () => {
    const dir = folder('headless')
    // conv-sub (depth 1) and conv-killed are newer than conv-ours, and still not the answer
    writeJson('agy/headless.json', ['conv-ours', 5], dir)
    expect(newestConversation('/w/app', 0, dir)).toBe('conv-new')
    // a headless list that is no list is nothing to leave out
    writeJson('agy/headless.json', { ids: ['conv-ours'] }, dir)
    expect(newestConversation('/w/app', 0, dir)).toBe('conv-ours')
  })

  test('a folder with no conversation, and a blank or root folder, have none', () => {
    const dir = folder('none')
    expect(newestConversation('/w/nowhere', 0, dir)).toBeUndefined()
    expect(newestConversation(' ', 0, dir)).toBeUndefined()
    expect(newestConversation('/', 0, dir)).toBeUndefined()
  })

  test('a workspace list that is no list, no JSON or missing never matches', () => {
    // conv-badjson, conv-notlist and conv-nouris name no folder, though they are the newest rows
    expect(newestConversation('/w/app', 0, folder('bad'))).toBe('conv-ours')
  })

  test('no summaries, or summaries that are not a database: nothing, never a throw', () => {
    const saved = process.env.SHEPHERDR_AGY_HOME
    process.env.SHEPHERDR_AGY_HOME = join(store, 'missing-home')
    expect(newestConversation('/w/app', 0, folder('missing'))).toBeUndefined()
    const broken = folder('broken')
    writeFileSync(join(broken, 'conversation_summaries.db'), 'not a database')
    process.env.SHEPHERDR_AGY_HOME = broken
    expect(newestConversation('/w/app', 0, folder('broken-dir'))).toBeUndefined()
    process.env.SHEPHERDR_AGY_HOME = saved
  })
})

/** the steps of the mirror fixture conversation: a user line, a tool decision, a tool call, a reply, a notice, a step of
 *  an unknown kind and a failed model response */
const SAMPLE: StepRow[] = [
  { idx: 0, step_type: 14, payload: userPayload('hello', 100) },
  { idx: 1, step_type: 15, payload: agentPayload({ sec: 101, tokensIn: 10, tokensOut: 2 }) },
  { idx: 2, step_type: 132, payload: toolPayload({ tool: 'run_command', args: '{"CommandLine":"ls"}', output: 'Command exited with code 1.', sec: 102 }) },
  { idx: 3, step_type: 15, payload: agentPayload({ text: 'Done', sec: 103 }) },
  { idx: 4, step_type: 101, payload: noticePayload('All stopped') },
  { idx: 5, step_type: 23 },
  { idx: 6, step_type: 15, error: pb({ '1': 'quota', '2': 'exceeded' }) },
]
const GENS = [
  genRow({ label: 'Gemini 3.8 Flash (Low)', id: 'gemini-3.8-flash-low' }),
  genRow({ label: 'Gemini 3.8 Flash (Low)', tokensIn: 7, tokensOut: 3 }),
  genRow({ label: 'Gemini 3.8 Flash (High)' }),
]

/** the JSON lines of a mirror file, parsed */
/** a mirror's step lines (its first line is the format's head) */
const lines = (file: string) => readFileSync(file, 'utf8').trim().split('\n').filter((l) => l !== MIRROR_HEAD).map((l) => JSON.parse(l))

/** adds a step to a conversation database, as agy would while the turn runs */
function addStep(id: string, row: StepRow) {
  const d = new Database(join(convs, `${id}.db`))
  d.run('INSERT INTO steps (idx, step_type, status, error_details, step_payload) VALUES (?, ?, ?, ?, ?)', [row.idx, row.step_type, row.status ?? 3, row.error ?? null, row.payload ?? null])
  d.close()
}

describe('the mirror of a conversation', () => {
  beforeAll(() => {
    makeConversation(join(convs, 'conv-a.db'), SAMPLE, GENS)
  })

  test('each final step as one line: what the chat reads of it, the model and the tokens of each model response', () => {
    const file = join(folder('mirror'), 'conv-a.jsonl')
    expect(mirrorConversation('conv-a', file)).toBe(7)
    expect(lines(file)).toEqual([
      { idx: 0, at: 100_000, kind: 'user', text: 'hello' },
      { idx: 1, at: 101_000, kind: 'agent', model: 'gemini-3.8-flash-low', tokensIn: 10, tokensOut: 2 },
      { idx: 2, at: 102_000, kind: 'tool', tool: 'run_command', args: '{"CommandLine":"ls"}', output: 'Command exited with code 1.' },
      { idx: 3, at: 103_000, kind: 'agent', text: 'Done', model: 'Gemini 3.8 Flash (Low)', tokensIn: 7, tokensOut: 3 },
      { idx: 4, at: 1_700_000_003_000, kind: 'notice', text: 'All stopped' },
      { idx: 5, at: 0, kind: 'other' },
      { idx: 6, at: 0, kind: 'error', text: 'quota | exceeded' },
    ])
  })

  test('a second mirror writes what is new only, and nothing when there is none', () => {
    const file = join(folder('again'), 'conv-a.jsonl')
    expect(mirrorConversation('conv-a', file)).toBe(7)
    expect(mirrorConversation('conv-a', file)).toBe(0)
    expect(lines(file)).toHaveLength(7)
  })

  test('the mirror stops at the first step still running, and goes on when it is final', () => {
    makeConversation(join(convs, 'conv-b.db'), [{ idx: 0, step_type: 14, payload: userPayload('one') }, { idx: 1, step_type: 15, status: 1, payload: agentPayload({ text: 'partial' }) }])
    const file = join(folder('partial'), 'conv-b.jsonl')
    expect(mirrorConversation('conv-b', file)).toBe(1)
    addStep('conv-b', { idx: 2, step_type: 14, payload: userPayload('two'), status: 3 })
    // step 1 still runs: nothing after it is copied
    expect(mirrorConversation('conv-b', file)).toBe(0)
    const d = new Database(join(convs, 'conv-b.db'))
    d.run('UPDATE steps SET status = 3, step_payload = ? WHERE idx = 1', [agentPayload({ text: 'final' })])
    d.close()
    expect(mirrorConversation('conv-b', file)).toBe(2)
    expect(lines(file).map((l) => l.idx)).toEqual([0, 1, 2])
    expect(lines(file)[1]).toMatchObject({ kind: 'agent', text: 'final' })
  })

  test('the statuses 0, 1 and 2 are not final; 3 and 6 are', () => {
    makeConversation(join(convs, 'conv-s.db'), [
      { idx: 0, step_type: 14, status: 3, payload: userPayload('s3') },
      { idx: 1, step_type: 14, status: 6, payload: userPayload('s6') },
      { idx: 2, step_type: 14, status: 2, payload: userPayload('s2') },
      { idx: 3, step_type: 14, status: 1, payload: userPayload('s1') },
      { idx: 4, step_type: 14, status: 0, payload: userPayload('s0') },
    ])
    const file = join(folder('status'), 'conv-s.jsonl')
    expect(mirrorConversation('conv-s', file)).toBe(2)
    const d = new Database(join(convs, 'conv-s.db'))
    d.run('UPDATE steps SET status = 3 WHERE idx IN (2, 3)')
    d.close()
    expect(mirrorConversation('conv-s', file)).toBe(2)
    expect(lines(file).map((l) => l.idx)).toEqual([0, 1, 2, 3])
    expect(mirrorConversation('conv-s', file)).toBe(0)
  })

  test('a conversation with no database: nothing written and no file made', () => {
    const file = join(folder('nodb'), 'conv-none.jsonl')
    expect(mirrorConversation('conv-none', file)).toBe(0)
    expect(existsSync(file)).toBe(false)
  })

  test('an empty mirror file, or one with its head alone, is read from the first step; a last line that is not JSON, or no step, throws', () => {
    const dir = folder('empty')
    const empty = join(dir, 'conv-a.jsonl')
    writeFileSync(empty, '')
    expect(mirrorConversation('conv-a', empty)).toBe(7)
    expect(readFileSync(empty, 'utf8').split('\n')[0]).toBe(MIRROR_HEAD)
    const headOnly = join(dir, 'head.jsonl')
    writeFileSync(headOnly, `${MIRROR_HEAD}\n`)
    expect(mirrorConversation('conv-a', headOnly)).toBe(7)
    const broken = join(dir, 'broken.jsonl')
    writeFileSync(broken, `${MIRROR_HEAD}\n{"idx":0}\nnot json\n`)
    expect(() => mirrorConversation('conv-a', broken)).toThrow('ends in a line that is no mirrored step')
    const nostep = join(dir, 'nostep.jsonl')
    writeFileSync(nostep, `${MIRROR_HEAD}\n{"kind":"user"}\n`)
    expect(() => mirrorConversation('conv-a', nostep)).toThrow('ends in a line that is no mirrored step')
  })

  test('a mirror an older Shepherdr wrote (no head; a cut-off read as nothing) is written again whole, as a new file', () => {
    const dir = folder('old')
    const file = join(dir, 'conv-a.jsonl')
    // the old format: every step as it read them then, a provider's cut-off among them as kind other
    writeFileSync(file, '{"idx":0,"at":0,"kind":"user","text":"old"}\n{"idx":1,"at":0,"kind":"other"}\n')
    const was = statSync(file).ino
    expect(mirrorConversation('conv-a', file)).toBe(7)
    expect(readFileSync(file, 'utf8').split('\n')[0]).toBe(MIRROR_HEAD)
    expect(lines(file).map((l) => l.idx)).toEqual([0, 1, 2, 3, 4, 5, 6])
    // a new file: the chat's reader starts it over from its first line
    expect(statSync(file).ino).not.toBe(was)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    // and then it goes on as any mirror: nothing new, nothing written
    expect(mirrorConversation('conv-a', file)).toBe(0)
  })

  test('a step whose payload or error is malformed keeps what it can: no text, no time, "the step failed"', () => {
    makeConversation(join(convs, 'conv-bad.db'), [
      { idx: 0, step_type: 14, payload: Uint8Array.from([0x0a, 0x05, 0x61]) },
      { idx: 1, step_type: 15, error: Uint8Array.from([0x0a]) },
      { idx: 2, step_type: 132, payload: Uint8Array.from([0x80]) },
    ])
    const file = join(folder('bad'), 'conv-bad.jsonl')
    expect(mirrorConversation('conv-bad', file)).toBe(3)
    expect(lines(file)).toEqual([
      { idx: 0, at: 0, kind: 'user' },
      { idx: 1, at: 0, kind: 'error', text: 'the step failed' },
      { idx: 2, at: 0, kind: 'tool' },
    ])
  })

  test('a provider error (step type 17) is an error line with its text and HTTP status; its short text alone, or none, still is one', () => {
    const quota = pb({ ...stepAt(104), '24.3.1': 'Individual quota reached.', '24.3.2': 'RESOURCE_EXHAUSTED (code 429): Individual quota reached.', '24.3.7': 429 })
    makeConversation(join(convs, 'conv-q.db'), [
      { idx: 0, step_type: 17, payload: quota },
      { idx: 1, step_type: 17, payload: pb({ ...stepAt(105), '24.3.1': 'Out of credit.' }) },
      { idx: 2, step_type: 17, payload: pb({ ...stepAt(106) }) },
    ])
    const file = join(folder('quota'), 'conv-q.jsonl')
    expect(mirrorConversation('conv-q', file)).toBe(3)
    expect(lines(file)).toEqual([
      { idx: 0, at: 104_000, kind: 'error', text: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached.', status: 429 },
      { idx: 1, at: 105_000, kind: 'error', text: 'Out of credit.' },
      { idx: 2, at: 106_000, kind: 'error', text: 'the step failed' },
    ])
  })

  test('a model response with no generation row, or one with no model: the tokens of the row, and no model', () => {
    makeConversation(join(convs, 'conv-d.db'), [
      { idx: 0, step_type: 15, payload: agentPayload({ text: 'x' }) },
      { idx: 1, step_type: 15, payload: agentPayload({ text: 'y' }) },
    ], [genRow({ tokensIn: 4, tokensOut: 1 })])
    const file = join(folder('gen'), 'conv-d.jsonl')
    expect(mirrorConversation('conv-d', file)).toBe(2)
    expect(lines(file)).toEqual([
      { idx: 0, at: 1_700_000_001_000, kind: 'agent', text: 'x', tokensIn: 4, tokensOut: 1 },
      { idx: 1, at: 1_700_000_001_000, kind: 'agent', text: 'y' },
    ])
  })
})

describe('agy in the finder and the chat reader', () => {
  test('a folder\'s conversation is mirrored into Shepherdr\'s home', () => {
    makeConversation(join(convs, 'conv-f.db'), [{ idx: 0, step_type: 14, payload: userPayload('hi there') }])
    const path = findAgyLog('/w/agy-app/')!
    expect(path).toBe(agyLogPath(home(), 'conv-f'))
    expect(lines(path)).toEqual([{ idx: 0, at: 1_700_000_000_000, kind: 'user', text: 'hi there' }])
  })

  test('sinceMs and headless runs: no conversation, so no log', () => {
    expect(findAgyLog('/w/agy-app', Date.UTC(2026, 10, 13, 15))).toBeUndefined()
    writeJson('agy/headless.json', ['conv-f'], home())
    expect(findAgyLog('/w/agy-app')).toBeUndefined()
    writeJson('agy/headless.json', [], home())
  })

  test('agy is a log finder and a chat kind, its logs are told by where they lie', () => {
    expect(LOG_FINDERS.agy).toBe(findAgyLog)
    expect(CHAT_KINDS).toContain('agy')
    expect(chatProblem('agy')).toBeUndefined()
    expect(logKind(agyLogPath(home(), 'conv-f'))).toBe('agy')
    expect(logKind(join(home(), 'elsewhere', 'conv-f.jsonl'))).toBeUndefined()
  })

  test('a tail over the mirror reads the steps written since, from the store', () => {
    const path = findAgyLog('/w/agy-app')!
    const tail = new LogTail(path, readerFor('agy')!)
    expect(tail.read().map((e) => e.kind)).toEqual(['session', 'turn-start', 'user'])
    addStep('conv-f', { idx: 1, step_type: 15, payload: agentPayload({ text: 'hello back', tokensIn: 3, tokensOut: 1 }) })
    expect(tail.read().map((e) => e.kind)).toEqual(['agent', 'usage', 'turn-end'])
    expect(readFileSync(path, 'utf8')).toContain('hello back')
  })

  test('a mirror that cannot be read does not throw from the finder: its log is still named', () => {
    const path = agyLogPath(home(), 'conv-f')
    writeFileSync(path, `${MIRROR_HEAD}\n{"idx":0}\nnot json\n`)
    expect(findAgyLog('/w/agy-app')).toBe(path)
    rmSync(path)
  })
})
