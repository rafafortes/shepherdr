// One clock for every relative-time label on the screen. A snapshot that keeps its revision leaves the tree undrawn
// (PERFC-01), so words like "3m ago" or "in 6h" cannot wait for the next change to move: each label subscribes here and
// redraws itself when its own unit moves, without touching the tree around it.
import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
// the test hook's clock, never set by the app
let fake: number | null = null
let version = 0
const now = () => fake ?? Date.now()
/** the store value is only a unit index and a version: the index changes when that unit moves, so React redraws a
 *  minute label once a minute and a seconds label once a second; the version makes an injected clock redraw even
 *  inside the same minute. The reading itself is taken fresh at render time, so a countdown that starts "in 6h" is
 *  not a second short because an earlier render sampled the clock. */
const snapshot = (step: number) => `${version}:${Math.floor(now() / step)}`
const notify = () => {
  for (const l of listeners) l()
}
setInterval(notify, 1000)

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** The screen's shared clock, read fresh on every draw: a minute tick for "3m ago" and "in 6h", pass 1000 for a label
 *  that shows seconds. Callers with the same step redraw together, only when that unit changes. */
export function useClock(step = 60_000): number {
  useSyncExternalStore(
    subscribe,
    () => snapshot(step),
    () => snapshot(step),
  )
  return now()
}

/** Test hook: move the clock and redraw every label, with no wait and no snapshot. The app never calls it. */
export function setClock(at: number) {
  fake = at
  version++
  notify()
}
