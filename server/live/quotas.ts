// Settings → Models → Quotas, on the main machine: Claude Code's /usage and Command Code's account read every 10 minutes
// (each only while its switch is on), OpenCode Go's estimate built from the ledger on each look, "Refresh quotas" on demand
// at most once a minute per provider. A read that fails keeps the last good figure (with its age, in the ledger) and says
// why; a read that gives a hint (no bubblewrap, no key) says what to add and fails nothing. Each window at or over the
// warning share (quota.alertAt) alerts once, and again only once it has refilled or a new window came, or after it was
// under the share.
import { clock, leftWords, providerName, shareOf, type QuotaInput } from './models-summary.ts'
import { opencodeEstimate, OPENCODE } from './quota-estimate.ts'
import type { Reading } from './plan-limits.ts'
import type { UsageLedger } from './usage-ledger.ts'
import type { QuotaFigure, QuotaRead } from '../../shared/types.ts'

/** how often each read runs by itself, and how soon one may run again on demand */
export const EVERY = 10 * 60_000
export const ON_DEMAND = 60_000

/** the Settings switch of each provider's quota (the estimate's too) */
export const SWITCH: Record<string, string> = { anthropic: 'quota.claude', commandcode: 'quota.commandcode', [OPENCODE]: 'quota.opencodeGo' }
/** the providers that have a read of their own */
const READS = ['anthropic', 'commandcode'] as const
type Reads = (typeof READS)[number]

export interface QuotasDeps {
  usage: UsageLedger
  readers: Record<Reads, () => Promise<Reading>>
  /** whether a Settings switch is on */
  on: (key: string) => boolean
  /** the warning share in percent, or none when it is off */
  alertAt: () => number | undefined
  /** an alert: a title and a body in words, about one window of one provider */
  alert: (provider: string, window: string, title: string, body: string) => void
  /** the snapshot changed (a read finished) */
  emit: () => void
  /** whether this is the main machine: the reads run here and nowhere else */
  main: boolean
}

interface Seen {
  tried?: number
  failed?: string
  hint?: string
  reading?: boolean
}

/** quota.alertAt as a share in percent, or none when it is off */
export const alertShare = (value: string): number | undefined => {
  const n = Number.parseFloat(value)
  return value.trim().toLowerCase() === 'off' || !Number.isFinite(n) ? undefined : n
}

export class Quotas {
  private seen = new Map<string, Seen>()
  private running = new Set<Promise<void>>()

  constructor(private d: QuotasDeps) {}

  private at(provider: string): Seen {
    let s = this.seen.get(provider)
    if (!s) this.seen.set(provider, (s = {}))
    return s
  }

  /** the figure a provider shows now: its last good read (the ledger's), or OpenCode Go's estimate built now while its switch is on */
  figure(provider: string, now = Date.now()): QuotaFigure | undefined {
    if (provider === OPENCODE) return this.d.on(SWITCH[OPENCODE]!) ? opencodeEstimate(this.d.usage, now) : undefined
    return this.d.usage.quota(provider)
  }

  /** what the summary shows (models-summary.ts): each provider's read as it stands, OpenCode Go's estimate built now, and
   *  the warning share (none when it is off) */
  summary(now = Date.now()): QuotaInput {
    const est = this.figure(OPENCODE, now)
    const share = this.d.alertAt()
    return {
      figures: est ? { [OPENCODE]: est } : {},
      reads: Object.fromEntries(Object.keys(SWITCH).map((p) => [p, this.status(p)])),
      ...(share !== undefined ? { alertAt: share } : {}),
    }
  }

  /** what the screen says of a provider's read: its switch, why it reads nothing, and how its last try went */
  status(provider: string): QuotaRead {
    const s = this.seen.get(provider) ?? {}
    const sw = SWITCH[provider]
    const on = sw ? this.d.on(sw) : false
    if (!READS.includes(provider as Reads)) return { on }
    const hint = this.d.main ? s.hint : 'Read by the main machine, not here.'
    return {
      on,
      ...(hint ? { hint } : {}),
      ...(s.failed ? { failed: s.failed } : {}),
      ...(s.tried !== undefined ? { tried: s.tried } : {}),
    }
  }

