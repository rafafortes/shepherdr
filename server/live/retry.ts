// A turn cut off by the model's provider: the agent did not stop, its provider did. Errors that pass by themselves
// (overloaded, at capacity, a rate limit, a dropped connection, a server error) are waited out: the agent is told to
// carry on after 1, 2, 4 and 8 minutes, so five tries over fifteen minutes, and only then does the human hear. Errors
// waiting can't fix (signed out, out of allowance, a model that isn't there, anything not recognised) go to a task's or
// a coordinator's backup agent at once where one is set (engine.ts cantGoOn, source.ts cannotGoOn), and otherwise to the
// human. A content or safety filter refusing one response is different: the provider is fine for every other chat, so
// that one task goes to its backup but no outage is kept and no provider is marked out (return.ts). Each CLI's log
// records the error (readers/), and this decides what it means. From herdr-projects' docs/provider-errors.md, without
// the weight.
import { dayOf, instant, parseClock, wall } from '../../shared/when.ts'
import { readJson, writeJson } from '../store.ts'
import { hidden } from './agents.ts'
import { OWN_ZONE } from './trigger.ts'

/** what a CLI's log says cut its turn off: the provider's words, and its own code and HTTP status where it has them; how
 *  long the CLI says to wait, where one says it (OpenCode's free models: `retryAfterMs`) */
export interface Cut {
  id: string
  at: number
  text: string
  code?: string
  status?: number
  retryAfterMs?: number
}

