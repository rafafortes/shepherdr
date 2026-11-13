// Settings → Models → Summary: where the work runs, per provider and per model, and the warnings about it. The configured
// numbers come from the same settings the table reads (its slots, read at each space's own level, so a backup that
// inherits counts where it runs); what runs and waits now comes from the agents and the tasks as the live source has
// them; the usage and the run-outs from the ledger (usage-ledger.ts). Nothing is stored here: a read of the state, with
// `now` as a parameter so a test gives it the clock it needs. A provider's quota is its last good read (the ledger holds
// it, quotas.ts sets it), or OpenCode Go's estimate built for this look; the warning share and each read's state come in
// with the input (quota), and a window at or over the share is a warning here.
import type { MatrixRole, ModelsSummary, QuotaFigure, QuotaRead, QuotaWindow, SummaryAtOnce, SummaryConfigured, SummarySpaceCap, SummaryModel, SummaryNow, SummaryProvider, SummaryRow, SummaryRunOuts, SummaryUsage, SummaryWarning } from '../../shared/types.ts'
import { shareOf } from '../../shared/quota-words.ts'
import { parseMaxAtOnce, type MaxEntry } from '../../shared/model-caps.ts'
import type { Harness } from './engine/engine.ts'
import { covers } from './engine/choose.ts'
import { findModel, modelsOf } from './models.ts'
import { placeId } from './places.ts'
import { type Chain, kindOf, type Level, rolePairs, Settings } from './settings.ts'
import { HOUR, modelKey, modelOf, providerOf, type RunOut, type RunRole, UsageLedger, type UsageTotals } from './usage-ledger.ts'

/** a provider in words: its own name where it has one, else its id */
export const providerName = (provider: string) => NAMES[provider] ?? provider

/** the model servers with no quota, only shared, so a warning about quota skips them: the operator's own machines, and
 *  the local servers OpenCode has a provider for (LM Studio and Ollama on this machine, 127.0.0.1) */
export const LOCAL = new Set(['spark', 'radeon', 'avell', 'dell', 'lmstudio', 'ollama'])

/** a provider in words, where it has a name of its own (the others show their id): the providers OpenCode adds too
 *  (opencode is its Zen models, nvidia its NVIDIA endpoints, lmstudio and ollama its local servers) */
const NAMES: Record<string, string> = {
  anthropic: 'Claude Code',
  openai: 'Codex',
  'opencode-go': 'OpenCode Go',
  opencode: 'OpenCode Zen (free)',
  nvidia: 'NVIDIA API',
  commandcode: 'Command Code',
  openrouter: 'OpenRouter',
  spark: 'Spark (local)',
  radeon: 'Radeon (local)',
  avell: 'Avell (local)',
  dell: 'Dell (local)',
  lmstudio: 'LM Studio (local)',
  ollama: 'Ollama (local)',
}

const TITLE: Record<MatrixRole, string> = { task: 'Tasks', coordinator: 'Coordinators', reviewer: 'Reviewer', advisor: 'Advisor' }
const WINDOWS = { h5: 5 * HOUR, h24: 24 * HOUR, d7: 7 * 24 * HOUR } as const
const WEEK = 7 * 24 * HOUR
/** this many run-outs in a week is a pattern, not an accident */
const PATTERN = 2

/** a slot of the table as the settings read it at one space: its role, its primary (n 0) or backup, and its model key */
export interface ConfRec {
  key: string
  role: MatrixRole
  n: number
  space: string
  spaceKey: string
}
/** an agent of this machine: its chat, its CLI and model, and its herdr status ('gone': no pane) */
export interface LiveAgent {
  key: string
  kind: string
  model?: string
  status: string
}
/** a task, as its waiting and its agents show: its status, and the CLI and model its agent and its reviewer start on */
export interface TaskFact {
  status: string
  agent?: Harness
  reviewer?: Harness
}

/** the quota side of the summary (quotas.ts): the figures built for this look, each read's state, and the warning share */
export interface QuotaInput {
  figures: Record<string, QuotaFigure>
  reads: Record<string, QuotaRead>
  /** the share of a window at which it warns, in percent; none when off */
  alertAt?: number
}

