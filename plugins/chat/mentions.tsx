// A mention in a chat, drawn: the "#" and "@" lists over the message box, and a space or a task picked in the box as a
// chip that opens it. The words and their mentions are plugins/chat/mentions.ts; this is how they show.
import clsx from 'clsx'
import { Fragment, useEffect, useRef } from 'react'
import { goPlace, manyMachines, openTask, useSnap } from '@client/kernel.ts'
import { Dot, HashIcon, ic, STATUS_WORD } from '@client/ui.tsx'
import { hasMention, matchSpaces, matchTasks, placeOf, short, split, taskOf, mentionTyping, type Kind, type Mention, type Typing } from './mentions.ts'
import type { Place, Snapshot, Status, Task } from '@shared/types.ts'

/** a row of the "#" list (a space) or of the "@" list (a task) */
export type Item = { kind: 'space'; key: string; place: Place; on: string } | { kind: 'task'; key: string; task: Task }

/** the # or @ list for what is typed, or null when nothing is: the spaces, or the tasks waiting on the person and at
    work first and Done last */
export function mentionItems(snap: Snapshot | null | undefined, text: string, caret: number): (Typing & { items: Item[] }) | null {
  const t = mentionTyping(text, caret)
  if (!t) return null
  if (!snap) return { ...t, items: [] }
  // one machine: its spaces need no machine beside them (as everywhere on the screen)
  const machines = manyMachines(snap)
  const items: Item[] =
    t.kind === 'space'
      ? matchSpaces(snap.places, t.word).map((p) => ({ kind: 'space' as const, key: p.id, place: p, on: machines ? p.machine : '' }))
      : matchTasks(snap.tasks, t.word).map((x) => ({ kind: 'task' as const, key: x.id, task: x }))
  return { ...t, items }
}

/** what a pick puts in the box, so it reads as words: a space "#gtm", a task its id */
export const inBox = (i: Item) => (i.kind === 'space' ? `#${i.place.name} ` : `@${i.task.id} `)

/** what its mention says at Send, kept until then */
export const pickOf = (i: Item) =>
  i.kind === 'space' ? ({ kind: 'space', id: i.place.id, name: i.place.name } as const) : ({ kind: 'task', id: i.task.id, ref: i.task.id } as const)

/** The # or @ list over the message box: a tap takes one; the arrows, Enter and Escape are the box's own (client.tsx) */
export function MentionList({ kind, items, sel, pick }: { kind: Kind; items: Item[]; sel: number; pick: (i: Item) => void }) {
  const rows = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    rows.current[sel]?.scrollIntoView({ block: 'nearest' })
  }, [sel])
  if (!items.length) return null
  return (
    <div
      role="listbox"
      aria-label={kind === 'space' ? 'Mention a space' : 'Mention a task'}
      data-mentions
      className="popover mb-2 max-h-[min(22rem,40dvh)] overflow-y-auto overscroll-contain"
    >
      <div className="flex h-7 items-center px-2.5 text-[0.75rem] text-fg3 phone:h-9 phone:px-3 phone:text-[0.8125rem]">{kind === 'space' ? 'Spaces' : 'Tasks'}</div>
      {items.map((i, n) => (
        <button
          key={i.key}
          ref={(el) => {
            rows.current[n] = el
          }}
          type="button"
          role="option"
          aria-selected={n === sel}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(i)}
          className={clsx(
            'press flex w-full min-w-0 items-center gap-2.5 rounded-row px-2.5 py-1 text-left phone:py-2',
            n === sel ? 'bg-hover' : 'hover:bg-hover',
          )}
        >
          {i.kind === 'space' ? (
            <>
              <span aria-hidden className="grid w-4 shrink-0 place-items-center text-fg3 phone:w-5">
                <HashIcon className={ic} />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{i.place.name}</span>
              {i.on ? <span className="shrink-0 text-[0.75rem] text-fg3 phone:text-[0.8125rem]">{i.on}</span> : null}
            </>
          ) : (
            <>
              <span className="grid w-4 shrink-0 place-items-center phone:w-5">
                <Dot s={i.task.status} p={i.task.report?.progress} />
              </span>
              <span className="shrink-0 font-medium tabular-nums">{i.task.id}</span>
              <span className="min-w-0 flex-1 truncate text-fg2">{i.task.name}</span>
              <span className="shrink-0 text-[0.75rem] text-fg3 phone:text-[0.8125rem]">{STATUS_WORD[i.task.status]}</span>
            </>
          )}
        </button>
      ))}
    </div>
  )
}

/* ---------- in a message ---------- */

/** what a mention shows as: its chip's words, its second part and state, and where a tap goes (nowhere: the space or
    task is not here any more, so the chip is only its words) */
type Shown = { text: string; sub?: string; where?: string; status?: Status; progress?: number; open?: { kind: Kind; id: string } }

