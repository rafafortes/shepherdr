// A refused merge train is searched by halves, not dissolved (engine.train, train-bisect.ts): a train of eight, and two faults, with the gate runs
// counted. Before, a refusal sent every member to a gate of its own (a train of n cost n + 1 runs).
import { describe, setDefaultTimeout } from 'bun:test'
import { bisectRows } from './train-world.ts'

setDefaultTimeout(120_000)

describe('a refused merge train is searched by halves', () => {
  // one fault in eight: five or six runs against nine; two faults cost more than one, never a task that is fine told
  bisectRows([
    [8, [1], 6, 9],
    [8, [4], 6, 9],
    [8, [8], 5, 9],
    [4, [1, 4], 7, 5],
    [5, [2, 3], 8, 6],
  ])
})
