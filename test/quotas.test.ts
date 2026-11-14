// Settings → Models → Quotas, the scheduler (quotas.ts) with fake readers: each read every ten minutes while its switch is on,
// Refresh quotas at most once a minute per provider, a failed read keeping the last good figure and saying why, a hint that
// fails nothing, and each window at its share alerting once and again only after it refilled, a new window came, or it fell
// under the share. OpenCode Go's estimate is looked at on each tick and never read. Nothing here calls a CLI or an API.
import { describe, expect, test } from 'bun:test'
import { alertShare, Quotas, EVERY, ON_DEMAND, SWITCH } from '../server/live/quotas.ts'
import { HOUR, UsageLedger, type RunOut } from '../server/live/usage-ledger.ts'
import type { Reading } from '../server/live/plan-limits.ts'
import type { QuotaFigure } from '../shared/types.ts'
import { tmp } from './tmp.ts'

const T = Date.UTC(2026, 10, 13, 9)
const FIG = (windows: QuotaFigure['windows'], extra: Partial<QuotaFigure> = {}): QuotaFigure => ({ windows, source: "from Claude Code's /usage", at: T, ...extra })

interface Alert {
  provider: string
  window: string
  title: string
  body: string
}

/** a quota world of its own: a ledger, the switches, the warning share, and readers that answer what the test sets */
function world(over: { main?: boolean; off?: string[]; share?: number | undefined } = {}) {
  const usage = new UsageLedger(tmp('quotas'), true)
  const alerts: Alert[] = []
  const counts = { claude: 0, 'pi.commandcode': 0 }
  let emits = 0
  const answers: Record<'claude' | 'pi.commandcode', () => Promise<Reading>> = {
    claude: async () => ({ hint: 'not set' }),
    'pi.commandcode': async () => ({ hint: 'not set' }),
  }
  const switches = Object.fromEntries((over.off ?? []).map((k) => [k, false]))
  let share: number | undefined = 'share' in over ? over.share : 80
  const q = new Quotas({
    usage,
    readers: {
      claude: () => {
        counts.claude++
        return answers.claude()
      },
      'pi.commandcode': () => {
        counts['pi.commandcode']++
        return answers['pi.commandcode']()
      },
    },
    on: (key) => switches[key] !== false,
    alertAt: () => share,
    alert: (provider, window, title, body) => alerts.push({ provider, window, title, body }),
    emit: () => emits++,
    main: over.main ?? true,
  })
  return {
    q,
    usage,
    alerts,
    counts,
    answers,
    emits: () => emits,
    setShare: (s: number | undefined) => (share = s),
  }
}

describe('the reads: every ten minutes each, while on; the first at once', () => {
  test('a tick reads each provider that is due, and no other time before ten minutes have passed', async () => {
    const w = world()
    await w.q.tick(T)
    expect(w.counts).toEqual({ claude: 1, 'pi.commandcode': 1 })
    await w.q.tick(T + 5 * 60_000)
    expect(w.counts).toEqual({ claude: 1, 'pi.commandcode': 1 })
    await w.q.tick(T + EVERY)
    expect(w.counts).toEqual({ claude: 2, 'pi.commandcode': 2 })
  })

  test('a switch that is off is not read, and its figure is what the ledger kept', async () => {
    const w = world({ off: ['quota.claude'] })
    await w.q.tick(T)
    expect(w.counts).toEqual({ claude: 0, 'pi.commandcode': 1 })
    expect(w.q.status('claude')).toEqual({ on: false })
  })

  test('a worker that is not the main machine reads nothing and says where it is read', async () => {
    const w = world({ main: false })
    await w.q.tick(T)
    expect(w.counts).toEqual({ claude: 0, 'pi.commandcode': 0 })
    expect(w.q.status('claude')).toEqual({ on: true, hint: 'Read by the main machine, not here.' })
    expect(w.q.refresh(T)).toEqual({ ok: false, error: 'Quotas are read on the main machine.' })
  })
})

