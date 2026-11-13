// Settings → Models: every level's agent settings in one table. Rows are Everywhere, this machine and its spaces; columns
// are each role's primary and backups (Tasks, Coordinators, Reviewer, Advisor), then Max tasks and Merge train. A cell
// opens a small popover (a phone: the same controls under its line) with the CLI, model and effort it runs on, and
// writes the same setting keys at that row's level, through the setting action. The bulk actions: a column's "Set for
// every space…" and a space's "Copy models to…", each confirmed first. The table comes from one read (models-matrix.ts).
import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MatrixRow, MatrixSlot, ModelsMatrix, ModelsSummary as Summary, SettingRow } from '@shared/types.ts'
import { act, useSnap } from './kernel.ts'
import { askWaitingMany } from './apply-waiting.tsx'
import { Anchored, OnTop } from './anchored.tsx'
import { Pop } from './cell-pop.tsx'
import { ProfilesBar } from './Profiles.tsx'
import { Control, openPage } from './Settings.tsx'
import { Dialog } from './rowmenu.tsx'
import ModelsSummary from './ModelsSummary.tsx'
import QuotaSettings from './QuotaSettings.tsx'
import { Ghost, Menu, MenuItem, MoreIcon, Primary, Small, ic } from './ui.tsx'

/** a CLI's name when it is off: a backup that doesn't run */
const OFF = 'off'
type Plain = ModelsMatrix['plain'][number]
/** what an editor changes: one slot of a role (its CLI, model and effort), or one plain column */
type Target = { slot: MatrixSlot } | { plain: Plain }
/** one setting key written, its value (null: reset to what the level above gives) */
type Write = [key: string, value: string | null]

const keysOf = (t: Target) => ('slot' in t ? [t.slot.cli, t.slot.model, t.slot.effort] : [t.plain.key])
const idOf = (row: MatrixRow, t: Target) => `${row.id}|${'slot' in t ? t.slot.id : t.plain.key}`
const isOn = (row: MatrixRow, key: string) => row.values[key]!.value.trim().toLowerCase() !== OFF
/** the highest backup a row has on (0: none, the primary only) among these slots */
const topOf = (row: MatrixRow, slots: MatrixSlot[]) => slots.reduce((h, x) => (x.n > 0 && isOn(row, x.cli) ? x.n : h), 0)
/** where a value comes from, in words */
const fromWord = (m: ModelsMatrix, from: MatrixRow['cells'][string]['from']) => (from === 'all' ? 'Everywhere' : from === 'machine' ? m.machine.name : from === 'space' ? 'this space' : 'default')
const kindWords = (row: MatrixRow) => (row.kind === 'all' ? 'every machine' : row.kind === 'machine' ? 'this machine' : 'space')

/** the columns: each role's slots, the primary and the backups its rows reach (Backup 1 always), and whether a "+" column
 *  is needed (some row has a backup to add) */
interface Group {
  role: MatrixSlot['role']
  title: string
  slots: MatrixSlot[]
  all: MatrixSlot[]
  plus: boolean
}
function groupsOf(m: ModelsMatrix): Group[] {
  const roles = [...new Set(m.slots.map((x) => x.role))]
  return roles.map((role) => {
    const all = m.slots.filter((x) => x.role === role)
    const reach = Math.max(1, ...m.rows.map((r) => topOf(r, all)))
    return { role, title: all[0]!.title, all, slots: all.slice(0, reach + 1), plus: m.rows.some((r) => topOf(r, all) < all.length - 1) }
  })
}

/** the rows an editor's controls are: a slot's Agent, Model and Effort (a backup's Backup, Backup model, Backup effort), or
 *  a plain column's one control; the model and effort rows offer what the CLI takes, as Settings does */
