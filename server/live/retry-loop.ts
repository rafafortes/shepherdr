// biome-ignore-all lint/style/noNonNullAssertion: the index and regex captures were checked just above
// A provider can retry inside a CLI's turn: OpenCode 2 waits with a growing backoff ("Retrying in 836s · attempt 7 ·
// Rate limit exceeded"), Claude Code, pi and agy print their own waiting lines. The turn never ends, so no error
// reaches the log and retry.ts's cut-off policy (and the backup chain behind it) never starts. This reads the state
// while the turn runs: OpenCode's own status from its API where the version has one, else its session messages, else
// the line on the screen. It is a small pure reader; retry.ts decides what the state means and when it is a cut-off.
//
// What was checked for each CLI, on this host in Nov 2026 (its own binary, log or screen):
//   opencode 2.3.2: `opencode api --standalone session.status` answers "Operation not found";
//     `session.message.list` answers with user/assistant/idle rows; the TUI shows "⚠ Retrying in Ns · attempt N ·
//     <reason>" and "⚠ Retry due · attempt N · <reason>". A host-local plugin (opencode-retry-cap) now caps a long
//     loop by ending the turn, but Shepherdr still has to catch sessions started before it and other machines.
//   claude 2.1.331: its bundle has "retrying in ${n}s" and "attempt ${n}/${max}" (a dim status line), so the
//     anchored "· retrying in Ns · attempt N/M" is read; no API status is used.
//   pi 1.5.2: dist/modes/interactive/components/status-indicator.js prints "Retrying (n/m) in Ns..."; pi's log
//     reader already ends its own retry turn, so this is a screen-only fallback.
//   agy: its bundle has "Retrying in %v... (attempt %d/%d)"; screen-only, it has no quiet session API here.
//   codex: not installed on this host (removed 2026-10-15); its reconnect is a transport retry of the CLI, not a
//     provider backoff that keeps a turn open with an attempt count — no reader, and a test says so.
import { api } from './opencode.ts'
import type { LoopState } from './retry.ts'

/** a span the CLIs write in their waiting line, in the unit they write it in */
const span = (n: string, unit: string): number => {
  const value = Number(n)
  if (!Number.isFinite(value)) return NaN
  const ms = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000
  return Math.round(value * ms)
}

/** Each CLI's own status line, with its own marker so prose in a diff or chat is never mistaken for a retry.
 *  Only the last few lines of the pane are read: above them is the agent's chat and tool output. */
const FORMATS: Record<string, RegExp[]> = {
  // OpenCode prints an amber ⚠ before "Retrying in Ns · attempt N · reason"; at zero it says "Retry due".
  opencode: [
    /retry(?:ing)? in (?<amount>\d+(?:\.\d+)?)(?<unit>ms|s|m|h)\b\s*·\s*attempt (?<attempt>\d+)\s*·\s*(?<reason>[^\n]*)/i,
    /retry due\s*·\s*attempt (?<attempt>\d+)(?:\s*·\s*(?<reason>[^\n]*))?/i,
  ],
  // Claude Code's dim line is "· retrying in Ns · attempt N/M"; its countdown may say "seconds" (handled by span).
  claude: [/·\s*retrying in (?<amount>\d+(?:\.\d+)?)(?<unit>ms|s|m|h)\b\s*·\s*attempt (?<attempt>\d+)(?:\/\d+)?\s*·?\s*(?<reason>[^\n]*)/i, /·\s*retrying…\s*·\s*attempt (?<attempt>\d+)(?:\/\d+)?/i],
  pi: [/retrying \((?<attempt>\d+)\/\d+\) in (?<amount>\d+(?:\.\d+)?)(?<unit>ms|s|m|h)\b/i],
  agy: [/retrying in (?<amount>\d+(?:\.\d+)?)(?<unit>ms|s|m|h)\b\s*\(attempt (?<attempt>\d+)\/\d+\)/i],
  // Codex is not installed here and has no in-turn provider retry line with an attempt count: no pattern, by design.
  codex: [],
}
const SCREEN_LINES = 14

