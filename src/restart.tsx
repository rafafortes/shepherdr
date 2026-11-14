// Restart picks for either chat role, used once or saved for its space. Opened from the + or ⋯ menu.
import clsx from 'clsx'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Place, RestartCli, RestartInfo, RestartRoom } from '@shared/types.ts'
import { NO_PICKS, orderByPicks, type Picks } from '@shared/picks.ts'
import { act, setUI, taskOf, useSnap, useStore } from './kernel.ts'
import { Dialog } from './rowmenu.tsx'
import { Pick, shown, Switch, TextValue, type Note } from './Settings.tsx'
import { EffortIcon, ic, MenuItem, ModelIcon, ModeIcon, PlayIcon, Primary, RestartIcon, UpDownIcon } from './ui.tsx'

/* ---------- the sheet ---------- */

/** start: a task that waits, on the worker picked here for it alone (no saving for the others): started now, or (later)
 *  only its worker set, the task staying in line */
type Opening = { chat: string; name: string; current?: boolean; start?: 'now' | 'later' }
let opening: Opening | null = null
const listeners = new Set<() => void>()
const subscribe = (f: () => void) => (listeners.add(f), () => void listeners.delete(f))

/** open the restart sheet for a coordinator (chat: its place id) or a task's agent (ID/Agent); name: what it is called */
export function openRestart(chat: string, name: string, current = false, start?: 'now' | 'later') {
  opening = { chat, name, current, start }
  listeners.forEach((f) => f())
}

const close = () => {
  opening = null
  listeners.forEach((f) => f())
}

/** the sheet, while one is open: each anew, its picks fresh */
export function RestartSheet() {
  const o = useSyncExternalStore(subscribe, () => opening)
  return o ? <Sheet key={o.chat} chat={o.chat} name={o.name} current={o.current} start={o.start} /> : null
}

/** "Restart agent" in a ⋯ menu */
export function RestartItem({ chat, name, onPick }: { chat: string; name: string; onPick?: () => void }) {
  return (
    <MenuItem
      icon={<RestartIcon className={ic} />}
      onClick={() => {
        onPick?.()
        openRestart(chat, name)
      }}
    >
      Restart agent…
    </MenuItem>
  )
}

/** "Start now" and "Start now with…" in a waiting task's ⋯ menu: first in line, past the machine's load (within its
 *  slots); the second on a worker picked for this task alone */
export function StartNowItems({ chat, name, onPick }: { chat: string; name: string; onPick?: () => void }) {
  return (
    <>
      <MenuItem
        icon={<PlayIcon className={ic} />}
        onClick={() => {
          onPick?.()
          void act({ type: 'start-now', chat }).catch(() => undefined)
        }}
      >
        Start now
      </MenuItem>
      <MenuItem
        icon={<PlayIcon className={ic} />}
        onClick={() => {
          onPick?.()
          openRestart(chat, name, false, 'now')
        }}
      >
        Start now with…
      </MenuItem>
      <MenuItem
        icon={<ModeIcon className={ic} />}
        onClick={() => {
          onPick?.()
          openRestart(chat, name, false, 'later')
        }}
      >
        Start with…
      </MenuItem>
    </>
  )
}

const DEFAULT = 'default'

/** a CLI's model choices by name, and the levels the one picked takes */
const modelsOf = (c?: RestartCli) => c?.models ?? []
const levelsOf = (c: RestartCli | undefined, model?: string) => (model ? modelsOf(c).find((m) => m.id === model)?.efforts : undefined) ?? c?.efforts ?? []

/** a model's room under Settings → Limits as its row in a list says it: faint and marked when one more can't start there */
const noteOf = (r?: RestartRoom): Note | undefined => (r?.short ? { words: r.short, ...(r.state !== 'room' ? { off: true } : {}), ...(r.warn ? { warn: true } : {}) } : undefined)

/** what the pick does when its model has no room now, by what the sheet does: a restart is refused while it is full or
 *  blocked (the server's own check); a start now takes the first backup with room, or waits first in line; a start later
 *  meets the limits again when its turn comes */
