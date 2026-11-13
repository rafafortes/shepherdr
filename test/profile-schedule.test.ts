// Scheduled profiles, the module's side: a rule due applies its profile once (all or nothing, with an undo point), a
// late one applies the latest due time only, a refused apply is reported once, the waiting tasks follow when asked, a
// worker applies nothing, and the words the rules read and write are the ones Autopilot's time rules use.
import { describe, expect, test } from 'bun:test'
import { formOf, lastDue, nextLine, ProfileSchedules, ruleOf, scheduleRows, scheduleWords, type ScheduleEnv } from '../server/live/profile-schedule.ts'
import { Profiles, ProfileStore, type Change } from '../server/live/profiles.ts'
import { Settings } from '../server/live/settings.ts'

const ZONE = 'Europe/Madrid'
/** Madrid is an hour ahead of UTC in November: 22:00 there is 21:00 UTC */
const at = (iso: string) => Date.parse(iso)
const NIGHT = 'FREQ=DAILY;BYHOUR=22;BYMINUTE=0'
const DAY = 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0'

/** a world of its own: this machine's settings, a profile store in memory, a scheduler whose env is recorded */
function world(main = true) {
  const s = new Settings({ everywhere: { 'time.zone': ZONE, 'task.agent': 'Codex' }, machine: {}, spaces: {} })
  const store = new ProfileStore(true)
  const spaces = [{ key: 'gtm', name: 'gtm' }]
  const profiles = new Profiles(store, () => ({ settings: s, machine: { host: 'box', name: 'box' }, spaces }), () => undefined)
  const retuned: Change[][] = []
  const reports: { text: string; failed: boolean; profile: string }[] = []
  const env: ScheduleEnv = {
    zone: () => ZONE,
    main: () => main,
    retune: (c) => {
      retuned.push(c)
      return ['2 waiting tasks changed.']
    },
    report: (text, failed, profile) => reports.push({ text, failed, profile }),
  }
  const sched = new ProfileSchedules(store, profiles, env)
  /** a profile of the settings as they are now (Codex everywhere), so it is in force until something changes */
  const save = (name: string) => profiles.save(name, { force: true })
  return { s, store, profiles, sched, retuned, reports, save }
}

/** the profile set to `agent`, as the settings read it when its schedule comes due */
function setAgent(w: ReturnType<typeof world>, agent: string) {
  w.s.set('task.agent', agent, 'all')
}