/**
 * The retry line a CLI's screen shows now, read from the foot upwards (newest line wins). Nothing when the screen says
 * no retry, so one that recovered is seen as over. A line that only mentions a retry further up (in chat, a diff or
 * tool output) is not the CLI's own status. The reason is the provider's words where the CLI prints them: retry.ts
 * classifies them as it does a cut at the end of a turn.
 */
export function screenRetry(text: string, now = Date.now(), kind = 'opencode'): LoopState | undefined {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim())
    .slice(-SCREEN_LINES)
  for (const line of lines.reverse()) {
    for (const re of FORMATS[kind] ?? []) {
      const g = re.exec(line.trim())?.groups
      if (!g) continue
      const wait = g.amount && g.unit ? span(g.amount, g.unit) : NaN
      return {
        attempt: Number(g.attempt) || 1,
        message: (g.reason ?? '').trim(),
        ...(Number.isFinite(wait) ? { next: now + wait } : {}),
        source: 'screen',
      }
    }
  }
  return undefined
}

/** OpenCode's session status: `{type:'retry', attempt, message, next}` or a map keyed by sessionID (`next`/`retry.at`
 *  is an absolute ms timestamp). A sibling session's retry is never attributed to this one. */
export function statusRetry(data: unknown, sessionId?: string): LoopState | undefined {
  const own = (data as { type?: string })?.type === 'retry' ? data : undefined
  const found = own ?? (sessionId ? (data as Record<string, unknown>)?.[sessionId] : undefined)
  const state = found as { attempt?: unknown; message?: unknown; next?: unknown; error?: { message?: unknown } } | undefined
  if (!state || typeof state.attempt !== 'number') return undefined
  const message = state.message ?? state.error?.message
  if (!message) return undefined
  const next = typeof state.next === 'number' ? state.next : undefined
  return { attempt: state.attempt, message: String(message), ...(next ? { next } : {}), source: 'api' }
}

/** a RetryPart kept in a session's messages: only the newest part of the newest message is current. An old retry
 *  followed by text, a tool or an idle row is a turn that went on: it must never read as a retry now. */
export function messagesRetry(data: unknown): LoopState | undefined {
  const rows = Array.isArray(data) ? data : []
  // `order=desc` from the API returns newest first; with `order=asc` the last row is newest
  const row = (rows.at(-1)?.type === 'idle' ? rows.at(-1) : rows[0]) as { type?: string; parts?: unknown[]; content?: unknown[] } | undefined
  if (!row || row.type === 'idle' || row.type === 'user') return undefined
  const parts = [...(row.parts ?? []), ...(row.content ?? [])]
  const part = parts.at(-1) as { type?: string; attempt?: number; error?: { message?: string }; message?: string } | undefined
  if (part?.type !== 'retry' || typeof part.attempt !== 'number') return undefined
  const message = part.error?.message ?? part.message ?? ''
  return { attempt: part.attempt, message: String(message), source: 'messages' }
}

/** an API call OpenCode does not have in this version: no point asking again until it is upgraded */
const unavailable = new Set<string>()
/** "no retry" answers are held briefly, so a polling pass must not spawn a CLI for every agent every few seconds */
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
          if (/Operation not found/.test(e.message)) unavailable.add('status')
          return undefined
        }),
        sessionId,
      )
  if (status) {
    quiet.set(sessionId, { until: now + 10_000, state: status })
    return status
  }
  const messages =
    unavailable.has('messages') || unavailable.has('status')
      ? undefined
      : messagesRetry(
          await call(['session.message.list', '--param', `sessionID=${sessionId}`, '--param', 'limit=10', '--param', 'order=desc'], {
            cwd,
            timeoutMs: 10_000,
          }).catch((e: Error) => {
            if (/Operation not found/.test(e.message)) unavailable.add('messages')
            return undefined
          }),
        )
  const state = messages ?? status
  quiet.set(sessionId, { until: now + QUIET_FOR, state })
  return state
}
