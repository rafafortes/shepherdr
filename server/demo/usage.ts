// The demo's usage: a week of model calls for the providers the demo's settings and chats use, and a run-out or two, so
// Settings → Models → Summary shows a believable week. Deterministic (no random numbers): each hour's calls follow the
// hour of the day, and the run-outs are at fixed times back from now. Kept in memory, as the demo's settings are.
import { HOUR, UsageLedger } from '../live/usage-ledger.ts'

/** per model key: tokens per call, its cost estimate per call (pi's), and how many calls in a working hour */
const MODELS: { key: string; tokens: number; cost?: number; busy: number; chat: string }[] = [
  { key: 'anthropic/claude-opus-5-5', tokens: 42_000, busy: 3, chat: 'GTM-15/Agent' },
  { key: 'anthropic/claude-haiku-5-5', tokens: 18_000, busy: 1, chat: 'HP-201/Reviewer' },
  { key: 'openai/gpt-6-sol', tokens: 26_000, busy: 1, chat: 'LV-3/Agent' },
  { key: 'opencode-go/deepseek-v4.1-flash', tokens: 15_000, cost: 0.0009, busy: 2, chat: 'HP-202/Agent' },
  { key: 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold', tokens: 22_000, busy: 2, chat: 'GTM-16/Agent' },
]

/** the demo's ledger: the week before `now`, hour by hour, and the run-outs of the week */
export function demoUsage(now = Date.now()): UsageLedger {
  const l = new UsageLedger('', true)
  for (let back = 7 * 24 - 1; back >= 0; back--) {
    const hour = new Date(now - back * HOUR).getHours()
    const working = hour >= 9 && hour <= 18 ? 1 : 0
    MODELS.forEach((m, i) => {
      // the calls of this hour: a working hour's share, a little more on the weekdays' busy hours
      const calls = working * m.busy + ((back * 3 + i * 5) % 3)
      for (let c = 0; c < calls; c++) {
        const at = now - back * HOUR + c * 60_000 + i * 1000
        l.count(m.chat, m.key, { id: `demo-${m.key}-${back}-${c}`, at, tokens: m.tokens + ((back + c) % 5) * 1000, ...(m.cost !== undefined ? { cost: m.cost } : {}) }, now)
      }
    })
  }
  // OpenCode Go ran out twice this week: the second time, now, until a reset three hours on (out now)
  l.runOut({ at: now - 50 * HOUR, key: 'opencode-go/deepseek-v4.1-flash', chat: 'HP-202/Agent', role: 'task', reason: 'Out of allowance until 6pm', words: 'You have hit your usage limit · resets 6pm', reset: '6pm', resetAt: now - 40 * HOUR }, now)
  l.runOut({ at: now - 2 * HOUR, key: 'opencode-go/deepseek-v4.1-flash', chat: 'HP-202/Agent', role: 'task', reason: 'Out of allowance until 5pm', words: 'You have hit your usage limit · resets 5pm', reset: '5pm', resetAt: now + 3 * HOUR }, now)
  // the demo's week was read already: no backfill notice
  l.markBackfilled(now)
  return l
}