export interface SummaryInput {
  now: number
  settings: Settings
  /** this machine's host (the table's row ids are built from it) */
  host: string
  /** the places this machine's table lists: the home space (~) and each space, by the name the sidebar gives it */
  spaces: { key: string; name: string }[]
  /** the row ids the table has (placeId.space and placeId.machine), so a warning's button can open the cell */
  rows: string[]
  usage: UsageLedger
  agents: LiveAgent[]
  tasks: TaskFact[]
  /** the outages the return watch has open (no back yet) or has seen answer (back: when), by the primary's model key */
  watch: { key: string; back?: number }[]
  /** the quota figures and reads (quotas.ts); none in a test that has no quota side */
  quota?: QuotaInput
  /** the runs that count toward models.maxAtOnce now (engine.runs): the model key each runs on, and its space's key */
  runs?: RunOn[]
  /** the entry that holds each task now waiting for a model's cap, by its name (the model key or the provider) */
  heldBy?: string[]
  /** providers to show even when nothing else names them (a provider a models.maxAtOnce entry caps, with no agent yet) */
  providers?: string[]
}

export { shareOf }

/** a run that counts toward models.maxAtOnce now: the model key it runs on, and the key of its space ('~': the home space) */
export interface RunOn {
  key: string
  space: string
}

/** a moment in words, in this machine's time: "Fri 3:00 PM" */
export const clock = (at: number) => new Date(at).toLocaleString('en', { weekday: 'short', hour: 'numeric', minute: '2-digit' })

/** a model key's model in words: its name in the CLI's own list, or its id */
export function labelOf(key: string): string {
  const provider = providerOf(key)
  const model = modelOf(key)
  // a CLI's own default model is not named in its log: the provider's name says which one it is
  if (model === 'unknown') return provider === 'opencode' ? 'OpenCode default' : `${providerName(provider)} default`
  const kind = provider === 'anthropic' ? 'claude' : provider === 'openai' ? 'codex' : 'pi'
  // pi's own list names its models with the provider in front (and OpenCode's do too): under the provider's row, that part
  // is said already. A model Claude Code or Codex names is the CLI's own word; pi's, and OpenCode's, come from their lists
  const label = (kind === 'pi' ? findModel('opencode', key)?.label : undefined) ?? findModel(kind, model)?.label ?? (model || key)
  return label.startsWith(`${provider}/`) ? label.slice(provider.length + 1) : label
}

/** a CLI's value (Settings' words, or a harness's model) as the model key it runs: the CLI's default model where it says
 *  default, the id the CLI's list has for a name it knows */
export function keyOf(kind: string, value?: string): string {
  const v = (value ?? '').trim()
  const id = !v || v.toLowerCase() === 'default' ? (modelsOf(kind)?.default ?? 'default') : (findModel(kind, v)?.id ?? v)
  return modelKey(kind, id)
}

/** the role a chat plays: a task's agent or its reviewer, else a coordinator (a place's chat) */
export const roleOfChat = (key: string): RunRole => (key.endsWith('/Reviewer') ? 'reviewer' : key.includes('/') ? 'task' : 'coordinator')

/** the table's roles, and the Settings chain each one's slots are read from */
const CHAIN: Record<MatrixRole, Chain> = { task: 'task', coordinator: 'coordinator', reviewer: 'reviewer', advisor: 'advisor' }

/** every slot of the table as the settings read it at each space: the configured counts and the warnings read these. A
 *  backup that follows its primary's model, or names one its CLI lacks, reads what the harness would start it on
 *  (Settings.modelOf), not the word written */
export function configuredOf(s: Settings, spaces: { key: string; name: string }[]): ConfRec[] {
  const places = spaces.length ? spaces : [{ key: '~', name: 'home' }]
  const out: ConfRec[] = []
  for (const sp of places) {
    const level: Level = { space: sp.key }
    for (const role of Object.keys(CHAIN) as MatrixRole[]) {
      rolePairs(CHAIN[role]).forEach((pair, n) => {
        const kind = kindOf(s.readAt(pair.cli, level).value)
        if (!kind) return
        out.push({ key: keyOf(kind, s.modelOf(pair.name, kind, sp.key).model), role, n, space: sp.name, spaceKey: sp.key })
      })
    }
  }
  return out
}

const sumUsage = (list: UsageTotals[]): SummaryUsage => {
  const t: SummaryUsage = { tokens: 0, calls: 0 }
  for (const x of list) {
    t.tokens += x.tokens
    t.calls += x.calls
    if (x.cost !== undefined) t.cost = (t.cost ?? 0) + x.cost
  }
  return t
}

