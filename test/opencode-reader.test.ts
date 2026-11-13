// The opencode log reader, on mirrored lines in the shape server/live/opencode.ts writes ({id, type, seq, time, data}).
import { describe, expect, test } from 'bun:test'
import { OpencodeReader } from '../server/live/readers/opencode.ts'
import type { LogEvent } from '../server/live/readers/types.ts'

const FILE = '/home/me/.shepherdr/opencode/ses_1.jsonl'
const line = (o: object, offset = 0) => ({ text: JSON.stringify(o), offset })
const parse = (objs: object[], reader = new OpencodeReader(), file = FILE): LogEvent[] => reader.parse(objs.map((o, i) => line(o, i * 100)), file)
const row = (id: string, type: string, data: object, time = 1) => ({ id, type, seq: 1, time, data })
const turn = (id: string, data: object) => row(id, 'assistant', { time: { created: 10, completed: 12 }, ...data })
const SESSION = { kind: 'session' as const, file: FILE, id: 'session-ses_1', at: 1, sessionId: 'ses_1' }

/** the events without the session, runtime, usage and turn-start lines, as kind:id */
const brief = (ev: LogEvent[]) =>
  ev.filter((e) => e.kind !== 'session' && e.kind !== 'runtime' && e.kind !== 'usage' && e.kind !== 'turn-start').map((e) => (e.kind === 'user' || e.kind === 'agent' ? `${e.kind}:${e.text}` : `${e.kind}:${e.id}`))
/** the turn starts and ends, in order, as kind:id */
const turns = (ev: LogEvent[]) => ev.filter((e) => e.kind === 'turn-start' || e.kind === 'turn-end').map((e) => `${e.kind}:${e.id}`)

