// Settings → Models → profiles: a named snapshot of the agent settings at every level of this machine (Everywhere, the
// machine, each space), so the whole set switches in one step: a night setup on the local model, a day one on the cloud
// ones. A profile holds every role's CLI, model and effort, backups included, and with limits also Max tasks and Merge
// train. It stores each key's own value at each level, null where the level sets nothing, so applying it restores
// exactly what was saved. Nothing is stored twice: applying writes the difference through Settings.set, the same check
// the setting action makes.
//
// Apply is all or nothing: every write is first tried on a copy of the settings, and one a level refuses (a model its
// CLI no longer has, say) stops the whole apply, so a half-applied profile, a night with a day's CLI, never happens.
// Before each apply the values it changes are kept as an undo point (the last UNDO_KEEP). Undo puts those back, and only
// where they still read as the apply left them: a setting changed since is left as it is.
//
// The Profiles class is the reusable part: the live source and the demo world hand it their settings, their spaces and
// what to do once values are written; the actions and the shepherdr profile command are thin layers over it.
import type { ProfileChange, ProfilePreview, ProfileRefusal, ProfilesView } from '../../shared/types.ts'
import { waitingKind, type WaitingKind } from '../../shared/apply-waiting.ts'
import { home, readJson, writeJson } from '../store.ts'
import { matrixSlots } from './models-matrix.ts'
import { nextLine, scheduleRows, type Schedule } from './profile-schedule.ts'
import { placeId } from './places.ts'
import { CAPS_FORMAT, fitCaps, type Level, type Settings } from './settings.ts'

/** the most undo points kept: an undo steps back through them, the newest first */
export const UNDO_KEEP = 5
/** the longest a profile's name may be */
export const NAME_MAX = 40
/** the keys of the models: every role's CLI, model and effort, its primary and backups (the columns of the Models page) */
export const MODEL_KEYS = matrixSlots().flatMap((x) => [x.cli, x.model, x.effort])
/** the limits a profile may hold as well: Max tasks, the most at once per model (this machine's, models.maxAtOnce) and Merge train */
export const LIMIT_KEYS = ['space.maxTasks', 'models.maxAtOnce', 'merge.train']
/** the keys a profile holds: the models, and the limits when it holds them */
export const keysOf = (limits: boolean) => (limits ? [...MODEL_KEYS, ...LIMIT_KEYS] : MODEL_KEYS)

/** a setting's name on the Models page: "Tasks · Primary · Agent", "Max tasks" */
const LABELS: Record<string, string> = {
  ...Object.fromEntries(matrixSlots().flatMap((x) => [[x.cli, `${x.title} · ${x.name} · Agent`], [x.model, `${x.title} · ${x.name} · Model`], [x.effort, `${x.title} · ${x.name} · Effort`]])),
  'space.maxTasks': 'Max tasks',
  'models.maxAtOnce': 'Max at once per model',
  'merge.train': 'Merge train',
}
export const labelOf = (key: string) => LABELS[key] ?? key

/** one level's own values, by key: null where the level sets nothing */
export type Rec = Record<string, string | null>
/** every level of a profile: Everywhere, this machine, and each space by its key */
export interface Values {
  all: Rec
  machine: Rec
  spaces: Record<string, Rec>
}
export interface Profile {
  name: string
  limits: boolean
  saved: number
  applied?: number
  /** each saved space's name, for what it says of a space (by its key) */
  names: Record<string, string>
  values: Values
  /** when it applies by itself (profile-schedule.ts); a re-save keeps them */
  schedules?: Schedule[]
}
export interface Last {
  name: string
  at: number
}
/** the values an apply changed, as they were before it and as it left them: an undo puts back the first where the second still holds */
export interface Undo {
  name: string
  at: number
  last?: Last | undefined
  changes: { key: string; at: Level; before: string | null; after: string | null }[]
}
/** profiles.json: the profiles, the last apply, and the undo points */
export interface ProfileFile {
  profiles: Profile[]
  last?: Last | undefined
  undo: Undo[]
  /** the format of the profiles' models.maxAtOnce words (CAPS_FORMAT); none for a file written before it */
  capsFormat?: number
}
/** what a profile is read against: this machine's settings, its spaces (the home one as ~) with their names */
export interface Site {
  settings: Settings
  machine: { host: string; name: string }
  spaces: { key: string; name: string }[]
}
/** one change as a level writes it: the setting, the level (Settings' own) and the values */
export type Change = ProfileChange & { at: Level }

