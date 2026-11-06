// The human's pinned and recent picks in a list of models: a pinned one leads its CLI's list, then the ones picked
// last, then the rest in the CLI's own order. The picks are kept by the machine that serves the screen (its home
// folder), never in a browser, so a phone sees the same ones as a desktop; each is "kind:model id", the id the CLI
// itself reported, and the same few keys are read here by the server and drawn by the screen.

export interface Picks {
  /** pinned to the top of its CLI's list, in the order each was pinned */
  pinned: string[]
  /** picked last (a restart, a saved default), newest first */
  recent: string[]
}

export const NO_PICKS: Picks = { pinned: [], recent: [] }

/** how many recent picks each CLI keeps */
export const RECENT = 5

/** a pick's key: the CLI it belongs to, and the exact id it runs */
export const pickKey = (kind: string, id: string) => `${kind}:${id}`

const keys = (x: unknown) => (Array.isArray(x) ? x.filter((k): k is string => typeof k === 'string' && k.includes(':') && k.indexOf(':') > 0) : [])
const kindOfKey = (key: string) => key.slice(0, key.indexOf(':'))

/** at most RECENT recent picks for each CLI, in the order they came, each key once */
function recentOnly(list: string[]): string[] {
  const kept = new Map<string, number>()
  return [...new Set(list)].filter((k) => {
    const kind = kindOfKey(k)
    const n = kept.get(kind) ?? 0
    kept.set(kind, n + 1)
    return n < RECENT
  })
}

/** what a kept file says, however old or damaged */
export function parsePicks(raw: unknown): Picks {
  const d = (raw ?? {}) as { pinned?: unknown; recent?: unknown }
  return { pinned: [...new Set(keys(d.pinned))], recent: recentOnly(keys(d.recent)) }
}

/** pinned, or not any more */
export function withPin(p: Picks, key: string): Picks {
  return { ...p, pinned: p.pinned.includes(key) ? p.pinned.filter((k) => k !== key) : [...p.pinned, key] }
}

/** picked now: first among the recent ones of its own CLI (each keeps RECENT), kept once */
export function withRecent(p: Picks, key: string): Picks {
  return { ...p, recent: recentOnly([key, ...p.recent.filter((k) => k !== key)]) }
}

/** the picks that belong to this CLI, by model id */
export function picksIn(p: Picks, kind: string): { pinned: string[]; recent: string[] } {
  const mine = (list: string[]) => list.filter((k) => k.startsWith(`${pickKey(kind, '')}`)).map((k) => k.slice(kind.length + 1))
  return { pinned: mine(p.pinned), recent: mine(p.recent) }
}

/** models in the order a list shows them: pinned first in their pin order, then recent (newest first), then the rest
 *  in the CLI's own order; ids here are this CLI's own */
export function orderByPicks<T extends { id: string }>(models: T[], p: { pinned: string[]; recent: string[] }): T[] {
  const rank = (m: T) => {
    const pin = p.pinned.indexOf(m.id)
    if (pin >= 0) return pin
    const recent = p.recent.indexOf(m.id)
    return recent >= 0 ? 1000 + recent : 2000
  }
  return models.map((m, i) => ({ m, i, r: rank(m) })).sort((a, b) => a.r - b.r || a.i - b.i).map(({ m }) => m)
}
