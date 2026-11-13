// Settings → Models → Summary, on the screen: the providers and their models with what each was configured as, ran and
// used (the share bars), the run-out that is out now with its time; a warning's Change opens the cell it names; Hide keeps
// a warning away for the browser session only; and the phone's cards, nothing wider than the screen.
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
  return page.locator('section[aria-label="Summary"]')
}
/** the warnings still shown */
const warnings = (page: Page) => page.locator('section[aria-label="Warnings"] li')
/** the open cell editor */
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit this setting' })

describe.skipIf(!browser)('Settings → Models → Summary on a desktop', () => {
  test('each provider with its models: what is configured and running, the share of the tokens, the usage of each window, the run-out out now with its time', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      const table = s.getByRole('table', { name: 'Providers and models' })
      // the providers, by their names, then the models under them
      for (const name of ['Claude Code', 'Codex', 'OpenCode Go']) await table.getByRole('rowheader', { name: new RegExp(`^${name}`) }).first().waitFor()
      expect(await table.getByRole('rowheader', { name: /^Opus 5\.5/ }).count()).toBeGreaterThan(0)
      // a bar per provider: its share of the tokens in a day and in a week
      expect(await s.getByRole('img', { name: /^24 h: \d+% of the tokens$/ }).count()).toBeGreaterThan(0)
      expect(await s.getByRole('img', { name: /^7 d: \d+% of the tokens$/ }).count()).toBeGreaterThan(0)
      // what each window used, in tokens and calls; pi's cost as an estimate
      expect(await table.getByText(/tokens · \d+ calls/).count()).toBeGreaterThan(0)
      expect(await table.getByText(/est\.$/).count()).toBeGreaterThan(0)
      // OpenCode Go ran out twice this week, and is out now until a time
      expect(await table.getByText(/^2 run-outs in 7 d$/).count()).toBeGreaterThan(0)
      expect(await table.getByText(/^Out until /).count()).toBeGreaterThan(0)
      // the quota slot is there: the windows a read gave, the refilled one left out; — where none was read
      expect(await table.getByRole('columnheader', { name: 'Quota' }).count()).toBe(1)
      expect(await table.getByRole('img', { name: '5 h: 62% used' }).count()).toBe(1)
      expect(await table.getByText(/Last month/).count()).toBe(0)
      expect(await table.getByText('—').count()).toBeGreaterThan(0)
    } finally {
      await page.close()
    }
  })

  test("a warning's Change opens the cell it names, with its CLI, model and effort", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      // the first warning names a backup that runs the same model as its primary: Change opens that backup's editor
      expect(await warnings(page).count()).toBeGreaterThan(0)
      await warnings(page).first().getByRole('button', { name: 'Change…', exact: true }).click()
      const pop = editor(page)
      await pop.waitFor()
      expect(await pop.textContent()).toMatch(/· Tasks · Backup \d/)
      expect(await pop.getByRole('button', { name: /^(Agent|Backup): / }).count()).toBe(1)
    } finally {
      await page.close()
    }
  })

  test('a hidden warning stays hidden through a reload of this session, and comes back in a new one', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    const fresh = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      const shown = await warnings(page).count()
      await warnings(page).first().getByRole('button', { name: /^Hide for this session/ }).click()
      expect(await warnings(page).count()).toBe(shown - 1)
      // the same tab, reloaded: still hidden
      const again = await openModels(page)
      await again.scrollIntoViewIfNeeded()
      expect(await warnings(page).count()).toBe(shown - 1)
      // another browser session: every warning is there
      const other = await openModels(fresh)
      await other.scrollIntoViewIfNeeded()
      expect(await warnings(fresh).count()).toBe(shown)
      // hidden one by one, the last one takes the list with it
      for (let left = shown - 1; left > 0; left--) await warnings(fresh).first().getByRole('button', { name: /^Hide for this session/ }).click()
      await warnings(fresh).first().getByRole('button', { name: /^Hide for this session/ }).click()
      expect(await fresh.locator('section[aria-label="Warnings"]').count()).toBe(0)
    } finally {
      await page.close()
      await fresh.close()
    }
  })
})

describe.skipIf(!browser)('Settings → Models → Summary on a phone', () => {
  test('one card per provider with its models under it; the warnings with their buttons under their words; nothing wider than the screen', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Places', exact: true }).click()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Models', exact: true }).tap()
      await settled(page)
      const s = page.locator('section[aria-label="Summary"]')
      await s.scrollIntoViewIfNeeded()
      const cards = s.locator('ul > li').filter({ has: page.locator('h4') })
      expect(await s.locator('h4').allTextContents()).toEqual(expect.arrayContaining(['Claude Code', 'OpenCode Go']))
      expect(await cards.count()).toBeGreaterThanOrEqual(3)
      // a warning's Change is under its words on a phone, and it opens the cell's editor under its line
      await warnings(page).first().getByRole('button', { name: 'Change…', exact: true }).tap()
      await page.getByText(/· Tasks · Backup \d/).first().waitFor()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    } finally {
      await page.close()
    }
  })
})
