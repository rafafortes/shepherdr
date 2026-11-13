// The usage ledger: a model call counted once per chat (dedupe across re-reads and resumed sessions), bucketed by the
// hour, the windows of 5 h, 24 h and 7 d, pruned past its 35 days, kept in usage.json across a restart, the backfill
// marked done once, and a provider's run-outs: out right now, or back, by a reset, a return or a later call.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { HOUR, KEEP_RUNOUTS, KEEP_USAGE, modelKey, modelOf, outState, providerOf, UsageLedger, type RunOut } from '../server/live/usage-ledger.ts'

// every time is read from the clock, so the windows are the same whenever the suite runs
const NOW = Date.now()
const ago = (h: number) => NOW - h * HOUR
const call = (id: string, h: number, tokens = 100, cost?: number) => ({ id, at: ago(h) + 1000, tokens, ...(cost !== undefined ? { cost } : {}) })
const runOut = (chat: string, h: number, extra: Partial<RunOut> = {}): RunOut => ({ at: ago(h), key: 'opencode-go/deepseek-v4.1-flash', chat, role: 'task', reason: 'Out of allowance', words: 'x', ...extra })

describe('the provider and the model of a call', () => {
  test('a pi model keeps its provider in front; Claude Code is Anthropic, Codex OpenAI', () => {
    expect(modelKey('pi', 'opencode-go/deepseek-v4.1-flash')).toBe('opencode-go/deepseek-v4.1-flash')
    expect(modelKey('pi', 'commandcode/deepseek/deepseek-v4.1-flash')).toBe('commandcode/deepseek/deepseek-v4.1-flash')
    expect(modelKey('pi', 'qwen3')).toBe('pi/qwen3')
    expect(modelKey('claude', 'claude-opus-5-5')).toBe('anthropic/claude-opus-5-5')
    expect(modelKey('codex', 'gpt-6-sol')).toBe('openai/gpt-6-sol')
    expect(modelKey('claude', undefined)).toBe('anthropic/unknown')
    expect(modelKey('claude', 'default')).toBe('anthropic/unknown')
    expect(modelKey('someother', 'x')).toBe('someother/x')
    expect(providerOf('commandcode/deepseek/deepseek-v4.1-flash')).toBe('commandcode')
    expect(providerOf('spark/qwen3.8-flash-next-mlx4-mtp-tensorfold')).toBe('spark')
    expect(modelOf('commandcode/deepseek/deepseek-v4.1-flash')).toBe('deepseek/deepseek-v4.1-flash')
    expect(modelOf('plain')).toBe('')
  })
})

describe('counting: once per call, in its hour', () => {
  test('a call is counted in its hour, with its cost when pi gave one; a call with no tokens is not', () => {
    const l = new UsageLedger(tmp('ledger-count'), true)
    expect(l.count('A/Agent', 'spark/q', call('m1', 2, 300, 0.5), NOW)).toBe(true)
    expect(l.count('A/Agent', 'spark/q', call('m2', 2, 200), NOW)).toBe(true)
    expect(l.count('A/Agent', 'spark/q', call('m3', 2, 0), NOW)).toBe(false)
    const t = l.byKey(ago(5)).get('spark/q')!
    expect(t).toEqual({ tokens: 500, calls: 2, cost: 0.5 })
  })

  test('the same call id in the same chat is counted once, however often it is read', () => {
    const l = new UsageLedger(tmp('ledger-dedupe'), true)
    for (let i = 0; i < 3; i++) l.count('A/Agent', 'anthropic/claude-opus-5-5', call('msg_1', 1, 122), NOW)
    expect(l.byKey(ago(5)).get('anthropic/claude-opus-5-5')).toEqual({ tokens: 122, calls: 1 })
  })

  test('a resumed session copies the calls before it into its new file: counted once in the chat, but a call of another chat is its own', () => {
    const l = new UsageLedger(tmp('ledger-resume'), true)
    l.count('A/Agent', 'anthropic/claude-opus-5-5', call('msg_old', 3, 1000), NOW)
    // the same call, copied into the resumed file of the same chat
    expect(l.count('A/Agent', 'anthropic/claude-opus-5-5', call('msg_old', 3, 1000), NOW)).toBe(false)
    // another chat that logged the same id (not a copy of this chat's): counted there
    expect(l.count('B/Agent', 'anthropic/claude-opus-5-5', call('msg_old', 3, 1000), NOW)).toBe(true)
    expect(l.byKey(ago(5)).get('anthropic/claude-opus-5-5')!.calls).toBe(2)
  })

  test('calls older than the 35 days are not counted at all', () => {
    const l = new UsageLedger(tmp('ledger-old'), true)
    expect(l.count('A/Agent', 'spark/q', { id: 'old', at: NOW - KEEP_USAGE - HOUR, tokens: 9 }, NOW)).toBe(false)
    expect(l.byKey(0).size).toBe(0)
  })
})

