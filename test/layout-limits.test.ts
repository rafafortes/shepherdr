// Settings → Limits, the values and caps of a machine, its spaces, providers and models: where a value is edited, the
// three choices, a column's sub-limit, Running now and Other providers, in a real browser (layout.ts).
import { afterAll, describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { at, layout, pickLimit, rowLabels, settled } from './layout.ts'
import { piOffers } from './pi-offers.ts'

// pi lists nvidia and amd-tokenlab, which nothing in the demo uses: they are the providers under Other providers
const restorePi = piOffers()
afterAll(restorePi)
const { browser, world, url } = await layout()

/** the file's tests share one world and one browser: each starts from the demo's own limits, with no column of this browser's */
async function fresh(page: Page) {
  const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
  await set('machine.maxTasks', null, 'm:vm-str')
  await set('space.maxTasks', '2', 'p:vm-str:gtm')
  await set('space.maxTasks', null, 'p:vm-str:herdr-projects')
  for (const place of ['all', 'm:vm-str', 'p:vm-str:gtm', 'p:vm-str:herdr-projects']) await set('models.maxAtOnce', null, place)
  await set('space.maxTasks', null, 'all')
  await page.goto(url())
  await page.evaluate(() => localStorage.removeItem('limits:columns'))
}

/** the Limits page on a desktop, opened from Settings → How Shepherdr runs */
async function openLimits(page: Page, phone = false) {
  await fresh(page)
  await page.goto(url())
  if (phone) await page.getByRole('button', { name: 'Places', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('region', { name: 'Settings' }).getByRole('button', { name: 'Limits', exact: true }).click()
  await settled(page)
}

describe.skipIf(!browser)('Settings → Limits on a desktop', () => {
  test("a machine's value is set where it is shown, strong, and Reset to inherited takes it back to the level above", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      // this machine's row, its Max tasks: the demo's default (10), inherited from Everywhere
      const cell = page.getByRole('button', { name: /^vm-str · Max tasks working at once: 10/ })
      await cell.scrollIntoViewIfNeeded()
      await cell.click()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      await pickLimit(pop, '6')
      await pop.waitFor({ state: 'detached' })
      // the value is this machine's own now: strong, and the live numbers beside it
      const set = page.getByRole('button', { name: /^vm-str · Max tasks working at once: 6, / })
      await set.waitFor()
      expect(await set.getAttribute('class')).toContain('font-medium')
      await set.click()
      await pop.getByRole('button', { name: 'Reset to inherited', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: /^vm-str · Max tasks working at once: 10/ }).waitFor()
    } finally {
      await page.close()
    }
  })
  test("a space's Max tasks is its own value: set it at the space, and its line reads its working and held tasks now", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      const cell = page.getByRole('button', { name: /^gtm · Max tasks: 2, / })
      await cell.scrollIntoViewIfNeeded()
      await cell.click()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      await pickLimit(pop, '3')
      await pop.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: /^gtm · Max tasks: 3, 0 of 3 working · 1 held/ }).waitFor()
    } finally {
      await page.close()
    }
  })
  test('providers are grouped under their harness: Claude Code and Codex as their own rows, pi and OpenCode with a heading each and their providers under it, OpenCode Go under both', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      const table = page.getByRole('table', { name: 'Providers and models' })
      await table.scrollIntoViewIfNeeded()
      const labels = await rowLabels(table)
      // the order: the single-account CLIs, then pi, then OpenCode; each heading row is in brackets
      expect(at(labels, 'Claude Code')).toBeGreaterThanOrEqual(0)
      expect(at(labels, '[pi]')).toBeGreaterThan(at(labels, 'Claude Code'))
      expect(at(labels, 'Spark (local)')).toBeGreaterThan(at(labels, '[pi]'))
      expect(at(labels, '[OpenCode]')).toBeGreaterThan(at(labels, 'Spark (local)'))
      expect(labels.indexOf('OpenCode Go')).toBeLessThan(at(labels, '[OpenCode]'))
      expect(labels.lastIndexOf('OpenCode Go')).toBeGreaterThan(at(labels, '[OpenCode]'))
      // OpenCode Go is a row under each of its two harnesses, each with its own cap and usage
      expect(labels.filter((l) => l === 'OpenCode Go')).toHaveLength(2)
      expect(labels.filter((l) => l === '[pi]' || l === '[OpenCode]')).toHaveLength(2)
    } finally {
      await page.close()
    }
  })
  test('Anthropic API under pi and Claude Code are separate rows, each with its own cap, and the cap editor names the harness', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      await world.act({ type: 'setting', key: 'models.maxAtOnce', value: 'claude=3, pi.anthropic=2', place: 'm:vm-str' } as never)
      await page.goto(url())
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('region', { name: 'Settings' }).getByRole('button', { name: 'Limits', exact: true }).click()
      const table = page.getByRole('table', { name: 'Providers and models' })
      await table.scrollIntoViewIfNeeded()
      const labels = await rowLabels(table)
      expect(at(labels, 'Anthropic API')).toBeGreaterThan(at(labels, '[pi]'))
      expect(at(labels, 'Claude Code')).toBeLessThan(at(labels, '[pi]'))
      // two caps, one per row: the subscription's own, and pi's Anthropic API
      await table.getByRole('button', { name: /^Anthropic API: \d+ of 2 at once/ }).waitFor()
      await table.getByRole('button', { name: /^Claude Code: \d+ of 3 at once/ }).waitFor()
      // the editor of the pi row says which harness it is set in
      await table.getByRole('button', { name: /^Anthropic API: \d+ of 2 at once/ }).click()
      await page.getByRole('dialog', { name: 'Edit this setting' }).getByText('Most pi · Anthropic API at once', { exact: true }).waitFor()
    } finally {
      await world.act({ type: 'setting', key: 'models.maxAtOnce', value: null, place: 'm:vm-str' } as never)
      await page.close()
    }
  })
  test("a limit's three choices: this machine's Max tasks at 0 starts no task, reads 0 · starts none in the warning colour, and No cap takes it back", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      const cell = page.getByRole('button', { name: /^vm-str · Max tasks working at once: 10/ })
      await cell.scrollIntoViewIfNeeded()
      await cell.click()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      // the three separate choices, and no number box beside No cap or 0
      expect(await pop.getByRole('radio', { name: 'No cap', exact: true }).count()).toBe(1)
      expect(await pop.getByRole('radio', { name: '0 · starts none', exact: true }).count()).toBe(1)
      expect(await pop.getByRole('radio', { name: 'Limit', exact: true }).count()).toBe(1)
      await pop.getByRole('radio', { name: '0 · starts none', exact: true }).check()
      await pop.waitFor({ state: 'detached' })
      // 0 is a value of its own: the cell says so, in the warning colour, not as no cap
      const zero = page.getByRole('button', { name: /^vm-str · Max tasks working at once: 0 · starts none/ })
      await zero.waitFor()
      expect(await zero.getAttribute('class')).toContain('text-need-fg')
      // No cap is unlimited for this machine: the cell reads it faint
      await zero.click()
      await pop.getByRole('radio', { name: 'No cap', exact: true }).check()
      await pop.waitFor({ state: 'detached' })
      const none = page.getByRole('button', { name: /^vm-str · Max tasks working at once: no cap/ })
      await none.waitFor()
      expect(await none.getAttribute('class')).toContain('text-fg3')
    } finally {
      await page.close()
    }
  })
  test("+ column adds a provider; a space's sub-limit under it is set at that space, and reads its runs of the cap", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      await page.getByRole('button', { name: '+ column', exact: true }).click()
      await page.getByRole('menuitem', { name: /^pi · Spark \(local\) provider$/ }).click()
      // the column's header names the provider outside its group, like the + column's menu did
      await page.getByText('pi · Spark (local) at once', { exact: true }).waitFor()
      // the new column, with each space's sub-limit empty: the machine's total applies there, or none
      const empty = page.getByRole('table', { name: 'Spaces' }).getByRole('button', { name: /^pi · Spark \(local\) in gtm: no sub-limit$/ })
      await empty.scrollIntoViewIfNeeded()
      await empty.click()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      await pop.getByRole('radio', { name: 'This space' }).check()
      await pickLimit(pop, '2')
      await pop.getByRole('button', { name: 'Save', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      await page.getByRole('table', { name: 'Spaces' }).getByRole('button', { name: /^pi · Spark \(local\) in gtm: 0 of 2 at once/ }).waitFor()
    } finally {
      await page.close()
    }
  })
  test("a provider's machine total is its cap, set at this machine, and its sub-limits show under it", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      const spark = page.getByRole('table', { name: 'Providers and models' }).getByRole('row').filter({ has: page.getByRole('rowheader', { name: /^Spark \(local\)/ }) }).first()
      await spark.scrollIntoViewIfNeeded()
      await spark.getByRole('button', { name: /^Spark \(local\): .* at once/ }).click()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      await pickLimit(pop, '4')
      await pop.getByRole('button', { name: 'Save', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      await spark.getByRole('button', { name: /^Spark \(local\): 0 of 4 at once/ }).waitFor()
      // and the same entry is cleared again, back to no cap
      await spark.getByRole('button', { name: /^Spark \(local\): 0 of 4 at once/ }).click()
      await pop.getByRole('radio', { name: 'No cap', exact: true }).check()
      await pop.getByRole('button', { name: 'Save', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      await spark.getByRole('button', { name: /^Spark \(local\): 0 at once · no cap/ }).waitFor()
    } finally {
      await page.close()
    }
  })
  test("a provider set below its model's own limit lowers that model to it, and the editor says so before saving", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    const Q = 'pi.spark/qwen3.8-flash-next-mlx4-mtp-tensorfold'
    try {
      await openLimits(page)
      await world.act({ type: 'setting', key: 'models.maxAtOnce', value: `${Q}=3`, place: 'm:vm-str' } as never)
      await page.goto(url())
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('region', { name: 'Settings' }).getByRole('button', { name: 'Limits', exact: true }).click()
      const table = page.getByRole('table', { name: 'Providers and models' })
      const spark = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /^Spark \(local\)/ }) }).first()
      await spark.scrollIntoViewIfNeeded()
      await spark.getByRole('button', { name: /^Spark \(local\): .* at once/ }).click()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      await pickLimit(pop, '2')
      await pop.getByText('Saving lowers pi · spark/qwen3.8-flash-next-mlx4-mtp-tensorfold from 3 to 2 (pi · spark allows 2 at once).').waitFor()
      await pop.getByRole('button', { name: 'Save', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      // the model's own limit is the provider's now
      await table.getByRole('button', { name: /: 0 of 2 at once$/ }).nth(1).waitFor()
      expect(((await world.act({ type: 'limits-view' } as never)) as { caps: { machine: string } }).caps.machine).toBe(`${Q}=2, pi.spark=2`)
    } finally {
      await page.close()
    }
  })
  test('Running now names the tasks that run on a provider and its models, each id a button that opens it', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      const running = page.getByRole('table', { name: 'Providers and models' }).locator('[data-running]').filter({ hasText: /tasks? / }).first()
      await running.scrollIntoViewIfNeeded()
      const ids = running.getByRole('button')
      const n = await ids.count()
      expect(n).toBeGreaterThan(0)
      // the count before the ids is how many there are
      expect(await running.textContent()).toMatch(new RegExp(`^${n} tasks? `))
      const id = (await ids.first().textContent())!
      expect(id).toMatch(/^[A-Z]+-\d+$/)
      await ids.first().click()
      await page.waitForURL(new RegExp(`[?&]task=${id}(&|$)`), { timeout: 10_000 })
    } finally {
      await page.close()
    }
  })
  test('a provider nothing uses yet is under Other providers, open here: its cap cell sets its cap before it is used, and then it is in use', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      const other = page.getByRole('table', { name: 'Other providers' })
      await other.scrollIntoViewIfNeeded()
      // open by default, and NVIDIA API is in it, not in the table of the providers in use
      await other.getByRole('rowheader', { name: /^NVIDIA API/ }).waitFor()
      expect(await page.getByRole('table', { name: 'Providers and models' }).getByRole('rowheader', { name: /^NVIDIA API/ }).count()).toBe(0)
      await other.getByRole('button', { name: /^NVIDIA API: 0 at once · no cap/ }).click()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      await pickLimit(pop, '2')
      await pop.getByRole('button', { name: 'Save', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      // capped now: it is one of the providers in use, with its cap
      await page.getByRole('table', { name: 'Providers and models' }).getByRole('button', { name: /^NVIDIA API: 0 of 2 at once/ }).waitFor()
    } finally {
      await page.close()
    }
  })
})
