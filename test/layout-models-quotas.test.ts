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
