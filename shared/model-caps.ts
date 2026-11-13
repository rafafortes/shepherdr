// The most agents at once per model or per provider (models.maxAtOnce): one text setting, `spark=4, radeon=1`, read by
// the server (settings, the tasks' gate) and drawn by the Models page. An entry's pattern is a provider (`spark`: every
// `spark/…` model) or a model key (`spark/qwen3.8-flash-next-mlx4-mtp-tensorfold`, `anthropic/claude-opus-5-5`); a model
// entry wins over its provider's. Patterns are lowercase, as the model keys are kept. A number is 0 to 200: 0 BLOCKS the
// model, so nothing starts on it (never waits for it either); no entry is no cap (unlimited), and off is no caps at all.

import type { SummaryAtOnce, SummarySpaceCap } from './types.ts'

/** the most entries one setting holds: every provider and model of the CLIs (five of them, each with many models) can
 *  have its own limit; the bound only keeps a runaway text out */
export const MAX_CAP_ENTRIES = 200
/** the highest number an entry may hold */
export const MAX_CAP = 200

/** one entry: a provider or a model key, and how many agents at once it may have on this machine */
export interface MaxEntry {
  pattern: string
  max: number
}

/** a model key's provider: the prefix before the first "/" (the same as the usage ledger's) */
export const providerOfKey = (key: string) => (key.includes('/') ? key.slice(0, key.indexOf('/')) : key)

/** a pattern: a provider id (letters, digits, dots, dashes), or a model key with one "/" or more after its provider */
const PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._:@+\-/[\]]*)?$/

/** the setting's words for a bad value, one line for the refusal and the hint */
export const CAP_HINT = 'Write provider=number or model=number, separated by commas: spark=4, anthropic/claude-opus-5-5=2 (0 to 200 each; 0 blocks it), or off.'

/**
 * The entries a setting's text holds, or why it can't be read. Empty and off are no entries. A pattern is lowercased; a
 * number is whole and from 0 to 200 (0 blocks the model); a pattern given twice is refused, so is an entry past MAX_CAP_ENTRIES.
 */
export function parseMaxAtOnce(text: string): { ok: true; entries: MaxEntry[] } | { ok: false; error: string } {
  const raw = text.trim()
  if (!raw || raw.toLowerCase() === 'off') return { ok: true, entries: [] }
  const entries: MaxEntry[] = []
  for (const part of raw.split(',')) {
    const bit = part.trim()
    if (!bit) return { ok: false, error: `An entry is empty. ${CAP_HINT}` }
    const eq = bit.lastIndexOf('=')
    const pattern = eq < 0 ? '' : bit.slice(0, eq).trim().toLowerCase()
    const num = eq < 0 ? '' : bit.slice(eq + 1).trim()
    if (!PATTERN.test(pattern)) return { ok: false, error: `${bit.slice(0, eq < 0 ? undefined : eq).trim() || bit} is no provider or model. ${CAP_HINT}` }
    if (!/^\d+$/.test(num) || Number(num) > MAX_CAP) return { ok: false, error: `${pattern} needs a whole number from 0 to ${MAX_CAP}, not "${num || 'nothing'}". ${CAP_HINT}` }
    if (entries.some((e) => e.pattern === pattern)) return { ok: false, error: `${pattern} is set twice. ${CAP_HINT}` }
    entries.push({ pattern, max: Number(num) })
  }
  if (entries.length > MAX_CAP_ENTRIES) return { ok: false, error: `At most ${MAX_CAP_ENTRIES} entries. ${CAP_HINT}` }
  return { ok: true, entries }
}

/** the text a cap write starts from at a level: this machine's (Everywhere's, while it sets none), Everywhere's, or a space's
 *  OWN text only. A space that sets none starts from nothing, never from the machine's entries: copying them there would
 *  freeze them in the space, so a later change of the machine would not reach it */
export function levelText(level: 'all' | 'machine' | 'space', t: { all: string; machine: string; space: string }): string {
  return level === 'all' ? t.all : level === 'machine' ? t.machine || t.all : t.space
}

/** a level's text with one entry set to `max`, or with the entry taken out when `max` is undefined: the other entries of
 *  the text stay as they are (an unreadable text keeps none of them) */
export function withEntry(text: string, pattern: string, max?: number): string {
  const p = parseMaxAtOnce(text)
  const entries = (p.ok ? p.entries : []).filter((e) => e.pattern !== pattern)
  if (max !== undefined) entries.push({ pattern, max })
  return formatMaxAtOnce(entries)
}

