// Which harness a role's agent starts on, by the caps (models.maxAtOnce) and by what is out now: the first of its chain
// (its primary, then its backups in order) that is not out and has room under every entry that applies to it. Pure: the
// engine (tasks, coordinators' starts and takeovers) and the advisor and reviewer runs (steps to come) call it with what
// runs now and the settings they read; nothing here reads a setting or a file.
//
// Two scopes count, and both must have room. The machine's entries (models.maxAtOnce as this machine has it) count every
// run on this machine. The space's entries (the same setting read at that space: its own value, else the machine's) count
// the runs of that space only, so a space's sub-limit sits inside the machine's total and can never raise it. Each scope
// has a model entry (`anthropic/claude-opus-5-5=2`) and a provider entry (`spark=4`), and a model's runs count toward both
// of its entries; a model entry wins nothing, it adds its own limit.
import { providerOfKey, type MaxEntry } from '../../../shared/model-caps.ts'

/** a role that runs an agent on this machine: a task's, a coordinator's, and the headless runs (leases) of the advisor and
 *  the reviewer, which hold a slot while they run */
export type CapRole = 'task' | 'coordinator' | 'reviewer' | 'advisor'

/** one run on this machine now: the model key it runs on (keyOf: kind/model), its space, its role, and what names it (a
 *  task's id, a lease's id) */
export interface Run {
  key: string
  space: string
  role: CapRole
  id?: string
}

/** one harness of a chain, primary first: its model key, and `out` when its provider is out now (until when, if known) */
export interface Option<H> {
  harness: H
  key: string
  out?: { until?: string }
}

/** a harness that cannot start now and why: out (its provider), or full under the entry named (of the machine or of the
 *  space, which counts its runs and its limit) */
export interface Blocked<H> {
  harness: H
  why: 'full' | 'out'
  /** the provider, when out; the entry's pattern, when full */
  name: string
  cap?: { scope: 'machine' | 'space'; space?: string; count: number; max: number }
  until?: string
}

export interface ChooseInput<H> {
  /** the space the role runs for (its runs count toward the space's own entries) */
  space: string
  options: Option<H>[]
  runs: Run[]
  /** models.maxAtOnce at this machine: the machine's totals, per provider and per model */
  machine: MaxEntry[]
  /** models.maxAtOnce as read at this space: its own sub-limit inside the machine's */
  own: MaxEntry[]
}

/** the first harness that can start, with the ones before it that could not; or none can, and why each cannot */
export type Choice<H> = { harness: H; index: number; skipped: Blocked<H>[] } | { wait: Blocked<H>[] }

/** whether a cap pattern covers a model key: a model entry its key, a provider entry every model of that provider */
export const covers = (pattern: string, key: string) => {
  const k = key.toLowerCase()
  return pattern.includes('/') ? k === pattern : providerOfKey(k) === pattern
}

/** the first entry of a list that is full for a model key, and how many runs it counts there (none when it has room) */
function fullIn<H>(list: MaxEntry[], scope: 'machine' | 'space', input: ChooseInput<H>, key: string) {
  for (const e of list) {
    if (!covers(e.pattern, key)) continue
    const count = input.runs.filter((r) => covers(e.pattern, r.key) && (scope === 'machine' || r.space === input.space)).length
    if (count >= e.max) return { scope, count, max: e.max, pattern: e.pattern }
  }
  return undefined
}

/**
 * The decision, in order, for each harness of the chain: it is out now (its provider's run-outs, or the return watch's
 * outage: `out`) → skipped as out; a machine's entry that covers it is full → skipped as full; a space's own entry that
 * covers it is full → skipped as full; else it is the one. None left: the wait lists each, so the held row can name them.
 */
export function choose<H>(input: ChooseInput<H>): Choice<H> {
  const skipped: Blocked<H>[] = []
  for (const [index, o] of input.options.entries()) {
    if (o.out) {
      skipped.push({ harness: o.harness, why: 'out', name: providerOfKey(o.key.toLowerCase()), ...(o.out.until ? { until: o.out.until } : {}) })
      continue
    }
    const full = fullIn(input.machine, 'machine', input, o.key) ?? fullIn(input.own, 'space', input, o.key)
    if (full) {
      skipped.push({ harness: o.harness, why: 'full', name: full.pattern, cap: { scope: full.scope, ...(full.scope === 'space' ? { space: input.space } : {}), count: full.count, max: full.max } })
      continue
    }
    return { harness: o.harness, index, skipped }
  }
  return { wait: skipped }
}

/** a wait in words, for a card: `Codex (default) (4 of 4 at once), pi · spark/qwen… (out until 17:00)`. `words` names each
 *  harness as the chain lists it, never by its model key (a Codex default key reads openai/unknown); `shown` names a space
 *  the way it shows (a space's own sub-limit says so) */
export function waitWords<H>(wait: Blocked<H>[], o: { words?: (h: H) => string; shown?: (space: string) => string } = {}): string {
  const words = o.words ?? ((h: H) => String(h))
  const shown = o.shown ?? ((s: string) => s)
  return wait
    .map((b) => {
      if (b.why === 'out') return `${words(b.harness)} (out${b.until ? ` until ${b.until}` : ''})`
      const c = b.cap!
      const where = c.scope === 'space' ? ` in ${shown(c.space!)}` : ''
      return `${words(b.harness)}${where} (${c.count} of ${c.max} at once)`
    })
    .join(', ')
}

/** a wait in short, for a row that must fit one line: the provider and how many of it run, or that it is out
 *  (`spark 4/4 · commandcode out`), a space's own sub-limit with its space's name (`spark 1/1 in app`); the full chain is
 *  the title of the row (waitWords) */
export function waitShort<H>(wait: Blocked<H>[], shown: (space: string) => string = (s) => s): string {
  // a model's own entry names the model (its provider is the row's); a provider's entry names the provider
  const name = (b: Blocked<H>) => (b.name.includes('/') ? b.name.slice(b.name.indexOf('/') + 1) : b.name)
  return wait
    .map((b) => {
      if (b.why === 'out') return `${providerOfKey(b.name)} out`
      const c = b.cap!
      return `${name(b)} ${c.count}/${c.max}${c.scope === 'space' ? ` in ${shown(c.space!)}` : ''}`
    })
    .join(' · ')
}
