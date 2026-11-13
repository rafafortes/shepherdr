// The cap-aware choice (server/live/engine/choose.ts): the first harness of a chain that is not out and has room under every
// entry that applies to it, at this machine's total and at its space's own sub-limit. Each combination of the brief.
import { describe, expect, test } from 'bun:test'
import { choose, covers, waitWords, type ChooseInput, type Option, type Run } from '../server/live/engine/choose.ts'
import type { MaxEntry } from '../shared/model-caps.ts'

const SPARK = 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold'
const SPARK2 = 'spark/qwen3.5-other'
const CODE = 'commandcode/deepseek/deepseek-v4.1-flash'
const CODEX = 'openai/gpt-5.5'

const opt = (name: string, key: string, out?: { until?: string }): Option<string> => ({ harness: name, key, ...(out ? { out } : {}) })
const run = (key: string, space = 'app', role: Run['role'] = 'task', id?: string): Run => ({ key, space, role, ...(id ? { id } : {}) })
const e = (pattern: string, max: number): MaxEntry => ({ pattern, max })

/** a choice over these options with these runs and entries; the space is `app` unless given */
function pick(options: Option<string>[], o: Partial<Omit<ChooseInput<string>, 'options'>> = {}) {
  return choose<string>({ space: 'app', options, runs: [], machine: [], own: [], ...o })
}

describe('the cap-aware choice: the chain in order', () => {
  test('the primary has room: it is the one, and nothing before it was skipped', () => {
    const c = pick([opt('primary', SPARK), opt('backup', CODE)], { machine: [e('spark', 4)], runs: [run(SPARK)] })
    expect(c).toEqual({ harness: 'primary', index: 0, skipped: [] })
  })

  test('nothing capped, nothing out: the first of the chain', () => {
    expect(pick([opt('primary', SPARK), opt('backup', CODE)])).toEqual({ harness: 'primary', index: 0, skipped: [] })
  })

  test('the primary is full: backup 1 starts, and the primary is what it says was skipped', () => {
    const c = pick([opt('primary', SPARK), opt('backup', CODE)], { machine: [e('spark', 2)], runs: [run(SPARK), run(SPARK2)] })
    expect(c).toMatchObject({ harness: 'backup', index: 1, skipped: [{ harness: 'primary', why: 'full', name: 'spark', cap: { scope: 'machine', count: 2, max: 2 } }] })
  })

  test('the primary and backup 1 are full: backup 2 starts', () => {
    const c = pick([opt('primary', SPARK), opt('b1', CODE), opt('b2', CODEX)], { machine: [e('spark', 1), e('commandcode', 1)], runs: [run(SPARK), run(CODE)] })
    expect(c).toMatchObject({ harness: 'b2', index: 2, skipped: [{ harness: 'primary', why: 'full' }, { harness: 'b1', why: 'full', name: 'commandcode' }] })
  })

  test('a backup out of quota is skipped for the next one, whatever its caps', () => {
    const c = pick([opt('primary', SPARK), opt('b1', CODE, { until: '17:00' }), opt('b2', CODEX)], { machine: [e('spark', 1)], runs: [run(SPARK)] })
    expect(c).toMatchObject({ harness: 'b2', index: 2, skipped: [{ harness: 'primary', why: 'full' }, { harness: 'b1', why: 'out', name: 'commandcode', until: '17:00' }] })
  })

  test('an out primary is passed over the same way (its backup starts on a free slot)', () => {
    const c = pick([opt('primary', SPARK, {}), opt('b1', CODE)])
    expect(c).toMatchObject({ harness: 'b1', index: 1, skipped: [{ harness: 'primary', why: 'out', name: 'spark' }] })
  })

  test('all full: a wait lists each, in the order of the chain, with the entry that is full', () => {
    const c = pick([opt('primary', SPARK), opt('b1', CODE, { until: '17:00' })], { machine: [e('spark', 4)], runs: [run(SPARK), run(SPARK), run(SPARK), run(SPARK)] })
    expect(c).toEqual({
      wait: [
        { harness: 'primary', why: 'full', name: 'spark', cap: { scope: 'machine', count: 4, max: 4 } },
        { harness: 'b1', why: 'out', name: 'commandcode', until: '17:00' },
      ],
    })
  })

  test('the task --set chain keeps its order: the one the task keeps first is tried first', () => {
    // the same backups, written in another order by a coordinator's --set, go in in that order
    expect(pick([opt('codex', CODEX), opt('pi', CODE)])).toMatchObject({ harness: 'codex', index: 0 })
    expect(pick([opt('pi', CODE), opt('codex', CODEX)])).toMatchObject({ harness: 'pi', index: 0 })
  })

  test('no options at all: a wait with nothing in it', () => {
    expect(pick([])).toEqual({ wait: [] })
  })
})

