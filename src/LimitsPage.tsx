// Settings → Limits: every limit of this machine in one place, as a spreadsheet. Rows are Everywhere and this machine (the
// machine's start limits and its alerts), each of its spaces (Max tasks, Merge train, and the sub-limit of each provider or
// model), and each provider with its models under it (the cap, what runs by role, what is held, whether it is out, and
// its quota). Beside them, what waits now and why. Every cell writes the setting it shows, at its row's level, through the
// setting action (limits-view.ts reads them): nothing new is stored, and the profiles bar above holds them with the models.
// The desktop tables keep their first column and header in view; a phone shows one card per section, space and provider,
// with the same editors. Bulk actions are confirmed first (a column's Set for every space…, a provider's Clear every
// space's sub-limit).
import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { parseMaxAtOnce, withEntry, type MaxEntry } from '@shared/model-caps.ts'
import { shareOf } from '@shared/quota-words.ts'
import type { LimitCell, LimitColumn, LimitKnown, LimitProvider, LimitRow, LimitSpaceRow, LimitTable, LimitsView, SettingRow, WaitingNow } from '@shared/types.ts'
import { act, openTask, useSnap } from './kernel.ts'
import { askWaitingMany } from './apply-waiting.tsx'
import { Anchored, OnTop } from './anchored.tsx'
import { CAP_KEY, CapCell, CapEditor } from './CapCell.tsx'
import { Pop } from './cell-pop.tsx'
import { Editor, Refused } from './ModelsPage.tsx'
import { ProfilesBar } from './Profiles.tsx'
import { openPage, shown } from './Settings.tsx'
import { Dialog } from './rowmenu.tsx'
import { Menu, MenuItem, MoreIcon, Primary, Small, ic } from './ui.tsx'

/** the + column's choices are kept in this browser: a column added with no entry yet stays until it is removed */
const COLUMNS = 'limits:columns'
function readColumns(): string[] {
  try {
    return (JSON.parse(localStorage.getItem(COLUMNS) ?? '[]') as unknown[]).filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}
function saveColumns(list: string[]) {
  try {
    localStorage.setItem(COLUMNS, JSON.stringify(list))
  } catch {
    /* a browser with no storage keeps its columns for this page only */
  }
}

type Caps = LimitsView['caps']
type Result = { ok: boolean; error?: string }

/** one write: the setting at its place, and the question about the waiting tasks it reaches (the server says whether any would change) */
async function write(place: string, key: string, value: string | null): Promise<Result> {
  const r = (await act({ type: 'setting', key, value, place }).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok?: boolean; error?: string }
  if (r?.ok) void askWaitingMany([{ key, place }])
  return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? "That didn't go through." }
}

/** where a value comes from, in words */
const fromWord = (from: LimitCell['from'], machine: string) => (from === 'all' ? 'Everywhere' : from === 'machine' ? machine : from === 'space' ? 'this space' : 'default')

/** the entries a space's own cap text holds (none when it is unreadable) */
const entriesOf = (text: string): MaxEntry[] => {
  const p = parseMaxAtOnce(text)
  return p.ok ? p.entries : []
}

/** the spaces the Spaces table lists, with their cap text and place: a bulk write reaches the rows the page shows, no others */
export function inRows(v: LimitsView): Caps['spaces'] {
  const keys = new Set(v.spaces.rows.map((r) => r.key))
  return v.caps.spaces.filter((s) => keys.has(s.key))
}

/** a pattern's name in words: a provider's or a model's, as the catalog and the providers name it, else the pattern itself */
export function nameOf(v: LimitsView, pattern: string): string {
  return v.known.find((k) => k.pattern === pattern)?.name ?? v.providers.find((p) => p.provider === pattern)?.name ?? pattern
}

/** the roles that run now on a provider or a model, in words ("2 tasks · 1 advisor"), or a dash */
const ROLE_WORDS = { task: ['task', 'tasks'], coordinator: ['coordinator', 'coordinators'], advisor: ['advisor', 'advisor'], reviewer: ['reviewer', 'reviewers'] } as const
export function roleWords(byRole: LimitProvider['byRole']): string {
  const parts = (Object.keys(ROLE_WORDS) as (keyof typeof ROLE_WORDS)[]).flatMap((r) => {
    const n = byRole[r] ?? 0
    return n ? [`${n} ${n === 1 ? ROLE_WORDS[r][0] : ROLE_WORDS[r][1]}`] : []
  })
  return parts.join(' · ') || '—'
}

/** a provider's quota in one short line: each window's share used, why there is none, or a dash (models have none) */
/** a provider's quota for the desktop table: one short line per window ("5 h 62%", "Week 41%"), an estimate on its own line, or why there is none */
export function quotaLines(quota?: LimitProvider['quota'], read?: LimitProvider['quotaRead']): string[] {
  const lines = (quota?.windows ?? []).flatMap((w) => {
    const share = shareOf(w)
    return share === undefined ? [] : [`${w.name} ${Math.round(share)}%`]
  })
  if (lines.length) return quota?.estimate ? [...lines, 'estimate'] : lines
  return [read?.failed ? 'read failed' : read?.hint ? 'no read' : '—']
}

