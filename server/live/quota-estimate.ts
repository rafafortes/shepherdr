// OpenCode Go's quota, as an estimate: OpenCode does not tell pi (or Shepherdr) what is left of its plan, and no endpoint
// gives it, so nothing is read. What is shown is what Shepherdr's own ledger holds: the tokens and pi's cost estimate used
// in the last 5 h and the last week, and, where the ledger holds run-outs, the limit they show: what the window before each
// run-out held when OpenCode Go ran out. The lowest of those is the learned limit, and the current window's use is a share
// of it, labelled an estimate. No run-out yet: the usage alone, with no share.
import { HOUR, providerOf, type RunOut, type UsageLedger, type UsageTotals } from './usage-ledger.ts'
import type { QuotaFigure, QuotaWindow } from '../../shared/types.ts'

export const OPENCODE = 'opencode-go'
const WEEK = 7 * 24 * HOUR
/** the windows the estimate shows: a 5 h one and a week */
const WINDOWS = [
  { name: '5 h', ms: 5 * HOUR },
  { name: 'Week', ms: WEEK },
] as const
/** the latest run-outs a window shows its learned limit from */
const LEARNED = 3

const isOpenCode = (key: string) => providerOf(key) === OPENCODE

/** the estimate of OpenCode Go's windows at `now`, or none when the ledger holds no call of it in the week and no run-out */
export function opencodeEstimate(usage: UsageLedger, now: number): QuotaFigure | undefined {
  const runs = usage.runOuts(isOpenCode)
  const week = usage.between(isOpenCode, now - WEEK, now)
  if (!week.calls && !runs.length) return undefined
  const windows = WINDOWS.map(({ name, ms }): QuotaWindow => {
    const used = usage.between(isOpenCode, now - ms, now)
    // the window that ended at each run-out, where it held any use: the learned limits
    const learned = runs.map((r) => ({ run: r, t: usage.between(isOpenCode, r.at - ms, r.at) })).filter((x) => x.t.tokens > 0)
    const cap = learned.length ? Math.min(...learned.map((x) => x.t.tokens)) : undefined
    return {
      name,
      used: used.tokens,
      ...(used.cost !== undefined ? { cost: used.cost } : {}),
      ...(cap !== undefined ? { cap, usedPct: (used.tokens / cap) * 100, learned: learned.slice(-LEARNED).reverse().map(({ run, t }) => learnedOf(run, t)) } : {}),
    }
  })
  return { windows, source: "estimate from Shepherdr's ledger", at: now, estimate: true }
}

/** one run-out's figure for a window: when, and what the window before it held */
function learnedOf(run: RunOut, t: UsageTotals): NonNullable<QuotaWindow['learned']>[number] {
  return { at: run.at, tokens: t.tokens, ...(t.cost !== undefined ? { cost: t.cost } : {}) }
}
