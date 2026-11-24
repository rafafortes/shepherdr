// The pieces Settings shares with the pages it loads on demand (Models, Limits and the tables under them). The shell
// owns them and the pages import them from here, never from Settings itself: no page holds the shell, and the shell
// reaches a page only through React.lazy, so the first-load chunk keeps no page body.

import { machineName, type SettingRow, type SettingSection, type Snapshot } from '@shared/types.ts'
import clsx from 'clsx'
import { type ComponentType, type FC, lazy, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getState, registry, setUI, type UI } from './kernel.ts'
import { LimitChoice } from './LimitChoice.tsx'
import type { Appearance } from './theme.ts'
import {
  AppearanceIcon,
  AutopilotIcon,
  BellIcon,
  ChatIcon,
  CheckIcon,
  ClockIcon,
  CogIcon,
  DownIcon,
  Ghost,
  GlobeIcon,
  ic,
  KeyIcon,
  MachineIcon,
  Menu,
  MenuItem,
  MinusIcon,
  ModelIcon,
  PinIcon,
  PlanIcon,
  PluginIcon,
  PlusIcon,
  Small,
  Tab,
  Tabs,
  TasksIcon,
  TextBox,
  UpDownIcon,
} from './ui.tsx'

/** the two heavy page bodies, brought in only when their page is opened */
export const ModelsPage = lazy(() => import('./ModelsPage.tsx'))
export const LimitsPage = lazy(() => import('./LimitsPage.tsx'))

/** a setting's word as the screen says it: "Off", "On its own", "2 rounds"; a name like claude-haiku-5-5 as it is */
export const shown = (v: string) => (v === 'xhigh' ? 'Extra high' : /^[a-z][a-z ,]*$/.test(v) ? v.charAt(0).toUpperCase() + v.slice(1) : v)

/** a setting's value and the menu of its choices; plain, as a phone's grouped rows have it (the value and ⌃⌄, no box) */
/** a few words at the end of a choice's row (Pick's note) */
export interface Note {
  words: string
  off?: boolean
  warn?: boolean
}

