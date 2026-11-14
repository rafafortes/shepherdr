// Settings → Models → Quotas: OpenCode Go's estimate (quota-estimate.ts), from the ledger alone. The windows are the tokens
// and pi's cost used in the last 5 h and the week; a run-out's window (the 5 h or the week before it) is a learned limit,
// the lowest of them the cap the current window is a share of; the estimate is labelled, with no share before a run-out.
import { describe, expect, test } from 'bun:test'
import { opencodeEstimate, OPENCODE } from '../server/live/quota-estimate.ts'
import { HOUR, UsageLedger, type RunOut } from '../server/live/usage-ledger.ts'
import { tmp } from './tmp.ts'

// on the hour, so a call half an hour before an hour's mark falls in one whole hour in every window the test reads
const NOW = Date.UTC(2026, 10, 13, 9)
const MODEL = `${OPENCODE}/deepseek-v4.1-flash`
const H = (x: number) => x * HOUR
const ledger = (name: string) => new UsageLedger(tmp(name), true)
/** a call of the model `ago` hours back (a half hour off the hour), its tokens and its cost estimate */
function call(l: UsageLedger, ago: number, tokens: number, cost?: number, key = MODEL) {
  l.count('T-1/Agent', key, { id: `c-${key}-${ago}-${tokens}`, at: NOW - H(ago), tokens, ...(cost !== undefined ? { cost } : {}) }, NOW)
}
function runOut(l: UsageLedger, ago: number, key = MODEL): RunOut {
  const r: RunOut = { at: NOW - H(ago), key, chat: 'T-1/Agent', role: 'task', reason: 'Out of allowance until 5pm', words: '' }
  l.runOut(r, NOW)
  return r
}

describe('no ledger, no estimate', () => {
  test('with no call of OpenCode Go in the week and no run-out there is no figure at all', () => {
    const l = ledger('estimate-empty')
    call(l, 200, 900, undefined, 'claude/claude-opus-5-5')
    expect(opencodeEstimate(l, NOW)).toBeUndefined()
  })
})

describe('the usage alone, with no run-out yet: no share, the windows as the ledger has them', () => {
  test('the 5 h and the week count their own hours; the cost is the estimate pi gave; nothing is a limit', () => {
    const l = ledger('estimate-usage')
    call(l, 0.5, 1000)
    call(l, 1.5, 2000)
    call(l, 3.5, 4000, 0.004)
    call(l, 6.5, 8000)
    call(l, 30.5, 32000)
    const got = opencodeEstimate(l, NOW)!
    expect(got.estimate).toBe(true)
    expect(got.source).toBe("estimate from Shepherdr's ledger")
    expect(got.at).toBe(NOW)
    expect(got.windows).toEqual([
      { name: '5 h', used: 7000, cost: 0.004 },
      { name: 'Week', used: 47000, cost: 0.004 },
    ])
    // an estimate's window rolls: it has no refill moment
    expect(got.windows.every((w) => w.resetAt === undefined)).toBe(true)
  })
})

describe('with run-outs: the window before each one is a learned limit, and the current window is a share of the lowest', () => {
  test('the lowest learned limit is the cap; the share of the current 5 h is over it, shown with the latest few run-outs', () => {
    const l = ledger('estimate-learned')
    call(l, 0.5, 1000)
    call(l, 1.5, 2000)
    call(l, 3.5, 4000, 0.004)
    call(l, 6.5, 8000, 0.008)
    call(l, 8.5, 16000)
    call(l, 30.5, 32000)
    call(l, 35.5, 5000)
    // a run-out 2.5 h back: the 5 h before it held the 4 k and the 8 k calls (12 k); the week before it, 65 k
    const first = runOut(l, 2.5)
    // one 33 h back: the 5 h before it held the 5 k call alone, the lowest so far
    const second = runOut(l, 33)
    const got = opencodeEstimate(l, NOW)!
    const [five, week] = got.windows
    expect(five).toMatchObject({ name: '5 h', used: 7000, cap: 5000, usedPct: 140 })
    // the latest first: the run-out 2.5 h back, then the one 33 h back
    expect(five!.learned).toEqual([
      { at: first.at, tokens: 12000, cost: 0.012 },
      { at: second.at, tokens: 5000 },
    ])
    expect(week).toMatchObject({ name: 'Week', used: 68000, cap: 5000 })
    expect(week!.learned).toEqual([
      { at: first.at, tokens: 65000, cost: 0.012 },
      { at: second.at, tokens: 5000 },
    ])
  })

  test('a run-out with no use before it in its window is no limit; the figure keeps its share of the rest', () => {
    const l = ledger('estimate-no-use')
    call(l, 1.5, 4000)
    runOut(l, 60)
    const [five] = opencodeEstimate(l, NOW)!.windows
    expect(five).toEqual({ name: '5 h', used: 4000 })
  })

  test('only the latest three run-outs are shown, newest first', () => {
    const l = ledger('estimate-latest')
    // each run-out has its own 5 h use just before it: 1 k, 2 k, 3 k and 4 k; the lowest is the cap, the latest three shown
    call(l, 42.5, 1000)
    call(l, 62.5, 2000)
    call(l, 82.5, 3000)
    call(l, 102.5, 4000)
    const runs = [runOut(l, 41), runOut(l, 61), runOut(l, 81), runOut(l, 101)]
    const [five] = opencodeEstimate(l, NOW)!.windows
    expect(five!.learned!.map((x) => x.at)).toEqual([runs[0]!.at, runs[1]!.at, runs[2]!.at])
    expect(five!.learned!.map((x) => x.tokens)).toEqual([1000, 2000, 3000])
    expect(five!.cap).toBe(1000)
  })

  test('a run-out of another provider is none of this estimate', () => {
    const l = ledger('estimate-other')
    call(l, 1.5, 4000)
    runOut(l, 2.5, 'claude/claude-opus-5-5')
    const got = opencodeEstimate(l, NOW)!
    expect(got.windows[0]).toEqual({ name: '5 h', used: 4000 })
  })
})
