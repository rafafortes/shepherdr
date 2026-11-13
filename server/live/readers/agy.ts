// The Antigravity CLI (agy) log reader, on the mirrored lines of server/live/agy.ts: one JSON line per final step of its
// conversation, {idx, at, kind, text?, tool?, args?, output?, model?, tokensIn?, tokensOut?}. The chat reads the human's
// and the agent's text, the model and the tokens of each model response, its shell commands and other tool calls (each
// one a step, over once it is logged), and the errors. The CLI's own notices and the steps of unknown kinds stay out.
import { basename } from 'node:path'
import { testResult, words } from '../../../shared/activity.ts'
import { runStep, type Said } from './steps.ts'
import type { LogEvent, Reader } from './types.ts'

type Json = any

const parseLine = (text: string): Json => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** the exit code a shell command's output reports ("Command exited with code 1."), or undefined when it reports none */
const exitCode = (output: string | undefined): number | undefined => {
  const m = /Command exited with code (-?\d+)/.exec(output ?? '')
  return m ? Number(m[1]) : undefined
}

/** a tool call of the agent as a step: a shell command (its own summary where it gave one), else its name in words */
export function agyStep(tool: string, args: string | undefined): Said {
  const a: Json = parseLine(args ?? '') ?? {}
  if (tool === 'run_command') return runStep(a.CommandLine, a.toolSummary)
  return { step: 'other', ...words(`Use ${tool.replace(/_/g, ' ')}`) }
}

export class AgyReader implements Reader {
  cli = 'agy'
  /** files whose session start was emitted already */
  private sessions = new Set<string>()
  /** files whose last turn ended: a step that comes next (the agent going on after its words) starts a turn of its own */
  private ended = new Set<string>()

  reset(file: string) {
    this.sessions.delete(file)
    this.ended.delete(file)
  }

  parse(lines: { text: string; offset: number }[], file: string): LogEvent[] {
    const out: LogEvent[] = []
    for (const { text, offset } of lines) {
      const l = parseLine(text)
      if (!l || typeof l !== 'object' || typeof l.idx !== 'number') continue
      const at = Number(l.at) || 0
      this.session(out, file, at)
      this.line(out, file, l, offset, at)
    }
    return out
  }

  /** one session per file: the mirror of a conversation is named after its id */
  private session(out: LogEvent[], file: string, at: number) {
    if (this.sessions.has(file)) return
    this.sessions.add(file)
    const sessionId = basename(file, '.jsonl')
    out.push({ kind: 'session', file, id: `session-${sessionId}`, at, sessionId })
  }

  private start(out: LogEvent[], file: string, id: string, at: number) {
    this.ended.delete(file)
    out.push({ kind: 'turn-start', id: `start-${id}`, at })
  }

  private end(out: LogEvent[], file: string, id: string, at: number) {
    this.ended.add(file)
    out.push({ kind: 'turn-end', id: `turn-${id}`, at })
  }

  /** one mirrored line by its kind */
  private line(out: LogEvent[], file: string, l: Json, offset: number, at: number) {
    const id = String(l.idx)
    switch (l.kind) {
      case 'user':
        return this.user(out, file, id, at, l.text)
      case 'agent':
        return this.agent(out, file, l, id, at)
      case 'tool':
        return this.tool(out, file, l, id, offset, at)
      case 'error':
        return this.error(out, file, id, at, l.text)
    }
  }

  private user(out: LogEvent[], file: string, id: string, at: number, text: unknown) {
    this.start(out, file, id, at)
    const body = typeof text === 'string' ? text.trim() : ''
    if (body) out.push({ kind: 'user', id, at, text: body })
  }

  /** a model response: its words (a reply that ends the turn; a step with none only asks for a tool), its model and tokens */
  private agent(out: LogEvent[], file: string, l: Json, id: string, at: number) {
    if (this.ended.has(file)) this.start(out, file, id, at)
    if (l.model) out.push({ kind: 'runtime', file, id: `runtime-model-${id}`, at, runtime: { model: l.model, source: 'session', at } })
    const body = typeof l.text === 'string' ? l.text.trim() : ''
    if (body) out.push({ kind: 'agent', id, at, text: body })
    const tokens = (l.tokensIn ?? 0) + (l.tokensOut ?? 0)
    if (tokens > 0) out.push({ kind: 'usage', id: `usage-${id}`, at, tokens, ...(l.model ? { model: l.model } : {}) })
    if (body) this.end(out, file, id, at)
  }

  /** a tool call that is over: one step, its output kept in the log (read from this line when the human opens it) */
  private tool(out: LogEvent[], file: string, l: Json, id: string, offset: number, at: number) {
    if (this.ended.has(file)) this.start(out, file, id, at)
    const tool = String(l.tool ?? '')
    const said = agyStep(tool, l.args)
    const code = exitCode(l.output)
    out.push({
      kind: 'step',
      id: `tool-${id}`,
      at,
      tool,
      end: at,
      failed: code ? true : undefined,
      result: said.test && l.output ? testResult(l.output) : undefined,
      out: { file, offset },
      ...said,
    })
  }

  /** the model's provider cut the reply off: the error, and the turn ends with it */
  private error(out: LogEvent[], file: string, id: string, at: number, text: unknown) {
    out.push({ kind: 'error', id: `error-${id}`, at, text: String(text ?? 'the step failed') })
    this.end(out, file, id, at)
  }
}
