// What the merge train pre-flight's tests share (engine-merge-train-preflight*.test.ts): the commands the space's pre-flight
// runs, the ledger as the tests read it, and a line of merges asked for in the order their pre-flights let them in.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { trainWorld } from './train-world.ts'
import { until } from './engine-world.ts'

/** fails once the stack holds a bad file on top of what the blocker landed: a change that is only wrong on top of what went in
 *  since it was written, so the car's own worktree (which lacks the blocker's file) passes it at the door */
export const WRONG_AFTER_BLOCKER = 'for f in bad-*.txt; do [ -e "$f" ] && [ -e blocker.txt ] && { echo "$f is wrong on top of blocker.txt"; exit 1; }; done; exit 0'
/** fails once the stack adds more than `n` files to main: a fault only a long stack has */
export const OVER = (n: number) => `[ "$(git diff --name-only main HEAD | wc -l)" -gt ${n} ] && { echo "too many files for one run"; exit 1; }; exit 0`

/** the ledger's lines, in order */
export type Line = { kind: string; task: string; end: string; code: number | null; members?: string[]; log: string }
export const ledger = (): Line[] =>
  readFileSync(join(process.env.SHEPHERDR_HOME ?? '', 'gates', 'ledger.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
/** the pre-flight runs that looked at a train's stack, in order: [its cars, how it ended] */
export const probes = () => ledger().flatMap((l) => (l.kind === 'preflight' && l.members ? [[l.members.join(','), l.end] as const] : []))

/**
 * Every member asks to merge behind the blocker, one at a time and each once its pre-flight let it take its place in line (a
 * pre-flight is not under the line's one-at-a-time rule, so the places come in the order the passes do), then every gate may
 * end. The answers, in order.
 */
export async function asked(world: Awaited<ReturnType<typeof trainWorld>>) {
  const { w, blocker, riders, ts, go } = world
  const answers = [w.engine.merge(blocker.id, { self: true })]
  await until(() => blocker.landing?.step === 'gate')
  for (const t of riders) {
    answers.push(w.engine.merge(t.id, { self: true }))
    await until(() => t.landing?.step === 'queue')
  }
  for (const t of ts) go(t)
  return Promise.all(answers)
}
