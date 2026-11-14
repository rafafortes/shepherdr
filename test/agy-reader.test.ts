// The agy log reader, on mirrored lines in the shape server/live/agy.ts writes ({idx, at, kind, ...}): the human's and the
// agent's text, the model and tokens of each response, turns, tool calls as steps (with their output read back from the
// line), errors, and what it leaves out.
import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { outputAt } from '../server/live/activity.ts'
import { AgyReader, agyStep } from '../server/live/readers/agy.ts'
import { headless } from '../server/live/readers/background.ts'
import { commandSay } from '../server/live/readers/steps.ts'
import type { LogEvent } from '../server/live/readers/types.ts'
import { tmp } from './tmp.ts'

const FILE = '/home/me/.shepherdr/agy/conv-1.jsonl'
const SESSION = { kind: 'session' as const, file: FILE, id: 'session-conv-1', at: 100, sessionId: 'conv-1' }

/** the mirrored lines as the reader gets them: each with its byte offset */
const parse = (objs: object[], reader = new AgyReader(), file = FILE): LogEvent[] =>
  reader.parse(
    objs.map((o, i) => ({ text: JSON.stringify(o), offset: i * 100 })),
    file,
  )

/** the events without the session line, as kind:id (or kind:text for words) */
const brief = (ev: LogEvent[]) => ev.filter((e) => e.kind !== 'session').map((e) => (e.kind === 'user' || e.kind === 'agent' ? `${e.kind}:${e.text}` : `${e.kind}:${e.id}`))

describe('agy reader: turns and words', () => {
  test('the session starts with the first line; a user line starts a turn and carries the human\'s words, trimmed', () => {
    const ev = parse([{ idx: 0, at: 100, kind: 'user', text: '  What is it?\n ' }])
    expect(ev).toEqual([
      { ...SESSION, at: 100 },
      { kind: 'turn-start', id: 'start-0', at: 100 },
      { kind: 'user', id: '0', at: 100, text: 'What is it?' },
    ])
  })

  test('a user line with no words starts the turn and says nothing; a line with no time is at 0', () => {
    const ev = parse([{ idx: 0, kind: 'user' }])
    expect(ev).toEqual([{ ...SESSION, at: 0 }, { kind: 'turn-start', id: 'start-0', at: 0 }])
  })

  test('a reply with words: its model, its usage, the words, and the end of the turn', () => {
    const ev = parse([{ idx: 1, at: 110, kind: 'agent', text: 'HERON', model: 'gemini-3.8-flash-low', tokensIn: 8, tokensOut: 4 }])
    expect(ev.slice(1)).toEqual([
      { kind: 'runtime', file: FILE, id: 'runtime-model-1', at: 110, runtime: { model: 'gemini-3.8-flash-low', source: 'session', at: 110 } },
      { kind: 'agent', id: '1', at: 110, text: 'HERON' },
      { kind: 'usage', id: 'usage-1', at: 110, tokens: 12, model: 'gemini-3.8-flash-low' },
      { kind: 'turn-end', id: 'turn-1', at: 110 },
    ])
  })

  test('a model response with no words asks for a tool: no end of turn; its usage with no model when it has none', () => {
    const ev = parse([{ idx: 2, at: 120, kind: 'agent', tokensIn: 5, tokensOut: 0 }, { idx: 3, at: 121, kind: 'agent' }])
    expect(ev.slice(1)).toEqual([{ kind: 'usage', id: 'usage-2', at: 120, tokens: 5 }])
  })

  test('a reply after the turn ended (the agent going on) starts a turn of its own', () => {
    const reader = new AgyReader()
    parse([{ idx: 1, at: 110, kind: 'agent', text: 'one' }], reader)
    const ev = parse([{ idx: 2, at: 111, kind: 'agent', text: 'two' }], reader)
    expect(brief(ev)).toEqual(['turn-start:start-2', 'agent:two', 'turn-end:turn-2'])
  })

  test('a tool call after an ended turn starts a turn of its own', () => {
    const reader = new AgyReader()
    parse([{ idx: 1, at: 110, kind: 'agent', text: 'done' }], reader)
    expect(brief(parse([{ idx: 5, at: 130, kind: 'tool', tool: 'run_command', args: '{"CommandLine":"ls"}', output: '' }], reader, FILE))).toEqual(['turn-start:start-5', 'step:tool-5'])
  })

  test('an error ends the turn with its words', () => {
    const ev = parse([{ idx: 7, at: 140, kind: 'error', text: 'quota | exceeded' }])
    expect(ev.slice(1)).toEqual([
      { kind: 'error', id: 'error-7', at: 140, text: 'quota | exceeded' },
      { kind: 'turn-end', id: 'turn-7', at: 140 },
    ])
    expect(parse([{ idx: 8, at: 141, kind: 'error' }]).find((e) => e.kind === 'error')).toMatchObject({ text: 'the step failed' })
  })

  test('an error with its provider\'s HTTP status keeps it, and still ends the turn', () => {
    const ev = parse([{ idx: 9, at: 150, kind: 'error', text: 'RESOURCE_EXHAUSTED (code 429)', status: 429 }])
    expect(ev.slice(1)).toEqual([
      { kind: 'error', id: 'error-9', at: 150, text: 'RESOURCE_EXHAUSTED (code 429)', status: 429 },
      { kind: 'turn-end', id: 'turn-9', at: 150 },
    ])
  })

  test('notices and steps of other kinds stay out; lines that are no mirrored step are skipped', () => {
    const ev = parse([{ idx: 3, at: 1, kind: 'notice', text: 'All stopped' }, { idx: 4, at: 2, kind: 'other' }, { at: 3, kind: 'user', text: 'no index' }])
    expect(brief(ev)).toEqual([])
    const reader = new AgyReader()
    expect(reader.parse([{ text: 'not json', offset: 0 }, { text: '[1]', offset: 10 }], FILE)).toEqual([])
  })

  test('reset: a file read again starts from its session line', () => {
    const reader = new AgyReader()
    parse([{ idx: 0, at: 1, kind: 'user', text: 'a' }], reader)
    reader.reset(FILE)
    expect(brief(parse([{ idx: 0, at: 1, kind: 'user', text: 'a' }], reader))).toEqual(['turn-start:start-0', 'user:a'])
    expect(parse([{ idx: 0, at: 1, kind: 'user', text: 'a' }], reader)[0].kind).toBe('turn-start')
  })
})

