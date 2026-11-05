import type { Snapshot, Task } from '@shared/types.ts'

/** What waits on you at these places, each number what its own list shows: need is the Needs you view's rows here, each
 *  card or waiting agent once; ready is the Ready tasks of the Tasks list. */
export function attentionCounts(snap: Snapshot, places: string[]) {
  const ids = new Set(places)
  const needs = new Set((snap.needs ?? []).filter((n) => ids.has(n.place)).map((n) => `${n.chat}\0${n.id}`))
  const ready = new Set(snap.tasks.filter((t) => ids.has(t.place) && !t.archived && t.status === 'ready').map((t) => t.id))
  return { need: needs.size, ready: ready.size }
}

export const actionable = (t: Task) => t.status === 'need' || t.status === 'ready'
