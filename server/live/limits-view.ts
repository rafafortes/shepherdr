// Settings → Limits: every limit this machine holds, in one read. The machine's own (Max tasks, the start limits, the alert
// thresholds), each space's (Max tasks, Merge train, and its sub-limit per provider or model), the providers and models
// with their caps, and what waits now and why. Nothing is stored here and nothing is decided here: the settings are read
// at each level the way Settings reads them (Settings.pick), the numbers now come from the health sample and the engine's
// own accessors, the providers from the summary (models-summary.ts), and a write is the setting action at the cell's
// place. The page's cells, the held groups and the waits are built from these, with `now` as a parameter for a test.
import type { LimitCell, LimitColumn, LimitKnown, LimitProvider, LimitRow, LimitSpaceRow, LimitTable, LimitsView, MatrixRole, ModelsMatrix, ModelsSummary, SettingRow, WaitingGroup, WaitingNow, WaitingTask } from '../../shared/types.ts'
import { capFor, parseMaxAtOnce, type MaxEntry } from '../../shared/model-caps.ts'
import { busy, memPct, type Sample } from './health.ts'
import { placeId } from './places.ts'
import { covers } from './engine/choose.ts'
import type { HeldWhy } from './engine/engine.ts'
import { capsOf, keyOf, providerName, type RunOn } from './models-summary.ts'
import { CATALOG, kindOf, type Level, Settings } from './settings.ts'
import { providerOf } from './usage-ledger.ts'

/** the machine's keys that start tasks, in the order the page shows them */
export const MACHINE_KEYS = ['machine.maxTasks', 'machine.startLoad', 'machine.startPressure', 'machine.startMemory', 'machine.startEvery']
/** the keys of the coordinator's alerts (machine.alert…), the page's second group */
export const ALERT_KEYS = ['machine.alertLoad', 'machine.alertMemory', 'machine.alertDisk', 'machine.alertHerdr']
/** the per-space keys: Max tasks of a space, and its Merge train */
export const SPACE_KEYS = ['space.maxTasks', 'merge.train']

/** one held task as the engine holds it: its space (key and shown name), why it waits, its line in words, and the entry
 *  that holds it for its model (its name, what runs under it now and its limit) */
export interface HeldFact {
  id: string
  space: string
  spaceName: string
  why: HeldWhy
  words: string
  priority?: boolean
  entry?: { name: string; count: number; max: number }
}

export interface LimitsInput {
  now: number
  settings: Settings
  host: string
  machineName: string
  matrix: ModelsMatrix
  summary: ModelsSummary
  /** what counts toward models.maxAtOnce now: the model key, the space's key (~ for home) and the role that runs it */
  runs: (RunOn & { role: MatrixRole })[]
  held: HeldFact[]
  working: number
  waitingOnYou: number
  /** the working tasks of each space, by its key */
  workingIn: Record<string, number>
  /** the health sample (health.ts) and whether herdr answers */
  sample?: Sample
  herdr: boolean
  advisor: { chat: string; task?: string; words: string }[]
  reviews: { task: string; space: string; words: string }[]
  /** the patterns the + column can add */
  known: LimitKnown[]
}

/** the setting's row as Settings draws it (its label, hint and control), with the value its level reads */
function rowOf(key: string, value: string): SettingRow {
  const r = CATALOG.flatMap((s) => s.rows).find((x) => x.key === key)
  if (!r) throw new Error(`No setting ${key}`)
  return { ...r, value } as SettingRow
}

/** the label and the hint of a key, as Settings names it */
const titleOf = (key: string) => {
  const r = CATALOG.flatMap((s) => s.rows).find((x) => x.key === key)
  return { title: r?.label ?? key, hint: r?.hint }
}