describe('agy reader: tool calls as steps', () => {
  const run = (o: object, offset = 0) => parse([{ idx: 2, at: 102, kind: 'tool', tool: 'run_command', args: '{"CommandLine":"ls -1 | wc -l","toolSummary":"Count directory entries"}', output: 'Command exited with code 0.\n\nCommand output: 6', ...o }]).find((e) => e.kind === 'step')

  test('a shell command is a step, over at once, with its own summary and its output kept in the line', () => {
    expect(run({})).toMatchObject({ kind: 'step', id: 'tool-2', at: 102, tool: 'run_command', end: 102, step: 'search', title: 'Counted directory entries', out: { file: FILE, offset: 0 } })
    expect(run({})?.failed).toBeUndefined()
    expect(run({})?.result).toBeUndefined()
  })

  test('a failed command: its exit code is not 0', () => {
    expect(run({ output: 'Command exited with code 2.' })).toMatchObject({ failed: true })
  })

  test('a shell command with no summary is worded from what it runs', () => {
    expect(run({ args: '{"CommandLine":"git status"}' })).toMatchObject({ step: 'run', title: 'Checked git status' })
    expect(run({ args: 'not json' })).toMatchObject({ step: 'run' })
  })

  test('a test run has its outcome read from its output', () => {
    expect(run({ args: '{"CommandLine":"bun test test/x.test.ts"}', output: 'Command exited with code 1.\n 2 fail\n 39 pass' })).toMatchObject({ test: true, result: '2 failed, 39 passed', failed: true })
    expect(run({ args: '{"CommandLine":"bun test"}', output: undefined })).toMatchObject({ test: true })
  })

  test('another tool is named in words: an unknown one is "Use …"', () => {
    expect(run({ tool: 'view_file', args: '{}', output: undefined })).toMatchObject({ step: 'other', title: 'Used view file', tool: 'view_file' })
    expect(agyStep('find_files', undefined)).toMatchObject({ step: 'other', title: 'Used find files' })
  })

  test('a tool call after the model’s words is a step of its turn; the output is read back from its line', () => {
    const reader = new AgyReader()
    const lines = [
      { idx: 1, at: 101, kind: 'agent', tokensIn: 3, tokensOut: 1 },
      { idx: 2, at: 102, kind: 'tool', tool: 'run_command', args: '{"CommandLine":"ls"}', output: 'Command exited with code 0.\n\nCommand output: a.txt' },
    ]
    const dir = tmp('agy-reader-out')
    const file = join(dir, 'conv-1.jsonl')
    const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    writeFileSync(file, body)
    const offset = Buffer.byteLength(JSON.stringify(lines[0]) + '\n')
    const ev = reader.parse(
      lines.map((l, i) => ({ text: JSON.stringify(l), offset: i === 0 ? 0 : offset })),
      file,
    )
    const step = ev.find((e) => e.kind === 'step')!
    expect(step.kind === 'step' && step.out).toEqual({ file, offset })
    expect(outputAt(step.kind === 'step' ? step.out! : { file, offset }, step.id)).toBe('Command exited with code 0.\n\nCommand output: a.txt')
  })

  test('outputAt: a line that is no tool call has no output of its own', () => {
    const dir = tmp('agy-reader-no-out')
    const file = join(dir, 'conv-1.jsonl')
    writeFileSync(file, JSON.stringify({ idx: 1, kind: 'agent', text: 'hi' }) + '\n')
    expect(outputAt({ file, offset: 0 }, 'tool-1')).toBeUndefined()
    writeFileSync(file, JSON.stringify({ idx: 1, kind: 'tool', tool: 'x' }) + '\n')
    expect(outputAt({ file, offset: 0 }, 'tool-1')).toBeUndefined()
  })
})

describe('agy reader: its CLI in the other readers and in headless runs', () => {
  test('a shell command that runs agy is a step asking another agent', () => {
    expect(commandSay('agy -p "review this"')).toMatchObject({ step: 'agent', title: 'Asked another agent' })
  })

  test('agy -p, --print and --prompt are headless one-shots; an interactive agy is not', () => {
    expect(headless(['agy', '-p', 'x'])).toBe(true)
    expect(headless(['/usr/bin/agy', '--print', 'x'])).toBe(true)
    expect(headless(['node', 'agy', '--prompt', 'x'])).toBe(true)
    expect(headless(['agy', '--conversation', 'abc'])).toBe(false)
  })
})
