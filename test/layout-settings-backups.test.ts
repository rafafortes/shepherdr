// Settings → Agents and How tasks work: each role's backups sit under its own rows, in a sub-block with a heading of its
// own, indented under a rule (desktop and phone); the way back is a group of its own, last on the page.
import { describe, expect, test } from 'bun:test'
import type { Locator } from 'playwright-core'
import { layout, settled } from './layout.ts'

const { browser, world, url } = await layout()

/** the rows of a part of the page in order, by their labels (a row's dt; the add button's words): a row whose CLI is off
 *  has its Model and Effort as plain words, not buttons, so its label is what tells them apart */
const rowNames = (loc: Locator) =>
  loc.locator('dt, button[data-add-backup]').evaluateAll((els) => els.map((e) => (e.tagName === 'DT' ? (e.firstChild?.textContent ?? '') : (e.textContent?.trim() ?? ''))))
/** the headings of the page's content (not the list beside it), in order */
const headingsOf = (settings: Locator) => groupOf(settings, 'Tasks').locator('..').locator('h3, h4').allTextContents()
/** a role's group (its heading and everything under it) on the Settings page */
const groupOf = (settings: Locator, name: string) => settings.getByRole('heading', { name, exact: true, level: 3 }).locator('..')
/** the Backups sub-block inside a role's group, the nth one of them (a role's or the page's last group) */
const backupsOf = (group: Locator) => group.getByRole('group', { name: 'Backups', exact: true })

