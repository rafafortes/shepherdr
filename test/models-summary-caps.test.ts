// Settings → Models → Summary and models.maxAtOnce: each provider and model row says how many of its agents run now and
// its cap (its own entry, or the provider's that holds a model), how many tasks wait for it, and the warnings a local
// model with several agents and no cap raises (the set-a-cap note), or at its cap (the held note). The texts the cap
// editors write from are the setting's own text at each level.
import { describe, expect, test } from 'bun:test'
import { placeId } from '../server/live/places.ts'
import { capsOf, modelsSummary, type LiveAgent, type SummaryInput } from '../server/live/models-summary.ts'
import { atOnceWords, spaceCapWords } from '../shared/model-caps.ts'
import { Settings } from '../server/live/settings.ts'
import { UsageLedger } from '../server/live/usage-ledger.ts'
import { tmp } from './tmp.ts'

const NOW = Date.now()
const HOST = 'box'
const SPACES = [{ key: '~', name: 'home' }, { key: 'gtm', name: 'gtm' }]
const SPARK = 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold'
const settings = (seed: Partial<{ everywhere: Record<string, string>; machine: Record<string, string>; spaces: Record<string, Record<string, string>> }> = {}) => new Settings({ everywhere: {}, machine: {}, spaces: {}, ...seed })
const ledger = (name: string) => new UsageLedger(tmp(name), true)

/** the input the summary reads: the agents that run, the tasks held for a model's cap by the entry they wait for */
function input(s: Settings, u: UsageLedger, over: Partial<SummaryInput> = {}): SummaryInput {
  return { now: NOW, settings: s, host: HOST, spaces: SPACES, rows: [placeId.machine(HOST), 'all'], usage: u, agents: [], tasks: [], watch: [], ...over }
}
const provider = (sum: ReturnType<typeof modelsSummary>, name: string) => sum.providers.find((p) => p.provider === name)!
const model = (sum: ReturnType<typeof modelsSummary>, name: string, key: string) => provider(sum, name).models.find((m) => m.key === key)!
const warn = (sum: ReturnType<typeof modelsSummary>, prefix: string) => sum.warnings.filter((w) => w.id.startsWith(prefix))
/** runs of model keys in the home space (the runs a summary counts: each on its key and its space) */
const runsOf = (...keys: string[]) => keys.map((key) => ({ key, space: '~' }))

