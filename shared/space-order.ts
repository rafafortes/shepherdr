// The one order of a machine's spaces in its queue: the spaces with a place (space.priority, a whole number from 1, set at
// the space) first, first to last, then the spaces with none, which go by age as they always did. The engine's line, the
// Spaces table of Settings → Limits and `shepherdr space list` all read it from here, so the three cannot disagree; each
// space's number is read once per computation, never per comparison (a snapshot sorts the line of every held task).

/** the highest place a space's number may name (space.priority), and the range Settings checks: 1 is first */
export const PLACE_MAX = 200

/** where a space with no place goes: after every numbered one, and equal among themselves */
export const NO_PLACE = Number.MAX_SAFE_INTEGER

/** a place as the order compares it: the space's number, or NO_PLACE when it has none */
export const placeRank = (place: number | null): number => place ?? NO_PLACE

/** two places in the queue: negative when a goes first, 0 when they tie (their tasks then go by age) */
export const comparePlace = (a: number | null, b: number | null): number => placeRank(a) - placeRank(b)

/**
 * A comparator of two space keys for a stable sort: each space's place is read once and kept, however many comparisons
 * name it. `place` is Settings' own accessor (spacePriority), so a stored "3abc" is no place at all.
 */
export function placeOrder(place: (space: string) => number | null): (a: string, b: string) => number {
  const ranks = new Map<string, number>()
  const rank = (key: string) => {
    let r = ranks.get(key)
    if (r === undefined) ranks.set(key, (r = placeRank(place(key))))
    return r
  }
  return (a, b) => rank(a) - rank(b)
}
