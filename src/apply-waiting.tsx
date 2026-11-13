// After a change of a task's agent (task.agent, task.model, task.effort) or of its reviewer in Settings (reviewer.*):
// "Apply to the tasks already created?". It asks only when a waiting task would change (a dry run first, so nothing
// moves until yes), and "Only new tasks" leaves them as they are. Running tasks keep their agent and reviewer whichever
// answer. The advisor's keys never ask: they apply at once already.
import { useState, useSyncExternalStore } from 'react'
import { waitingKind, type WaitingKind } from '@shared/apply-waiting.ts'
import { act } from './kernel.ts'
import { Dialog } from './rowmenu.tsx'
import { Primary } from './ui.tsx'

/** what a change would do to the tasks already waiting, as the server counts it (apply-to-waiting) */
export interface Waiting {
  /** waiting tasks that take the new agent, or the new reviewer */
  changed: number
  /** waiting tasks already on it */
  same: number
  /** waiting tasks that start on Settings at their turn anyway */
  follow: number
  /** of the changed, those a task add gave a worker (or a reviewer) of their own */
  pinned: number
  /** tasks already started, which keep their agent (their reviewer) */
  running: number
  /** spaces of this machine that keep their own setting */
  kept: string[]
  /** the spaces whose waiting tasks change, with the worker (reviewer) they take in words */
  spaces: { name: string; words: string; changed: number }[]
}

/** one question: the kind of change (the task agent's or the reviewer's), and the places it reaches, each with a key
 *  of that kind (the one that moved first there) */
interface Ask {
  kind: WaitingKind
  picks: { key: string; place?: string }[]
  waiting: Waiting
}

let asking: Ask | null = null
/** questions that wait behind the one shown (a bulk change asks one per kind) */
let queued: Ask[] = []
const listeners = new Set<() => void>()
const subscribe = (f: () => void) => {
  listeners.add(f)
  return () => {
    listeners.delete(f)
  }
}
const tell = () => listeners.forEach((f) => f())

/** after a saved change of a task's agent or reviewer: ask, if any waiting task would change (no question otherwise) */
export async function askWaiting(key: string, place?: string) {
  await askWaitingMany([{ key, place }])
}

/** after several saved changes (a bulk one, or a copy to several spaces): one question per kind, counting each place
 *  once and adding the places up, so a question about many spaces is asked once */
export async function askWaitingMany(changes: { key: string; place?: string }[]) {
  const picks = new Map<WaitingKind, { key: string; place?: string }[]>()
  for (const c of changes) {
    const kind = waitingKind(c.key)
    if (!kind) continue
    const list = picks.get(kind) ?? []
    if (!list.some((x) => x.place === c.place)) list.push(c)
    picks.set(kind, list)
  }
  for (const [kind, list] of picks) {
    const replies = await Promise.all(list.map((p) => act({ type: 'apply-to-waiting', key: p.key, place: p.place, dry: true }).catch(() => null)))
    const hit = list.filter((_, i) => (replies[i] as (Waiting & { ok?: boolean }) | null)?.ok && (replies[i] as Waiting).changed)
    if (!hit.length) continue
    const waiting = sumWaiting(replies.filter((r): r is Waiting & { ok?: boolean } => !!r?.ok && !!r.changed))
    const ask: Ask = { kind, picks: hit, waiting }
    if (asking) queued.push(ask)
    else asking = ask
  }
  tell()
}

/** the counts of several answers, added up */
export function sumWaiting(rs: Partial<Waiting>[]): Waiting {
  const total = (k: 'changed' | 'same' | 'follow' | 'pinned' | 'running') => rs.reduce((n, r) => n + (r[k] ?? 0), 0)
  return {
    changed: total('changed'),
    same: total('same'),
    follow: total('follow'),
    pinned: total('pinned'),
    running: total('running'),
    kept: [...new Set(rs.flatMap((r) => r.kept ?? []))],
    spaces: rs.flatMap((r) => r.spaces ?? []),
  }
}

/** the question, while one is asked */
export function ApplyWaitingSheet() {
  const a = useSyncExternalStore(subscribe, () => asking)
  return a ? <Question key={`${a.kind}|${a.picks.map((p) => `${p.place ?? ''}`).join(',')}|${a.waiting.changed}`} ask={a} /> : null
}