describe('the cap-aware choice: the two scopes', () => {
  test('a space sub-limit full while the machine has room: that harness waits, and the space says so', () => {
    const c = pick([opt('primary', SPARK), opt('b1', CODE)], { machine: [e('spark', 4)], own: [e('spark', 1)], runs: [run(SPARK, 'app')] })
    expect(c).toMatchObject({ harness: 'b1', index: 1, skipped: [{ harness: 'primary', why: 'full', name: 'spark', cap: { scope: 'space', count: 1, max: 1 } }] })
    expect(waitWords(c.skipped as never, (s) => `${s}!`)).toBe('spark in app! (1 of 1 at once)')
  })

  test("a space's sub-limit counts only its own runs: another space's runs leave it room", () => {
    const c = pick([opt('primary', SPARK)], { machine: [e('spark', 4)], own: [e('spark', 1)], runs: [run(SPARK, 'other'), run(SPARK, 'other')] })
    expect(c).toEqual({ harness: 'primary', index: 0, skipped: [] })
  })

  test('the machine total full while the space has room: that harness waits on the total', () => {
    const c = pick([opt('primary', SPARK)], { machine: [e('spark', 2)], own: [e('spark', 5)], runs: [run(SPARK, 'other'), run(SPARK, 'other')] })
    expect(c).toMatchObject({ wait: [{ why: 'full', cap: { scope: 'machine', count: 2, max: 2 } }] })
  })

  test('the total counts every space: two spaces with room of their own still share the machine total', () => {
    const runs = [run(SPARK, 'a'), run(SPARK, 'b')]
    expect(pick([opt('p', SPARK)], { machine: [e('spark', 3)], own: [e('spark', 2)], runs })).toEqual({ harness: 'p', index: 0, skipped: [] })
    expect(pick([opt('p', SPARK)], { machine: [e('spark', 2)], own: [e('spark', 2)], runs, space: 'c' })).toMatchObject({ wait: [{ cap: { scope: 'machine' } }] })
  })

  test('the space sub-limit is the space\'s own value: with none of its own, the machine entry is all there is', () => {
    expect(pick([opt('p', SPARK)], { machine: [e('spark', 1)], own: [], runs: [run(SPARK)] })).toMatchObject({ wait: [{ cap: { scope: 'machine' } }] })
  })
})