describe.skipIf(!browser)('backups under their role on Settings → Agents', () => {
  /** the demo's chains as this file sets them, and the Settings the others left */
  const setChains = async (values: Record<string, string>) => {
    const store = world.stores['vm-str']
    for (const [k, v] of Object.entries(values)) store.set(k, v)
    world.sections = (await import('../server/demo/data.ts')).settings(world.stores)
    world.emit('snapshot')
  }
  const reset = async () => {
    const store = world.stores['vm-str']
    for (const k of ['task.fallback', 'task.fallback2', 'coordinator.fallback', 'coordinator.fallback2', 'advisor.fallback', 'advisor.fallback2', 'backup.model', 'backup.effort'])
      for (const l of ['all', { space: '~' }] as const) store.set(k, null, l)
    world.sections = (await import('../server/demo/data.ts')).settings(world.stores)
    world.emit('snapshot')
  }

  test('desktop: Tasks, Coordinators and Advisor each show their backups under their own rows, then the way back, in order', async () => {
    await setChains({ 'task.fallback': 'Codex', 'task.fallback2': 'off', 'coordinator.fallback': 'Claude Code', 'advisor.fallback': 'off' })
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Agents', exact: true }).click()
      await settled(page)
      // the headings in order: each role, its Backups sub-heading, then the way back's group
      expect(await headingsOf(settings)).toEqual(['Tasks', 'Backups', 'Coordinators', 'Backups', 'Advisor', 'Backups', 'Back to the primary'])
      // a role's own three rows, then its Backups sub-block with its rows and the add button, last inside the sub-block
      expect(await rowNames(groupOf(settings, 'Tasks'))).toEqual(['Agent', 'Model', 'Effort', 'Backup', 'Backup model', 'Backup effort', 'Add a backup'])
      expect(await rowNames(backupsOf(groupOf(settings, 'Tasks')))).toEqual(['Backup', 'Backup model', 'Backup effort', 'Add a backup'])
      expect(await rowNames(groupOf(settings, 'Coordinators'))).toEqual(['Agent', 'Model', 'Effort', 'Backup', 'Backup model', 'Backup effort', 'Add a backup'])
      // the advisor's Backup is off: no add button yet, and its "Answers for you after" is back at the role's level
      expect(await rowNames(groupOf(settings, 'Advisor'))).toEqual(['Advisor', 'Model', 'Effort', 'Backup', 'Backup model', 'Backup effort', 'Answers for you after'])
      expect(await rowNames(backupsOf(groupOf(settings, 'Advisor')))).toEqual(['Backup', 'Backup model', 'Backup effort'])
      const after = settings.getByRole('button', { name: /^Answers for you after:/ })
      expect(await after.evaluate((el) => el.closest('[role="group"]'))).toBeNull()
      // the way back: a group of its own, outside every role's sub-block
      const back = settings.getByRole('button', { name: /^When the primary is back:/ })
      expect(await back.evaluate((el) => el.closest('[role="group"]'))).toBeNull()
      expect(await rowNames(groupOf(settings, 'Back to the primary'))).toEqual(['When the primary is back'])

      // the sub-block is indented from its role's rows and has a rule down its left (computed, not guessed)
      const roleRows = (await groupOf(settings, 'Tasks').locator(':scope > dl').first().boundingBox())!
      const sub = backupsOf(groupOf(settings, 'Tasks'))
      const subRows = (await sub.locator(':scope > dl').boundingBox())!
      expect(subRows.x - roleRows.x).toBeGreaterThanOrEqual(16)
      const rule = await sub.evaluate((el) => ({ width: getComputedStyle(el).borderLeftWidth, style: getComputedStyle(el).borderLeftStyle, color: getComputedStyle(el).borderLeftColor }))
      expect(rule).toEqual({ width: '2px', style: 'solid', color: expect.stringMatching(/(\/ 0\.5\)|,\s*0\.5\))$/) }) // fg3 at half strength, not the 7% line

      // a 2nd backup of the tasks lands inside the tasks' sub-block, not the coordinators'
      await backupsOf(groupOf(settings, 'Tasks')).getByRole('button', { name: 'Add a backup', exact: true }).click()
      await backupsOf(groupOf(settings, 'Tasks')).getByRole('button', { name: 'Backup 2: Codex', exact: true }).waitFor()
      expect(await rowNames(backupsOf(groupOf(settings, 'Tasks')))).toEqual(['Backup', 'Backup model', 'Backup effort', 'Backup 2', 'Backup 2 model', 'Backup 2 effort', 'Add a backup'])
      expect(await settings.getByRole('button', { name: 'Backup 2: Codex', exact: true }).count()).toBe(1)
      expect(await settings.getByRole('button', { name: 'Add a backup', exact: true }).count()).toBe(2)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280)
    } finally {
      await reset()
      await page.close()
    }
  })

  test('phone: the sub-block is indented inside its own rounded group, and the way back sits last', async () => {
    await setChains({ 'task.fallback': 'Codex', 'task.fallback2': 'off', 'coordinator.fallback': 'off', 'advisor.fallback': 'off' })
    const page = await browser!.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Places', exact: true }).click()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Agents', exact: true }).tap()
      await settled(page)
      expect(await headingsOf(settings)).toEqual(['Tasks', 'Backups', 'Coordinators', 'Backups', 'Advisor', 'Backups', 'Back to the primary'])
      // the coordinators' Backup 1 is off: its sub-block has no add button, and its Model is still a row of its own
      expect(await rowNames(backupsOf(groupOf(settings, 'Coordinators')))).toEqual(['Backup', 'Backup model', 'Backup effort'])
      // indented: the sub-block's rounded group starts right of the role's own
      const roleCard = (await groupOf(settings, 'Tasks').locator(':scope > dl').first().boundingBox())!
      const subCard = (await backupsOf(groupOf(settings, 'Tasks')).locator(':scope > dl').boundingBox())!
      expect(subCard.x - roleCard.x).toBeGreaterThanOrEqual(8)
      expect(subCard.x + subCard.width).toBeLessThanOrEqual(375)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
    } finally {
      await reset()
      await page.close()
    }
  })

  test("How tasks work: the Reviewer's backups sit under the Reviewer in the same sub-block", async () => {
    await setChains({})
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'How tasks work', exact: true }).click()
      await settled(page)
      const reviewer = groupOf(settings, 'Reviewer')
      expect(await rowNames(reviewer)).toEqual(['Agent', 'Model', 'Effort', 'Backup', 'Backup model', 'Backup effort'])
      expect(await rowNames(backupsOf(reviewer))).toEqual(['Backup', 'Backup model', 'Backup effort'])
      const roleRows = (await reviewer.locator(':scope > dl').first().boundingBox())!
      const subRows = (await backupsOf(reviewer).locator(':scope > dl').boundingBox())!
      expect(subRows.x - roleRows.x).toBeGreaterThanOrEqual(16)
    } finally {
      await page.close()
    }
  })
})