describe('opencode reader', () => {
  test('user text starts a turn, trimmed, and the session starts before it', () => {
    const ev = parse([row('u1', 'user', { time: { created: 100 }, text: '  What is the word?\n ', files: [] })])
    expect(ev).toEqual([
      { ...SESSION, at: 100 },
      { kind: 'turn-start', id: 'start-u1', at: 100 },
      { kind: 'user', id: 'u1', at: 100, text: 'What is the word?' },
    ])
  })

  test('a user row without text starts the turn and says nothing', () => {
    expect(parse([row('u2', 'user', {})]).slice(1)).toEqual([{ kind: 'turn-start', id: 'start-u2', at: 1 }])
    expect(parse([row('u3', 'user', { text: 42 })]).map((e) => e.kind)).toEqual(['session', 'turn-start'])
  })

  test('the session is named by the file, and starts once per file, at its first line', () => {
    const reader = new OpencodeReader()
    const first = parse([row('u4', 'user', { text: 'a' }, 50)], reader, '/x/ses_9.jsonl')
    expect(first[0]).toEqual({ kind: 'session', file: '/x/ses_9.jsonl', id: 'session-ses_9', at: 50, sessionId: 'ses_9' })
    expect(parse([row('u5', 'user', { text: 'b' }, 60)], reader, '/x/ses_9.jsonl').map((e) => e.kind)).toEqual(['turn-start', 'user'])
    // another file is another session
    expect(parse([row('u6', 'user', { text: 'c' })], reader, '/x/ses_8.jsonl')[0]).toMatchObject({ kind: 'session', sessionId: 'ses_8' })
  })

  test('a reset file starts its session over', () => {
    const reader = new OpencodeReader()
    parse([row('u7', 'user', { text: 'a' })], reader)
    reader.reset(FILE)
    expect(parse([row('u8', 'user', { text: 'b' })], reader)[0]).toMatchObject({ kind: 'session', id: 'session-ses_1' })
  })

  test('the agent\'s reply is its text items only, not reasoning or tool calls', () => {
    const ev = parse([
      turn('a1', {
        content: [{ type: 'reasoning', text: 'hmm' }, { type: 'tool', name: 'read' }, { type: 'text', text: ' HERON ' }, { type: 'text', text: 'and more' }, { type: 'text', text: '   ' }],
        finish: 'stop',
      }),
    ])
    expect(ev.find((e) => e.kind === 'agent')).toEqual({ kind: 'agent', id: 'a1', at: 10, text: 'HERON\n\nand more' })
  })

  test('a reply with no text says nothing', () => {
    expect(brief(parse([turn('a2', { content: [{ type: 'tool', name: 'x' }], finish: 'tool-calls' })]))).toEqual([])
    expect(brief(parse([turn('a3', { finish: 'stop' })]))).toEqual(['turn-end:turn-a3'])
  })

  test('the model is providerID/id, as a runtime line and in the usage', () => {
    const ev = parse([turn('a4', { model: { id: 'z-ai/glm', providerID: 'nvidia', variant: 'high' }, content: [], finish: 'stop', cost: 0.25, tokens: { input: 5, output: 1 } })])
    expect(ev.find((e) => e.kind === 'runtime')).toEqual({ kind: 'runtime', file: FILE, id: 'runtime-model-a4', at: 10, runtime: { model: 'nvidia/z-ai/glm', source: 'session', at: 10 } })
    expect(ev.find((e) => e.kind === 'usage')).toMatchObject({ id: 'usage-a4', model: 'nvidia/z-ai/glm', cost: 0.25, tokens: 6 })
  })

  test('a reply without a model names none', () => {
    const ev = parse([turn('a5', { model: { id: 'only-id' }, content: [], finish: 'stop', tokens: { input: 1, output: 0 } })])
    expect(ev.some((e) => e.kind === 'runtime')).toBe(false)
    expect(ev.find((e) => e.kind === 'usage')).not.toHaveProperty('model')
  })

  test('usage is input, output, reasoning and both cache counts; a negative or missing cost is left out', () => {
    const ev = parse([
      turn('a6', { tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } }, cost: -1, finish: 'tool-calls' }),
      turn('a7', { tokens: { input: 1, output: 1, cache: { read: 0 } }, finish: 'stop' }),
      turn('a8', { tokens: { input: 0, output: 0, reasoning: 0 }, finish: 'stop', cost: 0 }),
    ])
    expect(ev.filter((e) => e.kind === 'usage')).toEqual([{ kind: 'usage', id: 'usage-a6', at: 10, tokens: 20 }, { kind: 'usage', id: 'usage-a7', at: 10, tokens: 2 }])
  })

  test('a free reply with cost 0 keeps its cost; a reply without tokens has no usage', () => {
    const ev = parse([turn('a9', { tokens: { input: 3 }, cost: 0, finish: 'stop' }), turn('b1', { finish: 'stop' })])
    expect(ev.find((e) => e.kind === 'usage')).toMatchObject({ id: 'usage-a9', cost: 0 })
    expect(ev.filter((e) => e.kind === 'usage')).toHaveLength(1)
  })

  test('turn-end comes with every reply that is not tool-calls, and not with a tool-calls reply', () => {
    expect(brief(parse([turn('t1', { finish: 'tool-calls', content: [{ type: 'text', text: 'ok' }] })]))).toEqual(['agent:ok'])
    expect(brief(parse([turn('t2', { finish: 'stop', content: [{ type: 'text', text: 'done' }] })]))).toEqual(['agent:done', 'turn-end:turn-t2'])
    expect(brief(parse([turn('t3', { finish: 'length', content: [] })]))).toEqual(['turn-end:turn-t3'])
    expect(brief(parse([turn('t4', { finish: 'aborted', content: [] })]))).toEqual(['turn-end:turn-t4'])
  })

  test('an error reply is an error with its message, then the turn ends', () => {
    expect(brief(parse([turn('e1', { finish: 'error', error: { message: 'rate limited' }, content: [] })]))).toEqual(['error:error-e1', 'turn-end:turn-e1'])
    expect(parse([turn('e2', { finish: 'error', error: 'boom', content: [] })])).toContainEqual({ kind: 'error', id: 'error-e2', at: 10, text: 'boom' })
    expect(parse([turn('e3', { finish: 'content-filter', content: [] })])).toContainEqual({ kind: 'error', id: 'error-e3', at: 10, text: 'content-filter' })
  })

  test('an idle row that failed is an error; one that succeeded says nothing', () => {
    expect(parse([row('i1', 'idle', { time: { created: 5 }, outcome: 'failed', error: { message: 'no key' } })]).slice(1)).toEqual([
      { kind: 'error' as const, id: 'error-i1', at: 5, text: 'no key' },
    ])
    expect(parse([row('i2', 'idle', { outcome: 'failed' })])[1]).toEqual({ kind: 'error', id: 'error-i2', at: 1, text: 'the turn failed' })
    expect(parse([row('i3', 'idle', { time: { created: 5 }, outcome: 'succeeded' })])).toEqual([{ ...SESSION, at: 5 }])
  })

  test('a failed idle row ends a turn that is still open, after its error', () => {
    const ev = parse([
      row('u10', 'user', { text: 'do it' }),
      turn('a11', { finish: 'tool-calls', content: [{ type: 'tool', name: 'bash' }] }),
      row('i4', 'idle', { time: { created: 30 }, outcome: 'failed', error: 'the provider cut it' }),
    ])
    expect(ev.slice(-2)).toEqual([
      { kind: 'error', id: 'error-i4', at: 30, text: 'the provider cut it' },
      { kind: 'turn-end', id: 'turn-i4', at: 30 },
    ])
    expect(turns(ev)).toEqual(['turn-start:start-u10', 'turn-end:turn-i4'])
  })

  test('a failed idle row after a turn already ended adds only its error', () => {
    const ev = parse([turn('a12', { finish: 'stop', content: [{ type: 'text', text: 'ok' }] }), row('i5', 'idle', { outcome: 'failed' })])
    expect(turns(ev)).toEqual(['turn-end:turn-a12'])
    expect(ev.at(-1)).toMatchObject({ kind: 'error', id: 'error-i5' })
  })

  test('a reply after an ended turn starts a turn of its own; a tool-calls reply does not', () => {
    const ev = parse([
      row('u13', 'user', { text: 'first' }),
      turn('a13', { finish: 'tool-calls', content: [{ type: 'text', text: 'working' }] }),
      turn('a14', { finish: 'stop', content: [{ type: 'text', text: 'done' }] }),
      turn('a15', { finish: 'stop', content: [{ type: 'text', text: 'again' }] }),
    ])
    expect(turns(ev)).toEqual(['turn-start:start-u13', 'turn-end:turn-a14', 'turn-start:start-a15', 'turn-end:turn-a15'])
  })

  test('a reset file forgets its open and ended turns', () => {
    const reader = new OpencodeReader()
    parse([turn('a16', { finish: 'stop', content: [] })], reader)
    reader.reset(FILE)
    // no turn ended any more: a failed idle row has no open turn to end
    expect(turns(parse([row('i6', 'idle', { outcome: 'failed' })], reader))).toEqual([])
    expect(turns(parse([turn('a17', { finish: 'stop', content: [] })], reader))).toEqual(['turn-end:turn-a17'])
  })

  test('system rows and other types are left out', () => {
    expect(
      parse([
        row('s1', 'system', { metadata: { notice: 'instructions' }, text: '<context key="shepherdr">x</context>' }),
        row('m1', 'model-switched', { model: 'x' }),
        row('c1', 'compaction', {}),
      ]),
    ).toEqual([{ ...SESSION, at: 1 }])
  })

  test('lines that are not JSON, not rows, or have no data are skipped or read as empty', () => {
    const ev = new OpencodeReader().parse(
      [
        { text: 'not json', offset: 0 },
        { text: '[1,2]', offset: 10 },
        { text: JSON.stringify({ type: 'user', id: 7 }), offset: 20 },
        { text: JSON.stringify({ id: 'n1', type: 'user', seq: 1, time: 1 }), offset: 30 },
        // an assistant row with no data: no text, no tokens, no finish, so its turn ends (finish is not tool-calls)
        { text: JSON.stringify({ id: 'n2', type: 'assistant', seq: 2, time: 5 }), offset: 40 },
      ],
      FILE,
    )
    expect(ev).toEqual([
      SESSION,
      { kind: 'turn-start', id: 'start-n1', at: 1 },
      { kind: 'turn-end', id: 'turn-n2', at: 5 },
    ])
  })

  test('the time comes from the reply, else the row', () => {
    expect(parse([row('t5', 'user', { time: { created: 42 }, text: 'x' })])[1]).toMatchObject({ at: 42 })
    expect(parse([row('t6', 'user', { text: 'x' }, 77)])[1]).toMatchObject({ at: 77 })
  })

  test('the same lines read twice give the same ids', () => {
    const objs = [
      row('u9', 'user', { text: 'hi' }),
      turn('a10', { model: { id: 'm', providerID: 'p' }, tokens: { input: 1 }, content: [{ type: 'text', text: 'yo' }], finish: 'stop' }),
    ]
    const ids = (ev: LogEvent[]) => ev.map((e) => e.id)
    expect(ids(parse(objs))).toEqual(ids(parse(objs)))
    expect(ids(parse(objs))).toEqual(['session-ses_1', 'start-u9', 'u9', 'runtime-model-a10', 'a10', 'usage-a10', 'turn-a10'])
  })
})
