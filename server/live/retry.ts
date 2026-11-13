// A turn cut off by the model's provider: the agent did not stop, its provider did. Errors that pass by themselves
// (overloaded, at capacity, a rate limit, a dropped connection, a server error) are waited out: the agent is told to
// carry on after 1, 2, 4 and 8 minutes, so five tries over fifteen minutes, and only then does the human hear. Errors
// waiting can't fix (signed out, out of allowance, a model that isn't there, anything not recognised) go to a task's or
// a coordinator's backup agent at once where one is set (engine.ts cantGoOn, source.ts cannotGoOn), and otherwise to the
// human. Each CLI's log records the error (readers/), and this
// decides what it means. From herdr-projects' docs/provider-errors.md, without the weight.
import { readJson, writeJson } from '../store.ts'
import { hidden } from './agents.ts'

/** what a CLI's log says cut its turn off: the provider's words, and its own code and HTTP status where it has them */
export interface Cut {
  id: string
  at: number
  text: string
  code?: string
  status?: number
}

export interface ProviderError {
  /** it passes by itself: wait and try again */
  passing: boolean
  /** in a few words, for a status line: "Provider overloaded", "Out of allowance" */
  reason: string
}

const CODE_PASSING: Record<string, string> = {
  server_overloaded: 'Provider overloaded',
  overloaded: 'Provider overloaded',
  overloaded_error: 'Provider overloaded',
  model_cap: 'Model at capacity',
  http_connection_failed: 'Connection dropped',
  response_stream_connection_failed: 'Connection dropped',
  response_stream_disconnected: 'Connection dropped',
  response_too_many_failed_attempts: 'Connection dropped',
  internal_server_error: 'Provider server error',
  server_error: 'Provider server error',
  // OpenCode's own error types (its provider errors, as its message rows keep them)
  'provider.rate-limit': 'Rate limited',
  'provider.transport': 'Connection dropped',
  'provider.timeout': 'Connection dropped',
  'provider.internal': 'Provider server error',
  'provider.invalid-output': 'Provider answer cut short',
}
const CODE_LASTING = ['unauthorized', 'bad_request', 'context_window_exceeded', 'usage_limit_exceeded', 'sandbox_error', 'authentication_failed', 'billing_error', 'invalid_request', 'model_not_found', 'max_output_tokens', 'provider.auth', 'provider.no-route', 'provider.content-filter', 'provider.invalid-request', 'provider.unsupported-operation', 'content-filter']
/** a rate limit in words, which OpenCode also types as its quota error (provider.quota) when the provider says so */
const WORDS_RATE = /rate.?limit|too many requests/i
const WORDS_AUTH = /\b(?:status|error|HTTP)\b[^\n]{0,12}\b40[13]\b|\b401 Unauthorized\b|please run \/login|login expired|not logged in|oauth token/i
const WORDS_ALLOWANCE = /usage limit|(?<!rate.?)limit reached|hit your [\w ]*limit|\bquota\b|billing|credit balance|payment/i
/** a prepaid balance that ran out: the provider says so with 402 Payment Required, or in these words */
const WORDS_CREDIT = /insufficient (?:account )?(?:funds|balance|credits?)|out of credits?|credit balance|payment required/i
// agy's words for a model it does not have: "invalid model selection", "is not recognized as a known model"
const WORDS_LASTING = /not supported|unsupported|does not exist|may not exist|not found|unknown (?:provider|model)|invalid|context (?:window|length)|flagged|content policy|not recognized as a known model/i
const WORDS_PASSING: [RegExp, string][] = [
  [/at capacity/i, 'Model at capacity'],
  [/rate.?limit|too many requests|\b429\b/i, 'Rate limited'],
  [/overloaded|\b529\b/i, 'Provider overloaded'],
  [/socket|connection|network|\bE(?:CONN\w+|TIMEDOUT|AI_AGAIN|PIPE)\b|timed? ?out|fetch failed|stream (?:ended|closed|disconnected|error)|disconnect/i, 'Connection dropped'],
  [/\b(?:API error|status|HTTP)\b[^\n]{0,12}\b5\d\d\b|internal server error|bad gateway|service unavailable|upstream|server error|you can retry your request|try again later/i, 'Provider server error'],
]