export interface ProviderError {
  /** it passes by itself: wait and try again */
  passing: boolean
  /** in a few words, for a status line: "Provider overloaded", "Out of allowance" */
  reason: string
  /** one response was refused by a content/safety filter: no provider outage, nothing for the return watch */
  blocked?: boolean
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
const CODE_LASTING = [
  'unauthorized',
  'bad_request',
  'context_window_exceeded',
  'usage_limit_exceeded',
  'sandbox_error',
  'authentication_failed',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'max_output_tokens',
  'provider.auth',
  'provider.no-route',
  'provider.invalid-request',
  'provider.unsupported-operation',
]
/** one response a content/safety filter refused: OpenCode's `provider.content-filter` (also a `content-filter` finish
 *  with no error object), Claude Code's `refusal` stop reason, Codex's policy errors, any provider's `content_filter`.
 *  Not a provider outage: the same context is likely blocked again, so only this task goes to its backup. */
const CODE_CONTENT = ['provider.content-filter', 'content-filter', 'content_filter', 'content_policy', 'refusal', 'cyber_policy', 'bio_policy', 'misalignment_policy_violation']
const WORDS_CONTENT =
  /\bflagged\b|content[\s_-]*(?:policy|filter|moderation)|safety[\s-]*(?:filter|settings|check|block)|(?:response|answer)\s+(?:was\s+)?blocked|blocked\s+(?:the\s+)?(?:response|answer)|reason:\s*content_filter/i
/** a rate limit in words, which OpenCode also types as its quota error (provider.quota) when the provider says so */
const WORDS_RATE = /rate.?limit|too many requests/i
const WORDS_AUTH = /\b(?:status|error|HTTP)\b[^\n]{0,12}\b40[13]\b|\b401 Unauthorized\b|please run \/login|login expired|not logged in|oauth token/i
/** a plan's allowance in words, which no wait clears: "usage limit" (but never Claude Code's "not your usage limit"
 *  while it throttles), "out of extra usage", a session's or a plan's limit, a quota, a billing problem. */
const WORDS_ALLOWANCE =
  /(?<!not your )usage limit|out of (?:extra )?usage|\b(?:session|weekly|hourly|daily|monthly|5-hour|five-hour|plan|subscription) limit\b|(?<!check )\bquota\b|billing|credit balance|payment/i
/** a limit the words say the agent hit or reached, with the words between them: "You've hit your 5-hour limit",
 *  "reached the limit for this week". The hyphen is why this has its own reader: Claude Code says "you've hit your
 *  5-hour limit", and without it the code that comes with it (`rate_limit`) had that cut off waited out as a passing
 *  rate limit. */
const PHRASED_LIMIT = /\b(?:hit|reached) (?:your|its|the) ([\w .'-]{0,24}?)\blimit\b/i
/** a bare "limit reached": an allowance, unless the limit is one of these */
const LIMIT_REACHED = /([\w-]+[ -])?limit reached/i
/** what a limit is *of* where that makes it a wait or a resource, never an allowance: a rate ("per-minute rate limit",
 *  "the API rate limit"), requests ("max_requests limit"), the context, the output, tokens, concurrency */
const LIMIT_OF_NOTHING = /\brate\b|requests?\b|context|output|tokens?\b|concurren|max_/i

/** whether the provider's words say its plan's allowance ran out, never a rate limit or a resource's own limit */
function outOfAllowanceInWords(words: string): boolean {
  if (WORDS_ALLOWANCE.test(words)) return true
  const phrased = PHRASED_LIMIT.exec(words)
  if (phrased && !LIMIT_OF_NOTHING.test(phrased[1] ?? '')) return true
  const reached = LIMIT_REACHED.exec(words)
  return reached !== null && !LIMIT_OF_NOTHING.test(reached[1] ?? '')
}
/** a prepaid balance that ran out: the provider says so with 402 Payment Required, or in these words */
const WORDS_CREDIT = /insufficient (?:account )?(?:funds|balance|credits?)|out of credits?|credit balance|payment required/i
// agy's words for a model it does not have: "invalid model selection", "is not recognized as a known model"
const WORDS_LASTING = /not supported|unsupported|does not exist|may not exist|not found|unknown (?:provider|model)|invalid|context (?:window|length)|not recognized as a known model/i
const WORDS_PASSING: [RegExp, string][] = [
  [/at capacity/i, 'Model at capacity'],
  [/rate.?limit|too many requests|\b429\b/i, 'Rate limited'],
  [/overloaded|\b529\b/i, 'Provider overloaded'],
  [/socket|connection|network|\bE(?:CONN\w+|TIMEDOUT|AI_AGAIN|PIPE)\b|timed? ?out|fetch failed|stream (?:ended|closed|disconnected|error)|disconnect/i, 'Connection dropped'],
  [
    /\b(?:API error|status|HTTP)\b[^\n]{0,12}\b5\d\d\b|internal server error|bad gateway|service unavailable|upstream|server error|you can retry your request|try again later/i,
    'Provider server error',
  ],
]

/** a reset's own words after "resets": up to a punctuation mark, but a dot inside a clock it writes ("5 p.m.") stays */
const RESET_WORDS = '((?:[^\n·.,;()]|\\.(?=[^\\s·.,;()])){1,24})'
/** when an allowance comes back, as the provider says it: "resets 5pm", "resets 2:10am", "reset at 3pm", "try again at
 *  5:00 PM", "resets Nov 6, 11:59am", "resets in 1h3m51s", or an ISO time ("resets at 2026-11-11T20:44:33Z",
 *  Command Code's) */
const RESET = new RegExp(`\\bresets? (?:at )?(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+(?:Z|[+-]\\d{2}:?\\d{2})?)|\\bresets? (?:at )?${RESET_WORDS}|\\btry again (?:at |on |after |in )?([^\\n.,;()]{1,24})`, 'i')

/** the units a provider counts a wait in: seconds too, which no time rule of Settings has (agy says "158h59m47s") */
const SPANS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
}

/** a span in a provider's words ("1h3m51s", "2d 5h", "20 minutes"), or none when the words are not all spans */
function spanOf(text: string): number | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^in /, '').replace(/ and /g, ' ')
  let total = 0
  let pos = 0
  const re = /\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*/g
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const unit = SPANS[m[2] ?? '']
    if (m.index !== pos || unit === undefined) return undefined
    total += Number(m[1] ?? 0) * unit
    pos = m.index + (m[0]?.length ?? 0)
  }
  return pos === t.length && total > 0 ? Math.round(total) : undefined
}

/** the wait as a provider writes it, for the moment it comes back at: "resets in 1h3m51s", "try again in 2 hours and
 *  5 minutes" */
const IN_SPAN = /\b(?:in|after)\s+([\d.]+\s*[a-z]+(?:(?:\s*and)?\s*[\d.]+\s*[a-z]+)*)/i
/** a clock time as a provider writes it: "5pm", "2:10am", "5:00 PM", "17:00", "noon" */
const CLOCK_WORDS = /\b(?:\d{1,2}(?::\d{2})?\s*(?:[ap]\.m\.?|[ap]m)|\d{1,2}:\d{2}|noon|midday|midnight)(?!\w)/i
/** a date a reset words itself with, its clock written after it: "Nov 6", "November 6th", "21 Nov" */
const DATE_WORDS = /\b(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i
/** a date as a machine writes it, its clock after it: "2026-11-25 03:00" */
const ISO_DATE_WORDS = /\b(\d{4})-(\d{2})-(\d{2})\b/
/** a day word a reset may name instead of a date: "tomorrow 9am", "Fri 9am" */
const DAY_WORD = /\b(today|tonight|tomorrow|tmrw|tmr|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i
/** the zone a CLI names beside its reset: "resets 5pm (Europe/Oslo)", "resets 3pm (UTC)" */
const NAMED_ZONE = /\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)*)\)/
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/** half a year: a date this far behind is the next year's (a week that ends after New Year), anything nearer is past */
const HALF_YEAR = 182 * 86_400_000

