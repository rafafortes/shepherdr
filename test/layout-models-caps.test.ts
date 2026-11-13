// Settings → Models → Summary: a provider's or a model's cap on its agents at once (models.maxAtOnce). Its row says how many
// run now and its cap; its cell sets the cap at this machine, and clears it back to no cap; and a task held for a cap reads
// so in the Tasks list. The demo world keeps the setting and counts its working tasks, as the live source does.
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { layout, settled } from './layout.ts'

const { browser, world, url } = await layout()

/** the Models page on a desktop, opened from Settings; its Summary section */
async function openModels(page: Page) {
  await page.goto(url())
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Models', exact: true }).click()
  await settled(page)
  return page.locator('section[aria-label="Summary"]')
}

describe.skipIf(!browser)('the cap on a provider or model, in the Summary', () => {
  test("a cap set on a provider's row reads as N of M at once, and Clear here takes it back to no cap", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      const table = s.getByRole('table', { name: 'Providers and models' })
      const spark = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /^Spark \(local\)/ }) }).first()
      await spark.getByRole('button', { name: /^Spark \(local\): .* at once/ }).click()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      await pop.getByLabel('Most Spark (local) at once, this machine').fill('4')
      await pop.getByRole('button', { name: 'Save', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      // the row now names its cap, and what runs on it (none in the demo's world: 0 of 4)
      await spark.getByRole('button', { name: /^Spark \(local\): 0 of 4 at once/ }).waitFor()
      await spark.getByRole('button', { name: /^Spark \(local\): 0 of 4 at once/ }).click()
      await pop.getByRole('button', { name: 'Clear here', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      await spark.getByRole('button', { name: /^Spark \(local\): 0 at once · no cap/ }).waitFor()
    } finally {
      await page.close()
    }
  })

  test('a task held for its model’s cap reads so in the Tasks list', async () => {
    const task = world.tasks.find((t) => t.id === 'HP-203')!
    const saved = { status: task.status, sub: task.sub }
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      Object.assign(task, { status: 'queued', sub: 'Waiting for a free slot of spark (4 of 4 at once)' })
      await page.goto(url())
      await page.waitForSelector('section[aria-label="Tasks"] li')
      await page.locator('section[aria-label="Tasks"] li', { hasText: 'HP-203' }).getByText('Waiting for a free slot of spark (4 of 4 at once)').waitFor()
    } finally {
      Object.assign(task, saved)
      await page.close()
    }
  })
})
