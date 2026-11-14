// Settings → Models → Quotas, on the screen: the quota switches and the warning share sit on the Models page above its
// summary, not as a page of their own; a switch writes its setting (Everywhere); and the Quota column of the summary
// shows each provider's windows with a bar, its source and age, a failed read's reason, and the hint that opens Secrets.
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { layout, settled } from './layout.ts'

const { browser, url } = await layout()

/** the Models page on a desktop, opened from Settings */
async function openModels(page: Page) {
  await page.goto(url())
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Models', exact: true }).click()
  await settled(page)
  return settings
}

describe.skipIf(!browser)('Settings → Models → Quotas on a desktop', () => {
  test('the quota rows are on the Models page above its summary; no Quota page is listed in Settings', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const settings = await openModels(page)
      expect(await settings.getByRole('button', { name: /^Quotas?$/ }).count()).toBe(0)
      const rows = page.locator('section[aria-label="Quotas"]')
      await rows.scrollIntoViewIfNeeded()
      for (const label of ['Claude Code', 'Command Code', 'OpenCode Go (estimate)', 'Warn when a provider is at']) expect(await rows.locator('dt').filter({ hasText: label }).count()).toBe(1)
      // the warning share is a number, and sits above the summary's table
      expect(await rows.getByText('80%').count()).toBe(1)
      const above = await rows.boundingBox()
      const table = await page.getByRole('table', { name: 'Providers and models' }).boundingBox()
      expect(above!.y).toBeLessThan(table!.y)
    } finally {
      await page.close()
    }
  })

  test('a share Settings refuses says why under its row, and a valid one clears it', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      const rows = page.locator('section[aria-label="Quotas"]')
      await rows.scrollIntoViewIfNeeded()
      const box = rows.getByRole('textbox', { name: /^Warn when a provider is at/ })
      await box.fill('40')
      await box.press('Enter')
      await rows.getByText(/^Write a number from 50 to 95/).waitFor()
      await box.fill('80')
      await box.press('Enter')
      await rows.getByText(/^Write a number from 50 to 95/).waitFor({ state: 'detached' })
      expect(await rows.getByRole('status').count()).toBe(0)
    } finally {
      await page.close()
    }
  })

  test('a switch writes its setting, Everywhere: off stays off after a reload', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      const rows = page.locator('section[aria-label="Quotas"]')
      await rows.scrollIntoViewIfNeeded()
      const cc = rows.getByRole('switch', { name: 'Command Code' })
      expect(await cc.getAttribute('aria-checked')).toBe('true')
      await cc.click()
      await page.waitForFunction(() => document.querySelector('section[aria-label="Quotas"] [role="switch"][aria-label="Command Code"]')?.getAttribute('aria-checked') === 'false')
      await openModels(page)
      await page.locator('section[aria-label="Quotas"]').scrollIntoViewIfNeeded()
      expect(await page.locator('section[aria-label="Quotas"]').getByRole('switch', { name: 'Command Code' }).getAttribute('aria-checked')).toBe('false')
      await page.locator('section[aria-label="Quotas"]').getByRole('switch', { name: 'Command Code' }).click()
    } finally {
      await page.close()
    }
  })
})

/** the Summary's table on a desktop, with the Models page open */
async function summaryTable(page: Page) {
  await openModels(page)
  const s = page.locator('section[aria-label="Summary"]')
  await s.scrollIntoViewIfNeeded()
  return s.getByRole('table', { name: 'Providers and models' })
}

describe.skipIf(!browser)('the Quota column of the Summary on a desktop', () => {
  test('each window with its share as a bar, its refill, where its figure came from and how old it is; an estimate says so', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const table = await summaryTable(page)
      // Claude Code's read: its 5 h window at 62%, a bar of it, when it refills, and the source with its age
      expect(await table.getByRole('img', { name: '5 h: 62% used' }).count()).toBe(1)
      expect(await table.getByText(/^refills /).count()).toBeGreaterThan(0)
      expect(await table.getByText("from Claude Code's /usage, read 7 min ago").count()).toBe(1)
      // its last try failed two minutes ago: the reason, and the figure it keeps, with its own age
      expect(await table.getByText(/^Last read failed 2 min ago: Claude Code took longer than a minute to answer\. The figure is from 7 min ago\.$/).count()).toBe(1)
      // the refilled window of the demo is left out
      expect(await table.getByText('Last month').count()).toBe(0)
      // OpenCode Go's figure is an estimate: each window is tagged, and its source says where it comes from. It is the same on
      // both of its rows (pi's and OpenCode's), each with its own calls, so the source is named twice
      expect(await table.getByText('estimate', { exact: true }).count()).toBeGreaterThanOrEqual(2)
      expect(await table.getByText("estimate from Shepherdr's ledger").count()).toBe(2)
      expect(await table.getByText(/^ran out at ~\d+k? tokens/).count()).toBeGreaterThan(0)
    } finally {
      await page.close()
    }
  })

  test("a provider whose key is not in Secrets says what to add, and Open Secrets opens that page", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const table = await summaryTable(page)
      const hint = table.getByText("Add COMMANDCODE_API_KEY in Settings → Secrets to read Command Code's quota.")
      await hint.waitFor()
      await hint.locator('..').getByRole('button', { name: 'Open Secrets', exact: true }).click()
      // the Secrets page of Everywhere: its names and its add button, and no Models table any more
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Add a secret', exact: true }).waitFor()
      expect(await settings.getByText('Editing:').locator('..').getByText('Everywhere', { exact: true }).count()).toBe(1)
      expect(await page.getByRole('table', { name: 'Providers and models' }).count()).toBe(0)
    } finally {
      await page.close()
    }
  })

  test('Refresh quotas says what it did: the demo reads no quota, and says so', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      const quotas = page.locator('section[aria-label="Quotas"]')
      await quotas.scrollIntoViewIfNeeded()
      await quotas.getByRole('button', { name: 'Refresh quotas', exact: true }).click()
      await quotas.getByRole('status').filter({ hasText: 'The demo reads no quota' }).waitFor()
      expect(await quotas.getByRole('status').textContent()).toBe('The demo reads no quota: its figures are made up.')
    } finally {
      await page.close()
    }
  })
})

describe.skipIf(!browser)('the Quota of a provider on a phone', () => {
  test('its card has the windows with their bars and the source, and the hint with Open Secrets; nothing wider than the screen', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Places', exact: true }).click()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('region', { name: 'Settings' }).getByRole('button', { name: 'Models', exact: true }).tap()
      await settled(page)
      const s = page.locator('section[aria-label="Summary"]')
      await s.scrollIntoViewIfNeeded()
      const card = s.locator('li').filter({ has: page.locator('h4', { hasText: 'Claude Code' }) })
      expect(await card.getByRole('img', { name: '5 h: 62% used' }).count()).toBe(1)
      expect(await card.getByText("from Claude Code's /usage, read 7 min ago").count()).toBe(1)
      const cc = s.locator('li').filter({ has: page.locator('h4', { hasText: 'Command Code' }) })
      await cc.getByRole('button', { name: 'Open Secrets', exact: true }).waitFor()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    } finally {
      await page.close()
    }
  })
})
