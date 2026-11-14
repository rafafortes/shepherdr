// The usage feed: the model calls of Shepherdr's own agents' logs, read into the ledger once each. The first pass
// backfills every log from its start, in pieces, and is marked done once; a later pass reads on from where the ledger
// left each log, so a restart counts nothing twice; a resumed session's copy of a call counts once; a log no record names
// is not read at all, and a log that stops being named forgets its position.
import { describe, expect, test } from 'bun:test'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentRecord } from '../server/live/agents.ts'
import { UsageLedger, HOUR } from '../server/live/usage-ledger.ts'
import { UsageFeed } from '../server/live/usage-feed.ts'
import { tmp } from './tmp.ts'

const NOW = Date.now()
/** a pi reply's line: its model's provider and model, its usage and pi's cost estimate */
const reply = (id: string, h: number, tokens: number, provider = 'opencode-go', model = 'deepseek-v4.1-flash', cost = 0.001, pad = '') =>
  JSON.stringify({
    type: 'message',
    id,
    timestamp: new Date(NOW - h * HOUR).toISOString(),
    message: { role: 'assistant', provider, model, content: [{ type: 'text', text: `ok ${pad}` }], stopReason: 'stop', usage: { totalTokens: tokens, cost: { total: cost } } },
  }) + '\n'
const rec = (key: string, logs: string[], kind = 'pi'): Record<string, AgentRecord> => ({ [key]: { key, name: key, kind, cwd: '/x', workspace: 'w', logs, started: NOW } as AgentRecord })

