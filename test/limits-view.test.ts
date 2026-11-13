// Settings → Limits (server/live/limits-view.ts): the machine's rows and their live numbers, each space's Max tasks and its
// sub-limits by pattern (their own runs now, inside the machine's total), the providers that have an entry, the + column's
// choices, and what waits now grouped by what holds it (with the advisor's questions and the reviews that wait too).
import { describe, expect, test } from 'bun:test'
import { type Sample } from '../server/live/health.ts'
import { modelsSummary, type SummaryInput } from '../server/live/models-summary.ts'
import { modelsMatrix } from '../server/live/models-matrix.ts'
import { entryPatterns, knownOf, limitsView, machineColumns, machineReason, waitingOf, type HeldFact, type LimitsInput } from '../server/live/limits-view.ts'
import { Settings } from '../server/live/settings.ts'
import { UsageLedger } from '../server/live/usage-ledger.ts'
import { piOffers } from './pi-offers.ts'
import { tmp } from './tmp.ts'

const NOW = Date.now()
const HOST = 'box'
const SPACES = [
  { key: '~', name: 'home' },
  { key: 'gtm', name: 'gtm' },
]
const SPARK = 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold'
const settings = (seed: Partial<{ everywhere: Record<string, string>; machine: Record<string, string>; spaces: Record<string, Record<string, string>> }> = {}) => new Settings({ everywhere: {}, machine: {}, spaces: {}, ...seed })
const ledger = (name: string) => new UsageLedger(tmp(name), true)
/** a 4-core machine at 6 on its 5-minute load (over its 1× cores start limit), 85% of its memory in use */
const sample: Sample = { at: NOW, cores: 4, load: 6, load5: 6, memTotal: 100, memUsed: 85, disks: [{ path: '/', pct: 40, freeGb: 10, dev: 1 }], gpus: [] }

/** the whole input of a view: the settings, the matrix and summary they make, and what runs and waits, with what a test changes */
function input(s: Settings, over: Partial<LimitsInput> = {}): LimitsInput {
  const matrix = modelsMatrix(s, { host: HOST, name: HOST }, SPACES)
  const summaryInput: SummaryInput = { now: NOW, settings: s, host: HOST, spaces: SPACES, rows: matrix.rows.map((r) => r.id), usage: new UsageLedger(tmp(`lv-${Math.random()}`), true), agents: [], tasks: [], watch: [], runs: over.runs ?? [], providers: over.summary ? undefined : [] }
  const summary = over.summary ?? modelsSummary(summaryInput)
  return { now: NOW, settings: s, host: HOST, machineName: HOST, matrix, summary, runs: [], held: [], working: 0, waitingOnYou: 0, workingIn: {}, herdr: true, advisor: [], reviews: [], known: knownOf(matrix, summary), ...over }
}

const held = (over: Partial<HeldFact> & Pick<HeldFact, 'id' | 'why'>): HeldFact => ({ space: '~', spaceName: 'home', words: `${over.id} waits`, ...over })