const tasks = (n: number) => `${n} waiting ${n === 1 ? 'task' : 'tasks'}`

/** the sentences the question says, from what the change would do: for a task agent, the CLI a waiting task starts on;
 *  for the reviewer, the one its brief names */
export function waitingWords(w: Waiting, kind: WaitingKind = 'agent') {
  const n = w.changed
  const reviewer = kind === 'reviewer'
  const [verb, by] = reviewer ? [n === 1 ? 'is reviewed' : 'are reviewed', 'by'] : [n === 1 ? 'starts' : 'start', 'on']
  const start =
    w.spaces.length === 1
      ? `${tasks(n)} of ${w.spaces[0].name} (queued, To do, scheduled) ${verb} ${by} ${w.spaces[0].words} when ${n === 1 ? 'its' : 'their'} turn comes.`
      : `${tasks(n)} in ${w.spaces.length} spaces (queued, To do, scheduled) ${verb} ${by} what Settings name for each one when ${n === 1 ? 'its' : 'their'} turn comes: ${w.spaces.map((s) => `${s.name} ${by} ${s.words}`).join('; ')}.`
  return [
    start,
    reviewer ? 'Running tasks keep their reviewer.' : 'Running tasks keep their agent.',
    w.pinned ? `${w.pinned} of them ${w.pinned === 1 ? 'was' : 'were'} given ${w.pinned === 1 ? 'its' : 'their'} own ${reviewer ? 'reviewer' : 'worker'} when added, and ${w.pinned === 1 ? 'changes' : 'change'} too.` : '',
    w.kept.length ? `${w.kept.join(', ')} ${w.kept.length === 1 ? 'keeps' : 'keep'} its own setting.` : '',
  ].filter(Boolean)
}

/** what the answer did, in the words of the question */
function doneWords(r: Partial<Waiting>, kind: WaitingKind) {
  const same = r.same ?? 0
  const follow = r.follow ?? 0
  const reviewer = kind === 'reviewer'
  const changed = r.changed ?? 0
  const followed = reviewer
    ? `${follow} ${follow === 1 ? 'takes' : 'take'} Settings' reviewer at ${follow === 1 ? 'its' : 'their'} turn anyway.`
    : `${follow} start${follow === 1 ? 's' : ''} on Settings at ${follow === 1 ? 'its' : 'their'} turn anyway.`
  return [
    reviewer ? `Reviewer applied to ${tasks(changed)}.` : `Applied to ${tasks(changed)}.`,
    same ? `${same} ${same === 1 ? 'was' : 'were'} already on it.` : '',
    follow ? followed : '',
  ]
    .filter(Boolean)
    .join(' ')
}

function Question({ ask }: { ask: Ask }) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const n = ask.waiting.changed
  const kind = ask.kind
  // the next question waiting behind this one, if any, takes its place
  const close = () => {
    asking = queued.shift() ?? null
    tell()
  }
  const apply = async () => {
    setBusy(true)
    setFailed(null)
    const replies = await Promise.all(ask.picks.map((p) => act({ type: 'apply-to-waiting', key: p.key, place: p.place }).catch((e: Error) => ({ ok: false, error: e.message })))) as (Partial<Waiting> & { ok?: boolean; error?: string })[]
    setBusy(false)
    const bad = replies.find((r) => !r.ok)
    if (bad) return setFailed(bad.error || 'It could not be applied.')
    setDone(doneWords(sumWaiting(replies), kind))
  }
  return (
    <Dialog
      title="Apply to the tasks already created?"
      cancel={done ? 'Done' : 'Only new tasks'}
      onCancel={close}
      buttons={
        done ? null : (
          <Primary autoFocus disabled={busy} onClick={apply}>
            {busy ? 'Applying…' : `Apply to ${n} ${n === 1 ? 'task' : 'tasks'}`}
          </Primary>
        )
      }
    >
      {done ? (
        <p>{done}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {waitingWords(ask.waiting, kind).map((x) => (
            <p key={x}>{x}</p>
          ))}
          {failed ? <p className="text-need-fg">{failed}</p> : null}
        </div>
      )}
    </Dialog>
  )
}