export const publish = (c: Change): ProfileChange => ({ place: c.place, where: c.where, key: c.key, label: c.label, now: c.now, then: c.then })

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
/** a name as it is kept: its words, on one line */
export const cleanName = (raw: string) => raw.replace(/\s+/g, ' ').trim()

/** why a name can't be kept; own: the profile's own name when it is replaced or renamed to the same */
export function nameProblem(name: string, f: ProfileFile, own?: string): string | undefined {
  if (!name) return 'Give the profile a name.'
  if (name.length > NAME_MAX) return `Use at most ${NAME_MAX} characters.`
  if (/[\u0000-\u001f]/.test(name)) return 'Use letters, numbers and spaces.'
  if (same(name, 'Custom')) return 'Custom is what the bar says when no profile matches: choose another name.'
  if (f.profiles.some((p) => same(p.name, name) && p.name !== own)) return `${name} is a profile already.`
  return undefined
}

/** profiles.json in Shepherdr's home; a world of its own (the demo's) keeps them in memory */
export class ProfileStore {
  f: ProfileFile
  private dir: string | null

  constructor(memory = false) {
    this.dir = memory ? null : home()
    const raw = this.dir ? readJson<Partial<ProfileFile>>('profiles.json', {}, this.dir) : {}
    this.f = { profiles: Array.isArray(raw.profiles) ? raw.profiles : [], last: raw.last, undo: Array.isArray(raw.undo) ? raw.undo : [], ...(raw.capsFormat ? { capsFormat: raw.capsFormat } : {}) }
    if (this.dir && raw.capsFormat !== CAPS_FORMAT) this.convertCaps()
  }

  /** a file from before the harness keys: each saved profile's models.maxAtOnce text is written the way it is kept now (fitCaps),
   *  each change logged, and the file marked so this runs once */
  private convertCaps() {
    for (const p of this.f.profiles) {
      for (const rec of [p.values?.all, p.values?.machine, ...Object.values(p.values?.spaces ?? {})]) {
        const text = rec?.['models.maxAtOnce']
        if (typeof text !== 'string') continue
        const fit = fitCaps(text).text
        if (fit === text) continue
        console.error(`shepherdr: profile ${p.name}: models.maxAtOnce "${text}" is kept as "${fit}"`)
        rec['models.maxAtOnce'] = fit
      }
    }
    this.f.capsFormat = CAPS_FORMAT
    this.save()
  }

  save() {
    if (this.dir) writeJson('profiles.json', this.f, this.dir)
  }
}

const kindOf = (l: Level) => (l === 'all' ? 'all' : l === 'machine' ? 'machine' : 'space')

/** a key's own value at one level: null where the level sets nothing (an inherited value is not its own) */
export function ownAt(s: Settings, key: string, l: Level): string | null {
  const p = s.pick(key, l)
  return p.from === kindOf(l) ? p.value : null
}

/** where a level is: its place id, and its name in words */
export function placeOf(site: Site, at: Level): { place: string; where: string } {
  if (at === 'all') return { place: 'all', where: 'Everywhere' }
  if (at === 'machine') return { place: placeId.machine(site.machine.host), where: site.machine.name }
  return { place: placeId.space(at.space, site.machine.host), where: site.spaces.find((sp) => sp.key === at.space)?.name ?? at.space }
}

/** whether a level still exists here: Everywhere and the machine always, a space while it is one */
const exists = (site: Site, at: Level) => at === 'all' || at === 'machine' || site.spaces.some((sp) => sp.key === at.space)

/** the keys' own values at every level of this machine, as a profile keeps them */
export function readValues(site: Site, keys: string[]): Values {
  const rec = (at: Level): Rec => Object.fromEntries(keys.map((k) => [k, ownAt(site.settings, k, at)]))
  return { all: rec('all'), machine: rec('machine'), spaces: Object.fromEntries(site.spaces.map((sp) => [sp.key, rec({ space: sp.key })])) }
}

export interface Plan {
  changes: Change[]
  /** saved spaces that are no longer spaces: their values are skipped (by the name they had) */
  skipped: string[]
  /** spaces added since the save: applying leaves them as they are */
  added: string[]
}

