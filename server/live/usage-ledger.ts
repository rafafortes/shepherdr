// The usage ledger: what each model of each provider used, by the hour, read from the logs of Shepherdr's own agents
// (usage-feed.ts), and each provider's run-outs (retry.ts runOutOf), kept in usage.json in Shepherdr's home. Nothing
// here reads a log or a provider: a count is what the logs said when they were read, and a provider's quota figure
// (quota: a read of its own, 4b) is set by whoever reads it. Settings → Models → Summary reads it (models-summary.ts).
//
// Shape: usage is provider/model → hour (ms ÷ 3,600,000) → { tokens, calls, cost? }; the hours go back KEEP_USAGE (35
// days). Windows are whole hours: the hour a window starts in counts whole, so "the last 5 h" is 5 to 6 hours.
// Dedupe: a call is counted once per chat, by the call's own id (readers/: Claude Code's message id, pi's message id,
// Codex's file and offset). A resumed session copies the calls before it into its new log file, so the ids repeat
// across a chat's files, and a per-file position alone would count them twice; a per-chat set of the ids inside the
// window does not, and a restart re-reads nothing it has counted. The ids go back as far as the usage does.
import { home, readJson, writeJson } from '../store.ts'

export const HOUR = 3_600_000
/** how far back usage and the ids that dedupe it are kept: a call older than this is not counted at all */
export const KEEP_USAGE = 35 * 24 * HOUR
/** how far back run-outs are kept */
export const KEEP_RUNOUTS = 60 * 24 * HOUR
/** a change is written this long after it was made, once (not on each call) */
const SAVE_AFTER = 5_000

/** the role of the chat a run-out cut off: a task's agent, a task's reviewer, a coordinator (a chat of a place) */
export type RunRole = 'task' | 'reviewer' | 'coordinator'

export interface Bucket {
  tokens: number
  calls: number
  /** pi's own cost estimate, in dollars, summed over the calls that had one */
  cost?: number
}

/** one provider's run-out: its allowance or credit used up in a chat's turn (retry.ts) */
export interface RunOut {
  /** when the cut-off turn's log says it happened */
  at: number
  /** the model key it ran on (provider/model) */
  key: string
  /** the chat (agent) it cut off */
  chat: string
  role: RunRole
  /** the reason in words, as retry.ts says it ("Out of allowance until 5pm", "Out of credit") */
  reason: string
  /** the provider's words, a few hundred characters */
  words: string
  /** when it resets, as the words show it (ISO times in local time), and when, for an ISO time */
  reset?: string
  resetAt?: number
}

/** one window of a provider's quota (4b's figure; the summary shows what it is given): used as a share or a count,
 *  against a cap, and when it refills */
export interface QuotaWindow {
  name: string
  usedPct?: number
  used?: number
  cap?: number
  resetAt?: number
}

/** a provider's quota as a read of its own says it: its windows, where the read came from and when, and whether the
 *  numbers are an estimate (pi's catalog cost, say) */
export interface QuotaFigure {
  windows: QuotaWindow[]
  source: string
  at: number
  estimate?: boolean
}

export interface UsageTotals {
  tokens: number
  calls: number
  cost?: number
}

interface Stored {
  usage: Record<string, Record<string, Bucket>>
  /** per chat: each counted call id, with its hour */
  seen: Record<string, Record<string, number>>
  runOuts: RunOut[]
  quotas: Record<string, QuotaFigure>
  /** per log file: its inode and the offset of the first line not read (usage-feed.ts) */
  files: Record<string, { ino: number; offset: number }>
  /** when the first read of every log of Shepherdr's agents was done: the backfill, done once */
  backfilled?: number
}

const fresh = (): Stored => ({ usage: {}, seen: {}, runOuts: [], quotas: {}, files: {} })

/** the CLI's provider: Claude Code's models are Anthropic's (the Claude subscription), Codex's are OpenAI's */
const PROVIDER_OF: Record<string, string> = { claude: 'anthropic', 'claude-code': 'anthropic', codex: 'openai' }