/** the live number of a key beside its value, where the machine's sample gives one */
function nowOf(key: string, s: Sample | undefined, l: { max: number | null; working: number; waiting: number; herdr: boolean; atMachine: boolean }): string | undefined {
  if (key === 'machine.maxTasks') return l.atMachine ? `${l.working}${l.max === null ? '' : ` of ${l.max}`} working${l.waiting ? `, ${l.waiting} wait on you` : ''}` : undefined
  if (key === 'machine.alertHerdr') return l.atMachine ? (l.herdr ? 'herdr answers now' : "herdr doesn't answer now") : undefined
  if (!s || !l.atMachine) return undefined
  if (key === 'machine.startLoad') return `${((s.load5 ?? s.load) / s.cores).toFixed(2)}× cores now`
  if (key === 'machine.alertLoad') return `${(s.load / s.cores).toFixed(2)}× cores now`
  if (key === 'machine.startPressure') return s.cpuSome === undefined ? 'no pressure reading' : `${s.cpuSome}% now`
  if (key === 'machine.startMemory' || key === 'machine.alertMemory') return `${memPct(s)}% now`
  if (key === 'machine.alertDisk') return `${Math.max(0, ...s.disks.map((d) => d.pct))}% now`
  return undefined
}

/** one cell: a key at one level (Everywhere, this machine, or a space), with where its value comes from and the number now */
function cellOf(input: LimitsInput, key: string, level: Level, place: string, atMachine: boolean): LimitCell {
  const { settings: s } = input
  const p = s.pick(key, level)
  const kind = level === 'all' ? 'all' : level === 'machine' ? 'machine' : 'space'
  const words = nowOf(key, input.sample, { max: s.machine('machine').max, working: input.working, waiting: input.waitingOnYou, herdr: input.herdr, atMachine })
  return { key, place, row: rowOf(key, p.value), from: p.from, set: p.from === kind, ...(words ? { now: words } : {}) }
}

/** the rows of a machine table: Everywhere, then this machine, each with a cell per key */
function machineTable(input: LimitsInput, keys: string[], machinePlace: string): LimitTable {
  const cols: LimitColumn[] = keys.map((key) => ({ key, ...titleOf(key) }))
  const level = (id: string, name: string, kind: 'all' | 'machine', lvl: Level, place: string): LimitRow => ({
    id,
    name,
    kind,
    cells: Object.fromEntries(keys.map((key) => [key, cellOf(input, key, lvl, place, kind === 'machine')])),
  })
  const everywhere = level('all', 'Everywhere', 'all', 'all', 'all')
  const here = level(machinePlace, input.machineName, 'machine', 'machine', machinePlace)
  return { columns: cols, rows: [everywhere, here] }
}

/** the Machine table's columns: the start limits, and Merge train when Everywhere sets one (a default the spaces read) */
export function machineColumns(s: Settings): string[] {
  return s.pick('merge.train', 'all').from === 'all' ? [...MACHINE_KEYS, 'merge.train'] : MACHINE_KEYS
}

/** why the machine holds a task now, in words: herdr does not answer, its CPU is past the limit (load or pressure), or its memory */
export function machineReason(sample: Sample | undefined, herdr: boolean, s: Settings): string {
  const l = s.machine('machine')
  const why: string[] = []
  if (!herdr) why.push("herdr doesn't answer")
  if (sample) {
    const b = busy(sample, l)
    if (b === 'cpu') why.push(`CPU is busy: load ${((sample.load5 ?? sample.load) / sample.cores).toFixed(2)}× cores${l.startLoad !== null ? ` (limit ${l.startLoad}×)` : ''}${sample.cpuSome !== undefined && l.startPressure !== null ? `, pressure ${sample.cpuSome}% (limit ${l.startPressure}%)` : ''}`)
    if (b === 'memory') why.push(`memory ${memPct(sample)}% (limit ${l.startMemory}%)`)
  }
  return why.join(' · ') || 'the machine has room now: the next look starts it'
}

/** the held tasks grouped by what holds them, in the order the page names them: machine slots, the machine's load, its
 *  spaces' caps (one group each), the models' caps (one group each, by the entry that holds them), every model out, and the
 *  cut-off tasks that go back to work first */
