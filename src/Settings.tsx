// Settings: the app's few settings. Most are defaults set at three levels, All machines, a machine or a project, and
// the most specific one set wins: how tasks work (what every new brief ends with), each kind of agent's app, model and
// effort, Autopilot's heartbeat and checklist, a machine's limits. Settings opens on the level of the place it was opened from, and a
// picker at its top switches; each row says where a value it doesn't set comes from, and one it sets can be reset.
// Alerts and voice are one for all; a task has none of its own. Appearance is each device's own, as are the pages
// plugins add (a desktop's keyboard shortcuts). A phone lists the sections in rounded groups, as iOS's Settings does, and a tap pushes one over
// the list; a wider screen keeps the list down its side.
import clsx from 'clsx'
import { Component, Fragment, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { machineName, type Place, type SettingRow, type SettingSection } from '@shared/types.ts'
import { act, registry, setUI, useSnap, useUI, type UI } from './kernel.ts'
import { usePluginErrors } from './guard.tsx'
import { PlacesToggle } from './Frame.tsx'
import { askWaiting } from './apply-waiting.tsx'
import { Stack } from './Stack.tsx'
import { APPEARANCES, setAppearance, useAppearance } from './theme.ts'
import { BackIcon, CheckIcon, Empty, Ghost, Head, IconButton, NextIcon, PhoneTop, PlaceIcon, PlusIcon, RoundButton, SecretField, Small, Who, XIcon, field, ic } from './ui.tsx'
import { APPEARANCE, Control, DocValue, LOOKS, Pick, SEGMENTS, TriggerValue, card, groupsOf, heading, iconOf, levelHint, levelName, levelsOf, levelOf, numShown, rowLook, shown, subHeading, type Page } from './settings-parts.tsx'

// the shared names keep the old import path too: main.tsx and the human's own plugins import pieces from here
export * from './settings-parts.tsx'

/** a page body that fails to load (a new build replaced its chunk under an open tab) leaves Settings usable */
class PageLoadBoundary extends Component<{ children?: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(e: unknown) {
    console.error('a Settings page failed to load:', e)
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="flex flex-col gap-2">
        <Empty>Couldn't load this page. Reload and try again; if it keeps happening, the page has an error.</Empty>
        <Ghost onClick={() => location.reload()}>Reload Shepherdr</Ghost>
      </div>
    )
  }
}

/** Settings → Plugins with what failed on this screen too: a plugin of the human's own that threw here */
export function withPluginErrors(sections: SettingSection[], errors: Record<string, string>): SettingSection[] {
  if (!Object.keys(errors).length) return sections
  return sections.map((x) =>
    x.name !== 'Plugins'
      ? x
      : { ...x, rows: x.rows.map((r) => (errors[r.label] && !r.warn ? { ...r, warn: `Stopped on this screen: it threw:\n${errors[r.label]}` } : r)) },
  )
}
/** Appearance: System, Light or Dark, kept on this device */
function AppearancePick({ phone }: { phone: boolean }) {
  const now = useAppearance()
  return (
    <div role="radiogroup" aria-label="Appearance" className={phone ? clsx(card, 'overflow-hidden') : 'w-full'}>
      {APPEARANCES.map((a) => (
        <label key={a} className={clsx(rowLook(phone), 'group cursor-pointer has-focus-visible:shadow-[inset_0_0_0_1.5px_var(--focus)]', phone && 'press')}>
          <input type="radio" name="appearance" value={a} checked={now === a} onChange={() => setAppearance(a)} className="sr-only" />
          <span className="flex min-w-0 flex-col">
            {LOOKS[a].label}
            {LOOKS[a].hint ? <Small className="text-pretty">{LOOKS[a].hint}</Small> : null}
          </span>
          <CheckIcon className={clsx(ic, 'text-accent group-not-has-checked:invisible')} />
        </label>
      ))}
    </div>
  )
}
/** Settings → Autopilot for a space: Run now, the same control as the chat's, one heartbeat at once (or once its turn
 *  is over); while one waits or runs it says Queued or Waking, and a refusal says why */