function roomNext(r: RestartRoom, start?: 'now' | 'later'): string {
  if (r.state === 'room') return ''
  if (start === 'later') return r.state === 'blocked' ? ' It never starts on it while it is blocked: its backups may.' : ' When its turn comes, the limits decide again.'
  if (start) return r.state === 'blocked' ? ' It starts on a backup with room, never on this one.' : r.state === 'out' ? ' It starts on a backup with room, or waits until its provider is back.' : ' It starts on a backup with room, or waits first in line for a free slot.'
  return r.state === 'out' ? ' It may stop again at once.' : r.state === 'blocked' ? ' It can’t restart on it: pick another model, or change the limit in Settings → Limits.' : ' It can’t restart on it until a slot frees up: pick one with room.'
}

function Sheet({ chat, name, current, start }: Opening) {
  const [info, setInfo] = useState<RestartInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [save, setSave] = useState(false)
  // each CLI's pinned and recent models as the server has them, updated as one is pinned here
  const [picks, setPicks] = useState<Record<string, Picks>>({})
  useEffect(() => {
    act({ type: 'restart-info', chat })
      .then((r: { ok?: boolean; error?: string; info?: RestartInfo; waiting?: boolean }) => {
        if (!r.info) return setError(r.waiting ? 'Its machine is out of reach: restart it once it is back.' : r.error || 'It could not be restarted.')
        setInfo(r.info)
        // started now: what this task would run on (its own, else Settings'); a restart: what Settings say, or what it runs on
        const pick = current || start ? r.info.on : r.info.want
        setKind(pick.kind)
        setModel(pick.model ?? '')
        setEffort(pick.effort ?? '')
        setPicks(Object.fromEntries(r.info.clis.map((c) => [c.kind, { pinned: c.pinned ?? [], recent: c.recent ?? [] }])))
      })
      .catch((e: Error) => setError(e.message))
  }, [chat, current])
  const cli = info?.clis.find((c) => c.kind === kind)
  // the room of what is picked now: its model's, or its CLI's own default's
  const room = model ? cli?.models?.find((m) => m.id === model)?.room : cli?.room
  // a restart where the limits hold it is refused: never offered
  const held = !start && (room?.state === 'full' || room?.state === 'blocked')
  const levels = levelsOf(cli, model)
  const unavailable = !!(model && cli?.models?.length && !cli.models.some((m) => m.id === model))
  const pickKind = (k: string) => {
    const c = info?.clis.find((x) => x.kind === k)
    setKind(k)
    // a model of the CLI it was on means nothing to another; a level stays where the new one takes it
    setModel(k === info?.want.kind ? (info.want.model ?? '') : '')
    if (!levelsOf(c, k === info?.want.kind ? info.want.model : undefined).includes(effort)) setEffort('')
  }
  const pickModel = (id: string) => {
    setModel(id)
    if (!levelsOf(cli, id).includes(effort)) setEffort('')
  }
  const go = async () => {
    setBusy(true)
    setError(null)
    const r = await act(start === 'later' ? { type: 'start-with', chat, kind, model, effort } : start ? { type: 'start-now', chat, kind, model, effort } : { type: 'restart', chat, kind, model, effort, save }).catch((e: Error) => ({ ok: false, error: e.message }))
    setBusy(false)
    if (r.ok === false) return setError(r.error || 'It could not be restarted.')
    close()
  }
  const task = chat.includes('/')
  const other = !!info && kind !== info.on.kind
  const changed = !!info && (kind !== info.want.kind || model !== (info.want.model ?? '') || effort !== (info.want.effort ?? ''))
  const label = (id: string) => (id ? (modelsOf(cli).find((m) => m.id === id)?.label ?? id) : DEFAULT)
  // the model list: pinned first, then the recent ones, then the CLI's own order, each under its heading
  const pickedHere = picks[kind] ?? NO_PICKS
  const ordered = orderByPicks(modelsOf(cli), pickedHere)
  const heading = (l: string) => {
    if (!cli || l === DEFAULT) return undefined
    const id = cli.models?.find((m) => m.label === l)?.id
    if (!id) return undefined
    if (pickedHere.pinned.includes(id)) return 'Pinned'
    if (pickedHere.recent.includes(id)) return 'Recent'
    return pickedHere.pinned.length || pickedHere.recent.length ? 'All models' : undefined
  }
  const pin = async (l: string) => {
    const id = cli?.models?.find((m) => m.label === l)?.id
    if (!cli || !id) return
    // the chat names whose machine keeps the picks: another machine's agent pins on its own; the state asked for is
    // sent, so a tap on a stale list or a retry cannot unpin what it meant to pin
    const on = !pickedHere.pinned.includes(id)
    const r = await act({ type: 'model-pin', chat, kind: cli.kind, model: id, on }).catch(() => null)
    if (r?.ok) setPicks((p) => ({ ...p, [cli.kind]: { pinned: r.pinned ?? [], recent: r.recent ?? [] } }))
  }
  return (
    <Dialog
      title={start === 'later' ? `Start ${name} with?` : start ? `Start ${name} now?` : task ? `Restart ${name} agent?` : 'Restart coordinator?'}
      onCancel={close}
      buttons={
        <Primary autoFocus disabled={!info || busy || unavailable || held} onClick={go}>
          {start === 'later' ? (busy ? 'Saving…' : 'Save') : start ? (busy ? 'Starting…' : 'Start now') : busy ? 'Restarting…' : 'Restart'}
        </Primary>
      }
    >
      {info ? (
        <div data-restart className="flex flex-col gap-4">
          <div className="flex flex-col gap-2.5 text-fg">
            <Line label="Agent">
              <Pick label="Agent" value={cli?.name ?? kind} options={info.clis.map((c) => c.name)} note={(n) => noteOf(info.clis.find((c) => c.name === n)?.room)} onPick={(n) => pickKind(info.clis.find((c) => c.name === n)!.kind)} />
            </Line>
            <Line label="Model">
              {cli?.models ? (
                cli.models.length ? (
                  <Pick
                    label="Model"
                    value={label(model)}
                    options={[DEFAULT, ...ordered.map((m) => m.label)]}
                    ordered
                    // found by its name or its id: a provider's prefix is not in the name
                    match={(l) => `${l} ${cli.models?.find((m) => m.label === l)?.id ?? ''}`}
                    section={heading}
                    // each one's room under Settings → Limits now; Default's is its CLI's own default model's
                    note={(l) => noteOf(l === DEFAULT ? cli.room : cli.models?.find((m) => m.label === l)?.room)}
                    // only a model takes a pin: Default is the CLI's own choice
                    pin={{ pinned: ordered.filter((m) => pickedHere.pinned.includes(m.id)).map((m) => m.label), toggle: pin, skip: (l) => !cli.models?.some((m) => m.label === l) }}
                    onPick={(l) => pickModel(cli.models!.find((m) => m.label === l)?.id ?? '')}
                  />
                ) : (
                  <TextValue label="Model" value={model || DEFAULT} onEdit={() => undefined} onSave={(v) => pickModel(v.trim() === DEFAULT ? '' : v.trim())} />
                )
              ) : <span className="text-fg3">Default</span>}
            </Line>
            {cli?.models && levels.length ? (
              <Line label="Effort">
                <Pick label="Effort" value={effort || DEFAULT} options={[DEFAULT, ...levels]} ordered onPick={(v) => setEffort(v === DEFAULT ? '' : v)} />
              </Line>
            ) : <Line label="Effort"><span className="text-fg3">Default</span></Line>}
            {unavailable ? <p className="text-need-fg">{model} is unavailable. Choose Default or an available model before restarting.</p> : null}
            {room?.words ? (
              <p data-room={room.state} className={clsx('text-sm', room.state === 'room' && !room.warn ? 'text-fg3' : 'text-need-fg')}>
                {room.words}
                {roomNext(room, start)}
                {room.quota ? ` Quota: ${room.quota}.` : null}
              </p>
            ) : null}
            {!start && (changed || save) ? (
              <Line label={saveWords(info)}>
                <Switch label={saveWords(info)} on={save} onChange={setSave} />
              </Line>
            ) : null}
          </div>
          {start === 'later' ? (
            <p className="text-sm text-fg3">Only this task's agent runs on it, when its turn comes; it stays in line as it is. Its reviewer and backups stay as Settings say.</p>
          ) : start ? (
            <p className="text-sm text-fg3">Only this task's agent runs on it; its reviewer and backups stay as Settings say. It no longer waits for the tasks it was queued after, and goes ahead of the machine's load, within its slots.</p>
          ) : other ? <p className="text-sm text-fg3">{cli?.name ?? shown(kind)} starts a new session with this chat{task ? ', the brief and branch' : ''}.</p> : null}
          {error ? <p className="text-need-fg">{error}</p> : null}
        </div>
      ) : (
        <p className={clsx(error && 'text-need-fg')}>{error ?? 'Reading what it runs on…'}</p>
      )}
    </Dialog>
  )
}

