// Scheduled profiles, the live source's side: the actions the screen sends, a due schedule applied on its time with a
// card in the home space's chat, its waiting tasks moved with it without a question, and a refused apply alerted once
// and tried again at its next time. The tick is given the due time itself (the schedule's own next run), never a clock.
import { afterAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import type { ProfilesView } from '../shared/types.ts'
import { nextRun } from '../server/live/trigger.ts'
import { tmp } from './tmp.ts'

const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { fakeHerdr } = await import('./fake-herdr.ts')
const { Worktrees } = await import('../server/live/engine/worktrees.ts')

const src = new LiveSource()
// herdr makes task worktrees: a stand-in on real git, and no terminal for their agents (no herdr is there)
const fake = fakeHerdr()
fake.h.createTab = async () => {
  throw new Error('herdr is not here')
}
Object.assign(src.engine, { wt: new Worktrees(fake.h as never) })
afterAll(() => src.stop())

const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'
const run = (cmd: string, cwd: string) => execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8', timeout: 30_000 }).trim()
const idOf = (out: string) => out.match(/([A-Z]+-\d+)/)![1]
const view = () => src.profiles.view()
/** the schedules of a profile, as the view names them */
const rowsOf = (name: string) => view().profiles.find((p) => p.name === name)?.schedules ?? []
/** the first run a schedule is due at, from when it was made */
const dueOf = (name: string) => {
  const s = src.profiles.find(name)!.schedules![0]!
  return nextRun(s.when, src.settings.zone(), s.since)!
}
/** the cards the home space's chat got from schedules */
const homeCards = () => src.chats.log(placeId.home()).posted.filter((p) => p.id.startsWith('profile-schedule:')).map((p) => p.card?.text)

describe('scheduled profiles: the actions the screen sends', () => {
  test('a schedule is added, changed, switched off and removed; the view names each one and the next run; a rule that reads wrong is refused', async () => {
    expect(await src.act({ type: 'profile-save', name: 'sa-night', force: true })).toMatchObject({ ok: true })
    expect(await src.act({ type: 'profile-schedule', name: 'sa-night', rule: 'daily 22:00', waiting: true })).toMatchObject({ ok: true })
    const row = rowsOf('sa-night')[0]!
    expect(row).toMatchObject({ words: expect.stringMatching(/^Every day at 22:00/), waiting: true, on: true, form: { time: '22:00', days: null } })
    expect(view().next).toMatch(/^Next: sa-night (at 22:00|on )/)
    expect(await src.act({ type: 'profile-schedule', name: 'sa-night', rule: 'sometimes' })).toMatchObject({ ok: false })
    expect(await src.act({ type: 'profile-schedule', name: 'nope', rule: 'daily 22:00' })).toEqual({ ok: false, error: 'No profile called nope.' })
    expect(await src.act({ type: 'profile-schedule', name: 'sa-night', id: row.id, on: false })).toEqual({ ok: true })
    expect(rowsOf('sa-night')[0]).toMatchObject({ on: false })
    expect(view().next).toBeUndefined()
    expect(await src.act({ type: 'profile-schedule', name: 'sa-night', id: row.id, rule: 'weekdays 8:00', waiting: false, on: true })).toEqual({ ok: true })
    expect(rowsOf('sa-night')[0]).toMatchObject({ words: expect.stringMatching(/^Monday to Friday at 8:00/), waiting: false, on: true, form: { time: '08:00', days: [0, 1, 2, 3, 4] } })
    expect(await src.act({ type: 'profile-schedule-remove', name: 'sa-night', id: row.id })).toEqual({ ok: true })
    expect(rowsOf('sa-night')).toEqual([])
    expect(await src.act({ type: 'profile-schedule-remove', name: 'sa-night', id: row.id })).toEqual({ ok: false, error: `No schedule ${row.id} on sa-night.` })
    expect(await src.act({ type: 'profile-delete', name: 'sa-night' })).toEqual({ ok: true })
  })
})

describe('scheduled profiles: a due one applies, says so, and moves what it reaches', () => {
  test('a due schedule applies its profile, keeps an undo point, moves the waiting tasks with no question, and posts one card in the home chat', async () => {
    const dir = tmp('sched-due')
    run(REPO, dir)
    const p = await src.places.add(dir, 'sched-due')
    const place = placeId.space(p.name)
    const engine = src.engine as unknown as { machine?: () => { busy?: string; herdr: boolean } }
    const was = engine.machine
    // herdr not answering holds both tasks: they wait
    engine.machine = () => ({ herdr: false })
    try {
      const a = idOf((await src.cli(['task', 'add', 'Waits for a schedule', '--desc', 'x'], { chat: place })).out)
      idOf((await src.cli(['task', 'add', 'Waits too', '--desc', 'y'], { chat: place })).out)
      // the space's own pi, saved as the night profile; then changed by hand, so the due apply changes it back
      expect(await src.act({ type: 'setting', key: 'task.agent', value: 'pi', place })).toEqual({ ok: true })
      expect(await src.act({ type: 'profile-save', name: 'sd-pi', force: true })).toMatchObject({ ok: true })
      expect(await src.act({ type: 'setting', key: 'task.agent', value: 'Claude Code', place })).toEqual({ ok: true })
      expect(await src.act({ type: 'profile-schedule', name: 'sd-pi', rule: 'daily 22:00', waiting: true })).toMatchObject({ ok: true })
      const before = homeCards().length
      src.profileSchedules.tick(dueOf('sd-pi') - 60_000)
      expect(homeCards().length).toBe(before)
      src.profileSchedules.tick(dueOf('sd-pi'))
      expect(src.settings.pick('task.agent', { space: p.name })).toMatchObject({ value: 'pi', from: 'space' })
      expect(homeCards().length).toBe(before + 1)
      const card = homeCards().at(-1)!
      expect(card).toMatch(/^Applied sd-pi, due .*: 1 setting changed\. Undo last apply puts them back\. .*2 waiting tasks in .* will start on pi/)
      // the apply kept an undo point, and the task moved with it
      expect(view().undo?.name).toBe('sd-pi')
      expect(src.engine.task(a)!.agent).toMatchObject({ kind: 'pi' })
      // the same minute again does nothing
      src.profileSchedules.tick(dueOf('sd-pi') + 30_000)
      expect(homeCards().length).toBe(before + 1)
    } finally {
      engine.machine = was
      await src.act({ type: 'profile-delete', name: 'sd-pi' })
    }
  })

  test('a refused scheduled apply is alerted once and posted once; its next time tries again and is refused again the same way', async () => {
    expect(await src.act({ type: 'profile-save', name: 'sr-bad', force: true })).toMatchObject({ ok: true })
    src.profiles.find('sr-bad')!.values.all['task.model'] = 'bad!'
    expect(await src.act({ type: 'profile-schedule', name: 'sr-bad', rule: 'daily 23:00' })).toMatchObject({ ok: true })
    const alerts: { title: string; tag?: string; body: string }[] = []
    const alert = src.alert
    src.alert = ((a: { title: string; tag?: string; body: string }) => alerts.push(a)) as never
    try {
      const before = homeCards().length
      const due = dueOf('sr-bad')
      src.profileSchedules.tick(due)
      expect(homeCards().length).toBe(before + 1)
      expect(homeCards().at(-1)).toMatch(/^sr-bad was not applied, due .*\. Nothing was applied: 1 setting would be refused\. Everywhere · Tasks · Primary · Model: /)
      expect(alerts.map((a) => [a.title, a.tag])).toEqual([['sr-bad was not applied', 'profile-schedule:sr-bad']])
      // the minute after: nothing again
      src.profileSchedules.tick(due + 60_000)
      expect(alerts.length).toBe(1)
      // the next day: tried again, refused again, said again
      src.profileSchedules.tick(due + 86_400_000)
      expect(alerts.length).toBe(2)
      expect(homeCards().length).toBe(before + 2)
    } finally {
      src.alert = alert
    }
    expect(await src.act({ type: 'profile-delete', name: 'sr-bad' })).toEqual({ ok: true })
  })

  test('the view names the next two runs across the profiles, in the time zone of Settings', async () => {
    expect(await src.act({ type: 'profile-save', name: 'sn-day', force: true })).toMatchObject({ ok: true })
    expect(await src.act({ type: 'profile-save', name: 'sn-night', force: true })).toMatchObject({ ok: true })
    expect(await src.act({ type: 'profile-schedule', name: 'sn-day', rule: 'daily 8:00' })).toMatchObject({ ok: true })
    expect(await src.act({ type: 'profile-schedule', name: 'sn-night', rule: 'daily 22:00' })).toMatchObject({ ok: true })
    const next = view().next!
    expect(next).toMatch(/^Next: sn-(day|night) (at|on) \S.*, then sn-(day|night) (at|on) \S/)
    expect(next).toContain('sn-day at 08:00')
    expect(await src.act({ type: 'profile-delete', name: 'sn-day' })).toEqual({ ok: true })
    expect(await src.act({ type: 'profile-delete', name: 'sn-night' })).toEqual({ ok: true })
    expect(view().next).toBeUndefined()
  })
})

describe('shepherdr profile schedule: the command, verb by verb', () => {
  test('schedule, schedules, schedule-off and -on, and unschedule say what they did; a mistake says what to type', async () => {
    expect(src.settings.set('time.zone', 'Europe/Madrid', 'all')).toEqual({ ok: true })
    expect(await src.act({ type: 'profile-save', name: 'cs-night', force: true })).toMatchObject({ ok: true })
    const cli = (args: string[]) => src.cli(args, {})
    // a rule in words, quoted or not, with --waiting: the profile's name is the longest run of words that is one
    const one = await cli(['profile', 'schedule', 'cs-night', 'daily 22:00', '--waiting'])
    expect(one.code).toBe(0)
    expect(one.out).toMatch(/^Scheduled cs-night: Every day at 22:00 \(Madrid\) · also the waiting tasks\. Next: .+\.\n$/)
    expect((await cli(['profile', 'schedule', 'cs-night', 'weekdays', '8:00'])).out).toMatch(/^Scheduled cs-night: Monday to Friday at 8:00/)
    expect((await cli(['profile', 'schedule', 'cs-night', 'FREQ=DAILY;BYHOUR=21;BYMINUTE=30'])).code).toBe(0)
    // the list: numbered, with what each is, and the next runs
    const list = await cli(['profile', 'schedules'])
    expect(list.code).toBe(0)
    expect(list.out).toMatch(/^cs-night\n  1  Every day at 22:00 \(Madrid\) · also the waiting tasks · next .+\n  2  Monday to Friday at 8:00 \(Madrid\) .+\n  3  Every day at 21:30 \(Madrid\) .+\n/)
    // a number is needed once a profile has more than one schedule
    expect(await cli(['profile', 'schedule-off', 'cs-night'])).toEqual({ out: 'cs-night has 3 schedules: give the number of one, 1 to 3 (shepherdr profile schedules lists them).\n', code: 1 })
    expect(await cli(['profile', 'schedule-off', 'cs-night', '9'])).toEqual({ out: 'No schedule 9 on cs-night: 1 to 3.\n', code: 1 })
    const off = await cli(['profile', 'schedule-off', 'cs-night', '2'])
    expect(off).toEqual({ out: 'cs-night: Monday to Friday at 8:00 (Madrid) is off now.\n', code: 0 })
    expect((await cli(['profile', 'schedules'])).out).toContain('  2  Monday to Friday at 8:00 (Madrid) · off\n')
    const on = await cli(['profile', 'schedule-on', 'cs-night', '2'])
    expect(on.out).toMatch(/^cs-night: Monday to Friday at 8:00 \(Madrid\) is on now\. Next: .+\.\n$/)
    expect(await cli(['profile', 'unschedule', 'cs-night', '3'])).toEqual({ out: 'Removed the schedule of cs-night: Every day at 21:30 (Madrid).\n', code: 0 })
    expect(await cli(['profile', 'unschedule', 'cs-night', '2'])).toMatchObject({ code: 0 })
    // one left: its number is not needed
    expect(await cli(['profile', 'schedule-on', 'cs-night'])).toMatchObject({ code: 0, out: expect.stringContaining('is on now') })
    expect(await cli(['profile', 'unschedule', 'cs-night'])).toMatchObject({ code: 0 })
    expect(await cli(['profile', 'unschedule', 'cs-night'])).toEqual({ out: 'cs-night has no schedule. shepherdr profile schedules lists them.\n', code: 1 })
    expect(await cli(['profile', 'schedules'])).toMatchObject({ code: 0 })
    // a mistake says what to type
    expect(await cli(['profile', 'schedule'])).toMatchObject({ code: 1, out: expect.stringContaining('shepherdr profile schedule <name> "<rule>" [--waiting]') })
    expect(await cli(['profile', 'schedule', 'cs-night'])).toMatchObject({ code: 1, out: expect.stringContaining('shepherdr profile schedule <name>') })
    expect(await cli(['profile', 'schedule', 'nope', 'daily 22:00'])).toEqual({ out: 'No profile called nope.\n', code: 1 })
    expect(await cli(['profile', 'schedule', 'cs-night', 'every evening, more or less'])).toMatchObject({ code: 1, out: expect.stringContaining("Can't read the time rule") })
    expect(await cli(['profile', 'schedule', 'cs-night', 'off'])).toMatchObject({ code: 1, out: expect.stringContaining('Say when it applies') })
    expect(await src.act({ type: 'profile-delete', name: 'cs-night' })).toEqual({ ok: true })
    expect(src.settings.set('time.zone', null, 'all')).toEqual({ ok: true })
    expect(await cli(['profile', 'schedules'])).toEqual({ out: 'No schedules yet. shepherdr profile schedule <name> "daily 22:00" adds one.\n', code: 0 })
  })
})
