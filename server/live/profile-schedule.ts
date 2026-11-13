// Scheduled profiles: a profile may carry schedule rules ("apply night every day at 22:00"), kept on the profile in
// profiles.json. A rule is read with the same time rules as Autopilot's heartbeat and automations (trigger.ts: an
// RRULE, or "once <date> <time>", in the time zone Settings sets; the words "daily 22:00" are read too, as an old
// automation's schedule was). Only the main machine keeps profiles, so only it applies them: tick() finds the rules due
// and applies one through Profiles.apply (all or nothing, with an undo point, as a manual apply does), and reports it
// once in the home space's chat. A refused apply is reported once and not retried: the next due time tries again.
import { randomUUID } from 'node:crypto'
import { RRule, rrulestr, type RRuleSet } from 'rrule'
import type { ProfileScheduleRow } from '../../shared/types.ts'
import { wall } from '../../shared/when.ts'
import type { Change, Profile, ProfileStore, Profiles } from './profiles.ts'
import { fromSchedule, nextRun, nextRuns, runWords, timeRule, timeWords } from './trigger.ts'

/** one schedule rule of a profile, as profiles.json keeps it */
export interface Schedule {
  id: string
  /** the time rule as kept (trigger.ts timeRule): an RRULE, or "once <date> <time>" (then it is off once it ran) */
  when: string
  /** the tasks already created take the profile's task and reviewer settings too, as the apply-waiting question would */
  waiting: boolean
  /** off: kept, never applied */
  on: boolean
  /** when it was made, or its rule or its on switch last changed: its first run is the rule's first after that */
  since: number
  /** the last due time it handled (applied, refused or left out): its next run is the rule's first after it */
  timed?: number
  /** its last run: when, and whether it was applied */
  last?: { at: number; ok: boolean }
}

const DAY = 86_400_000
/** a due time found more than this late means Shepherdr was not running when it came */
const LATE = 2 * 60_000
/** how far back a due time is looked for: a day first, then a week, then a year (a weekly rule may be a week apart) */
const WINDOWS = [DAY, 8 * DAY, 400 * DAY]
/** the most runs of a rule looked at in one window: a rule every minute for a day is 1 440 */
const STEPS = 5000
const pad = (n: number) => String(n).padStart(2, '0')
/** a name as the profiles keep it, on one line (profiles.ts cleanName) */
const cleanName = (raw: string) => raw.replace(/\s+/g, ' ').trim()
const hhmm = (at: number, zone: string) => {
  const w = wall(at, zone)
  return `${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`
}

/** a rule as it is kept, from what a human or the coordinator wrote: words an old automation's schedule read ("daily
 *  22:00", "weekdays 8:00", "mon,fri 16:00", "once 2026-11-20 9:00") or a time rule (an RRULE, "once …"). Throws, saying
 *  how to write one, when neither reads it. */
export function ruleOf(text: string): string {
  return fromSchedule(text.trim()) ?? timeRule(text)
}

/** the latest time a rule came due after `from` and not after `now`, or nothing: looked for from the last day, then the
 *  last week, then the last year, so the search costs what the rule's frequency asks and no more */
export function lastDue(rule: string, zone: string, from: number, now: number): number | undefined {
  for (const w of WINDOWS) {
    const start = Math.max(from, now - w)
    let at: number | undefined
    let cursor = start
    for (let i = 0; i < STEPS; i++) {
      const next = nextRun(rule, zone, cursor)
      if (next === undefined || next > now) break
      at = next
      cursor = next
    }
    if (at !== undefined) return at
    if (start === from) break
  }
  return undefined
}

/** the time and days a rule of the editor's shape has: one time a day, every day (days null) or on some days (0 is
 *  Monday). Nothing for a rule it doesn't write (every 30 minutes, several times a day, a once) */
export function formOf(kept: string): { time: string; days: number[] | null } | undefined {
  if (kept.startsWith('once ')) return undefined
  const set = rrulestr(kept.split(' ').join('\n'), { forceset: true }) as RRuleSet
  const o = set.rrules()[0]?.origOptions
  if (!o || (o.freq !== RRule.DAILY && o.freq !== RRule.WEEKLY) || (o.interval ?? 1) !== 1) return undefined
  const hours = o.byhour == null ? [] : ([] as number[]).concat(o.byhour)
  const minutes = o.byminute == null ? [] : ([] as number[]).concat(o.byminute)
  if (hours.length !== 1 || minutes.length !== 1) return undefined
  // BYDAY as rrule keeps it: a weekday number (0 Monday), or a weekday with an occurrence (MO, +1MO), or a list of them
  const byday = o.byweekday == null ? [] : ([] as unknown[]).concat(o.byweekday)
  const weekday = (d: unknown) => (typeof d === 'number' ? d : typeof d === 'object' && d && 'weekday' in d ? Number(d.weekday) : RRule[String(d).slice(-2) as 'MO'].weekday)
  const days = byday.length ? [...new Set(byday.map(weekday))].sort((a, b) => a - b) : null
  return { time: `${pad(hours[0]!)}:${pad(minutes[0]!)}`, days }
}