describe('the cap of each provider and model row', () => {
  test("a provider's row counts every agent of its provider and holds its entry; a model's counts its own and shows the provider's", () => {
    const s = settings({ machine: { 'models.maxAtOnce': 'spark=4' } })
    const sum = modelsSummary(input(s, ledger('cap-rows'), { runs: runsOf(SPARK, SPARK, 'spark/other-model') }))
    expect(provider(sum, 'spark').atOnce).toEqual({ now: 3, own: { pattern: 'spark', max: 4, from: 'machine' }, held: 0 })
    expect(model(sum, 'spark', SPARK).atOnce).toEqual({ now: 2, via: { pattern: 'spark', max: 4, from: 'machine' }, held: 0 })
    // no cap anywhere: the count alone, and nothing is held
    const bare = modelsSummary(input(settings(), ledger('cap-bare'), { runs: runsOf(SPARK) }))
    expect(provider(bare, 'spark').atOnce).toEqual({ now: 1, held: 0 })
    expect(model(bare, 'spark', SPARK).atOnce).toEqual({ now: 1, held: 0 })
  })

  test("a model's own entry shows on its row from Everywhere or this machine, and the tasks it holds count as held there", () => {
    const s = settings({ everywhere: { 'models.maxAtOnce': `spark/other-model=2` }, machine: { 'models.maxAtOnce': `${SPARK}=1` } })
    const sum = modelsSummary(input(s, ledger('cap-own'), { runs: runsOf(SPARK), heldBy: [SPARK, SPARK] }))
    expect(model(sum, 'spark', SPARK).atOnce).toEqual({ now: 1, own: { pattern: SPARK, max: 1, from: 'machine' }, held: 2 })
    // a machine that sets its own text takes Everywhere's place for every entry: the other model's entry is not in force here
    expect(provider(sum, 'spark').models.map((m) => m.key)).toEqual([SPARK])
    // and with no text of its own, the machine reads Everywhere's, from there
    const inherit = modelsSummary(input(settings({ everywhere: { 'models.maxAtOnce': 'spark/other-model=2' } }), ledger('cap-own-all'), { runs: runsOf('spark/other-model') }))
    expect(model(inherit, 'spark', 'spark/other-model').atOnce).toEqual({ now: 1, own: { pattern: 'spark/other-model', max: 2, from: 'all' }, held: 0 })
    expect(capsOf(s)).toEqual({ entries: [{ pattern: SPARK, max: 1 }], from: 'machine' })
    expect(capsOf(settings({ everywhere: { 'models.maxAtOnce': 'spark=4' } }))).toEqual({ entries: [{ pattern: 'spark', max: 4 }], from: 'all' })
    expect(capsOf(settings())).toEqual({ entries: [], from: 'all' })
  })

  test("the held tasks of a provider's cap count on its provider row", () => {
    const s = settings({ machine: { 'models.maxAtOnce': 'spark=2' } })
    const sum = modelsSummary(input(s, ledger('cap-held-provider'), { runs: runsOf(SPARK, SPARK), heldBy: ['spark', 'spark'] }))
    expect(provider(sum, 'spark').atOnce).toEqual({ now: 2, own: { pattern: 'spark', max: 2, from: 'machine' }, held: 2 })
    expect(model(sum, 'spark', SPARK).atOnce.held).toBe(0)
  })

  test('the caps as each level holds them: its own text, not an inherited one, and where a write goes', () => {
    const s = settings({ everywhere: { 'models.maxAtOnce': 'spark=4' }, machine: { 'models.maxAtOnce': 'radeon=1' } })
    const sum = modelsSummary(input(s, ledger('cap-texts')))
    expect(sum.caps).toEqual({
      all: 'spark=4',
      machine: 'radeon=1',
      place: placeId.machine(HOST),
      spaces: [
        { key: '~', name: 'home', place: placeId.home(HOST), text: '' },
        { key: 'gtm', name: 'gtm', place: placeId.space('gtm', HOST), text: '' },
      ],
    })
    const inherits = modelsSummary(input(settings({ everywhere: { 'models.maxAtOnce': 'spark=4' } }), ledger('cap-texts-inherit')))
    expect(inherits.caps).toEqual({ all: 'spark=4', machine: '', place: placeId.machine(HOST), spaces: [
      { key: '~', name: 'home', place: placeId.home(HOST), text: '' },
      { key: 'gtm', name: 'gtm', place: placeId.space('gtm', HOST), text: '' },
    ] })
  })

  test("a space's own sub-limit shows on the row it caps: its name, the runs of that space it counts, and where its text is written", () => {
    const s = settings({ machine: { 'models.maxAtOnce': 'spark=4' }, spaces: { gtm: { 'models.maxAtOnce': `spark=2, ${SPARK}=1` } } })
    const runs = [
      { key: SPARK, space: 'gtm' },
      { key: SPARK, space: '~' },
      { key: SPARK, space: '~' },
    ]
    const sum = modelsSummary(input(s, ledger('cap-spaces'), { runs }))
    // the provider's sub-limit counts the gtm runs it covers; the home space's own runs are not in it
    expect(provider(sum, 'spark').atOnce.spaces).toEqual([{ key: 'gtm', name: 'gtm', max: 2, now: 1 }])
    expect(model(sum, 'spark', SPARK).atOnce.spaces).toEqual([{ key: 'gtm', name: 'gtm', max: 1, now: 1 }])
    // a row with no sub-limit of a space shows none
    expect(provider(sum, 'spark').models.find((m) => m.key === 'spark/other')).toBeUndefined()
    // the texts the editor writes from: the space's own, its place, and the home space's place for the home space
    expect(sum.caps.spaces).toEqual([
      { key: '~', name: 'home', place: placeId.home(HOST), text: '' },
      { key: 'gtm', name: 'gtm', place: placeId.space('gtm', HOST), text: `spark=2, ${SPARK}=1` },
    ])
  })
  

  test('a row says its cap in words: a count of its cap, no cap, or the provider’s that holds it, and what waits', () => {
    expect(atOnceWords({ now: 2, own: { pattern: 'spark', max: 4, from: 'machine' }, held: 0 })).toMatchObject({ words: '2 of 4 at once' })
    expect(atOnceWords({ now: 2, own: { pattern: 'spark', max: 4, from: 'machine' }, held: 3 }).words).toBe('2 of 4 at once · 3 held')
    expect(atOnceWords({ now: 0, held: 0 }).words).toBe('0 at once · no cap')
    expect(atOnceWords({ now: 1, via: { pattern: 'spark', max: 4, from: 'all' }, held: 0 })).toMatchObject({ words: '1 at once · no cap of its own', title: 'Held by spark=4, set Everywhere. Click to set its own.' })
  })
})