describe('windows: the last 5 h, 24 h and 7 d, by whole hours', () => {
  test('a call counts in every window that reaches its hour', () => {
    const l = new UsageLedger(tmp('ledger-windows'), true)
    l.count('A/Agent', 'k/m', call('a', 1, 10), NOW)
    l.count('A/Agent', 'k/m', call('b', 10, 20), NOW)
    l.count('A/Agent', 'k/m', call('c', 100, 40), NOW)
    l.count('A/Agent', 'k/m', call('d', 200, 80), NOW)
    expect(l.byKey(NOW - 5 * HOUR).get('k/m')!.tokens).toBe(10)
    expect(l.byKey(NOW - 24 * HOUR).get('k/m')!.tokens).toBe(30)
    expect(l.byKey(NOW - 7 * 24 * HOUR).get('k/m')!.tokens).toBe(70)
    expect(l.byKey(NOW - 7 * 24 * HOUR).get('k/m')!.calls).toBe(3)
  })

  test('sum adds the models of a provider; a provider with no calls in the window is not listed', () => {
    const l = new UsageLedger(tmp('ledger-sum'), true)
    l.count('A/Agent', 'opencode-go/a', call('1', 2, 5, 0.1), NOW)
    l.count('A/Agent', 'opencode-go/b', call('2', 2, 7), NOW)
    l.count('A/Agent', 'spark/q', call('3', 50, 9), NOW)
    const go = [...l.byKey(ago(5))].filter(([k]) => providerOf(k) === 'opencode-go').map(([, t]) => t)
    expect(l.sum(go)).toEqual({ tokens: 12, calls: 2, cost: 0.1 })
    expect(l.sum([])).toEqual({ tokens: 0, calls: 0 })
    expect([...l.byKey(ago(5)).keys()]).toEqual(['opencode-go/a', 'opencode-go/b'])
  })
})