/** one row (a provider's, or a model's): what matches it, counted */
function rowOf(f: SummaryInput, matches: (k: string) => boolean, conf: ConfRec[], watch: { key: string; back?: number }[], provider: string, model?: string): SummaryRow {
  const now = f.now
  const atOnce = atOnceOf(f, provider, model)
  const c: SummaryConfigured = { primary: 0, backup: 0, roles: {}, spaces: {} }
  for (const x of conf) {
    if (!matches(x.key)) continue
    if (x.n === 0) c.primary++
    else c.backup++
    c.roles[x.role] = (c.roles[x.role] ?? 0) + 1
    c.spaces[x.space] = (c.spaces[x.space] ?? 0) + 1
  }
  const n: SummaryNow = { agents: 0, working: 0, roles: {}, starts: 0, reviews: 0 }
  for (const a of f.agents) {
    if (a.status === 'gone' || !matches(keyOf(a.kind, a.model))) continue
    n.agents++
    if (a.status === 'working') n.working++
    const role = roleOfChat(a.key)
    n.roles[role] = (n.roles[role] ?? 0) + 1
  }
  for (const t of f.tasks) {
    if (t.agent && ['todo', 'queued', 'scheduled'].includes(t.status) && matches(keyOf(t.agent.kind, t.agent.model))) n.starts++
    if (t.reviewer && t.status !== 'done' && matches(keyOf(t.reviewer.kind, t.reviewer.model))) n.reviews++
  }
  const from = (w: number) => f.usage.byKey(now - w)
  const usage = { h5: sumUsage(keysOf(from(WINDOWS.h5), matches)), h24: sumUsage(keysOf(from(WINDOWS.h24), matches)), d7: sumUsage(keysOf(from(WINDOWS.d7), matches)) }
  // a watch that has not seen the primary back is an outage that goes on; one that has is its answer
  const backAt = watch.filter((w) => matches(w.key) && w.back !== undefined).reduce((a, w) => Math.max(a, w.back!), 0) || undefined
  const openWatch = watch.some((w) => matches(w.key) && w.back === undefined)
  const runs = f.usage.runOuts(matches)
  const inWeek = runs.filter((r) => r.at >= now - WEEK)
  const st = f.usage.outOf(provider, now, backAt, model)
  const last = st.last ?? runs.at(-1)
  const runOuts: SummaryRunOuts = {
    count7d: inWeek.length,
    out: st.out || openWatch,
    ...(last ? { last: lastOf(last) } : {}),
    ...(st.out && st.last?.resetAt !== undefined ? { until: st.last.resetAt } : {}),
  }
  return { configured: c, now: n, usage: { h5: usage.h5, h24: usage.h24, d7: usage.d7 }, runOuts, atOnce }
}

/** the cap of a row, as models.maxAtOnce sets it at this machine or Everywhere (this machine's text when it sets one,
 *  else Everywhere's): the entries, and the level the one that holds the row came from */
export function capsOf(s: Settings): { entries: MaxEntry[]; from: 'all' | 'machine' } {
  const pick = s.pick('models.maxAtOnce', 'machine')
  const p = parseMaxAtOnce(pick.value)
  return { entries: p.ok ? p.entries : [], from: pick.from === 'machine' ? 'machine' : 'all' }
}

/** what a provider row or a model row counts toward its cap now, its own entry, the provider's that also holds a model,
 *  the sub-limits its spaces set for it, and the tasks waiting for it. A provider row counts every agent of its provider; a
 *  model row its own agents */
function atOnceOf(f: SummaryInput, provider: string, model?: string): SummaryAtOnce {
  const { entries, from } = capsOf(f.settings)
  const runs = f.runs ?? []
  const key = model ?? provider
  const counted = model === undefined ? runs.filter((r) => providerOf(r.key) === provider) : runs.filter((r) => r.key === model)
  const own = entries.find((e) => e.pattern === key)
  const via = model !== undefined ? entries.find((e) => e.pattern === provider && !e.pattern.includes('/')) : undefined
  const held = (f.heldBy ?? []).filter((p) => p === key).length
  // a space's own text sets its sub-limits: the entry for this row, counting the runs of that space it covers
  const spaces = f.spaces.flatMap((sp): SummarySpaceCap[] => {
    const pick = f.settings.pick('models.maxAtOnce', { space: sp.key })
    const p = pick.from === 'space' ? parseMaxAtOnce(pick.value) : undefined
    const e = p?.ok ? p.entries.find((x) => x.pattern === key) : undefined
    return e ? [{ key: sp.key, name: sp.name, max: e.max, now: runs.filter((r) => r.space === sp.key && covers(key, r.key)).length }] : []
  })
  return {
    now: counted.length,
    ...(own ? { own: { pattern: own.pattern, max: own.max, from } } : {}),
    ...(via ? { via: { pattern: via.pattern, max: via.max, from } } : {}),
    ...(spaces.length ? { spaces } : {}),
    held,
  }
}