export function waitingOf(input: LimitsInput): WaitingNow {
  const task = (h: HeldFact): WaitingTask => ({ id: h.id, space: h.spaceName, words: h.words })
  const of = (why: HeldWhy) => input.held.filter((h) => h.why === why)
  const groups: WaitingGroup[] = []
  const machine = input.settings.machine('machine')
  if (of('slots').length)
    groups.push({ id: 'slots', title: 'Machine slots are full', limit: `${input.working}${machine.max === null ? '' : ` of ${machine.max}`} working`, tasks: of('slots').map(task) })
  if (of('machine').length) groups.push({ id: 'machine', title: 'The machine is too busy', limit: machineReason(input.sample, input.herdr, input.settings), tasks: of('machine').map(task) })
  const spaces = [...new Set(of('space').map((h) => h.space))]
  for (const key of spaces) {
    const hs = of('space').filter((h) => h.space === key)
    const e = hs[0]!.entry
    groups.push({ id: `space:${key}`, title: `Space cap · ${hs[0]!.spaceName}`, limit: e ? `${e.count} of ${e.max} working` : undefined, tasks: hs.map(task) })
  }
  const entries = [...new Set(of('model').map((h) => h.entry?.name ?? 'model'))]
  for (const name of entries) {
    const hs = of('model').filter((h) => (h.entry?.name ?? 'model') === name)
    const e = hs[0]!.entry
    groups.push({ id: `model:${name}`, title: `Model cap · ${name}`, limit: e ? `${e.count} of ${e.max} at once` : undefined, tasks: hs.map(task) })
  }
  if (of('models').length) groups.push({ id: 'models', title: 'Every model of the space ran out', tasks: of('models').map(task) })
  if (of('resume').length) groups.push({ id: 'resume', title: 'Cut-off tasks go back to work first', tasks: of('resume').map(task) })
  return { held: input.held.length, groups, advisor: input.advisor, reviews: input.reviews }
}

/** home's key: its settings are the `~` level (places.ts HOME_KEY) */
const HOME = '~'

/** the patterns the models.maxAtOnce entries name, in the order they are first set: this machine's (Everywhere's while it
 *  sets none), then each space's own (the spaces by key) */
export function entryPatterns(s: Settings, spaceKeys: string[]): string[] {
  const machine = capsOf(s).entries.map((e) => e.pattern)
  const spaces = spaceKeys.flatMap((k) => {
    const p = s.pick('models.maxAtOnce', { space: k })
    const c = p.from === 'space' ? parseMaxAtOnce(p.value) : undefined
    return c?.ok ? c.entries.map((e) => e.pattern) : []
  })
  return [...new Set([...machine, ...spaces])]
}

/** the + column's choices: every provider the summary shows, every model it lists, and the models each CLI's own list
 *  has (the Models page's catalog), each once, lowercase as the entries are */
export function knownOf(matrix: ModelsMatrix, summary: ModelsSummary): LimitKnown[] {
  const out = new Map<string, LimitKnown>()
  const add = (pattern: string, name: string, kind: LimitKnown['kind']) => {
    const k = pattern.toLowerCase()
    if (!out.has(k)) out.set(k, { pattern: k, name, kind })
  }
  for (const p of summary.providers) add(p.provider, p.name, 'provider')
  for (const p of summary.providers) for (const m of p.models) add(m.key, m.label, 'model')
  for (const [cli, cat] of Object.entries(matrix.catalog)) {
    const kind = kindOf(cli)
    if (!kind) continue
    for (const m of cat.models) {
      const key = keyOf(kind, m.id)
      add(providerOf(key), providerName(providerOf(key)), 'provider')
      add(key, m.label, 'model')
    }
  }
  return [...out.values()]
}

