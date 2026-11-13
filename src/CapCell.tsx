// The most agents at once per provider or per model (models.maxAtOnce), in Settings → Models → Summary: each provider and
// model row says how many of its agents run now and its cap ("2 of 4 at once", "2 at once · no cap"), and a cell opens an
// editor that sets or clears that row's entry at this machine, Everywhere, or one space. A space that sets its own
// sub-limit for the row shows it under the row ("lyvora-app: 1 of 2 at once"), and its line opens the editor at that space.
// The writes are the setting's own text: the entries of the chosen level, with this one changed, so a machine's value keeps
// what Everywhere sets for the others.
import { useState } from 'react'
import { act } from './kernel.ts'
import { atOnceWords, levelText, MAX_CAP, parseMaxAtOnce, spaceCapWords, withEntry, type MaxEntry } from '../shared/model-caps.ts'
import type { SummaryAtOnce, SummarySpaceText } from '../shared/types.ts'
import { Pop } from './cell-pop.tsx'
import { Ghost, Primary, Small } from './ui.tsx'

/** the setting these cells write */
export const CAP_KEY = 'models.maxAtOnce'

/** the setting's own text at each level ('' where a level sets none), this machine's place a write goes to, and each
 *  space's own text with its place */
export interface CapsText {
  all: string
  machine: string
  place: string
  spaces: SummarySpaceText[]
}

/** the entries a level's text holds, none when it is unreadable (the server refused it, so nothing of it is kept) */
const entriesOf = (text: string): MaxEntry[] => {
  const p = parseMaxAtOnce(text)
  return p.ok ? p.entries : []
}

/** the id of a row's cell, and of one space's sub-limit line under it: the summary's open cell (cap|<row>, cap|<row>|<space>) */
export const capId = (pattern: string, space?: string) => (space === undefined ? `cap|${pattern}` : `cap|${pattern}|${space}`)

/** the cell of one row: its words, the sub-limits of its spaces under them, and the editor under them when it is open (a
 *  phone: under the line, the same controls) */
export { atOnceWords }

export function CapCell({ name, pattern: raw, atOnce, caps, phone, openId, onOpen }: { name: string; pattern: string; atOnce: SummaryAtOnce; caps: CapsText; phone: boolean; openId: string | null; onOpen: (id: string | null) => void }) {
  // a cap's pattern is lowercase, as its text holds it: a model id with capitals (Qwen3.8-27B) is capped by its lowercase
  const pattern = raw.toLowerCase()
  const id = capId(pattern)
  const w = atOnceWords(atOnce)
  const open = openId === id
  const editor = <CapEditor name={name} pattern={pattern} caps={caps} phone={phone} onClose={() => onOpen(null)} />
  return (
    <span className="relative block min-w-0">
      <button type="button" data-cell={id} aria-haspopup={phone ? undefined : 'dialog'} aria-expanded={open} aria-label={`${name}: ${w.words}`} title={w.title} onClick={() => onOpen(open ? null : id)} className="press-dim block max-w-full truncate rounded-row px-1.5 py-0.5 text-left tabular-nums hover:bg-hover aria-expanded:bg-sel">
        {w.words}
      </button>
      {open ? phone ? <div className="pt-1">{editor}</div> : <Pop onClose={() => onOpen(null)}>{editor}</Pop> : null}
      {(atOnce.spaces ?? []).map((s) => (
        <SpaceCap key={s.key} name={name} pattern={pattern} space={s} caps={caps} phone={phone} openId={openId} onOpen={onOpen} />
      ))}
    </span>
  )
}

/** one space's sub-limit under a row: its line, which opens the editor with that space chosen */
function SpaceCap({ name, pattern, space, caps, phone, openId, onOpen }: { name: string; pattern: string; space: NonNullable<SummaryAtOnce['spaces']>[number]; caps: CapsText; phone: boolean; openId: string | null; onOpen: (id: string | null) => void }) {
  const id = capId(pattern, space.key)
  const open = openId === id
  const words = spaceCapWords(space)
  const editor = <CapEditor name={name} pattern={pattern} caps={caps} phone={phone} space={space.key} onClose={() => onOpen(null)} />
  return (
    <span className="relative mt-0.5 block min-w-0">
      <button type="button" data-cell={id} aria-haspopup={phone ? undefined : 'dialog'} aria-expanded={open} aria-label={`${name} in ${words}`} title={`Set by ${space.name}: ${pattern}=${space.max}. Click to change it.`} onClick={() => onOpen(open ? null : id)} className="press-dim block max-w-full truncate rounded-row px-1.5 py-0.5 pl-3 text-left text-fg2 tabular-nums hover:bg-hover aria-expanded:bg-sel">
        {words}
      </button>
      {open ? phone ? <div className="pt-1">{editor}</div> : <Pop onClose={() => onOpen(null)}>{editor}</Pop> : null}
    </span>
  )
}

/** the editor of one cap: a number (1 to 200) at this machine, Everywhere, or one space (`space`: the one it opens for,
 *  else the first space), saved, or cleared at that level */