const lastOf = (r: RunOut): NonNullable<SummaryRunOuts['last']> => ({
  at: r.at,
  reason: r.reason,
  model: r.key,
  chat: r.chat,
  role: r.role,
  ...(r.reset !== undefined ? { reset: r.reset } : {}),
  ...(r.resetAt !== undefined ? { resetAt: r.resetAt } : {}),
})

/** the usage of the keys matching `matches`, as the totals a window has */
const keysOf = (byKey: Map<string, UsageTotals>, matches: (k: string) => boolean): UsageTotals[] => [...byKey].filter(([k]) => matches(k)).map(([, t]) => t)

/** the summary of this machine: its providers (each with its models), and the warnings about them */
export function modelsSummary(f: SummaryInput): ModelsSummary {
  const conf = configuredOf(f.settings, f.spaces)
  const d7 = f.usage.byKey(f.now - WEEK)
  // every provider that has a slot, runs, waits, used something in the week, or ran out in it
  const keys = new Set<string>([...conf.map((c) => c.key), ...f.agents.filter((a) => a.status !== 'gone').map((a) => keyOf(a.kind, a.model)), ...(f.runs ?? []).map((r) => r.key), ...d7.keys(), ...f.usage.runOuts(() => true).filter((r) => r.at >= f.now - WEEK).map((r) => r.key)])
  const providers = [...new Set([...[...keys].map(providerOf), ...(f.providers ?? [])])]
  const totalDay = [...f.usage.byKey(f.now - 24 * HOUR).values()].reduce((n, t) => n + t.tokens, 0)
  const totalWeek = [...d7.values()].reduce((n, t) => n + t.tokens, 0)

  const rows: SummaryProvider[] = providers.map((provider) => {
    const models = [...keys].filter((k) => providerOf(k) === provider).sort()
    const row = rowOf(f, (k) => providerOf(k) === provider, conf, f.watch, provider)
    const list: SummaryModel[] = models.map((key) => ({
      key,
      label: labelOf(key),
      ...rowOf(f, (k) => k === key, conf, f.watch, provider, key),
    }))
    const day = f.usage.byKey(f.now - 24 * HOUR)
    const tokens24 = keysOf(day, (k) => providerOf(k) === provider).reduce((n, t) => n + t.tokens, 0)
    const tokensWeek = keysOf(d7, (k) => providerOf(k) === provider).reduce((n, t) => n + t.tokens, 0)
    const quota: QuotaFigure | undefined = f.quota?.figures[provider] ?? f.usage.quota(provider)
    const quotaRead = f.quota?.reads[provider]
    return {
      provider,
      name: providerName(provider),
      local: LOCAL.has(provider),
      share: { ...(totalDay ? { h24: tokens24 / totalDay } : {}), ...(totalWeek ? { d7: tokensWeek / totalWeek } : {}) },
      ...(quota ? { quota } : {}),
      ...(quotaRead ? { quotaRead } : {}),
      ...row,
      models: list,
    }
  })
  rows.sort((a, b) => b.usage.d7.tokens - a.usage.d7.tokens || a.name.localeCompare(b.name))
  const warnings = [...warningsOf(f, conf, rows), ...quotaWarningsOf(f, conf, rows)]
  return { at: f.now, ...(f.usage.backfilled !== undefined ? { backfilled: f.usage.backfilled } : {}), providers: rows, warnings, caps: capsTextOf(f) }
}

/** models.maxAtOnce as each level holds its own text ('' where it sets none), this machine's place a write goes to, and
 *  each space's own text with its place (the home space's is placeId.home) */
function capsTextOf(f: SummaryInput): ModelsSummary['caps'] {
  const own = (level: 'all' | 'machine') => {
    const pick = f.settings.pick('models.maxAtOnce', level === 'all' ? 'all' : 'machine')
    return pick.from === level ? pick.value : ''
  }
  const spaces = f.spaces.map((sp) => {
    const pick = f.settings.pick('models.maxAtOnce', { space: sp.key })
    return { key: sp.key, name: sp.name, place: sp.key === '~' ? placeId.home(f.host) : placeId.space(sp.key, f.host), text: pick.from === 'space' ? pick.value : '' }
  })
  return { all: own('all'), machine: own('machine'), place: placeId.machine(f.host), spaces }
}