describe('the cap-aware choice: which entry covers a model', () => {
  test("a model's own entry is checked with its provider's: the provider's total still holds", () => {
    // spark=4 and spark/qwen…=2: the model has 2 of its own; the provider's 4 hold for every model together
    const machine = [e(SPARK, 2), e('spark', 4)]
    expect(pick([opt('p', SPARK)], { machine, runs: [run(SPARK), run(SPARK)] })).toMatchObject({ wait: [{ name: SPARK, cap: { count: 2, max: 2 } }] })
    expect(pick([opt('p', SPARK2)], { machine, runs: [run(SPARK), run(SPARK), run(SPARK2), run(SPARK2)] })).toMatchObject({ wait: [{ why: 'full', name: 'spark', cap: { count: 4, max: 4 } }] })
    expect(pick([opt('p', SPARK2)], { machine, runs: [run(SPARK), run(SPARK), run(SPARK2)] })).toEqual({ harness: 'p', index: 0, skipped: [] })
  })

  test("the model's entry is full while its provider has room: the provider's total is not the reason", () => {
    const c = pick([opt('p', SPARK)], { machine: [e(SPARK, 1), e('spark', 4)], runs: [run(SPARK)] })
    expect(c).toMatchObject({ wait: [{ name: SPARK, cap: { count: 1, max: 1 } }] })
  })

  test("the provider's entry is full while the model has room: a model of that provider waits", () => {
    const c = pick([opt('p', SPARK2)], { machine: [e(SPARK, 9), e('spark', 2)], runs: [run(SPARK), run(SPARK2)] })
    expect(c).toMatchObject({ wait: [{ name: 'spark', cap: { count: 2, max: 2 } }] })
  })

  test('a model entry covers only its own model; a provider entry covers all of its models', () => {
    expect(covers(SPARK, SPARK)).toBe(true)
    expect(covers(SPARK, SPARK2)).toBe(false)
    expect(covers('spark', SPARK2)).toBe(true)
    expect(covers('spark', CODE)).toBe(false)
    expect(covers('commandcode/deepseek/deepseek-v4.1-flash', CODE)).toBe(true)
    expect(covers('commandcode', CODE)).toBe(true)
  })

  test('a model key with no slash is its own provider too', () => {
    expect(covers('local', 'local')).toBe(true)
    expect(covers('openai', CODEX)).toBe(true)
  })
})

describe('the cap-aware choice: what counts', () => {
  test('the advisor and reviewer leases count toward the machine total like any run', () => {
    const runs = [run(SPARK, 'app', 'task', 't1'), run(SPARK, 'app', 'advisor', 'adv-1')]
    expect(pick([opt('p', SPARK), opt('b', CODE)], { machine: [e('spark', 2)], runs })).toMatchObject({ harness: 'b', index: 1 })
  })

  test('a lease counts toward its own space sub-limit as well', () => {
    const runs = [run(SPARK, 'app', 'reviewer', 'rev-1')]
    expect(pick([opt('p', SPARK)], { machine: [e('spark', 4)], own: [e('spark', 1)], runs })).toMatchObject({ wait: [{ cap: { scope: 'space' } }] })
  })

  test('runs of another provider or model do not count toward an entry', () => {
    expect(pick([opt('p', SPARK)], { machine: [e('spark', 1)], runs: [run(CODE), run(CODEX), run(SPARK2, 'app', 'task')] })).toMatchObject({ wait: [{ cap: { count: 1 } }] })
    expect(pick([opt('p', CODE)], { machine: [e('spark', 1)], runs: [run(SPARK)] })).toEqual({ harness: 'p', index: 0, skipped: [] })
  })

  test('an out harness counts nothing and is not held by a cap either', () => {
    expect(pick([opt('p', SPARK, { until: 'tomorrow' })], { machine: [e('spark', 1)], runs: [run(SPARK)] })).toEqual({ wait: [{ harness: 'p', why: 'out', name: 'spark', until: 'tomorrow' }] })
  })
})

describe('the words of a wait', () => {
  test('full entries say how many run at once, out ones until when', () => {
    const c = pick([opt('primary', SPARK), opt('b1', CODE, { until: '17:00' })], { machine: [e('spark', 4)], runs: [run(SPARK), run(SPARK), run(SPARK), run(SPARK)] })
    if (!('wait' in c)) throw new Error('expected a wait')
    expect(waitWords(c.wait)).toBe('spark (4 of 4 at once), commandcode (out until 17:00)')
  })

  test('an out provider with no time says only that it is out', () => {
    expect(waitWords([{ harness: 'x', why: 'out', name: 'radeon' }])).toBe('radeon (out)')
  })
})