/** "Save as nas's setting", for its role's agents there from now on */
const saveWords = (i: RestartInfo) => `Use for future ${i.role === 'task' ? 'task agents' : 'coordinators'} ${i.space ? `in ${i.space === '~' ? 'the home space' : i.space}` : 'on this machine'}`

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3">
      <span className="min-w-0">{label}</span>
      {children}
    </div>
  )
}

/** Kept for plugin imports. The + menu replaces the old Settings mismatch banner. */
export function RestartHint(_props: { chatKey: string; cli: string }) {
  return null
}

/**
 * "Restart 3 coordinators" in this machine's ⋯ menu in the places list: `shepherdr restart --all`, one action and one
 * answer in the row itself, its label carrying how many it will touch. Nothing to do (no coordinator's Settings moved)
 * and it is not there at all, unless it is answering. It touches no task's agent and no other machine's place, which
 * the server says in what it answers.
 */
export function RestartAllItem() {
  const snap = useSnap()!
  const [said, setSaid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // the ones whose Settings moved away from what they run on: the very places the command restarts, this machine's own
  const count = snap.places.filter((p) => p.machine === snap.host && p.restart).length
  const run = async () => {
    setBusy(true)
    try {
      const r = (await act({ type: 'restart-all' })) as { ok?: boolean; error?: string; restarted?: number; failed?: number; failures?: string[] }
      if (!r.ok || r.error) setSaid(r.error ?? 'It could not restart them.')
      else if (!r.restarted && !r.failed) setSaid('Nothing new in their Settings')
      else setSaid(`Restarted ${r.restarted ?? 0}${r.failed ? `, ${r.failed} failed: ${(r.failures ?? []).join(', ')}` : ''}`)
    } catch (e) {
      setSaid((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (!count && !said && !busy) return null
  const answer = busy ? 'Restarting…' : said
  const label = answer ?? (count ? `Restart ${count} coordinator${count === 1 ? '' : 's'}` : 'Restart coordinators')
  return (
    <MenuItem icon={<RestartIcon className={ic} />} disabled={busy} onClick={run}>
      {label}
    </MenuItem>
  )
}

/* ---------- in the ⋯ menus ---------- */

/** a coordinator chat's top-right menu (placeMenu) */
export function PlaceRestartItem({ place }: { place: Place }) {
  return <RestartItem chat={place.chat} name={place.name} onPick={() => setUI({ menu: false })} />
}

/** Compact launch controls inside the composer + menu, shared by both chat roles. */
export function AgentControls({ chatKey, cli }: { chatKey: string; cli: string }) {
  const agent = useStore((s) => s.chats[chatKey]?.agent)
  const model = agent?.runtime?.modelLabel ?? agent?.runtime?.model ?? 'Not reported'
  const level = agent?.runtime?.effort
  const effort = agent?.runtime?.effortUnsupported ? 'Not supported' : level ? (level === 'xhigh' ? 'Extra high' : level.charAt(0).toUpperCase() + level.slice(1)) : 'Not reported'
  const open = () => {
    setUI({ plus: null })
    openRestart(chatKey, chatKey.includes('/') ? chatKey.split('/')[0] : 'this space', true)
  }
  return <div data-agent-controls>
    {([['Agent', agent ? cli : `${cli} · unknown`, ModeIcon], ['Model', model, ModelIcon], ['Effort', effort, EffortIcon]] as const).map(([label, value, Icon]) =>
      <MenuItem key={label} icon={<Icon className={ic} />} aria-label={`${label}: ${value}. Select and restart`} onClick={open}>
        <span className="flex min-w-0 items-center justify-between gap-4">
          <span>{label}</span>
          <span className="flex min-w-0 items-center gap-1 text-fg2"><span className="truncate">{value}</span><UpDownIcon className={`${ic} shrink-0`} /></span>
        </span>
      </MenuItem>)}
  </div>
}