describe('the machine rows: Everywhere and this machine, each value with where it comes from and the number now', () => {
  test('a value a level sets is strong with its level, one it inherits says where from; the live numbers read this machine now', () => {
    const s = settings({ everywhere: { 'machine.maxTasks': '12' }, machine: { 'machine.startLoad': '2× cores' } })
    const view = limitsView(input(s, { working: 7, waitingOnYou: 2, sample, herdr: false }))
    const [all, here] = view.machineTable.rows
    expect(all!.id).toBe('all')
    expect(here!.id).toBe(`m:${HOST}`)
    // Everywhere: its own value, set there; the machine inherits it
    expect(all!.cells['machine.maxTasks']).toMatchObject({ key: 'machine.maxTasks', place: 'all', from: 'all', set: true, row: { value: '12' } })
    expect(here!.cells['machine.maxTasks']).toMatchObject({ place: `m:${HOST}`, from: 'all', set: false, row: { value: '12' }, now: '7 of 12 working, 2 wait on you' })
    // this machine sets its own load limit; Everywhere has none (the default)
    expect(here!.cells['machine.startLoad']).toMatchObject({ from: 'machine', set: true, row: { value: '2× cores' }, now: '1.50× cores now' })
    expect(all!.cells['machine.startLoad']).toMatchObject({ from: 'default', set: false, row: { value: '1× cores' } })
    // the numbers now are read from the sample: pressure has none here, memory is 85%, herdr is down
    expect(here!.cells['machine.startPressure']!.now).toBe('no pressure reading')
    expect(here!.cells['machine.startMemory']!.now).toBe('85% now')
    expect(all!.cells['machine.startMemory']!.now).toBeUndefined()
    expect(view.machine).toEqual({ id: `m:${HOST}`, name: HOST, herdr: false })
  })

  test('the alerts are a table of their own, with the herdr and load numbers now; merge train joins the machine only when Everywhere sets it', () => {
    const plain = limitsView(input(settings(), { sample, herdr: false }))
    expect(machineColumns(settings())).toEqual(['machine.maxTasks', 'machine.startLoad', 'machine.startPressure', 'machine.startMemory', 'machine.startEvery'])
    expect(plain.machineTable.columns.map((c) => c.key)).not.toContain('merge.train')
    const alerts = limitsView(input(settings({ everywhere: { 'merge.train': '3' } }), { sample, herdr: true }))
    expect(alerts.machineTable.columns.map((c) => c.key)).toContain('merge.train')
    const a = plain.alerts.rows[1]!
    expect(a.cells['machine.alertLoad']!.now).toBe('1.50× cores now')
    expect(a.cells['machine.alertDisk']!.now).toBe('40% now')
    expect(a.cells['machine.alertHerdr']!.now).toBe("herdr doesn't answer now")
    expect(limitsView(input(settings(), { sample, herdr: true })).alerts.rows[1]!.cells['machine.alertHerdr']!.now).toBe('herdr answers now')
    expect(plain.alerts.columns.map((c) => c.key)).toEqual(['machine.alertLoad', 'machine.alertMemory', 'machine.alertDisk', 'machine.alertHerdr'])
  })

  test('with no sample yet, the live numbers are not drawn', () => {
    const view = limitsView(input(settings()))
    expect(view.machineTable.rows[1]!.cells['machine.startLoad']!.now).toBeUndefined()
    expect(view.machineTable.rows[1]!.cells['machine.maxTasks']!.now).toBe('0 of 10 working')
  })

  test('machineReason names what holds the machine: herdr, its CPU, its memory, or nothing that holds', () => {
    const s = settings()
    expect(machineReason(sample, false, s)).toBe("herdr doesn't answer · CPU is busy: load 1.50× cores (limit 1×)")
    expect(machineReason({ ...sample, load: 1, load5: 1 }, true, s)).toBe('memory 85% (limit 80%)')
    expect(machineReason({ ...sample, load: 1, load5: 1, memUsed: 10 }, true, s)).toBe('the machine has room now: the next look starts it')
    expect(machineReason(undefined, true, s)).toBe('the machine has room now: the next look starts it')
  })
})