function shown(snap: Snapshot | null | undefined, m: Mention): Shown {
  if (m.kind === 'space') {
    const p = placeOf(snap, m.id)
    if (!p) return { text: `#${m.name}` }
    return { text: `#${p.name}`, where: snap && manyMachines(snap) ? p.machine : undefined, open: { kind: 'space', id: p.id } }
  }
  const t = taskOf(snap, m.id)
  if (!t) return { text: `@${m.ref}` }
  return { text: t.id, sub: t.name, status: t.status, progress: t.report?.progress, open: { kind: 'task', id: t.id } }
}

const CHIP = 'inline-flex max-w-full items-baseline gap-1 rounded-md py-px pr-1.5 pl-1 align-baseline whitespace-nowrap'
const OPEN = 'cursor-pointer bg-accent/12 text-accent hover:bg-accent/20'
const GONE = 'bg-sel text-fg3'

const openOf = (s: Shown) => (s.open?.kind === 'space' ? `Open space ${s.text.slice(1)}` : `Open task ${s.text}`)

/** a space or a task in a message as a chip: a tap opens it. Drawn the same in the person's words and in an agent's
    reply, so a mention reads as one thing wherever it comes from */
export function Chip({ mention }: { mention: Mention }) {
  const snap = useSnap()
  return renderChip(shown(snap, mention))
}

function renderChip(s: Shown) {
  const body = (
    <>
      {s.status ? <Dot s={s.status} p={s.progress} className="size-3 self-center" /> : null}
      <span className="max-w-56 truncate phone:max-w-40">
        <span className="font-medium">{s.text}</span>
        {s.sub ? <span className="text-fg2"> · {short(s.sub, 22)}</span> : null}
        {s.where ? <span className="opacity-70"> · {s.where}</span> : null}
      </span>
    </>
  )
  if (!s.open)
    return (
      <span data-mention="gone" className={clsx(CHIP, GONE)}>
        {body}
      </span>
    )
  const open = s.open
  return (
    <button
      type="button"
      data-mention="open"
      aria-label={openOf(s)}
      onClick={(e) => {
        e.stopPropagation()
        if (open.kind === 'space') goPlace(open.id)
        else openTask(open.id)
      }}
      className={clsx(CHIP, OPEN)}
    >
      {body}
    </button>
  )
}

/** the person's words, each mention among them as a chip */
export function Mentions({ text }: { text: string }) {
  if (!hasMention(text)) return <>{text}</>
  return (
    <>
      {split(text).map((p, i) => ('text' in p ? <Fragment key={i}>{p.text}</Fragment> : <Chip key={i} mention={p.mention} />))}
    </>
  )
}

/** a mention as an element for an agent's reply, which is drawn from markdown (markdown.tsx) */
export function chipFor(snap: Snapshot | null | undefined, mention: Mention): HTMLElement {
  const s = shown(snap, mention)
  const el = document.createElement(s.open ? 'button' : 'span')
  el.className = `${CHIP} ${s.open ? OPEN : GONE}`
  if (s.open) {
    el.setAttribute('type', 'button')
    el.setAttribute('data-mention', 'open')
    el.setAttribute(s.open.kind === 'space' ? 'data-open-space' : 'data-open-task', s.open.id)
    el.setAttribute('aria-label', openOf(s))
  } else el.setAttribute('data-mention', 'gone')
  if (s.status) {
    const dot = document.createElement('span')
    dot.className = `dot ${s.status} size-3 self-center`
    if (s.status === 'work' && s.progress !== undefined) dot.style.setProperty('--p', `${Math.max(4, s.progress)}%`)
    dot.setAttribute('role', 'img')
    dot.setAttribute('aria-label', STATUS_WORD[s.status])
    el.append(dot)
  }
  const words = document.createElement('span')
  words.className = 'max-w-56 truncate phone:max-w-40'
  const main = document.createElement('span')
  main.className = 'font-medium'
  main.textContent = s.text
  words.append(main)
  if (s.sub) {
    const sub = document.createElement('span')
    sub.className = 'text-fg2'
    sub.textContent = ` · ${short(s.sub, 22)}`
    words.append(sub)
  }
  if (s.where) {
    const where = document.createElement('span')
    where.className = 'opacity-70'
    where.textContent = ` · ${s.where}`
    words.append(where)
  }
  el.append(words)
  return el
}

/** what each mention in a message draws now, as one string: a reply is drawn again only when it changes (markdown.tsx) */
export function mentionKey(snap: Snapshot | null | undefined, text: string): string {
  if (!hasMention(text)) return ''
  return split(text)
    .flatMap((p) => ('text' in p ? [] : [shown(snap, p.mention)]))
    .map((s) => `${s.text}|${s.sub ?? ''}|${s.where ?? ''}|${s.status ?? ''}|${s.progress ?? ''}|${s.open?.id ?? ''}`)
    .join(' ')
}