/** the rule-based warnings: each is a fact about the settings or a provider now, with its fix in words, and a button into
 *  the cell that changes it where a setting does. Risks first. Local models and what the operator chose with no risk
 *  (the same model on both, a backup that is the primary's model on a local server) are not warned about. */
function warningsOf(f: SummaryInput, conf: ConfRec[], rows: SummaryProvider[]): SummaryWarning[] {
  const out: SummaryWarning[] = []
  const byName = new Map(rows.map((r) => [r.provider, r]))
  const outOf = (provider: string) => byName.get(provider)?.runOuts.out ?? false
  const label = (provider: string) => byName.get(provider)?.name ?? provider
  const rowIdOf = (spaceKey: string) => (f.rows.includes(placeId.space(spaceKey, f.host)) ? placeId.space(spaceKey, f.host) : placeId.machine(f.host))
  const runsWords = (provider: string) => {
    const last = byName.get(provider)?.runOuts.last
    return last ? `${label(provider)}: ${last.reason.charAt(0).toLowerCase()}${last.reason.slice(1)}` : `${label(provider)}: its return is not seen yet`
  }
  const places = [...new Map(conf.map((c) => [c.spaceKey, c])).values()]
  for (const sp of places) {
    const here = conf.filter((c) => c.spaceKey === sp.spaceKey)
    const roles = (['task', 'coordinator', 'reviewer', 'advisor'] as MatrixRole[]).filter((r) => here.some((c) => c.role === r))
    for (const role of roles) {
      const slots = here.filter((c) => c.role === role).sort((a, b) => a.n - b.n)
      const primary = slots.find((c) => c.n === 0)
      const slotId = (n: number) => `${role}.${n}`
      // a role whose every slot sits on a provider that is out now: nothing of it runs but by hand
      if (slots.length && slots.every((c) => outOf(providerOf(c.key)))) {
        out.push({
          id: `out:${sp.spaceKey}:${role}`,
          level: 'risk',
          words: `${TITLE[role]} in ${sp.space}: the primary and every backup are out now (${[...new Set(slots.map((c) => providerOf(c.key)))].map(runsWords).join('; ')}).`,
          fix: `Give ${TITLE[role]} a backup on another provider, or wait: the primary is tried again once it answers.`,
          go: { row: rowIdOf(sp.spaceKey), slot: slotId(1) },
        })
      }
      // a backup that is the primary's model on a cloud provider: it runs out with the primary
      if (primary) {
        for (const b of slots.filter((c) => c.n > 0 && c.key === primary.key && !LOCAL.has(providerOf(c.key)))) {
          out.push({
            id: `same:${sp.spaceKey}:${role}:${b.n}`,
            level: 'note',
            words: `${TITLE[role]} · Backup ${b.n} in ${sp.space} is the same model as its primary (${labelOf(b.key)}): when the primary runs out, the backup runs out with it.`,
            fix: 'Pick another provider or another model for it.',
            go: { row: rowIdOf(sp.spaceKey), slot: slotId(b.n) },
          })
        }
      }
    }
    // every role that runs runs on one cloud provider, and no backup of any role is elsewhere
    const active = roles.filter((r) => here.some((c) => c.role === r && c.n === 0))
    const providersHere = [...new Set(here.map((c) => providerOf(c.key)))]
    if (active.length >= 2 && providersHere.length === 1 && !LOCAL.has(providersHere[0]!)) {
      out.push({
        id: `single:${sp.spaceKey}`,
        level: 'note',
        words: `Every role in ${sp.space} runs on ${label(providersHere[0]!)}, and no backup is on another provider: one run-out of its allowance stops all of them.`,
        fix: `Give one role a backup on another provider (Tasks · Backup 1, say).`,
        go: { row: rowIdOf(sp.spaceKey), slot: 'task.1' },
      })
    }
  }
  for (const r of rows) {
    if (r.runOuts.count7d >= PATTERN && !r.local) {
      out.push({
        id: `runouts:${r.provider}`,
        level: 'note',
        words: `${r.name} ran out ${r.runOuts.count7d} times in the last 7 days; the last was ${r.runOuts.last ? r.runOuts.last.reason.toLowerCase() : 'not recorded'}.`,
        fix: 'Spread the work over other providers with backups, or check the plan it runs on.',
      })
    }
  }
  // a local model several working agents share: with no cap on it (models.maxAtOnce, its own or its provider's) a note asks
  // for one; at its cap, the tasks it holds say so
  for (const r of rows) {
    if (!r.local) continue
    if (r.atOnce.own && r.atOnce.held) {
      out.push({ id: `held:${r.provider}`, level: 'note', words: `Held tasks wait for ${r.name.replace(' (local)', '')}: its cap of ${r.atOnce.own.max} at once is full (${r.atOnce.now} running).`, go: { row: 'cap', slot: r.provider } })
    }
    for (const m of r.models) {
      const cap = m.atOnce.own ?? m.atOnce.via
      if (!cap) {
        if (m.now.working < 2) continue
        out.push({ id: `shared:${m.key}`, level: 'note', words: `${m.now.working} agents on ${r.name.replace(' (local)', '')} now (${m.label}), and no cap holds them: set a cap for it.`, fix: 'A cap says how many run at once; the others wait for a free slot.', go: { row: 'cap', slot: m.key } })
        continue
      }
      if (m.atOnce.own && m.atOnce.held) {
        out.push({ id: `held:${m.key}`, level: 'note', words: `Held tasks wait for ${m.label}: ${cap.pattern} takes ${cap.max} at once and ${m.atOnce.now} run there now.`, go: { row: 'cap', slot: m.key } })
      }
    }
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'risk' ? -1 : 1))
}