  /** a tick of the clock (each minute): each read that is on and was last tried 10 minutes ago or more runs now; the
   *  estimate's windows are looked at for the alert. Resolves when the reads it started are done */
  async tick(now = Date.now()): Promise<void> {
    if (!this.d.main) return
    for (const p of READS) {
      const s = this.at(p)
      if (this.d.on(SWITCH[p]!) && !s.reading && (s.tried === undefined || now - s.tried >= EVERY)) this.start(p, now)
    }
    const est = this.figure(OPENCODE, now)
    if (est) this.check(OPENCODE, est, now)
    await this.settled()
  }

  /** Refresh quotas: each read that is on starts now, unless it is reading or was tried in the last minute. The answer
   *  says what started, or why nothing did */
  refresh(now = Date.now()): { ok: boolean; started?: string[]; error?: string } {
    if (!this.d.main) return { ok: false, error: 'Quotas are read on the main machine.' }
    const on = READS.filter((p) => this.d.on(SWITCH[p]!))
    if (!on.length) return { ok: false, error: 'Every quota read is off: switch one on in Settings → Models → Quotas first.' }
    const ready = on.filter((p) => {
      const s = this.at(p)
      return !s.reading && (s.tried === undefined || now - s.tried >= ON_DEMAND)
    })
    if (!ready.length) return { ok: false, error: 'Read a minute ago, or still reading: try again in a moment.' }
    for (const p of ready) this.start(p, now)
    return { ok: true, started: ready }
  }

  /** the reads started and not yet done: a test waits for them, the screen does not */
  async settled(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running])
  }

  private start(p: string, now: number) {
    const job = this.run(p as Reads, now)
    this.running.add(job)
    void job.finally(() => this.running.delete(job))
  }

  /** one read: its figure is kept in the ledger, a failure keeps the last good one, a hint changes nothing but its words */
  private async run(p: Reads, now: number): Promise<void> {
    const s = this.at(p)
    s.reading = true
    s.tried = now
    try {
      const r = await this.d.readers[p]()
      // what this read says replaces what the last one did, the figure aside: a good one is kept, a hint or a failure is said
      s.failed = s.hint = undefined
      if ('figure' in r) {
        this.d.usage.setQuota(p, r.figure)
        this.check(p, r.figure, now)
      } else if ('hint' in r) s.hint = r.hint
      else s.failed = r.reason
    } catch {
      s.failed = 'The read stopped unexpectedly.'
      s.hint = undefined
    } finally {
      s.reading = false
      this.d.emit()
    }
  }

  /** each window at or over the warning share alerts once: again only after it refilled (its moment passed, or a new one
   *  came) or fell under the share. A window with no moment (an estimate's) alerts once until it falls under the share */
  private check(provider: string, f: QuotaFigure, now: number) {
    const at = this.d.alertAt()
    if (at === undefined) return
    for (const w of f.windows) {
      const pct = shareOf(w)
      if (pct === undefined) continue
      const key = `${provider}|${w.name}`
      const armed = this.d.usage.alerted(key)
      const refilled = w.resetAt !== undefined && w.resetAt <= now
      if (pct < at || refilled) {
        if (armed !== undefined) this.d.usage.setAlerted(key, undefined)
        continue
      }
      if (armed === (w.resetAt ?? 0)) continue
      if (armed !== undefined && w.resetAt === undefined) continue
      this.d.usage.setAlerted(key, w.resetAt ?? 0)
      const refill = w.resetAt !== undefined ? `it refills ${clock(w.resetAt)}` : f.estimate ? "it drains as its calls leave the window" : "it has no refill time"
      this.d.alert(provider, w.name, `${providerName(provider)} is at ${Math.round(pct)}%`, `${w.name} window: ${leftWords(pct)}, and ${refill}.`)
    }
  }
}
