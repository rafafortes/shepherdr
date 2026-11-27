// How a refused merge train is searched by halves instead of dissolved (engine.train, docs/tasks.md): the pure part.
//
// A train whose gate run is refused holds a fault, or an interaction, somewhere in it. Its members are marked with the
// group the refusal made (`id`) and one of two states:
//   suspect: the stack of these was refused together (the whole train, or the half that was refused again): it is never
//            gated whole a second time, its first half goes on a gate run of its own;
//   unknown: it rode a refused train but was left out of the half the next run took: nothing says it is at fault, so
//            the members in this state go in together on one gate run, then are suspect if that is refused.
// A member rides only with the others of its group in the same state until its own gate passed or refused it alone.

/** a member of a refused train: its group, and `suspect` while its half is known to hold the fault */
export interface Bisect {
  id: string
  suspect?: true
}

/**
 * How many of `n` merges the next gate run takes: the smaller half, at least one. A pair or a trio's first half is its
 * head alone, which goes on to its own gate, so searching a refused train never costs more gate runs than sending each
 * member to a gate of its own did, for one fault, and costs clearly fewer from five members up (test/train-bisect.test.ts).
 */
export const firstHalf = (n: number) => Math.max(1, Math.floor(n / 2))

/** a group's id: the head of the refused train and the stack it ran on, so a log line and the gate run it names agree */
export const groupId = (head: string, top: string) => `${head}@${top.slice(0, 7)}`

/**
 * What the next gate run is for, given the cars a train stacked (head first) and whether they are suspect: the run's
 * cars, and the rest that waits. A suspect set is never gated whole again (its stack was refused already), so its
 * first half goes and its second half waits; anything else goes whole.
 */
export function halves<T>(cars: T[], suspect: boolean): { go: T[]; rest: T[] } {
  const go = suspect ? cars.slice(0, firstHalf(cars.length)) : cars
  return { go, rest: cars.slice(go.length) }
}

/**
 * Why a merge marked `x` may not ride a train whose head is marked `head` (either may be unmarked), or nothing: an
 * unmarked task rides with unmarked ones only, a marked one with its group in its own state.
 */
export function rideBlock(head: Bisect | undefined, x: Bisect | undefined): 'group' | 'half' | undefined {
  if (head?.id !== x?.id) return 'group'
  if (!!head?.suspect !== !!x?.suspect) return 'half'
  return undefined
}
