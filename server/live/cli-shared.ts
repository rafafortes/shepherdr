// Helpers shared by server/live/source.ts and the extracted CLI verb surface (SHE-160).

import type { Task } from '../../shared/types.ts'
import type { HeldWhy } from './engine/engine.ts'

/** the held reasons heldWords gives their own words, in a task's add and tell replies (the machine's own room and its line
 *  have theirs there) */
export const HELD_NAMED = new Set<HeldWhy>(['space', 'model', 'blocked', 'zero', 'spaceZero', 'turn'])

/** the home space holds no repo, so no task starts in it: a place in this machine's queue would decide nothing */
export const HOME_NO_PLACE =
  'The home space holds no repo, so no task starts in it: a place in this machine’s queue would decide nothing. Set space.priority on a space (shepherdr space list shows them).'

/** a time left as minutes: "5m", "5 min", "90", "1h", "1h20m", "1.5h"; null when it is none of those */
export function minutesOf(text: string): number | null {
  const m = text
    .trim()
    .toLowerCase()
    .match(/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*(?:m|mins?|minutes?)?)?$/)
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return Math.round(Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0))
}

/** a task's line in the CLI, as on screen: its agent's own line while it works, else its standard status line (never the brief) */
export function statusLine(t: Task) {
  return t.status === 'work' && t.report && !t.report.paused ? t.report.msg : t.sub
}