/**
 * The moment a reset's own words name, from `now` on and in a zone: a clock time today, or tomorrow once today's has
 * passed; a date and a clock, with the clock written after the date; or a wait from now. A date with no year is this
 * year's unless this year's is far behind, so a reset that has passed stays in the past — an allowance that came back
 * is back, never a year away. The zone a CLI names in brackets wins over the configured one. Undefined when the words
 * name no time this reads.
 */
function resetMoment(words: string, now: number, configured: string): number | undefined {
  const named = NAMED_ZONE.exec(words)?.[1]
  let zone = configured
  if (named) {
    try {
      wall(now, named)
      zone = named
    } catch {
      // not a zone: the one Settings sets
    }
  }
  const span = IN_SPAN.exec(words)?.[1]
  if (span) {
    const ms = spanOf(span)
    if (ms !== undefined) return now + ms
  }
  const clockText = CLOCK_WORDS.exec(words)?.[0]
  if (!clockText) return undefined
  let clock: { h: number; m: number }
  try {
    // a clock written with stops ("5 p.m.") is the same time as "5 pm"
    clock = parseClock(clockText.replace(/\./g, ''))
  } catch {
    return undefined
  }
  const today = wall(now, zone)
  const y = today.getUTCFullYear()
  const at = (year: number, month: number, day: number) => instant(new Date(Date.UTC(year, month, day, clock.h, clock.m)), zone)
  const todayAt = at(y, today.getUTCMonth(), today.getUTCDate())
  // "2026-11-25 03:00" names its own date, this year or another
  const machine = ISO_DATE_WORDS.exec(words)
  if (machine) return at(Number(machine[1]), Number(machine[2]) - 1, Number(machine[3]))
  const date = DATE_WORDS.exec(words)
  if (!date) {
    // a day word instead of a date: "tomorrow 9am", "Fri 9am"
    const word = (DAY_WORD.exec(words)?.[1] ?? '').toLowerCase()
    const ahead = dayOf(word, (today.getUTCDay() + 6) % 7)
    if (ahead !== undefined) {
      const moment = at(y, today.getUTCMonth(), today.getUTCDate() + ahead)
      // a weekday whose clock has gone today is next week's; "today" with one gone is already back
      const todayItself = word === 'today' || word === 'tonight'
      return todayItself || moment + 60_000 > now ? moment : at(y, today.getUTCMonth(), today.getUTCDate() + ahead + 7)
    }
    // its words stop at the minute: this minute is still today
    return todayAt + 60_000 > now ? todayAt : at(y, today.getUTCMonth(), today.getUTCDate() + 1)
  }
  const month = MONTHS.indexOf((date[1] ?? date[4] ?? '').toLowerCase())
  const day = Number(date[2] ?? date[3] ?? 0)
  if (day < 1 || day > 31) return undefined
  const thisYear = at(y, month, day)
  return now - thisYear > HALF_YEAR ? at(y + 1, month, day) : thisYear
}

/** an ISO time, in this machine's time zone and with its name: "11 Nov, 17:44 GMT-3" (as it is given when it can't be read) */
const local = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(d)
}

/** a moment, in this machine's time zone and with its name: "11 Nov, 17:44 GMT-3" */
export const momentOf = (at: number) => local(new Date(at).toISOString())

/**
 * The reset the provider's words give: what to show ("5pm", "in 2h", "11 Nov, 17:44 GMT-3") and, when the words say
 * a moment this can work out — an ISO time, a clock (today, else tomorrow), a date with its clock, or a wait from now —
 * when that is (ms), in the zone Settings set unless the words name one.
 */
export function resetOf(words: string, now = Date.now(), zone = OWN_ZONE): { when: string; at?: number } | undefined {
  const m = RESET.exec(words)
  if (!m) return undefined
  if (m[1]) {
    const at = Date.parse(m[1])
    return { when: local(m[1]), ...(Number.isNaN(at) ? {} : { at }) }
  }
  const when = (m[2] ?? m[3])?.trim()
  if (!when) return undefined
  // the time is read from the reset's own words on: a date keeps the clock written after it, and no other number of
  // the message is taken for it
  const rest = words.slice(m.index)
  const at = resetMoment(rest, now, zone)
  // "try again later", "reset your payment method": words that name no time at all say no reset, and the reason keeps
  // nothing of them
  if (at === undefined && !CLOCK_WORDS.test(rest) && !DAY_WORD.test(rest) && !DATE_WORDS.test(rest) && !ISO_DATE_WORDS.test(rest) && !IN_SPAN.test(rest)) return undefined
  return { when, ...(at !== undefined ? { at } : {}) }
}