describe('the warnings about a local model without a cap, or at its cap', () => {
  test('a local model with several working agents and no cap says so, with a cell to set one; a cap of its provider stops it', () => {
    const agents: LiveAgent[] = [
      { key: 'T-1/Agent', kind: 'pi', model: SPARK, status: 'working' },
      { key: 'T-2/Agent', kind: 'pi', model: SPARK, status: 'working' },
    ]
    const bare = warn(modelsSummary(input(settings({ everywhere: { 'task.agent': 'pi', 'task.model': SPARK } }), ledger('cap-warn-bare'), { agents })), 'shared:')
    expect(bare).toEqual([expect.objectContaining({ id: `shared:${SPARK}`, level: 'note', go: { row: 'cap', slot: SPARK } })])
    expect(bare[0]!.words).toBe('2 agents on Spark now (qwen3.8-flash-next-mlx4-mtp-tensorfold), and no cap holds them: set a cap for it.')
    const capped = settings({ everywhere: { 'task.agent': 'pi', 'task.model': SPARK }, machine: { 'models.maxAtOnce': 'spark=4' } })
    expect(warn(modelsSummary(input(capped, ledger('cap-warn-capped'), { agents })), 'shared:')).toEqual([])
  })

  test('at its cap, the tasks it holds say so: a note on the model (its own cap) or on the provider (its cap)', () => {
    const agents: LiveAgent[] = [{ key: 'T-1/Agent', kind: 'pi', model: SPARK, status: 'working' }]
    const own = settings({ everywhere: { 'task.agent': 'pi', 'task.model': SPARK }, machine: { 'models.maxAtOnce': `${SPARK}=1` } })
    const held = warn(modelsSummary(input(own, ledger('cap-held-own'), { agents, runs: runsOf(SPARK), heldBy: [SPARK] })), 'held:')
    expect(held).toEqual([expect.objectContaining({ id: `held:${SPARK}`, level: 'note', go: { row: 'cap', slot: SPARK } })])
    expect(held[0]!.words).toBe(`Held tasks wait for qwen3.8-flash-next-mlx4-mtp-tensorfold: ${SPARK} takes 1 at once and 1 run there now.`)
    const provider = settings({ everywhere: { 'task.agent': 'pi', 'task.model': SPARK }, machine: { 'models.maxAtOnce': 'spark=1' } })
    const onProvider = warn(modelsSummary(input(provider, ledger('cap-held-provider-warn'), { agents, runs: runsOf(SPARK), heldBy: ['spark'] })), 'held:')
    expect(onProvider).toEqual([expect.objectContaining({ id: 'held:spark', go: { row: 'cap', slot: 'spark' } })])
    expect(onProvider[0]!.words).toBe('Held tasks wait for Spark: its cap of 1 at once is full (1 running).')
    // no held task, no note
    expect(warn(modelsSummary(input(own, ledger('cap-held-none'), { agents })), 'held:')).toEqual([])
  })
})

