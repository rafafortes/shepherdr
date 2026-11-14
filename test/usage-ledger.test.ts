// The usage ledger: a model call counted once per chat (dedupe across re-reads and resumed sessions), bucketed by the
// hour, the windows of 5 h, 24 h and 7 d, pruned past its 35 days, kept in usage.json across a restart, the backfill
// marked done once, and a provider's run-outs: out right now, or back, by a reset, a return or a later call.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { HOUR, harnessOf, KEEP_RUNOUTS, KEEP_USAGE, modelKey, modelOf, outState, providerOf, providerPart, rekey, UsageLedger, VERSION, type RunOut } from '../server/live/usage-ledger.ts'

// every time is read from the clock, so the windows are the same whenever the suite runs
const NOW = Date.now()
const ago = (h: number) => NOW - h * HOUR
const call = (id: string, h: number, tokens = 100, cost?: number) => ({ id, at: ago(h) + 1000, tokens, ...(cost !== undefined ? { cost } : {}) })
const runOut = (chat: string, h: number, extra: Partial<RunOut> = {}): RunOut => ({ at: ago(h), key: 'pi.opencode-go/deepseek-v4.1-flash', chat, role: 'task', reason: 'Out of allowance', words: 'x', ...extra })

describe('the provider and the model of a call', () => {
  test('a single-account CLI is its own provider: Claude Code, Codex and agy each keep their own rows', () => {
    expect(modelKey('claude', 'claude-opus-5-5')).toBe('claude/claude-opus-5-5')
    expect(modelKey('codex', 'gpt-6-sol')).toBe('codex/gpt-6-sol')
    expect(modelKey('agy', 'gemini-3.8-flash-low')).toBe('agy/gemini-3.8-flash')
    expect(modelKey('claude-code', 'claude-opus-5-5')).toBe('claude/claude-opus-5-5')
    expect(modelKey('claude', undefined)).toBe('claude/unknown')
    expect(modelKey('claude', 'default')).toBe('claude/unknown')
    expect(modelKey('someother', 'x')).toBe('someother/x')
  })

  test('pi and OpenCode are harness.provider/model: their model ids name the provider already', () => {
    expect(modelKey('pi', 'opencode-go/deepseek-v4.1-flash')).toBe('pi.opencode-go/deepseek-v4.1-flash')
    expect(modelKey('pi', 'commandcode/deepseek/deepseek-v4.1-flash')).toBe('pi.commandcode/deepseek/deepseek-v4.1-flash')
    expect(modelKey('pi', 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold')).toBe('pi.spark/qwen3.8-flash-next-mlx4-mtp-tensorfold')
    expect(modelKey('pi', 'qwen3')).toBe('pi/qwen3')
    expect(modelKey('pi', undefined)).toBe('pi/unknown')
    // OpenCode's models keep their provider, slashes and all; a bare one gets the CLI's name in front
    expect(modelKey('opencode', 'opencode/minimax-m3.1-flash-free')).toBe('opencode.opencode/minimax-m3.1-flash-free')
    expect(modelKey('opencode', 'nvidia/z-ai/glm-5.3-flash')).toBe('opencode.nvidia/z-ai/glm-5.3-flash')
    expect(modelKey('opencode', 'bare')).toBe('opencode/bare')
    expect(modelKey('opencode', undefined)).toBe('opencode/unknown')
    expect(providerOf('commandcode/deepseek/deepseek-v4.1-flash')).toBe('commandcode')
    expect(providerOf('pi.spark/qwen3.8-flash-next-mlx4-mtp-tensorfold')).toBe('pi.spark')
    expect(providerOf('claude/claude-opus-5-5')).toBe('claude')
    expect(modelOf('pi.commandcode/deepseek/deepseek-v4.1-flash')).toBe('deepseek/deepseek-v4.1-flash')
    expect(modelOf('plain')).toBe('')
  })

  test('the harness and the provider part of a provider key', () => {
    expect(harnessOf('pi.spark')).toBe('pi')
    expect(providerPart('pi.spark')).toBe('spark')
    expect(harnessOf('opencode.opencode-go')).toBe('opencode')
    expect(providerPart('opencode.opencode-go')).toBe('opencode-go')
    expect(harnessOf('claude')).toBe('claude')
    expect(providerPart('claude')).toBe('claude')
  })

  test('a key from before the harness prefix is written as its chat’s CLI writes it now', () => {
    expect(rekey('claude/claude-opus-5-5', 'claude')).toBe('claude/claude-opus-5-5')
    expect(rekey('openai/gpt-6-sol', 'codex')).toBe('codex/gpt-6-sol')
    expect(rekey('anthropic/unknown', 'claude')).toBe('claude/unknown')
    expect(rekey('spark/qwen', 'pi')).toBe('pi.spark/qwen')
    expect(rekey('anthropic/claude-opus-5-5', 'pi')).toBe('pi.anthropic/claude-opus-5-5')
    expect(rekey('pi/unknown', 'pi')).toBe('pi/unknown')
    expect(rekey('opencode-go/deepseek', 'opencode')).toBe('opencode.opencode-go/deepseek')
    expect(rekey('opencode/minimax-m3', 'opencode')).toBe('opencode.opencode/minimax-m3')
    expect(rekey('opencode/unknown', 'opencode')).toBe('opencode/unknown')
    expect(rekey('agy/gemini-3.8-flash', 'agy')).toBe('agy/gemini-3.8-flash')
    // the old key's own provider decides where it can, whatever the chat runs now: agy's stayed agy's, OpenCode's Zen
    // (opencode/…) stays OpenCode's (both seen on the live data: chats that moved to pi after these cut-offs)
    expect(rekey('agy/claude-sonnet-5-5', 'pi')).toBe('agy/claude-sonnet-5-5')
    expect(rekey('opencode/deepseek-v4.1-flash-free', 'pi')).toBe('opencode.opencode/deepseek-v4.1-flash-free')
    // what the key leaves open is the chat's CLI: Anthropic's models by pi's key, OpenCode Go by OpenCode's
    expect(rekey('anthropic/claude-opus-5-5', 'opencode')).toBe('opencode.anthropic/claude-opus-5-5')
    expect(rekey('openai/gpt-6-sol', 'pi')).toBe('pi.openai/gpt-6-sol')
    expect(rekey('opencode-go/deepseek', 'pi')).toBe('pi.opencode-go/deepseek')
    // a chat with no record (or another CLI): Anthropic's is Claude Code's, OpenAI's Codex's, any other pi's
    expect(rekey('anthropic/claude-opus-5-5')).toBe('claude/claude-opus-5-5')
    expect(rekey('openai/gpt-6-sol', 'claude')).toBe('codex/gpt-6-sol')
    expect(rekey('commandcode/deepseek/x')).toBe('pi.commandcode/deepseek/x')
    // a key in the harness form already stays
    expect(rekey('pi.spark/qwen', 'opencode')).toBe('pi.spark/qwen')
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
    for (let i = 0; i < 3; i++) l.count('A/Agent', 'claude/claude-opus-5-5', call('msg_1', 1, 122), NOW)
    expect(l.byKey(ago(5)).get('claude/claude-opus-5-5')).toEqual({ tokens: 122, calls: 1 })
  })

  test('a resumed session copies the calls before it into its new file: counted once in the chat, but a call of another chat is its own', () => {
    const l = new UsageLedger(tmp('ledger-resume'), true)
    l.count('A/Agent', 'claude/claude-opus-5-5', call('msg_old', 3, 1000), NOW)
    // the same call, copied into the resumed file of the same chat
    expect(l.count('A/Agent', 'claude/claude-opus-5-5', call('msg_old', 3, 1000), NOW)).toBe(false)
    // another chat that logged the same id (not a copy of this chat's): counted there
    expect(l.count('B/Agent', 'claude/claude-opus-5-5', call('msg_old', 3, 1000), NOW)).toBe(true)
    expect(l.byKey(ago(5)).get('claude/claude-opus-5-5')!.calls).toBe(2)
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
    l.count('A/Agent', 'pi.opencode-go/a', call('1', 2, 5, 0.1), NOW)
    l.count('A/Agent', 'pi.opencode-go/b', call('2', 2, 7), NOW)
    l.count('A/Agent', 'spark/q', call('3', 50, 9), NOW)
    const go = [...l.byKey(ago(5))].filter(([k]) => providerOf(k) === 'pi.opencode-go').map(([, t]) => t)
    expect(l.sum(go)).toEqual({ tokens: 12, calls: 2, cost: 0.1 })
    expect(l.sum([])).toEqual({ tokens: 0, calls: 0 })
    expect([...l.byKey(ago(5)).keys()]).toEqual(['pi.opencode-go/a', 'pi.opencode-go/b'])
  })
})

describe('the file: kept across a restart, pruned, the backfill once', () => {
  test('what was counted is in usage.json: a new ledger on the same folder has it and counts nothing twice', () => {
    const dir = tmp('ledger-file')
    const a = new UsageLedger(dir)
    a.count('A/Agent', 'claude/claude-opus-5-5', call('msg_1', 2, 50, 0.02), NOW)
    a.setPosition('/logs/a.jsonl', { ino: 7, offset: 1234 })
    a.setQuota('claude', { windows: [{ name: 'Week', usedPct: 40 }], source: 'test', at: NOW })
    a.markBackfilled(NOW)
    a.flush(NOW)
    expect(existsSync(join(dir, 'usage.json'))).toBe(true)
    const b = new UsageLedger(dir)
    expect(b.count('A/Agent', 'claude/claude-opus-5-5', call('msg_1', 2, 50, 0.02), NOW)).toBe(false)
    expect(b.byKey(ago(5)).get('claude/claude-opus-5-5')).toEqual({ tokens: 50, calls: 1, cost: 0.02 })
    expect(b.position('/logs/a.jsonl')).toEqual({ ino: 7, offset: 1234 })
    expect(b.quota('claude')).toMatchObject({ source: 'test', windows: [{ name: 'Week', usedPct: 40 }] })
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
    expect(l.runOuts((k) => k.startsWith('pi.opencode-go/')).length).toBe(2)
  })

  test('a reset in the future keeps it out; one in the past does not', () => {
    const l = new UsageLedger(tmp('ledger-reset'), true)
    l.runOut(runOut('A/Agent', 2, { reset: '11 Nov, 17:44 GMT-3', resetAt: NOW + 3 * HOUR }), NOW)
    expect(l.outOf('pi.opencode-go', NOW)).toMatchObject({ out: true })
    expect(l.outOf('pi.opencode-go', NOW + 4 * HOUR)).toMatchObject({ out: false })
    expect(l.outOf('spark', NOW)).toEqual({ out: false })
  })

  test('with no reset: out until the return watch says the primary is back, or a call of it goes through after the run-out', () => {
    const l = new UsageLedger(tmp('ledger-until'), true)
    l.runOut(runOut('A/Agent', 3), NOW)
    expect(l.outOf('pi.opencode-go', NOW).out).toBe(true)
    // the return watch found the primary back after the run-out
    expect(l.outOf('pi.opencode-go', NOW, ago(1)).out).toBe(false)
    // a call of the same model in a later hour answers too
    l.count('B/Agent', 'pi.opencode-go/deepseek-v4.1-flash', call('later', 1), NOW)
    expect(l.outOf('pi.opencode-go', NOW).out).toBe(false)
  })

  test('a call of another model of the provider answers for the provider, not for the model that ran out', () => {
    const l = new UsageLedger(tmp('ledger-model'), true)
    l.runOut(runOut('A/Agent', 3), NOW)
    l.count('B/Agent', 'pi.opencode-go/other', call('o1', 1), NOW)
    expect(l.outOf('pi.opencode-go', NOW).out).toBe(false)
    expect(l.outOf('pi.opencode-go', NOW, undefined, 'pi.opencode-go/deepseek-v4.1-flash').out).toBe(true)
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
    expect(l.quota('claude')).toBeUndefined()
    l.setQuota('claude', { windows: [{ name: '5 h', usedPct: 12, resetAt: NOW + HOUR }], source: 'claude /usage', at: NOW, estimate: true })
    expect(l.quota('claude')?.windows[0]).toMatchObject({ usedPct: 12 })
    l.setQuota('claude', undefined)
    expect(l.quota('claude')).toBeUndefined()
  })
})

describe('a usage.json from before the harness keys', () => {
  const write = (dir: string, data: unknown) => writeFileSync(join(dir, 'usage.json'), JSON.stringify(data))
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8'))
  const figure = { windows: [{ name: 'Week', usedPct: 40 }], source: 'test', at: NOW }

  test('its counts, ids and log positions are emptied, so the logs are read again; its quotas and alerts take the new names', () => {
    const dir = tmp('ledger-v1-counts')
    write(dir, {
      usage: { 'anthropic/claude-opus-5-5': { [Math.floor(NOW / HOUR)]: { tokens: 5, calls: 1 } } },
      seen: { 'A/Agent': { m1: 1 } },
      runOuts: [],
      quotas: { anthropic: figure, commandcode: figure },
      alerts: { 'anthropic|5 h': NOW, 'opencode-go|Week': 0, 'spark|Week': 0 },
      files: { 'f.jsonl': { ino: 1, offset: 9 } },
      backfilled: 5,
    })
    const l = new UsageLedger(dir)
    expect(l.byKey(0).size).toBe(0)
    expect(l.position('f.jsonl')).toBeUndefined()
    expect(l.backfilled).toBeUndefined()
    expect(l.quota('claude')).toEqual(figure)
    expect(l.quota('pi.commandcode')).toEqual(figure)
    expect(l.quota('anthropic')).toBeUndefined()
    expect(l.alerted('claude|5 h')).toBe(NOW)
    expect(l.alerted('opencode.opencode-go|Week')).toBe(0)
    expect(l.alerted('spark|Week')).toBe(0)
    l.stop()
    // the version is set by migrateRunOuts, after the run-outs are re-keyed: until then the file is still version 1
    expect(read(dir).version).toBeUndefined()
  })

  test('its run-outs are re-keyed as their chat’s CLI writes them, once; a chat with no record takes the old provider’s CLI', () => {
    const dir = tmp('ledger-v1-runs')
    const run = (key: string, chat: string, h: number) => ({ at: NOW - h * HOUR, key, chat, role: 'task', reason: 'Out of allowance', words: 'x' })
    write(dir, { usage: {}, seen: {}, files: {}, quotas: {}, alerts: {}, runOuts: [run('anthropic/claude-opus-5-5', 'A/Agent', 2), run('spark/qwen', 'Gone/Agent', 3)] })
    const l = new UsageLedger(dir)
    expect(l.runOuts(() => true).map((r) => r.key)).toEqual(['spark/qwen', 'anthropic/claude-opus-5-5'])
    l.migrateRunOuts((chat) => (chat === 'A/Agent' ? 'claude' : undefined))
    expect(l.runOuts(() => true).map((r) => r.key)).toEqual(['pi.spark/qwen', 'claude/claude-opus-5-5'])
    // a second pass changes nothing: the file is version 2 now
    l.migrateRunOuts(() => 'codex')
    expect(l.runOuts(() => true).map((r) => r.key)).toEqual(['pi.spark/qwen', 'claude/claude-opus-5-5'])
    l.stop()
    expect(read(dir)).toMatchObject({ version: VERSION, runOuts: [{ key: 'claude/claude-opus-5-5' }, { key: 'pi.spark/qwen' }] })
  })

  test('a file that is version 2 keeps its counts and positions, and a new one starts at version 2', () => {
    const dir = tmp('ledger-v2')
    write(dir, { version: VERSION, usage: { 'claude/claude-opus-5-5': { [Math.floor(NOW / HOUR)]: { tokens: 5, calls: 1 } } }, seen: {}, runOuts: [], quotas: {}, alerts: {}, files: { 'f.jsonl': { ino: 1, offset: 9 } }, backfilled: 5 })
    const l = new UsageLedger(dir)
    expect(l.byKey(0).get('claude/claude-opus-5-5')).toEqual({ tokens: 5, calls: 1 })
    expect(l.position('f.jsonl')).toEqual({ ino: 1, offset: 9 })
    l.migrateRunOuts(() => 'codex')
    expect(l.backfilled).toBe(5)
    const fresh = new UsageLedger(tmp('ledger-fresh'), true)
    fresh.migrateRunOuts(() => 'codex')
    expect(fresh.byKey(0).size).toBe(0)
  })
})