describe('the spaces: Max tasks and Merge train, and one sub-limit per provider or model that an entry names', () => {
  test("each space's Max tasks reads its tasks now and the held ones; its sub-limits count its own runs inside the machine's total", () => {
    const s = settings({
      machine: { 'models.maxAtOnce': 'spark=4' },
      spaces: { gtm: { 'space.maxTasks': '2', 'models.maxAtOnce': `${SPARK}=1`, 'merge.train': '3' } },
    })
    const runs = [
      { key: SPARK, space: 'gtm', role: 'task' as const },
      { key: SPARK, space: '~', role: 'coordinator' as const },
      { key: 'anthropic/claude-opus-5-5', space: 'gtm', role: 'task' as const },
    ]
    const view = limitsView(input(s, { runs, workingIn: { gtm: 2, '~': 1 }, held: [held({ id: 'GTM-9', why: 'space', space: 'gtm', spaceName: 'gtm' }), held({ id: 'GTM-10', why: 'slots', space: 'gtm', spaceName: 'gtm' })] }))
    // home has no own value: no row for it (its settings are not in Settings → Limits); gtm has one
    expect(view.spaces.rows.map((r) => r.key)).toEqual(['gtm'])
    const gtm = view.spaces.rows[0]!
    expect(gtm.cells['space.maxTasks']).toMatchObject({ place: 'p:box:gtm', from: 'space', set: true, row: { value: '2' }, now: '2 of 2 working · 2 held' })
    expect(gtm.cells['merge.train']).toMatchObject({ from: 'space', row: { value: '3' } })
    // the patterns: the machine's entries, then each space's own, each once
    expect(view.spaces.patterns).toEqual(['spark', SPARK])
    // the machine's spark total covers the model's column too: its own entry is the one that caps it
    expect(view.spaces.totals).toEqual({ spark: { pattern: 'spark', max: 4 }, [SPARK]: { pattern: 'spark', max: 4 } })
    // the sub-limit of gtm for the model: its own entry, and its own runs now (the Spark run of gtm, and no other space's)
    expect(gtm.caps[SPARK]).toEqual({ max: 1, now: 1 })
    expect(gtm.caps.spark).toBeUndefined()
  })

  test('a space with no value of its own still shows its tasks; a machine total with no space entry shows as its total', () => {
    const view = limitsView(input(settings({ machine: { 'models.maxAtOnce': 'spark=4' } }), { workingIn: { gtm: 0 } }))
    // gtm is a space of this machine: its row is there, its Max tasks inherited, and its sub-limit for spark faint
    expect(view.spaces.rows.map((r) => r.key)).toEqual(['gtm'])
    expect(view.spaces.rows[0]!.cells['space.maxTasks']).toMatchObject({ from: 'default', set: false, now: '0 working' })
    expect(view.spaces.rows[0]!.caps).toEqual({})
    expect(view.spaces.patterns).toEqual(['spark'])
    expect(view.spaces.totals.spark).toEqual({ pattern: 'spark', max: 4 })
  })

  test("home has a row only when it sets one of these keys itself: its own sub-limit makes one, with its runs counted", () => {
    const quiet = limitsView(input(settings({ spaces: { gtm: { 'space.maxTasks': '2' } } })))
    expect(quiet.spaces.rows.map((r) => r.key)).toEqual(['gtm'])
    const home = limitsView(input(settings({ spaces: { '~': { 'models.maxAtOnce': 'spark=1' } } }), { runs: [{ key: SPARK, space: '~', role: 'task' }] }))
    expect(home.spaces.rows.map((r) => [r.key, r.name, r.id])).toEqual([['~', 'home', `p:${HOST}:~`], ['gtm', 'gtm', `p:${HOST}:gtm`]])
    expect(home.spaces.rows[0]!.caps).toEqual({ spark: { max: 1, now: 1 } })
    expect(home.spaces.patterns).toEqual(['spark'])
  })

  test('entryPatterns: the machine (Everywhere while it sets none) then each space, each pattern once', () => {
    const s = settings({ everywhere: { 'models.maxAtOnce': 'radeon=1' }, spaces: { gtm: { 'models.maxAtOnce': `${SPARK}=2, radeon=1` } } })
    expect(entryPatterns(s, ['gtm', '~'])).toEqual(['radeon', SPARK])
    expect(entryPatterns(settings(), ['gtm'])).toEqual([])
  })
})

describe('the providers: every provider with an entry, an agent, a run or usage, each with its models and what runs by role', () => {
  test('a provider with an entry and nothing else shows; runs count by role on the provider and on its model', () => {
    const s = settings({ machine: { 'models.maxAtOnce': 'avell=1' } })
    const summary = modelsSummary({ now: NOW, settings: s, host: HOST, spaces: SPACES, rows: [], usage: new UsageLedger(tmp('lv-prov'), true), agents: [], tasks: [], watch: [], runs: [], providers: ['avell'] } as SummaryInput)
    const view = limitsView(input(s, { summary, runs: [{ key: SPARK, space: '~', role: 'task' }, { key: SPARK, space: 'gtm', role: 'advisor' }, { key: 'spark/other', space: '~', role: 'reviewer' }] }))
    // the provider with an entry shows, with the configured ones of the defaults beside it (the summary's own rows)
    expect(view.providers.map((p) => p.provider)).toContain('avell')
    expect(view.providers.find((p) => p.provider === 'avell')).toMatchObject({ name: 'Avell (local)', local: true, atOnce: { own: { pattern: 'avell', max: 1, from: 'machine' } } })
    const spark = limitsView(input(s, { runs: [{ key: SPARK, space: '~', role: 'task' }, { key: SPARK, space: 'gtm', role: 'advisor' }, { key: 'spark/other', space: '~', role: 'reviewer' }] })).providers.find((p) => p.provider === 'spark')
    expect(spark!.byRole).toEqual({ task: 1, advisor: 1, reviewer: 1 })
    expect(spark!.models.find((m) => m.key === SPARK)!.byRole).toEqual({ task: 1, advisor: 1 })
  })

  test('the tasks running on a provider or a model are named by id, in their order; a row with no task names none', () => {
    const runs = [
      { key: SPARK, space: 'gtm', role: 'task' as const, id: 'POL-314' },
      { key: 'spark/other', space: 'gtm', role: 'task' as const, id: 'POL-9' },
      { key: SPARK, space: 'gtm', role: 'task' as const, id: 'POL-313' },
      { key: SPARK, space: '~', role: 'coordinator' as const },
    ]
    const spark = limitsView(input(settings(), { runs })).providers.find((p) => p.provider === 'spark')!
    expect(spark).toMatchObject({ byRole: { task: 3, coordinator: 1 }, tasks: ['POL-9', 'POL-313', 'POL-314'] })
    expect(spark.models.find((m) => m.key === SPARK)).toMatchObject({ byRole: { task: 2, coordinator: 1 }, tasks: ['POL-313', 'POL-314'] })
    const none = limitsView(input(settings(), { runs: [{ key: SPARK, space: '~', role: 'coordinator' }] })).providers.find((p) => p.provider === 'spark')!
    expect(none.tasks).toBeUndefined()
  })

  test('the + column can add any provider or model the summary or the CLIs list, each once, in lowercase', () => {
    const view = limitsView(input(settings()))
    const keys = view.known.map((k) => k.pattern)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every((k) => k === k.toLowerCase())).toBe(true)
    expect(view.known.find((k) => k.pattern === 'anthropic')).toMatchObject({ kind: 'provider', name: 'Claude Code' })
    expect(keys).toContain('anthropic/claude-opus-5-5')
  })
})

