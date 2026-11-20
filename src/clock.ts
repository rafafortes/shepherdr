// One clock for every relative-time label on the screen. A snapshot that keeps its revision leaves the tree undrawn
// (PERFC-01), so words like "3m ago" or "in 6h" cannot wait for the next change to move: each label subscribes here and
// redraws itself when its own unit moves, without touching the tree around it.
import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
const notify = () => {
  for (const l of listeners) l()
}
// one interval for the whole screen, started once, at the finest unit a label shows (a second, in useElapsed)
setInterval(notify, 1000)

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** The screen's shared clock, read fresh on every draw: a minute tick for "3m ago" and "in 6h", pass 1000 for a label
 *  that shows seconds. Callers with the same step redraw together, only when that unit changes. A test can drive this
 *  clock with Playwright's fake clock, which advances Date and fires the interval without a real wait. */
export function useClock(step = 60_000): number {
  const get = () => Math.floor(Date.now() / step)
  useSyncExternalStore(subscribe, get, get)
  return Date.now()
}