/** the changes that make the levels read as a profile's values: Everywhere, this machine, then each saved space that is
 *  still one; only where a value differs now */
export function planOf(site: Site, p: Pick<Profile, 'limits' | 'values' | 'names'>): Plan {
  const saved = p.values.spaces
  const here = site.spaces.filter((sp) => sp.key in saved)
  const levels: { at: Level; rec: Rec }[] = [
    { at: 'all', rec: p.values.all },
    { at: 'machine', rec: p.values.machine },
    ...here.map((sp) => ({ at: { space: sp.key } as Level, rec: saved[sp.key]! })),
  ]
  const changes: Change[] = []
  for (const { at, rec } of levels)
    for (const key of keysOf(p.limits)) {
      if (!(key in rec)) continue
      const now = ownAt(site.settings, key, at)
      const then = rec[key] ?? null
      if (now !== then) changes.push({ key, at, now, then, label: labelOf(key), ...placeOf(site, at) })
    }
  return {
    changes,
    skipped: Object.keys(saved)
      .filter((k) => !site.spaces.some((sp) => sp.key === k))
      .map((k) => p.names[k] ?? k),
    added: site.spaces.filter((sp) => !(sp.key in saved)).map((sp) => sp.name),
  }
}

/** the changes the settings would refuse, tried one after another on a copy of them (nothing is written) */
export function refusedBy(s: Settings, changes: Change[]): ProfileRefusal[] {
  const scratch = s.copy()
  const out: ProfileRefusal[] = []
  for (const c of changes) {
    const r = scratch.set(c.key, c.then, c.at)
    if (!r.ok) out.push({ ...publish(c), error: r.error ?? 'Refused.' })
  }
  return out
}

/** writes the changes in order, each through Settings.set as the setting action writes it */
function write(s: Settings, changes: Change[]) {
  for (const c of changes) {
    const r = s.set(c.key, c.then, c.at)
    // coverage-exempt: refusedBy tried these same writes on a copy of these settings, so none can be refused now
    if (!r.ok) throw new Error(r.error)
  }
}

/** the first change of each kind of waiting task at each place: the question asks once per kind and place, as the screen does */
export function waitingPicks(changes: Change[]): { kind: WaitingKind; change: Change }[] {
  const seen = new Set<string>()
  const out: { kind: WaitingKind; change: Change }[] = []
  for (const change of changes) {
    const kind = waitingKind(change.key)
    if (!kind || seen.has(`${kind}|${change.place}`)) continue
    seen.add(`${kind}|${change.place}`)
    out.push({ kind, change })
  }
  return out
}