describe('Refresh quotas: on demand, at most once a minute per provider', () => {
  test('a refresh starts each read that is on; a second one within the minute starts none, and one after it starts them again', async () => {
    const w = world()
    expect(w.q.refresh(T)).toEqual({ ok: true, started: ['claude', 'pi.commandcode'] })
    await w.q.settled()
    expect(w.counts).toEqual({ claude: 1, 'pi.commandcode': 1 })
    expect(w.q.refresh(T + 30_000)).toEqual({ ok: false, error: 'Read a minute ago, or still reading: try again in a moment.' })
    expect(w.q.refresh(T + ON_DEMAND)).toEqual({ ok: true, started: ['claude', 'pi.commandcode'] })
    await w.q.settled()
    expect(w.counts).toEqual({ claude: 2, 'pi.commandcode': 2 })
  })

  test('a read still running is not started again; the refresh says so', async () => {
    const w = world()
    let finish: (r: Reading) => void = () => undefined
    w.answers.claude = () => new Promise<Reading>((done) => (finish = done))
    expect(w.q.refresh(T).started).toEqual(['claude', 'pi.commandcode'])
    expect(w.q.refresh(T + ON_DEMAND)).toEqual({ ok: false, error: 'Read a minute ago, or still reading: try again in a moment.' })
    finish({ hint: 'done' })
    await w.q.settled()
  })

  test('with both switches off there is nothing to refresh, and the answer says which switch to turn on', () => {
    const w = world({ off: ['quota.claude', 'quota.commandcode'] })
    expect(w.q.refresh(T)).toEqual({ ok: false, error: 'Every quota read is off: switch one on in Settings → Models → Quotas first.' })
  })

  test('a refresh of one provider only: the other one is still within its minute', async () => {
    const w = world({ off: ['quota.commandcode'] })
    expect(w.q.refresh(T)).toEqual({ ok: true, started: ['claude'] })
    await w.q.settled()
  })
})

describe('a read that fails keeps the last good figure, and says why', () => {
  test('a good read is kept in the ledger; a failure after it keeps that figure with its reason, and a good read clears the reason', async () => {
    const w = world()
    w.answers.claude = async () => ({ figure: FIG([{ name: '5 h', usedPct: 12, resetAt: T + 2 * HOUR }]) })
    await w.q.tick(T)
    expect(w.usage.quota('claude')?.windows[0]).toMatchObject({ usedPct: 12 })
    expect(w.q.status('claude')).toEqual({ on: true, tried: T })
    w.answers.claude = async () => ({ reason: 'Claude Code is not signed in.' })
    await w.q.tick(T + EVERY)
    expect(w.usage.quota('claude')?.windows[0]).toMatchObject({ usedPct: 12 })
    expect(w.q.status('claude')).toEqual({ on: true, failed: 'Claude Code is not signed in.', tried: T + EVERY })
    w.answers.claude = async () => ({ figure: FIG([{ name: '5 h', usedPct: 13 }]) })
    await w.q.tick(T + 2 * EVERY)
    expect(w.q.status('claude')).toEqual({ on: true, tried: T + 2 * EVERY })
  })

  test('a hint is what the screen says, fails nothing, and keeps the figure; a read that throws says it stopped', async () => {
    const w = world()
    w.answers['pi.commandcode'] = async () => ({ figure: FIG([{ name: 'Credits', left: 9 }], { source: "from Command Code's API" }) })
    await w.q.tick(T)
    w.answers['pi.commandcode'] = async () => ({ hint: 'Add COMMANDCODE_API_KEY in Settings → Secrets to read Command Code\'s quota.' })
    await w.q.tick(T + EVERY)
    expect(w.q.status('pi.commandcode')).toEqual({ on: true, hint: "Add COMMANDCODE_API_KEY in Settings → Secrets to read Command Code's quota.", tried: T + EVERY })
    expect(w.usage.quota('pi.commandcode')?.windows).toEqual([{ name: 'Credits', left: 9 }])
    w.answers['pi.commandcode'] = async () => {
      throw new Error('boom')
    }
    await w.q.tick(T + 2 * EVERY)
    expect(w.q.status('pi.commandcode')).toEqual({ on: true, failed: 'The read stopped unexpectedly.', tried: T + 2 * EVERY })
    expect(w.emits()).toBeGreaterThanOrEqual(3)
  })

  test('the status of OpenCode Go is its switch alone: its figure is the estimate, not a read', () => {
    const w = world()
    expect(w.q.status('opencode.opencode-go')).toEqual({ on: true })
    expect(w.q.status('spark')).toEqual({ on: false })
    expect(w.q.figure('opencode.opencode-go', T)).toBeUndefined()
  })
})