/** a model's key, provider/model: pi's model ids carry their provider already (spark/qwen3.8-…, commandcode/deepseek/…);
 *  a model the logs don't name is "unknown" */
export function modelKey(cli: string, model?: string): string {
  const name = model && model !== 'default' ? model : 'unknown'
  if (cli === 'pi') return name.includes('/') ? name : `pi/${name}`
  return `${PROVIDER_OF[cli] ?? cli}/${name}`
}

/** a model key's provider: the prefix before the first "/" */
export const providerOf = (key: string) => (key.includes('/') ? key.slice(0, key.indexOf('/')) : key)

/** a model key's model id (the rest after the provider) */
export const modelOf = (key: string) => (key.includes('/') ? key.slice(key.indexOf('/') + 1) : '')

/** whether a provider or model is out right now. A known reset decides (out until it). Without one, out until the
 *  return watch says its primary is back (backAt, after the run-out), or until a call of it went through after the
 *  run-out (successAfter). The last run-out is the one that counts. */
export function outState(runOuts: RunOut[], successAfter: (at: number) => boolean, now: number, backAt?: number): { out: boolean; last?: RunOut } {
  const last = runOuts.reduce<RunOut | undefined>((a, r) => (!a || r.at > a.at ? r : a), undefined)
  if (!last) return { out: false }
  if (last.resetAt !== undefined) return { out: last.resetAt > now, last }
  if (backAt !== undefined && backAt >= last.at) return { out: false, last }
  return { out: !successAfter(last.at), last }
}

export class UsageLedger {
  private data: Stored
  private timer?: ReturnType<typeof setTimeout>
  private dirty = false

  /** dir: where usage.json is kept (Shepherdr's home by default); memory: nothing is written (the demo's world) */
  constructor(
    private dir: string = home(),
    private memory = false,
  ) {
    this.data = memory ? fresh() : readJson<Stored>('usage.json', fresh(), dir)
    for (const k of ['usage', 'seen', 'quotas', 'files'] as const) this.data[k] ??= {}
    this.data.runOuts ??= []
    this.prune(Date.now())
  }

  /** counts one model call of a chat, once: false when it was counted already, or is older than the window */
  count(chat: string, key: string, c: { id: string; at: number; tokens: number; cost?: number }, now = Date.now()): boolean {
    if (c.at < now - KEEP_USAGE || c.tokens <= 0) return false
    const seen = (this.data.seen[chat] ??= {})
    if (Object.hasOwn(seen, c.id)) return false
    const hour = Math.floor(c.at / HOUR)
    seen[c.id] = hour
    const b = ((this.data.usage[key] ??= {})[hour] ??= { tokens: 0, calls: 0 })
    b.tokens += c.tokens
    b.calls += 1
    if (c.cost !== undefined) b.cost = (b.cost ?? 0) + c.cost
    this.save()
    return true
  }

  /** a run-out, once per chat and time. `wasOut`: its provider was out already before it (the caller alerts only the
   *  first of an outage) */
  runOut(r: RunOut, now = Date.now()): { wasOut: boolean; added: boolean } {
    const wasOut = this.outOf(providerOf(r.key), now).out
    if (r.at < now - KEEP_RUNOUTS || this.data.runOuts.some((x) => x.chat === r.chat && x.at === r.at)) return { wasOut, added: false }
    this.data.runOuts.push(r)
    this.save()
    return { wasOut, added: true }
  }

  /** the run-outs of the keys matching `match`, the newest last */
  runOuts(match: (key: string) => boolean): RunOut[] {
    return this.data.runOuts.filter((r) => match(r.key)).sort((a, b) => a.at - b.at)
  }

  /** whether a provider (or, with `model`, one of its model keys) is out right now: outState over its run-outs, where a
   *  call of it after one counts as its answer */
  outOf(provider: string, now: number, backAt?: number, model?: string): { out: boolean; last?: RunOut } {
    const match = (k: string) => (model ? k === model : providerOf(k) === provider)
    const lastHour = this.lastCallHour(match)
    return outState(this.runOuts(match), (at) => lastHour > Math.floor(at / HOUR), now, backAt)
  }