describe('what waits now: the held tasks grouped by what holds them, in the page’s order, with the advisor and reviews', () => {
  test('each group names its limit now, lists its tasks, and a model or space group names its entry', () => {
    const w = waitingOf(
      input(settings(), {
        working: 9,
        sample,
        herdr: true,
        held: [
          held({ id: 'A-1', why: 'resume', words: 'waits for the cut-off tasks' }),
          held({ id: 'A-2', why: 'space', space: 'gtm', spaceName: 'gtm', entry: { name: 'gtm', count: 2, max: 2 } }),
          held({ id: 'A-3', why: 'slots', words: 'waits for a slot' }),
          held({ id: 'A-4', why: 'machine', words: 'waits for the machine' }),
          held({ id: 'A-5', why: 'model', words: 'waits: spark 4/4', entry: { name: SPARK, count: 4, max: 4 } }),
          held({ id: 'A-6', why: 'model', words: 'waits: spark 4/4', entry: { name: SPARK, count: 4, max: 4 } }),
          held({ id: 'A-7', why: 'models', words: 'every model ran out' }),
          held({ id: 'A-8', why: 'space', space: 'gtm', spaceName: 'gtm', entry: { name: 'gtm', count: 2, max: 2 } }),
        ],
        advisor: [{ chat: 'A-9/Agent', task: 'A-9', words: "A-9's agent asks: which?" }],
        reviews: [{ task: 'A-10', space: 'home', words: 'Waits for a reviewer: Codex (out until 17:00)' }],
      }),
    )
    expect(w.held).toBe(8)
    expect(w.groups.map((g) => g.id)).toEqual(['slots', 'machine', `space:gtm`, `model:${SPARK}`, 'models', 'resume'])
    const by = Object.fromEntries(w.groups.map((g) => [g.id, g]))
    expect(by.slots).toMatchObject({ title: 'Machine slots are full', limit: '9 of 10 working' })
    expect(by.slots!.tasks.map((t) => t.id)).toEqual(['A-3'])
    expect(by.machine!.limit).toContain('CPU is busy')
    expect(by[`space:gtm`]).toMatchObject({ title: 'Space cap · gtm', limit: '2 of 2 working' })
    expect(by[`space:gtm`]!.tasks.map((t) => t.id)).toEqual(['A-2', 'A-8'])
    expect(by[`model:${SPARK}`]).toMatchObject({ limit: '4 of 4 at once' })
    expect(by.models!.tasks.map((t) => t.id)).toEqual(['A-7'])
    expect(by.resume!.tasks[0]!.words).toBe('waits for the cut-off tasks')
    expect(w.advisor).toEqual([{ chat: 'A-9/Agent', task: 'A-9', words: "A-9's agent asks: which?" }])
    expect(w.reviews).toEqual([{ task: 'A-10', space: 'home', words: 'Waits for a reviewer: Codex (out until 17:00)' }])
  })

  test('nothing held: no groups, and no limit names a number of waits', () => {
    const w = waitingOf(input(settings()))
    expect(w).toEqual({ held: 0, groups: [], advisor: [], reviews: [] })
  })

  test('a machine group with no limit that holds it now says the machine has room', () => {
    const w = waitingOf(input(settings(), { held: [held({ id: 'B-1', why: 'machine' })], sample: { ...sample, load: 1, load5: 1, memUsed: 10 }, herdr: true }))
    expect(w.groups[0]!.limit).toBe('the machine has room now: the next look starts it')
  })
})

