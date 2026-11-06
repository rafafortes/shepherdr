// The human's pinned and recent models, kept for this machine alone: one small file in Shepherdr's own folder
// (model-picks.json, "kind:model id" keys, as shared/picks.ts reads them), so every browser, phone and the command
// see the same picks here, and a model pinned on one machine is not offered on another. The file is written only when
// a model is pinned or picked.
import { home, readJson, writeJson } from '../store.ts'
import { parsePicks, pickKey, picksIn, withPin, withRecent, type Picks } from '../../shared/picks.ts'

export const PICKS_FILE = 'model-picks.json'

let cache: { dir: string; picks: Picks } | undefined

/** the picks as they stand: read once, then kept as they change */
export function picks(): Picks {
  if (cache?.dir !== home()) cache = { dir: home(), picks: parsePicks(readJson(PICKS_FILE, {}, home())) }
  return cache.picks
}

/** one CLI's picks, by model id */
export function picksOf(kind: string) {
  return picksIn(picks(), kind)
}

/** a model pinned to the top of its CLI's list, or not any more: the picks after it */
export function pinModel(kind: string, id: string): Picks {
  return save(withPin(picks(), pickKey(kind, id)))
}

/** a model picked now (a restart on it, a default saved): first among the recent ones; none for the CLI's own */
export function rememberModel(kind: string, id?: string): Picks {
  if (!id || id === 'default') return picks()
  return save(withRecent(picks(), pickKey(kind, id)))
}

/** for tests: the picks as they now stand, without reading or writing the file */
export function setPicks(next: Picks) {
  cache = { dir: home(), picks: next }
}

function save(next: Picks): Picks {
  cache = { dir: home(), picks: next }
  try {
    writeJson(PICKS_FILE, next, home())
  } catch {
    /* a home that can't be written keeps the picks for this run */
  }
  return next
}
