// A refused merge train is searched by halves, not dissolved (engine.train, train-bisect.ts): trains of four and five, with the gate runs
// counted. Before, a refusal sent every member to a gate of its own (a train of n cost n + 1 runs).
import { describe, setDefaultTimeout } from 'bun:test'
import { bisectRows, trainLog } from './train-world.ts'

setDefaultTimeout(120_000)

trainLog()

describe('a refused merge train is searched by halves', () => {
  bisectRows([
    [4, [1], 5, 5],
    [4, [2], 5, 5],
    [4, [4], 4, 5],
    [5, [1], 5, 6],
    [5, [3], 5, 6],
    [5, [5], 5, 6],
  ])
})