export function quotaWords(quota?: LimitProvider['quota'], read?: LimitProvider['quotaRead']): string {
  const parts = (quota?.windows ?? []).flatMap((w) => {
    const share = shareOf(w)
    return share === undefined ? [] : [`${w.name} ${Math.round(share)}%`]
  })
  if (parts.length) return `${parts.join(' · ')}${quota?.estimate ? ' (estimate)' : ''}`
  return read?.failed ? 'read failed' : read?.hint ? 'no read' : '—'
}

/** when a provider is out now, in words: until its known reset, or now */
const outWords = (r: LimitProvider['runOuts']) => (r.out ? (r.until !== undefined ? `out until ${new Date(r.until).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'out now') : '—')

/** a task's id as a button that opens it */
function TaskButton({ id }: { id: string }) {
  return (
    <button type="button" onClick={() => openTask(id)} className="press-dim mr-1 rounded-row font-medium text-accent hover:underline">
      {id}
    </button>
  )
}

/** the Waiting now list: the tasks held right now by what holds them (machine slots, the machine's load, each space's cap,
 *  each model's cap, every model out, the cut-off tasks that go back first), the advisor's questions and the reviews that
 *  wait for a reviewer */
export function Waiting({ w, phone }: { w: WaitingNow; phone: boolean }) {
  const none = !w.held && !w.advisor.length && !w.reviews.length
  const card = 'rounded-box bg-bg px-3 py-2 shadow-[inset_0_0_0_1px_var(--line)] dark:bg-bubble'
  return (
    <section aria-label="Waiting now" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 className="font-medium">Waiting now</h2>
        <Small>{w.held ? `${w.held} ${w.held === 1 ? 'task' : 'tasks'} held for room` : 'Nothing is held for room'}</Small>
      </div>
      {none ? <Small className="text-pretty">Every limit has room now: nothing waits for a slot, a load or a cap.</Small> : null}
      <ul className={clsx('grid gap-2', phone ? '' : 'md:grid-cols-2')}>
        {w.groups.map((g) => (
          <li key={g.id} className={card}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-medium">
                {g.title} <span className="tabular-nums text-fg2">· {g.tasks.length}</span>
              </span>
              {g.limit ? <Small className="text-pretty">{g.limit}</Small> : null}
            </div>
            <ul className="flex flex-col gap-0.5 pt-1">
              {g.tasks.map((t) => (
                <li key={t.id} className="flex min-w-0 flex-wrap gap-x-2 text-fg2">
                  <TaskButton id={t.id} />
                  <span className="min-w-0 text-pretty">
                    {t.space} · {t.words}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
        {w.advisor.length ? (
          <li className={card}>
            <span className="font-medium">Questions waiting for the advisor</span>
            <ul className="flex flex-col gap-0.5 pt-1">
              {w.advisor.map((a) => (
                <li key={a.chat} className="text-pretty text-fg2">
                  {a.task ? <TaskButton id={a.task} /> : null}
                  {a.words}
                </li>
              ))}
            </ul>
          </li>
        ) : null}
        {w.reviews.length ? (
          <li className={card}>
            <span className="font-medium">Review rounds waiting for a reviewer</span>
            <ul className="flex flex-col gap-0.5 pt-1">
              {w.reviews.map((r) => (
                <li key={r.task} className="text-pretty text-fg2">
                  <TaskButton id={r.task} />
                  {r.words}
                </li>
              ))}
            </ul>
          </li>
        ) : null}
      </ul>
    </section>
  )
}

/** one limit's value in its cell: its words (strong where this level sets it, faint where it inherits, with where from), its
 *  live number under them, and its editor (a desktop: a popover; a phone: under the line). A write that is refused keeps the
 *  editor open with the refusal in it; one that goes through closes it */
export function LimitValue({ title, cell, machine, phone }: { title: string; cell: LimitCell; machine: string; phone: boolean }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const put = async (value: string | null) => {
    const r = await write(cell.place, cell.key, value)
    if (r.ok) setOpen(false)
    setError(r.error ?? '')
  }
  const words = shown(cell.row.value)
  const editor = (
    <Editor
      phone={phone}
      title={`${title} · ${cell.set ? 'set at this level' : `from ${fromWord(cell.from, machine)}`}`}
      controls={[cell.row]}
      reset={cell.set}
      error={error || undefined}
      onSet={(_, v) => void put(v)}
      onReset={() => void put(null)}
    />
  )
  const close = () => {
    setOpen(false)
    setError('')
  }
  return (
    <span className="relative block min-w-0">
      <button
        type="button"
        aria-haspopup={phone ? undefined : 'dialog'}
        aria-expanded={open}
        aria-label={`${title}: ${words}${cell.now ? `, ${cell.now}` : ''}`}
        title={`${words}${cell.now ? `, ${cell.now}` : ''}`}
        onClick={() => (open ? close() : setOpen(true))}
        className={clsx('press-dim block max-w-full rounded-row px-1.5 py-0.5 text-left tabular-nums hover:bg-hover aria-expanded:bg-sel', cell.set ? 'font-medium text-fg' : 'text-fg3')}
      >
        <span className="block truncate">{words}</span>
        {cell.now ? <span className="block truncate text-[0.75rem] font-normal text-fg3">{cell.now}</span> : null}
        {cell.set ? null : <span className="block truncate text-[0.75rem] text-fg3">{fromWord(cell.from, machine)}</span>}
      </button>
      {open ? phone ? <div className="pt-1">{editor}</div> : <Pop onClose={close}>{editor}</Pop> : null}
    </span>
  )
}

/** a space's sub-limit for one pattern: its own entry (strong: its runs now, of its max), or none (faint: the machine's total
 *  applies, or no sub-limit). Either opens the cap editor at this space: a number, or Clear here */
function SpaceCapCell({ name, pattern, space, caps, total, phone, openId, onOpen }: { name: string; pattern: string; space: LimitSpaceRow; caps: Caps; total?: number; phone: boolean; openId: string | null; onOpen: (id: string | null) => void }) {
  // its own id: a provider's cap (CapCell) names the same space's line as cap|<pattern>|<space>, which must not open with this one
  const id = `space-cap|${pattern}|${space.key}`
  const mine = space.caps[pattern]
  const open = openId === id
  const words = mine ? `${mine.now} of ${mine.max} at once` : total ? `machine's total applies (${total} at once)` : 'no sub-limit'
  const editor = <CapEditor name={name} pattern={pattern} caps={caps} phone={phone} space={space.key} onClose={() => onOpen(null)} />
  return (
    <span className="relative block min-w-0">
      <button
        type="button"
        data-cell={id}
        aria-haspopup={phone ? undefined : 'dialog'}
        aria-expanded={open}
        aria-label={`${name} in ${space.name}: ${words}`}
        onClick={() => onOpen(open ? null : id)}
        className={clsx('press-dim block max-w-full truncate rounded-row px-1.5 py-0.5 text-left tabular-nums hover:bg-hover aria-expanded:bg-sel', mine ? 'font-medium text-fg' : 'text-fg3')}
      >
        {words}
      </button>
      {open ? phone ? <div className="pt-1">{editor}</div> : <Pop onClose={() => onOpen(null)}>{editor}</Pop> : null}
    </span>
  )
}

/** a machine column's header on the desktop, short; its full wording is the header's title (the phone cards keep the full title) */
const SHORT_HEAD: Record<string, string> = {
  'machine.maxTasks': 'Max tasks',
  'machine.startLoad': 'CPU load',
  'machine.startPressure': 'CPU pressure',
  'machine.startMemory': 'Memory',
  'machine.startEvery': 'Start spacing',
  'machine.alertLoad': 'CPU load',
  'machine.alertMemory': 'Memory',
  'machine.alertDisk': 'Disk',
  'machine.alertHerdr': 'herdr',
}

/** the machine's table (Everywhere and this machine, or the alerts): a column per limit, a row per level. A desktop fits the
 *  Settings width (fixed columns, long words cut with their full text as a title) and keeps the first column and the header
 *  in view; a phone draws a card per level, a line per limit */
function MachineTable({ table, label, machine, phone }: { table: LimitTable; label: string; machine: string; phone: boolean }) {
  if (phone)
    return (
      <div className="flex flex-col gap-3">
        {table.rows.map((row) => (
          <section key={row.id} aria-label={`${label}: ${row.name}`} className="rounded-box bg-bg shadow-[inset_0_0_0_1px_var(--line)] dark:bg-bubble">
            <h3 className="px-4 pt-3 pb-1 font-medium">{row.name}</h3>
            <ul className="flex flex-col px-4 pb-2">
              {table.columns.map((c) => (
                <li key={c.key} className="flex flex-col gap-1 border-t border-line py-2 first:border-t-0">
                  <Small className="text-fg2">{c.title}</Small>
                  <LimitValue title={`${row.name} · ${c.title}`} cell={row.cells[c.key]!} machine={machine} phone />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    )
  return (
    <div className="max-w-full overflow-auto overscroll-contain">
      <table aria-label={label} className="w-full table-fixed border-separate border-spacing-0 text-[0.8125rem]">
        <colgroup>
          <col style={{ width: '16%' }} />
          {table.columns.map((c) => (
            <col key={c.key} style={{ width: `${84 / table.columns.length}%` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="sticky top-0 left-0 z-20 bg-bg pr-4 pb-2 text-left align-bottom font-medium text-fg3">
              Level
            </th>
            {table.columns.map((c: LimitColumn) => (
              <th key={c.key} scope="col" title={c.hint ? `${c.title}. ${c.hint}` : c.title} className="sticky top-0 z-10 bg-bg px-2 pb-2 text-left align-bottom font-medium text-fg3">
                {SHORT_HEAD[c.key] ?? c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row: LimitRow) => (
            <tr key={row.id}>
              <th scope="row" title={row.name} className={clsx('sticky left-0 z-10 truncate bg-bg pr-4 py-1.5 text-left', row.kind === 'all' ? 'font-normal text-fg2' : 'font-medium')}>
                {row.name}
              </th>
              {table.columns.map((c) => (
                <td key={c.key} className="relative py-1.5 pr-3 align-top">
                  <LimitValue title={`${row.name} · ${c.title}`} cell={row.cells[c.key]!} machine={machine} phone={false} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** a row's ⋯ menu: the same look as the other tables' */
function More({ id, label, menu, setMenu, items }: { id: string; label: string; menu: string | null; setMenu: (m: string | null) => void; items: ReactNode }) {
  return (
    <span className="relative inline-flex">
      <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={menu === id} onClick={() => setMenu(menu === id ? null : id)} className="press-dim grid size-6 place-items-center rounded-full text-fg3 hover:bg-sel hover:text-fg aria-expanded:bg-sel aria-expanded:text-fg">
        <MoreIcon className={ic} />
      </button>
      {menu === id ? (
        <Anchored>
          <Menu label="More" onClose={() => setMenu(null)} className="min-w-56 text-left">
            {items}
          </Menu>
        </Anchored>
      ) : null}
    </span>
  )
}

/** what a bulk dialog changes: a space-level column (Max tasks, Merge train), one pattern's sub-limit in every space, or
 *  clearing one pattern's sub-limits */
type Bulk = { kind: 'column'; key: string; title: string; row: SettingRow } | { kind: 'pattern'; pattern: string; name: string } | { kind: 'clear'; pattern: string; name: string }

/** Settings → Limits */
export default function LimitsPage({ phone }: { phone: boolean }) {
  const snap = useSnap()
  const [v, setV] = useState<LimitsView | null>(null)
  const [failed, setFailed] = useState('')
  // the cap editor open (its id), a ⋯ menu open, the bulk dialog, and the + column's choices
  const [capOpen, setCapOpen] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [bulk, setBulk] = useState<Bulk | null>(null)
  const [picker, setPicker] = useState(false)
  const [columns, setColumns] = useState<string[]>(readColumns)
  // every change of Settings is a new snapshot: the page reads again
  useEffect(() => {
    let live = true
    act({ type: 'limits-view' })
      .then((r) => live && setV(r as LimitsView))
      .catch((e: Error) => live && setFailed(e.message))
    return () => {
      live = false
    }
  }, [snap])
  if (!v) return <p className="px-6 pt-5 text-fg2">{failed || 'Reading every limit…'}</p>
  // the pattern columns: those the entries name, then those the + column added (this browser's)
  const patterns = [...v.spaces.patterns, ...columns.filter((c) => !v.spaces.patterns.includes(c))]
  const hasSubs = (p: string) => inRows(v).some((s) => entriesOf(s.text).some((e) => e.pattern === p))
  const addColumn = (pattern: string) => {
    setPicker(false)
    const next = [...columns.filter((c) => c !== pattern), pattern]
    setColumns(next)
    saveColumns(next)
  }
  const removeColumn = (pattern: string) => {
    setMenu(null)
    const next = columns.filter((c) => c !== pattern)
    setColumns(next)
    saveColumns(next)
  }
  const spaceColumn = (key: string, title: string, row: SettingRow) => (
    <MenuItem
      onClick={() => {
        setMenu(null)
        setBulk({ kind: 'column', key, title, row })
      }}
    >
      Set for every space…
    </MenuItem>
  )
  const spaceRows = v.spaces.rows
  const machineTotal = (p: string) => v.spaces.totals[p]?.max

  return (
    <div className={clsx('flex w-full flex-col gap-5', phone ? 'px-4 pb-6' : 'px-6 pt-5 pb-8')}>
      <ProfilesBar phone={phone} limits />
      <Waiting w={v.waiting} phone={phone} />

      <section aria-label="Machine limits" className="flex flex-col gap-2">
        <div className="flex flex-col">
          <h2 className="font-medium">Machine · {v.machine.name}</h2>
          <Small className="text-pretty">How many of this machine's tasks work at once, and when it holds new ones. The numbers beside each value are read now. Everywhere is the default for every machine; this machine's own value wins.</Small>
        </div>
        <MachineTable table={v.machineTable} label="Machine limits" machine={v.machine.name} phone={phone} />
        <details className="flex flex-col gap-2">
          <summary className="cursor-pointer text-fg2 select-none">Alerts: when this machine's coordinator is told</summary>
          <Small className="text-pretty">Its coordinator hears once when a limit stays past it, and again once it is back under. It only tells: what to do about it is the coordinator's call.</Small>
          <MachineTable table={v.alerts} label="Alerts" machine={v.machine.name} phone={phone} />
        </details>
      </section>

      <section aria-label="Spaces" className="flex flex-col gap-2">
        <div className="flex flex-col">
          <h2 className="font-medium">Spaces</h2>
          <Small className="text-pretty">Each space's own limits. Max tasks is a cap inside the machine's. A column is one provider's or model's sub-limit for each space: its own runs, inside the machine's total for that row. An empty cell has none of its own.</Small>
        </div>
        {phone ? (
          <div className="flex flex-col gap-3">
            {spaceRows.map((row) => (
              <section key={row.id} aria-label={`Space ${row.name}`} className="rounded-box bg-bg shadow-[inset_0_0_0_1px_var(--line)] dark:bg-bubble">
                <div className="flex items-center gap-2 px-4 pt-3 pb-1">
                  <h3 className="min-w-0 flex-1 truncate font-medium">{row.name}</h3>
                  <Small>{row.working} working{row.held ? ` · ${row.held} held` : ''}</Small>
                </div>
                <ul className="flex flex-col px-4 pb-2">
                  {(['space.maxTasks', 'merge.train'] as const).map((key) => (
                    <li key={key} className="flex flex-col gap-1 border-t border-line py-2">
                      <Small className="text-fg2">{key === 'space.maxTasks' ? 'Max tasks' : 'Merge train'}</Small>
                      <LimitValue title={`${row.name} · ${key === 'space.maxTasks' ? 'Max tasks' : 'Merge train'}`} cell={row.cells[key]!} machine={v.machine.name} phone />
                    </li>
                  ))}
                </ul>
                {patterns.length ? (
                  <ul className="flex flex-col px-4 pt-1 pb-2">
                    {patterns.map((p) => (
                      <li key={p} className="flex flex-col gap-1 border-t border-line py-2">
                        <Small className="text-fg2">{nameOf(v, p)} · at once in this space</Small>
                        <SpaceCapCell name={nameOf(v, p)} pattern={p} space={row} caps={v.caps} total={machineTotal(p)} phone openId={capOpen} onOpen={setCapOpen} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ))}
          </div>
        ) : (
          <div className="max-h-[min(70vh,44rem)] max-w-full overflow-auto overscroll-contain">
            <table aria-label="Spaces" className="w-max border-separate border-spacing-0 text-[0.8125rem]">
              <thead>
                <tr>
                  <th scope="col" className="sticky top-0 left-0 z-30 min-w-44 bg-bg pr-4 pb-2 text-left align-bottom font-medium text-fg3">
                    Space
                  </th>
                  <th scope="col" className="sticky top-0 z-20 bg-bg px-2 pb-2 text-left align-bottom font-medium whitespace-nowrap text-fg3">
                    <span className="inline-flex items-center gap-1">
                      Max tasks
                      <More id="col:space.maxTasks" label="More for Max tasks" menu={menu} setMenu={setMenu} items={spaceColumn('space.maxTasks', 'Max tasks', { label: 'Max tasks of this space working at once', key: 'space.maxTasks', value: 'off', num: { min: 1, max: 200, off: true } })} />
                    </span>
                  </th>
                  <th scope="col" className="sticky top-0 z-20 bg-bg px-2 pb-2 text-left align-bottom font-medium whitespace-nowrap text-fg3">
                    <span className="inline-flex items-center gap-1">
                      Merge train
                      <More id="col:merge.train" label="More for Merge train" menu={menu} setMenu={setMenu} items={spaceColumn('merge.train', 'Merge train', { label: 'Merge train', key: 'merge.train', value: 'off', options: ['off', '2', '3', '4', '5'] })} />
                    </span>
                  </th>
                  {patterns.map((p) => (
                    <th key={p} scope="col" className="sticky top-0 z-20 bg-bg px-2 pb-2 text-left align-bottom font-medium whitespace-nowrap text-fg3">
                      <span className="inline-flex items-center gap-1">
                        <span title={p}>{nameOf(v, p)} at once</span>
                        <More
                          id={`col:${p}`}
                          label={`More for ${nameOf(v, p)}`}
                          menu={menu}
                          setMenu={setMenu}
                          items={
                            <>
                              <MenuItem
                                onClick={() => {
                                  setMenu(null)
                                  setBulk({ kind: 'pattern', pattern: p, name: nameOf(v, p) })
                                }}
                              >
                                Set for every space…
                              </MenuItem>
                              {hasSubs(p) ? (
                                <MenuItem
                                  onClick={() => {
                                    setMenu(null)
                                    setBulk({ kind: 'clear', pattern: p, name: nameOf(v, p) })
                                  }}
                                >
                                  Clear every space's sub-limit
                                </MenuItem>
                              ) : null}
                              {!v.spaces.patterns.includes(p) ? <MenuItem onClick={() => removeColumn(p)}>Remove this column</MenuItem> : null}
                            </>
                          }
                        />
                      </span>
                    </th>
                  ))}
                  <th scope="col" className="sticky top-0 z-20 bg-bg px-2 pb-2 text-left align-bottom font-medium text-fg3">
                    <span className="relative inline-flex">
                      <button type="button" aria-haspopup="menu" aria-expanded={picker} onClick={() => setPicker(!picker)} className="press-dim rounded-row px-1.5 py-0.5 font-medium whitespace-nowrap text-accent hover:bg-hover">
                        + column
                      </button>
                      {picker ? (
                        <Anchored>
                          <Menu label="Add a column" onClose={() => setPicker(false)} className="max-h-96 min-w-64 overflow-y-auto text-left">
                            {v.known
                              .filter((k) => !patterns.includes(k.pattern))
                              .map((k: LimitKnown) => (
                                <MenuItem key={k.pattern} hint={k.kind === 'provider' ? 'provider' : 'model'} onClick={() => addColumn(k.pattern)}>
                                  {k.name}
                                </MenuItem>
                              ))}
                          </Menu>
                        </Anchored>
                      ) : null}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {spaceRows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row" className="sticky left-0 z-10 bg-bg pr-4 py-1.5 text-left align-top font-normal">
                      <span className="block max-w-56 truncate text-fg">{row.name}</span>
                      <span className="block text-[0.75rem] text-fg3">
                        {row.working} working{row.held ? ` · ${row.held} held` : ''}
                      </span>
                    </th>
                    {(['space.maxTasks', 'merge.train'] as const).map((key) => (
                      <td key={key} className="relative py-1.5 pr-3 align-top">
                        <LimitValue title={`${row.name} · ${key === 'space.maxTasks' ? 'Max tasks' : 'Merge train'}`} cell={row.cells[key]!} machine={v.machine.name} phone={false} />
                      </td>
                    ))}
                    {patterns.map((p) => (
                      <td key={p} className="relative py-1.5 pr-3 align-top">
                        <SpaceCapCell name={nameOf(v, p)} pattern={p} space={row} caps={v.caps} total={machineTotal(p)} phone={false} openId={capOpen} onOpen={setCapOpen} />
                      </td>
                    ))}
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Small className="text-pretty">Strong: set at that space. Faint: inherited, or none. A sub-limit is written at its space; the machine's total is written at this machine or Everywhere, in the table of the providers below.</Small>
      </section>

      <section aria-label="Providers and models" className="flex flex-col gap-2">
        <div className="flex flex-col">
          <h2 className="font-medium">Providers and models</h2>
          <Small className="text-pretty">
            Every provider with a cap, an agent, a run or usage, and its models under it. Max at once is the machine's total for the row, set at this machine or Everywhere (the sub-limits of the spaces show under it). The quota and the run-outs are read from each provider; the details are in{' '}
            <button type="button" onClick={() => openPage('Models', 'all')} className="press-dim rounded-row font-medium text-accent hover:underline">
              Models
            </button>
            .
          </Small>
        </div>
        {phone ? (
          <div className="flex flex-col gap-3">
            {v.providers.map((p) => (
              <section key={p.provider} aria-label={p.name} className="rounded-box bg-bg shadow-[inset_0_0_0_1px_var(--line)] dark:bg-bubble">
                <div className="flex items-center gap-2 px-4 pt-3 pb-1">
                  <h3 className="min-w-0 flex-1 truncate font-medium">{p.name}</h3>
                  {p.local ? <Small>local</Small> : null}
                </div>
                <div className="flex flex-col gap-1 px-4 pb-2">
                  <Small className="text-fg2">Max at once</Small>
                  <CapCell name={p.name} pattern={p.provider} atOnce={p.atOnce} caps={v.caps} phone openId={capOpen} onOpen={setCapOpen} />
                  <ProviderFacts byRole={p.byRole} held={p.atOnce.held} runOuts={p.runOuts} quota={p.quota} read={p.quotaRead} />
                </div>
                {p.models.map((m) => (
                  <div key={m.key} className="flex flex-col gap-1 border-t border-line px-4 py-2">
                    <span className="truncate text-fg2">{m.label}</span>
                    <CapCell name={m.label} pattern={m.key} atOnce={m.atOnce} caps={v.caps} phone openId={capOpen} onOpen={setCapOpen} />
                    <ProviderFacts byRole={m.byRole} held={m.atOnce.held} runOuts={m.runOuts} />
                  </div>
                ))}
              </section>
            ))}
          </div>
        ) : (
          <div className="max-h-[min(70vh,44rem)] max-w-full overflow-auto overscroll-contain">
            <table aria-label="Providers and models" className="w-full table-fixed border-separate border-spacing-0 text-[0.8125rem]">
              <colgroup>
                <col className="w-[24%]" />
                <col className="w-[20%]" />
                <col className="w-[16%]" />
                <col className="w-[7%]" />
                <col className="w-[14%]" />
                <col className="w-[19%]" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className="sticky top-0 left-0 z-30 bg-bg pr-4 pb-2 text-left align-bottom font-medium text-fg3">
                    Provider · model
                  </th>
                  {['Max at once', 'Running now', 'Held', 'Out now', 'Quota'].map((t) => (
                    <th key={t} scope="col" className="sticky top-0 z-20 bg-bg px-2 pb-2 text-left align-bottom font-medium text-fg3">
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {v.providers.map((p) => (
                  <ProviderRows key={p.provider} p={p} v={v} capOpen={capOpen} setCapOpen={setCapOpen} menu={menu} setMenu={setMenu} hasSubs={hasSubs(p.provider)} onClear={() => setBulk({ kind: 'clear', pattern: p.provider, name: p.name })} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Small className="text-pretty">Local servers (spark, radeon, avell, dell) have no quota. A cap counts this machine's agents only: a request from another app on the same server is not seen.</Small>
      </section>

      <OnTop>
        {bulk?.kind === 'column' ? <SetForSpaces bulk={bulk} rows={spaceRows} caps={v.caps} phone={phone} onClose={() => setBulk(null)} /> : null}
        {bulk?.kind === 'pattern' ? <SetPatternForSpaces pattern={bulk.pattern} name={bulk.name} spaces={inRows(v)} onClose={() => setBulk(null)} /> : null}
        {bulk?.kind === 'clear' ? <ClearSubLimits pattern={bulk.pattern} name={bulk.name} spaces={inRows(v)} onClose={() => setBulk(null)} /> : null}
      </OnTop>
    </div>
  )
}

/** a provider's or a model's facts beside its cap: what runs by role, what is held, whether it is out, and its quota */
function ProviderFacts({ byRole, held, runOuts, quota, read }: { byRole: LimitProvider['byRole']; held: number; runOuts: LimitProvider['runOuts']; quota?: LimitProvider['quota']; read?: LimitProvider['quotaRead'] }) {
  return (
    <dl className="flex flex-col gap-0.5 text-fg2">
      <div className="flex gap-2">
        <dt className="text-fg3">Running now</dt>
        <dd className="tabular-nums">{roleWords(byRole)}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-fg3">Held</dt>
        <dd className="tabular-nums">{held || '—'}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-fg3">Out now</dt>
        <dd>{outWords(runOuts)}</dd>
      </div>
      {quota || read ? (
        <div className="flex gap-2">
          <dt className="text-fg3">Quota</dt>
          <dd className="tabular-nums">{quotaWords(quota, read)}</dd>
        </div>
      ) : null}
    </dl>
  )
}

/** a provider's row and its models' rows, as the desktop table draws them: the cap (its row's ⋯ clears the spaces' sub-limits),
 *  what runs by role, what is held, whether it is out, and its quota (a provider's only; a details link to Models) */
function ProviderRows({ p, v, capOpen, setCapOpen, menu, setMenu, hasSubs, onClear }: { p: LimitProvider; v: LimitsView; capOpen: string | null; setCapOpen: (id: string | null) => void; menu: string | null; setMenu: (m: string | null) => void; hasSubs: boolean; onClear: () => void }) {
  const cells = (name: string, pattern: string, atOnce: LimitProvider['atOnce'], byRole: LimitProvider['byRole'], runOuts: LimitProvider['runOuts'], held: number, quota?: LimitProvider['quota'], read?: LimitProvider['quotaRead'], clear?: boolean) => (
    <>
      <td className="relative py-1.5 pr-3 align-top">
        <span className="flex items-start gap-1">
          <span className="min-w-0 flex-1">
            <CapCell name={name} pattern={pattern} atOnce={atOnce} caps={v.caps} phone={false} openId={capOpen} onOpen={setCapOpen} />
          </span>
          {clear ? (
            <More
              id={`prov:${pattern}`}
              label={`More for ${name}`}
              menu={menu}
              setMenu={setMenu}
              items={
                <MenuItem
                  onClick={() => {
                    setMenu(null)
                    onClear()
                  }}
                >
                  Clear every space's sub-limit
                </MenuItem>
              }
            />
          ) : null}
        </span>
      </td>
      <td className="py-1.5 pr-3 align-top text-fg2 tabular-nums">{roleWords(byRole)}</td>
      <td className="py-1.5 pr-3 align-top text-fg2 tabular-nums">{held || '—'}</td>
      <td className="py-1.5 pr-3 align-top text-fg2">{outWords(runOuts)}</td>
      <td className="py-1.5 pr-3 align-top text-fg2 tabular-nums">
        {read || quota ? quotaLines(quota, read).map((l) => (
          <span key={l} className="block">
            {l}
          </span>
        )) : '—'}
      </td>
    </>
  )
  return (
    <>
      <tr>
        <th scope="row" className="sticky left-0 z-10 bg-bg pr-4 py-1.5 text-left align-top font-normal">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium text-fg" title={p.name}>{p.name}</span>
            {p.local ? <span className="shrink-0 text-[0.75rem] text-fg3">local</span> : null}
          </span>
        </th>
        {cells(p.name, p.provider, p.atOnce, p.byRole, p.runOuts, p.atOnce.held, p.quota, p.quotaRead, hasSubs)}
      </tr>
      {p.models.map((m) => (
        <tr key={m.key}>
          <th scope="row" className="sticky left-0 z-10 bg-bg py-1 pr-4 pl-6 text-left align-top font-normal">
            <span className="block truncate text-fg2" title={m.label}>{m.label}</span>
          </th>
          {cells(m.label, m.key, m.atOnce, m.byRole, m.runOuts, m.atOnce.held)}
        </tr>
      ))}
    </>
  )
}

/** Set for every space…, for Max tasks or Merge train: each space's own, or Everywhere with the spaces reset to it. Asked
 *  once the writes are through (the waiting-tasks question) */
function SetForSpaces({ bulk, rows, caps, phone, onClose }: { bulk: Extract<Bulk, { kind: 'column' }>; rows: LimitSpaceRow[]; caps: Caps; phone: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState(bulk.row.value)
  const [mode, setMode] = useState<'each' | 'all'>('each')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async () => {
    setBusy(true)
    setError('')
    const failed: string[] = []
    if (mode === 'each') {
      for (const r of rows) {
        const res = await write(caps.spaces.find((s) => s.key === r.key)?.place ?? r.id, bulk.key, draft)
        if (!res.ok) failed.push(`${r.name}: ${res.error}`)
      }
    } else {
      const res = await write('all', bulk.key, draft)
      if (!res.ok) failed.push(`Everywhere: ${res.error}`)
      else for (const r of rows) await write(r.id, bulk.key, null)
    }
    setBusy(false)
    if (failed.length) setError(failed.join(' '))
    else onClose()
  }
  return (
    <Dialog
      title={`Set ${bulk.title} for every space`}
      onCancel={onClose}
      buttons={
        <Primary autoFocus disabled={busy || !rows.length} onClick={run}>
          {busy ? 'Setting…' : `Set for ${rows.length} ${rows.length === 1 ? 'space' : 'spaces'}`}
        </Primary>
      }
    >
      <div className="flex flex-col gap-3">
        <Editor phone={phone} controls={[{ ...bulk.row, value: draft }]} reset={false} onSet={(_, x) => setDraft(x)} onReset={() => undefined} />
        <fieldset className="flex flex-col gap-1.5">
          <legend className="sr-only">How to set it</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="limit-mode" checked={mode === 'each'} onChange={() => setMode('each')} className="mt-1" />
            <span>Each space's own: written at each space, replacing its value.</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="limit-mode" checked={mode === 'all'} onChange={() => setMode('all')} className="mt-1" />
            <span>Everywhere, and reset the spaces to it: each space loses its own value, so every space reads Everywhere's.</span>
          </label>
        </fieldset>
        <Small className="text-pretty">{mode === 'each' ? 'Each space gets this value at its own level.' : 'Everywhere gets this value. Each space and this machine lose their own, and what they set there is lost.'}</Small>
        {error ? <Refused text={error} /> : null}
      </div>
    </Dialog>
  )
}

/** Set for every space…, for one provider's or model's sub-limit: the same number at each space, inside the machine's total;
 *  the spaces' other entries stay as they are */
function SetPatternForSpaces({ pattern, name, spaces, onClose }: { pattern: string; name: string; spaces: Caps['spaces']; onClose: () => void }) {
  const [n, setN] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const value = Number(n)
  const ok = n.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= 200
  const run = async () => {
    setBusy(true)
    setError('')
    const failed: string[] = []
    for (const s of spaces) {
      const r = await write(s.place, CAP_KEY, withEntry(s.text, pattern, value) || null)
      if (!r.ok) failed.push(`${s.name}: ${r.error}`)
    }
    setBusy(false)
    if (failed.length) setError(failed.join(' '))
    else onClose()
  }
  return (
    <Dialog
      title={`${name} at once: every space`}
      onCancel={onClose}
      buttons={
        <Primary autoFocus disabled={busy || !ok || !spaces.length} onClick={run}>
          {busy ? 'Setting…' : `Set for ${spaces.length} ${spaces.length === 1 ? 'space' : 'spaces'}`}
        </Primary>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex items-center justify-between gap-3">
          <span className="text-fg2">At once in each space</span>
          <input
            type="number"
            min={1}
            max={200}
            step={1}
            inputMode="numeric"
            aria-label={`Most ${name} at once in each space`}
            placeholder="a number"
            value={n}
            onChange={(e) => setN(e.target.value)}
            className="w-24 rounded-row bg-bg px-2 py-1 text-right tabular-nums shadow-[inset_0_0_0_1px_var(--line2)] outline-none focus:shadow-box-focus dark:bg-bubble"
          />
        </label>
        <Small className="text-pretty">Each space's sub-limit for {name} becomes this number, inside the machine's total. Its other entries stay as they are.</Small>
        {error ? <Refused text={error} /> : null}
      </div>
    </Dialog>
  )
}

/** Clear every space's sub-limit: a provider's or a model's entry taken out of each space's own text (the machine's total stays) */
function ClearSubLimits({ pattern, name, spaces, onClose }: { pattern: string; name: string; spaces: Caps['spaces']; onClose: () => void }) {
  const hit = spaces.filter((s) => entriesOf(s.text).some((e) => e.pattern === pattern))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async () => {
    setBusy(true)
    setError('')
    const failed: string[] = []
    for (const s of hit) {
      const r = await write(s.place, CAP_KEY, withEntry(s.text, pattern, undefined) || null)
      if (!r.ok) failed.push(`${s.name}: ${r.error}`)
    }
    setBusy(false)
    if (failed.length) setError(failed.join(' '))
    else onClose()
  }
  return (
    <Dialog
      title={`Clear ${name}'s sub-limit in every space`}
      onCancel={onClose}
      buttons={
        <Primary autoFocus disabled={busy || !hit.length} onClick={run}>
          {busy ? 'Clearing…' : `Clear in ${hit.length} ${hit.length === 1 ? 'space' : 'spaces'}`}
        </Primary>
      }
    >
      <div className="flex flex-col gap-2">
        <p>
          {hit.map((s) => s.name).join(', ')} {hit.length === 1 ? 'has' : 'have'} a sub-limit of its own for {name}. Each goes back to the machine's total for it, when there is one.
        </p>
        {error ? <Refused text={error} /> : null}
      </div>
    </Dialog>
  )
}