describe('the feed reads the logs of the records it is given, once each', () => {
  test('a pass counts each reply on its model; a second pass counts only what was written since', () => {
    const dir = tmp('feed-once')
    const log = join(dir, 'T-1.jsonl')
    writeFileSync(log, reply('m1', 3, 100) + reply('m2', 2, 50, 'spark', 'qwen3'))
    const ledger = new UsageLedger(dir, true)
    const feed = new UsageFeed(ledger, () => rec('T-1/Agent', [log]))
    expect(feed.pass(NOW)).toBe(false)
    expect(ledger.byKey(NOW - 24 * HOUR).get('pi.opencode-go/deepseek-v4.1-flash')).toEqual({ tokens: 100, calls: 1, cost: 0.001 })
    expect(ledger.byKey(NOW - 24 * HOUR).get('pi.spark/qwen3')).toEqual({ tokens: 50, calls: 1, cost: 0.001 })
    // nothing new: nothing counted again
    feed.pass(NOW)
    expect(ledger.byKey(NOW - 24 * HOUR).get('pi.spark/qwen3')!.calls).toBe(1)
    // a reply written since: counted once
    appendFileSync(log, reply('m3', 0, 25))
    feed.pass(NOW)
    expect(ledger.byKey(NOW - 24 * HOUR).get('pi.opencode-go/deepseek-v4.1-flash')).toEqual({ tokens: 125, calls: 2, cost: 0.002 })
  })

  test('a restart reads on from the saved position: nothing is counted twice, and a new reply is', () => {
    const dir = tmp('feed-restart')
    const log = join(dir, 'T-2.jsonl')
    writeFileSync(log, reply('r1', 4, 10) + reply('r2', 3, 20))
    const a = new UsageLedger(dir)
    new UsageFeed(a, () => rec('T-2/Agent', [log])).pass(NOW)
    a.flush(NOW)
    appendFileSync(log, reply('r3', 1, 40))
    // a new process: a new ledger on the same folder, a new feed
    const b = new UsageLedger(dir)
    const feed = new UsageFeed(b, () => rec('T-2/Agent', [log]))
    feed.pass(NOW)
    expect(b.byKey(NOW - 24 * HOUR).get('pi.opencode-go/deepseek-v4.1-flash')).toEqual({ tokens: 70, calls: 3, cost: 0.003 })
  })

  test('a resumed session copies the calls before it into a new file: the copy counts once for the chat', () => {
    const dir = tmp('feed-copy')
    const first = join(dir, 'T-3-first.jsonl')
    const resumed = join(dir, 'T-3-resumed.jsonl')
    writeFileSync(first, reply('c1', 5, 300))
    writeFileSync(resumed, reply('c1', 5, 300) + reply('c2', 1, 70))
    const ledger = new UsageLedger(dir, true)
    new UsageFeed(ledger, () => rec('T-3/Agent', [first, resumed])).pass(NOW)
    expect(ledger.byKey(NOW - 24 * HOUR).get('pi.opencode-go/deepseek-v4.1-flash')).toEqual({ tokens: 370, calls: 2, cost: 0.002 })
  })

  test('the backfill reads a log in pieces, goes on in later passes, and is marked done once every log is read to its end', () => {
    const dir = tmp('feed-backfill')
    const log = join(dir, 'T-4.jsonl')
    // a log bigger than one read's step (64 KB), so a pass of a few hundred bytes stops short of its end
    const pad = 'x'.repeat(400)
    let text = ''
    for (let i = 0; i < 300; i++) text += reply(`b${i}`, 2 + i / 100, 10, undefined, undefined, undefined, pad)
    writeFileSync(log, text)
    const ledger = new UsageLedger(dir, true)
    const feed = new UsageFeed(ledger, () => rec('T-4/Agent', [log]))
    let passes = 0
    while (feed.pass(NOW, 300)) passes++
    expect(passes).toBeGreaterThan(1)
    const t = ledger.byKey(NOW - 24 * HOUR).get('pi.opencode-go/deepseek-v4.1-flash')!
    expect([t.tokens, t.calls]).toEqual([3000, 300])
    expect(t.cost).toBeCloseTo(0.3)
    // the marker is the run's: marked once, the first time
    ledger.markBackfilled(1)
    ledger.markBackfilled(2)
    expect(ledger.backfilled).toBe(1)
  })

  test('a pass that spends its bytes on one log leaves the other logs to the next pass', () => {
    const dir = tmp('feed-budget')
    const a = join(dir, 'A-1.jsonl')
    const b = join(dir, 'B-1.jsonl')
    writeFileSync(a, reply('x1', 1, 10))
    writeFileSync(b, reply('y1', 1, 20))
    const ledger = new UsageLedger(dir, true)
    const feed = new UsageFeed(ledger, () => ({ ...rec('A-1/Agent', [a]), ...rec('B-1/Agent', [b]) }))
    // one byte of budget: the first log takes the pass, and the second waits for the next
    expect(feed.pass(NOW, 1)).toBe(true)
    expect(ledger.byKey(NOW - 24 * HOUR).get('pi.opencode-go/deepseek-v4.1-flash')!.tokens).toBe(10)
    expect(feed.pass(NOW)).toBe(false)
    expect(ledger.byKey(NOW - 24 * HOUR).get('pi.opencode-go/deepseek-v4.1-flash')!.tokens).toBe(30)
  })

  test('only the logs of the records are read: another session folder is never scanned', () => {
    const dir = tmp('feed-only')
    const mine = join(dir, 'mine.jsonl')
    const other = join(dir, 'someone-else.jsonl')
    writeFileSync(mine, reply('o1', 1, 5))
    writeFileSync(other, reply('o2', 1, 999))
    const ledger = new UsageLedger(dir, true)
    new UsageFeed(ledger, () => rec('T-5/Agent', [mine])).pass(NOW)
    expect(ledger.byKey(NOW - 24 * HOUR).get('pi.opencode-go/deepseek-v4.1-flash')).toEqual({ tokens: 5, calls: 1, cost: 0.001 })
  })

  test('a log that no record names any more forgets its position; a missing log is waited for, not an error', () => {
    const dir = tmp('feed-gone')
    const log = join(dir, 'T-6.jsonl')
    writeFileSync(log, reply('g1', 1, 5))
    const ledger = new UsageLedger(dir, true)
    let records = rec('T-6/Agent', [log])
    const feed = new UsageFeed(ledger, () => records)
    feed.pass(NOW)
    expect(ledger.position(log)).toBeDefined()
    records = {}
    feed.pass(NOW)
    expect(ledger.position(log)).toBeUndefined()
    // a record whose log is not there yet: nothing is read, nothing breaks
    records = rec('T-7/Agent', [join(dir, 'not-yet.jsonl')])
    expect(feed.pass(NOW)).toBe(false)
  })

  test('a log of a CLI Shepherdr has no reader for is skipped', () => {
    const dir = tmp('feed-noreader')
    const log = join(dir, 'T-8.jsonl')
    writeFileSync(log, reply('n1', 1, 5))
    const ledger = new UsageLedger(dir, true)
    new UsageFeed(ledger, () => rec('T-8/Agent', [log], 'no-such-cli')).pass(NOW)
    expect(ledger.byKey(0).size).toBe(0)
  })

  test('a Claude Code reply and a Codex turn are counted on their providers', () => {
    const dir = tmp('feed-clis')
    const claude = join(dir, 'claude.jsonl')
    const codex = join(dir, 'codex.jsonl')
    writeFileSync(
      claude,
      JSON.stringify({ type: 'assistant', sessionId: 's', uuid: 'u1', timestamp: new Date(NOW - HOUR).toISOString(), message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n',
    )
    writeFileSync(
      codex,
      JSON.stringify({ timestamp: new Date(NOW - HOUR).toISOString(), type: 'turn_context', payload: { model: 'gpt-6-sol' } }) + '\n' +
        JSON.stringify({ timestamp: new Date(NOW - HOUR).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 33 } } } }) + '\n',
    )
    const ledger = new UsageLedger(dir, true)
    new UsageFeed(ledger, () => ({ ...rec('C-1/Agent', [claude], 'claude'), ...rec('X-1/Agent', [codex], 'codex') })).pass(NOW)
    expect(ledger.byKey(NOW - 24 * HOUR).get('claude/claude-opus-5-5')).toEqual({ tokens: 15, calls: 1 })
    expect(ledger.byKey(NOW - 24 * HOUR).get('codex/gpt-6-sol')).toEqual({ tokens: 33, calls: 1 })
  })

  test('start reads now and then each minute; stop ends the timer and writes what was counted', async () => {
    const dir = tmp('feed-start')
    const log = join(dir, 'T-9.jsonl')
    writeFileSync(log, reply('s1', 1, 9))
    const ledger = new UsageLedger(dir)
    const feed = new UsageFeed(ledger, () => rec('T-9/Agent', [log]))
    feed.start()
    // the first read is at once, in a later turn of the event loop
    for (let i = 0; i < 100 && !ledger.backfilled; i++) await Bun.sleep(5)
    expect(ledger.backfilled).toBeGreaterThan(0)
    feed.stop()
    expect(ledger.byKey(0).get('pi.opencode-go/deepseek-v4.1-flash')!.calls).toBe(1)
  })
})
