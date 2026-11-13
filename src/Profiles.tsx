// Settings → Models: the profiles bar above the table. It names the profile the settings match (Custom when none does),
// and its menu applies one (a preview first, with what would hold it back), saves the current settings as a new one,
// undoes the last apply, and renames or deletes one. profiles.ts keeps the rules; the server answers each step. An apply
// or an undo asks about the waiting tasks it reaches once per kind and place, as a table cell's change does.
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { waitingKind } from '@shared/apply-waiting.ts'
import type { ProfileChange, ProfilePreview, ProfileRefusal, ProfileSummary, ProfilesView } from '@shared/types.ts'
import { act, useSnap } from './kernel.ts'
import { askWaitingMany } from './apply-waiting.tsx'
import { Anchored } from './anchored.tsx'
import { Dialog } from './rowmenu.tsx'
import { Ghost, Menu, MenuItem, MenuLabel, MenuSeparator, Primary, Small, field } from './ui.tsx'

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

export function ProfilesBar({ phone }: { phone: boolean }) {
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
      {open?.kind === 'preview' ? <PreviewDialog name={open.name} onClose={close} onNote={setNote} /> : null}
      {open?.kind === 'save' ? <SaveDialog onClose={close} onNote={setNote} /> : null}
      {open?.kind === 'undo' && undo ? <UndoDialog name={undo.name} label={undo.label} onClose={close} onNote={setNote} /> : null}
      {open?.kind === 'manage' ? <ManageDialog onClose={close} onNote={setNote} /> : null}
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
function SaveDialog({ onClose, onNote }: { onClose: () => void; onNote: (s: string) => void }) {
  const [name, setName] = useState('')
  const [limits, setLimits] = useState(false)
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

/** Manage profiles: rename one, or delete it (its saved values go; the undo points that name it stay until they are used) */
function ManageDialog({ onClose, onNote }: { onClose: () => void; onNote: (s: string) => void }) {
  const [list, setList] = useState<ProfileSummary[]>([])
  const [edit, setEdit] = useState<{ name: string; mode: 'rename' | 'delete'; to: string } | null>(null)
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
  return (
    <Dialog title="Manage profiles" cancel="Done" onCancel={onClose} buttons={null}>
      <ul className="flex flex-col gap-3">
        {list.map((p) => (
          <li key={p.name} className="flex flex-col gap-1.5">
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
                <Small className="min-w-0 flex-1 text-pretty">{`Delete ${p.name}? Its saved values go; the undo points that name it stay until they are used.`}</Small>
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
          </li>
        ))}
      </ul>
      {error ? <Refused text={error} /> : null}
    </Dialog>
  )
}