/** when an allowance comes back, as the provider says it: "resets 5pm", "try again at 5:00 PM", or an ISO time
 *  ("resets at 2026-11-11T20:44:33Z", Command Code's) */
const RESET = /\bresets (?:at )?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)|\bresets (?:at )?([^\n·.,;()]{1,24})|try again (?:at|after) ([^\n.,;()]{1,24})/i

/** an ISO time, in this machine's time zone and with its name: "11 Nov, 17:44 GMT-3" (as it is given when it can't be read) */
const local = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(d)
}

/** the reset the provider's words give: what to show ("5pm", "11 Nov, 17:44 GMT-3") and, for an ISO time, when (ms) */
export function resetOf(words: string): { when: string; at?: number } | undefined {
  const m = RESET.exec(words)
  if (!m) return undefined
  if (m[1]) {
    const at = Date.parse(m[1])
    return { when: local(m[1]), ...(Number.isNaN(at) ? {} : { at }) }
  }
  const when = (m[2] ?? m[3])?.trim()
  return when ? { when } : undefined
}

const until = (words: string) => {
  const r = resetOf(words)
  return r ? ` until ${r.when}` : ''
}

/** a reason that is a provider's run-out: its allowance or its credit is used up (retry.ts providerError) */
export const runOutOf = (reason: string) => /^Out of (?:allowance|credit)/.test(reason)

/** which errors pass by themselves. The CLI's own code decides where it has one (Codex codex_error_info, Claude Code's
 *  error and HTTP status); its words decide for the rest. Not recognised: it doesn't pass. */
export function providerError(words: string, code = '', status = 0): ProviderError {
  const c = code.toLowerCase()
  const said = WORDS_PASSING.find(([re]) => re.test(words))?.[1]
  if (c === 'unauthorized' || c === 'authentication_failed' || c === 'provider.auth' || status === 401 || status === 403 || WORDS_AUTH.test(words)) return { passing: false, reason: 'Signed out' }
  // a prepaid balance that is spent (402, or its words) is out of credit; a plan's allowance is out of allowance
  if (status === 402 || WORDS_CREDIT.test(words)) return { passing: false, reason: `Out of credit${until(words)}` }
  // OpenCode's quota error is its plan's or its free models' allowance, unless the provider says it is a rate limit
  if (c === 'usage_limit_exceeded' || c === 'billing_error' || (c === 'provider.quota' && !WORDS_RATE.test(words)) || WORDS_ALLOWANCE.test(words)) return { passing: false, reason: `Out of allowance${until(words)}` }
  if (CODE_LASTING.includes(c) || (status >= 400 && status < 500 && status !== 408 && status !== 429) || WORDS_LASTING.test(words)) return { passing: false, reason: c === 'context_window_exceeded' || /context (?:window|length)|too long/i.test(words) ? 'Context window full' : c === 'model_not_found' || c === 'provider.no-route' || /model/i.test(words) ? 'Model not available' : 'Provider refused it' }
  if (CODE_PASSING[c]) return { passing: true, reason: said ?? CODE_PASSING[c] }
  if (status === 429 || c === 'rate_limit') return { passing: true, reason: 'Rate limited' }
  if (status === 408 || status >= 500) return { passing: true, reason: said ?? (status === 529 ? 'Provider overloaded' : 'Provider server error') }
  return said ? { passing: true, reason: said } : { passing: false, reason: 'Provider error' }
}

/** the waits before each try: after the fifth cut-off turn in a row, it gives up */
export const WAITS = [1, 2, 4, 8].map((m) => m * 60_000)

export interface Retry {
  /** the cut-off turn last seen (its log event's id) */
  cut: string
  /** cut-off turns in a row */
  tries: number
  reason: string
  /** the provider's own words */
  words: string
  /** when it is told to carry on; none once it was told (its turn runs) or it gave up */
  due?: number
  /** when it was told */
  nudged?: number
  /** given up: what waiting can't fix, or still cut off after the last try. The human (or a backup agent) is next */
  over?: boolean
  /** waiting can't fix it (out of allowance, signed out, a model that is not there, a refusal): only a backup or the
   *  human can. Unset when the tries ran out on an error that passes by itself */
  lasting?: boolean
}