export function Pick({
  value,
  options,
  onPick,
  label,
  plain,
  show = shown,
  match,
  depth,
  icon,
  ordered,
  section,
  pin,
  note,
  left,
  className,
}: {
  value: string
  options: string[]
  onPick: (v: string) => void
  label: string
  plain?: boolean
  /** its words for a value */
  show?: (v: string) => string
  /** what it can be found by, where that is more than its words (a model's id as well as its name) */
  match?: (v: string) => string
  /** a mark before a value's words, in the picker and its menu (a place's icon) */
  icon?: (v: string) => ReactNode
  /** a tree: how deep each choice sits, and its own short name there (a project's, under its machine) */
  depth?: (v: string) => { depth: number; name: string }
  /** the choices in their own order (else the one picked first) */
  ordered?: boolean
  /** the group a choice belongs to: its heading is drawn above the first of each in turn (Pinned, Recent) */
  section?: (v: string) => string | undefined
  /** pin a choice to the top of the list, or unpin it: a mark on its row (a model's); skip: a choice with none (the
   *  CLI's own default, which is no model) */
  pin?: { pinned: string[]; toggle: (v: string) => void; skip?: (v: string) => boolean }
  /** a few words at the end of a choice's row (a model's room under the limits: "1 of 2", "Full 2 of 2"); off: the choice
   *  can't take one more now (its words and its name faint and marked); warn: a mark without fainting it */
  note?: (v: string) => Note | undefined
  /** its menu opens from its left edge */
  left?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  // a menu near the bottom of the screen opens upward, so every choice stays in view; a long one (pi's many models,
  // every place) shows ten rows and scrolls, fewer where the screen has less room (a phone on its side)
  const [up, setUp] = useState(false)
  const [tall, setTall] = useState(0)
  // any list too long to take in at a glance can be searched, as well as scrolled
  const searchable = options.length > 8
  const toggle = () => {
    const r = ref.current?.getBoundingClientRect()
    const room = roomFor(ref.current)
    const row = innerWidth < 640 || matchMedia('(pointer: coarse)').matches ? 44 : 32
    const need = (Math.min(options.length, 10) + 1) * row + 16 + (searchable ? SEARCH_H : 0)
    const below = r ? room.bottom - r.bottom - 12 : need
    const above = r ? r.top - room.top - 12 : 0
    const upward = below < need && above > below
    setUp(upward)
    setTall(Math.max(3 * row, Math.min(need, upward ? above : below)))
    setOpen(!open)
  }
  const ref = useRef<HTMLDivElement>(null)
  return (
    // plain, its ⌃⌄ sits a hair past the row's edge, lined up with the other rows' ends
    <div ref={ref} className={clsx('relative max-w-full', plain && 'left-1', className)}>
      {plain ? (
        <button
          type="button"
          aria-label={`${label}: ${show(value)}`}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={toggle}
          className="press-dim relative -my-2.5 inline-flex min-h-11 max-w-full items-center gap-1 pl-2 whitespace-nowrap text-fg2"
        >
          {icon?.(value)}
          <span className="truncate">{show(value)}</span>
          <UpDownIcon className={ic} />
        </button>
      ) : (
        <Ghost className="max-w-full pr-1.5 pl-2.5 tabular-nums" aria-label={`${label}: ${show(value)}`} aria-expanded={open} aria-haspopup="menu" onClick={toggle}>
          {icon?.(value)}
          <span className="truncate">{show(value)}</span>
          <DownIcon className={ic} />
        </Ghost>
      )}
      {open ? (
        <Choices
          value={value}
          options={options}
          show={show}
          match={match}
          depth={depth}
          icon={icon}
          ordered={ordered}
          section={section}
          pin={pin}
          note={note}
          searchable={searchable}
          left={left}
          up={up}
          tall={tall}
          onClose={() => setOpen(false)}
          onPick={(o) => {
            setOpen(false)
            if (o !== value) onPick(o)
          }}
        />
      ) : null}
    </div>
  )
}

/** the room the search box takes at the top of a long menu */
export const SEARCH_H = 44

/** where a menu may open: inside the pane it lives in (the page's content scrolls, and a list longer than that pane
 *  would otherwise draw its top under the page's header, out of reach), and inside the window */
export function roomFor(from: HTMLElement | null) {
  for (let el = from?.parentElement; el; el = el.parentElement) {
    const s = getComputedStyle(el)
    if (/(auto|scroll|hidden)/.test(`${s.overflow}${s.overflowY}`)) {
      const r = el.getBoundingClientRect()
      return { top: Math.max(0, r.top), bottom: Math.min(innerHeight, r.bottom) }
    }
  }
  return { top: 0, bottom: innerHeight } // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
}

/** a setting's choices: the shared menu, springing out of it (up, near the bottom of the screen); one too long to show
 *  whole scrolls, the one picked in view, and can be searched (a letter typed narrows it, Enter takes the first) */
export function Choices({
  value,
  options,
  up,
  tall,
  onPick,
  onClose,
  show,
  match,
  depth,
  icon,
  ordered,
  section,
  pin,
  note,
  searchable,
  left,
}: {
  value: string
  options: string[]
  up: boolean
  tall: number
  onPick: (v: string) => void
  onClose: () => void
  show: (v: string) => string
  match?: (v: string) => string
  depth?: (v: string) => { depth: number; name: string }
  icon?: (v: string) => ReactNode
  ordered?: boolean
  section?: (v: string) => string | undefined
  pin?: { pinned: string[]; toggle: (v: string) => void; skip?: (v: string) => boolean }
  note?: (v: string) => Note | undefined
  searchable: boolean
  left?: boolean
}) {
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && el.scrollHeight > el.clientHeight) el.querySelector('[aria-checked=true]')?.scrollIntoView({ block: 'center' })
  }, [])
  // with a mouse, a long list takes what you type at once; a phone's keyboard waits for a tap on the box
  useEffect(() => {
    if (searchable && matchMedia('(pointer: fine)').matches) box.current?.focus({ preventScroll: true })
  }, [searchable])
  const all = ordered ? options : [value, ...options.filter((o) => o !== value)]
  const words = query.trim().toLowerCase()
  const rows = all.filter((o) => (match?.(o) ?? show(o)).toLowerCase().includes(words))
  const search = searchable ? (
    <input
      ref={box}
      aria-label={depth ? 'Find scope or value' : 'Search'}
      placeholder={depth ? 'Find…' : 'Search…'}
      type="search"
      autoComplete="off"
      spellCheck={false}
      enterKeyHint="go"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      onKeyDown={(e) => {
        // Enter takes the first one left, never the one already set (that pick would change nothing); in an empty box it
        // takes nothing at all, so a keyboard opening the menu and pressing Enter again cannot change what is set
        const first = words ? (rows.find((r) => r !== value) ?? rows[0]) : undefined
        if (e.key === 'Enter' && first !== undefined) {
          e.preventDefault()
          onPick(first)
        }
      }}
      className="mx-2 mb-1 w-[calc(100%-1rem)] min-w-0 rounded-row bg-well px-2 py-2 outline-none phone:text-[1rem]"
    />
  ) : null
  let group: string | undefined
  return (
    <Menu
      label="Choices"
      onClose={onClose}
      className={clsx(
        'absolute z-10 min-w-full max-w-[calc(100vw-2rem)]',
        left ? 'left-0' : 'right-0',
        up ? 'bottom-full mb-1' : 'top-full mt-1',
        up ? (left ? 'origin-bottom-left' : 'origin-bottom-right') : left ? 'origin-top-left' : 'origin-top-right',
      )}
    >
      {search}
      <div ref={ref} style={{ maxHeight: Math.max(0, tall - (searchable ? SEARCH_H + 8 : 12)) }} className="overflow-y-auto overscroll-contain">
        {rows.length ? null : <p className="px-2 py-2 text-fg3">No match.</p>}
        {rows.map((o) => {
          const at = depth?.(o)
          const n = note?.(o)
          const head = section?.(o)
          const starts = !!head && head !== group
          group = head ?? group
          return (
            <div key={o}>
              {starts ? <div className="px-2 pt-2 pb-0.5 text-[0.75rem] text-fg3 coarse:text-[0.8125rem] phone:text-[0.8125rem]">{head}</div> : null}
              <div className="relative flex items-center">
                <MenuItem
                  role="menuitemradio"
                  aria-checked={o === value}
                  // named by its words alone: a note is told as its description
                  aria-label={(at && at.name !== show(o)) || n?.words ? show(o) : undefined}
                  aria-description={n?.words || undefined}
                  icon={o === value ? <CheckIcon className={ic} /> : null}
                  hint={
                    n?.words ? (
                      <span data-note={n.off ? 'off' : n.warn ? 'warn' : 'on'} className={clsx('tabular-nums', (n.off || n.warn) && 'text-need-fg')}>
                        {n.words}
                      </span>
                    ) : undefined
                  }
                  onClick={() => onPick(o)}
                  // the pin's room at the row's end, wider where it is (a phone's own padding would cover it otherwise)
                  className={pin ? 'pr-10 coarse:pr-12 phone:pr-12' : undefined}
                >
                  {/* a tree's rows step in under the one they belong to, as the sidebar's */}
                  <span style={at ? { paddingLeft: `${at.depth}rem` } : undefined} className={clsx(icon && 'flex min-w-0 items-center gap-2', n?.off && 'text-fg3')}>
                    {icon?.(o)}
                    <span className="truncate">{at ? at.name : show(o)}</span>
                  </span>
                </MenuItem>
                {pin && !pin.skip?.(o) ? (
                  // in the rows' own cycle (role menuitemcheckbox), so the arrow keys reach it and Enter or Space
                  // pins: a menu keeps its keys on its menuitem rows
                  <button
                    type="button"
                    tabIndex={-1}
                    role="menuitemcheckbox"
                    aria-checked={pin.pinned.includes(o)}
                    aria-label={`${pin.pinned.includes(o) ? 'Unpin' : 'Pin'} ${show(o)}`}
                    onClick={() => pin.toggle(o)}
                    className={clsx(
                      'absolute right-0.5 grid size-7 shrink-0 place-items-center rounded-full text-fg3 hover:text-fg coarse:size-10 phone:size-10',
                      pin.pinned.includes(o) ? 'text-fg' : 'opacity-60',
                    )}
                  >
                    <PinIcon className={ic} />
                  </button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </Menu>
  )
}

/** a number as the screen says it: "7 days", "1.5× cores", "Off" */
export const numShown = (v: string, num: NonNullable<SettingRow['num']>) =>
  v === 'off' ? 'Off' : v.replace(/^(\d+(?:\.\d+)?)(\s*).*$/, (_, n, sp) => `${n}${num.unit ? `${sp}${Number(n) === 1 && num.one ? num.one : num.unit}` : ''}`)

/** a value you type: a box as wide as its words, saved when you leave it (Enter too) */
export function TextValue({ value, onSave, onEdit, label }: { value: string; onSave: (v: string) => void; onEdit: () => void; label: string }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    // as tall and round as the pickers beside it, its edge a shade darker while you type (a text box's look)
    <span className="relative inline-flex h-7 max-w-full items-center rounded-full shadow-[inset_0_0_0_1px_var(--line2)] has-focus:shadow-box-focus coarse:h-9 phone:h-9">
      <span aria-hidden="true" className="invisible block truncate px-2.5 whitespace-pre">
        {v || ' '}
      </span>
      <input
        name={label}
        aria-label={label}
        value={v}
        onFocus={onEdit}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== value && onSave(v)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="absolute inset-0 w-full min-w-0 bg-transparent px-2.5 outline-none phone:text-[1rem]"
      />
    </span>
  )
}

/** on or off: the track grey off, green on, its knob sliding across (iOS's) */
export function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className="group relative inline-flex w-9 shrink-0 rounded-full bg-line2 p-0.5 shadow-[inset_0_0_0_1px_var(--line)] transition-colors duration-200 ease-in-out after:absolute after:-inset-2 aria-checked:bg-ready aria-checked:shadow-none coarse:w-12 phone:w-12"
    >
      <span className="aspect-square w-1/2 rounded-full bg-white shadow-xs ring-1 ring-black/5 transition-transform duration-200 ease-in-out group-aria-checked:translate-x-full" />
    </button>
  )
}

/** a few short choices side by side, the one picked raised */
export function Segments({ value, options, label, onPick, fill }: { value: string; options: string[]; label: string; onPick: (v: string) => void; fill?: boolean }) {
  return (
    <Tabs label={label} className={fill ? 'flex! w-full' : undefined}>
      {options.map((o) => (
        <Tab key={o} fill={fill} on={o === value} onClick={() => o !== value && onPick(o)}>
          {shown(o)}
        </Tab>
      ))}
    </Tabs>
  )
}

/** a stepper's − or + */
export function Step({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="press-dim relative grid size-7 shrink-0 place-items-center rounded-full bg-hover text-fg2 after:absolute after:-inset-1 enabled:hover:bg-sel enabled:hover:text-fg disabled:cursor-default disabled:opacity-40 coarse:size-9 phone:size-9"
    >
      {children}
    </button>
  )
}

/** a count or a threshold: − and + step it (↑ and ↓ too), or type any number in its range, its unit after it; one
 *  that may be off is off below its least, or left empty. Typed, it is saved when you leave it; stepped, a moment
 *  after the last step */
export function NumberValue({ value, num, onSave, onEdit, label }: { value: string; num: NonNullable<SettingRow['num']>; onSave: (v: string) => void; onEdit: () => void; label: string }) {
  const now = value === 'off' ? '' : String(Number.parseFloat(value))
  const [v, setV] = useState(now)
  useEffect(() => setV(now), [now])
  const offable = !!(num.off || num.zero)
  const later = useRef<ReturnType<typeof setTimeout>>(undefined)
  // a step still waiting is saved as the row goes (another page, Settings closed)
  const pending = useRef<() => void>(undefined)
  useEffect(() => () => pending.current?.(), [])
  const save = (t = v.trim()) => {
    clearTimeout(later.current)
    pending.current = undefined
    if (t === now) return
    if (!t && !offable) return setV(now)
    onSave(t || 'off')
  }
  const step = (by: number) => {
    onEdit() // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
    const s = num.step ?? 1 // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
    const x = Number.parseFloat(v) // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
    let next: string // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
    if (!Number.isFinite(x))
      next = by > 0 ? String(num.min) : v // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
    else {
      // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
      const to = Math.round((x + by * s) / s) * s // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
      next = to < num.min - 1e-9 ? (offable ? '' : String(num.min)) : String(+Math.min(num.max, to).toFixed(4)) // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
    } // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
    setV(next) // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
    clearTimeout(later.current) // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
    pending.current = () => save(next) // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
    later.current = setTimeout(() => save(next), 700) // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
  } // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
  const x = Number.parseFloat(v)
  const unit = v && num.unit ? (x === 1 && num.one ? num.one : num.unit) : ''
  return (
    <span className="inline-flex items-center gap-1.5">
      <Step label={`Less: ${label}`} onClick={() => step(-1)} disabled={!v || (!offable && x <= num.min)}>
        <MinusIcon className={ic} />
      </Step>
      <span className="relative inline-flex h-7 min-w-14 items-center justify-center rounded-full tabular-nums shadow-[inset_0_0_0_1px_var(--line2)] has-focus:shadow-box-focus coarse:h-9 phone:h-9">
        {/* the box is as wide as its number */}
        <span className="inline-grid">
          <span aria-hidden="true" className={clsx('invisible col-start-1 row-start-1 pl-2.5 whitespace-pre', !unit && 'pr-2.5')}>
            {v || (offable ? 'Off' : ' ')}
          </span>
          <input
            type="text"
            inputMode="decimal"
            name={label}
            aria-label={num.unit ? `${label} (${num.unit})` : label}
            value={v}
            placeholder={offable ? 'Off' : undefined}
            onFocus={onEdit}
            onChange={(e) => setV(e.target.value)}
            onBlur={() => save()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
                e.preventDefault() // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
                step(e.key === 'ArrowUp' ? 1 : -1) // coverage-exempt: exercised in layout-settings-controls.test.ts; minified browser coverage leaves this line unattributed
              }
            }}
            className={clsx('col-start-1 row-start-1 w-0 min-w-full bg-transparent pl-2.5 outline-none placeholder:text-fg2 phone:text-[1rem]', !unit && 'pr-2.5')}
          />
        </span>
        {unit ? <span className={clsx('pr-2.5 whitespace-nowrap text-fg2', !/^[×%]/.test(unit) && 'pl-1')}>{unit}</span> : null}
      </span>
      <Step label={`More: ${label}`} onClick={() => step(1)} disabled={!!v && x >= num.max}>
        <PlusIcon className={ic} />
      </Step>
    </span>
  )
}