/** the runs that cover a pattern (a provider or a model key), by the role that runs them */
function byRoleOf(runs: (RunOn & { role: MatrixRole })[], covered: (key: string) => boolean): LimitProvider['byRole'] {
  const out: LimitProvider['byRole'] = {}
  for (const r of runs) if (covered(r.key)) out[r.role] = (out[r.role] ?? 0) + 1
  return out
}

/** the Spaces table: each space of this machine, its Max tasks and Merge train, and its sub-limit per pattern column */
function spacesOf(input: LimitsInput): LimitsView['spaces'] {
  const { matrix, summary, settings: s, runs } = input
  const machineEntries: MaxEntry[] = capsOf(s).entries
  // a space's own entries, as its cap text holds them
  const own = (key: string): MaxEntry[] => {
    const p = parseMaxAtOnce(summary.caps.spaces.find((x) => x.key === key)?.text ?? '')
    return p.ok ? p.entries : []
  }
  // the pattern columns: each entry the machine or a space sets, in the order they are first set
  const patterns = entryPatterns(s, summary.caps.spaces.map((sp) => sp.key))
  const totals = Object.fromEntries(
    patterns.flatMap((p) => {
      const e = capFor(machineEntries, p)
      return e ? [[p, { pattern: e.pattern, max: e.max }]] : []
    }),
  )
  const cols: LimitColumn[] = SPACE_KEYS.map((key) => ({ key, ...titleOf(key) }))
  // the spaces of this machine as the Models table lists them, and home too when it sets one of these keys itself
  const listed = matrix.rows.filter((r) => r.kind === 'space').map((r) => ({ id: r.id, name: r.name, key: r.id.split(':')[2]! }))
  const homeSets = [...SPACE_KEYS, 'models.maxAtOnce'].some((k) => s.pick(k, { space: HOME }).from === 'space')
  if (homeSets && !listed.some((x) => x.key === HOME)) listed.unshift({ id: placeId.home(input.host), name: 'home', key: HOME })
  const rows: LimitSpaceRow[] = listed.map(({ id, name, key }) => {
    const working = input.workingIn[key] ?? 0
    const held = input.held.filter((h) => h.space === key).length
    const maxTasks = s.spaceMax(key)
    const cells: Record<string, LimitCell> = {
      'space.maxTasks': {
        ...cellOf(input, 'space.maxTasks', { space: key }, id, false),
        now: `${working}${maxTasks === null ? '' : ` of ${maxTasks}`} working${held ? ` · ${held} held` : ''}`,
      },
      'merge.train': cellOf(input, 'merge.train', { space: key }, id, false),
    }
    const caps = Object.fromEntries(
      own(key).map((e) => [e.pattern, { max: e.max, now: runs.filter((x) => x.space === key && covers(e.pattern, x.key)).length }]),
    )
    return { id, name, kind: 'space' as const, key, working, held, cells, caps }
    })
  return { columns: cols, rows, patterns, totals }
}

/** the Providers table: every provider the summary has (its entries, agents, runs, usage or run-outs), with what runs by role */
function providersOf(input: LimitsInput): LimitProvider[] {
  return input.summary.providers.map((p) => ({
    ...p,
    byRole: byRoleOf(input.runs, (k) => providerOf(k) === p.provider),
    models: p.models.map((m) => ({ ...m, byRole: byRoleOf(input.runs, (k) => k === m.key) })),
  }))
}

/** the view of Settings → Limits: every table, the providers and the waiting groups (read only; the writes are the setting action) */
export function limitsView(input: LimitsInput): LimitsView {
  const { settings: s, matrix } = input
  const machinePlace = matrix.machine.id
  return {
    at: input.now,
    machine: { id: machinePlace, name: input.machineName, herdr: input.herdr },
    machineTable: machineTable(input, machineColumns(s), machinePlace),
    alerts: machineTable(input, ALERT_KEYS, machinePlace),
    spaces: spacesOf(input),
    providers: providersOf(input),
    caps: input.summary.caps,
    known: input.known,
    waiting: waitingOf(input),
  }
}