describe('the file: kept across a restart, pruned, the backfill once', () => {
  test('what was counted is in usage.json: a new ledger on the same folder has it and counts nothing twice', () => {
    const dir = tmp('ledger-file')
    const a = new UsageLedger(dir)
    a.count('A/Agent', 'anthropic/claude-opus-5-5', call('msg_1', 2, 50, 0.02), NOW)
    a.setPosition('/logs/a.jsonl', { ino: 7, offset: 1234 })
    a.setQuota('anthropic', { windows: [{ name: 'Week', usedPct: 40 }], source: 'test', at: NOW })
    a.markBackfilled(NOW)
    a.flush(NOW)
    expect(existsSync(join(dir, 'usage.json'))).toBe(true)
    const b = new UsageLedger(dir)
    expect(b.count('A/Agent', 'anthropic/claude-opus-5-5', call('msg_1', 2, 50, 0.02), NOW)).toBe(false)
    expect(b.byKey(ago(5)).get('anthropic/claude-opus-5-5')).toEqual({ tokens: 50, calls: 1, cost: 0.02 })
    expect(b.position('/logs/a.jsonl')).toEqual({ ino: 7, offset: 1234 })
    expect(b.quota('anthropic')).toMatchObject({ source: 'test', windows: [{ name: 'Week', usedPct: 40 }] })
    expect(b.backfilled).toBe(NOW)
    expect(JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')).usage).toBeDefined()
  })

  test('the backfill is marked once: a second mark keeps the first time', () => {
    const l = new UsageLedger(tmp('ledger-backfill'), true)
    expect(l.backfilled).toBeUndefined()
    l.markBackfilled(1000)
    l.markBackfilled(2000)
    expect(l.backfilled).toBe(1000)
  })

  test('pruning drops the hours and the ids past 35 days, and the run-outs past 60 days', () => {
    const l = new UsageLedger(tmp('ledger-prune'))
    const DAY = 24 * HOUR
    l.count('A/Agent', 'spark/q', { id: 'ok', at: NOW - 30 * DAY, tokens: 5 }, NOW)
    l.count('A/Agent', 'spark/old', { id: 'old', at: NOW - 34 * DAY, tokens: 5 }, NOW)
    l.runOut(runOut('A/Agent', 20 * 24, { key: 'spark/q', reason: 'Out of credit' }), NOW)
    l.runOut(runOut('A/Agent', 50 * 24, { key: 'spark/q', reason: 'Out of allowance' }), NOW)
    l.prune(NOW)
    expect([...l.byKey(0).keys()].sort()).toEqual(['spark/old', 'spark/q'])
    // two days later the 34-day-old call is past the 35 days; the 30-day-old one is not
    l.prune(NOW + 2 * DAY)
    expect([...l.byKey(0).keys()]).toEqual(['spark/q'])
    // and its id goes with it: the same call read again would count (it is no longer in the window's ids)
    expect(l.count('A/Agent', 'spark/old', { id: 'old', at: NOW - 34 * DAY, tokens: 5 }, NOW + 2 * DAY)).toBe(false)
    // eleven days later the run-out of 50 days is past its 60 days' keep; the one of 20 days is not
    l.prune(NOW + 11 * DAY)
    expect(l.runOuts(() => true).map((r) => r.reason)).toEqual(['Out of credit'])
    expect(KEEP_RUNOUTS).toBeGreaterThan(KEEP_USAGE)
  })

  test('the positions of logs no record names any more are forgotten', () => {
    const l = new UsageLedger(tmp('ledger-files'), true)
    l.setPosition('/logs/a.jsonl', { ino: 1, offset: 10 })
    l.setPosition('/logs/b.jsonl', { ino: 2, offset: 20 })
    l.keepFiles(new Set(['/logs/a.jsonl']))
    expect(l.position('/logs/a.jsonl')).toEqual({ ino: 1, offset: 10 })
    expect(l.position('/logs/b.jsonl')).toBeUndefined()
    l.keepFiles(new Set(['/logs/a.jsonl']))
  })

  test('a memory ledger writes nothing; a flush with nothing changed writes nothing either', () => {
    const dir = tmp('ledger-nothing')
    const m = new UsageLedger(dir, true)
    m.count('A/Agent', 'spark/q', call('x', 1), NOW)
    m.flush()
    expect(existsSync(join(dir, 'usage.json'))).toBe(false)
    const d = new UsageLedger(dir)
    d.flush()
    expect(existsSync(join(dir, 'usage.json'))).toBe(false)
  })

  test('a change waits for its save; stop writes it now', () => {
    const dir = tmp('ledger-timer')
    const d = new UsageLedger(dir)
    d.count('A/Agent', 'spark/q', call('t1', 1), NOW)
    expect(existsSync(join(dir, 'usage.json'))).toBe(false)
    d.stop()
    expect(existsSync(join(dir, 'usage.json'))).toBe(true)
  })
})

describe('run-outs: recorded once, and out until a reset, a return or a later call', () => {
  test('the first run-out of a provider says it was not out before; a second one while it is out says it was', () => {
    const l = new UsageLedger(tmp('ledger-runout'), true)
    expect(l.runOut(runOut('A/Agent', 5), NOW)).toEqual({ wasOut: false, added: true })
    expect(l.runOut(runOut('B/Agent', 4), NOW)).toEqual({ wasOut: true, added: true })
    // the same chat's same time: kept once
    expect(l.runOut(runOut('B/Agent', 4), NOW)).toEqual({ wasOut: true, added: false })
    expect(l.runOuts((k) => k.startsWith('opencode-go/')).length).toBe(2)
  })

  test('a reset in the future keeps it out; one in the past does not', () => {
    const l = new UsageLedger(tmp('ledger-reset'), true)
    l.runOut(runOut('A/Agent', 2, { reset: '11 Nov, 17:44 GMT-3', resetAt: NOW + 3 * HOUR }), NOW)
    expect(l.outOf('opencode-go', NOW)).toMatchObject({ out: true })
    expect(l.outOf('opencode-go', NOW + 4 * HOUR)).toMatchObject({ out: false })
    expect(l.outOf('spark', NOW)).toEqual({ out: false })
  })

  test('with no reset: out until the return watch says the primary is back, or a call of it goes through after the run-out', () => {
    const l = new UsageLedger(tmp('ledger-until'), true)
    l.runOut(runOut('A/Agent', 3), NOW)
    expect(l.outOf('opencode-go', NOW).out).toBe(true)
    // the return watch found the primary back after the run-out
    expect(l.outOf('opencode-go', NOW, ago(1)).out).toBe(false)
    // a call of the same model in a later hour answers too
    l.count('B/Agent', 'opencode-go/deepseek-v4.1-flash', call('later', 1), NOW)
    expect(l.outOf('opencode-go', NOW).out).toBe(false)
  })

  test('a call of another model of the provider answers for the provider, not for the model that ran out', () => {
    const l = new UsageLedger(tmp('ledger-model'), true)
    l.runOut(runOut('A/Agent', 3), NOW)
    l.count('B/Agent', 'opencode-go/other', call('o1', 1), NOW)
    expect(l.outOf('opencode-go', NOW).out).toBe(false)
    expect(l.outOf('opencode-go', NOW, undefined, 'opencode-go/deepseek-v4.1-flash').out).toBe(true)
  })

  test('outState: the last run-out decides, and a reset that has passed does not keep it out', () => {
    const r1 = runOut('A/Agent', 9)
    const r2 = runOut('A/Agent', 2, { resetAt: NOW - HOUR })
    expect(outState([], () => false, NOW)).toEqual({ out: false })
    expect(outState([r1, r2], () => false, NOW).last).toBe(r2)
    // the reset passed: not out, though the return watch has nothing
    expect(outState([r2], () => false, NOW).out).toBe(false)
    // no reset, no return, no call after: out
    expect(outState([r1], () => false, NOW).out).toBe(true)
    expect(outState([r1], () => true, NOW).out).toBe(false)
  })
})

describe('quota figures: set by a read, cleared', () => {
  test('a provider has none until one is set; clearing it takes it away', () => {
    const l = new UsageLedger(tmp('ledger-quota'), true)
    expect(l.quota('anthropic')).toBeUndefined()
    l.setQuota('anthropic', { windows: [{ name: '5 h', usedPct: 12, resetAt: NOW + HOUR }], source: 'claude /usage', at: NOW, estimate: true })
    expect(l.quota('anthropic')?.windows[0]).toMatchObject({ usedPct: 12 })
    l.setQuota('anthropic', undefined)
    expect(l.quota('anthropic')).toBeUndefined()
  })
})