/** a trigger (Autopilot's heartbeat, the news that wakes it): never its rule as written, but in plain words, its next
 *  runs, and a few ready-made picks side by side (none raised for one the coordinator wrote); anything else is asked of
 *  the coordinator */
export function TriggerValue({ row, phone, onPick }: { row: SettingRow & { trigger: NonNullable<SettingRow['trigger']> }; phone: boolean; onPick: (v: string) => void }) {
  const t = row.trigger
  const picked = t.presets.find((p) => p.value === row.value)?.label ?? ''
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <p className="text-pretty text-fg">{t.words}</p>
        {t.next.length ? <Small className="tabular-nums">Next: {t.next.join(' · ')}</Small> : null}
      </div>
      <Segments label={row.label} value={picked} options={t.presets.map((p) => p.label)} fill={phone} onPick={(l) => onPick(t.presets.find((p) => p.label === l)!.value)} />
      <Small className="text-pretty">{row.key === 'heartbeat.on' ? 'Other news waits for the next heartbeat. ' : ''}Ask the coordinator for anything else.</Small>
    </div>
  )
}

/** a whole file's words (a coordinator's HEARTBEAT.md): an editor as wide as the page that grows with them, its
 *  name on top; Save (⌘S, Ctrl+S) and Undo show once it changed, Undo putting back what is saved */
