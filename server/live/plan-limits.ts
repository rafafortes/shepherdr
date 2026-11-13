// Claude Code's plan limits, for Settings → Models → Quotas: what is left in its 5-hour session and its week, and when each
// refills. The read is Claude Code's own /usage, in one short `claude -p /usage` process, never a running agent's chat.
// The idea is upstream's (eliasstravik/shepherdr, helper/core-plan-limits.ts at 3a3ce931 and c0ee1971, read only), ported
// to this code: the process is sealed by bubblewrap (the whole root read-only, a throwaway /tmp), so nothing it does can
// write the human's settings or login; a login near its renewal is not read at all (a sealed run cannot save a renewed
// login, and a renewal that is not saved signs the CLI out). Without bubblewrap nothing is read: an unsealed read is
// refused, and the screen says so. Only the percentages and the reset times are kept, never the output or the login.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuotaFigure, QuotaWindow } from '../../shared/types.ts'

/** the CLI's own answer is read for at most this long; a run past it is killed */
export const RUN_LIMIT_MS = 60_000
/** a login that ends within this long is due: the next Claude Code run renews it (never read here) */
const SOON = 60 * 60_000

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Nov 6, 11:59am (UTC)" or "3pm (UTC)": the next such moment, since Claude Code leaves out what is obvious to a reader.
 *  The run is TZ=UTC, so the words are UTC, whatever zone the screen shows them in */
export function claudeReset(words: string, now: number): number | undefined {
  const m = words.match(/^(?:([A-Z][a-z]{2}) (\d{1,2})(?:, (\d{4}))?(?:,| at)? )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?: \(UTC\))?$/i)
  if (!m) return undefined
  const month = m[1] ? MONTHS.indexOf(m[1]) : -1
  if (m[1] && month < 0) return undefined
  const hour = (Number(m[4]) % (m[6] ? 12 : 24)) + (m[6]?.toLowerCase() === 'pm' ? 12 : 0)
  const minute = Number(m[5] ?? 0)
  const today = new Date(now)
  if (!m[1]) {
    const at = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hour, minute)
    // its words stop at the minute: this minute is still today
    return at + 60_000 <= now ? at + 86_400_000 : at
  }
  const at = (year: number) => Date.UTC(year, month, Number(m[2]), hour, minute)
  if (m[3]) return at(Number(m[3]))
  return at(today.getUTCFullYear()) < now - 86_400_000 ? at(today.getUTCFullYear() + 1) : at(today.getUTCFullYear())
}

/** a window's name as Claude Code words it, in the screen's words: "Current session" is the 5 h window, "Current week" the week */
const windowName = (raw: string) => raw.replace(/^Current session\b/, '5 h').replace(/^Current week\b/, 'Week').slice(0, 40)

export type Parsed = { state: 'ok'; windows: QuotaWindow[] } | { state: 'signed-out' } | { state: 'no-plan' } | { state: 'unknown'; why: string }

/** what /usage printed, as Claude Code 2.1 words it: `Current week (all models): 10% used · resets Nov 6, 11:59am (UTC)`.
 *  A line it leaves out (no week, say) is no window; the rest still count */
export function parseClaude(text: string, now: number): Parsed {
  const windows: QuotaWindow[] = []
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(.+?): (\d+(?:\.\d+)?)% used(?: · resets (.+))?$/)
    if (!m) continue
    const resetAt = m[3] ? claudeReset(m[3], now) : undefined
    windows.push({ name: windowName(m[1]!), usedPct: Number(m[2]), ...(resetAt !== undefined ? { resetAt } : {}) })
  }
  if (windows.length) return { state: 'ok', windows }
  if (/not logged in|\/login/i.test(text)) return { state: 'signed-out' }
  // with no subscription, signed out or on an API key, /usage is only the session's cost
  if (/^Total cost:/m.test(text)) return { state: 'no-plan' }
  return { state: 'unknown', why: "Claude Code's answer had no limits in it" }
}

/** the command under bubblewrap: the whole root read-only, a throwaway /tmp, the network the CLI's own answer needs. Undefined
 *  without bubblewrap: the read is then refused, never run unsealed */
