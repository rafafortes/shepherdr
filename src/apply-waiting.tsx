// After a change of a task's agent in Settings (task.agent, task.model, task.effort): "Apply to the tasks already
// created?". It asks only when a waiting task would change (a dry run first, so nothing moves until yes), and "Only new
// tasks" leaves them as they are. Running tasks keep their agent whichever answer.
import { useState, useSyncExternalStore } from 'react'
import { act } from './kernel.ts'
import { Dialog } from './rowmenu.tsx'
import { Primary } from './ui.tsx'

/** the Settings keys of a task's agent */
const KEYS = ['task.agent', 'task.model', 'task.effort']

/** what a change would do to the tasks already waiting, as the server counts it (apply-to-waiting) */
export interface Waiting {
  /** waiting tasks that take the new agent */
  changed: number
  /** waiting tasks already on it */
  same: number
  /** waiting tasks that start on Settings at their turn anyway */
  follow: number
  /** of the changed, those a task add gave a worker of their own */
  pinned: number
  /** tasks already started, which keep their agent */
  running: number
  /** spaces of this machine that keep their own setting */
  kept: string[]
  /** the spaces whose waiting tasks change, with the worker they take in words */
  spaces: { name: string; words: string; changed: number }[]
}

interface Ask {
  key: string
  place?: string
  waiting: Waiting
}

let asking: Ask | null = null
const listeners = new Set<() => void>()
const subscribe = (f: () => void) => {
  listeners.add(f)
  return () => {
    listeners.delete(f)
  }
}
const tell = () => listeners.forEach((f) => f())

/** after a saved change of a task's agent: ask, if any waiting task would change (no question otherwise) */
export async function askWaiting(key: string, place?: string) {
  if (!KEYS.includes(key)) return
  const r = (await act({ type: 'apply-to-waiting', key, place, dry: true }).catch(() => null)) as (Waiting & { ok?: boolean }) | null
  if (!r?.ok || !r.changed) return
  asking = { key, place, waiting: r }
  tell()
}

/** the question, while one is asked */
export function ApplyWaitingSheet() {
  const a = useSyncExternalStore(subscribe, () => asking)
  return a ? <Question key={`${a.key}|${a.place ?? ''}|${a.waiting.changed}`} ask={a} /> : null
}

const tasks = (n: number) => `${n} waiting ${n === 1 ? 'task' : 'tasks'}`

/** the sentences the question says, from what the change would do */
export function waitingWords(w: Waiting) {
  const n = w.changed
  const one = w.spaces.length === 1
  const start = one
    ? `${tasks(n)} of ${w.spaces[0].name} (queued, To do, scheduled) ${n === 1 ? 'starts' : 'start'} on ${w.spaces[0].words} when ${n === 1 ? 'its' : 'their'} turn comes.`
    : `${tasks(n)} in ${w.spaces.length} spaces (queued, To do, scheduled) start on what Settings name for each one when their turn comes: ${w.spaces.map((s) => `${s.name} on ${s.words}`).join('; ')}.`
  return [
    start,
    'Running tasks keep their agent.',
    w.pinned ? `${w.pinned} of them ${w.pinned === 1 ? 'was' : 'were'} given ${w.pinned === 1 ? 'its' : 'their'} own worker when added, and ${w.pinned === 1 ? 'changes' : 'change'} too.` : '',
    w.kept.length ? `${w.kept.join(', ')} ${w.kept.length === 1 ? 'keeps' : 'keep'} its own setting.` : '',
  ].filter(Boolean)
}

function Question({ ask }: { ask: Ask }) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const n = ask.waiting.changed
  const close = () => {
    asking = null
    tell()
  }
  const apply = async () => {
    setBusy(true)
    setFailed(null)
    const r = (await act({ type: 'apply-to-waiting', key: ask.key, place: ask.place }).catch((e: Error) => ({ ok: false, error: e.message }))) as Partial<Waiting> & { ok?: boolean; error?: string }
    setBusy(false)
    if (!r.ok) return setFailed(r.error || 'It could not be applied.')
    const same = r.same ?? 0
    const follow = r.follow ?? 0
    setDone(
      [`Applied to ${tasks(r.changed ?? 0)}.`, same ? `${same} ${same === 1 ? 'was' : 'were'} already on it.` : '', follow ? `${follow} start${follow === 1 ? 's' : ''} on Settings at ${follow === 1 ? 'its' : 'their'} turn anyway.` : ''].filter(Boolean).join(' '),
    )
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
          {waitingWords(ask.waiting).map((x) => (
            <p key={x}>{x}</p>
          ))}
          {failed ? <p className="text-need-fg">{failed}</p> : null}
        </div>
      )}
    </Dialog>
  )
}