function AutopilotRunNow({ place }: { place: Place }) {
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState('')
  const state = place.runNow
  if (!state) return null
  const waiting = busy || state !== 'ready'
  const run = async () => {
    if (waiting) return
    setBusy(true)
    setRefused('')
    try {
      const r = (await act({ type: 'heartbeat', place: place.id, op: 'run' })) as { ok?: boolean; error?: string } | undefined
      if (r?.ok === false) setRefused(r.error ?? 'It did not wake.')
    } catch (e) {
      setRefused((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex items-center gap-3">
        <Ghost onClick={() => void run()} disabled={waiting} aria-label={`Run now: wake ${place.name}'s coordinator for one heartbeat`}>
          {state === 'queued' ? 'Queued' : state === 'waking' ? 'Waking' : 'Run now'}
        </Ghost>
        <Small className="text-pretty">
          {state === 'queued' ? 'It wakes once its turn is over' : state === 'waking' ? 'Its wake runs now' : 'Wakes its coordinator once, now: one heartbeat, no waiting for the next'}
        </Small>
      </div>
      {refused ? (
        <Small role="status" className="text-pretty text-need-fg!">
          {refused}
        </Small>
      ) : null}
    </div>
  )
}

/** a value set here that is what the row would follow anyway unsets it: it follows again */
const follows = (row: SettingRow, value: string) => (row.inherits && value === row.inherits.value ? null : value)

/** a page's row, or the button that adds the next backup of a role's chain under its last one */
type Item = SettingRow | { add: { key: string; value: string; label: string }; group?: string; sub?: string }

/** a group's rows in runs: each role's backups (sub) as one run of their own, the rows around them as the others */
const runsOf = (rows: Item[]) =>
  rows.reduce<{ sub?: string; rows: Item[] }[]>((runs, row) => {
    const last = runs.at(-1)
    if (last && last.sub === row.sub) last.rows.push(row)
    else runs.push({ sub: row.sub, rows: [row] })
    return runs
  }, [])

/** a role's backups under its own rows: a small heading (a labelled group for a screen reader), indented with a 2px rule
 *  down its left (fg3 at half strength: visible in light and dark, under the words), as a nested list has it; in a phone's group, its own rounded group inside the indent */
function SubBlock({ name, phone, children }: { name: string; phone: boolean; children: ReactNode }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className={clsx('mt-3 border-l-2 border-fg3/50', phone ? 'ml-2 pl-2' : 'ml-1 pl-4')}>
      <h4 id={id} className={subHeading(phone)}>
        {name}
      </h4>
      {children}
    </div>
  )
}

/** a page's settings: its rows under their group's heading (Tasks, Coordinators, Reviewer), and what it notes under them */
function PageBody({ page, phone, set, refused, clear, hint }: { page: Page; phone: boolean; set: (key: string, value: string | null) => void; refused: (key: string) => string | undefined; clear: (key: string) => void; hint?: string }) {
  // Autopilot's Run now on a space's page: what its chat's pill offers, where the heartbeat is set
  const snap = useSnap()
  const woken = page.name === 'Autopilot' && page.level?.startsWith('p:') ? snap?.places.find((p) => p.id === page.level) : undefined
  // a role's 2nd to 5th backups show once their CLI is on (or was just added here); its last one shown is followed by a
  // button that adds the next, on the same CLI as the one before it
  const [added, setAdded] = useState<string[]>([])
  const cliOf = (of: string, n: number) => page.rows.find((r) => r.chain?.of === of && r.chain.n === n && r.chain.cli)
  const on = (r?: SettingRow) => !!r && r.value.trim().toLowerCase() !== 'off'
  const shows = (r: SettingRow) => !r.chain || r.chain.n === 1 || on(cliOf(r.chain.of, r.chain.n)) || added.includes(cliOf(r.chain.of, r.chain.n)?.key ?? '')
  // one just added shows until its value comes back on; from then its value decides, so Off takes it out again
  useEffect(() => setAdded((a) => (a.some((k) => on(page.rows.find((r) => r.key === k))) ? a.filter((k) => !on(page.rows.find((r) => r.key === k))) : a)), [page.rows])
  const visible = page.rows.filter(shows)
  const items: Item[] = []
  visible.forEach((r, i) => {
    items.push(r)
    if (!r.chain || visible[i + 1]?.chain?.of === r.chain.of || !on(cliOf(r.chain.of, 1))) return
    const next = page.rows.find((x) => x.chain?.of === r.chain!.of && x.chain.cli && !shows(x))
    if (!next) return
    const last = visible.slice(0, i + 1).findLast((x) => x.chain?.of === r.chain!.of && x.chain.cli && on(x))
    items.push({ add: { key: next.key, value: last?.value ?? next.options?.find((o) => o !== 'off') ?? 'off', label: next.chain!.add ?? 'Add a backup' }, group: r.group, sub: r.sub })
  })
  const groups: { name?: string; rows: Item[] }[] = []
  for (const row of items) {
    if (groups.length && groups.at(-1)!.name === row.group) groups.at(-1)!.rows.push(row)
    else groups.push({ name: row.group, rows: [row] })
  }
  // what is said under a row's label: where its value comes from, or a reset for one set here; then what went wrong
  const under = (row: SettingRow) => (
    <>
      {row.key in registry.settingActions ? <Small className="text-pretty">{row.value}</Small> : null}
      {row.hint ? <Small className="text-pretty">{row.hint}</Small> : null}
      {/* the exact words it adds to every new brief, as it is set now */}
      {row.line ? <details className="text-[0.8125rem] text-fg2"><summary className="cursor-pointer">Brief wording</summary><p className="text-pretty">Adds: “{row.line}”</p></details> : null}
      {row.from ? <Small className="text-pretty">From {row.from}</Small> : null}
      {row.inherits ? (
        // set here: Reset, back to what it would be (its title says where that comes from)
        <Small className="text-pretty">
          <span className="font-medium text-accent">Set here</span>
          <span className="block">Inherits {row.multiline ? (row.inherits.value ? 'private rules' : 'no private rules') : row.num ? numShown(row.inherits.value, row.num) : row.trigger ? (row.trigger.presets.find((p) => p.value === row.inherits!.value)?.label ?? 'Custom rule') : shown(row.inherits.value)} · {row.inherits.from}</span>
          {row.trigger && !row.trigger.presets.some((p) => p.value === row.inherits!.value) ? <details><summary className="cursor-pointer">Inherited rule</summary><span className="[overflow-wrap:anywhere]">{row.inherits.value}</span></details> : null}
          <button
            type="button"
            title={`Set here. Back to ${row.inherits.from === 'Default' ? 'the default' : row.inherits.from}'s`}
            onClick={() => set(row.key, null)}
            className="press-dim relative font-medium text-accent after:absolute after:-inset-x-1 after:-inset-y-1.5 coarse:after:-inset-y-3"
          >
            Reset to {row.multiline ? (row.inherits.value ? 'private rules' : 'no private rules') : row.num ? numShown(row.inherits.value, row.num) : row.trigger ? (row.inherits.from === 'Default' ? 'the default' : `${row.inherits.from}'s`) : shown(row.inherits.value)}
          </button>
        </Small>
      ) : null}
      {row.warn ? <Small className="text-pretty whitespace-pre-line text-need-fg!">{row.warn}</Small> : null}
      {refused(row.key) ? (
        <Small role="status" className={clsx('text-pretty', !registry.settingActions[row.key] && 'text-need-fg!')}>
          {refused(row.key)}
        </Small>
      ) : null}
    </>
  )
  // one row of a group, or the button that adds the next backup of its chain
  const rowOf = (row: Item) => {
    if ('add' in row)
      return (
        <div className={rowLook(phone)}>
          <button
            type="button"
            data-add-backup={row.add.key}
            onClick={() => {
              setAdded((a) => [...a, row.add.key])
              set(row.add.key, row.add.value)
            }}
            className="press-dim relative flex min-h-9 items-center gap-1.5 font-medium text-accent after:absolute after:-inset-x-1 after:-inset-y-1.5 coarse:min-h-11"
          >
            <PlusIcon className={ic} />
            {row.add.label}
          </button>
        </div>
      )
    if (row.doc || row.multiline)
      return (
        <div className={clsx(rowLook(phone), 'flex-col items-stretch! gap-2.5 pb-3!', row.inherits && 'border-l-2 border-accent pl-3')}>
          <dt className="flex min-w-0 flex-col">
            {row.label}
            {row.doc ? <Small className="text-pretty">Its coordinator goes through it each heartbeat, and may edit it too.</Small> : null}
            {under(row)}
          </dt>
          <dd>
            <DocValue label={row.label} file={row.multiline ? 'Private · this role only' : 'HEARTBEAT.md'} privateRules={row.multiline} phone={phone} value={row.value} onSave={(x) => set(row.key, row.multiline ? follows(row, x) : x)} />
          </dd>
        </div>
      )
    // a trigger: its words, next runs and picks under its label, as wide as the page
    if (row.trigger)
      return (
        <div className={clsx(rowLook(phone), 'flex-col items-stretch! gap-2 pb-3!', row.inherits && 'border-l-2 border-accent pl-3')}>
          <dt className="flex min-w-0 flex-col">
            {row.label}
            {under(row)}
          </dt>
          <dd>
            <TriggerValue row={{ ...row, trigger: row.trigger }} phone={phone} onPick={(x) => set(row.key, follows(row, x))} />
          </dd>
        </div>
      )
    // on a phone, a row's segments fill a line of their own under its label
    return (
      <div className={clsx(rowLook(phone), row.inherits && 'border-l-2 border-accent pl-3', phone && SEGMENTS.has(row.key) && 'flex-col items-stretch! gap-2.5 pb-3!')}>
        <dt className="flex min-w-0 flex-1 flex-col">
          {row.label}
          {under(row)}
        </dt>
        <dd className={clsx('flex min-w-0 shrink-0 flex-col', phone && SEGMENTS.has(row.key) ? 'items-stretch' : 'max-w-[65%] items-end')}>
          <Control row={row} phone={phone} set={(x) => set(row.key, follows(row, x))} edit={() => clear(row.key)} />
        </dd>
      </div>
    )
  }
  // a run of rows as one list: a phone's rounded group, a little apart from the run before it
  const list = (rows: Item[], apart = false) => (
    <dl className={clsx(phone && card, apart && 'mt-3')}>
      {rows.map((row) => (
        <Fragment key={'add' in row ? `add:${row.add.key}` : row.key || row.label}>{rowOf(row)}</Fragment>
      ))}
    </dl>
  )
  return (
    <div className={clsx('flex w-full flex-col', phone ? 'gap-6 px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+--spacing(8))]' : page.matrix ? 'gap-4 pt-5 pb-0' : 'max-w-[720px] gap-6 px-6 pt-5 pb-8')}>
      <div className={clsx('flex flex-col gap-1', phone ? 'px-4' : page.matrix && 'max-w-[720px] px-6')}>
        {phone ? null : <h2 className="text-[0.9375rem] font-semibold">{page.name}</h2>}
        {page.about ? <p className={clsx('text-pretty text-fg2', phone ? 'text-[0.9375rem]' : 'text-[0.8125rem]')}>{page.about}</p> : null}
        {hint ? <p className={clsx('text-pretty text-fg3', phone ? 'text-[0.9375rem]' : 'text-[0.8125rem]')}>{hint}</p> : null}
      </div>
      {woken?.runNow ? <AutopilotRunNow place={woken} /> : null}
      {page === APPEARANCE ? <AppearancePick phone={phone} /> : null}
      {page.secrets && page.level ? <SecretsList level={page.level} secrets={page.secrets} phone={phone} /> : null}
      {page.View ? (
        <PageLoadBoundary>
          <Suspense fallback={<div role="status" aria-live="polite" data-suspense-fallback><Empty>Loading…</Empty></div>}>
            <page.View phone={phone} />
          </Suspense>
        </PageLoadBoundary>
      ) : null}
      {groups.map(({ name, rows }, g) => (
        <div key={name ?? g} className="w-full">
          {name ? <h3 className={heading(phone)}>{name}</h3> : null}
          {runsOf(rows).map((run, i) => (
            <Fragment key={i}>
              {run.sub ? <SubBlock name={run.sub} phone={phone}>{list(run.rows)}</SubBlock> : list(run.rows, i > 0)}
            </Fragment>
          ))}
        </div>
      ))}
      {page.note ? (
        <figure className="w-full">
          <figcaption className={heading(phone)}>{page.noteTitle ?? 'Every new brief ends with'}</figcaption>
          <blockquote className={clsx('text-pretty whitespace-pre-wrap text-fg2', phone ? clsx(card, 'px-4 py-3 text-[0.9375rem]') : 'rounded-box bg-hover px-3 py-2.5 text-[0.8125rem]')}>{page.note}</blockquote>
        </figure>
      ) : null}
    </div>
  )
}

/** how long ago, in a word or two */
function ago(at: number) {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

/** a level's secrets, by name: each replaced or removed, and new ones added, in masked boxes. Values never come here:
 *  they only go, once, to be kept on the main machine */
function SecretsList({ level, secrets, phone }: { level: string; secrets: { name: string; at: number }[]; phone: boolean }) {
  // the name being replaced, or '' for a new one; none: no box open
  const [open, setOpen] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [sure, setSure] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // another level's page: nothing half-typed comes along
  useEffect(() => {
    setOpen(null)
    setValue('')
    setSure(null)
  }, [level])
  const close = () => {
    setOpen(null)
    setName('')
    setValue('')
    setErr('')
  }
  const save = async (n: string, v: string | null) => {
    setBusy(true)
    setErr('')
    try {
      const r = (await act({ type: 'secret', level, name: n, value: v })) as { ok?: boolean; error?: string }
      if (r?.ok === false) setErr(r.error ?? "That didn't go through.")
      else if (v !== null) close()
      else setSure(null)
    } catch {
      setErr("That didn't go through: Shepherdr can't be reached.")
    } finally {
      setBusy(false)
    }
  }
  const box = (n: string) => (
    <div className="flex w-full flex-col gap-2">
      <SecretField label={n ? `New value for ${n}` : 'Value'} value={value} onChange={setValue} onEnter={() => (n || name) && value && save(n || name.trim(), value)} autoFocus={!!n} />
      <div className="flex items-center justify-end gap-2">
        {err ? <span role="status" className="mr-auto text-[0.75rem] text-need-fg phone:text-[0.8125rem]">{err}</span> : null}
        <Ghost onClick={close}>Cancel</Ghost>
        <Ghost disabled={busy || !value || (!n && !name.trim())} onClick={() => save(n || name.trim(), value)} className="bg-fg text-bg! shadow-none! enabled:hover:bg-fg">
          Save
        </Ghost>
      </div>
    </div>
  )
  return (
    <div className="flex w-full flex-col gap-1.5">
      <dl className={phone ? card : undefined}>
        {secrets.map((x) => (
          <div key={x.name} className={clsx(rowLook(phone), open === x.name && 'flex-col items-stretch! gap-2.5 pb-3!')}>
            <dt className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-mono text-[0.8125rem] phone:text-[0.9375rem]">{x.name}</span>
              <Small>Saved {ago(x.at)}</Small>
            </dt>
            <dd className={clsx('flex shrink-0 items-center gap-1.5', open === x.name && 'w-full')}>
              {open === x.name ? (
                box(x.name)
              ) : sure === x.name ? (
                <>
                  <Ghost onClick={() => setSure(null)}>Keep</Ghost>
                  <Ghost disabled={busy} onClick={() => save(x.name, null)} className="text-need-fg!">
                    Remove it
                  </Ghost>
                </>
              ) : (
                <>
                  <Ghost
                    onClick={() => {
                      close()
                      setOpen(x.name)
                    }}
                  >
                    Replace
                  </Ghost>
                  <Ghost onClick={() => setSure(x.name)}>Remove</Ghost>
                </>
              )}
            </dd>
          </div>
        ))}
        {open === '' ? (
          <div className={clsx(rowLook(phone), 'flex-col items-stretch! gap-2 py-3!')}>
            <input
              aria-label="Name"
              placeholder="NAME, like GITHUB_TOKEN"
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
              className={clsx('min-h-10 w-full min-w-0 rounded-row bg-transparent px-3 py-[9px] font-mono placeholder:font-sans placeholder:text-fg3 coarse:min-h-11 phone:min-h-11 phone:text-[1rem]', field)}
            />
            {box('')}
          </div>
        ) : (
          <div className={rowLook(phone)}>
            <dt className="min-w-0 flex-1 text-fg2">{secrets.length ? null : 'None here yet.'}</dt>
            <dd>
              <Ghost
                onClick={() => {
                  close()
                  setOpen('')
                }}
              >
                Add a secret
              </Ghost>
            </dd>
          </div>
        )}
      </dl>
      {err && open === null ? <Small role="status" className="text-need-fg!">{err}</Small> : null}
      <p className={clsx('text-pretty text-fg3', phone ? 'px-4 text-[0.8125rem]' : 'text-[0.75rem]')}>
        Agents run commands with them by name (shepherdr secret run), and ask for one in their chat when they need it.
      </p>
    </div>
  )
}

export default function Settings() {
  const ui = useUI()
  const snap = useSnap()!
  const s = ui.settings!
  const groups = groupsOf(withPluginErrors(snap.settings, usePluginErrors()), ui)
  const pages = groups.flatMap((g) => g.pages)
  const sec = Math.min(s.section ?? 0, pages.length - 1)
  const page = pages[sec]
  // a page that comes or goes (a tablet's Keyboard shortcuts, once a key is pressed) keeps the one shown in view
  const names = pages.map((p) => p.name).join('\n')
  const shownPage = useRef({ names, name: page.name })
  useLayoutEffect(() => {
    const was = shownPage.current
    shownPage.current = { names, name: page.name }
    if (was.names === names || s.section === null) return
    const i = pages.findIndex((p) => p.name === was.name)
    if (i >= 0 && i !== sec) {
      shownPage.current.name = was.name
      setUI({ settings: { ...s, section: i } })
    }
  })
  const phone = ui.device === 'phone'
  const tablet = ui.device === 'tablet'
  const appearance = useAppearance()
  // what was refused, by page and key: each machine's page has the same keys
  const [refused, setRefused] = useState<Record<string, string>>({})
  const at = (key: string) => `${page.level ?? ''}|${key}`
  const level = levelOf(snap.settings, ui)
  const levels = levelsOf(snap.settings)
  const name = (l: string) => levelName(l, snap.settings, snap)
  const pickLevel = (l: string) => setUI({ settings: { ...s, level: l } })
  // the picker is the sidebar's tree: Everywhere, then each machine with its spaces under it, in its order
  const order = ['all', ...(snap.machines ?? []).flatMap((m) => [m.id, ...snap.places.filter((p) => p.machine === m.machine).map((p) => p.id)])]
  const rank = (l: string) => (order.includes(l) ? order.indexOf(l) : Infinity)
  const tree = [...levels].sort((a, b) => rank(a) - rank(b))
  const inTree = (l: string) => {
    return { depth: l === 'all' ? 0 : l.startsWith('m:') ? 1 : 2, name: name(l) }
  }
  const levelPick = (where: string) =>
    levels.length > 1 ? (
      <Pick
        label="Editing"
        value={level}
        options={tree}
        show={name}
        depth={inTree}
        icon={(l) => <PlaceIcon level={inTree(l).depth} className={clsx(ic, 'text-fg2')} />}
        onPick={pickLevel}
        ordered
        left={where !== 'phone'}
        plain={where === 'phone'}
        className={where === 'nav' ? 'px-0.5' : undefined}
      />
    ) : null
  const set = async (key: string, value: string | null) => {
    const own = registry.settingActions[key]
    if (own) {
      setRefused((r) => ({ ...r, [at(key)]: '' }))
      const said = await own()
      setRefused((r) => ({ ...r, [at(key)]: said }))
      return
    }
    // set at the page's level: a machine's or a space's goes to that machine
    const r = (await act({ type: 'setting', key, value, ...((page.targets?.[key] ?? page.level) ? { place: page.targets?.[key] ?? page.level } : {}) })) as { ok?: boolean; error?: string; waiting?: boolean }
    setRefused((x) => ({ ...x, [at(key)]: r?.ok === false ? (r.error ?? 'Refused.') : r?.waiting ? `Set once ${machineName(snap.machines, page.machine)} is back.` : '' }))
    // a task's agent or reviewer saved: the tasks already waiting may take it too, asked first (none asked when none would change)
    if (r?.ok && !r.waiting) void askWaiting(key, page.targets?.[key] ?? page.level)
  }
  const close = () => setUI({ settings: null })
  const scroller = useRef<HTMLDivElement>(null)
  const go = (section: number) => {
    setUI({ settings: { ...s, section } })
    // a new section starts at its top
    requestAnimationFrame(() => scroller.current && (scroller.current.scrollTop = 0))
  }
  const clear = (key: string) => refused[at(key)] && setRefused((r) => ({ ...r, [at(key)]: '' }))
  const body = <>
    <div className={clsx('flex min-w-0 flex-wrap items-center gap-2 border-b border-line px-6 py-3', phone && 'px-4')}>
      <span className="text-fg2">Editing:</span>
      {page.device ? <span>This device</span> : page.matrix ? <span>Every level</span> : page.global || !page.level ? <span>Everywhere</span> : levelPick(phone ? 'phone' : 'content') ?? <span>{name(level)}</span>}
    </div>
    <PageBody key={`${page.level ?? ''}|${page.name}`} page={page} phone={phone} set={set} refused={(key) => refused[at(key)]} clear={clear} hint={page.rows.some((r) => r.key === 'space.base') ? 'This repository’s branch for new tasks.' : page.level && !page.global && page.name !== 'Task IDs' ? levelHint(page.level, snap) : undefined} /></>

  if (phone) {
    const list = (
      <div className="flex min-h-0 flex-1 flex-col">
        <PhoneTop
          left={
            <RoundButton label="Back" onClick={close}>
              <BackIcon className={ic} />
            </RoundButton>
          }
          name="Settings"
        />
        <nav aria-label="Sections" className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain bg-canvas">
          <div className="flex flex-col gap-6 px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+--spacing(8))]">
            {/* which level's defaults the two groups below set */}
            {levels.length > 1 ? (
              <div className={clsx(card, 'flex min-h-12 items-center justify-between gap-3 px-4')}>
                <span>Editing:</span>
                {levelPick('phone')}
              </div>
            ) : null}
            {groups.map((g) => (
              <div key={g.name}>
                <h3 className={heading(true)}>{g.name}</h3>
                <ul role="list" className={clsx(card, 'overflow-hidden')}>
                  {g.pages.map((p) => {
                    const Icon = iconOf(p)
                    return (
                      <li key={p.name} className="relative not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-11 not-first:before:h-px not-first:before:bg-line">
                        <button type="button" onClick={() => go(pages.indexOf(p))} className="press flex min-h-12 w-full items-center gap-3 px-4 text-left">
                          <Icon className={clsx(ic, 'text-fg2')} />
                          <span className="min-w-0 flex-1 truncate">{p.name}</span>
                          {p === APPEARANCE ? <span className="text-fg2">{LOOKS[appearance].label}</span> : null}
                          <NextIcon className={clsx(ic, 'text-fg3')} />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        </nav>
      </div>
    )
    const back = () => setUI({ settings: { ...s, section: null } })
    return (
      <section aria-label="Settings" className="flex min-h-0 flex-1 flex-col">
        <Stack
          base={list}
          top={
            s.section === null ? null : (
              <section aria-label={page.name} className="flex min-h-0 flex-1 flex-col">
                <PhoneTop
                  left={
                    <RoundButton label="Back" onClick={back}>
                      <BackIcon className={ic} />
                    </RoundButton>
                  }
                  name={page.name}
                  kind={page.device ? 'This device' : page.global ? 'Everywhere' : page.level ? name(page.level) : undefined}
                />
                <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain bg-canvas">{body}</div>
              </section>
            )
          }
          topKey={s.section === null ? null : page.name}
          onBack={back}
        />
      </section>
    )
  }

  return (
    <section aria-label="Settings" className="flex min-h-0 flex-1 flex-col">
      <Head>
        {/* on a tablet it slid in like a page: Back, at the start */}
        {tablet ? (
          <IconButton label="Back" onClick={close}>
            <BackIcon className={ic} />
          </IconButton>
        ) : null}
        <PlacesToggle when="closed" drawer />
        <Who name="Settings" />
        {tablet ? null : (
          <IconButton label="Close" onClick={close}>
            <XIcon className={ic} />
          </IconButton>
        )}
      </Head>
      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Sections" className="flex touch-pan-y flex-col gap-4 overflow-y-auto overscroll-contain border-r border-line px-2 py-3">
          {groups.map((g) => (
            <div key={g.name} className="flex flex-col gap-px">
              <h3 className="px-2.5 pb-1 text-[0.75rem] font-medium text-fg3">{g.name}</h3>
              {g.pages.map((p) => {
                const Icon = iconOf(p)
                const i = pages.indexOf(p)
                return (
                  <button
                    key={p.name}
                    type="button"
                    aria-current={sec === i ? 'page' : undefined}
                    onClick={() => go(i)}
                    className="press flex h-8 items-center gap-2 rounded-row px-2.5 text-left text-fg2 hover:bg-hover aria-[current=page]:bg-sel aria-[current=page]:text-fg coarse:h-11"
                  >
                    <Icon className={ic} />
                    <span className="min-w-0 truncate">{p.name}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
        <div ref={scroller} className="touch-pan-y overflow-y-auto overscroll-contain">
          {body}
        </div>
      </div>
    </section>
  )
}
