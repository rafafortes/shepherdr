// SHE-112: the Settings shell is in the first-load chunk, the page bodies come on demand. Opening Models goes through
// Suspense: the section list is there before the chunk is asked for, a fallback frame shows while it is fetched, and
// the table replaces it once it lands.
import { describe, expect, test } from 'bun:test'
import { layout, settled } from './layout.ts'

const { browser, url } = await layout()

describe.skipIf(!browser)('Settings loads its page bodies on demand', () => {
  test('the gear page opens first; Models shows the fallback while its chunk is held, then the table', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    let release: (() => void) | undefined
    const held = new Promise<void>((r) => (release = r))
    let asked = false
    try {
      // hold the chunk so the fallback stays long enough for the browser to see it
      await page.route('**/ModelsPage-*.js', async (route) => {
        asked = true
        await held
        await route.continue()
      })
      await page.goto(url())
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      // the shell: the section list comes with the first load, before any page body is asked for
      expect(await settings.getByRole('button', { name: 'Models', exact: true }).count()).toBe(1)
      expect(asked).toBe(false)
      await settings.getByRole('button', { name: 'Models', exact: true }).click()
      await settings.getByText('Loading…', { exact: true }).waitFor()
      expect(asked).toBe(true)
      release!()
      const table = settings.getByRole('table', { name: 'Models by level', exact: true })
      await table.waitFor()
      await settled(page)
      expect(await settings.getByText('Loading…', { exact: true }).count()).toBe(0)
      expect(await table.locator('tbody th[scope="row"] span.truncate').count()).toBeGreaterThan(0)
    } finally {
      release?.()
      await page.close()
    }
  })
})