describe('0 blocks a row: its cap reads blocked, its running agents go on, and a role with every model blocked is a warning', () => {
  test("a provider at 0 reads blocked · 0 allowed, its running agents said to keep running, and a model under it reads blocked by it", () => {
    const s = settings({ machine: { 'models.maxAtOnce': 'spark=0' } })
    const sum = modelsSummary(input(s, ledger('blk-rows'), { runs: runsOf(SPARK) }))
    expect(provider(sum, 'spark').atOnce).toMatchObject({ now: 1, own: { pattern: 'spark', max: 0, from: 'machine' } })
    // the note is about what runs on it now: a provider's agents, the runs the cap counts
    expect(atOnceWords(provider(sum, 'spark').atOnce)).toEqual({ words: 'blocked · 0 allowed · 1 still running', title: 'Blocked: spark=0, set this machine. Nothing new starts on it; what runs now goes on. Click to change.', blocked: true })
    expect(atOnceWords(model(sum, 'spark', SPARK).atOnce)).toMatchObject({ words: 'blocked · 0 allowed (by spark) · 1 still running', blocked: true })
    expect(sum.warnings.filter((w) => w.id === 'blocked-running:spark')).toEqual([expect.objectContaining({ level: 'note', words: 'Spark (local) is blocked (0 allowed), and 1 agent still runs on it: they keep running; nothing new starts on it.' })])
    // not on a row with nothing running: the blocked row still reads so, without the note
    const idle = modelsSummary(input(s, ledger('blk-idle'), { providers: ['spark'] }))
    expect(atOnceWords(provider(idle, 'spark').atOnce)).toMatchObject({ words: 'blocked · 0 allowed', blocked: true })
    expect(warn(idle, 'blocked-running:')).toEqual([])
  })

  test('a model at 0 on its own: its row is blocked; its provider is not', () => {
    const sum = modelsSummary(input(settings({ machine: { 'models.maxAtOnce': `${SPARK}=0` } }), ledger('blk-model'), { runs: runsOf(SPARK, SPARK) }))
    expect(model(sum, 'spark', SPARK).atOnce).toMatchObject({ now: 2, own: { max: 0 } })
    expect(provider(sum, 'spark').atOnce).toEqual({ now: 2, held: 0 })
    expect(warn(sum, 'blocked-running:').map((w) => w.id)).toEqual([`blocked-running:${SPARK}`])
  })

  test("a space's sub-limit at 0 blocks its line, which reads blocked and not a count", () => {
    const s = settings({ spaces: { gtm: { 'models.maxAtOnce': 'spark=0' } } })
    const sum = modelsSummary(input(s, ledger('blk-space-line'), { providers: ['spark'] }))
    const line = provider(sum, 'spark').atOnce.spaces?.[0]
    expect(line).toMatchObject({ key: 'gtm', max: 0 })
    expect(line && spaceCapWords(line)).toBe('gtm: blocked · 0 allowed')
  })

  test('a role every model of which is blocked in a space: a risk warning that it can never start, with the blocked cell to change', () => {
    // the home space's task model is spark (its primary): blocked; its only backup is blocked too
    const s = settings({ machine: { 'models.maxAtOnce': 'spark=0, openai=0', 'task.agent': 'pi', 'task.model': SPARK, 'task.fallback': 'Codex' } })
    const sum = modelsSummary(input(s, ledger('blk-role')))
    const never = warn(sum, 'blocked:')
    expect(never.length).toBeGreaterThan(0)
    expect(never[0]).toMatchObject({ level: 'risk', words: expect.stringContaining('can never start: every model is blocked.') })
    expect(never.find((w) => w.id.startsWith('blocked:~:task'))).toMatchObject({ go: { row: 'cap', slot: expect.any(String) } })
  })

  test('a role with one model left free is not a risk: only a role every model of which is blocked is', () => {
    const s = settings({ machine: { 'models.maxAtOnce': 'spark=0', 'task.agent': 'pi', 'task.model': SPARK, 'task.fallback': 'Codex' } })
    const sum = modelsSummary(input(s, ledger('blk-free')))
    expect(warn(sum, 'blocked:~:task')).toEqual([])
  })
})

describe('0 in words: a row, a space line and the cap of a row that holds nothing', () => {
  test('atOnceWords reads a 0 as blocked, whatever runs, and a space line as blocked too', () => {
    expect(atOnceWords({ now: 0, own: { pattern: 'spark', max: 0, from: 'all' }, held: 0 })).toEqual({ words: 'blocked · 0 allowed', title: 'Blocked: spark=0, set Everywhere. Nothing new starts on it; what runs now goes on. Click to change.', blocked: true })
    expect(atOnceWords({ now: 1, own: { pattern: 'spark', max: 0, from: 'machine' }, held: 2 }).words).toBe('blocked · 0 allowed · 1 still running · 2 held')
    expect(atOnceWords({ now: 1, via: { pattern: 'spark', max: 0, from: 'all' }, held: 0 })).toEqual({ words: 'blocked · 0 allowed (by spark) · 1 still running', title: 'Blocked by spark=0, set Everywhere. Nothing new starts on it; what runs now goes on. Click to set its own.', blocked: true })
    // a provider's sub-limit of its own still reads its count, and a limit of 2 is no block
    expect(atOnceWords({ now: 1, own: { pattern: 'spark', max: 2, from: 'machine' }, held: 0 })).toMatchObject({ words: '1 of 2 at once', blocked: false })
    expect(atOnceWords({ now: 0, held: 0 })).toMatchObject({ words: '0 at once · no cap', blocked: false })
    expect(spaceCapWords({ key: 'gtm', name: 'gtm', max: 0, now: 0 })).toBe('gtm: blocked · 0 allowed')
    expect(spaceCapWords({ key: 'gtm', name: 'gtm', max: 2, now: 1 })).toBe('gtm: 1 of 2 at once')
  })
})
