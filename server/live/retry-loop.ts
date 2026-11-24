// biome-ignore-all lint/style/noNonNullAssertion: the index and regex captures were checked just above
// A provider can retry inside a CLI's turn: OpenCode 2 waits with a growing backoff ("Retrying in 836s · attempt 7 ·
// Rate limit exceeded"), Claude Code, pi and agy print their own waiting lines. The turn never ends, so no error
// reaches the log and retry.ts's cut-off policy (and the backup chain behind it) never starts. This reads the state
// while the turn runs: OpenCode's own status from its API where the version has one, else its session messages, else
// the line on the screen. It is a small pure reader; retry.ts decides what the state means and when it is a cut-off.
import { api } from './opencode.ts'
import type { LoopState } from './retry.ts'

/** a span the CLIs write in their waiting line, in the unit they write it in */
const span = (n: string, unit: string): number => {
  const value = Number(n)
  if (!Number.isFinite(value)) return NaN
  const ms = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000
  return Math.round(value * ms)
}

/** "Retrying in 836s · attempt 7 · Rate limit exceeded. Please try again later." (OpenCode), the same in Claude
 *  Code's dimmer "· retrying in 25s · attempt 2/5", agy's "Retrying in 12s (attempt 3/8)", and pi's "Retrying
 *  (2/5) in 30s...". The reason is the rest of that one line, never the next status line. */
const IN = /\bretry(?:ing)?\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s|m|h)\b([^\n]*)/i
const PARENS = /\bretrying\s*\(\s*(\d+)\s*\/\s*\d+\s*\)\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s|m|h)\b/i
const NO_WAIT = /\bretrying[….]*(?:\s|\u00b7|-)*attempt\s+(\d+)(?:\s*\/\s*\d+)?/i
const ATTEMPT = /\battempt\s+(\d+)(?:\s*\/\s*\d+)?\s*(?:[\u00b7|:\u2013\u2014-]\s*([^\n]*))?/i
/** a waiting line with no reason of its own (Claude Code and pi) still says the CLI is retrying */
const BARE = /\bretrying\s*…|\bretrying\s*\.\.\.|\bretrying\s*$/i

/**
 * The retry line a CLI's screen shows now, read from the end (the newest line wins). Nothing when the screen says no
 * retry, so a loop that recovered is seen as over. The message is the provider's own words where the CLI prints them:
 * retry.ts classifies them the same way it classifies a cut at the end of a turn.
 */
export function screenRetry(text: string, now = Date.now()): LoopState | undefined {
  const lines = text.replace(/\r/g, '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    const paren = PARENS.exec(line)
    if (paren) {
      const wait = span(paren[2]!, paren[3]!)
      return { attempt: Number(paren[1]), message: '', ...(Number.isFinite(wait) ? { next: now + wait } : {}), source: 'screen' }
    }
    const inLine = IN.exec(line)
    if (inLine) {
      const wait = span(inLine[1]!, inLine[2]!)
      const attempt = ATTEMPT.exec(inLine[3] ?? '')
      const reason = (attempt?.[2] ?? inLine[3] ?? '').replace(/^[\s\u00b7|:\u2013\u2014-]+/, '').trim()
      return {
        attempt: attempt ? Number(attempt[1]) : 1,
        message: reason,
        ...(Number.isFinite(wait) ? { next: now + wait } : {}),
        source: 'screen',
      }
    }
    const bare = NO_WAIT.exec(line)
    if (bare) return { attempt: Number(bare[1]), message: '', source: 'screen' }
    if (BARE.test(line)) return { attempt: 1, message: '', source: 'screen' }
  }
  return undefined
}

/** OpenCode's session status: `{type:'retry', attempt, message, next}` (next is an absolute ms timestamp). Newer
 *  versions return one state per session, older ones the single state; both are read. */
export function statusRetry(data: unknown): LoopState | undefined {
  const own = (data as { type?: string })?.type === 'retry' ? data : undefined
  const found = own ?? Object.values((data ?? {}) as Record<string, unknown>).find((x) => (x as { type?: string })?.type === 'retry')
  const state = found as { attempt?: unknown; message?: unknown; next?: unknown } | undefined
  if (!state || typeof state.attempt !== 'number' || !state.message) return undefined
  const next = typeof state.next === 'number' ? state.next : undefined
  return { attempt: state.attempt, message: String(state.message), ...(next ? { next } : {}), source: 'api' }
}

/** a RetryPart kept in a session's messages: newer OpenCodes store the attempt and the provider's error with it */
export function messagesRetry(data: unknown): LoopState | undefined {
  const rows = Array.isArray(data) ? data : []
  for (const row of rows.slice().reverse()) {
    const parts = [...((row as { parts?: unknown[] })?.parts ?? []), ...((row as { content?: unknown[] })?.content ?? [])]
    for (const part of parts.reverse()) {
      const p = part as { type?: string; attempt?: number; error?: { message?: string }; message?: string }
      if (p?.type !== 'retry' || typeof p.attempt !== 'number') continue
      const message = p.error?.message ?? p.message ?? ''
      return { attempt: p.attempt, message: String(message), source: 'messages' }
    }
  }
  return undefined
}

/** an API call OpenCode does not have in this version: no point asking again until it is upgraded */
const unavailable = new Set<string>()
/** "no retry" answers are held briefly: a polling pass must not spawn a CLI for every agent every few seconds */
const quiet = new Map<string, { until: number; state?: LoopState }>()

/** how long a "no retry" answer (or a state) is trusted, per session */
export const QUIET_FOR = 30_000

/** reset the cache between tests and when the OpenCode binary changes (a test points it at a fake) */
export function forgetOpencodeRetry(sessionId?: string) {
  if (sessionId) {
    quiet.delete(sessionId)
    return
  }
  quiet.clear()
  unavailable.clear()
}

/**
 * Ask OpenCode's own API for a session's retry state: its status operation first, then a RetryPart in its messages.
 * `call` is behind the same signature as opencode.ts's api so a test can answer without starting a CLI. A version that
 * has neither operation falls to the screen reader, silently and without asking twice.
 */
export async function opencodeRetry(
  sessionId: string,
  cwd: string,
  call: (args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<unknown> = api,
  now = Date.now(),
): Promise<LoopState | undefined> {
  const held = quiet.get(sessionId)
  if (held && held.until > now) return held.state
  const status = unavailable.has('status')
    ? undefined
    : statusRetry(
        await call(['session.status'], { cwd, timeoutMs: 10_000 }).catch((e: Error) => {
          if (/Operation not found|404/.test(e.message)) unavailable.add('status')
          return undefined
        }),
      )
  if (status) {
    quiet.set(sessionId, { until: now + 10_000, state: status })
    return status
  }
  const messages = unavailable.has('messages')
    ? undefined
    : messagesRetry(
        await call(['session.message.list', '--param', `sessionID=${sessionId}`, '--param', 'limit=10', '--param', 'order=desc'], {
          cwd,
          timeoutMs: 10_000,
        }).catch((e: Error) => {
          if (/Operation not found|404/.test(e.message)) unavailable.add('messages')
          return undefined
        }),
      )
  const state = messages ?? status
  quiet.set(sessionId, { until: now + QUIET_FOR, state })
  return state
}
