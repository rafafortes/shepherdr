// A turn cut off by the model's provider: each CLI's log says so (on recorded endings in samples/endings, from
// herdr-projects' tests: the "-made" ones are written by hand in a recorded one's shape), which errors pass by
// themselves, and the waits and tries before the human hears.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('retry')
const { readerFor } = await import('../server/live/readers/index.ts')
const { carryOn, providerError, resetOf, Retries, runOutOf, WAITS } = await import('../server/live/retry.ts')

const ending = (name: string) => {
  const cli = name.split('-')[0]
  const lines = readFileSync(join(import.meta.dir, 'samples', 'endings', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((text, i) => ({ text, offset: i * 1000 }))
  const ev = readerFor(cli)!.parse(lines, `/logs/${name}.jsonl`)
  const e = ev.find((x) => x.kind === 'error')
  if (e?.kind !== 'error') throw new Error(`${name}: no error read`)
  // the turn is over with it
  expect(ev.findLastIndex((x) => x.kind === 'turn-end')).toBeGreaterThan(ev.indexOf(e))
  return providerError(e.text, e.code, e.status, e.retryAfterMs ? e.at + e.retryAfterMs : undefined)
}

describe("each CLI's log says what cut its turn off", () => {
  test('errors that pass by themselves are waited out', () => {
    expect(ending('claude-overloaded-made')).toEqual({ passing: true, reason: 'Provider overloaded' })
    expect(ending('claude-rate-limit-made')).toEqual({ passing: true, reason: 'Rate limited' })
    expect(ending('codex-at-capacity')).toEqual({ passing: true, reason: 'Model at capacity' })
    expect(ending('pi-socket-closed')).toEqual({ passing: true, reason: 'Connection dropped' })
    expect(ending('pi-overloaded')).toEqual({ passing: true, reason: 'Provider overloaded' })
    expect(ending('pi-gateway-502').passing).toBe(true)
  })

  test("pi's status alone waits out a cut-off its words do not describe, as for every other CLI", () => {
    // a provider rewords its errors: these words match no passing word rule, only the HTTP status pi recovered from
    // them decides. Without the status the same words are unrecognised and go to the backup or the human at once.
    const words = '503 provider returned: request could not be completed at this time'
    expect(providerError(words)).toEqual({ passing: false, reason: 'Provider error' })
    const line = {
      type: 'message',
      id: 'e1',
      timestamp: '2026-11-18T10:00:00.000Z',
      message: { role: 'assistant', content: [], usage: {}, stopReason: 'error', errorMessage: words },
    }
    const e = readerFor('pi')!
      .parse([{ text: JSON.stringify(line), offset: 0 }], '/logs/pi-reworded.jsonl')
      .find((x) => x.kind === 'error')
    if (e?.kind !== 'error') throw new Error('pi reworded: no error read')
    expect(e.status).toBe(503)
    expect(providerError(e.text, e.code, e.status)).toEqual({ passing: true, reason: 'Provider server error' })
  })

  test("pi's recovered status leaves every pinned sample's classification unchanged", () => {
    const cut = (name: string) => {
      const lines = readFileSync(join(import.meta.dir, 'samples', 'endings', `${name}.jsonl`), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((text, i) => ({ text, offset: i * 1000 }))
      const e = readerFor('pi')!
        .parse(lines, `/logs/${name}.jsonl`)
        .find((x) => x.kind === 'error')
      if (e?.kind !== 'error') throw new Error(`${name}: no error read`)
      return e
    }
    // only the two samples whose words name one gain a status
    expect(cut('pi-gateway-502').status).toBe(502)
    expect(cut('pi-usage-limit-made').status).toBe(429)
    for (const name of ['pi-content-filter-made', 'pi-overloaded', 'pi-socket-closed', 'pi-unknown-provider']) {
      expect('status' in cut(name)).toBe(false)
    }
    // the words still win where they match, so each pinned sample keeps the classification it had before
    expect(ending('pi-gateway-502')).toEqual({ passing: true, reason: 'Provider server error' })
    expect(ending('pi-overloaded')).toEqual({ passing: true, reason: 'Provider overloaded' })
    expect(ending('pi-socket-closed')).toEqual({ passing: true, reason: 'Connection dropped' })
    expect(ending('pi-unknown-provider')).toEqual({ passing: false, reason: 'Provider refused it' })
    expect(ending('pi-content-filter-made')).toEqual({ passing: false, reason: "Response blocked by the provider's filter", blocked: true })
    expect(ending('pi-usage-limit-made')).toEqual({ passing: false, reason: 'Out of allowance until 3pm' })
  })

  test('errors waiting cannot fix go on at once, in a few words', () => {
    expect(ending('claude-usage-limit-made')).toEqual({ passing: false, reason: 'Out of allowance until 5pm' })
    expect(ending('claude-model-not-found')).toEqual({ passing: false, reason: 'Model not available' })
    expect(ending('codex-unauthorized')).toEqual({ passing: false, reason: 'Signed out' })
    expect(ending('codex-model-not-supported')).toEqual({ passing: false, reason: 'Model not available' })
    expect(ending('pi-unknown-provider').passing).toBe(false)
    // agy's words for a model it does not have: lasting, and the model is the one not available
    expect(ending('agy-invalid-model-made')).toEqual({ passing: false, reason: 'Model not available' })
    // its provider's quota (429, RESOURCE_EXHAUSTED): out of allowance, with the reset its words give
    expect(ending('agy-quota-made')).toEqual({ passing: false, reason: 'Out of allowance until in 158h59m47s' })
    expect(providerError('gemini-9 is not recognized as a known model')).toEqual({ passing: false, reason: 'Model not available' })
    expect(providerError('Your input exceeds the context window of this model.', 'context_window_exceeded').reason).toBe('Context window full')
    expect(providerError("You've hit your limit · resets 5pm (Europe/Oslo)").reason).toBe('Out of allowance until 5pm')
    expect(providerError('Login expired · Please run /login', 'authentication_failed')).toEqual({ passing: false, reason: 'Signed out' })
    // anything not recognised is not waited out
    expect(providerError('Something odd happened')).toEqual({ passing: false, reason: 'Provider error' })
  })

  test('a spent prepaid balance (402, Insufficient account funds) is out of credit, not a refusal', () => {
    expect(providerError('402 Insufficient account funds', '', 402)).toEqual({ passing: false, reason: 'Out of credit' })
    expect(providerError('Insufficient balance, top up to continue')).toEqual({ passing: false, reason: 'Out of credit' })
    expect(providerError('Your credit balance is too low', '', 400)).toEqual({ passing: false, reason: 'Out of credit' })
    // a plan's allowance and a refused request keep their own reasons
    expect(providerError("You've hit your limit · resets 5pm", '', 429).reason).toBe('Out of allowance until 5pm')
    expect(providerError('bad request', 'invalid_request', 400).reason).toBe('Provider refused it')
  })

  test("OpenCode's own errors: its plan's or free models' allowance, a rate limit, a dead key, a model it lacks", () => {
    // its quota error is out of allowance, unless the provider says it is a rate limit: then it waits
    expect(ending('opencode-go-usage-limit-made')).toEqual({ passing: false, reason: 'Out of allowance' })
    expect(ending('opencode-rate-limit-made')).toEqual({ passing: true, reason: 'Rate limited' })
    expect(ending('opencode-auth-made')).toEqual({ passing: false, reason: 'Signed out' })
    expect(ending('opencode-transport-made')).toEqual({ passing: true, reason: 'Connection dropped' })
    expect(ending('opencode-no-route-made')).toEqual({ passing: false, reason: 'Model not available' })
    // its free models' allowance says the same words, and a reset in them is kept
    expect(providerError('Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to Go to keep going.', 'provider.quota', 429).reason).toBe('Out of allowance')
    expect(providerError('Rate limit exceeded. Please try again later.', 'provider.quota', 429)).toEqual({ passing: true, reason: 'Rate limited' })
    expect(providerError('Rate limit exceeded, resets 5pm', 'provider.quota', 429).reason).toBe('Rate limited')
    expect(providerError('Insufficient balance. Top up your OpenCode account.', 'provider.quota', 402)).toEqual({ passing: false, reason: 'Out of credit' })
    expect(providerError('OpenAI Chat stream ended without finish_reason', 'provider.invalid-output', 200)).toEqual({ passing: true, reason: 'Connection dropped' })
    expect(providerError('Model answer cut short', 'provider.invalid-output', 200)).toEqual({ passing: true, reason: 'Provider answer cut short' })
    expect(providerError('Streaming response failed: capacity is temporarily limited', 'provider.rate-limit', 200)).toEqual({ passing: true, reason: 'Rate limited' })
    expect(providerError('Upstream failed', 'provider.internal', 500)).toEqual({ passing: true, reason: 'Provider server error' })
    expect(providerError('Function not found', 'provider.invalid-request', 404)).toEqual({ passing: false, reason: 'Provider refused it' })
    // its free models ran out: provider.free-limit, which says how long to wait (retryAfterMs) instead of when
    // WEB-137: the failure at 20:50:11, its free models back in 2,447,000 ms (about 21:31)
    const resetAt = 1794958211000 + 2_447_000
    const shown = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(resetAt))
    expect(ending('opencode-free-limit-made')).toEqual({ passing: false, reason: `Out of allowance until ${shown}` })
    expect(providerError('Free usage limit reached.', 'provider.free-limit', 429, resetAt)).toEqual({ passing: false, reason: `Out of allowance until ${shown}` })
    expect(providerError('Blocked by content filter', 'provider.content-filter')).toEqual({ passing: false, reason: "Response blocked by the provider's filter", blocked: true })
  })

  test("a phrased session, weekly or 5-hour limit is out of allowance in every CLI's words, never a rate limit", () => {
    // POL-452: Claude Code's StopFailure sends code rate_limit, and its words say "You've hit your 5-hour limit": the
    // hyphen was not in the old rule, so the cut was waited out five times over fifteen minutes, no run-out was kept,
    // and the task went to a backup at the end of it
    expect(ending('claude-5-hour-limit-made')).toEqual({ passing: false, reason: 'Out of allowance until 2:10am' })
    const phrased = [
      // Claude Code's own words, with the code and status it sends with them
      ["You've hit your 5-hour limit · resets 2:10am", 'rate_limit', 429],
      ["You've hit your weekly limit · resets Nov 21, 11:59am", 'rate_limit', 429],
      ["You've hit your session limit · resets 5pm", 'rate_limit', 429],
      ['5-hour limit reached · resets 2:10am', 'rate_limit', 429],
      ["You've reached your daily limit", 'rate_limit', 429],
      // and the other four CLIs' words for the same thing
      ["You've hit your usage limit. Upgrade to Pro or try again at 5:00 PM.", 'usage_limit_exceeded', 429],
      ['429 usage limit reached for this plan, resets 3pm', '', 429],
      ['Go usage limit exceeded', 'provider.quota', 429],
      ['RESOURCE_EXHAUSTED: Individual quota reached. Resets in 158h59m47s.', '', 429],
    ] as const
    for (const [words, code, status] of phrased) {
      const e = providerError(words, code, status)
      expect([words, e.passing]).toEqual([words, false])
      expect([words, runOutOf(e.reason)]).toEqual([words, true])
    }
    // a real rate limit keeps being waited out, however it is worded, and in whoever's words
    expect(providerError("You've hit your rate limit", 'rate_limit', 429)).toEqual({ passing: true, reason: 'Rate limited' })
    expect(providerError('Rate limit reached, please retry', '', 429)).toEqual({ passing: true, reason: 'Rate limited' })
    expect(providerError('too many requests', 'provider.rate-limit', 429)).toEqual({ passing: true, reason: 'Rate limited' })
    // a rate limit with a word before it, and a limit of a resource, are no allowance either
    expect(providerError('You have reached the per-minute rate limit', 'rate_limit', 429)).toEqual({ passing: true, reason: 'Rate limited' })
    expect(providerError('hit the API rate limit', '', 429)).toEqual({ passing: true, reason: 'Rate limited' })
    expect(providerError('You have reached the context window limit', 'context_window_exceeded', 400).reason).toBe('Context window full')
    // Claude Code's own words while the provider throttles it: not the allowance, though it says "usage limit"
    expect(providerError('Claude Code is temporarily limiting requests (not your usage limit)', 'rate_limit', 429)).toEqual({ passing: true, reason: 'Rate limited' })
    // its extra usage running out is the allowance, with the reset it names
    expect(providerError("You're out of extra usage · resets 5pm", 'rate_limit', 429).reason).toBe('Out of allowance until 5pm')
    // a plan's spend or an organization's limit is the allowance, apostrophe and all, and the rate words after a full
    // stop say nothing of it; a limit of requests, of tokens or of the context, however it is spelled, is not
    expect(providerError("You've hit your org's spend limit", 'rate_limit', 429)).toEqual({ passing: false, reason: 'Out of allowance' })
    expect(providerError("You've hit your org's spend limit. Requests are blocked until you raise it", 'rate_limit', 429)).toEqual({ passing: false, reason: 'Out of allowance' })
    expect(providerError("You've hit your corporate spend limit", 'rate_limit', 429)).toEqual({ passing: false, reason: 'Out of allowance' })
    expect(providerError('max_requests limit exceeded', 'rate_limit', 429)).toEqual({ passing: true, reason: 'Rate limited' })
    expect(providerError('Request limit reached', '', 429)).toEqual({ passing: true, reason: 'Rate limited' })
    expect(providerError('Output token limit reached', '', 429)).toEqual({ passing: true, reason: 'Rate limited' })
    expect(providerError('Context limit reached · /compact or /clear to continue', 'invalid_request', 400).reason).toBe('Context window full')
    // a bare limit reached is the allowance, and Google's transient 429 that points at its quota page is a wait
    expect(providerError('Limit reached. resets 3pm', '', 429).reason).toBe('Out of allowance until 3pm')
    expect(providerError('Resource has been exhausted (e.g. check quota).', '', 429)).toEqual({ passing: true, reason: 'Rate limited' })
    // agy's own out-of-allowance words, which name a quota reached and its reset
    expect(providerError('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 158h59m47s.', '', 429).reason).toBe('Out of allowance until in 158h59m47s')
  })

  test('a reset given as a clock, a date or a wait is read into the moment it comes back', () => {
    // 19 Nov 2026, 10:00 in the zone read: a reset is worked out from `now`, never from when the message is read
    const now = Date.UTC(2026, 10, 19, 10, 0)
    const at = (words: string, zone = 'UTC') => {
      const r = resetOf(words, now, zone)
      return r?.at === undefined ? undefined : new Date(r.at).toISOString()
    }
    // a clock today, or tomorrow once today's has passed
    expect(at('resets 5pm')).toBe('2026-11-19T17:00:00.000Z')
    expect(at('try again at 5:00 PM')).toBe('2026-11-19T17:00:00.000Z')
    // a day word instead of a date, and its words stopping at the minute
    expect(at('resets tomorrow 9am')).toBe('2026-11-20T09:00:00.000Z')
    expect(at('try again Fri 5pm')).toBe('2026-11-20T17:00:00.000Z')
    expect(at('resets today 3pm')).toBe('2026-11-19T15:00:00.000Z')
    // 19 Nov is a Thursday: a weekday whose clock has gone today is next week's, and "today" with one gone is past
    expect(at('resets Thu 3am')).toBe('2026-11-26T03:00:00.000Z')
    expect(at('resets today 3am')).toBe('2026-11-19T03:00:00.000Z')
    // a clock written with stops: "5 p.m.", and the same without its last stop
    expect(at('resets 5 p.m.')).toBe('2026-11-19T17:00:00.000Z')
    expect(at('resets 5 p.m')).toBe('2026-11-19T17:00:00.000Z')
    expect(at('resets 2:10am')).toBe('2026-11-20T02:10:00.000Z')
    expect(at('Claude usage limit reached. Your limit will reset at 3pm')).toBe('2026-11-19T15:00:00.000Z')
    expect(at('resets noon')).toBe('2026-11-19T12:00:00.000Z')
    // its words stop at the minute: a clock that has this very minute in it is today's, not tomorrow's
    const minute = (words: string, moment: number) => {
      const r = resetOf(words, moment, 'UTC')
      return r?.at === undefined ? undefined : new Date(r.at).toISOString()
    }
    expect(minute('resets 2:10am', Date.UTC(2026, 10, 19, 2, 10, 30))).toBe('2026-11-19T02:10:00.000Z')
    // the zone a CLI names beside its time wins over the configured one; without one, the configured zone is read
    expect(at('resets 5pm (Europe/Oslo)', 'America/Sao_Paulo')).toBe('2026-11-19T16:00:00.000Z')
    expect(at('resets 5pm', 'Europe/Oslo')).toBe('2026-11-19T16:00:00.000Z')
    // brackets that name no zone leave the configured one; a zone without a slash (UTC) is read when Intl knows it
    expect(at('resets 5pm (Foo/Bar)')).toBe('2026-11-19T17:00:00.000Z')
    expect(at('resets 5pm (America/Sao_Paulo)')).toBe('2026-11-19T20:00:00.000Z')
    expect(at('resets 5pm (UTC)', 'Europe/Oslo')).toBe('2026-11-19T17:00:00.000Z')
    // a date with its clock written after it; one that has passed is past (an allowance that came back is back), and one
    // a week ahead is this year's
    expect(at('resets Nov 21, 11:59am')).toBe('2026-11-21T11:59:00.000Z')
    expect(at('resets 21 Nov, 11:59am')).toBe('2026-11-21T11:59:00.000Z')
    // a date a machine writes names its own, never today's clock
    expect(at('resets 2026-11-25 03:00')).toBe('2026-11-25T03:00:00.000Z')
    expect(at("You've hit your weekly limit · resets Nov 6, 11:59am")).toBe('2026-11-06T11:59:00.000Z')
    expect(at('resets Dec 30, 1:00pm')).toBe('2026-12-30T13:00:00.000Z')
    // a date this year's is half a year behind is next year's (a week that ends after New Year)
    expect(at('resets Jan 2, 1:00pm')).toBe('2027-01-02T13:00:00.000Z')
    // a wait from now, in a provider's words: agy's seconds too, which no time rule of Settings has
    expect(at('Resets in 158h59m47s.')).toBe('2026-11-26T00:59:47.000Z')
    expect(at('resets in 1h3m51s')).toBe('2026-11-19T11:03:51.000Z')
    expect(at('resets in 2d 5h')).toBe('2026-11-21T15:00:00.000Z')
    expect(at('try again in 20 minutes')).toBe('2026-11-19T10:20:00.000Z')
    expect(at('resets in 2 hours and 5 minutes')).toBe('2026-11-19T12:05:00.000Z')
    // what names no time it can read keeps only the provider's words
    expect(resetOf('resets in 3 elephants', now, 'UTC')).toEqual({ when: 'in 3 elephants' })
    expect(resetOf('resets 31:99pm', now, 'UTC')).toEqual({ when: '31:99pm' })
    expect(resetOf('resets Nov 42, 5pm', now, 'UTC')).toEqual({ when: 'Nov 42' })
    // a reset whose words are blank, or that name no time at all ("try again later", "reset your payment method"),
    // says no reset: the reason keeps nothing of those words
    expect(resetOf('resets  · 5pm', now, 'UTC')).toBeUndefined()
    expect(resetOf('try again later', now, 'UTC')).toBeUndefined()
    expect(resetOf('billing problem: reset your payment method', now, 'UTC')).toBeUndefined()
    // each CLI's own run-out words name when it comes back, so its run-out carries a moment, not only words
    for (const [words, iso] of [
      ["You've hit your 5-hour limit · resets 2:10am", '2026-11-20T02:10:00.000Z'],
      ["You've hit your usage limit. Upgrade to Pro or try again at 5:00 PM.", '2026-11-19T17:00:00.000Z'],
      ['429 usage limit reached for this plan, resets 3pm', '2026-11-19T15:00:00.000Z'],
      ['RESOURCE_EXHAUSTED: Individual quota reached. Resets in 158h59m47s.', '2026-11-26T00:59:47.000Z'],
    ] as const) {
      expect([words, at(words)]).toEqual([words, iso])
    }
    // OpenCode's own words name no moment: its CLI says how long to wait instead (retryAfterMs, source.ts ranOut)
    expect(resetOf('Go usage limit exceeded', now, 'UTC')).toBeUndefined()
  })

  test("one response a content or safety filter refused is not a provider outage, in every CLI's own words", () => {
    const blocked = { passing: false, reason: "Response blocked by the provider's filter", blocked: true }
    // OpenCode: a `content-filter` finish with `provider.content-filter`
    expect(ending('opencode-content-filter-made')).toEqual(blocked)
    // Claude Code: a normal 200 with stop_reason "refusal" and stop_details (Anthropic's safety classifier)
    expect(ending('claude-refusal-made')).toEqual(blocked)
    // Codex: a policy error in codex_error_info, and a content_filter stop in its message
    expect(ending('codex-policy-made')).toEqual(blocked)
    expect(ending('codex-content-filter-made')).toEqual(blocked)
    // pi and agy have no refusal code of their own: the provider's words reach us in their error
    expect(ending('pi-content-filter-made')).toEqual(blocked)
    expect(ending('agy-safety-made')).toEqual(blocked)
    // a `content-filter` finish with no error object is still a filter, by its own words
    expect(providerError('content-filter')).toEqual(blocked)
    // a refusal that really is the provider's keeps its own words, and a filter is no run-out
    expect(providerError('bad request', 'invalid_request', 400)).toEqual({ passing: false, reason: 'Provider refused it' })
    expect(runOutOf("Response blocked by the provider's filter")).toBe(false)
  })

  test("every CLI's run-out keeps the reset its own log gives, so the wait says when it comes back", () => {
    // Claude Code's words (resets 5pm), Codex's (try again at 5:00 PM), pi's provider words (resets 3pm), agy's quota
    // (resets in 158h59m47s), and OpenCode's own retryAfterMs: each is a run-out, none is waited out
    for (const [name, reason] of [
      ['claude-usage-limit-made', 'Out of allowance until 5pm'],
      ['codex-usage-limit-made', 'Out of allowance until 5:00 PM'],
      ['pi-usage-limit-made', 'Out of allowance until 3pm'],
      ['agy-quota-made', 'Out of allowance until in 158h59m47s'],
      ['opencode-go-usage-limit-made', 'Out of allowance'],
    ] as const) {
      expect([name, ending(name)]).toEqual([name, { passing: false, reason }])
      expect(runOutOf(reason)).toBe(true)
    }
    // OpenCode's free models are the one that says how long to wait instead of when: the reset is now plus that
    expect(ending('opencode-free-limit-made').reason).toStartWith('Out of allowance until ')
  })

  test("a reset given as an ISO time is shown in this machine's time, with its zone name", () => {
    const iso = '2026-11-11T20:44:33Z'
    const shown = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso))
    expect(providerError(`Command Code: out of credit, resets at ${iso}`, '', 402)).toEqual({ passing: false, reason: `Out of credit until ${shown}` })
    expect(resetOf(`Limit reached. resets at ${iso}.`)).toEqual({ when: shown, at: Date.parse(iso) })
    // with milliseconds and an offset
    expect(resetOf('resets 2026-11-11T17:44:33.250-03:00')?.at).toBe(Date.parse('2026-11-11T17:44:33.250-03:00'))
    // what is not an ISO time stays as the provider wrote it, with the moment it names read too (below)
    expect(resetOf('resets 5pm (Europe/Oslo)')).toEqual({ when: '5pm', at: expect.any(Number) })
    expect(resetOf('try again at 5:00 PM')).toEqual({ when: '5:00 PM', at: expect.any(Number) })
    expect(resetOf('nothing about a time')).toBeUndefined()
    expect(runOutOf('Out of credit until 5pm')).toBe(true)
    expect(runOutOf('Out of allowance')).toBe(true)
    expect(runOutOf('Provider refused it')).toBe(false)
  })
})