describe('the Limits view as a whole', () => {
  test('the view carries every table, the caps the editors write from, and the waiting groups', () => {
    const s = settings({ machine: { 'models.maxAtOnce': 'spark=4' }, spaces: { gtm: { 'space.maxTasks': '2' } } })
    const view = limitsView(input(s, { held: [held({ id: 'C-1', why: 'slots' })], working: 10, sample }))
    expect(Object.keys(view).sort()).toEqual(['alerts', 'at', 'caps', 'known', 'machine', 'machineTable', 'providers', 'spaces', 'waiting'].sort())
    expect(view.caps.machine).toBe('spark=4')
    expect(view.caps.spaces.map((x) => x.key)).toEqual(['~', 'gtm'])
    expect(view.waiting.groups.map((g) => g.id)).toEqual(['slots'])
  })
})

describe('the demo world reads the same view (its own tasks, its fixtures for what holds them)', () => {
  test('the demo answers limits-view: the machine from its health, gtm’s cap and held task, the advisor and review waits, and a write goes through the setting action', async () => {
    const { DemoWorld } = await import('../server/demo/world.ts')
    const w = new DemoWorld()
    const v = (await w.act({ type: 'limits-view' })) as import('../shared/types.ts').LimitsView
    // the machine is over its load (the demo's health), so the held machine task says why
    expect(v.waiting.groups.map((g) => g.id)).toEqual(['machine', 'space:gtm'])
    expect(v.waiting.groups[0]!.limit).toContain('CPU is busy')
    expect(v.waiting.groups[1]).toMatchObject({ limit: '0 of 2 working' })
    expect(v.waiting.advisor.length).toBe(1)
    expect(v.waiting.reviews.length).toBe(1)
    expect(v.spaces.rows.find((r) => r.key === 'gtm')!.cells['space.maxTasks']).toMatchObject({ from: 'space', row: { value: '2' } })
    // a write from the page lands at its place, and the next read shows it
    expect(await w.act({ type: 'setting', key: 'machine.maxTasks', value: '7', place: `m:${'vm-str'}` })).toMatchObject({ ok: true })
    const after = (await w.act({ type: 'limits-view' })) as import('../shared/types.ts').LimitsView
    expect(after.machineTable.rows[1]!.cells['machine.maxTasks']).toMatchObject({ from: 'machine', row: { value: '7' } })
    // the summary the demo shows still reads (the Models page and the Limits page share its inputs)
    expect(((await w.act({ type: 'models-summary' })) as { providers: unknown[] }).providers.length).toBeGreaterThan(0)
  })
})