function controlsOf(m: ModelsMatrix, row: MatrixRow, t: Target): SettingRow[] {
  if ('plain' in t) return [{ label: t.plain.title, key: t.plain.key, value: row.values[t.plain.key]!.value, options: t.plain.options, num: t.plain.num }]
  const { slot } = t
  const cli = row.values[slot.cli]!.value
  const cat = cli === OFF ? undefined : m.catalog[cli]
  const [a, b, c] = slot.n === 0 ? ['Agent', 'Model', 'Effort'] : ['Backup', 'Backup model', 'Backup effort']
  const model = row.values[slot.model]!.value
  const picked = cat?.models.find((x) => x.label === model)
  const levels = picked?.efforts ?? cat?.efforts ?? []
  const modelRow: SettingRow = !cat
    ? { label: b, key: slot.model, value: 'default', fixed: true }
    : !cat.known
      ? { label: b, key: slot.model, value: model, text: true }
      : { label: b, key: slot.model, value: model, ordered: true, options: ['default', ...cat.models.map((x) => x.label), ...(model === 'default' || picked ? [] : [model])], ids: Object.fromEntries(cat.models.map((x) => [x.label, x.id])) }
  return [
    { label: a, key: slot.cli, value: cli, options: slot.clis },
    modelRow,
    cat ? { label: c, key: slot.effort, value: row.values[slot.effort]!.value, options: ['default', ...levels] } : { label: c, key: slot.effort, value: 'default', fixed: true },
  ]
}

/** the writes one control's change makes: a CLI's change also resets a model or an effort the new CLI lacks (a model
 *  change, an effort the model lacks), so the change is never refused for a value the screen itself moved */
function writesOf(m: ModelsMatrix, row: MatrixRow, t: Target, key: string, value: string): Write[] {
  if ('plain' in t) return [[key, value]]
  const { slot } = t
  if (key === slot.cli) {
    const cat = value === OFF ? undefined : m.catalog[value]
    const writes: Write[] = [[key, value]]
    if (!cat) return writes
    const model = row.values[slot.model]!.value
    const known = cat.models.find((x) => x.label === model)
    let levels = known?.efforts ?? cat.efforts
    if (cat.known && model !== 'default' && !known) {
      writes.push([slot.model, 'default'])
      levels = cat.efforts
    }
    const effort = row.values[slot.effort]!.value
    if (effort !== 'default' && !levels.includes(effort)) writes.push([slot.effort, 'default'])
    return writes
  }
  if (key === slot.model) {
    const cat = m.catalog[row.values[slot.cli]!.value]
    const levels = cat?.models.find((x) => x.label === value)?.efforts ?? cat?.efforts ?? []
    const effort = row.values[slot.effort]!.value
    return effort !== 'default' && !levels.includes(effort) ? [[key, value], [slot.effort, 'default']] : [[key, value]]
  }
  return [[key, value]]
}

/** the reset of a target's keys set in this row: each goes back to what the level above gives */
const resetOf = (row: MatrixRow, t: Target): Write[] => keysOf(t).filter((k) => row.values[k]?.set).map((k): Write => [k, null])

/** a row with some values changed: the draft a bulk dialog edits */
const withValues = (row: MatrixRow, writes: Write[]): MatrixRow => ({
  ...row,
  values: { ...row.values, ...Object.fromEntries(writes.map(([k, v]) => [k, { ...row.values[k]!, value: v ?? 'default' }])) },
})

/** writes a row's settings at its place, in order, stopping at the first refusal: the keys that went through, and why it stopped */
async function writeAt(place: string, writes: Write[]): Promise<{ keys: string[]; error?: string }> {
  const keys: string[] = []
  for (const [key, value] of writes) {
    const r = (await act({ type: 'setting', key, value, place }).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok?: boolean; error?: string }
    if (!r?.ok) return { keys, error: r?.error ?? "That didn't go through." }
    keys.push(key)
  }
  return { keys }
}

/** an editor: the controls of one cell, a reset to what the level above gives (when a key is set here), what went wrong,
 *  and what else it offers under them */
