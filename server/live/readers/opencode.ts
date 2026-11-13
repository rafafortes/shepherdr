// OpenCode's mirrored log (server/live/opencode.ts mirrorSession): one JSONL line per final row of its session,
// {id, type, seq, time, data}. The chat reads the user's and the agent's text, the model, the tokens and cost of each
// reply, where a turn starts and ends, and the errors; system rows (Shepherdr's own instructions) stay out.
import type { LogEvent, Reader } from './types.ts'

type Json = any

const parseLine = (text: string): Json => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export class OpencodeReader implements Reader {
  cli = 'opencode'

  parse(lines: { text: string; offset: number }[], file: string): LogEvent[] {
    const out: LogEvent[] = []
    for (const { text } of lines) {
      const l = parseLine(text)
      if (!l || typeof l !== 'object' || typeof l.id !== 'string') continue
      const d = l.data ?? {}
      const at = Number(d.time?.created ?? l.time) || 0
      const id = l.id

      if (l.type === 'user') {
        out.push({ kind: 'turn-start', id: `start-${id}`, at })
        const words = typeof d.text === 'string' ? d.text.trim() : ''
        if (words) out.push({ kind: 'user', id, at, text: words })
      } else if (l.type === 'assistant') {
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
        // tool-calls means the agent goes on; stop, length, aborted, error and content-filter all end the turn
        if (d.finish === 'error' || d.finish === 'content-filter') {
          out.push({ kind: 'error', id: `error-${id}`, at, text: String(d.error?.message ?? d.error ?? d.finish) })
        }
        if (d.finish !== 'tool-calls') out.push({ kind: 'turn-end', id: `turn-${id}`, at })
      } else if (l.type === 'idle' && d.outcome === 'failed') {
        out.push({ kind: 'error', id: `error-${id}`, at, text: String(d.error?.message ?? d.error ?? 'the turn failed') })
      }
    }
    return out
  }
}