/** the setting's text for some entries, in the order given ("" for none: off) */
export function formatMaxAtOnce(entries: MaxEntry[]): string {
  return entries.map((e) => `${e.pattern}=${e.max}`).join(', ')
}

/** a model's own limit lowered to its provider's: the model, the number it had, and the one it has now */
export interface Lowered {
  pattern: string
  from: number
  to: number
}

/**
 * The entries of one level with each model's own limit no higher than its provider's limit at that level (the provider's
 * total holds every model of it, so a model's own number above it would never be reached and only misleads). A provider
 * that is blocked (0) or has no entry lowers nothing: blocking is a choice of its own, and unblocking it gives each model
 * back the number it had. The entries keep their order; `lowered` names each one that changed.
 */
export function fitToProviders(entries: MaxEntry[]): { entries: MaxEntry[]; lowered: Lowered[] } {
  const lowered: Lowered[] = []
  const fitted = entries.map((e) => {
    if (!e.pattern.includes('/')) return e
    const provider = entries.find((p) => p.pattern === providerOfKey(e.pattern) && !p.pattern.includes('/'))
    if (!provider || provider.max === 0 || e.max <= provider.max) return e
    lowered.push({ pattern: e.pattern, from: e.max, to: provider.max })
    return { pattern: e.pattern, max: provider.max }
  })
  return { entries: fitted, lowered }
}

/** the models a write lowers to their provider's limit, in words: `spark/qwen… from 3 to 2 (spark allows 2 at once)` */
export const loweredWords = (lowered: Lowered[]) => lowered.map((l) => `${l.pattern} from ${l.from} to ${l.to} (${providerOfKey(l.pattern)} allows ${l.to} at once)`).join(', ')

/** the entry that caps a model key: its own model entry when there is one, else its provider's; none when neither */
export function capFor(entries: MaxEntry[], key: string): MaxEntry | undefined {
  const k = key.toLowerCase()
  return entries.find((e) => e.pattern === k) ?? entries.find((e) => e.pattern === providerOfKey(k) && !e.pattern.includes('/'))
}

/** the words of a blocked cap (0 allowed): the one a row has, or the sub-limit a space sets; what runs on it still runs */
export const BLOCKED = 'blocked · 0 allowed'

/** a space's sub-limit under a row, in words: its name, what of its runs count under it now, and its cap (`lyvora-app: 1 of 2 at once`);
 *  blocked (0): `lyvora-app: blocked · 0 allowed` */
export const spaceCapWords = (s: SummarySpaceCap) => `${s.name}: ${s.max === 0 ? BLOCKED : `${s.now} of ${s.max} at once`}`

/** a row's cap in words: what runs now, its own cap, or the provider's that holds it, and what waits for it. `blocked`: the
 *  cap is 0, so the row is blocked (BLOCKED) and whatever still runs on it goes on */
export function atOnceWords(a: SummaryAtOnce): { words: string; title: string; blocked: boolean } {
  const where = (from: 'all' | 'machine') => (from === 'machine' ? 'this machine' : 'Everywhere')
  const held = a.held ? ` · ${a.held} held` : ''
  if (a.own?.max === 0) return { words: `${BLOCKED}${a.now ? ` · ${a.now} still running` : ''}${held}`, title: `Blocked: ${a.own.pattern}=0, set ${where(a.own.from)}. Nothing new starts on it; what runs now goes on. Click to change.`, blocked: true }
  if (a.own) return { words: `${a.now} of ${a.own.max} at once${held}`, title: `Its cap: ${a.own.pattern}=${a.own.max}, set ${where(a.own.from)}. Click to change.`, blocked: false }
  if (a.via?.max === 0) return { words: `${BLOCKED} (by ${a.via.pattern})${a.now ? ` · ${a.now} still running` : ''}${held}`, title: `Blocked by ${a.via.pattern}=0, set ${where(a.via.from)}. Nothing new starts on it; what runs now goes on. Click to set its own.`, blocked: true }
  if (a.via) return { words: `${a.now} at once · no cap of its own${held}`, title: `Held by ${a.via.pattern}=${a.via.max}, set ${where(a.via.from)}. Click to set its own.`, blocked: false }
  return { words: `${a.now} at once · no cap${held}`, title: 'No cap for this row. Click to set one.', blocked: false }
}