const until = (words: string, resetAt?: number) => {
  const r = resetOf(words)
  // a provider that says how long to wait (OpenCode's free models' retryAfterMs) instead of when: its reset, in this
  // machine's time
  return r ? ` until ${r.when}` : resetAt ? ` until ${momentOf(resetAt)}` : ''
}

/** a reason that is a provider's run-out: its allowance or its credit is used up (retry.ts providerError), in the
 *  capitalised words it says it with or the lower-case ones a takeover keeps (an outage's `why`) */
export const runOutOf = (reason: string) => /^out of (?:allowance|credit)/i.test(reason)

/** which errors pass by themselves. The CLI's own code decides where it has one (Codex codex_error_info, Claude Code's
 *  error and HTTP status); its words decide for the rest. Not recognised: it doesn't pass. `resetAt` is when the provider
 *  says its allowance comes back, where it said how long to wait rather than when (ms). */
export function providerError(words: string, code = '', status = 0, resetAt?: number): ProviderError {
  const c = code.toLowerCase()
  const said = WORDS_PASSING.find(([re]) => re.test(words))?.[1]
  if (c === 'unauthorized' || c === 'authentication_failed' || c === 'provider.auth' || status === 401 || status === 403 || WORDS_AUTH.test(words)) return { passing: false, reason: 'Signed out' }
  // a prepaid balance that is spent (402, or its words) is out of credit; a plan's allowance is out of allowance
  if (status === 402 || WORDS_CREDIT.test(words)) return { passing: false, reason: `Out of credit${until(words, resetAt)}` }
  // OpenCode's quota error is its plan's or its free models' allowance (its `provider.free-limit`, whose retryAfterMs says
  // when they come back), unless the provider says it is a rate limit
  if (c === 'usage_limit_exceeded' || c === 'billing_error' || c === 'provider.free-limit' || (c === 'provider.quota' && !WORDS_RATE.test(words)) || outOfAllowanceInWords(words))
    return { passing: false, reason: `Out of allowance${until(words, resetAt)}` }
  // a filter refusing one response is no outage of the provider: its own task goes to its backup (no return entry),
  // never a provider other chats are kept off. Waiting would only feed the same blocked context back to the same model.
  if (CODE_CONTENT.includes(c) || WORDS_CONTENT.test(words)) return { passing: false, reason: "Response blocked by the provider's filter", blocked: true }
  if (CODE_LASTING.includes(c) || (status >= 400 && status < 500 && status !== 408 && status !== 429) || WORDS_LASTING.test(words))
    return {
      passing: false,
      reason:
        c === 'context_window_exceeded' || /context (?:window|length|limit)|too long/i.test(words)
          ? 'Context window full'
          : c === 'model_not_found' || c === 'provider.no-route' || /model/i.test(words)
            ? 'Model not available'
            : 'Provider refused it',
    }
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
  /** the provider itself is out (out of allowance, signed out, a model that is not there, a lasting refusal): only a
   *  backup or the human can, and its primary is watched until it answers. Unset when the tries ran out on an error
   *  that passes by itself, and when one response was blocked by a content filter */
  lasting?: boolean
  /** one response was refused by a filter: its chat goes to its backup, but there is no outage to watch, so this
   *  takeover must not be adopted as one by the way back (unlike a passing error's five tries) */
  blocked?: boolean
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
    const e = providerError(cut.text, cut.code, cut.status, cut.retryAfterMs ? cut.at + cut.retryAfterMs : undefined)
    const tries = (was?.tries ?? 0) + 1
    const words = cut.text.replace(/\s+/g, ' ').trim().slice(0, 300)
    if (e.passing && tries <= this.waits.length) {
      const r: Retry = { cut: cut.id, tries, reason: e.reason, words, due: now + this.waits[tries - 1] }
      this.set(key, r)
      this.arm(key, r.due!)
      this.hooks.changed(key)
      return
    }
    // a filter's refusal of one response hands only this chat to its backup: no wait (the same blocked context would
    // come back), and no lasting flag (no outage for the return watch, so its provider stays free for new starts)
    const r: Retry = {
      cut: cut.id,
      tries,
      reason: e.passing ? `${e.reason}, still after ${tries} tries` : e.reason,
      words,
      over: true,
      ...(e.passing || e.blocked ? {} : { lasting: true }),
      ...(e.blocked ? { blocked: true } : {}),
    }
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