export function DocValue({
  value,
  onSave,
  label,
  file,
  phone,
  privateRules = false,
}: {
  value: string
  onSave: (v: string) => void
  label: string
  file: string
  phone: boolean
  privateRules?: boolean
}) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const changed = v !== value
  return (
    <div className={clsx('flex w-full flex-col', privateRules && clsx('overflow-hidden rounded-row shadow-[inset_0_0_0_1px_var(--line2)] has-focus:shadow-box-focus', phone ? 'bg-well' : 'bg-bg'))}>
      <div className={clsx('flex min-h-9 items-center gap-3 text-[0.8125rem] phone:min-h-11', privateRules && 'border-b border-line py-1 pr-1.5 pl-3')}>
        <span className={clsx('min-w-0 flex-1 text-fg2', privateRules && 'truncate font-mono text-[0.75rem]')}>{file}</span>
        {changed ? (
          <>
            <span className="text-fg3 phone:hidden">Not saved</span>
            <Ghost onClick={() => setV(value)}>Undo</Ghost>
            <Ghost onClick={() => onSave(v)} className="bg-fg text-bg! shadow-none! enabled:hover:bg-fg">
              Save
            </Ghost>
          </>
        ) : null}
      </div>
      <TextBox
        label={label}
        value={v}
        onChange={setV}
        spellCheck={false}
        placeholder={privateRules ? 'Empty: no private rules for this role' : 'Empty: nothing to go through'}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault()
            if (changed) onSave(v)
          }
        }}
        className={clsx(
          'w-full bg-transparent outline-none',
          privateRules
            ? 'min-h-24 px-3 py-2.5 font-mono text-[0.8125rem]/5 phone:text-[0.875rem]/[1.375rem]'
            : 'min-h-40 whitespace-pre-wrap wrap-anywhere text-base/6 focus-visible:rounded-row focus-visible:outline-2 focus-visible:outline-box-focus',
        )}
      />
    </div>
  )
}