describe('the Limits providers that nothing uses yet: listed after the used ones, named, with their models and a cap of their own', () => {
  const NV = 'nvidia/mistralai/mistral-large-4-1t-a52b'
  const AMD = 'amd-tokenlab/Qwen3.8-27B'
  /** the catalog of the two providers, for each test's span */
  const withPi = (fn: () => void) => {
    const restore = piOffers()
    try {
      fn()
    } finally {
      restore()
    }
  }

  test('the providers table lists them after the used ones; the + column adds the provider or the model, each named as its row says', () => {
    withPi(() => {
      const view = limitsView(input(settings()))
      const nv = view.providers.find((p) => p.provider === 'nvidia')!
      expect(nv).toMatchObject({ name: 'NVIDIA API', idle: true, atOnce: { now: 0, held: 0 } })
      expect(nv.models.map((m) => [m.key, m.label])).toEqual([[NV, 'mistralai/mistral-large-4-1t-a52b']])
      expect(view.providers.find((p) => p.provider === 'amd-tokenlab')).toMatchObject({ name: 'AMD TokenLab', idle: true })
      // the used ones first: Claude Code runs the default roles here
      const flags = view.providers.map((p) => p.idle)
      expect(flags).toEqual([...flags].sort((a, b) => Number(a) - Number(b)))
      expect(view.providers[0]!.idle).toBe(false)
      // the + column: a provider by its name, a model with its provider in front, each once and in lowercase
      expect(view.known.find((k) => k.pattern === 'nvidia')).toEqual({ pattern: 'nvidia', name: 'NVIDIA API', kind: 'provider' })
      expect(view.known.find((k) => k.pattern === NV.toLowerCase())).toEqual({ pattern: NV.toLowerCase(), name: 'NVIDIA API · mistralai/mistral-large-4-1t-a52b', kind: 'model' })
      expect(view.known.find((k) => k.pattern === 'amd-tokenlab/qwen3.8-27b')?.name).toBe('AMD TokenLab · Qwen3.8-27B')
    })
  })

  test('a cap set on a provider nothing uses yet is written and read back: the row is in use from then on', () => {
    withPi(() => {
      const view = limitsView(input(settings({ machine: { 'models.maxAtOnce': 'nvidia=2' } })))
      const nv = view.providers.find((p) => p.provider === 'nvidia')!
      expect(nv).toMatchObject({ idle: false, atOnce: { own: { pattern: 'nvidia', max: 2, from: 'machine' } } })
      // in use, it is above the idle ones
      expect(view.providers.findIndex((p) => p.provider === 'nvidia')).toBeLessThan(view.providers.findIndex((p) => p.provider === 'amd-tokenlab'))
      // the + column still offers it: a pattern is added once, from the summary or the list
      expect(view.known.filter((k) => k.pattern === 'nvidia')).toHaveLength(1)
    })
  })
})

describe('0 in the waiting groups: blocked, set to 0 tasks, and the rest unchanged', () => {
  test('a task every model of which is blocked waits in its own group, with the blocked entry named; 0 tasks groups by where they are set', () => {
    const w = waitingOf(
      input(settings(), {
        held: [
          held({ id: 'Z-1', why: 'zero', words: 'waiting: this machine is set to 0 tasks' }),
          held({ id: 'Z-2', why: 'spaceZero', space: 'gtm', spaceName: 'gtm', words: 'waiting: gtm is set to 0 tasks' }),
          held({ id: 'B-1', why: 'blocked', entry: { name: 'spark', count: 0, max: 0 }, words: 'waiting: every model it may use is blocked (0 allowed): change its agent or a limit' }),
          held({ id: 'F-1', why: 'model', entry: { name: 'radeon', count: 1, max: 1 } }),
        ],
      }),
    )
    const ids = w.groups.map((g) => g.id)
    expect(ids).toEqual(['zero', 'spaceZero:gtm', 'model:radeon', 'blocked'])
    expect(w.groups.find((g) => g.id === 'zero')).toMatchObject({ title: 'This machine is set to 0 tasks', limit: '0 tasks', tasks: [{ id: 'Z-1', space: 'home', words: 'waiting: this machine is set to 0 tasks' }] })
    expect(w.groups.find((g) => g.id === 'spaceZero:gtm')).toMatchObject({ title: 'Space set to 0 tasks · gtm', limit: '0 tasks', tasks: [{ id: 'Z-2' }] })
    expect(w.groups.find((g) => g.id === 'blocked')).toMatchObject({ title: 'Every model blocked (0 allowed)', tasks: [{ id: 'B-1' }] })
    expect(w.held).toBe(4)
  })

  test('a machine at 0 tasks holds no slot count: its table reads 0 working, and off reads no limit at all', () => {
    const at0 = limitsView(input(settings({ machine: { 'machine.maxTasks': '0' } }), { working: 0 }))
    expect(at0.machineTable.rows[1]!.cells['machine.maxTasks']).toMatchObject({ from: 'machine', set: true, row: { value: '0' } })
    expect(at0.machineTable.rows[1]!.cells['machine.maxTasks']!.now).toBe('0 of 0 working')
    const off = limitsView(input(settings({ machine: { 'machine.maxTasks': 'off' } }), { working: 2 }))
    expect(off.machineTable.rows[1]!.cells['machine.maxTasks']).toMatchObject({ row: { value: 'off' } })
    expect(off.machineTable.rows[1]!.cells['machine.maxTasks']!.now).toBe('2 working')
  })
})
