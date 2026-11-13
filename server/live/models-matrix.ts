// Settings → Models: every level's agent settings in one table, read in one go. Rows are Everywhere, this machine and
// its spaces (the home space only when it sets one of these keys itself); columns are each role's primary and backups
// (task.agent … and task.fallback…, coordinator, reviewer, advisor), then two plain ones (space.maxTasks, merge.train).
// Nothing is stored here: a cell's value is the setting Settings reads at that row's level, and a write goes through the
// same setting action at the row's place. The summary phase reads the same matrix (rows × keys with where each value
// comes from).
import type { MatrixCatalog, MatrixCell, MatrixRole, MatrixRow, MatrixSlot, MatrixValue, ModelsMatrix } from '../../shared/types.ts'
import { fitHarness } from './restart.ts'
import { agentRow, Chain, CLI_NAME, kindOf, optionsOf, rolePairs, Settings, type Level, type LevelKind } from './settings.ts'
import { effortsOf, findModel, knowsModels } from './models.ts'
import { placeId } from './places.ts'

/** the roles the table's column groups are, in order */
const ROLES: { role: MatrixRole; title: string; chain: Chain }[] = [
  { role: 'task', title: 'Tasks', chain: 'task' },
  { role: 'coordinator', title: 'Coordinators', chain: 'coordinator' },
  { role: 'reviewer', title: 'Reviewer', chain: 'reviewer' },
  { role: 'advisor', title: 'Advisor', chain: 'advisor' },
]

/** the plain columns after the roles: one key each, its title on screen */
export const PLAIN_COLUMNS: ModelsMatrix['plain'] = [
  { key: 'space.maxTasks', title: 'Max tasks', num: { min: 1, max: 200, off: true } },
  { key: 'merge.train', title: 'Merge train', options: optionsOf('merge.train') },
]

/** the home space's key: its settings are the `~` level (places.ts placeId.home) */
const HOME = '~'

/** every role's slots, the primary first and then its backups in turn: the columns of the table, in order */
export function matrixSlots(): MatrixSlot[] {
  return ROLES.flatMap(({ role, title, chain }) =>
    rolePairs(chain).map((p, n) => ({
      id: `${role}.${n}`,
      role,
      title,
      name: n === 0 ? 'Primary' : `Backup ${n}`,
      n,
      cli: p.cli,
      model: p.model,
      effort: p.effort,
      clis: optionsOf(p.cli) ?? [],
    })),
  )
}

/** a key's value as its level reads it, where it comes from, and whether it is set at that level itself */
function valueAt(s: Settings, key: string, l: Level, kind: LevelKind): MatrixValue {
  const own = s.pick(key, l)
  const read = s.readAt(key, l)
  return { value: read.value, from: read.from, set: own.from === kind, ...(read.follows ? { follows: read.follows } : {}) }
}

/** a slot's CLI, model and effort in words: "pi · opencode-go/deepseek-v4.1-flash · high", "Codex", "off" */
export function wordsOf(cli: string, model: string, effort: string): string {
  const kind = kindOf(cli)
  if (!kind) return 'off'
  const h = fitHarness({ kind, model, effort })
  const label = h.model ? (findModel(kind, h.model)?.label ?? h.model) : ''
  return [CLI_NAME[kind] ?? kind, label, h.effort].filter(Boolean).join(' · ')
}

/** what one CLI takes, as its Settings rows list it for the task agent's keys (the same words, so a choice fits) */
function catalogOf(s: Settings, kind: string): MatrixCatalog {
  const get = (key: string) => (key === 'task.agent' ? (CLI_NAME[kind] ?? kind) : 'default')
  const picks = (k: string) => s.picksAt(k)
  const model = agentRow({ group: '', label: 'Model', key: 'task.model', value: 'default', text: true }, get, picks)
  const effort = agentRow({ group: '', label: 'Effort', key: 'task.effort', value: 'default' }, get, picks)
  const listed = model.options?.slice(1) ?? []
  return {
    known: knowsModels(kind),
    models: listed.map((label) => {
      const id = model.ids?.[label] ?? label
      return { label, id, efforts: effortsOf(kind, id) }
    }),
    efforts: (effort.options ?? ['default']).slice(1),
  }
}

/**
 * The whole table for this machine: its Everywhere, machine and space rows, as a screen or a summary reads them. `spaces`:
 * this machine's spaces, each with its key (its folder's name, or ~ for home) and the name it shows.
 */
export function modelsMatrix(s: Settings, machine: { host: string; name: string }, spaces: { key: string; name: string }[]): ModelsMatrix {
  const slots = matrixSlots()
  const plain = PLAIN_COLUMNS
  const keys = [...new Set([...slots.flatMap((x) => [x.cli, x.model, x.effort]), ...plain.map((p) => p.key)])]
  // the home space shows only when it sets one of these keys itself: its settings are the operator's to find in Settings
  const home = spaces.find((sp) => sp.key === HOME)
  const homeSets = !!home && keys.some((k) => s.pick(k, { space: HOME }).from === 'space')
  const levels: { id: string; name: string; kind: LevelKind; level: Level }[] = [
    { id: 'all', name: 'Everywhere', kind: 'all', level: 'all' },
    { id: placeId.machine(machine.host), name: machine.name, kind: 'machine', level: 'machine' },
    ...spaces.filter((sp) => sp.key !== HOME || homeSets).map((sp) => ({ id: placeId.space(sp.key, machine.host), name: sp.name, kind: 'space' as const, level: { space: sp.key } })),
  ]
  const rows: MatrixRow[] = levels.map(({ id, name, kind, level }) => {
    const values = Object.fromEntries(keys.map((k) => [k, valueAt(s, k, level, kind)]))
    // a model shows its label, a CLI its name: what the screen's words and the options speak
    for (const x of slots) {
      const cli = values[x.cli]!
      const kind = kindOf(cli.value)
      const model = values[x.model]!
      cli.value = kind ? (CLI_NAME[kind] ?? kind) : cli.value
      model.value = findModel(kind ?? '', model.value)?.label ?? model.value
    }
    const cells = Object.fromEntries(
      slots.map((x): [string, MatrixCell] => [
        x.id,
        {
          words: wordsOf(values[x.cli]!.value, values[x.model]!.value, values[x.effort]!.value),
          set: [x.cli, x.model, x.effort].some((k) => values[k]!.set),
          from: values[x.cli]!.from,
        },
      ]),
    )
    return { id, name, kind, values, cells }
  })
  const catalog: Record<string, MatrixCatalog> = {}
  // keyed by the CLI's name, as a cell's value and the choices of its row are
  for (const x of slots) for (const c of x.clis) {
    const kind = kindOf(c)
    if (kind && !catalog[CLI_NAME[kind] ?? kind]) catalog[CLI_NAME[kind] ?? kind] = catalogOf(s, kind)
  }
  return { machine: { id: placeId.machine(machine.host), name: machine.name }, slots, plain, rows, catalog }
}