describe('the warning share: each window alerts once, and again only after it refilled, a new window came, or it fell under', () => {
  test('a window at or over the share alerts once with what is left and when it refills; the others do not', async () => {
    const w = world()
    w.answers.claude = async () => ({ figure: FIG([{ name: '5 h', usedPct: 85, resetAt: T + 2 * HOUR }, { name: 'Week', usedPct: 41, resetAt: T + 72 * HOUR }]) })
    await w.q.tick(T)
    expect(w.alerts).toHaveLength(1)
    expect(w.alerts[0]).toMatchObject({ provider: 'claude', window: '5 h', title: 'Claude Code is at 85%' })
    expect(w.alerts[0]!.body).toMatch(/^5 h window: 15% left, and it refills \w{3}/)
    expect(w.alerts[0]!.body).not.toMatch(/over|at its limit/)
    // the same window, read again: no second alert
    await w.q.tick(T + EVERY)
    expect(w.alerts).toHaveLength(1)
  })

  test('a window that refilled (its moment passed) alerts again when a new one is over the share', async () => {
    const w = world()
    w.answers.claude = async () => ({ figure: FIG([{ name: '5 h', usedPct: 85, resetAt: T + HOUR }]) })
    await w.q.tick(T)
    expect(w.alerts).toHaveLength(1)
    // its moment passed: the old window is refilled, and the read still shows it (no new moment yet)
    w.answers.claude = async () => ({ figure: FIG([{ name: '5 h', usedPct: 85, resetAt: T + HOUR }]) })
    await w.q.tick(T + 2 * HOUR)
    expect(w.alerts).toHaveLength(1)
    // a new window over the share: alerts again
    w.answers.claude = async () => ({ figure: FIG([{ name: '5 h', usedPct: 90, resetAt: T + 7 * HOUR }]) })
    await w.q.tick(T + 2 * HOUR + EVERY)
    expect(w.alerts).toHaveLength(2)
    expect(w.alerts[1]!.title).toBe('Claude Code is at 90%')
  })

  test('a window that fell under the share is armed again, so the next time it is over it alerts', async () => {
    const w = world()
    w.answers.claude = async () => ({ figure: FIG([{ name: '5 h', usedPct: 85, resetAt: T + 2 * HOUR }]) })
    await w.q.tick(T)
    w.answers.claude = async () => ({ figure: FIG([{ name: '5 h', usedPct: 10, resetAt: T + 2 * HOUR }]) })
    await w.q.tick(T + EVERY)
    w.answers.claude = async () => ({ figure: FIG([{ name: '5 h', usedPct: 83, resetAt: T + 2 * HOUR }]) })
    await w.q.tick(T + 2 * EVERY)
    expect(w.alerts.map((a) => a.title)).toEqual(['Claude Code is at 85%', 'Claude Code is at 83%'])
  })

  test('a count window (used of a cap) has its own share, and says it has no refill time', async () => {
    const w = world()
    w.answers['pi.commandcode'] = async () => ({ figure: FIG([{ name: 'Team', used: 90, cap: 100 }], { source: "from Command Code's API" }) })
    await w.q.tick(T)
    expect(w.alerts).toEqual([{ provider: 'pi.commandcode', window: 'Team', title: 'pi · Command Code is at 90%', body: 'Team window: 10% left, and it has no refill time.' }])
  })

  test('with the share off nothing alerts; a share set later alerts for what is over it now', async () => {
    const w = world({ share: undefined })
    w.answers.claude = async () => ({ figure: FIG([{ name: '5 h', usedPct: 99, resetAt: T + 2 * HOUR }]) })
    await w.q.tick(T)
    expect(w.alerts).toEqual([])
    w.setShare(95)
    await w.q.tick(T + EVERY)
    expect(w.alerts).toHaveLength(1)
  })

  test("OpenCode Go's estimate is looked at on each tick: its window over the share alerts once, as an estimate", async () => {
    const w = world()
    const u = w.usage
    const at = (ago: number) => T - ago * HOUR
    const MODEL = 'opencode.opencode-go/deepseek-v4.1-flash'
    // 4,500 tokens in the last hour, and a run-out 10 h back after 5,000 tokens in the 5 h before it: the learned cap
    u.count('T-1/Agent', MODEL, { id: 'now', at: at(0.5), tokens: 4500 }, T)
    u.count('T-1/Agent', MODEL, { id: 'before', at: at(11.5), tokens: 5000 }, T)
    const run: RunOut = { at: at(10), key: MODEL, chat: 'T-1/Agent', role: 'task', reason: 'Out of allowance', words: '' }
    u.runOut(run, T)
    await w.q.tick(T)
    const five = w.alerts.filter((a) => a.provider === 'opencode.opencode-go' && a.window === '5 h')
    expect(five).toEqual([{ provider: 'opencode.opencode-go', window: '5 h', title: 'OpenCode · OpenCode Go is at 90%', body: '5 h window: 10% left, and it drains as its calls leave the window.' }])
    // the plan's other row (pi's) shows the same estimate and alerts for it nowhere: one alert per plan
    expect(w.alerts.filter((a) => a.provider === 'pi.opencode-go')).toEqual([])
    // over the share still: no second alert
    await w.q.tick(T + EVERY)
    expect(w.alerts.filter((a) => a.provider === 'opencode.opencode-go' && a.window === '5 h')).toHaveLength(1)
    // under a share it is not over, then over it again: alerts again
    w.setShare(95)
    await w.q.tick(T + 2 * EVERY)
    w.setShare(80)
    await w.q.tick(T + 3 * EVERY)
    expect(w.alerts.filter((a) => a.provider === 'opencode.opencode-go' && a.window === '5 h')).toHaveLength(2)
  })

  test('the share is the number of quota.alertAt: an off word, a percent, or a word that is no number', () => {
    expect(alertShare('off')).toBeUndefined()
    expect(alertShare('80%')).toBe(80)
    expect(alertShare(' 72.5 % ')).toBe(72.5)
    expect(alertShare('soon')).toBeUndefined()
  })
})