/** how long ago, in words: just now, 5m ago, 2h ago, 3d ago */
export function agoWords(t: number, now = Date.now()) {
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const clock = (t: number) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const shown = (v: string | null) => v ?? 'not set'
const holds = (p: { limits: boolean }) => (p.limits ? 'Models and Limits' : 'Models')

/** the changes in words, grouped by level: a heading, then each setting as now → then */
export function changeWords(changes: ProfileChange[]): string[] {
  const groups = new Map<string, { where: string; rows: ProfileChange[] }>()
  for (const c of changes) groups.set(c.place, { where: c.where, rows: [...(groups.get(c.place)?.rows ?? []), c] })
  return [...groups.values()].flatMap(({ where, rows }) => [where, ...rows.map((c) => `  ${c.label}: ${shown(c.now)} → ${shown(c.then)}`)])
}

/** a preview in words, as the command line says it */
export function previewWords(r: ProfilePreview): string {
  const n = r.changes.length
  return [
    n ? `${r.name} would change ${n} ${n === 1 ? 'setting' : 'settings'}:` : `${r.name} changes nothing: the settings read as it says.`,
    ...changeWords(r.changes),
    ...(r.refused.length ? [`Refused, so nothing would be applied:`, ...r.refused.map((x) => `  ${x.where} · ${x.label}: ${x.error}`)] : []),
    ...r.skipped.map((s) => `Skipped, no longer a space: ${s}`),
    ...r.added.map((s) => `Left as it is, added since the save: ${s}`),
  ].join('\n')
}

export class Profiles {
  constructor(
    private store: ProfileStore,
    private site: () => Site,
    /** what a write changed: the caller's own follow-up (its snapshot, its chats) */
    private written: (changes: Change[]) => void,
  ) {}

  /** the saved profile of a name (any case) */
  find(raw: string) {
    const name = cleanName(raw)
    return this.store.f.profiles.find((p) => same(p.name, name))
  }

  /** the bar: the saved profiles, the one the settings match now, and the undo point an undo restores */
  view(): ProfilesView {
    const site = this.site()
    const f = this.store.f
    const last = f.last
    const lastProfile = last ? f.profiles.find((p) => p.name === last.name) : undefined
    const match = (lastProfile ? [lastProfile, ...f.profiles] : f.profiles).find((p) => planOf(site, p).changes.length === 0)
    const undo = f.undo.at(-1)
    const zone = site.settings.zone()
    const now = Date.now()
    const next = nextLine(f.profiles, zone, now)
    return {
      profiles: f.profiles.map(({ name, limits, saved, applied, schedules }) => ({
        name,
        limits,
        saved,
        ...(applied ? { applied } : {}),
        ...(schedules?.length ? { schedules: scheduleRows({ schedules }, zone, now) } : {}),
      })),
      ...(next ? { next } : {}),
      active: match?.name ?? 'Custom',
      ...(lastProfile && last ? { last: { name: lastProfile.name, at: last.at } } : {}),
      ...(undo ? { undo: { name: undo.name, at: undo.at, label: `Before ${undo.name}, ${clock(undo.at)}` } } : {}),
    }
  }

  /** saves the current settings as a profile: the models, and the limits when asked. A saved name is replaced only with force */
  save(raw: string, o: { limits?: boolean; force?: boolean } = {}): { ok: boolean; error?: string; exists?: boolean; profile?: Profile } {
    const f = this.store.f
    const name = cleanName(raw)
    const old = f.profiles.find((p) => same(p.name, name))
    const bad = nameProblem(name, f, old?.name)
    if (bad) return { ok: false, error: bad }
    if (old && !o.force) return { ok: false, exists: true, error: `${old.name} is a profile already.` }
    const site = this.site()
    const limits = !!o.limits
    const profile: Profile = {
      name,
      limits,
      saved: Date.now(),
      names: Object.fromEntries(site.spaces.map((sp) => [sp.key, sp.name])),
      values: readValues(site, keysOf(limits)),
      ...(old?.schedules ? { schedules: old.schedules } : {}),
    }
    f.profiles = old ? f.profiles.map((p) => (p === old ? profile : p)) : [...f.profiles, profile]
    this.store.save()
    return { ok: true, profile }
  }

  /** what applying a profile would change now, what would hold it back, and what it leaves out */
  preview(raw: string): ProfilePreview {
    const p = this.find(raw)
    if (!p) return { ok: false, error: `No profile called ${cleanName(raw)}.`, changes: [], refused: [], skipped: [], added: [] }
    const site = this.site()
    const plan = planOf(site, p)
    return { ok: true, name: p.name, changes: plan.changes.map(publish), refused: refusedBy(site.settings, plan.changes), skipped: plan.skipped, added: plan.added }
  }

  /** applies a profile, all of it or nothing; the values it changes are kept as an undo point first. The changes come
   *  back with their levels, so the caller can ask about the waiting tasks they reach */
  apply(raw: string, now = Date.now()): { ok: boolean; error?: string; name?: string; changes: Change[]; refused: ProfileRefusal[]; skipped: string[]; added: string[] } {
    const p = this.find(raw)
    if (!p) return { ok: false, error: `No profile called ${cleanName(raw)}.`, changes: [], refused: [], skipped: [], added: [] }
    const site = this.site()
    const plan = planOf(site, p)
    const refused = refusedBy(site.settings, plan.changes)
    if (refused.length) {
      const n = refused.length
      return { ok: false, error: `Nothing was applied: ${n} ${n === 1 ? 'setting' : 'settings'} would be refused.`, name: p.name, changes: [], refused, skipped: plan.skipped, added: plan.added }
    }
    const f = this.store.f
    const last = f.last
    f.undo = [...f.undo, { name: p.name, at: now, last, changes: plan.changes.map((c) => ({ key: c.key, at: c.at, before: c.now, after: c.then })) }].slice(-UNDO_KEEP)
    write(site.settings, plan.changes)
    p.applied = now
    f.last = { name: p.name, at: now }
    this.store.save()
    this.written(plan.changes)
    return { ok: true, name: p.name, changes: plan.changes, refused: [], skipped: plan.skipped, added: plan.added }
  }

  /** puts back what the last apply changed, where it still reads as the apply left it; the point is then gone, and
   *  the last apply goes back to the one before. kept: what changed since and was left as it is */
  undo(): { ok: boolean; error?: string; name?: string; changes: Change[]; kept: string[]; refused: ProfileRefusal[] } {
    const f = this.store.f
    const u = f.undo.at(-1)
    if (!u) return { ok: false, error: 'Nothing to undo: no profile has been applied.', changes: [], kept: [], refused: [] }
    const site = this.site()
    const live = u.changes.filter((c) => exists(site, c.at))
    const back = live.filter((c) => ownAt(site.settings, c.key, c.at) === c.after)
    const kept = live.filter((c) => !back.includes(c)).map((c) => `${labelOf(c.key)} (${placeOf(site, c.at).where})`)
    const changes: Change[] = back.map((c) => ({ key: c.key, at: c.at, now: c.after, then: c.before, label: labelOf(c.key), ...placeOf(site, c.at) }))
    const refused = refusedBy(site.settings, changes)
    if (refused.length) return { ok: false, error: `Nothing was undone: ${refused.length} ${refused.length === 1 ? 'setting' : 'settings'} would be refused.`, changes: [], kept, refused }
    write(site.settings, changes)
    f.undo = f.undo.slice(0, -1)
    f.last = u.last
    this.store.save()
    this.written(changes)
    return { ok: true, name: u.name, changes, kept, refused: [] }
  }

  rename(raw: string, to: string): { ok: boolean; error?: string } {
    const p = this.find(raw)
    if (!p) return { ok: false, error: `No profile called ${cleanName(raw)}.` }
    const name = cleanName(to)
    const bad = nameProblem(name, this.store.f, p.name)
    if (bad) return { ok: false, error: bad }
    const f = this.store.f
    if (f.last?.name === p.name) f.last = { ...f.last, name }
    p.name = name
    this.store.save()
    return { ok: true }
  }

  remove(raw: string): { ok: boolean; error?: string } {
    const p = this.find(raw)
    if (!p) return { ok: false, error: `No profile called ${cleanName(raw)}.` }
    const f = this.store.f
    f.profiles = f.profiles.filter((x) => x !== p)
    if (f.last?.name === p.name) f.last = undefined
    this.store.save()
    return { ok: true }
  }

  /** a profile in words: what it holds, when it was saved and applied, and each level's set values */
  show(raw: string): string {
    const p = this.find(raw)
    if (!p) throw new Error(`No profile called ${cleanName(raw)}.`)
    const site = this.site()
    const block = (title: string, rec: Rec) => {
      const rows = keysOf(p.limits).filter((k) => rec[k] !== null && rec[k] !== undefined).map((k) => `  ${labelOf(k)}: ${rec[k]}`)
      return [title, ...(rows.length ? rows : ['  nothing set here'])]
    }
    const spaces = Object.keys(p.values.spaces).flatMap((key) => {
      const gone = site.spaces.some((sp) => sp.key === key) ? '' : ' (no longer a space)'
      return block(`${p.names[key] ?? key}${gone}`, p.values.spaces[key]!)
    })
    return [
      `${p.name}: ${holds(p)}, saved ${agoWords(p.saved)}${p.applied ? `, applied ${agoWords(p.applied)}` : ''}`,
      ...block('Everywhere', p.values.all),
      ...block(site.machine.name, p.values.machine),
      ...spaces,
    ].join('\n')
  }

  /** the saved profiles in words, the one in force and the undo point */
  list(): string {
    const v = this.view()
    if (!v.profiles.length) return 'No profiles yet. shepherdr profile save <name> keeps the current settings as one.'
    const rows = v.profiles.map((p) => `${p.name.padEnd(24)} ${holds(p).padEnd(20)} saved ${agoWords(p.saved)}${p.applied ? `, applied ${agoWords(p.applied)}` : ''}`)
    return [...rows, `In force: ${v.active}${v.undo ? `. Undo: ${v.undo.label}` : ''}`].join('\n')
  }

}

/** why a worker keeps no profiles: the main machine keeps them, as it keeps Secrets */
export const PROFILES_ON_MAIN = 'Profiles are kept on the main machine: run this there.'
