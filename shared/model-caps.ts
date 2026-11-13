// The most agents at once per model or per provider (models.maxAtOnce): one text setting, `spark=4, radeon=1`, read by
// the server (settings, the tasks' gate) and drawn by the Models page. An entry's pattern is a provider (`spark`: every
// `spark/…` model) or a model key (`spark/qwen3.8-flash-next-mlx4-mtp-tensorfold`, `anthropic/claude-opus-5-5`); a model
// entry wins over its provider's. Patterns are lowercase, as the model keys are kept.

/** the most entries one setting holds: a few providers and the models that need their own limit */
import type { SummaryAtOnce, SummarySpaceCap } from './types.ts'

export const MAX_CAP_ENTRIES = 20
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
export const CAP_HINT = 'Write provider=number or model=number, separated by commas: spark=4, anthropic/claude-opus-5-5=2 (1 to 200 each), or off.'

/**
 * The entries a setting's text holds, or why it can't be read. Empty and off are no entries. A pattern is lowercased; a
 * number is whole and from 1 to 200; a pattern given twice is refused, so is an entry past MAX_CAP_ENTRIES.
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
    if (!/^\d+$/.test(num) || Number(num) < 1 || Number(num) > MAX_CAP) return { ok: false, error: `${pattern} needs a whole number from 1 to ${MAX_CAP}, not "${num || 'nothing'}". ${CAP_HINT}` }
    if (entries.some((e) => e.pattern === pattern)) return { ok: false, error: `${pattern} is set twice. ${CAP_HINT}` }
    entries.push({ pattern, max: Number(num) })
  }
  if (entries.length > MAX_CAP_ENTRIES) return { ok: false, error: `At most ${MAX_CAP_ENTRIES} entries. ${CAP_HINT}` }
  return { ok: true, entries }
}

/** the setting's text for some entries, in the order given ("" for none: off) */
export function formatMaxAtOnce(entries: MaxEntry[]): string {
  return entries.map((e) => `${e.pattern}=${e.max}`).join(', ')
}

/** the entry that caps a model key: its own model entry when there is one, else its provider's; none when neither */
export function capFor(entries: MaxEntry[], key: string): MaxEntry | undefined {
  const k = key.toLowerCase()
  return entries.find((e) => e.pattern === k) ?? entries.find((e) => e.pattern === providerOfKey(k) && !e.pattern.includes('/'))
}

/** a space's sub-limit under a row, in words: its name, what of its runs count under it now, and its cap (`lyvora-app: 1 of 2 at once`) */
export const spaceCapWords = (s: SummarySpaceCap) => `${s.name}: ${s.now} of ${s.max} at once`

/** a row's cap in words: what runs now, its own cap, or the provider's that holds it, and what waits for it */
export function atOnceWords(a: SummaryAtOnce): { words: string; title: string } {
  const where = (from: 'all' | 'machine') => (from === 'machine' ? 'this machine' : 'Everywhere')
  const held = a.held ? ` · ${a.held} held` : ''
  if (a.own) return { words: `${a.now} of ${a.own.max} at once${held}`, title: `Its cap: ${a.own.pattern}=${a.own.max}, set ${where(a.own.from)}. Click to change.` }
  if (a.via) return { words: `${a.now} at once · no cap of its own${held}`, title: `Held by ${a.via.pattern}=${a.via.max}, set ${where(a.via.from)}. Click to set its own.` }
  return { words: `${a.now} at once · no cap${held}`, title: 'No cap for this row. Click to set one.' }
}