  /** what each model key used since `from` (whole hours: the hour `from` falls in counts) */
  byKey(from: number): Map<string, UsageTotals> {
    const out = new Map<string, UsageTotals>()
    const first = Math.floor(from / HOUR)
    for (const [key, hours] of Object.entries(this.data.usage)) {
      const t: UsageTotals = { tokens: 0, calls: 0 }
      for (const [h, b] of Object.entries(hours)) {
        if (Number(h) < first) continue
        t.tokens += b.tokens
        t.calls += b.calls
        if (b.cost !== undefined) t.cost = (t.cost ?? 0) + b.cost
      }
      if (t.calls) out.set(key, t)
    }
    return out
  }

  /** the totals of several model keys added up */
  sum(list: UsageTotals[]): UsageTotals {
    const t: UsageTotals = { tokens: 0, calls: 0 }
    for (const x of list) {
      t.tokens += x.tokens
      t.calls += x.calls
      if (x.cost !== undefined) t.cost = (t.cost ?? 0) + x.cost
    }
    return t
  }

  /** the latest hour a call of the keys matching `match` was counted in (0: none) */
  private lastCallHour(match: (key: string) => boolean): number {
    let last = 0
    for (const [key, hours] of Object.entries(this.data.usage)) {
      if (!match(key)) continue
      for (const [h, b] of Object.entries(hours)) if (b.calls && Number(h) > last) last = Number(h)
    }
    return last
  }

  /** a provider's quota figure as it was last set (4b's read), or none */
  quota(provider: string): QuotaFigure | undefined {
    return this.data.quotas[provider]
  }

  /** sets (or with none, clears) a provider's quota figure */
  setQuota(provider: string, q: QuotaFigure | undefined) {
    if (q) this.data.quotas[provider] = q
    else delete this.data.quotas[provider]
    this.save()
  }

  /** where a log file's reading stands (usage-feed.ts), or none for a file not read yet */
  position(file: string): { ino: number; offset: number } | undefined {
    return this.data.files[file]
  }

  setPosition(file: string, p: { ino: number; offset: number }) {
    this.data.files[file] = p
    this.save()
  }

  /** keeps the positions of the files given, and forgets the rest (their chats are gone from the agents' records) */
  keepFiles(files: Set<string>) {
    const gone = Object.keys(this.data.files).filter((f) => !files.has(f))
    if (!gone.length) return
    for (const f of gone) delete this.data.files[f]
    this.save()
  }

  /** the first read of every log is done: the backfill is not run again */
  get backfilled(): number | undefined {
    return this.data.backfilled
  }

  markBackfilled(at = Date.now()) {
    if (this.data.backfilled !== undefined) return
    this.data.backfilled = at
    this.save()
  }

  /** drops what is older than the windows: buckets and ids past KEEP_USAGE, run-outs past KEEP_RUNOUTS */
  prune(now: number) {
    const cutHour = Math.floor((now - KEEP_USAGE) / HOUR)
    for (const [key, hours] of Object.entries(this.data.usage)) {
      for (const h of Object.keys(hours)) if (Number(h) < cutHour) delete hours[h]
      if (!Object.keys(hours).length) delete this.data.usage[key]
    }
    for (const [chat, ids] of Object.entries(this.data.seen)) {
      for (const [id, h] of Object.entries(ids)) if (h < cutHour) delete ids[id]
      if (!Object.keys(ids).length) delete this.data.seen[chat]
    }
    this.data.runOuts = this.data.runOuts.filter((r) => r.at >= now - KEEP_RUNOUTS)
  }

  /** writes what changed, now (a test, the end of a run) or with the next save */
  flush(now = Date.now()) {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.dirty || this.memory) return
    this.dirty = false
    this.prune(now)
    writeJson('usage.json', this.data, this.dir)
  }

  stop() {
    this.flush()
  }

  private save() {
    this.dirty = true
    if (this.memory || this.timer) return
    this.timer = setTimeout(() => this.flush(), SAVE_AFTER)
    this.timer.unref?.()
  }
}
