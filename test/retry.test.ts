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
  return providerError(e.text, e.code, e.status)
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
    expect(providerError('Blocked by content filter', 'provider.content-filter')).toEqual({ passing: false, reason: "Response blocked by the provider's filter", blocked: true })
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

  test('a reset given as an ISO time is shown in this machine\'s time, with its zone name', () => {
    const iso = '2026-11-11T20:44:33Z'
    const shown = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso))
    expect(providerError(`Command Code: out of credit, resets at ${iso}`, '', 402)).toEqual({ passing: false, reason: `Out of credit until ${shown}` })
    expect(resetOf(`Limit reached. resets at ${iso}.`)).toEqual({ when: shown, at: Date.parse(iso) })
    // with milliseconds and an offset
    expect(resetOf('resets 2026-11-11T17:44:33.250-03:00')?.at).toBe(Date.parse('2026-11-11T17:44:33.250-03:00'))
    // what is not an ISO time stays as the provider wrote it
    expect(resetOf('resets 5pm (Europe/Oslo)')).toEqual({ when: '5pm' })
    expect(resetOf('try again at 5:00 PM')).toEqual({ when: '5:00 PM' })
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

  test('a filter refusal hands only this chat to its backup: no wait, no outage to watch', () => {
    const runs: string[] = []
    const over: { cut: string; tries: number; reason: string; words: string; over?: boolean; lasting?: boolean; blocked?: boolean }[] = []
    const r = new Retries({ nudge: () => undefined, over: (_k: string, x: { cut: string; tries: number; reason: string; words: string; over?: boolean; lasting?: boolean; blocked?: boolean }) => { over.push(x) }, changed: () => undefined, runOut: (k) => runs.push(k) }, WAITS)
    r.seen('F', { id: 'e1', at: Date.now(), text: 'Provider blocked the response', code: 'provider.content-filter' })
    expect(over).toEqual([{ cut: 'e1', tries: 1, reason: "Response blocked by the provider's filter", words: 'Provider blocked the response', over: true, blocked: true }])
    expect(over[0].lasting).toBeUndefined()
    expect(r.get('F')!.due).toBeUndefined()
    expect(runs).toEqual([])
    r.stop()
  })
})