/** the line a cut-off agent is told after the wait */
export const carryOn = (reason: string) => hidden(`Your last turn was cut off by the model's provider (${reason.toLowerCase()}). Carry on where you left off.`)

/** how long until the next try, for a status line: "2m", "<1m" */
export const inMins = (due: number, now = Date.now()) => (due - now < 60_000 ? '<1m' : `${Math.round((due - now) / 60_000)}m`)

/**
 * Every agent's cut-off turns: seen() after each turn ends (with its log's cut, or none), it waits and nudges, or
 * gives up. A turn that ends well, or anything written to the agent, starts the count again. Kept across a restart.
 */
export class Retries {
  private data = readJson<Record<string, Retry>>('retries.json', {})
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private hooks: {
      /** tell it to carry on */
      nudge: (key: string, text: string) => void
      /** it can't go on by itself: the human, or a backup agent */
      over: (key: string, r: Retry) => void
      changed: (key: string) => void
      /** a new cut-off turn that is a provider's run-out (runOutOf): its log's cut, once (usage-ledger.ts keeps it) */
      runOut?: (key: string, cut: Cut, reason: string) => void
    },
    private waits = WAITS,
  ) {
    // after a restart, once herdr has told which agents run
    for (const [key, r] of Object.entries(this.data)) if (r.due) this.arm(key, Math.max(r.due, Date.now() + 30_000))
  }

  get(key: string): Retry | undefined {
    return this.data[key]
  }

  /** its last turn ended: with what cut it off, or none (it ended well, or a newer turn began since) */
  seen(key: string, cut: Cut | undefined, now = Date.now()) {
    const was = this.data[key]
    // a newer turn began since (a job it left running woke it, you typed in its terminal, the CLI tried again by
    // itself): it went on without being told, and the count starts again
    if (!cut) return was ? this.clear(key) : undefined
    if (was?.cut === cut.id) return
    const e = providerError(cut.text, cut.code, cut.status)
    const tries = (was?.tries ?? 0) + 1
    const words = cut.text.replace(/\s+/g, ' ').trim().slice(0, 300)
    if (e.passing && tries <= this.waits.length) {
      const r: Retry = { cut: cut.id, tries, reason: e.reason, words, due: now + this.waits[tries - 1] }
      this.set(key, r)
      this.arm(key, r.due!)
      this.hooks.changed(key)
      return
    }
    const r: Retry = { cut: cut.id, tries, reason: e.passing ? `${e.reason}, still after ${tries} tries` : e.reason, words, over: true, ...(e.passing ? {} : { lasting: true }) }
    this.set(key, r)
    if (!e.passing && runOutOf(e.reason)) this.hooks.runOut?.(key, cut, e.reason)
    // told by what comes next: a backup agent takes over, or the human hears
    this.hooks.over(key, r)
  }

  /** a message went in (yours, a coordinator's): it carries on now, and the count starts again */
  clear(key: string) {
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
    if (!this.data[key]) return
    delete this.data[key]
    this.save()
    this.hooks.changed(key)
  }

  stop() {
    for (const x of this.timers.values()) clearTimeout(x)
  }

  private set(key: string, r: Retry) {
    this.data[key] = r
    this.save()
  }

  private arm(key: string, due: number) {
    clearTimeout(this.timers.get(key))
    const x = setTimeout(() => this.due(key), Math.max(0, due - Date.now()))
    x.unref?.()
    this.timers.set(key, x)
  }

  private due(key: string) {
    this.timers.delete(key)
    const r = this.data[key]
    if (!r?.due) return
    r.due = undefined
    r.nudged = Date.now()
    this.save()
    this.hooks.nudge(key, carryOn(r.reason))
    this.hooks.changed(key)
  }

  private save() {
    writeJson('retries.json', this.data)
  }
}