describe("OpenCode Go's figure as the summary asks for it", () => {
  test('on, it is the estimate of the ledger; off, none', () => {
    const w = world()
    w.usage.count('T-1/Agent', 'opencode.opencode-go/deepseek-v4.1-flash', { id: 'a', at: T - HOUR, tokens: 300 }, T)
    expect(w.q.figure('opencode.opencode-go', T)).toMatchObject({ estimate: true, windows: [{ name: '5 h', used: 300 }, { name: 'Week', used: 300 }] })
    const off = world({ off: ['quota.opencodeGo'] })
    off.usage.count('T-1/Agent', 'opencode.opencode-go/deepseek-v4.1-flash', { id: 'a', at: T - HOUR, tokens: 300 }, T)
    expect(off.q.figure('opencode.opencode-go', T)).toBeUndefined()
  })

  test("a read's last figure is the ledger's, and none before a read", async () => {
    const w = world()
    expect(w.q.figure('claude', T)).toBeUndefined()
    w.answers.claude = async () => ({ figure: FIG([{ name: '5 h', usedPct: 1 }]) })
    await w.q.tick(T)
    expect(w.q.figure('claude', T)).toMatchObject({ source: "from Claude Code's /usage" })
  })
})

describe('the rows of the quotas: each switch, and OpenCode Go on both of its rows', () => {
  test('a read is for the Claude subscription and Command Code only; the switches name the rows that show them', () => {
    expect(SWITCH).toEqual({ claude: 'quota.claude', 'pi.commandcode': 'quota.commandcode', 'pi.opencode-go': 'quota.opencodeGo', 'opencode.opencode-go': 'quota.opencodeGo' })
    const w = world()
    expect(w.q.status('pi.opencode-go')).toEqual({ on: true })
    expect(w.q.status('opencode.opencode-go')).toEqual({ on: true })
    expect(w.q.status('pi.spark')).toEqual({ on: false })
  })

  test('the estimate is the same figure on pi’s row and on OpenCode’s, and the summary carries it on both', () => {
    const w = world()
    w.usage.count('T-1/Agent', 'pi.opencode-go/deepseek-v4.1-flash', { id: 'p1', at: T - HOUR, tokens: 200 }, T)
    w.usage.count('T-2/Agent', 'opencode.opencode-go/deepseek-v4.1-flash', { id: 'o1', at: T - HOUR, tokens: 100 }, T)
    const pi = w.q.figure('pi.opencode-go', T)
    expect(pi).toMatchObject({ estimate: true, windows: [{ name: '5 h', used: 300 }, { name: 'Week', used: 300 }] })
    expect(w.q.figure('opencode.opencode-go', T)).toEqual(pi)
    expect(Object.keys(w.q.summary(T).figures).sort()).toEqual(['opencode.opencode-go', 'pi.opencode-go'])
    expect(w.q.summary(T).figures['pi.opencode-go']).toEqual(w.q.summary(T).figures['opencode.opencode-go'])
  })
})
