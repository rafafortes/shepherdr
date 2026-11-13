// Settings → Models → profiles: the schedules of a profile on a desktop and a phone. Manage profiles lists each profile's
// schedules in words, with the next and last run; a schedule is added, changed, switched on or off and removed in the
// same dialog, the editor says what it will write, and the bar's Next line names the two soonest runs.
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { layout, settled } from './layout.ts'

const { browser, world, url } = await layout()

/** the Models page on a desktop, opened from Settings */
async function openModels(page: Page) {
  await page.goto(url())
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Models', exact: true }).click()
  await settled(page)
  return settings
}
const bar = (page: Page) => page.getByRole('region', { name: 'Profiles', exact: true })
/** the profiles bar's menu, and its Manage profiles dialog */
async function manage(page: Page) {
  await bar(page).getByRole('button', { name: 'Profiles', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Manage profiles…', exact: true }).click()
  return page.getByRole('alertdialog', { name: 'Manage profiles' })
}
/** the demo's profiles and schedules back as the tests found them */
async function reset() {
  for (const p of ((await world.act({ type: 'profiles' })) as { profiles: { name: string }[] }).profiles) await world.act({ type: 'profile-delete', name: p.name })
  world.emit('snapshot')
}

describe.skipIf(!browser)('Settings → Models: schedules of a profile on a desktop', () => {
  test('add a schedule with its days, time and waiting tasks; change it, switch it off and on, and remove it; the bar names the next runs', async () => {
    await reset()
    await world.act({ type: 'profile-save', name: 'night' })
    await world.act({ type: 'profile-save', name: 'day' })
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      const dlg = await manage(page)
      // a new one: every day at 22:00, the waiting tasks too
      await dlg.getByRole('button', { name: 'Add a schedule…' }).first().click()
      const add = dlg.getByRole('form', { name: 'Add a schedule to night' })
      await add.getByRole('button', { name: 'Every day', exact: true }).click()
      await add.getByLabel('At', { exact: true }).fill('22:00')
      await add.getByRole('checkbox', { name: /Also the waiting tasks/ }).check()
      expect(await add.textContent()).toContain('Every day at 22:00 · also the waiting tasks')
      await add.getByRole('button', { name: 'Save', exact: true }).click()
      await add.waitFor({ state: 'detached' })
      await dlg.getByText('Every day at 22:00 (', { exact: false }).first().waitFor()
      expect(await dlg.textContent()).toMatch(/Every day at 22:00 \(.+\) · also the waiting tasks/)
      expect(await dlg.textContent()).toMatch(/Next (Today|Tomorrow) 22:00/)
      expect(await world.act({ type: 'profiles' })).toMatchObject({ next: expect.stringMatching(/^Next: night at 22:00/) })
      // the bar's Next line names it
      await bar(page).getByText(/^Next: night at 22:00/).waitFor()
      // a second one on weekdays at 8:00, a new one on some days
      await dlg.getByRole('button', { name: 'Add a schedule…' }).first().click()
      const weekdays = dlg.getByRole('form', { name: 'Add a schedule to night' })
      await weekdays.getByRole('button', { name: 'Weekdays', exact: true }).click()
      await weekdays.getByLabel('At', { exact: true }).fill('08:00')
      await weekdays.getByRole('button', { name: 'Save', exact: true }).click()
      await dlg.getByText('Monday to Friday at 8:00', { exact: false }).first().waitFor()
      // some days: none picked is refused, then Mon and Fri
      await dlg.getByRole('button', { name: 'Add a schedule…' }).first().click()
      const some = dlg.getByRole('form', { name: 'Add a schedule to night' })
      await some.getByRole('button', { name: 'Some days', exact: true }).click()
      await some.getByLabel('At', { exact: true }).fill('16:30')
      await some.getByRole('button', { name: 'Save', exact: true }).click()
      await some.getByRole('status').filter({ hasText: 'Pick the days it applies on.' }).waitFor()
      await some.getByRole('button', { name: 'Mon', exact: true }).click()
      await some.getByRole('button', { name: 'Fri', exact: true }).click()
      await some.getByRole('button', { name: 'Save', exact: true }).click()
      await dlg.getByText('Mon, Fri at 16:30', { exact: false }).first().waitFor()
      expect(((await world.act({ type: 'profiles' })) as { profiles: { name: string; schedules?: unknown[] }[] }).profiles.find((p) => p.name === 'night')!.schedules!.length).toBe(3)
      // the day profile has none yet; a change of the first one: 21:30, and the waiting tasks off
      const first = dlg.getByRole('button', { name: 'Change', exact: true }).first()
      await first.click()
      const change = dlg.getByRole('form', { name: 'Change a schedule of night' })
      expect(await change.getByLabel('At', { exact: true }).inputValue()).toBe('22:00')
      await change.getByLabel('At', { exact: true }).fill('21:30')
      await change.getByRole('checkbox', { name: /Also the waiting tasks/ }).uncheck()
      await change.getByRole('button', { name: 'Save', exact: true }).click()
      await change.waitFor({ state: 'detached' })
      await dlg.getByText('Every day at 21:30 (', { exact: false }).first().waitFor()
      // switched off, then on
      await dlg.getByRole('button', { name: 'Turn off', exact: true }).first().click()
      await dlg.getByText(/Every day at 21:30 \(.+\) · off/).waitFor()
      expect(await bar(page).textContent()).not.toMatch(/Next: night at 21:30/)
      await dlg.getByRole('button', { name: 'Turn on', exact: true }).first().click()
      await dlg.getByText(/Every day at 21:30 \(.+\)$/).first().waitFor()
      // removed: asked first, then gone
      await dlg.getByRole('button', { name: 'Remove', exact: true }).first().click()
      await dlg.getByText(/^Remove Every day at 21:30/).waitFor()
      await dlg.getByRole('group', { name: 'Remove this schedule?' }).getByRole('button', { name: 'Remove', exact: true }).click()
      await dlg.getByText(/Every day at 21:30 \(.+\)/).waitFor({ state: 'detached' })
      expect(((await world.act({ type: 'profiles' })) as { profiles: { name: string; schedules?: unknown[] }[] }).profiles.find((p) => p.name === 'night')!.schedules!.length).toBe(2)
      await dlg.getByRole('button', { name: 'Done', exact: true }).click()
      await dlg.waitFor({ state: 'detached' })
    } finally {
      await reset()
      await page.close()
    }
  })

  test('a profile with no schedule says so by its button only; the Next line names two runs and is gone without one', async () => {
    await reset()
    await world.act({ type: 'profile-save', name: 'night' })
    await world.act({ type: 'profile-save', name: 'day' })
    await world.act({ type: 'profile-schedule', name: 'night', rule: 'daily 22:00' })
    await world.act({ type: 'profile-schedule', name: 'day', rule: 'daily 8:00' })
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      await bar(page).getByText(/^Next: (night|day) at/).waitFor()
      expect(await bar(page).textContent()).toMatch(/Next: (night|day) at \d\d:\d\d, then (night|day) (at|on) /)
      const dlg = await manage(page)
      await dlg.getByText(/Every day at 8:00 \(/).waitFor()
      await dlg.getByText(/Every day at 22:00 \(/).waitFor()
      expect(await dlg.getByRole('button', { name: 'Add a schedule…' }).count()).toBe(2)
      await dlg.getByRole('button', { name: 'Done', exact: true }).click()
      await world.act({ type: 'profile-schedule-remove', name: 'night', id: ((await world.act({ type: 'profiles' })) as { profiles: { name: string; schedules?: { id: string }[] }[] }).profiles.find((p) => p.name === 'night')!.schedules![0]!.id })
      world.emit('snapshot')
      await bar(page).getByText(/^Next: day at 08:00/).waitFor()
    } finally {
      await reset()
      await page.close()
    }
  })
})

describe.skipIf(!browser)('Settings → Models: a due schedule in the demo', () => {
  test('a due schedule posts its note as a card in the home space\'s chat (the demo sends no alert)', async () => {
    await reset()
    // a profile of the settings as they are: due, it changes nothing, and says so
    await world.act({ type: 'profile-save', name: 'tick-now' })
    await world.act({ type: 'profile-schedule', name: 'tick-now', rule: 'daily 22:00' })
    const home = world.places.find((p) => p.home && p.machine === 'vm-str')!.chat
    const before = world.chats[home]!.messages.length
    // two days on, the 22:00 of the last day has come due
    world.profileSchedules.tick(Date.now() + 2 * 86_400_000)
    const cards = world.chats[home]!.messages.filter((m) => m.card?.text?.includes('tick-now')).map((m) => m.card!.text)
    expect(world.chats[home]!.messages.length).toBe(before + 1)
    expect(cards).toEqual([expect.stringContaining('nothing changed, the settings read as tick-now says already.')])
    await reset()
  })
})

describe.skipIf(!browser)('Settings → Models: schedules of a profile on a phone', () => {
  test('the schedules sit under each profile in the dialog, the editor fits the screen and saves, and nothing is wider than the screen', async () => {
    await reset()
    await world.act({ type: 'profile-save', name: 'night' })
    await world.act({ type: 'profile-schedule', name: 'night', rule: 'weekends 10:00', waiting: true })
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Places', exact: true }).click()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Models', exact: true }).tap()
      await settled(page)
      await bar(page).getByText(/^Next: night/).waitFor()
      await bar(page).getByRole('button', { name: 'Profiles', exact: true }).tap()
      await page.getByRole('menuitem', { name: 'Manage profiles…', exact: true }).tap()
      const dlg = page.getByRole('alertdialog', { name: 'Manage profiles' })
      await dlg.getByText(/Saturday and Sunday at 10:00|Weekends/).first().waitFor()
      expect(await dlg.textContent()).toContain('also the waiting tasks')
      await dlg.getByRole('button', { name: 'Add a schedule…' }).tap()
      const form = dlg.getByRole('form', { name: 'Add a schedule to night' })
      await form.getByRole('button', { name: 'Weekends', exact: true }).tap()
      await form.getByLabel('At', { exact: true }).fill('09:15')
      await form.getByRole('button', { name: 'Save', exact: true }).tap()
      await form.waitFor({ state: 'detached' })
      await dlg.getByText(/at 9:15/).first().waitFor()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    } finally {
      await reset()
      await page.close()
    }
  })
})
