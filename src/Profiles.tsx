// Settings → Models: the profiles bar above the table. It names the profile the settings match (Custom when none does),
// and its menu applies one (a preview first, with what would hold it back), saves the current settings as a new one,
// undoes the last apply, and renames or deletes one. profiles.ts keeps the rules; the server answers each step. An apply
// or an undo asks about the waiting tasks it reaches once per kind and place, as a table cell's change does.
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { waitingKind } from '@shared/apply-waiting.ts'
import type { ProfileChange, ProfilePreview, ProfileRefusal, ProfileScheduleRow, ProfileSummary, ProfilesView } from '@shared/types.ts'
import { act, useSnap } from './kernel.ts'
import { askWaitingMany } from './apply-waiting.tsx'
import { Anchored, OnTop } from './anchored.tsx'
import { Dialog } from './rowmenu.tsx'
import { Ghost, Menu, MenuItem, MenuLabel, MenuSeparator, Primary, Small, Tab, Tabs, field } from './ui.tsx'

/** a time in words on the screen: just now, 5 min ago, 2 h ago, 3 d ago */
function since(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}
const shown = (v: string | null) => v ?? 'not set'
const holds = (p: ProfileSummary) => (p.limits ? 'Models and Limits' : 'Models')
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** a profile's changes, grouped by the level they are at */
function groupsOf(changes: ProfileChange[]) {
  const out = new Map<string, { where: string; rows: ProfileChange[] }>()
  for (const c of changes) out.set(c.place, { where: c.where, rows: [...(out.get(c.place)?.rows ?? []), c] })
  return [...out.values()]
}

/** the waiting tasks a change reaches: the questions it asks (the server counts each place once per kind) */
const waitingOf = (changes: ProfileChange[]) => changes.filter((c) => waitingKind(c.key)).map((c) => ({ key: c.key, place: c.place }))

/** a refusal, under the controls it came from: said once, as a status a screen reader hears */
function Refused({ text }: { text: string }) {
  return (
    <Small role="status" className="text-pretty text-need-fg!">
      {text}
    </Small>
  )
}

/** the dialogs of the bar, one at a time */
type Open = { kind: 'preview'; name: string } | { kind: 'save' } | { kind: 'undo' } | { kind: 'manage' } | null