/** a page of settings: one of the server's sections (set Everywhere), or this device's own (Appearance, or a plugin's
 *  drawn by its View) */
export interface Page extends SettingSection {
  targets?: Record<string, string>
  device?: boolean
  Icon?: ComponentType<{ className?: string }>
  View?: FC<{ phone: boolean }>
  /** the page reads every level at once (Models): it has no level of its own to edit or pick */
  matrix?: boolean
}
/** the Settings section of the alert command (server settings.ts): its rows show on the Notifications page */
export const ALERT_COMMAND = 'Alert command'

/** the Settings section the Models page draws its quota rows from (server settings.ts QUOTAS): not a page of its own */
export const QUOTAS = 'Quotas'
export const APPEARANCE: Page = { name: 'Appearance', device: true, about: 'How Shepherdr looks on this device. Your other devices keep their own.', rows: [] }

/** Settings → Models: every level's agent settings in one table (ModelsPage.tsx); it reads all levels at once, so it has
 *  no level of its own */
export const MODELS: Page = {
  name: 'Models',
  about:
    "Every level's agent settings in one table: each space's tasks, coordinator, reviewer and advisor, with their backups, and this machine's and Everywhere's. Click a cell to change it; drag a chain entry or use its menu to move it or insert above. A value set in that row is drawn strong, one it inherits faint with where it comes from.",
  rows: [],
  matrix: true,
  View: ModelsPage,
}

