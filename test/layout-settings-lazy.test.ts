// SHE-112: the Settings shell is in the first-load chunk, the page bodies come on demand. Opening Models goes through
// Suspense: the section list is there before the chunk is asked for, a fallback frame shows while it is fetched, and
// the table (a phone's cards) replaces it once it lands.
import { describe, expect, test } from 'bun:test'
import { layout, settled } from './layout.ts'

const { browser, url } = await layout()

async function opensThroughFallback(phone: boolean) {
  const page = await browser!.newPage(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 900 } })
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
    if (phone) await page.getByRole('button', { name: 'Places', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('region', { name: 'Settings' })
    // the shell: the section list comes with the first load, before any page body is asked for
    const models = settings.getByRole('button', { name: 'Models', exact: true })
    expect(await models.count()).toBe(1)
    expect(asked).toBe(false)
    if (phone) await models.tap()
    else await models.click()
    const fallback = settings.getByRole('status').filter({ hasText: 'Loading…' })
    await fallback.waitFor()
    expect(asked).toBe(true)
    release!()
    await settled(page)
    expect(await fallback.count()).toBe(0)
    if (phone) expect(await page.locator('section[aria-label="gtm"]').count()).toBe(1)
    else {
      const table = settings.getByRole('table', { name: 'Models by level', exact: true })
      expect(await table.locator('tbody th[scope="row"] span.truncate').count()).toBeGreaterThan(0)
    }
  } finally {
    release?.()
    await page.close()
  }
}

describe.skipIf(!browser)('Settings loads its page bodies on demand', () => {
  test('on a desktop: the shell opens first, Models shows the fallback while its chunk is held, then the table', async () => {
    await opensThroughFallback(false)
  })
  test('on a phone: the same fallback, then the level cards', async () => {
    await opensThroughFallback(true)
  })
})