export function ProfilesBar({ phone, limits = false }: { phone: boolean; limits?: boolean }) {
  const snap = useSnap()
  const [view, setView] = useState<ProfilesView | null>(null)
  const [menu, setMenu] = useState(false)
  const [open, setOpen] = useState<Open>(null)
  // what the last change said, under the bar
  const [note, setNote] = useState('')
  // every change of Settings is a new snapshot: the bar reads again
  useEffect(() => {
    let live = true
    act({ type: 'profiles' })
      .then((r) => live && setView(r as ProfilesView))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [snap])
  if (!view) return null
  if (view.unavailable)
    return (
      <section aria-label="Profiles">
        <Small className="text-pretty">{view.unavailable}</Small>
      </section>
    )
  const { last, undo } = view
  const matched = last && last.name === view.active
  const status = matched ? `Applied ${since(last.at)}` : view.active === 'Custom' && last ? `Changed since ${last.name} was applied` : view.profiles.length ? '' : 'Save the settings as a profile to switch them in one step.'
  const close = () => setOpen(null)
  const pick = (next: Open) => {
    setMenu(false)
    setOpen(next)
  }
  return (
    <section aria-label="Profiles" className={clsx('flex flex-wrap items-center gap-x-3 gap-y-2', phone ? 'px-1' : '')}>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-baseline gap-2">
          <Small>Profile</Small>
          <span className="truncate font-medium text-fg">{view.active}</span>
        </div>
        {status ? <Small className="truncate">{status}</Small> : null}
        {view.next ? <Small className="text-pretty">{view.next}</Small> : null}
      </div>
      <span className="relative inline-flex">
        <Ghost aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          Profiles
        </Ghost>
        {menu ? (
          <Anchored end>
            <Menu label="Profiles" onClose={() => setMenu(false)} className="min-w-64 text-left">
              {view.profiles.length ? (
                <>
                  <MenuLabel>Apply</MenuLabel>
                  {view.profiles.map((p) => (
                    <MenuItem key={p.name} hint={`${holds(p)} · ${p.applied ? `applied ${since(p.applied)}` : 'not applied yet'}`} onClick={() => pick({ kind: 'preview', name: p.name })}>
                      {`Apply ${p.name}…`}
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                </>
              ) : null}
              <MenuItem onClick={() => pick({ kind: 'save' })}>Save current as…</MenuItem>
              {undo ? (
                <MenuItem hint={undo.label} onClick={() => pick({ kind: 'undo' })}>
                  Undo last apply
                </MenuItem>
              ) : null}
              {view.profiles.length ? <MenuItem onClick={() => pick({ kind: 'manage' })}>Manage profiles…</MenuItem> : null}
            </Menu>
          </Anchored>
        ) : null}
      </span>
      {note ? <Small role="status" className="w-full text-pretty">{note}</Small> : null}
      <OnTop>
        {open?.kind === 'preview' ? <PreviewDialog name={open.name} onClose={close} onNote={setNote} /> : null}
        {open?.kind === 'save' ? <SaveDialog onClose={close} onNote={setNote} limits={limits} /> : null}
        {open?.kind === 'undo' && undo ? <UndoDialog name={undo.name} label={undo.label} onClose={close} onNote={setNote} /> : null}
        {open?.kind === 'manage' ? <ManageDialog onClose={close} onNote={setNote} /> : null}
      </OnTop>
    </section>
  )
}

/** Apply …?: what it would change, grouped by level, with what would hold it back and what it leaves out. Apply is off
 *  while a value is refused: nothing is written then, and the dialog says which */
function PreviewDialog({ name, onClose, onNote }: { name: string; onClose: () => void; onNote: (s: string) => void }) {
  const [p, setP] = useState<ProfilePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    act({ type: 'profile-preview', name })
      .then((r) => live && setP(r as ProfilePreview))
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [name])
  const n = p?.changes.length ?? 0
  const refused: ProfileRefusal[] = p?.refused ?? []
  const apply = async () => {
    setBusy(true)
    setError('')
    const r = (await act({ type: 'profile-apply', name }).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok: boolean; error?: string; changes?: ProfileChange[]; refused?: ProfileRefusal[] }
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? "That didn't apply.")
      if (r.refused) setP((x) => x && { ...x, refused: r.refused! })
      return
    }
    const changes = r.changes ?? []
    onNote(`Applied ${name}: ${plural(changes.length, 'setting')} changed. Undo last apply puts them back.`)
    onClose()
    void askWaitingMany(waitingOf(changes))
  }
  return (
    <Dialog
      title={`Apply ${name}?`}
      onCancel={onClose}
      buttons={
        <Primary autoFocus disabled={busy || !p || n === 0 || refused.length > 0} onClick={apply}>
          {busy ? 'Applying…' : n ? `Apply ${plural(n, 'change')}` : 'Apply'}
        </Primary>
      }
    >
      {!p ? (
        <p>{error || 'Working out what it changes…'}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {n ? (
            groupsOf(p.changes).map((g) => (
              <div key={g.where} className="flex flex-col gap-1">
                <h4 className="font-medium text-fg">{g.where}</h4>
                <ul className="flex flex-col gap-0.5 text-[0.8125rem]">
                  {g.rows.map((c) => (
                    <li key={`${c.place}|${c.key}`} className="text-pretty">
                      {c.label}: <span className="text-fg2">{shown(c.now)}</span> → <span className="text-fg">{shown(c.then)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <p>The settings read as {name} says already: nothing to change.</p>
          )}
          {p.skipped.length ? <Small className="text-pretty">Skipped, no longer a space: {p.skipped.join(', ')}. Its saved values are left out.</Small> : null}
          {p.added.length ? <Small className="text-pretty">Left as it is, added since the save: {p.added.join(', ')}.</Small> : null}
          {refused.length ? (
            <div className="flex flex-col gap-1">
              <Refused text="Nothing is applied while a value is refused:" />
              <ul className="flex flex-col gap-0.5 text-[0.8125rem]">
                {refused.map((x) => (
                  <li key={`${x.place}|${x.key}`} className="text-pretty">
                    {x.where} · {x.label}: {x.error}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {error && p.changes.length ? <Refused text={error} /> : null}
        </div>
      )}
    </Dialog>
  )
}

/** Save current as…: the models, and the limits when asked. A name that is saved already asks first, and replaces it */
function SaveDialog({ onClose, onNote, limits: withLimits }: { onClose: () => void; onNote: (s: string) => void; limits: boolean }) {
  const [name, setName] = useState('')
  const [limits, setLimits] = useState(withLimits)
  const [taken, setTaken] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (force: boolean) => {
    setBusy(true)
    setError('')
    const r = (await act({ type: 'profile-save', name, limits, force }).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok: boolean; exists?: boolean; error?: string }
    setBusy(false)
    if (r.ok) {
      onNote(`Saved ${name.trim()}${limits ? ', the models and the limits' : ', the models'}.`)
      return onClose()
    }
    setTaken(!!r.exists)
    setError(r.error ?? "That didn't save.")
  }
  const typed = name.trim()
  return (
    <Dialog
      title="Save the current settings as a profile"
      onCancel={onClose}
      buttons={
        taken ? (
          <Primary autoFocus disabled={busy} onClick={() => save(true)}>
            {`Replace ${typed}`}
          </Primary>
        ) : (
          <Primary autoFocus disabled={busy || !typed} onClick={() => save(false)}>
            {busy ? 'Saving…' : 'Save'}
          </Primary>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-fg2">Name</span>
          <input
            className={clsx('h-9 rounded-full px-3 text-fg', field)}
            value={name}
            maxLength={40}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setName(e.target.value)
              setTaken(false)
              setError('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && typed && !taken) void save(false)
            }}
          />
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={limits} onChange={() => setLimits(!limits)} className="mt-1" />
          <span>Also Max tasks and Merge train (the limits), not only the models</span>
        </label>
        <Small className="text-pretty">Every role's CLI, model and effort, backups included, is kept at Everywhere, this machine and each space, as it is now.</Small>
        {error ? <Refused text={error} /> : null}
      </div>
    </Dialog>
  )
}

/** Undo the last apply: puts back what it changed, where it still reads as it left it; the answer names what it left */
function UndoDialog({ name, label, onClose, onNote }: { name: string; label: string; onClose: () => void; onNote: (s: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const undo = async () => {
    setBusy(true)
    setError('')
    const r = (await act({ type: 'profile-undo' }).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok: boolean; error?: string; changes?: ProfileChange[]; kept?: string[] }
    setBusy(false)
    if (!r.ok) return setError(r.error ?? "That didn't undo.")
    const changes = r.changes ?? []
    const kept = r.kept ?? []
    onNote(`Undone: ${name}'s apply put back ${plural(changes.length, 'setting')}.${kept.length ? ` Left as they are, changed since: ${kept.join(', ')}.` : ''}`)
    onClose()
    void askWaitingMany(waitingOf(changes))
  }
  return (
    <Dialog title="Undo the last apply?" onCancel={onClose} buttons={<Primary autoFocus disabled={busy} onClick={undo}>{busy ? 'Undoing…' : 'Undo'}</Primary>}>
      <div className="flex flex-col gap-2">
        <p className="text-pretty">{`Puts back what the apply of ${name} changed, where it still reads as that apply left it. A setting changed since is left as it is.`}</p>
        <Small>{label}</Small>
        {error ? <Refused text={error} /> : null}
      </div>
    </Dialog>
  )
}

/** the days a schedule runs on, as the editor offers them: every day, weekdays, weekends, or the days picked (0 is Monday) */
type Days = 'every' | 'weekdays' | 'weekends' | 'some'
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const sameDays = (a: number[] | null, b: number[] | null) => (a === null || b === null ? a === b : a.length === b.length && a.every((x, i) => x === b[i]))
/** the rule the editor writes: one time a day, every day or on the days picked (time rules, trigger.ts, read it back) */
export function ruleWritten(time: string, days: number[] | null) {
  const [h, m] = time.split(':').map(Number)
  const by = days?.length ? `BYDAY=${days.map((d) => DAY_CODES[d]).join(',')};` : ''
  return `FREQ=${by ? 'WEEKLY' : 'DAILY'};${by}BYHOUR=${h};BYMINUTE=${m}`
}
/** a schedule's days as the editor shows them: from its own shape, or every day for one the editor does not write */
function shapeOf(row?: ProfileScheduleRow): { days: Days; picked: number[]; time: string } {
  const f = row?.form
  if (!f) return { days: 'every', picked: [], time: '22:00' }
  if (f.days === null) return { days: 'every', picked: [], time: f.time }
  if (sameDays(f.days, [0, 1, 2, 3, 4])) return { days: 'weekdays', picked: f.days, time: f.time }
  if (sameDays(f.days, [5, 6])) return { days: 'weekends', picked: f.days, time: f.time }
  return { days: 'some', picked: f.days, time: f.time }
}
const DAYS_LABEL: Record<Days, string> = { every: 'Every day', weekdays: 'Weekdays', weekends: 'Weekends', some: 'Some days' }

/** a schedule's line: its words, whether it waits for the tasks and is on, and its next and last run */
function scheduleText(s: ProfileScheduleRow) {
  return `${s.words}${s.waiting ? ' · also the waiting tasks' : ''}${s.on ? '' : ' · off'}`
}

/** one schedule's editor, for a new one (no row) or a change: the days, the time, waiting tasks and on. Saved through the
 *  server, which refuses a rule it cannot read and says why; a change that keeps the rule keeps its next time */
function ScheduleForm({ name, row, onNote, onDone, onCancel }: { name: string; row?: ProfileScheduleRow; onNote: (s: string) => void; onDone: () => void; onCancel: () => void }) {
  const start = shapeOf(row)
  const [days, setDays] = useState<Days>(start.days)
  const [picked, setPicked] = useState<number[]>(start.picked)
  const [time, setTime] = useState(start.time)
  const [waiting, setWaiting] = useState(row?.waiting ?? false)
  const [on, setOn] = useState(row?.on ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const chosen = days === 'some' ? picked : days === 'every' ? null : days === 'weekdays' ? [0, 1, 2, 3, 4] : [5, 6]
  const kept = !!row?.form && row.form.time === time && sameDays(row.form.days, chosen)
  const words = `${days === 'some' ? (picked.length ? [...picked].sort((a, b) => a - b).map((d) => DAY_NAMES[d]).join(', ') : 'Some days') : DAYS_LABEL[days]} at ${time || '—'}${waiting ? ' · also the waiting tasks' : ''}`
  const toggleDay = (d: number) => setPicked(picked.includes(d) ? picked.filter((x) => x !== d) : [...picked, d])
  const save = async () => {
    if (!time) return setError('Give the time, like 22:00.')
    if (days === 'some' && !picked.length) return setError('Pick the days it applies on.')
    setBusy(true)
    setError('')
    const body = { type: 'profile-schedule' as const, name, ...(row ? { id: row.id } : {}), ...(row && kept ? {} : { rule: ruleWritten(time, chosen) }), waiting, on }
    const r = (await act(body).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok: boolean; error?: string }
    setBusy(false)
    if (!r.ok) return setError(r.error ?? "That didn't save.")
    onNote(`Saved the schedule of ${name}: ${words}.`)
    onDone()
  }
  return (
    <form
      aria-label={row ? `Change a schedule of ${name}` : `Add a schedule to ${name}`}
      className="flex flex-col gap-3 rounded-box p-3 shadow-[inset_0_0_0_1px_var(--line2)]"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <Tabs label="Days" className="flex-wrap">
        {(['every', 'weekdays', 'weekends', 'some'] as Days[]).map((d) => (
          <Tab key={d} on={days === d} onClick={() => setDays(d)}>
            {DAYS_LABEL[d]}
          </Tab>
        ))}
      </Tabs>
      {days === 'some' ? (
        <div role="group" aria-label="Days of the week" className="flex flex-wrap gap-1.5">
          {DAY_NAMES.map((d, i) => (
            <button
              key={d}
              type="button"
              aria-pressed={picked.includes(i)}
              onClick={() => toggleDay(i)}
              className="press-dim h-8 min-w-11 rounded-full px-2 text-[0.8125rem] text-fg2 shadow-[inset_0_0_0_1px_var(--line2)] aria-pressed:bg-fg aria-pressed:text-bg coarse:h-10 phone:h-10 phone:text-[0.875rem]"
            >
              {d}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <label className="flex flex-wrap items-center gap-2">
          <span className="text-fg2">At</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={clsx('h-9 rounded-full px-3 text-fg', field)} />
        </label>
        <Small>In the time zone of Settings.</Small>
      </div>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={waiting} onChange={() => setWaiting(!waiting)} className="mt-1" />
        <span>Also the waiting tasks: they take the profile's task and reviewer settings too, with no question</span>
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={on} onChange={() => setOn(!on)} />
        <span>On</span>
      </label>
      <Small className="text-pretty">{words}</Small>
      {error ? <Refused text={error} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Primary type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Primary>
        <Ghost onClick={onCancel}>Cancel</Ghost>
      </div>
    </form>
  )
}

/** Manage profiles: rename one, or delete it (its saved values go; the undo points that name it stay until they are used),
 *  and its schedules: each one in words, with its next and last run, changed, switched on or off, or removed */
function ManageDialog({ onClose, onNote }: { onClose: () => void; onNote: (s: string) => void }) {
  const [list, setList] = useState<ProfileSummary[]>([])
  const [edit, setEdit] = useState<{ name: string; mode: 'rename' | 'delete'; to: string } | null>(null)
  // a schedule's editor: of a profile, and which one (none: a new one)
  const [form, setForm] = useState<{ name: string; id?: string } | null>(null)
  // a schedule waiting for its removal to be confirmed
  const [gone, setGone] = useState<{ name: string; id: string } | null>(null)
  const [error, setError] = useState('')
  const reload = () =>
    act({ type: 'profiles' })
      .then((r) => setList((r as ProfilesView).profiles))
      .catch(() => undefined)
  useEffect(() => {
    void reload()
  }, [])
  const change = async (body: { type: 'profile-rename'; name: string; to: string } | { type: 'profile-delete'; name: string }) => {
    setError('')
    const r = (await act(body).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok: boolean; error?: string }
    if (!r.ok) return setError(r.error ?? "That didn't change.")
    onNote(body.type === 'profile-rename' ? `${body.name} is called ${body.to} now.` : `Deleted ${body.name}.`)
    setEdit(null)
    void reload()
  }
  /** a schedule's editor is done: closed, and the list reads again */
  const done = () => {
    setForm(null)
    void reload()
  }
  /** a schedule switched on or off, or removed: the server answers, then the list reads again */
  const scheduleChange = async (body: { type: 'profile-schedule'; name: string; id: string; on: boolean } | { type: 'profile-schedule-remove'; name: string; id: string }) => {
    setError('')
    const r = (await act(body).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok: boolean; error?: string }
    if (!r.ok) return setError(r.error ?? "That didn't change.")
    onNote(body.type === 'profile-schedule-remove' ? `Removed a schedule of ${body.name}.` : `${body.name}'s schedule is ${body.on ? 'on' : 'off'} now.`)
    setGone(null)
    void reload()
  }
  return (
    <Dialog title="Manage profiles" cancel="Done" onCancel={onClose} buttons={null}>
      <ul className="flex flex-col gap-4">
        {list.map((p) => {
          const editing = form?.name === p.name
          return (
            <li key={p.name} className="flex flex-col gap-2">
              {edit?.name === p.name && edit.mode === 'rename' ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void change({ type: 'profile-rename', name: p.name, to: edit.to })
                  }}
                >
                  <input aria-label={`New name for ${p.name}`} className={clsx('h-9 min-w-0 flex-1 rounded-full px-3 text-fg', field)} value={edit.to} maxLength={40} autoFocus onChange={(e) => setEdit({ ...edit, to: e.target.value })} />
                  <Primary type="submit" disabled={!edit.to.trim()}>
                    Rename
                  </Primary>
                  <Ghost onClick={() => setEdit(null)}>Cancel</Ghost>
                </form>
              ) : edit?.name === p.name && edit.mode === 'delete' ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Small className="min-w-0 flex-1 text-pretty">{`Delete ${p.name}? Its saved values and its schedules go; the undo points that name it stay until they are used.`}</Small>
                  <Ghost onClick={() => setEdit(null)}>Cancel</Ghost>
                  <Primary onClick={() => change({ type: 'profile-delete', name: p.name })}>Delete</Primary>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium text-fg">{p.name}</span>
                    <Small>{`${holds(p)} · saved ${since(p.saved)}${p.applied ? ` · applied ${since(p.applied)}` : ''}`}</Small>
                  </div>
                  <Ghost onClick={() => setEdit({ name: p.name, mode: 'rename', to: p.name })}>Rename</Ghost>
                  <Ghost onClick={() => setEdit({ name: p.name, mode: 'delete', to: p.name })}>Delete</Ghost>
                </div>
              )}
              {/* its schedules: each one, then the editor of one, or the button that adds one */}
              {(p.schedules ?? []).map((s) =>
                editing && form?.id === s.id ? (
                  <ScheduleForm key={s.id} name={p.name} row={s} onNote={onNote} onDone={done} onCancel={() => setForm(null)} />
                ) : gone?.name === p.name && gone.id === s.id ? (
                  <div key={s.id} role="group" aria-label="Remove this schedule?" className="flex flex-wrap items-center gap-2 pl-3">
                    <Small className="min-w-0 flex-1 text-pretty">{`Remove ${s.words}? The profile stays.`}</Small>
                    <Ghost onClick={() => setGone(null)}>Cancel</Ghost>
                    <Primary onClick={() => scheduleChange({ type: 'profile-schedule-remove', name: p.name, id: s.id })}>Remove</Primary>
                  </div>
                ) : (
                  <div key={s.id} className="flex flex-wrap items-center gap-2 pl-3">
                    <div className="flex min-w-48 flex-1 flex-col">
                      <span className={clsx('text-pretty', s.on ? 'text-fg' : 'text-fg2')}>{scheduleText(s)}</span>
                      <Small className="text-pretty">{[s.on && s.next ? `Next ${s.next}` : '', s.last ?? ''].filter(Boolean).join(' · ')}</Small>
                    </div>
                    <Ghost onClick={() => setForm({ name: p.name, id: s.id })}>Change</Ghost>
                    <Ghost onClick={() => scheduleChange({ type: 'profile-schedule', name: p.name, id: s.id, on: !s.on })}>{s.on ? 'Turn off' : 'Turn on'}</Ghost>
                    <Ghost onClick={() => setGone({ name: p.name, id: s.id })}>Remove</Ghost>
                  </div>
                ),
              )}
              {editing && !form?.id ? (
                <div className="pl-3">
                  <ScheduleForm name={p.name} onNote={onNote} onDone={done} onCancel={() => setForm(null)} />
                </div>
              ) : editing ? null : (
                <div className="pl-3">
                  <Ghost onClick={() => setForm({ name: p.name })}>Add a schedule…</Ghost>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {error ? <Refused text={error} /> : null}
    </Dialog>
  )
}