/** a schedule's rows for the screen and the command line: its rule in words, its next and last run, and its editor's shape */
export function scheduleRows(p: Pick<Profile, 'schedules'>, zone: string, now = Date.now()): ProfileScheduleRow[] {
  return (p.schedules ?? []).map((s) => {
    const next = s.on ? nextRun(s.when, zone, now) : undefined
    const form = formOf(s.when)
    return {
      id: s.id,
      words: timeWords(s.when, zone, now),
      waiting: s.waiting,
      on: s.on,
      ...(form ? { form } : {}),
      ...(next !== undefined ? { next: runWords(next, zone, now) } : {}),
      ...(s.last ? { last: `${s.last.ok ? 'Applied' : 'Not applied'} ${runWords(s.last.at, zone, now)}` } : {}),
    }
  })
}

/** the next runs of every profile's schedules, in words: "Next: night at 22:00, then day at 08:00"; nothing when none is on */
export function nextLine(profiles: Pick<Profile, 'name' | 'schedules'>[], zone: string, now = Date.now()): string | undefined {
  const runs = profiles
    .flatMap((p) => (p.schedules ?? []).filter((s) => s.on).flatMap((s) => nextRuns(s.when, zone, now, 1).map((at) => ({ name: p.name, at }))))
    .sort((a, b) => a.at - b.at)
    .slice(0, 2)
  if (!runs.length) return undefined
  const words = runs.map((r) => (r.at - now < DAY ? `${r.name} at ${hhmm(r.at, zone)}` : `${r.name} on ${runWords(r.at, zone, now)}`))
  return `Next: ${words.join(', then ')}`
}

/** the schedule's rule in one line, as the list of a profile's schedules says it: "Every day at 22:00 (Madrid) · also the waiting tasks" */
export function scheduleWords(s: Pick<Schedule, 'when' | 'waiting' | 'on'>, zone: string, now = Date.now()): string {
  return [timeWords(s.when, zone, now), s.waiting ? 'also the waiting tasks' : '', s.on ? '' : 'off'].filter(Boolean).join(' · ')
}

/** the store and the profiles, as the scheduler needs them from the caller: the zone, whether this machine keeps and
 *  applies profiles, what a waiting-tasks change moved (in words), and where a line for the human goes */
export interface ScheduleEnv {
  zone(): string
  main(): boolean
  retune(changes: Change[]): string[]
  report(text: string, failed: boolean, profile: string): void
}

/** the profiles' schedules: added, edited and removed by name, and applied when due (tick) */
export class ProfileSchedules {
  constructor(
    private store: ProfileStore,
    private profiles: Profiles,
    private env: ScheduleEnv,
  ) {}

