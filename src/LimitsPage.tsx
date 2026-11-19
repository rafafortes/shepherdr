// Settings → Limits: every limit of this machine in one place, as a spreadsheet. Rows are Everywhere and this machine (the
// machine's start limits and its alerts), each of its spaces (Max tasks, Merge train, and the sub-limit of each provider or
// model), and each provider with its models under it (the cap, what runs by role, what is held, whether it is out, and
// its quota). A provider nothing uses yet (every provider a CLI offers, with no cap, run or usage) is under Other providers,
// open, so its cap can be set before it is used. Beside them, what waits now and why. Every cell writes the setting it
// shows, at its row's level, through the setting action (limits-view.ts reads them): nothing new is stored, and the
// profiles bar above holds them with the models.
// The desktop tables keep their first column and header in view; a phone shows one card per section, space and provider,
// with the same editors. Bulk actions are confirmed first (a column's Set for every space…, a provider's Clear every
// space's sub-limit).
import clsx from 'clsx'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { BLOCKED as BLOCKED_WORDS, parseMaxAtOnce, withEntry, type MaxEntry } from '@shared/model-caps.ts'
import { PLACE_MAX } from '@shared/space-order.ts'
import { shareOf } from '@shared/quota-words.ts'
import type { LimitCell, LimitColumn, LimitKnown, LimitProvider, LimitRow, LimitSpaceRow, LimitTable, LimitsView, QueueTask, SettingRow, WaitingGroup, WaitingNow, WaitingTask } from '@shared/types.ts'
import { act, openTask, useSnap } from './kernel.ts'
import { askWaitingMany } from './apply-waiting.tsx'
import { Anchored, OnTop } from './anchored.tsx'
import { CAP_KEY, CapCell, CapEditor } from './CapCell.tsx'
import { LimitChoice, limitValue, limitWords } from './LimitChoice.tsx'
import { Pop } from './cell-pop.tsx'
import { Editor, Refused } from './settings-parts.tsx'
import { HarnessRow, OtherProviders } from './ModelsSummary.tsx'
import { harnessGroups, inHarness } from '../shared/harness.ts'
import { ProfilesBar } from './Profiles.tsx'
import { openPage, shown } from './settings-parts.tsx'
import { Dialog } from './rowmenu.tsx'
import { Menu, MenuItem, MoreIcon, Primary, Small, ic } from './ui.tsx'

/** the + column's choices are kept in this browser: a column added with no entry yet stays until it is removed */
const COLUMNS = 'limits:columns'
/** the Waiting now sections and groups the viewer opened, kept in this browser: Held for room starts open */
const WAIT_OPEN = 'limits:waiting'
const WAIT_CARD = 'rounded-box bg-bg px-3 py-2 shadow-[inset_0_0_0_1px_var(--line)] dark:bg-bubble'
/** how many rows of a group show before its Show all button */
const WAIT_ROWS = 10
/** How long the page waits before it reads the view again after a change. A snapshot arrives with every change of any
 *  task (and one every 30 s at rest), and each read is the whole queue and every table built on the server: one read at
 *  most per this, never one per snapshot, and at once for a write made on this page (SHE-165). */
