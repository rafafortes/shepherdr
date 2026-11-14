// Which harness a role's agent starts on, by the caps (models.maxAtOnce) and by what is out now: the first of its chain
// (its primary, then its backups in order) that is not out and has room under every entry that applies to it. Pure: the
// engine (tasks, coordinators' starts and takeovers) and the advisor and reviewer runs (steps to come) call it with what
// runs now and the settings they read; nothing here reads a setting or a file.
//
// Two scopes count, and both must have room. The machine's entries (models.maxAtOnce as this machine has it) count every
// run on this machine. The space's entries (the same setting read at that space: its own value, else the machine's) count
// the runs of that space only, so a space's sub-limit sits inside the machine's total and can never raise it. Each scope
// has a model entry (`claude/claude-opus-5-5=2`) and a provider entry (`pi.spark=4`), and a model's runs count toward both
// of its entries; a model entry wins nothing, it adds its own limit.
import { BLOCKED, providerOfKey, type MaxEntry } from '../../../shared/model-caps.ts'
import { patternWords } from '../../../shared/harness.ts'

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

/** a harness that cannot start now and why: out (its provider), full under the entry named (of the machine or of the
 *  space, which counts its runs and its limit), or blocked: the entry named is 0, so nothing starts on it, now or after a
 *  wait (it is never waited for) */
export interface Blocked<H> {
  harness: H
  why: 'full' | 'out' | 'blocked'
  /** the provider, when out; the entry's pattern, when full or blocked */
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

/** the first entry of a list that covers a model key and holds its runs at the entry's number: full when they reach it, and
 *  blocked when the number is 0 (no run is needed for that: nothing starts on it) */
function capIn<H>(list: MaxEntry[], scope: 'machine' | 'space', input: ChooseInput<H>, key: string, zero: boolean) {
  for (const e of list) {
    if (!covers(e.pattern, key) || (e.max === 0) !== zero) continue
    const count = input.runs.filter((r) => covers(e.pattern, r.key) && (scope === 'machine' || r.space === input.space)).length
    if (zero || count >= e.max) return { scope, count, max: e.max, pattern: e.pattern }
  }
  return undefined
}

/** the entries that hold a model key, the blocked ones first: a machine's entry, then a space's own. Blocked (0) beats
 *  full, and full beats having room */
const holdOf = <H>(input: ChooseInput<H>, key: string) =>
  ({ blocked: capIn(input.machine, 'machine', input, key, true) ?? capIn(input.own, 'space', input, key, true), full: capIn(input.machine, 'machine', input, key, false) ?? capIn(input.own, 'space', input, key, false) })

/**
 * The decision, in order, for each harness of the chain: a machine's or a space's entry that covers it is 0 → skipped as
 * blocked; it is out now (its provider's run-outs, or the return watch's outage: `out`) → skipped as out; a machine's entry
 * that covers it is full → skipped as full; a space's own entry that covers it is full → skipped as full; else it is the
 * one. None left: the wait lists each one that can free up (full or out); when only blocked ones are left, it lists those
 * (blockedOnly), so the held row can say that nothing will start.
 */
export function choose<H>(input: ChooseInput<H>): Choice<H> {
  const skipped: Blocked<H>[] = []
  for (const [index, o] of input.options.entries()) {
    const { blocked, full } = holdOf(input, o.key)
    if (blocked) {
      skipped.push({ harness: o.harness, why: 'blocked', name: blocked.pattern, cap: { scope: blocked.scope, ...(blocked.scope === 'space' ? { space: input.space } : {}), count: blocked.count, max: 0 } })
      continue
    }
    if (o.out) {
      skipped.push({ harness: o.harness, why: 'out', name: providerOfKey(o.key.toLowerCase()), ...(o.out.until ? { until: o.out.until } : {}) })
      continue
    }
    if (full) {
      skipped.push({ harness: o.harness, why: 'full', name: full.pattern, cap: { scope: full.scope, ...(full.scope === 'space' ? { space: input.space } : {}), count: full.count, max: full.max } })
      continue
    }
    return { harness: o.harness, index, skipped }
  }
  // what can free up is waited for; a blocked option never is, so only when every one is blocked does the wait hold them
  const waitable = skipped.filter((b) => b.why !== 'blocked')
  return { wait: waitable.length ? waitable : skipped }
}

/** whether a choice found nothing to start on and nothing that can free up: every option of the chain is blocked (0
 *  allowed), so it never starts until a limit changes (the wait holds the blocked ones only) */
export const blockedOnly = <H>(c: Choice<H>): boolean => 'wait' in c && allBlocked(c.wait)

/** a wait list where every entry is blocked (0 allowed): nothing in it can free up, so nothing in it is waited for */
export const allBlocked = <H>(wait: Blocked<H>[]): boolean => wait.length > 0 && wait.every((b) => b.why === 'blocked')

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
      if (b.why === 'blocked') return `${words(b.harness)}${where} (${BLOCKED})`
      return `${words(b.harness)}${where} (${c.count} of ${c.max} at once)`
    })
    .join(', ')
}

/** a wait in short, for a row that must fit one line: the provider and how many of it run, or that it is out
 *  (`spark 4/4 · commandcode out`), a space's own sub-limit with its space's name (`spark 1/1 in app`); the full chain is
 *  the title of the row (waitWords) */
export function waitShort<H>(wait: Blocked<H>[], shown: (space: string) => string = (s) => s): string {
  // a model's own entry names the model (its provider is the row's); a provider's entry names the provider
  const name = (b: Blocked<H>) => (b.name.includes('/') ? b.name.slice(b.name.indexOf('/') + 1) : patternWords(b.name))
  return wait
    .map((b) => {
      if (b.why === 'out') return `${patternWords(providerOfKey(b.name))} out`
      const c = b.cap!
      if (b.why === 'blocked') return `${name(b)} blocked${c.scope === 'space' ? ` in ${shown(c.space!)}` : ''}`
      return `${name(b)} ${c.count}/${c.max}${c.scope === 'space' ? ` in ${shown(c.space!)}` : ''}`
    })
    .join(' · ')
}
