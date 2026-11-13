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

  test("a space's own sub-limit reads under its row, and its line opens the editor on that space: This space, then Clear here", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      const table = s.getByRole('table', { name: 'Providers and models' })
      const spark = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /^Spark \(local\)/ }) }).first()
      await spark.getByRole('button', { name: /^Spark \(local\): .* at once/ }).click()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      await pop.getByRole('radio', { name: /This space/ }).check()
      await pop.getByLabel('Which space').selectOption('gtm')
      await pop.getByLabel('Most Spark (local) at once, in gtm').fill('2')
      await pop.getByRole('button', { name: 'Save', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      // the line under the row names the space, its count of runs and its cap (none in the demo's world: 0 of 2)
      const line = spark.getByRole('button', { name: /^Spark \(local\) in gtm: 0 of 2 at once/ })
      await line.waitFor()
      await line.click()
      expect(await pop.getByRole('radio', { name: /This space/ }).isChecked()).toBe(true)
      expect(await pop.getByLabel('Which space').inputValue()).toBe('gtm')
      await pop.getByRole('button', { name: 'Clear here', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      await spark.getByRole('button', { name: /^Spark \(local\): .* at once/ }).waitFor()
      await line.waitFor({ state: 'detached' })
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

  test('a task held for its models reads one short line in its row; its title names the whole chain', async () => {
    const task = world.tasks.find((t) => t.id === 'HP-203')!
    const saved = { status: task.status, sub: task.sub, subTitle: task.subTitle }
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const full = 'Waiting: pi · spark/qwen3.8-flash-next-mlx4-mtp-tensorfold (4 of 4 at once), Command Code (out until 17:00)'
      Object.assign(task, { status: 'queued', sub: 'Waiting: spark 4/4 · commandcode out', subTitle: full })
      await page.goto(url())
      await page.waitForSelector('section[aria-label="Tasks"] li')
      const row = page.locator('section[aria-label="Tasks"] li', { hasText: 'HP-203' })
      // the row shows the short words, whole: nothing cut off in it
      await row.getByText('Waiting: spark 4/4 · commandcode out', { exact: true }).waitFor()
      expect(await row.getByText('Waiting: spark 4/4 · commandcode out', { exact: true }).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      // the whole chain is the title of the line
      expect(await row.locator('span[title]').evaluate((el) => el.getAttribute('title'))).toBe(full)
      // a screenshot of the row, as the proof of it
      await row.screenshot({ path: process.env.CAP_ROW_SHOT ?? '/tmp/cap-row-short.png' })
    } finally {
      Object.assign(task, saved)
      await page.close()
    }
  })

  test('a phone card: the cap opens under its line, a value that is no whole number is refused in words, and Save sets it', async () => {
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
      const card = s.locator('ul > li').filter({ has: page.locator('h4', { hasText: 'Spark (local)' }) })
      await card.getByRole('button', { name: /^Spark \(local\): .* at once/ }).tap()
      const editor = card.getByLabel('Most Spark (local) at once, this machine')
      await editor.fill('0')
      await card.getByRole('button', { name: 'Save', exact: true }).tap()
      await card.getByRole('status').filter({ hasText: 'Write a whole number from 1 to 200' }).waitFor()
      await editor.fill('3')
      await card.getByRole('button', { name: 'Save', exact: true }).tap()
      await card.getByRole('button', { name: /^Spark \(local\): 0 of 3 at once/ }).waitFor()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    } finally {
      await page.close()
    }
  })

  test('a write the server refuses is said in the editor, and the cell keeps what it was', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    const act = world.act.bind(world)
    world.act = async (a) => (a.type === 'setting' && a.key === 'models.maxAtOnce' ? { ok: false, error: 'models.maxAtOnce is refused by this test' } : act(a))
    try {
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      const table = s.getByRole('table', { name: 'Providers and models' })
      const spark = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /^Spark \(local\)/ }) }).first()
      // the cell as it reads before (the demo world is shared by this file's tests: an earlier one may have set it)
      const labels = () => spark.getByRole('button').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label')))
      const before = await labels()
      await spark.getByRole('button', { name: /^Spark \(local\): .* at once/ }).click()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      await pop.getByLabel('Most Spark (local) at once, this machine').fill('2')
      await pop.getByRole('button', { name: 'Save', exact: true }).click()
      await pop.getByRole('status').filter({ hasText: 'refused by this test' }).waitFor()
      // nothing was kept: once the editor is closed, the cell reads as it did
      await pop.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Edit this setting"]'))
      expect(await labels()).toEqual(before)
    } finally {
      world.act = act
      await page.close()
    }
  })
})