/** Settings → Limits: every limit of this machine in one place (LimitsPage.tsx), beside Models; the same settings */
export const LIMITS: Page = {
  name: 'Limits',
  about:
    "Every limit of this machine in one place: its tasks at once and when it waits, each space's Max tasks, Merge train and sub-limit per provider or model, each provider's cap and what waits now. Click a value to change it, at its level. The numbers beside a value are read now.",
  rows: [],
  matrix: true,
  View: LimitsPage,
}

export const LOOKS: Record<Appearance, { label: string; hint?: string }> = {
  system: { label: 'System', hint: "Light or dark, as this device's own setting is" },
  light: { label: 'Light' },
  dark: { label: 'Dark' },
}

export const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  'How tasks work': PlanIcon,
  'Private instructions': PlanIcon,
  Agents: ModelIcon,
  Tasks: TasksIcon,
  'Task IDs': TasksIcon,
  Autopilot: AutopilotIcon,
  'Time zone': ClockIcon,
  Machine: MachineIcon,
  Browser: GlobeIcon,
  Notify: ChatIcon,
  Notifications: BellIcon,
  Voice: ChatIcon,
  'Alerts and voice': BellIcon,
  Appearance: AppearanceIcon,
  Plugins: PluginIcon,
  Machines: MachineIcon,
  Models: ModelIcon,
  Limits: PlanIcon,
  Secrets: KeyIcon,
}

/** every level defaults are set at: Everywhere, then each machine and its spaces */
export const levelsOf = (sections: SettingSection[]) => [...new Set(sections.flatMap((x) => (x.level && !x.global ? [x.level] : [])))]

/** the level Settings edits: the one picked, else the space it was opened from's, else Everywhere */
export function levelOf(sections: SettingSection[], ui: UI) {
  const levels = levelsOf(sections)
  const want = ui.settings?.level ?? ui.place
  return levels.includes(want) ? want : 'all'
}

/** a level's name: Everywhere, a machine's, or a space's (with its machine's, where there are more machines) */
export function levelName(level: string, sections: SettingSection[], snap: Pick<Snapshot, 'places' | 'machines'> = { places: [], machines: [] }) {
  if (level === 'all') return 'Everywhere'
  const [kind, key, space] = level.split(':')
  const machine = machineName(snap.machines, key)
  if (kind === 'm') return machine
  const name = snap.places.find((p) => p.id === level)?.name ?? (space === '~' ? 'home' : space)
  const machines = new Set(levelsOf(sections).filter((l) => l.startsWith('m:')))
  return machines.size > 1 ? `${name} · ${machine}` : name
}

/** what a level's defaults are, and what it follows where it sets none */
export function levelHint(level: string, snap: Pick<Snapshot, 'places' | 'machines'>) {
  if (level === 'all') return 'For every machine and space, unless one sets its own.'
  const [kind, key, space] = level.split(':')
  const machine = machineName(snap.machines, key)
  if (kind === 'm') return `For ${machine} and its spaces. The rest follows Everywhere.`
  return `For ${snap.places.find((p) => p.id === level)?.name ?? space}. The rest follows ${machine}, then Everywhere.`
}
/** the list of pages, in groups: the defaults of the level picked (what agents are told, only words in their prompts,
 *  apart from how Shepherdr runs, with what is one for all), this device's own, and what is only shown */