export function Editor({ phone, title, controls, reset, error, onSet, onReset, footer }: { phone: boolean; title?: string; controls: SettingRow[]; reset: boolean; error?: string; onSet: (key: string, value: string) => void; onReset: () => void; footer?: ReactNode }) {
  return (
    <div className={clsx('flex flex-col gap-2', phone ? 'px-4 pt-1 pb-3' : 'w-72')}>
      {title ? <Small className="text-pretty font-medium">{title}</Small> : null}
      <dl className="flex flex-col gap-1.5">
        {controls.map((row) => (
          // a limit's three choices are a column of their own under its name (LimitChoice), not a control beside it
          <div key={row.key} className={clsx('flex min-h-9 gap-3', row.num?.limit ? 'flex-col items-start' : 'items-center justify-between')}>
            <dt className="shrink-0 text-fg2">{row.label}</dt>
            <dd className={clsx('flex min-w-0', row.num?.limit ? 'w-full' : 'max-w-[65%] justify-end')}>
              <Control row={row} phone={phone} set={(v) => onSet(row.key, v)} edit={() => undefined} />
            </dd>
          </div>
        ))}
      </dl>
      {error ? <Refused text={error} /> : null}
      {reset || footer ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {reset ? <Ghost onClick={onReset} className="text-accent">Reset to inherited</Ghost> : <span />}
          {footer}
        </div>
      ) : null}
    </div>
  )
}

/** what a change refused, under the controls it came from: said once, as a status a screen reader hears */
export function Refused({ text }: { text: string }) {
  return (
    <Small role="status" className="text-pretty text-need-fg!">
      {text}
    </Small>
  )
}