export function sealed(command: string[], bwrap: string | null): string[] | undefined {
  if (!bwrap) return undefined
  return [bwrap, '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--share-net', '--die-with-parent', '--chdir', '/tmp', '--', ...command]
}

/** whether the login is due for renewal: it ends within an hour (or has ended). The login's text is only read for its end
 *  time here, and it is never kept. Unreadable counts as due; a login with no end time is not */
export function claudeLoginDue(text: string, now: number): boolean {
  try {
    const end = JSON.parse(text)?.claudeAiOauth?.expiresAt
    return end !== undefined && !(end - SOON > now)
  } catch {
    return true
  }
}

/** what a read gives: a figure, a reason it failed (the last good figure stays), or a hint why nothing is read (no failure) */
export type Reading = { figure: QuotaFigure } | { reason: string } | { hint: string }

/** what a read needs from its machine, so a test gives it a fake one */
export interface Host {
  home: string
  env: Record<string, string | undefined>
  which(name: string): string | null
  exists(path: string): boolean
  /** a file's text, or null when there is none (read only for a login's end time) */
  read(path: string): string | null
  run(argv: string[], options: { env: Record<string, string | undefined>; timeoutMs: number }): Promise<{ stdout: string; timedOut: boolean }>
}

/** the real machine: a process is killed at its time limit, a file is read as text */
export const HOST: Host = {
  home: process.env.HOME ?? '',
  env: process.env,
  which: (name) => Bun.which(name),
  exists: (path) => existsSync(path),
  read: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
  async run(argv, options) {
    const env = Object.fromEntries(Object.entries(options.env).filter((e): e is [string, string] => e[1] !== undefined))
    const proc = Bun.spawn(argv, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
    let timedOut = false
    const limit = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, options.timeoutMs)
    try {
      const stdout = await new Response(proc.stdout).text()
      await proc.exited
      return { stdout, timedOut }
    } finally {
      clearTimeout(limit)
    }
  },
}

const quiet = (host: Host, command: string[]) => (host.which('nice') ? ['nice', '-n', '19', ...command] : command)

/** one read of Claude Code's /usage. Nothing is read without bubblewrap, nor while the login is due for renewal */
export async function readClaude(now: () => number = Date.now, host: Host = HOST): Promise<Reading> {
  const binary = host.which('claude')
  if (!binary) return { hint: 'Claude Code is not installed on this machine.' }
  const bwrap = host.which('bwrap')
  // the seal is checked first: a read without it is never made, whatever else is true
  if (!bwrap) return { hint: 'Needs bubblewrap (bwrap) to read it safely, so nothing is read until it is installed: sudo apt install bubblewrap.' }
  const config = host.env.CLAUDE_CONFIG_DIR || join(host.home, '.claude')
  if (!host.exists(config)) return { hint: 'Not signed in to Claude Code on this machine.' }
  const login = host.read(join(config, '.credentials.json'))
  if (login !== null && claudeLoginDue(login, now())) return { hint: 'Its sign-in is near renewal: the next Claude Code run renews it, and the read waits for that.' }
  const argv = sealed(quiet(host, [binary, '-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config']), bwrap)!
  const run = await host.run(argv, { env: { ...host.env, TZ: 'UTC', TMPDIR: '/tmp' }, timeoutMs: RUN_LIMIT_MS })
  if (run.timedOut) return { reason: 'Claude Code took longer than a minute to answer.' }
  let result: unknown
  try {
    result = JSON.parse(run.stdout)?.result
  } catch {
    return { reason: "Couldn't read Claude Code's answer." }
  }
  if (typeof result !== 'string') return { reason: "Couldn't read Claude Code's answer." }
  const parsed = parseClaude(result, now())
  if (parsed.state === 'ok') return { figure: { windows: parsed.windows, source: "from Claude Code's /usage", at: now() } }
  if (parsed.state === 'signed-out') return { reason: 'Claude Code is not signed in.' }
  if (parsed.state === 'no-plan') return { hint: 'Claude Code shows no plan limits here: an API key, or no subscription.' }
  return { reason: parsed.why }
}