export function groupsOf(sections: SettingSection[], ui: UI): { name: string; pages: Page[] }[] {
  const level = levelOf(sections, ui)
  // Present one delivery page without changing stored keys or the server/plugin section contract.
  const delivery = sections.find((x) => x.global && x.name === 'Alerts and voice')
  // the alert command is set Everywhere or for a machine: Notifications shows, at any level, the one that level reads
  // (a space's is its machine's) and writes there, so it is found where alerts are, never on a page of its own
  const commandLevel = level === 'all' ? 'all' : `m:${level.split(':')[1]}`
  const command = sections.find((x) => x.name === ALERT_COMMAND && x.level === commandLevel)
  const scoped = sections
    .filter((x) => x.level === level && !x.global && x.name !== ALERT_COMMAND)
    .map(
      (x): Page =>
        x.name === 'Notify'
          ? {
              ...x,
              name: 'Notifications',
              targets: Object.fromEntries([
                ...(delivery?.rows.filter((r) => !r.key.startsWith('voice.')) ?? []).map((r) => [r.key, delivery!.level ?? 'all']),
                ...(command?.rows ?? []).map((r) => [r.key, commandLevel]),
              ]),
              about: `All: every new coordinator message, question and alert. Needs me: questions and alerts. Off: none, and the space stays quiet. Task alerts reach you either way. Spaces can override the delivery rule here or from their sidebar menu. Device delivery below applies Everywhere.${command ? ` The alert command runs a command of yours (a Telegram notifier, say) for what waits on you, ${commandLevel === 'all' ? 'Everywhere' : 'on this machine'}.` : ''}`,
              rows: [
                ...x.rows.map((r) => ({ ...r, group: 'Delivery rules' })),
                ...(command?.rows.map((r) => ({ ...r, group: commandLevel === 'all' ? 'Alert command · Everywhere' : level === commandLevel ? 'Alert command' : 'Alert command · its machine' })) ??
                  []),
                ...(delivery?.rows.filter((r) => !r.key.startsWith('voice.')).map((r) => ({ ...r, group: 'Devices · Everywhere' })) ?? []),
              ],
            }
          : x,
    )
  const globals = sections
    .filter((x) => x.global && x.name !== QUOTAS)
    .map(
      (x): Page =>
        x === delivery
          ? {
              ...x,
              name: 'Voice',
              rows: x.rows.filter((r) => r.key.startsWith('voice.')),
            }
          : x,
    )
  const own = registry.settingsPages.filter((x) => x.when(ui)).map(({ name, about, Icon, View }): Page => ({ name, about, Icon, View, device: true, rows: [] }))
  // the Models table comes right after Agents, the settings it is the one table of
  const running = scoped.filter((x) => !x.told)
  const agents = running.findIndex((x) => x.name === 'Agents')
  const runs = agents < 0 ? [...running, MODELS, LIMITS] : [...running.slice(0, agents + 1), MODELS, LIMITS, ...running.slice(agents + 1)]
  return [
    { name: 'What agents are told', pages: scoped.filter((x) => x.told) },
    // what is one for all (alerts and voice) runs Shepherdr too, whatever level is picked: its page says so
    { name: 'How Shepherdr runs', pages: [...runs, ...globals] },
    { name: 'This device', pages: [APPEARANCE, ...own] },
    { name: 'About', pages: sections.filter((x) => !x.level && !x.global) },
  ].filter((g) => g.pages.length)
}

/** opens a page of Settings at a level (Secrets at Everywhere, say) from elsewhere on the screen. A level change changes the
 *  list of pages, and Settings keeps the page it showed by name, so the level goes first and the page is set once the list
 *  has settled (the next frame) */
export function openPage(name: string, level: string) {
  const sections = getState().snap?.settings ?? []
  const ui = getState().ui
  const at = (n: string) => Math.max(0, sectionOf(n, sections, { ...ui, settings: { section: 0, level } }))
  setUI({ settings: { section: ui.settings?.section ?? 0, level } })
  requestAnimationFrame(() => setUI({ settings: { section: at(name), level } }))
}