/** what is left of a window in words: its share used against 100 (an estimate past its learned limit is over it) */
export const leftWords = (share: number) => (share > 100 ? 'over its limit' : share === 100 ? 'at its limit' : `${Math.round(100 - share)}% left`)

/** the windows that are at or over the warning share and not refilled by `now`: a window that refilled says nothing of now */
export function overWindows(q: QuotaFigure, at: number, now: number): { w: QuotaWindow; share: number }[] {
  return q.windows.flatMap((w) => {
    const share = shareOf(w)
    return share !== undefined && share >= at && (w.resetAt === undefined || w.resetAt > now) ? [{ w, share }] : []
  })
}

/** the quota warnings: a provider's window at or over quota.alertAt, what is left and when it refills, and the cells that
 *  use it most (the configured slots of this provider, by role and space). Local servers have no quota: not warned about */
function quotaWarningsOf(f: SummaryInput, conf: ConfRec[], rows: SummaryProvider[]): SummaryWarning[] {
  const at = f.quota?.alertAt
  if (at === undefined) return []
  const rowIdOf = (spaceKey: string) => (f.rows.includes(placeId.space(spaceKey, f.host)) ? placeId.space(spaceKey, f.host) : placeId.machine(f.host))
  const out: SummaryWarning[] = []
  for (const r of rows) {
    if (r.local || !r.quota) continue
    const over = overWindows(r.quota, at, f.now)
    if (!over.length) continue
    const words = over.map(({ w, share }) => `${w.name} is at ${Math.round(share)}%: ${leftWords(share)}${w.resetAt !== undefined ? `, refills ${clock(w.resetAt)}` : ''}`).join('; ')
    // the cells that use it most: the configured slots of this provider, counted by role and space, the top two
    const cells = new Map<string, { role: MatrixRole; spaceKey: string; space: string; n: number }>()
    for (const c of conf.filter((x) => providerOf(x.key) === r.provider)) {
      const k = `${c.spaceKey}|${c.role}`
      const cell = cells.get(k) ?? { role: c.role, spaceKey: c.spaceKey, space: c.space, n: 0 }
      cell.n++
      cells.set(k, cell)
    }
    const top = [...cells.values()].sort((a, b) => b.n - a.n || a.space.localeCompare(b.space)).slice(0, 2)
    const using = top.map((c) => `${TITLE[c.role]} in ${c.space} (${c.n} ${c.n === 1 ? 'slot' : 'slots'})`).join(' and ')
    const warning: SummaryWarning = {
      id: `quota:${r.provider}`,
      level: over.some((x) => x.share >= 100) ? 'risk' : 'note',
      words: `${r.name}: ${words}.`,
      fix: top.length
        ? `Most of its slots are ${using}. Give one of them a backup on another provider, or let the window refill before the work does.`
        : 'Give its roles a backup on another provider, or let the window refill before the work does.',
      ...(top[0] ? { go: { row: rowIdOf(top[0].spaceKey), slot: `${top[0].role}.0` } } : {}),
    }
    out.push(warning)
  }
  return out
}