export function CapEditor({ name, pattern, caps, phone, space, onClose }: { name: string; pattern: string; caps: CapsText; phone: boolean; space?: string; onClose: () => void }) {
  const spaces = caps.spaces
  const [scope, setScope] = useState<'machine' | 'all' | 'space'>(space === undefined ? 'machine' : 'space')
  const [spaceKey, setSpaceKey] = useState(space ?? spaces[0]?.key ?? '')
  const shown = spaces.find((s) => s.key === spaceKey)
  const textOf = (level: 'all' | 'machine' | 'space') => (level === 'all' ? caps.all : level === 'machine' ? caps.machine : (shown?.text ?? ''))
  const own = (level: 'all' | 'machine' | 'space') => entriesOf(textOf(level)).find((e) => e.pattern === pattern)?.max
  const [draft, setDraft] = useState(String(own(scope) ?? (scope === 'space' ? undefined : own('all')) ?? ''))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // a write starts from the level's OWN entries (levelText): this machine's from Everywhere's while it sets none, a space's
  // from its own text only, so a change of one entry keeps the others as they are and copies nothing into a space
  const base = (level: 'all' | 'machine' | 'space') => levelText(level, { all: caps.all, machine: caps.machine, space: textOf('space') })
  const here = own(scope)
  const inherited = scope === 'machine' && here === undefined ? own('all') : scope === 'space' && here === undefined ? (own('machine') ?? own('all')) : undefined
  const above = scope === 'space' ? 'This machine' : 'Everywhere'
  const write = async (clear: boolean) => {
    let max: number | undefined
    if (!clear) {
      const n = Number(draft)
      if (!Number.isInteger(n) || n < 1 || n > MAX_CAP) {
        setError(`Write a whole number from 1 to ${MAX_CAP}, or clear the cap.`)
        return
      }
      max = n
    }
    // nothing left at this level: its value goes back to what the level above gives, never to "off" (which would hold it)
    const text = withEntry(base(scope), pattern, max)
    const place = scope === 'all' ? 'all' : scope === 'machine' ? caps.place : (shown?.place ?? caps.place)
    setBusy(true)
    setError('')
    const r = (await act({ type: 'setting', key: CAP_KEY, value: text || null, place }).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok?: boolean; error?: string }
    setBusy(false)
    if (r?.ok) onClose()
    else setError(r?.error ?? "That didn't go through.")
  }
  return (
    <div aria-label={`Most ${name} at once`} className={phone ? 'flex flex-col gap-2 pb-2' : 'flex w-72 flex-col gap-2 text-left'}>
      <Small className="text-pretty font-medium">Most {name} at once</Small>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="sr-only">Where it is set</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name={`cap-scope-${pattern}`} checked={scope === 'machine'} onChange={() => setScope('machine')} />
          This machine
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={`cap-scope-${pattern}`} checked={scope === 'all'} onChange={() => setScope('all')} />
          Everywhere
        </label>
        {spaces.length ? (
          <label className="flex items-center gap-2">
            <input type="radio" name={`cap-scope-${pattern}`} checked={scope === 'space'} onChange={() => setScope('space')} />
            This space
            {scope === 'space' ? (
              <select aria-label="Which space" value={spaceKey} onChange={(e) => setSpaceKey(e.target.value)} className="min-w-0 truncate rounded-row bg-bg px-1.5 py-0.5 text-[0.8125rem] shadow-[inset_0_0_0_1px_var(--line2)] outline-none focus:shadow-box-focus dark:bg-bubble">
                {spaces.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : null}
          </label>
        ) : null}
      </fieldset>
      <label className="flex items-center justify-between gap-3">
        <span className="text-fg2">At once</span>
        <input
          type="number"
          min={1}
          max={MAX_CAP}
          step={1}
          inputMode="numeric"
          aria-label={`Most ${name} at once, ${scope === 'all' ? 'Everywhere' : scope === 'space' ? `in ${shown?.name ?? 'this space'}` : 'this machine'}`}
          placeholder="no cap"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-24 rounded-row bg-bg px-2 py-1 text-right tabular-nums shadow-[inset_0_0_0_1px_var(--line2)] outline-none focus:shadow-box-focus dark:bg-bubble"
        />
      </label>
      {inherited !== undefined ? <Small className="text-pretty">{above} sets {inherited} here. Saving makes this {scope === 'space' ? 'space' : 'machine'}'s own value.</Small> : null}
      {error ? (
        <Small role="status" className="text-pretty text-need-fg!">
          {error}
        </Small>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {here !== undefined ? (
          <Ghost onClick={() => void write(true)} disabled={busy} className="text-accent">
            Clear here
          </Ghost>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Ghost onClick={onClose}>Cancel</Ghost>
          <Primary disabled={busy || draft.trim() === '' || (scope === 'space' && !shown)} onClick={() => void write(false)}>
            {busy ? 'Saving…' : 'Save'}
          </Primary>
        </div>
      </div>
    </div>
  )
}