export default function ModelsPage({ phone }: { phone: boolean }) {
  const snap = useSnap()
  const [m, setM] = useState<ModelsMatrix | null>(null)
  const [failed, setFailed] = useState('')
  // the summary under the table: read with it (its numbers move as the logs are read and the agents work)
  const [summary, setSummary] = useState<Summary | null>(null)
  // the editor open (its cell's id) and what its last change refused
  const [open, setOpen] = useState<{ id: string; error?: string } | null>(null)
  // the summary's cap cell open (cap|<row>, see CapCell), and a ⋯ menu open (a column's or a space's), and the bulk dialogs
  const [capOpen, setCapOpen] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [bulk, setBulk] = useState<MatrixSlot | null>(null)
  const [copy, setCopy] = useState<MatrixRow | null>(null)
  // every change of Settings is a new snapshot: the table reads again
  useEffect(() => {
    let live = true
    act({ type: 'models-matrix' })
      .then((r) => live && setM(r as ModelsMatrix))
      .catch((e: Error) => live && setFailed(e.message))
    return () => {
      live = false
    }
  }, [snap])
  useEffect(() => {
    let live = true
    act({ type: 'models-summary' })
      .then((r) => live && setSummary(r as Summary))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [snap])
  if (!m) return <p className="px-6 pt-5 text-fg2">{failed || 'Reading every level…'}</p>
  const groups = groupsOf(m)
  const spaces = m.rows.filter((r) => r.kind === 'space')
  const machine = m.rows.find((r) => r.kind === 'machine')!
  const toggle = (id: string, next?: { id: string }) => setOpen(open?.id === id ? null : (next ?? { id }))
  /** a warning's Change: the cell's editor opens, and the cell is brought into view first */
  const goTo = (row: string, slot: string) => {
    // a cap of the summary (a warning's Change…) opens its own cell, under the summary
    const id = row === 'cap' ? `cap|${slot}` : `${row}|${slot}`
    if (row === 'cap') setCapOpen(id)
    else setOpen({ id })
    requestAnimationFrame(() => document.querySelector(`[data-cell="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' }))
  }
  /** a cell's change, or its reset: written at its row's place, and asked about the waiting tasks once it is through */
  const apply = async (row: MatrixRow, t: Target, writes: Write[]) => {
    const r = await writeAt(row.id, writes)
    if (r.keys.length) void askWaitingMany(r.keys.map((key) => ({ key, place: row.id })))
    setOpen({ id: idOf(row, t), error: r.error })
  }
  /** the editor of a cell, while it is the one open */
  const editorOf = (row: MatrixRow, t: Target) => {
    if (open?.id !== idOf(row, t)) return null
    return (
      <Editor
        phone={phone}
        title={'slot' in t ? `${row.name} · ${t.slot.title} · ${t.slot.name}` : `${row.name} · ${t.plain.title}`}
        controls={controlsOf(m, row, t)}
        reset={resetOf(row, t).length > 0}
        error={open.error}
        onSet={(key, value) => void apply(row, t, writesOf(m, row, t, key, value))}
        onReset={() => void apply(row, t, resetOf(row, t))}
        footer={'slot' in t ? (
          <Ghost onClick={() => { setOpen(null); setBulk(t.slot) }} className="text-accent">
            Set for every space…
          </Ghost>
        ) : undefined}
      />
    )
  }
  /** a ⋯ button and its menu, for a column's header or a space's row */
  const more = (id: string, label: string, items: ReactNode, end = true) => (
    <span className="relative inline-flex">
      <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={menu === id} onClick={() => setMenu(menu === id ? null : id)} className="press-dim grid size-6 place-items-center rounded-full text-fg3 hover:bg-sel hover:text-fg aria-expanded:bg-sel aria-expanded:text-fg">
        <MoreIcon className={ic} />
      </button>
      {menu === id ? (
        <Anchored end={end}>
          <Menu label="More" onClose={() => setMenu(null)} className="min-w-56 text-left">
            {items}
          </Menu>
        </Anchored>
      ) : null}
    </span>
  )
  const copyItem = (row: MatrixRow) => (
    <MenuItem
      onClick={() => {
        setMenu(null)
        setCopy(row)
      }}
    >
      Copy this space's models to…
    </MenuItem>
  )
  const setEverySpace = (slot: MatrixSlot) => (
    <MenuItem
      onClick={() => {
        setMenu(null)
        setBulk(slot)
      }}
    >
      Set for every space…
    </MenuItem>
  )
  /** the "+": the next backup of a row, starting on the CLI of the one before it (Settings' Add a backup does the same),
   *  then its editor open for the rest */
  const add = (row: MatrixRow, slot: MatrixSlot) => {
    const before = [...m.slots.filter((x) => x.role === slot.role && x.n < slot.n)].reverse().map((x) => row.values[x.cli]!.value).find((v) => v !== OFF)
    void apply(row, { slot }, [[slot.cli, before ?? slot.clis.find((c) => c !== OFF) ?? OFF]])
  }
  const cellOf = (row: MatrixRow, slot: MatrixSlot) => row.cells[slot.id]!
  const plainSet = (row: MatrixRow, p: Plain) => row.values[p.key]!.set
  const plainWords = (row: MatrixRow, p: Plain) => row.values[p.key]!.value

  if (phone) {
    return (
      <div className="flex flex-col gap-5 px-4 pb-6">
        <ProfilesBar phone={phone} />
        <LimitsLink />
        {m.rows.map((row) => (
          <section key={row.id} aria-label={row.name} className="rounded-box bg-bg shadow-[inset_0_0_0_1px_var(--line)] dark:bg-bubble">
            <div className="flex items-center gap-2 px-4 pt-3 pb-1">
              <h3 className="min-w-0 flex-1 truncate font-medium">{row.name}</h3>
              <Small>{kindWords(row)}</Small>
              {row.kind === 'space' ? more(`row:${row.id}`, `More for ${row.name}`, copyItem(row)) : null}
            </div>
            {groups.map((g) => {
              const next = g.all[topOf(row, g.all) + 1]
              return (
                <div key={g.role} className="px-4 pb-1">
                  <h4 className="pt-2 pb-1 text-[0.8125rem] text-fg2">{g.title}</h4>
                  <ul className="flex flex-col">
                    {g.slots.map((slot) => {
                      const cell = cellOf(row, slot)
                      const t: Target = { slot }
                      return (
                        <li key={slot.id} className="flex flex-col">
                          <button type="button" data-cell={idOf(row, t)} aria-expanded={open?.id === idOf(row, t)} onClick={() => toggle(idOf(row, t))} className="press flex min-h-11 w-full items-center justify-between gap-3 text-left">
                            <span className="shrink-0 text-fg2">{slot.name}</span>
                            <span className={clsx('min-w-0 truncate text-right', cell.set ? 'text-fg' : 'text-fg3')} title={cell.words}>
                              {cell.words}
                              {cell.set ? null : <span className="block text-[0.75rem] text-fg3">{fromWord(m, cell.from)}</span>}
                            </span>
                          </button>
                          {editorOf(row, t)}
                        </li>
                      )
                    })}
                    {g.plus && next ? (
                      <li className="flex flex-col">
                        <button type="button" onClick={() => add(row, next)} className="press flex min-h-11 items-center font-medium text-accent">
                          Add {next.name}
                        </button>
                        {editorOf(row, { slot: next })}
                      </li>
                    ) : null}
                  </ul>
                </div>
              )
            })}
            <ul className="flex flex-col px-4 pt-1 pb-2">
              {m.plain.map((p) => {
                const t: Target = { plain: p }
                return (
                  <li key={p.key} className="flex flex-col">
                    <button type="button" aria-expanded={open?.id === idOf(row, t)} onClick={() => toggle(idOf(row, t))} className="press flex min-h-11 w-full items-center justify-between gap-3 text-left">
                      <span className="text-fg2">{p.title}</span>
                      <span className={clsx(plainSet(row, p) ? 'text-fg' : 'text-fg3')}>{plainWords(row, p)}</span>
                    </button>
                    {editorOf(row, t)}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
        {summary ? <ModelsSummary s={summary} phone={phone} go={goTo} extra={<QuotaSettings phone={phone} />} capOpen={capOpen} onCapOpen={setCapOpen} /> : null}
        <OnTop>
          {bulk ? <SetForEverySpace m={m} slot={bulk} phone={phone} onClose={() => setBulk(null)} /> : null}
          {copy ? <CopyModels m={m} from={copy} targets={spaces.filter((r) => r.id !== copy.id)} onClose={() => setCopy(null)} /> : null}
        </OnTop>
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-3 px-6 pt-5 pb-8">
      <ProfilesBar phone={phone} />
      <LimitsLink />
      {/* the table scrolls in its own box, both ways: its header rows and the Level column stay in view */}
      <div className="max-h-[min(70vh,44rem)] max-w-full overflow-auto overscroll-contain">
        <table aria-label="Models by level" className="w-max border-separate border-spacing-0 text-[0.8125rem]">
          <thead>
            <tr>
              <th rowSpan={2} scope="col" className="sticky top-0 left-0 z-30 min-w-44 bg-bg pr-4 pb-2 text-left align-bottom font-medium text-fg3">
                Level
              </th>
              {groups.map((g) => (
                <th key={g.role} colSpan={g.slots.length + (g.plus ? 1 : 0)} scope="colgroup" className="sticky top-0 z-20 h-7 border-l border-line bg-bg px-2 pt-0.5 pb-1 text-left font-medium text-fg2">
                  {g.title}
                </th>
              ))}
              <th rowSpan={2} scope="col" className="sticky top-0 z-20 border-l border-line bg-bg px-2 pb-2 text-left align-bottom font-medium text-fg3">
                Max tasks
              </th>
              <th rowSpan={2} scope="col" className="sticky top-0 z-20 bg-bg px-2 pb-2 text-left align-bottom font-medium text-fg3">
                Merge train
              </th>
            </tr>
            <tr>
              {groups.flatMap((g) => [
                ...g.slots.map((slot, i) => (
                  <th key={slot.id} scope="col" className={clsx('sticky top-7 z-20 bg-bg px-2 pb-2 text-left align-bottom font-medium whitespace-nowrap text-fg3', i === 0 && 'border-l border-line')}>
                    <span className="inline-flex items-center gap-1">
                      {slot.name}
                      {more(`slot:${slot.id}`, `More for ${g.title} · ${slot.name}`, setEverySpace(slot))}
                    </span>
                  </th>
                )),
                ...(g.plus ? [<th key={`${g.role}-plus`} scope="col" className="sticky top-7 z-20 bg-bg px-2 pb-2 text-left align-bottom font-medium text-fg3">+</th>] : []),
              ])}
            </tr>
          </thead>
          <tbody>
            {m.rows.map((row) => (
              <tr key={row.id}>
                <th scope="row" className="sticky left-0 z-10 bg-bg pr-4 py-1.5 text-left font-normal">
                  <span className="inline-flex max-w-full items-center gap-1.5">
                    <span className={clsx('truncate', row.kind === 'space' ? 'text-fg' : 'font-medium')}>{row.name}</span>
                    {row.kind === 'space' ? more(`row:${row.id}`, `More for ${row.name}`, copyItem(row), false) : null}
                  </span>
                  <span className="block text-[0.75rem] text-fg3">{kindWords(row)}</span>
                </th>
                {groups.flatMap((g) => [
                  ...g.slots.map((slot, i) => {
                    const cell = cellOf(row, slot)
                    const t: Target = { slot }
                    const id = idOf(row, t)
                    return (
                      <td key={slot.id} className={clsx('relative py-1.5 pr-3 pl-2 align-top', i === 0 && 'border-l border-line')}>
                        <button type="button" data-cell={id} aria-label={`${row.name} · ${g.title} · ${slot.name}: ${cell.words}`} aria-haspopup="dialog" aria-expanded={open?.id === id} onClick={() => toggle(id)} title={cell.words} className={clsx('press-dim block max-w-64 truncate rounded-row px-1.5 py-0.5 text-left hover:bg-hover aria-expanded:bg-sel', cell.set ? 'font-medium text-fg' : 'text-fg3')}>
                          {cell.words}
                        </button>
                        {cell.set || cell.words === OFF ? null : <span className="block truncate px-1.5 text-[0.75rem] text-fg3">{fromWord(m, cell.from)}</span>}
                        {open?.id === id ? (
                          <Pop onClose={() => setOpen(null)}>{editorOf(row, t)}</Pop>
                        ) : null}
                      </td>
                    )
                  }),
                  ...(g.plus
                    ? [
                        <td key={`${g.role}-plus-${row.id}`} className="relative py-1.5 pr-3 align-top">
                          <PlusCell row={row} group={g} open={open?.id ?? null} add={(slot) => add(row, slot)} onClose={() => setOpen(null)} editor={(t) => editorOf(row, t)} />
                        </td>,
                      ]
                    : []),
                ])}
                {m.plain.map((p) => {
                  const t: Target = { plain: p }
                  const id = idOf(row, t)
                  return (
                    <td key={p.key} className="relative py-1.5 pr-3 align-top">
                      <button type="button" aria-label={`${row.name} · ${p.title}: ${plainWords(row, p)}`} aria-haspopup="dialog" aria-expanded={open?.id === id} onClick={() => toggle(id)} className={clsx('press-dim rounded-row px-1.5 py-0.5 text-left tabular-nums hover:bg-hover aria-expanded:bg-sel', plainSet(row, p) ? 'font-medium text-fg' : 'text-fg3')}>
                        {plainWords(row, p)}
                      </button>
                      {open?.id === id ? <Pop onClose={() => setOpen(null)}>{editorOf(row, t)}</Pop> : null}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Small className="text-pretty">Strong: set in that row. Faint: inherited, with where it comes from. Each cell's values are written at its row's level.</Small>
      {summary ? <ModelsSummary s={summary} phone={phone} go={goTo} extra={<QuotaSettings phone={phone} />} capOpen={capOpen} onCapOpen={setCapOpen} /> : null}
      <OnTop>
        {bulk ? <SetForEverySpace m={m} slot={bulk} phone={phone} onClose={() => setBulk(null)} /> : null}
        {copy ? <CopyModels m={m} from={copy} targets={spaces.filter((r) => r.id !== copy.id)} onClose={() => setCopy(null)} /> : null}
      </OnTop>
    </div>
  )
}

/** the way to Settings → Limits: every limit of the machine, its spaces and its providers in one place (its own page) */
function LimitsLink() {
  return (
    <Small className="text-pretty">
      The caps on every space, provider and model, and what waits for them, are in{' '}
      <button type="button" onClick={() => openPage('Limits', 'all')} className="press-dim rounded-row font-medium text-accent hover:underline">
        Limits
      </button>
      .
    </Small>
  )
}

/** the "+" cell of a role: the next backup in the row (the one after its last that is on), its editor under it */
function PlusCell({ row, group, open, add, onClose, editor }: { row: MatrixRow; group: Group; open: string | null; add: (slot: MatrixSlot) => void; onClose: () => void; editor: (t: Target) => ReactNode }) {
  const slot = group.all[topOf(row, group.all) + 1]
  if (!slot) return <span className="text-fg3">—</span>
  const t: Target = { slot }
  const id = idOf(row, t)
  return (
    <>
      <button type="button" aria-label={`Add ${slot.name} to ${row.name}`} aria-haspopup="dialog" aria-expanded={open === id} onClick={() => add(slot)} className="press-dim inline-flex items-center gap-1 rounded-row px-1.5 py-0.5 font-medium text-accent hover:bg-hover">
        <span aria-hidden="true">+</span>
        {slot.name}
      </button>
      {open === id ? <Pop onClose={onClose}>{editor(t)}</Pop> : null}
    </>
  )
}

/** Set for every space…: one slot's CLI, model and effort, either at each space's own level, or Everywhere with the spaces
 *  (and this machine) reset to it. Asked once, after the write */
function SetForEverySpace({ m, slot, phone, onClose }: { m: ModelsMatrix; slot: MatrixSlot; phone: boolean; onClose: () => void }) {
  const everywhere = m.rows[0]!
  const machine = m.rows.find((r) => r.kind === 'machine')!
  const spaces = m.rows.filter((r) => r.kind === 'space')
  const t: Target = { slot }
  const [draft, setDraft] = useState<MatrixRow>(everywhere)
  const [mode, setMode] = useState<'each' | 'all'>('each')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // what was written, asked about once the dialog is closed (one question, not one over the other)
  const asked = useRef<{ key: string; place: string }[]>([])
  const close = () => {
    if (asked.current.length) void askWaitingMany(asked.current)
    onClose()
  }
  const set = (key: string, value: string) => setDraft((d) => withValues(d, writesOf(m, d, t, key, value)))
  const writes = keysOf(t).map((k): Write => [k, draft.values[k]!.value])
  const run = async () => {
    setBusy(true)
    setError('')
    const failed: string[] = []
    const through = (place: string, r: { keys: string[]; error?: string }, name: string) => {
      asked.current.push(...r.keys.map((key) => ({ key, place })))
      if (r.error) failed.push(`${name}: ${r.error}`)
    }
    if (mode === 'each') {
      for (const r of spaces) through(r.id, await writeAt(r.id, writes), r.name)
    } else {
      through('all', await writeAt('all', writes), 'Everywhere')
      for (const r of [machine, ...spaces]) {
        const resets = resetOf(r, t)
        if (resets.length) through('all', await writeAt(r.id, resets), r.name)
      }
    }
    setBusy(false)
    if (failed.length) setError(failed.join(' '))
    else close()
  }
  const ask = mode === 'each'
    ? `Each of the ${spaces.length} spaces gets this value at its own level, replacing what it sets there. Spaces that inherit it now set it themselves.`
    : `Everywhere gets this value. ${machine.name} and each of the ${spaces.length} spaces lose their own value for it, so every space reads Everywhere's. What they set there is lost.`
  return (
    <Dialog
      title={`Set ${slot.title} · ${slot.name} for every space`}
      onCancel={close}
      buttons={
        <Primary autoFocus disabled={busy || !spaces.length} onClick={run}>
          {busy ? 'Setting…' : `Set for ${spaces.length} ${spaces.length === 1 ? 'space' : 'spaces'}`}
        </Primary>
      }
    >
      <div className="flex flex-col gap-3">
        <Editor phone={phone} controls={controlsOf(m, draft, t)} reset={false} onSet={set} onReset={() => undefined} />
        <fieldset className="flex flex-col gap-1.5">
          <legend className="sr-only">How to set it</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="set-mode" checked={mode === 'each'} onChange={() => setMode('each')} className="mt-1" />
            <span>Each space's own: write it at each space, replacing its value.</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="set-mode" checked={mode === 'all'} onChange={() => setMode('all')} className="mt-1" />
            <span>Everywhere, and reset the spaces (and this machine's) to it.</span>
          </label>
        </fieldset>
        <Small className="text-pretty">{ask}</Small>
        {error ? <Refused text={error} /> : null}
      </div>
    </Dialog>
  )
}

/** Copy this space's models to…: the space's own values of every slot, written at each chosen space (where it doesn't
 *  already set the same value); asked once, after the writes */
function CopyModels({ m, from, targets, onClose }: { m: ModelsMatrix; from: MatrixRow; targets: MatrixRow[]; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>(targets.map((r) => r.id))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const asked = useRef<{ key: string; place: string }[]>([])
  const close = () => {
    if (asked.current.length) void askWaitingMany(asked.current)
    onClose()
  }
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const run = async () => {
    setBusy(true)
    setError('')
    const failed: string[] = []
    for (const r of targets.filter((x) => picked.includes(x.id))) {
      // what the source reads, slot by slot (the primary first), skipping what the target already sets the same way
      const writes = m.slots.flatMap((slot) => keysOf({ slot })).map((k): Write => [k, from.values[k]!.value]).filter(([k, v]) => !(r.values[k]!.set && r.values[k]!.value === v))
      const res = await writeAt(r.id, writes)
      asked.current.push(...res.keys.map((key) => ({ key, place: r.id })))
      if (res.error) failed.push(`${r.name}: ${res.error}`)
    }
    setBusy(false)
    if (failed.length) setError(failed.join(' '))
    else close()
  }
  return (
    <Dialog
      title={`Copy ${from.name}'s models to…`}
      onCancel={close}
      buttons={
        <Primary autoFocus disabled={busy || !picked.length} onClick={run}>
          {busy ? 'Copying…' : `Copy to ${picked.length} ${picked.length === 1 ? 'space' : 'spaces'}`}
        </Primary>
      }
    >
      <div className="flex flex-col gap-2.5">
        <p>Every slot of its Tasks, Coordinators, Reviewer and Advisor, with their backups, is written at the level of each chosen space (replacing what it sets there). Max tasks and Merge train stay as they are.</p>
        {targets.length ? (
          <ul className="flex flex-col gap-1">
            {targets.map((r) => (
              <li key={r.id}>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />
                  {r.name}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-fg2">This is the only space. Add another, then copy to it.</p>
        )}
        {error ? <Refused text={error} /> : null}
      </div>
    </Dialog>
  )
}

