// OpenCode's mirrored log (server/live/opencode.ts mirrorSession): one JSONL line per final row of its session,
// {id, type, seq, time, data}. The chat reads the user's and the agent's text, the model, the tokens and cost of each
// reply, where a session and a turn start and end, and the errors; system rows (Shepherdr's own instructions) stay out.
// An error is OpenCode's own `{type, message, status}` (provider.quota, provider.auth, provider.rate-limit…): its type and
// status go with the message, so retry.ts reads them as it reads Claude Code's and Codex's codes.
import { basename } from 'node:path'
import type { LogEvent, Reader } from './types.ts'

type Json = any

/** OpenCode's error of a row, as the error event keeps it: its words, its type as the code, its HTTP status; nothing for a
 *  user's abort (Esc in its TUI, "Step interrupted"), which is not a provider's cut-off */
export function errorOf(error: Json, fallback: string): { text: string; code?: string; status?: number } | undefined {
  if (error?.type === 'aborted') return undefined
  const code = typeof error?.type === 'string' ? error.type : undefined
  const status = typeof error?.status === 'number' ? error.status : undefined
  return { text: String(error?.message ?? error ?? fallback), ...(code ? { code } : {}), ...(status !== undefined ? { status } : {}) }
}

const parseLine = (text: string): Json => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export class OpencodeReader implements Reader {
  cli = 'opencode'
  /** files whose session start was emitted already */
  private sessions = new Set<string>()
  /** files with a turn under way: started, not ended */
  private open = new Set<string>()
  /** files whose last turn ended: a reply that comes next (OpenCode retrying an error) starts a turn of its own */
  private ended = new Set<string>()
  /** files whose last reply failed: OpenCode then writes the same failure again as an idle row, which is not a second error */
  private failed = new Set<string>()

  reset(file: string) {
    this.sessions.delete(file)
    this.open.delete(file)
    this.ended.delete(file)
    this.failed.delete(file)
  }

  private start(out: LogEvent[], file: string, id: string, at: number) {
    this.ended.delete(file)
    this.failed.delete(file)
    this.open.add(file)
    out.push({ kind: 'turn-start', id: `start-${id}`, at })
  }

  private end(out: LogEvent[], file: string, id: string, at: number) {
    this.open.delete(file)
    this.ended.add(file)
    out.push({ kind: 'turn-end', id: `turn-${id}`, at })
  }

  parse(lines: { text: string; offset: number }[], file: string): LogEvent[] {
    const out: LogEvent[] = []
    for (const { text } of lines) {
      const l = parseLine(text)
      if (!l || typeof l !== 'object' || typeof l.id !== 'string') continue
      const d = l.data ?? {}
      const at = Number(d.time?.created ?? l.time) || 0
      const id = l.id

      // one session per file: OpenCode names each session's file after its id
      if (!this.sessions.has(file)) {
        this.sessions.add(file)
        const sessionId = basename(file, '.jsonl')
        out.push({ kind: 'session', file, id: `session-${sessionId}`, at, sessionId })
      }

      if (l.type === 'user') {
        this.start(out, file, id, at)
        const words = typeof d.text === 'string' ? d.text.trim() : ''
        if (words) out.push({ kind: 'user', id, at, text: words })
      } else if (l.type === 'assistant') {
        if (this.ended.has(file)) this.start(out, file, id, at)
        const model = typeof d.model?.providerID === 'string' && typeof d.model?.id === 'string' ? `${d.model.providerID}/${d.model.id}` : undefined
        if (model) out.push({ kind: 'runtime', file, id: `runtime-model-${id}`, at, runtime: { model, source: 'session', at } })
        const words = (Array.isArray(d.content) ? d.content : [])
          .filter((b: Json) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: { text: string }) => b.text.trim())
          .filter(Boolean)
          .join('\n\n')
        if (words) out.push({ kind: 'agent', id, at, text: words })
        const t = d.tokens
        const tokens = (t?.input ?? 0) + (t?.output ?? 0) + (t?.reasoning ?? 0) + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0)
        const cost = typeof d.cost === 'number' && d.cost >= 0 ? d.cost : undefined
        if (tokens > 0) out.push({ kind: 'usage', id: `usage-${id}`, at, tokens, ...(model ? { model } : {}), ...(cost !== undefined ? { cost } : {}) })
        if (d.finish === 'error' || d.finish === 'content-filter') {
          const e = errorOf(d.error, d.finish)
          if (e) out.push({ kind: 'error', id: `error-${id}`, at, ...e })
          this.failed.add(file)
        }
        // tool-calls means the agent goes on; stop, length, aborted, error and content-filter all end the turn
        if (d.finish !== 'tool-calls') this.end(out, file, id, at)
      } else if (l.type === 'idle' && d.outcome === 'failed') {
        // the failure of the reply before it, written again: its error is out already
        const e = this.failed.has(file) ? undefined : errorOf(d.error, 'the turn failed')
        if (e) out.push({ kind: 'error', id: `error-${id}`, at, ...e })
        this.failed.delete(file)
        // a turn still under way ends with the failure
        if (this.open.has(file)) this.end(out, file, id, at)
      }
    }
    return out
  }
}