  /** a new schedule for a profile: a rule (ruleOf's words or time rule) that may come due, on or off, waiting tasks too or not */
  add(raw: string, rule: string, o: { waiting?: boolean; on?: boolean } = {}, now = Date.now()): { ok: boolean; error?: string; profile?: string; schedule?: Schedule } {
    const p = this.profiles.find(raw)
    if (!p) return { ok: false, error: `No profile called ${cleanName(raw)}.` }
    let when: string
    try {
      when = ruleOf(rule)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    const zone = this.env.zone()
    if (when === 'off') return { ok: false, error: 'Say when it applies, like "daily 22:00" or FREQ=DAILY;BYHOUR=22;BYMINUTE=0.' }
    if (when.startsWith('once ') && nextRun(when, zone, now) === undefined) return { ok: false, error: `${rule.trim()} has passed. Say a time to come.` }
    const s: Schedule = { id: randomUUID().slice(0, 8), when, waiting: !!o.waiting, on: o.on !== false, since: now }
    p.schedules = [...(p.schedules ?? []), s]
    this.store.save()
    return { ok: true, profile: p.name, schedule: s }
  }

  /** changes a schedule's rule, waiting tasks or on switch. A new rule counts from now, and so does one switched on again:
   *  a schedule switched off is not caught up when it comes back */
  edit(raw: string, id: string, c: { rule?: string; waiting?: boolean; on?: boolean }, now = Date.now()): { ok: boolean; error?: string } {
    const s = this.schedule(raw, id)
    if (!s) return { ok: false, error: `No schedule ${id} on ${cleanName(raw)}.` }
    let when = s.when
    if (c.rule !== undefined) {
      try {
        when = ruleOf(c.rule)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      if (when === 'off') return { ok: false, error: 'Say when it applies, like "daily 22:00" or FREQ=DAILY;BYHOUR=22;BYMINUTE=0.' }
    }
    const restart = c.rule !== undefined || (c.on === true && !s.on)
    if (restart) {
      s.since = now
      delete s.timed
    }
    s.when = when
    if (c.waiting !== undefined) s.waiting = c.waiting
    if (c.on !== undefined) s.on = c.on
    this.store.save()
    return { ok: true }
  }

  /** removes a schedule of a profile; the profile stays */
  remove(raw: string, id: string): { ok: boolean; error?: string } {
    const p = this.profiles.find(raw)
    if (!p || !this.schedule(raw, id)) return { ok: false, error: `No schedule ${id} on ${cleanName(raw)}.` }
    p.schedules = (p.schedules ?? []).filter((s) => s.id !== id)
    this.store.save()
    return { ok: true }
  }

  private schedule(raw: string, id: string): Schedule | undefined {
    return this.profiles.find(raw)?.schedules?.find((s) => s.id === id)
  }

  /** applies the schedules due by now, once each. The latest due time wins; a rule due at the same time as another is the
   *  one defined later (its since, then its place in the list), and the others due by now are left out. Each due one is
   *  marked handled, so it is never run twice, and a refused apply waits for its next time. */
  tick(now = Date.now()): void {
    if (!this.env.main()) return
    const zone = this.env.zone()
    const due: { p: Profile; s: Schedule; at: number; i: number; n: number }[] = []
    this.store.f.profiles.forEach((p, i) =>
      (p.schedules ?? []).forEach((s, n) => {
        if (!s.on) return
        const at = lastDue(s.when, zone, s.timed ?? s.since, now)
        if (at !== undefined) due.push({ p, s, at, i, n })
      }),
    )
    if (!due.length) return
    due.sort((a, b) => b.at - a.at || b.s.since - a.s.since || b.i - a.i || b.n - a.n)
    const [win, ...left] = due
    const { p, s } = win
    const late = now - win.at > LATE
    const when = runWords(win.at, zone, now)
    // the rules left out are handled too: they are not run later on
    const skipped = left.map((d) => {
      d.s.timed = d.at
      const rule = `${d.p.name}'s ${hhmm(d.at, zone)} rule`
      return d.at === win.at ? `${rule} was left out: ${p.name}'s was defined later.` : `${rule} was left out: only the latest due one applies.`
    })
    const r = this.profiles.apply(p.name, now)
    s.timed = win.at
    s.last = { at: win.at, ok: r.ok }
    if (s.when.startsWith('once ')) s.on = false
    const next = s.on ? nextRun(s.when, zone, now) : undefined
    const after = next === undefined ? 'It has no next time.' : `Its next time is ${runWords(next, zone, now)}.`
    let text: string
    if (!r.ok) {
      const why = (r.refused ?? []).map((x) => `${x.where} · ${x.label}: ${x.error.replace(/\.+$/, '')}`)
      text = [`${p.name} was not applied, due ${when}. ${r.error ?? 'Nothing was applied.'}`, ...(why.length ? [`${why.join('; ')}.`] : []), after, ...skipped].join(' ')
    } else {
      const n = r.changes.length
      const head = late ? `${p.name} was due ${when}, while Shepherdr was not running, and is applied now` : `Applied ${p.name}, due ${when}`
      // a waiting task reached by what changed takes it now, as the apply-waiting question would make it
      const moved = s.waiting && n ? this.env.retune(r.changes) : []
      text = [n ? `${head}: ${n} ${n === 1 ? 'setting' : 'settings'} changed. Undo last apply puts them back.` : `${head}: nothing changed, the settings read as ${p.name} says already.`, ...moved, ...skipped].join(' ')
    }
    this.store.save()
    this.env.report(text, !r.ok, p.name)
  }
}
