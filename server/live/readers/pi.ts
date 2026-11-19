// pi's log: ~/.pi/agent/sessions/--<cwd>--/<time>_<id>.jsonl. The first line is {type: 'session', id, cwd}; then
// entries with their own id: message {message: {role, content}}, model_change, custom, ... The chat reads the user's
// and the assistant's text, and their tool calls and results as steps; system prompts and thinking stay out.
import { testResult, words } from '../../../shared/activity.ts'
import { runStep, type Said } from './steps.ts'
import type { LogEvent, Reader } from './types.ts'

type Json = any

/** a pi tool call as a step: a shell command in words, else the tool's name */
export function piStep(name: string, args: Json): Said {
  if (name === 'bash') return runStep(args && typeof args === 'object' ? args.command : undefined)
  return { step: 'other', ...words(`Use ${name.replace(/_/g, ' ')}`) }
}

const parseLine = (text: string): Json => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** pi expands "/skill:name args" into the skill's body in tags, then the args: show it as typed */
function cleanUser(t: string): string {
  const m = /^\s*<skill name="([^"]*)"[^>]*>[\s\S]*?<\/skill>\s*/.exec(t)
  if (m) return `/skill:${m[1]} ${t.slice(m[0].length)}`.trim()
  return t.trim()
}

function texts(c: Json): string[] {
  if (typeof c === 'string') return [c]
  if (!Array.isArray(c)) return []
  return c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text)
}

/** The HTTP status pi's error message names at its start, where it names one: "exe-dev-openai API error (502): …"
 *  or "429 usage limit reached …". Both forms are anchored, and a bare leading number must be a 4xx or 5xx: a count
 *  ("700 tokens requested", "max_tokens must be at most 500") is not a status. pi keeps no structured status of its
 *  own, so recover the one in the provider's words and let retry.ts read it as every other CLI's status; the words
 *  stay in the event unchanged. */
const statusOf = (text: string): number | undefined => {
  const m = /^(?:\w[\w-]* )?API error \((\d{3})\)|^([45]\d\d)\b/.exec(text)
  return m ? Number(m[1] ?? m[2]) : undefined
}

export class PiReader implements Reader {
  cli = 'pi'
  private sessions = new Set<string>()
  /** files whose last turn ended: a reply that comes next (pi retrying an error) starts a turn of its own */
  private ended = new Set<string>()
  /** tool calls shown as steps and not over yet, by file and id: whether it was a test run */
  private steps = new Map<string, boolean>()
  /** a call id repeats across sessions, so it names a step only together with its file */
  private stepKey = (file: string, id: string) => `${file}\0${id}`

  reset(file: string) {
    this.sessions.delete(file)
    this.ended.delete(file)
    for (const key of this.steps.keys()) if (key.startsWith(`${file}\0`)) this.steps.delete(key)
  }

  parse(lines: { text: string; offset: number }[], file: string): LogEvent[] {
    const out: LogEvent[] = []
    for (const { text, offset } of lines) {
      const l = parseLine(text)
      if (!l || typeof l !== 'object') continue
      const t = Date.parse(l.timestamp ?? '') || (typeof l.message?.timestamp === 'number' ? l.message.timestamp : 0)

      if (l.type === 'session') {
        if (this.sessions.has(file) || typeof l.id !== 'string') continue
        this.sessions.add(file)
        out.push({ kind: 'session', file, id: `session-${l.id}`, at: t, sessionId: l.id })
      } else if (l.type === 'model_change' || l.type === 'thinking_level_change') {
        const runtime = { source: 'session' as const, at: t,
          ...(l.type === 'model_change' && typeof l.modelId === 'string' ? { model: l.modelId } : {}),
          ...(l.type === 'thinking_level_change' && typeof l.thinkingLevel === 'string' ? { effort: l.thinkingLevel } : {}),
        }
        out.push({ kind: 'runtime', file, id: `runtime-${offset}`, at: t, runtime })
      } else if (l.type === 'message') {
        const m = l.message ?? {}
        const id = String(l.id ?? `m${offset}`)
        if (m.role === 'user' || (m.role === 'assistant' && this.ended.has(file))) {
          this.ended.delete(file)
          out.push({ kind: 'turn-start', id: `start-${id}`, at: t })
        }
        if (m.role === 'user') {
          const words = texts(m.content).map(cleanUser).filter(Boolean).join('\n\n')
          if (words) out.push({ kind: 'user', id, at: t, text: words })
        } else if (m.role === 'assistant') {
          if (typeof m.model === 'string') out.push({ kind: 'runtime', file, id: `runtime-model-${offset}`, at: t, runtime: { model: m.model, source: 'session', at: t } })
          const words = texts(m.content)
            .map((s) => s.trim())
            .filter(Boolean)
            .join('\n\n')
          if (words) out.push({ kind: 'agent', id, at: t, text: words })
          // a tool call starts a step now; its result line ends it and holds the raw output
          const content = Array.isArray(m.content) ? m.content : []
          content.forEach((b: Json, index: number) => {
            if (b?.type !== 'toolCall') return
            const call = typeof b.id === 'string' ? b.id : `t${offset}-${index}`
            const key = this.stepKey(file, call)
            if (this.steps.has(key)) return
            const name = String(b.name ?? '')
            const said = piStep(name, b.arguments)
            this.steps.set(key, !!said.test)
            out.push({ kind: 'step', id: call, at: t, tool: name, ...said })
          })
          const u = m.usage
          const tokens = typeof u?.totalTokens === 'number' ? u.totalTokens : (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0)
          // the model as pi names it, with its provider in front (spark/qwen3.8-…, commandcode/deepseek/…); pi's own cost
          // estimate for the call, when its line has one
          const provider = typeof m.provider === 'string' && m.provider ? m.provider : undefined
          const model = typeof m.model === 'string' && m.model ? (provider && !m.model.startsWith(`${provider}/`) ? `${provider}/${m.model}` : m.model) : undefined
          const cost = typeof u?.cost?.total === 'number' && u.cost.total >= 0 ? u.cost.total : undefined
          if (tokens > 0) out.push({ kind: 'usage', id: `usage-${id}`, at: t, tokens, ...(model ? { model } : {}), ...(cost !== undefined ? { cost } : {}) })
          // toolUse means the agent goes on; stop, aborted, error and length all end the turn. pi has no refusal code
          // of its own: a provider's content or safety filter arrives as an error with the provider's own words
          if (m.stopReason && m.stopReason !== 'toolUse') {
            if (m.stopReason === 'error') {
              const text = String(m.errorMessage ?? '')
              const status = statusOf(text)
              out.push({ kind: 'error', id: `error-${id}`, at: t, text, ...(status !== undefined ? { status } : {}) })
            }
            this.ended.add(file)
            out.push({ kind: 'turn-end', id: `turn-${id}`, at: t })
          }
        } else if (m.role === 'toolResult') {
          const call = String(m.toolCallId ?? '')
          const key = this.stepKey(file, call)
          const test = this.steps.get(key)
          if (test !== undefined) {
            this.steps.delete(key)
            const body = texts(m.content).join('\n')
            out.push({ kind: 'step-end', id: call, at: t, failed: m.isError === true || undefined, out: { file, offset }, ...(test && body ? { result: testResult(body) } : {}) })
          }
        }
      }
    }
    return out
  }
}