describe('waits and tries', () => {
  const cut = (id: string, text = 'API Error: 529 Overloaded', status = 529) => ({ id, at: Date.now(), text, status })
  const world = (waits = [30, 60, 90, 120]) => {
    const nudged: string[] = []
    const over: { key: string; reason: string }[] = []
    const r = new Retries({ nudge: (key, text) => nudged.push(`${key} ${text}`), over: (key, x) => over.push({ key, reason: x.reason }), changed: () => undefined }, waits)
    return { r, nudged, over }
  }
  /** a wait is over: however slow the machine, its timer has fired */
  const until = async (f: () => boolean) => {
    for (const t0 = Date.now(); !f(); await Bun.sleep(5)) if (Date.now() - t0 > 8000) throw new Error('timed out')
  }

  test('told to carry on after each wait; still cut off after the last try, it gives up', async () => {
    const w = world()
    w.r.seen('A', cut('e1'))
    expect(w.r.get('A')).toMatchObject({ tries: 1, reason: 'Provider overloaded' })
    // the same cut-off turn seen again changes nothing
    w.r.seen('A', cut('e1'))
    expect(w.r.get('A')!.tries).toBe(1)
    await until(() => w.nudged.length > 0)
    expect(w.nudged).toEqual([`A ${carryOn('Provider overloaded')}`])
    expect(w.nudged[0]).toContain('Carry on where you left off.')
    for (const id of ['e2', 'e3', 'e4']) w.r.seen('A', cut(id))
    expect(w.r.get('A')).toMatchObject({ tries: 4 })
    expect(w.over).toEqual([])
    w.r.seen('A', cut('e5'))
    expect(w.over).toEqual([{ key: 'A', reason: 'Provider overloaded, still after 5 tries' }])
    expect(w.r.get('A')).toMatchObject({ over: true })
    expect(w.r.get('A')!.due).toBeUndefined()
  })

  test('a turn that ends well, or a message that goes in, starts the count again', async () => {
    const w = world()
    w.r.seen('B', cut('e1'))
    await until(() => w.nudged.length > 0)
    // the turn it was told to carry on in ended well
    w.r.seen('B', undefined)
    expect(w.r.get('B')).toBeUndefined()
    // waiting, a message of yours goes in: no try is due any more
    w.r.seen('B', cut('e2'))
    w.r.clear('B')
    await Bun.sleep(50)
    expect(w.nudged).toHaveLength(1)
    expect(w.r.get('B')).toBeUndefined()
    // waiting, it went on by itself and that turn ended well (a job woke it, you typed in its terminal): never told
    w.r.seen('B', cut('e3'))
    w.r.seen('B', undefined)
    await Bun.sleep(50)
    expect(w.nudged).toHaveLength(1)
    expect(w.r.get('B')).toBeUndefined()
  })

  test('an error waiting cannot fix gives up at once', () => {
    const w = world()
    w.r.seen('C', cut('e1', "You've hit your session limit · resets 5pm", 429))
    expect(w.over).toEqual([{ key: 'C', reason: 'Out of allowance until 5pm' }])
  })

  test('a run-out is told once, with the cut it came from; a refusal is not one', () => {
    const runs: { key: string; id: string; reason: string }[] = []
    const r = new Retries({ nudge: () => undefined, over: () => undefined, changed: () => undefined, runOut: (key, c, reason) => runs.push({ key, id: c.id, reason }) }, WAITS)
    r.seen('D', cut('e1', 'Insufficient account funds', 402))
    r.seen('D', cut('e1', 'Insufficient account funds', 402))
    r.seen('E', cut('e2', 'bad request', 400))
    expect(runs).toEqual([{ key: 'D', id: 'e1', reason: 'Out of credit' }])
    r.stop()
  })

  test('a phrased 5-hour limit is a run-out at the first cut: no try is waited out (POL-452)', () => {
    const nudged: string[] = []
    const over: { key: string; reason: string }[] = []
    const runs: { key: string; id: string; reason: string }[] = []
    const r = new Retries(
      {
        nudge: (k, t) => nudged.push(`${k} ${t}`),
        over: (k, x) => over.push({ key: k, reason: x.reason }),
        changed: () => undefined,
        runOut: (key, c, reason) => runs.push({ key, id: c.id, reason }),
      },
      [30, 60, 90, 120],
    )
    // Claude Code's StopFailure: code rate_limit, 429, and the 5-hour limit in its words, hyphen and all
    r.seen('H', { id: 'e1', at: Date.now(), text: "You've hit your 5-hour limit · resets 2:10am", code: 'rate_limit', status: 429 })
    expect(over).toEqual([{ key: 'H', reason: 'Out of allowance until 2:10am' }])
    expect(r.get('H')).toMatchObject({ over: true, lasting: true, tries: 1 })
    // nothing is waited out, and the run-out reaches the usage ledger with the cut it came from
    expect(nudged).toEqual([])
    expect(r.get('H')?.due).toBeUndefined()
    expect(runs).toEqual([{ key: 'H', id: 'e1', reason: 'Out of allowance until 2:10am' }])
    r.stop()
  })

  test("OpenCode's free models: a cut with its retryAfterMs gives up at once, with the reset it named", () => {
    const w = world()
    const at = Date.now()
    w.r.seen('G', { id: 'e1', at, text: 'Free usage limit reached.', code: 'provider.free-limit', status: 429, retryAfterMs: 2_447_000 })
    const shown = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(at + 2_447_000))
    expect(w.over).toEqual([{ key: 'G', reason: `Out of allowance until ${shown}` }])
    expect(w.r.get('G')).toMatchObject({ over: true, lasting: true, tries: 1 })
    // nothing is waited out: no nudge, no due time
    expect(w.nudged).toEqual([])
    w.r.stop()
  })

  test('a filter refusal hands only this chat to its backup: no wait, no outage to watch', () => {
    const runs: string[] = []
    const over: { cut: string; tries: number; reason: string; words: string; over?: boolean; lasting?: boolean; blocked?: boolean }[] = []
    const r = new Retries(
      {
        nudge: () => undefined,
        over: (_k: string, x: { cut: string; tries: number; reason: string; words: string; over?: boolean; lasting?: boolean; blocked?: boolean }) => {
          over.push(x)
        },
        changed: () => undefined,
        runOut: (k) => runs.push(k),
      },
      WAITS,
    )
    r.seen('F', { id: 'e1', at: Date.now(), text: 'Provider blocked the response', code: 'provider.content-filter' })
    expect(over).toEqual([{ cut: 'e1', tries: 1, reason: "Response blocked by the provider's filter", words: 'Provider blocked the response', over: true, blocked: true }])
    expect(over[0].lasting).toBeUndefined()
    expect(r.get('F')!.due).toBeUndefined()
    expect(runs).toEqual([])
    r.stop()
  })
})