describe('the rules: the words and the time rules Autopilot reads', () => {
  test('a rule is read as an old automation schedule or as a time rule, and refused otherwise', () => {
    expect(ruleOf('daily 22:00')).toBe('DTSTART:20260101T000000 RRULE:FREQ=DAILY;BYHOUR=22;BYMINUTE=0')
    expect(ruleOf('weekdays 8:00')).toBe('DTSTART:20260101T000000 RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0')
    expect(ruleOf(NIGHT)).toBe(`DTSTART:20260101T000000 RRULE:${NIGHT}`)
    expect(ruleOf('once 2026-11-20 9:00')).toBe('once 2026-11-20 09:00')
    expect(ruleOf('off')).toBe('off')
    expect(() => ruleOf('every evening, more or less')).toThrow(/Can't read the time rule/)
  })

  test('the editor reads back the rules it writes, and not the others', () => {
    expect(formOf(ruleOf('daily 22:00'))).toEqual({ time: '22:00', days: null })
    expect(formOf(ruleOf('weekdays 8:00'))).toEqual({ time: '08:00', days: [0, 1, 2, 3, 4] })
    expect(formOf(ruleOf('mon,fri 16:30'))).toEqual({ time: '16:30', days: [0, 4] })
    expect(formOf(ruleOf('once 2026-11-20 9:00'))).toBeUndefined()
    expect(formOf(ruleOf('FREQ=MINUTELY;INTERVAL=30'))).toBeUndefined()
    expect(formOf(ruleOf('FREQ=DAILY;BYHOUR=8,22;BYMINUTE=0'))).toBeUndefined()
  })

  test('the next line names the two soonest runs, in the zone of Settings', () => {
    const now = at('2026-11-13T20:00:00Z') // 21:00 in Madrid: night is an hour away, day is tomorrow
    const profiles = [
      { name: 'day', schedules: [{ id: 'd', when: ruleOf('daily 8:00'), waiting: false, on: true, since: 0 }] },
      { name: 'night', schedules: [{ id: 'n', when: ruleOf('daily 22:00'), waiting: false, on: true, since: 0 }] },
      { name: 'off', schedules: [{ id: 'x', when: ruleOf('daily 21:30'), waiting: false, on: false, since: 0 }] },
    ]
    expect(nextLine(profiles, ZONE, now)).toBe('Next: night at 22:00, then day at 08:00')
    // a run more than a day off gives its day
    expect(nextLine([{ name: 'weekly', schedules: [{ id: 'w', when: ruleOf('mon 8:00'), waiting: false, on: true, since: 0 }] }], ZONE, now)).toBe('Next: weekly on Mon 16 Nov 8:00')
    expect(nextLine(profiles.slice(2), ZONE, now)).toBeUndefined()
    expect(nextLine([], ZONE, now)).toBeUndefined()
  })

  test('a schedule in words: its time rule, the waiting tasks, and off', () => {
    expect(scheduleWords({ when: ruleOf('daily 22:00'), waiting: true, on: true }, ZONE)).toBe('Every day at 22:00 (Madrid) · also the waiting tasks')
    expect(scheduleWords({ when: ruleOf('weekdays 8:00'), waiting: false, on: false }, ZONE)).toBe('Monday to Friday at 8:00 (Madrid) · off')
  })
})

describe('lastDue: the latest time a rule came due, looked for by how far back it has to be', () => {
  test('a daily rule: the last 22:00 before now, and nothing before its first', () => {
    const rule = ruleOf('daily 22:00')
    expect(lastDue(rule, ZONE, at('2026-11-12T20:00:00Z'), at('2026-11-13T21:30:00Z'))).toBe(at('2026-11-13T21:00:00Z'))
    expect(lastDue(rule, ZONE, at('2026-11-13T21:00:00Z'), at('2026-11-13T21:30:00Z'))).toBeUndefined()
    // a week back: a weekly rule's last time is found too
    expect(lastDue(ruleOf('mon 8:00'), ZONE, at('2026-11-01T00:00:00Z'), at('2026-11-13T12:00:00Z'))).toBe(at('2026-11-09T07:00:00Z'))
    // a rule that never came due in the search window is none
    expect(lastDue(ruleOf('once 2026-11-20 9:00'), ZONE, at('2026-11-13T00:00:00Z'), at('2026-11-13T12:00:00Z'))).toBeUndefined()
  })

  test('a rule every few minutes is looked at a day back, without walking all its runs', () => {
    const rule = ruleOf('FREQ=MINUTELY;INTERVAL=30')
    expect(lastDue(rule, ZONE, at('2026-11-01T00:00:00Z'), at('2026-11-13T12:10:00Z'))).toBe(at('2026-11-13T12:00:00Z'))
  })
})

describe('tick: a due rule applies its profile once, and says so', () => {
  test('due now: applied once, not again in the same minute, and again the next day', () => {
    const w = world()
    w.save('night')
    setAgent(w, 'pi')
    w.sched.add('night', 'daily 22:00', {}, at('2026-11-13T12:00:00Z'))
    w.sched.tick(at('2026-11-13T20:59:50Z'))
    expect(w.reports).toEqual([])
    w.sched.tick(at('2026-11-13T21:00:00Z'))
    expect(w.s.pick('task.agent', 'all').value).toBe('Codex')
    expect(w.reports).toEqual([{ text: 'Applied night, due Today 22:00: 1 setting changed. Undo last apply puts them back.', failed: false, profile: 'night' }])
    expect(w.store.f.undo.length).toBe(1)
    expect(w.store.f.last?.name).toBe('night')
    // a second tick in the same minute, and one later in it, do nothing
    setAgent(w, 'pi')
    w.sched.tick(at('2026-11-13T21:00:30Z'))
    w.sched.tick(at('2026-11-13T21:00:59Z'))
    expect(w.reports.length).toBe(1)
    expect(w.s.pick('task.agent', 'all').value).toBe('pi')
    // the next day it runs again
    w.sched.tick(at('2026-11-14T21:00:00Z'))
    expect(w.reports.length).toBe(2)
    expect(w.reports[1]!.text).toContain('Applied night, due Today 22:00')
  })

  test('a profile already in force is reported as such, with nothing changed and nothing undone', () => {
    const w = world()
    w.save('same')
    w.sched.add('same', 'daily 22:00', {}, at('2026-11-13T12:00:00Z'))
    w.sched.tick(at('2026-11-13T21:00:00Z'))
    expect(w.reports).toEqual([{ text: 'Applied same, due Today 22:00: nothing changed, the settings read as same says already.', failed: false, profile: 'same' }])
    expect(w.s.pick('task.agent', 'all').value).toBe('Codex')
  })

  test('a rule switched off, and one that is not due, apply nothing', () => {
    const w = world()
    w.save('night')
    setAgent(w, 'pi')
    const x = w.sched.add('night', 'daily 22:00', { on: false }, at('2026-11-13T12:00:00Z'))
    expect(x.ok).toBe(true)
    w.sched.tick(at('2026-11-13T21:00:00Z'))
    w.sched.add('night', 'daily 23:00', {}, at('2026-11-13T12:00:00Z'))
    w.sched.tick(at('2026-11-13T21:00:00Z'))
    expect(w.reports).toEqual([])
    expect(w.s.pick('task.agent', 'all').value).toBe('pi')
  })

  test('a worker applies nothing: it keeps no profiles, and its schedules are not run', () => {
    const w = world(false)
    w.save('night')
    setAgent(w, 'pi')
    w.sched.add('night', 'daily 22:00', {}, at('2026-11-13T12:00:00Z'))
    w.sched.tick(at('2026-11-13T21:00:00Z'))
    expect(w.reports).toEqual([])
    expect(w.s.pick('task.agent', 'all').value).toBe('pi')
  })

  test('Shepherdr off at a due time: on start, the latest due one applies, once, and the earlier ones are left out', () => {
    const w = world()
    w.save('night')
    w.save('day')
    setAgent(w, 'pi')
    w.sched.add('night', 'daily 22:00', {}, at('2026-11-12T12:00:00Z'))
    w.sched.add('day', 'daily 8:00', {}, at('2026-11-12T12:00:00Z'))
    // last ran at 09:00 on the 12th; it starts at 09:30 on the 13th: 22:00 on the 12th and 08:00 on the 13th came due while off
    w.sched.tick(at('2026-11-12T08:00:00Z'))
    w.sched.tick(at('2026-11-13T08:30:00Z'))
    expect(w.reports.length).toBe(1)
    expect(w.reports[0]!.profile).toBe('day')
    expect(w.reports[0]!.text).toContain('day was due Today 8:00, while Shepherdr was not running, and is applied now: 1 setting changed.')
    expect(w.reports[0]!.text).toContain("night's 22:00 rule was left out: only the latest due one applies.")
    // a week off: still one apply, the latest
    setAgent(w, 'pi')
    w.sched.tick(at('2026-11-20T08:30:00Z'))
    expect(w.reports.length).toBe(2)
    expect(w.s.pick('task.agent', 'all').value).toBe('Codex')
  })

  test('a late tick says it was applied late, with the time it was due', () => {
    const w = world()
    w.save('night')
    setAgent(w, 'pi')
    w.sched.add('night', 'daily 22:00', {}, at('2026-11-12T12:00:00Z'))
    w.sched.tick(at('2026-11-12T11:00:00Z'))
    expect(w.reports).toEqual([])
    // on at 09:00 the next day: the 22:00 of the day before came due while it was not running
    w.sched.tick(at('2026-11-13T09:00:00Z'))
    expect(w.reports.length).toBe(1)
    expect(w.reports[0]!.text).toBe('night was due Thu 12 Nov 22:00, while Shepherdr was not running, and is applied now: 1 setting changed. Undo last apply puts them back.')
  })

  test('two rules due at the same minute: the one defined later wins, the other is left out and says so', () => {
    const w = world()
    w.save('night')
    w.save('day')
    setAgent(w, 'pi')
    w.sched.add('day', 'daily 22:00', {}, at('2026-11-13T12:00:00Z'))
    w.sched.add('night', 'daily 22:00', {}, at('2026-11-13T13:00:00Z'))
    w.sched.tick(at('2026-11-13T21:00:00Z'))
    expect(w.reports.length).toBe(1)
    expect(w.reports[0]!.profile).toBe('night')
    expect(w.reports[0]!.text).toContain("day's 22:00 rule was left out: night's was defined later.")
    // the left one is handled: it does not come back on the next tick
    w.sched.tick(at('2026-11-13T21:00:30Z'))
    expect(w.reports.length).toBe(1)
  })

  test('a refused apply is reported once, with what was refused, and the next due time tries again', () => {
    const w = world()
    w.save('broken')
    w.store.f.profiles[0]!.values.all['task.model'] = 'bad!'
    w.sched.add('broken', 'daily 22:00', {}, at('2026-11-13T12:00:00Z'))
    w.sched.tick(at('2026-11-13T21:00:00Z'))
    expect(w.reports.length).toBe(1)
    expect(w.reports[0]!.failed).toBe(true)
    expect(w.reports[0]!.text).toMatch(/^broken was not applied, due Today 22:00\. Nothing was applied: 1 setting would be refused\. Everywhere · Tasks · Primary · Model: /)
    expect(w.reports[0]!.text.endsWith('Its next time is Tomorrow 22:00.')).toBe(true)
    // not retried in a loop: the same minute and the next minute say nothing
    w.sched.tick(at('2026-11-13T21:00:30Z'))
    w.sched.tick(at('2026-11-13T21:01:00Z'))
    expect(w.reports.length).toBe(1)
    expect(w.store.f.profiles[0]!.schedules![0]!.last).toEqual({ at: at('2026-11-13T21:00:00Z'), ok: false })
    // the next time tries again, and this time it is fixed, so it applies
    w.store.f.profiles[0]!.values.all['task.model'] = null
    w.sched.tick(at('2026-11-14T21:00:00Z'))
    expect(w.reports.length).toBe(2)
    expect(w.reports[1]!.failed).toBe(false)
  })

  test('the waiting tasks: a rule that says so moves them with its change, without a question; one that does not leaves them', () => {
    const w = world()
    w.save('night')
    setAgent(w, 'pi')
    w.sched.add('night', 'daily 22:00', { waiting: true }, at('2026-11-13T12:00:00Z'))
    w.sched.tick(at('2026-11-13T21:00:00Z'))
    expect(w.retuned.length).toBe(1)
    expect(w.retuned[0]!.map((c) => c.key)).toEqual(['task.agent'])
    expect(w.reports[0]!.text).toContain('2 waiting tasks changed.')
    // without waiting: no move, however many changes
    setAgent(w, 'pi')
    w.sched.edit('night', w.store.f.profiles[0]!.schedules![0]!.id, { waiting: false }, at('2026-11-13T21:00:30Z'))
    w.sched.edit('night', w.store.f.profiles[0]!.schedules![0]!.id, { rule: 'daily 22:05' }, at('2026-11-13T21:00:30Z'))
    w.sched.tick(at('2026-11-13T21:05:00Z'))
    expect(w.retuned.length).toBe(1)
    expect(w.reports.at(-1)!.text).not.toContain('waiting')
  })

  test('a once rule applies once and then is off', () => {
    const w = world()
    w.save('night')
    setAgent(w, 'pi')
    w.sched.add('night', 'once 2026-11-13 22:00', {}, at('2026-11-13T12:00:00Z'))
    w.sched.tick(at('2026-11-13T21:00:00Z'))
    expect(w.reports.length).toBe(1)
    expect(w.store.f.profiles[0]!.schedules![0]!.on).toBe(false)
    w.sched.tick(at('2026-11-14T21:00:00Z'))
    expect(w.reports.length).toBe(1)
  })
})

describe('add, edit and remove: what they keep, and what they refuse', () => {
  test('a schedule is added to a profile with its id; a name that is none, or a rule that passed or reads wrong, is refused', () => {
    const w = world()
    w.save('night')
    const now = at('2026-11-13T12:00:00Z')
    const added = w.sched.add('night', 'daily 22:00', { waiting: true }, now)
    expect(added).toMatchObject({ ok: true, profile: 'night', schedule: { when: ruleOf('daily 22:00'), waiting: true, on: true, since: now } })
    expect(w.sched.add('nope', 'daily 22:00', {}, now)).toEqual({ ok: false, error: 'No profile called nope.' })
    expect(w.sched.add('night', 'off', {}, now)).toEqual({ ok: false, error: 'Say when it applies, like "daily 22:00" or FREQ=DAILY;BYHOUR=22;BYMINUTE=0.' })
    expect(w.sched.add('night', 'once 2026-11-01 9:00', {}, now)).toEqual({ ok: false, error: 'once 2026-11-01 9:00 has passed. Say a time to come.' })
    expect(w.sched.add('night', 'sometimes', {}, now).ok).toBe(false)
    expect(w.store.f.profiles[0]!.schedules!.length).toBe(1)
  })

  test('a rule edited counts from now; a schedule switched on again is not caught up; the waiting tasks and the on switch change alone', () => {
    const w = world()
    w.save('night')
    const id = w.sched.add('night', 'daily 22:00', {}, at('2026-11-10T12:00:00Z')).schedule!.id
    expect(w.sched.edit('night', id, { on: false }, at('2026-11-11T12:00:00Z'))).toEqual({ ok: true })
    // off for days: switched on at 12:00 on the 13th, the 22:00 of the 11th and the 12th are not applied
    expect(w.sched.edit('night', id, { on: true }, at('2026-11-13T12:00:00Z'))).toEqual({ ok: true })
    setAgent(w, 'pi')
    w.sched.tick(at('2026-11-13T12:30:00Z'))
    expect(w.reports).toEqual([])
    expect(w.sched.edit('night', id, { waiting: true }, at('2026-11-13T12:30:00Z'))).toEqual({ ok: true })
    expect(w.store.f.profiles[0]!.schedules![0]!.since).toBe(at('2026-11-13T12:00:00Z'))
    expect(w.sched.edit('night', id, { rule: 'daily 21:00' }, at('2026-11-13T12:30:00Z'))).toEqual({ ok: true })
    expect(w.store.f.profiles[0]!.schedules![0]).toMatchObject({ when: ruleOf('daily 21:00'), since: at('2026-11-13T12:30:00Z'), waiting: true })
    expect(w.sched.edit('night', id, { rule: 'sometimes' }, at('2026-11-13T12:30:00Z')).ok).toBe(false)
    expect(w.sched.edit('night', 'nope', { on: true }, at('2026-11-13T12:30:00Z'))).toEqual({ ok: false, error: 'No schedule nope on night.' })
  })

  test('remove takes one schedule off; the profile and its others stay; a profile removed takes all of them', () => {
    const w = world()
    w.save('night')
    const a = w.sched.add('night', 'daily 22:00', {}).schedule!.id
    const b = w.sched.add('night', 'weekdays 8:00', {}).schedule!.id
    expect(w.sched.remove('night', a)).toEqual({ ok: true })
    expect(w.store.f.profiles[0]!.schedules!.map((x) => x.id)).toEqual([b])
    expect(w.sched.remove('night', a)).toEqual({ ok: false, error: `No schedule ${a} on night.` })
    w.profiles.remove('night')
    expect(w.store.f.profiles).toEqual([])
  })

  test('a re-save of a profile keeps its schedules; the profile view says each one in words, with its last run and next', () => {
    const w = world()
    w.save('night')
    w.sched.add('night', 'daily 22:00', { waiting: true }, at('2026-11-13T12:00:00Z'))
    w.save('night')
    expect(w.store.f.profiles[0]!.schedules?.length).toBe(1)
    const v = w.profiles.view()
    const now = Date.now()
    expect(v.profiles[0]!.schedules).toEqual(scheduleRows(w.store.f.profiles[0]!, ZONE, now))
    expect(v.profiles[0]!.schedules![0]).toMatchObject({ words: 'Every day at 22:00 (Madrid)', waiting: true, on: true, form: { time: '22:00', days: null }, next: expect.any(String) })
    expect(v.next).toMatch(/^Next: night (at 22:00|on )/)
    expect(v.next).toBe(nextLine(w.store.f.profiles, ZONE, now))
  })
})