/** where a page sits in the list of them (for ui.settings.section), or -1 where it doesn't show */
export const sectionOf = (name: string, sections: SettingSection[], ui: UI) =>
  groupsOf(sections, ui)
    .flatMap((g) => g.pages)
    .findIndex((p) => p.name === ({ Notify: 'Notifications', [ALERT_COMMAND]: 'Notifications', 'Alerts and voice': 'Voice' }[name] ?? name))

/** a machine's own Machine page (to open Settings on it): its section and level */
export function settingsPageOf(sections: SettingSection[], machine: string, ui: UI) {
  const level = `m:${machine}`
  if (!levelsOf(sections).includes(level)) return undefined
  const i = sectionOf('Machine', sections, { ...ui, settings: { section: 0, level } })
  return i < 0 ? undefined : { section: i, level }
}

/** a page's own icon: a plugin's, or its section's */
export const iconOf = (p: Page) => p.Icon ?? ICONS[p.name] ?? CogIcon
/** a phone's rounded group of rows, a shade lighter than the page under it in dark mode, as iOS's */
export const card = 'rounded-box bg-bg dark:bg-bubble'
/** a row's look: in a phone's group its line starts where its words do, as iOS's; on a wider screen a line between rows */
export const rowLook = (phone: boolean) =>
  phone
    ? 'relative flex min-h-12 items-center justify-between gap-3 px-4 py-2.5 not-first:before:absolute not-first:before:inset-x-0 not-first:before:top-0 not-first:before:left-4 not-first:before:h-px not-first:before:bg-line'
    : 'flex min-h-12 items-center justify-between gap-3 py-2 not-first:border-t not-first:border-line'
export const heading = (phone: boolean) => (phone ? 'px-4 pb-1.5 text-[0.8125rem] text-fg2' : 'pb-1 text-[0.75rem] font-medium text-fg3')
/** a sub-block's heading (a role's Backups): the same words, flush with the rule the sub-block hangs from */
export const subHeading = (phone: boolean) => (phone ? 'pb-1.5 text-[0.8125rem] text-fg2' : 'pb-1 text-[0.75rem] font-medium text-fg3')
/** a row's control, by what its value is: on or off a switch, two or three short words segments, a number a stepper,
 *  free words a box, a list a menu; one with no other choice, or only shown,
 *  its words */
export function Control({ row, phone, set, edit }: { row: SettingRow; phone: boolean; set: (value: string) => void; edit: () => void }) {
  const options = row.options ?? []
  const action = row.key in registry.settingActions
  const only = !row.num && !row.text && !action && options.length <= 1 && (options[0] ?? row.value) === row.value
  if (row.fixed || !row.key || only) return <span className="truncate text-fg2">{shown(row.value)}</span>
  // a limit is three choices (no cap, 0, a number): a radio each, and a number is saved once it is left
  if (row.num?.limit) return <LimitChoice label={row.label} value={row.value} max={row.num.max} phone={phone} onChange={(v, final) => final && v !== '' && set(v)} />
  if (row.num) return <NumberValue label={row.label} value={row.value} num={row.num} onEdit={edit} onSave={set} />
  if (row.text) return <TextValue label={row.label} value={row.value} onEdit={edit} onSave={set} />
  // an action (alerts: turn them on for this device) is a button, its row's value the words under its label
  if (action) return <Ghost onClick={() => set(options[0])}>{options[0]}</Ghost>
  if (options.length === 2 && options.includes('on') && options.includes('off')) return <Switch label={row.label} on={row.value === 'on'} onChange={(on) => set(on ? 'on' : 'off')} />
  if (SEGMENTS.has(row.key)) return <Segments label={row.label} value={row.value} options={options} onPick={set} fill={phone} />
  return <Pick label={row.label} plain={phone} value={row.value} options={options} ordered={row.ordered} match={row.ids ? (v) => `${v} ${row.ids?.[v] ?? ''}` : undefined} onPick={set} />
}
/** the rows whose few short choices sit side by side */
export const SEGMENTS = new Set(['notify', 'review.mustFix'])

/** an editor: the controls of one cell, a reset to what the level above gives (when a key is set here), what went wrong,
 *  and what else it offers under them */
export function Editor({
  phone,
  title,
  controls,
  reset,
  error,
  onSet,
  onReset,
  footer,
}: {
  phone: boolean
  title?: string
  controls: SettingRow[]
  reset: boolean
  error?: string
  onSet: (key: string, value: string) => void
  onReset: () => void
  footer?: ReactNode
}) {
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
          {reset ? (
            <Ghost onClick={onReset} className="text-accent">
              Reset to inherited
            </Ghost>
          ) : (
            <span />
          )}
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