const LIMITS_EVERY = 2_000
function readOpen(): Record<string, boolean> {
  try {
    // a stored value that is no object (another version, a hand) keeps no section open instead of breaking the page
    const v = JSON.parse(localStorage.getItem(WAIT_OPEN) ?? '{}') as unknown
    return v && typeof v === 'object' ? (v as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}
function saveOpen(o: Record<string, boolean>) {
  try {
    localStorage.setItem(WAIT_OPEN, JSON.stringify(o))
  } catch {
    /* a browser with no storage keeps its sections open for this page only */
  }
}
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
async function write(place: string, key: string, value: string | null, quiet = false): Promise<Result> {
  const r = (await act({ type: 'setting', key, value, place }).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok?: boolean; error?: string }
  if (r?.ok) void askWaitingMany([{ key, place }])
  // the page reads its view again at once: the snapshot this write brings may be behind the read of the moment, and the
  // result of a write made here is never up to LIMITS_EVERY late. A bulk write says `quiet` and asks once at its end
  if (r?.ok && !quiet) asked()
  return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? "That didn't go through." }
}

/** the Limits pages open now, each asked to read the view again: a write made on one shows its result at once */
const openPages = new Set<() => void>()
/** every open page reads its view again now */
const asked = () => {
  for (const ask of openPages) ask()
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

/** each role's words, one and many */
const ROLE_WORDS = { task: ['task', 'tasks'], coordinator: ['coordinator', 'coordinators'], advisor: ['advisor', 'advisor'], reviewer: ['reviewer', 'reviewers'] } as const

/** what runs now on a provider or a model: each role in words ("2 tasks · 1 advisor"), the tasks' ids after their count,
 *  each a button that opens it ("3 tasks POL-313 POL-314 POL-315 · 1 coordinator"), or a dash */
export function RunningNow({ byRole, tasks }: { byRole: LimitProvider['byRole']; tasks?: string[] }) {
  const parts = (Object.keys(ROLE_WORDS) as (keyof typeof ROLE_WORDS)[]).flatMap((r) => {
    const n = byRole[r] ?? 0
    return n ? [{ r, words: `${n} ${n === 1 ? ROLE_WORDS[r][0] : ROLE_WORDS[r][1]}` }] : []
  })
  if (!parts.length) return <>—</>
  return (
    <span data-running>
      {parts.map((p, i) => (
        <span key={p.r}>
          {i ? ' · ' : ''}
          {p.words}
          {p.r === 'task' && tasks?.length ? (
            <>
              {' '}
              {tasks.map((id) => (
                <TaskButton key={id} id={id} />
              ))}
            </>
          ) : null}
        </span>
      ))}
    </span>
  )
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
const outWords = (r: LimitProvider['runOuts']) =>
  r.out ? (r.until !== undefined ? `out until ${new Date(r.until).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'out now') : '—'

/** a task's id as a button that opens it */
function TaskButton({ id }: { id: string }) {
  return (
    <button type="button" onClick={() => openTask(id)} className="press-dim mr-1 rounded-row font-medium text-accent hover:underline">
      {id}
    </button>
  )
}

/** the count of one kind, left out when there is none of it: "37 held for room", "1 merge waiting" */
const countWords = (n: number, rest: string) => `${n} ${rest}`

/** the Waiting now list: every task that has not started or waits to go on, in the order it will go, and why. Held tasks
 *  are numbered in the engine's own start order; the rest are queued after other tasks, scheduled, waiting for a go or
 *  waiting to merge. The advisor's questions and the review rounds wait too. Read only: an id opens its task. */
export function Waiting({ w, phone }: { w: WaitingNow; phone: boolean }) {
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen)
  const shown = (id: string, byDefault: boolean) => open[id] ?? byDefault
  const toggle = (id: string, byDefault: boolean) =>
    setOpen((prev) => {
      const next = { ...prev, [id]: !(prev[id] ?? byDefault) }
      saveOpen(next)
      return next
    })
  const queued = w.queued.reduce((n, g) => n + g.tasks.length, 0)
  const counts = [
    ...(w.held ? [countWords(w.held, 'held for room')] : []),
    ...(queued ? [countWords(queued, 'queued after other tasks')] : []),
    ...(w.scheduled.length ? [countWords(w.scheduled.length, 'scheduled')] : []),
    ...(w.todo.length ? [countWords(w.todo.length, 'waiting for a go')] : []),
    ...(w.merges.length ? [countWords(w.merges.length, w.merges.length === 1 ? 'merge waiting' : 'merges waiting')] : []),
  ]
  const none = !counts.length && !w.advisor.length && !w.reviews.length
  return (
    <section aria-label="Waiting now" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 className="font-medium">Waiting now</h2>
        <Small>{counts.length ? counts.join(' · ') : 'Nothing is held for room'}</Small>
      </div>
      {none ? <Small className="text-pretty">Every limit has room now: nothing waits for a slot, a load or a cap.</Small> : null}
      {w.spaceLines.some((s) => s.working || s.held || s.queued) ? (
        <ul className="flex flex-col gap-0.5">
          {w.spaceLines
            .filter((s) => s.working || s.held || s.queued)
            .map((s) => (
              <li key={s.name} className="text-fg2 text-pretty">
                <span className="font-medium">{s.name}:</span>{' '}
                {[s.working ? `${s.working} working` : '', s.held ? `${s.held} held` : '', s.queued ? `${s.queued} queued` : ''].filter(Boolean).join(', ')}
              </li>
            ))}
        </ul>
      ) : null}
      {counts.length ? (
        <Fragment>
          <WaitSection id="held" title="Held for room" byDefault open={shown} toggle={toggle}>
            {w.groups.length ? (
              <ul className={clsx('grid gap-2', phone ? '' : 'md:grid-cols-2')}>
                {w.groups.map((g) => (
                  <WaitGroup key={g.id} g={g} numbered open={shown} toggle={toggle} />
                ))}
              </ul>
            ) : (
              <Small className="text-pretty">Nothing here now.</Small>
            )}
          </WaitSection>
          <WaitSection id="queued" title="Queued after other tasks" open={shown} toggle={toggle}>
            {w.behindYou.tasks ? (
              <Small className="text-pretty">
                {w.behindYou.tasks} {w.behindYou.tasks === 1 ? 'task waits' : 'tasks wait'} behind {w.behindYou.roots.length} {w.behindYou.roots.length === 1 ? 'task that needs' : 'tasks that need'}{' '}
                you:{' '}
                {w.behindYou.roots.map((id, i) => (
                  <Fragment key={id}>
                    <TaskButton id={id} />
                    {i < w.behindYou.roots.length - 1 ? ', ' : ''}
                  </Fragment>
                ))}
              </Small>
            ) : null}
            {w.queued.length ? (
              <ul className={clsx('grid gap-2', phone ? '' : 'md:grid-cols-2')}>
                {w.queued.map((g) => (
                  <WaitGroup key={g.id} g={g} open={shown} toggle={toggle} />
                ))}
              </ul>
            ) : (
              <Small className="text-pretty">Nothing here now.</Small>
            )}
          </WaitSection>
          <WaitSection id="scheduled" title="Scheduled" open={shown} toggle={toggle}>
            <WaitList id="scheduled" title="Starting soonest first" tasks={w.scheduled} phone={phone} open={shown} toggle={toggle} />
          </WaitSection>
          <WaitSection id="todo" title="Waiting for a go" open={shown} toggle={toggle}>
            <WaitList id="todo" title="To do" tasks={w.todo} phone={phone} open={shown} toggle={toggle} />
          </WaitSection>
          <WaitSection id="merges" title="Merges waiting" open={shown} toggle={toggle}>
            <WaitList id="merges" title="In line to merge" tasks={w.merges} phone={phone} open={shown} toggle={toggle} />
          </WaitSection>
        </Fragment>
      ) : null}
      {w.advisor.length || w.reviews.length ? (
        <ul className={clsx('grid gap-2', phone ? '' : 'md:grid-cols-2')}>
          {w.advisor.length ? (
            <li className={WAIT_CARD}>
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
            <li className={WAIT_CARD}>
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
      ) : null}
    </section>
  )
}

/** one collapsible section of Waiting now: Held for room starts open, the rest closed; what the viewer opened is kept.
 *  Its title is a heading and the button inside it (a button holds no heading: assistive technology would lose it), and
 *  the button says whether it is open and which region it controls */
function WaitSection({
  id,
  title,
  byDefault = false,
  open,
  toggle,
  children,
}: {
  id: string
  title: string
  byDefault?: boolean
  open: (id: string, byDefault: boolean) => boolean
  toggle: (id: string, byDefault: boolean) => void
  children: ReactNode
}) {
  const isOpen = open(id, byDefault)
  const content = `waiting-${id}`
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="font-medium">
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={content}
          onClick={() => toggle(id, byDefault)}
          className="press-dim flex w-full items-center justify-between gap-2 rounded-row py-0.5 text-left hover:bg-hover"
        >
          {title}
          <span aria-hidden="true" className="text-fg3">
            {isOpen ? '−' : '+'}
          </span>
        </button>
      </h3>
      <div id={content} className={isOpen ? 'flex flex-col gap-2' : 'hidden'}>
        {isOpen ? children : null}
      </div>
    </section>
  )
}

/** one group in Waiting now: its count and at most its first rows, with Show all N for the rest */
function WaitGroup({
  g,
  numbered = false,
  open,
  toggle,
}: {
  g: WaitingGroup
  numbered?: boolean
  open: (id: string, byDefault: boolean) => boolean
  toggle: (id: string, byDefault: boolean) => void
}) {
  const id = `group:${g.id}`
  const all = open(id, false)
  const rows = all ? g.tasks : g.tasks.slice(0, WAIT_ROWS)
  return (
    <li data-group={g.id} className={WAIT_CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-medium">
          {g.title} <span className="tabular-nums text-fg2">· {g.tasks.length}</span>
        </span>
        {g.limit ? <Small className="text-pretty">{g.limit}</Small> : null}
      </div>
      <ul className="flex flex-col gap-0.5 pt-1">
        {rows.map((t: WaitingTask) => (
          <li key={t.id} className="flex min-w-0 flex-wrap gap-x-2 text-fg2">
            {numbered ? <span className="tabular-nums text-fg3">{t.order! + 1}.</span> : null}
            <TaskButton id={t.id} />
            <span className="min-w-0 text-pretty">
              {t.space} · {t.words}
              {t.need ? <span className="text-need-fg">{t.words === `After ${t.need.id}` ? `, which ${t.need.words}` : ` · ${t.need.id} ${t.need.words}`}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {g.tasks.length > WAIT_ROWS ? (
        <button type="button" onClick={() => toggle(id, false)} className="press-dim mt-1 rounded-row font-medium text-accent hover:underline">
          {all ? 'Show less' : `Show all ${g.tasks.length}`}
        </button>
      ) : null}
    </li>
  )
}

/** the flat kinds of Waiting now (scheduled, To do, merges): one group card, with its count and its first rows */
function WaitList({
  id,
  title,
  tasks,
  phone,
  open,
  toggle,
}: {
  id: string
  title: string
  tasks: QueueTask[]
  phone: boolean
  open: (id: string, byDefault: boolean) => boolean
  toggle: (id: string, byDefault: boolean) => void
}) {
  if (!tasks.length) return <Small className="text-pretty">Nothing here now.</Small>
  const key = `group:${id}`
  const all = open(key, false)
  const rows = all ? tasks : tasks.slice(0, WAIT_ROWS)
  return (
    <ul className={clsx('grid gap-2', phone ? '' : 'md:grid-cols-2')}>
      <li data-group={`list:${id}`} className={WAIT_CARD}>
        <span className="font-medium">
          {title} <span className="tabular-nums text-fg2">· {tasks.length}</span>
        </span>
        <ul className="flex flex-col gap-0.5 pt-1">
          {rows.map((t) => (
            <li key={t.id} className="flex min-w-0 flex-wrap gap-x-2 text-fg2">
              <TaskButton id={t.id} />
              <span className="min-w-0 text-pretty">
                {t.spaceName} · {t.words}
              </span>
            </li>
          ))}
        </ul>
        {tasks.length > WAIT_ROWS ? (
          <button type="button" onClick={() => toggle(key, false)} className="press-dim mt-1 rounded-row font-medium text-accent hover:underline">
            {all ? 'Show less' : `Show all ${tasks.length}`}
          </button>
        ) : null}
      </li>
    </ul>
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
  // a limit is three choices in words too: no cap (faint), 0 (blocked, in the warning color), or its number
  const lim = cell.row.num?.limit ? limitWords(cell.row.value) : undefined
  const words = lim ? lim.words : shown(cell.row.value)
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
        className={clsx(
          'press-dim block max-w-full rounded-row px-1.5 py-0.5 text-left tabular-nums hover:bg-hover aria-expanded:bg-sel',
          lim?.tone === 'zero' ? 'font-medium text-need-fg' : lim?.tone === 'none' || !cell.set ? 'text-fg3' : 'font-medium text-fg',
        )}
      >
        <span className="block truncate">{words}</span>
        {cell.now ? <span className="block truncate text-[0.75rem] font-normal text-fg3">{cell.now}</span> : null}
        {cell.set ? null : <span className="block truncate text-[0.75rem] text-fg3">{fromWord(cell.from, machine)}</span>}
      </button>
      {open ? phone ? <div className="pt-1">{editor}</div> : <Pop onClose={close}>{editor}</Pop> : null}
    </span>
  )
}

/** one value a move writes: the place of a space's Priority cell, and its number now (null: it goes back to by age) */
type Move = { place: string; value: string | null }

/** the number a space's Priority cell holds now, or null when it has none: off, a value no longer readable, one outside the
 *  range Settings keeps (1 to PLACE_MAX), which the queue reads as no place at all (settings.ts spacePriority), or the home
 *  space's, which has no tasks of its own and no place to move (the server refuses a write there) */
function placeOf(row: LimitSpaceRow): number | null {
  const v = row.home ? '' : (row.cells['space.priority']?.row.value.trim() ?? '')
  if (!/^[0-9]+$/.test(v)) return null
  const n = Number(v)
  return n >= 1 && n <= PLACE_MAX ? n : null
}

/**
 * What one arrow does to this machine's numbered spaces, as the values it writes — and nothing when the arrow is off:
 * ↑ on a numbered space swaps its number with the numbered space above it, and ↓ swaps it with the one below; ↓ on the
 * last numbered one clears its number, so it goes back to by age with the others that have none. ↑ on a space with no
 * number puts it last among the numbered ones, in one write, and its ↓ is off (it is already after them all). Only the
 * numbered spaces are touched, and only the values that change; a space with no number keeps none until the human gives
 * it a place.
 *
 * Two spaces may hold the same number (they then go by age, as the setting says), and a swap of two numbers can say
 * nothing there: equal numbers would leave the list as it was, and two different ones let the row jump over the numbers
 * between them. So while any two numbered spaces share a number, a move gives the numbered ones 1, 2, 3, … in their new
 * order instead — the same places in the same order, now each its own, and only the numbers that change are written.
 */
function moveOf(rows: LimitSpaceRow[], at: number, dir: -1 | 1): Move[] | null {
  const row = rows[at]
  if (!row || row.home) return null
  const place = placeAt(row)
  const mine = placeOf(row)
  if (!place) return null
  const numbered = rows.filter((r) => placeOf(r) !== null)
  const numbers = numbered.map((r) => placeOf(r) ?? 0)
  // no number yet: it goes last among the numbered ones (the first one when nothing is numbered), and no lower. Past the
  // range there is no place to give it: the arrow is off rather than refused by the server
  if (mine === null) {
    const next = Math.max(0, ...numbers) + 1
    return dir < 0 && next <= PLACE_MAX ? [{ place, value: String(next) }] : null
  }
  // a tie anywhere among the numbered ones: the numbered spaces are renumbered 1, 2, 3, … in the order the move makes
  if (new Set(numbers).size !== numbers.length) {
    const from = numbered.indexOf(row)
    const to = from + dir
    // ↓ on the last numbered one still clears its number, as it does with no tie: it goes back to by age
    if (to >= numbered.length) return [{ place, value: null }]
    if (to < 0) return null
    const order = numbered.filter((_, i) => i !== from)
    order.splice(to, 0, row)
    return order.flatMap((r, i) => {
      const cell = placeAt(r)
      return cell && placeOf(r) !== i + 1 ? [{ place: cell, value: String(i + 1) }] : []
    })
  }
  // the numbered row above (↑) or below (↓) it in the table: the one the arrow passes, and the first with a number that
  // way (the numbered ones come first, so it is the next row, but a row with no place is stepped over all the same)
  let neighbour: LimitSpaceRow | undefined
  for (let i = at + dir; i >= 0 && i < rows.length; i += dir) {
    const r = rows[i]
    if (r && placeOf(r) !== null) {
      neighbour = r
      break
    }
  }
  const other = neighbour ? placeAt(neighbour) : undefined
  const n = neighbour ? placeOf(neighbour) : null
  if (other && n !== null)
    return [
      { place, value: String(n) },
      { place: other, value: String(mine) },
    ]
  // ↑ with none above it is off; ↓ with none below is the last numbered one, and goes back to by age
  return dir > 0 ? [{ place, value: null }] : null
}

/** where a space's Priority is written: its cell's place (every row of the Spaces table has one) */
const placeAt = (row: LimitSpaceRow) => row.cells['space.priority']?.place

/** a space's Priority in this machine's queue, with the buttons that move it up or down. They are real buttons, so a Tab
 *  and Enter/Space and a finger both work, without adding drag code; a move writes only the numbers it changes, as one
 *  action, and every button is off while one is being written */
function PriorityCell({ row, rows, machine, phone, moving, onMove }: { row: LimitSpaceRow; rows: LimitSpaceRow[]; machine: string; phone: boolean; moving: boolean; onMove: (moves: Move[]) => void }) {
  const at = rows.indexOf(row)
  const up = moveOf(rows, at, -1)
  const down = moveOf(rows, at, 1)
  const button = (dir: -1 | 1, moves: Move[] | null) => (
    <button
      type="button"
      aria-label={`Move ${row.name} ${dir < 0 ? 'up' : 'down'}`}
      disabled={moving || !moves}
      onClick={() => moves && onMove(moves)}
      className="press-dim grid size-9 shrink-0 place-items-center rounded-row text-fg2 hover:bg-hover disabled:opacity-30"
    >
      <span aria-hidden="true">{dir < 0 ? '↑' : '↓'}</span>
    </button>
  )
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 flex-1">
        <LimitValue title={`${row.name} · Priority`} cell={row.cells['space.priority']!} machine={machine} phone={phone} />
      </span>
      {button(-1, up)}
      {button(1, down)}
    </span>
  )
}

/** a space's sub-limit for one pattern: its own entry (strong: its runs now, of its max), or none (faint: the machine's total
 *  applies, or no sub-limit). Either opens the cap editor at this space: a number, or Clear here */
function SpaceCapCell({
  name,
  pattern,
  space,
  caps,
  total,
  phone,
  openId,
  onOpen,
  onSaved,
}: {
  name: string
  pattern: string
  space: LimitSpaceRow
  caps: Caps
  total?: number
  phone: boolean
  openId: string | null
  onOpen: (id: string | null) => void
  onSaved?: () => void
}) {
  // its own id: a provider's cap (CapCell) names the same space's line as cap|<pattern>|<space>, which must not open with this one
  const id = `space-cap|${pattern}|${space.key}`
  const mine = space.caps[pattern]
  const open = openId === id
  const words = mine ? (mine.max === 0 ? BLOCKED_WORDS : `${mine.now} of ${mine.max} at once`) : total ? `machine's total applies (${total} at once)` : 'no sub-limit'
  const editor = <CapEditor name={name} pattern={pattern} caps={caps} phone={phone} space={space.key} onClose={() => onOpen(null)} onSaved={onSaved} />
  return (
    <span className="relative block min-w-0">
      <button
        type="button"
        data-cell={id}
        aria-haspopup={phone ? undefined : 'dialog'}
        aria-expanded={open}
        aria-label={`${name} in ${space.name}: ${words}`}
        onClick={() => onOpen(open ? null : id)}
        className={clsx(
          'press-dim block max-w-full truncate rounded-row px-1.5 py-0.5 text-left tabular-nums hover:bg-hover aria-expanded:bg-sel',
          mine?.max === 0 ? 'font-medium text-need-fg' : mine ? 'font-medium text-fg' : 'text-fg3',
        )}
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
  'machine.startMemoryPressure': 'Memory pressure',
  'machine.startIoPressure': 'I/O pressure',
  'machine.startMemory': 'Memory',
  'machine.startSwap': 'Swap',
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
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu === id}
        onClick={() => setMenu(menu === id ? null : id)}
        className="press-dim grid size-6 place-items-center rounded-full text-fg3 hover:bg-sel hover:text-fg aria-expanded:bg-sel aria-expanded:text-fg"
      >
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

/** what the page's reads are doing: the timer of the next one, one on its way, a change since the last read, a write
 *  that asked for a read while one was on its way, when the last read started, and gone once the page closed */
type Reads = { timer: ReturnType<typeof setTimeout> | null; busy: boolean; dirty: boolean; soon: boolean; at: number; gone: boolean; for: unknown; moves: number }

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
  // a move of a space up or down: its values go as one action (server: space-order), the arrows are off while it is
  // written, and a second tap before the page draws again is dropped here, not only by the buttons
  const [moving, setMoving] = useState(false)
  const inFlight = useRef(false)
  const [moveError, setMoveError] = useState('')
  const move = async (moves: Move[]) => {
    if (inFlight.current) return
    inFlight.current = true
    setMoving(true)
    setMoveError('')
    // counted before it is sent: a read that came back from before this move (or from during it) says nothing of the rows
    // it makes, so it leaves the arrows off; only the move's own answer and the read it asks for bring them back
    moved.current++
    const r = (await act({ type: 'space-order', moves }).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok?: boolean; error?: string }
    // written: the arrows stay off until the page has read the rows the write made (the snapshot it brings); refused: no
    // snapshot comes, so they come back now with the reason
    if (!r?.ok) {
      inFlight.current = false
      setMoving(false)
      setMoveError(r?.error ?? "That didn't go through.")
    } else askNow.current()
  }
  // the reads of the view: one at a time, at most one every LIMITS_EVERY while something changed (one trailing read,
  // never a queue of them), at once for a write made here, and none while the tab is hidden: shown again, it reads once
  const reads = useRef<Reads>({ timer: null, busy: false, dirty: false, soon: false, at: 0, gone: false, for: snap, moves: 0 })
  // the snapshot on screen now: one that arrives while a read is on its way makes that read out of date
  const seen = useRef(snap)
  // how many moves this page has written: an answer sent before one of them says nothing of the rows it made
  const moved = useRef(0)
  /** read the view now, unless the tab is hidden (then it is asked for once it is shown again) */
  const go = () => {
    const r = reads.current
    if (r.gone) return
    if (document.visibilityState === 'hidden') {
      r.dirty = true
      return
    }
    r.busy = true
    r.dirty = false
    r.at = Date.now()
    r.for = seen.current
    r.moves = moved.current
    act({ type: 'limits-view' })
      .then((next) => {
        if (r.gone) return
        setV(next as LimitsView)
        setFailed('')
        // a move's write is in: its arrows come back with the rows the write made, never with the ones before it. A read
        // a change overtook says nothing of those rows, so one more read is due instead
        if (r.moves >= moved.current) {
          inFlight.current = false
          setMoving(false)
        }
        // a change that landed while this read was on its way may make what it brought older than the screen
        if (seen.current !== r.for) r.dirty = true
      })
      .catch((e: Error) => !r.gone && setFailed(e.message))
      .finally(() => {
        r.busy = false
        if (r.gone) return
        // a write asked for a read while this one was on its way: it goes at once; a change, at the interval's pace
        if (r.soon) {
          r.soon = false
          go()
        } else if (r.dirty) ask(false)
      })
  }
  /** a change (or this page's own write, `atOnce`): a read now if the last one was a while ago, else one read when its
   *  interval is over, and nothing at all while the tab is hidden */
  const ask = (atOnce: boolean) => {
    const r = reads.current
    if (r.busy) {
      if (atOnce) r.soon = true
      else r.dirty = true
      return
    }
    if (atOnce) {
      if (r.timer) clearTimeout(r.timer)
      r.timer = null
      go()
      return
    }
    r.dirty = true
    if (r.timer || document.visibilityState === 'hidden') return
    r.timer = setTimeout(
      () => {
        r.timer = null
        go()
      },
      Math.max(0, r.at + LIMITS_EVERY - Date.now()),
    )
  }
  const askNow = useRef(() => ask(true))
  askNow.current = () => ask(true)
  // the snapshot on screen when the page opened is what its first read reads
  useEffect(() => {
    const r = reads.current
    r.gone = false
    const mine = () => askNow.current()
    openPages.add(mine)
    ask(true)
    return () => {
      openPages.delete(mine)
      r.gone = true
      if (r.timer) clearTimeout(r.timer)
      r.timer = null
    }
  }, [])
  // a change of Settings is a new snapshot: the page reads again, at most once every LIMITS_EVERY
  useEffect(() => {
    if (seen.current === snap) return
    seen.current = snap
    ask(false)
  }, [snap])
  // a hidden tab asks nothing; shown again, it reads once when something changed while it was away
  useEffect(() => {
    const shownAgain = () => {
      if (document.visibilityState !== 'hidden') ask(true)
    }
    document.addEventListener('visibilitychange', shownAgain)
    return () => document.removeEventListener('visibilitychange', shownAgain)
  }, [])
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
  // the providers in use, then those nothing uses yet (Other providers): a phone's card per provider, a desktop's grid
  const used = v.providers.filter((p) => !p.idle)
  const idle = v.providers.filter((p) => p.idle)
  // a phone's cards, under a heading for each harness that runs several providers
  const providerCards = (list: LimitProvider[]) =>
    harnessGroups(list).map((g) => (
      <Fragment key={g.harness}>
        {g.single ? null : <h3 className="px-1 font-medium text-fg2">{g.name}</h3>}
        {g.list.map((p) => (
          <section key={p.provider} aria-label={p.name} className="rounded-box bg-bg shadow-[inset_0_0_0_1px_var(--line)] dark:bg-bubble">
            <div className="flex items-center gap-2 px-4 pt-3 pb-1">
              <h3 className="min-w-0 flex-1 truncate font-medium">{p.name}</h3>
              {p.local ? <Small>local</Small> : null}
            </div>
            <div className="flex flex-col gap-1 px-4 pb-2">
              <Small className="text-fg2">Max at once</Small>
              <CapCell name={p.name} harness={p.harnessName} pattern={p.provider} atOnce={p.atOnce} caps={v.caps} phone openId={capOpen} onOpen={setCapOpen} onSaved={() => askNow.current()} />
              <ProviderFacts byRole={p.byRole} tasks={p.tasks} held={p.atOnce.held} runOuts={p.runOuts} quota={p.quota} read={p.quotaRead} />
            </div>
            {p.models.map((m) => (
              <div key={m.key} className="flex flex-col gap-1 border-t border-line px-4 py-2">
                <span className="truncate text-fg2">{m.label}</span>
                <CapCell name={m.label} pattern={m.key} atOnce={m.atOnce} caps={v.caps} phone openId={capOpen} onOpen={setCapOpen} onSaved={() => askNow.current()} />
                <ProviderFacts byRole={m.byRole} tasks={m.tasks} held={m.atOnce.held} runOuts={m.runOuts} />
              </div>
            ))}
          </section>
        ))}
      </Fragment>
    ))
  // the desktop table: a heading row for each harness that runs several providers, its providers and their models under it
  const providerGrid = (label: string, list: LimitProvider[]) => (
    <table aria-label={label} className="w-full table-fixed border-separate border-spacing-0 text-[0.8125rem]">
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
        {harnessGroups(list).map((g) => (
          <Fragment key={g.harness}>
            {g.single ? null : <HarnessRow name={g.name} cols={6} />}
            {g.list.map((p) => (
              <ProviderRows
                key={p.provider}
                p={p}
                v={v}
                nested={!g.single}
                capOpen={capOpen}
                setCapOpen={setCapOpen}
                menu={menu}
                setMenu={setMenu}
                hasSubs={hasSubs(p.provider)}
                onClear={() => setBulk({ kind: 'clear', pattern: p.provider, name: inHarness(p.harnessName, p.name) })}
                onSaved={() => askNow.current()}
              />
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  )

  return (
    <div className={clsx('flex w-full flex-col gap-5', phone ? 'px-4 pb-6' : 'px-6 pt-5 pb-8')}>
      <ProfilesBar phone={phone} limits />
      <Waiting w={v.waiting} phone={phone} />

      <section aria-label="Machine limits" className="flex flex-col gap-2">
        <div className="flex flex-col">
          <h2 className="font-medium">Machine · {v.machine.name}</h2>
          <Small className="text-pretty">
            How many of this machine's tasks work at once, and when it holds new ones. The numbers beside each value are read now. Everywhere is the default for every machine; this machine's own value
            wins.
          </Small>
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
          <Small className="text-pretty">
            Each space's own limits, listed in queue order. Priority puts a space ahead of the others: while it has a task that can start, no later space starts one, so give it a Max tasks cap to
            leave room. Max tasks is a cap inside the machine's. A column is one provider's or model's sub-limit for each space: its own runs, inside the machine's total for that row. An empty cell
            has none of its own.
          </Small>
        </div>
        {phone ? (
          <div className="flex flex-col gap-3">
            {spaceRows.map((row) => (
              <section key={row.id} aria-label={`Space ${row.name}`} className="rounded-box bg-bg shadow-[inset_0_0_0_1px_var(--line)] dark:bg-bubble">
                <div className="flex items-center gap-2 px-4 pt-3 pb-1">
                  <h3 className="min-w-0 flex-1 truncate font-medium">{row.name}</h3>
                  <Small>
                    {row.working} working{row.held ? ` · ${row.held} held` : ''}
                  </Small>
                </div>
                <ul className="flex flex-col px-4 pb-2">
                  {(
                    [
                      ['space.priority', 'Priority'],
                      ['space.maxTasks', 'Max tasks'],
                      ['merge.train', 'Merge train'],
                    ] as const
                  ).map(([key, title]) => (
                    <li key={key} className="flex flex-col gap-1 border-t border-line py-2">
                      <Small className="text-fg2">{title}</Small>
                      {key === 'space.priority' ? (
                        <PriorityCell row={row} rows={spaceRows} machine={v.machine.name} phone moving={moving} onMove={(next) => void move(next)} />
                      ) : (
                        <LimitValue title={`${row.name} · ${title}`} cell={row.cells[key]!} machine={v.machine.name} phone />
                      )}
                    </li>
                  ))}
                </ul>
                {patterns.length ? (
                  <ul className="flex flex-col px-4 pt-1 pb-2">
                    {patterns.map((p) => (
                      <li key={p} className="flex flex-col gap-1 border-t border-line py-2">
                        <Small className="text-fg2">{nameOf(v, p)} · at once in this space</Small>
                        <SpaceCapCell name={nameOf(v, p)} pattern={p} space={row} caps={v.caps} total={machineTotal(p)} phone openId={capOpen} onOpen={setCapOpen} onSaved={() => askNow.current()} />
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
                  <th
                    scope="col"
                    title="Lower numbers start first. While the first space has a task that can start, no later space starts one: cap its Max tasks to leave room. A task marked first in line still goes ahead."
                    className="sticky top-0 z-20 bg-bg px-2 pb-2 text-left align-bottom font-medium whitespace-nowrap text-fg3"
                  >
                    Priority
                  </th>
                  <th scope="col" className="sticky top-0 z-20 bg-bg px-2 pb-2 text-left align-bottom font-medium whitespace-nowrap text-fg3">
                    <span className="inline-flex items-center gap-1">
                      Max tasks
                      <More
                        id="col:space.maxTasks"
                        label="More for Max tasks"
                        menu={menu}
                        setMenu={setMenu}
                        items={spaceColumn('space.maxTasks', 'Max tasks', {
                          label: 'Max tasks of this space working at once',
                          key: 'space.maxTasks',
                          value: 'off',
                          num: { min: 0, max: 200, off: true, limit: true },
                        })}
                      />
                    </span>
                  </th>
                  <th scope="col" className="sticky top-0 z-20 bg-bg px-2 pb-2 text-left align-bottom font-medium whitespace-nowrap text-fg3">
                    <span className="inline-flex items-center gap-1">
                      Merge train
                      <More
                        id="col:merge.train"
                        label="More for Merge train"
                        menu={menu}
                        setMenu={setMenu}
                        items={spaceColumn('merge.train', 'Merge train', { label: 'Merge train', key: 'merge.train', value: 'off', options: ['off', '2', '3', '4', '5'] })}
                      />
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
                      <button
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={picker}
                        onClick={() => setPicker(!picker)}
                        className="press-dim rounded-row px-1.5 py-0.5 font-medium whitespace-nowrap text-accent hover:bg-hover"
                      >
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
                    <td className="relative py-1.5 pr-3 align-top">
                      <PriorityCell row={row} rows={spaceRows} machine={v.machine.name} phone={false} moving={moving} onMove={(next) => void move(next)} />
                    </td>
                    {(['space.maxTasks', 'merge.train'] as const).map((key) => (
                      <td key={key} className="relative py-1.5 pr-3 align-top">
                        <LimitValue title={`${row.name} · ${key === 'space.maxTasks' ? 'Max tasks' : 'Merge train'}`} cell={row.cells[key]!} machine={v.machine.name} phone={false} />
                      </td>
                    ))}
                    {patterns.map((p) => (
                      <td key={p} className="relative py-1.5 pr-3 align-top">
                        <SpaceCapCell
                          name={nameOf(v, p)}
                          pattern={p}
                          space={row}
                          caps={v.caps}
                          total={machineTotal(p)}
                          phone={false}
                          openId={capOpen}
                          onOpen={setCapOpen}
                          onSaved={() => askNow.current()}
                        />
                      </td>
                    ))}
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {moveError || failed ? (
          <Small role="alert" className="text-need-fg">
            {moveError || failed}
          </Small>
        ) : null}
        <Small className="text-pretty">A space with no number goes by age, after the numbered ones.</Small>
        <Small className="text-pretty">
          Strong: set at that space. Faint: inherited, or none. A sub-limit is written at its space; the machine's total is written at this machine or Everywhere, in the table of the providers below.
        </Small>
      </section>

      <section aria-label="Providers and models" className="flex flex-col gap-2">
        <div className="flex flex-col">
          <h2 className="font-medium">Providers and models</h2>
          <Small className="text-pretty">
            Every provider with a cap, an agent, a run or usage, and its models under it; the others a CLI offers are under Other providers, where a cap can be set before they are used. Max at once is
            the machine's total for the row, set at this machine or Everywhere (the sub-limits of the spaces show under it). The quota and the run-outs are read from each provider; the details are in{' '}
            <button type="button" onClick={() => openPage('Models', 'all')} className="press-dim rounded-row font-medium text-accent hover:underline">
              Models
            </button>
            .
          </Small>
        </div>
        {phone ? (
          <div className="flex flex-col gap-3">
            {providerCards(used)}
            {idle.length ? (
              <OtherProviders count={idle.length} open>
                <div className="flex flex-col gap-3">{providerCards(idle)}</div>
              </OtherProviders>
            ) : null}
          </div>
        ) : (
          <div className="max-h-[min(70vh,44rem)] max-w-full overflow-auto overscroll-contain">
            {providerGrid('Providers and models', used)}
            {idle.length ? (
              <OtherProviders count={idle.length} open>
                {providerGrid('Other providers', idle)}
              </OtherProviders>
            ) : null}
          </div>
        )}
        <Small className="text-pretty">
          Local servers (spark, radeon, avell, dell) have no quota. A cap counts this machine's agents only: a request from another app on the same server is not seen.
        </Small>
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
function ProviderFacts({
  byRole,
  tasks,
  held,
  runOuts,
  quota,
  read,
}: {
  byRole: LimitProvider['byRole']
  tasks?: string[]
  held: number
  runOuts: LimitProvider['runOuts']
  quota?: LimitProvider['quota']
  read?: LimitProvider['quotaRead']
}) {
  return (
    <dl className="flex flex-col gap-0.5 text-fg2">
      <div className="flex gap-2">
        <dt className="text-fg3">Running now</dt>
        <dd className="tabular-nums">
          <RunningNow byRole={byRole} tasks={tasks} />
        </dd>
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
function ProviderRows({
  p,
  v,
  nested,
  capOpen,
  setCapOpen,
  menu,
  setMenu,
  hasSubs,
  onClear,
  onSaved,
}: {
  p: LimitProvider
  v: LimitsView
  nested: boolean
  capOpen: string | null
  setCapOpen: (id: string | null) => void
  menu: string | null
  setMenu: (m: string | null) => void
  hasSubs: boolean
  onClear: () => void
  onSaved?: () => void
}) {
  const cells = (
    name: string,
    pattern: string,
    atOnce: LimitProvider['atOnce'],
    byRole: LimitProvider['byRole'],
    tasks: string[] | undefined,
    runOuts: LimitProvider['runOuts'],
    held: number,
    quota?: LimitProvider['quota'],
    read?: LimitProvider['quotaRead'],
    clear?: boolean,
    harness?: string,
  ) => (
    <>
      <td className="relative py-1.5 pr-3 align-top">
        <span className="flex items-start gap-1">
          <span className="min-w-0 flex-1">
            <CapCell name={name} harness={harness} pattern={pattern} atOnce={atOnce} caps={v.caps} phone={false} openId={capOpen} onOpen={setCapOpen} onSaved={onSaved} />
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
      <td className="py-1.5 pr-3 align-top text-fg2 tabular-nums">
        <RunningNow byRole={byRole} tasks={tasks} />
      </td>
      <td className="py-1.5 pr-3 align-top text-fg2 tabular-nums">{held || '—'}</td>
      <td className="py-1.5 pr-3 align-top text-fg2">{outWords(runOuts)}</td>
      <td className="py-1.5 pr-3 align-top text-fg2 tabular-nums">
        {read || quota
          ? quotaLines(quota, read).map((l) => (
              <span key={l} className="block">
                {l}
              </span>
            ))
          : '—'}
      </td>
    </>
  )
  return (
    <>
      <tr>
        <th scope="row" className={clsx('sticky left-0 z-10 bg-bg pr-4 py-1.5 text-left align-top font-normal', nested && 'pl-5')}>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium text-fg" title={p.name}>
              {p.name}
            </span>
            {p.local ? <span className="shrink-0 text-[0.75rem] text-fg3">local</span> : null}
          </span>
        </th>
        {cells(p.name, p.provider, p.atOnce, p.byRole, p.tasks, p.runOuts, p.atOnce.held, p.quota, p.quotaRead, hasSubs, p.harnessName)}
      </tr>
      {p.models.map((m) => (
        <tr key={m.key}>
          <th scope="row" className={clsx('sticky left-0 z-10 bg-bg py-1 pr-4 text-left align-top font-normal', nested ? 'pl-10' : 'pl-6')}>
            <span className="block truncate text-fg2" title={m.key}>
              {m.label}
            </span>
          </th>
          {cells(m.label, m.key, m.atOnce, m.byRole, m.tasks, m.runOuts, m.atOnce.held)}
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
        const res = await write(caps.spaces.find((s) => s.key === r.key)?.place ?? r.id, bulk.key, draft, true)
        if (!res.ok) failed.push(`${r.name}: ${res.error}`)
      }
    } else {
      const res = await write('all', bulk.key, draft, true)
      if (!res.ok) failed.push(`Everywhere: ${res.error}`)
      else for (const r of rows) await write(r.id, bulk.key, null, true)
    }
    // one read for the whole bulk, not one for each setting it wrote
    asked()
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
        <Small className="text-pretty">
          {mode === 'each' ? 'Each space gets this value at its own level.' : 'Everywhere gets this value. Each space and this machine lose their own, and what they set there is lost.'}
        </Small>
        {error ? <Refused text={error} /> : null}
      </div>
    </Dialog>
  )
}

/** Set for every space…, for one provider's or model's sub-limit: the same number at each space, inside the machine's total;
 *  the spaces' other entries stay as they are */
function SetPatternForSpaces({ pattern, name, spaces, onClose }: { pattern: string; name: string; spaces: Caps['spaces']; onClose: () => void }) {
  // the three choices (LimitChoice): no cap takes the entry out of each space, blocked (0) or a number sets it
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ok = draft !== '' && (draft === 'off' || limitValue('limit', draft, 200) !== '' || draft === '0')
  const run = async () => {
    setBusy(true)
    setError('')
    const failed: string[] = []
    const max = draft === 'off' ? undefined : Number(draft)
    for (const s of spaces) {
      const r = await write(s.place, CAP_KEY, withEntry(s.text, pattern, max) || null, true)
      if (!r.ok) failed.push(`${s.name}: ${r.error}`)
    }
    asked()
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
        <LimitChoice label={`Most ${name} at once in each space`} value={draft} max={200} zero="Blocked · 0 allowed" onChange={(v) => setDraft(v)} />
        <Small className="text-pretty">
          Each space's sub-limit for {name} becomes this choice: no cap takes its own out, blocked (0) starts none of {name} there, a number caps it inside the machine's total. Its other entries stay
          as they are.
        </Small>
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
      const r = await write(s.place, CAP_KEY, withEntry(s.text, pattern, undefined) || null, true)
      if (!r.ok) failed.push(`${s.name}: ${r.error}`)
    }
    asked()
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
