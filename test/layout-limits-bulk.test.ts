// Settings → Limits, the bulk actions on the sub-limits: a column's Set for every space… writes each space its own number
// (inside the machine's total), a provider's Clear every space's sub-limit takes each space's entry back, and a column the
// + column added stays until it is removed. The desktop table; each test is short (the browser and the world are shared).
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { layout, pickLimit, settled } from './layout.ts'

const { browser, world, url } = await layout()

/** the Limits page on a desktop, with the machine's total for Spark set and two sub-limits of the spaces under it */
async function openWithSparkCaps(page: Page) {
  const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
  await set('models.maxAtOnce', 'spark=4', 'm:vm-str')
  await set('models.maxAtOnce', 'spark=2', 'p:vm-str:gtm')
  await page.goto(url())
  await page.evaluate(() => localStorage.removeItem('limits:columns'))
  await page.goto(url())
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('region', { name: 'Settings' }).getByRole('button', { name: 'Limits', exact: true }).click()
  await settled(page)
}
/** the demo's caps back as the file found them */
async function restore() {
  await world.act({ type: 'setting', key: 'models.maxAtOnce', value: null, place: 'm:vm-str' } as never)
  await world.act({ type: 'setting', key: 'models.maxAtOnce', value: null, place: 'p:vm-str:gtm' } as never)
}

describe.skipIf(!browser)('the bulk actions of the sub-limits', () => {
  test("the spaces' sub-limit reads under its column, inside the machine's total; a provider's ⋯ clears every space's sub-limit, asked first", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openWithSparkCaps(page)
      const spaces = page.getByRole('table', { name: 'Spaces' })
      // the column is there because an entry names it; gtm's own is 2 (1 of its runs is none now), herdr has none of its own
      await spaces.getByRole('button', { name: /^Spark \(local\) in gtm: 0 of 2 at once/ }).waitFor()
      await spaces.getByRole('button', { name: /^Spark \(local\) in herdr-projects: no sub-limit|^Spark \(local\) in herdr-projects: machine's total applies/ }).waitFor()
      // the provider's row: its ⋯ asks before it clears the two spaces' entries
      await page.getByRole('table', { name: 'Providers and models' }).getByRole('button', { name: 'More for Spark (local)', exact: true }).click()
      await page.getByRole('menuitem', { name: "Clear every space's sub-limit" }).click()
      const dialog = page.getByRole('alertdialog', { name: "Clear Spark (local)'s sub-limit in every space" })
      await dialog.getByRole('button', { name: 'Clear in 1 space', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await spaces.getByRole('button', { name: /^Spark \(local\) in gtm: machine's total applies \(4 at once\)/ }).waitFor()
    } finally {
      await restore()
      await page.close()
    }
  })

  test("a column's ⋯ clears its sub-limit in every space too, asked first", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openWithSparkCaps(page)
      await page.getByRole('table', { name: 'Spaces' }).getByRole('button', { name: 'More for Spark (local)', exact: true }).click()
      await page.getByRole('menuitem', { name: "Clear every space's sub-limit" }).click()
      await page.getByRole('alertdialog', { name: "Clear Spark (local)'s sub-limit in every space" }).getByRole('button', { name: 'Clear in 1 space', exact: true }).click()
      await page.getByRole('alertdialog', { name: "Clear Spark (local)'s sub-limit in every space" }).waitFor({ state: 'detached' })
      await page.getByRole('table', { name: 'Spaces' }).getByRole('button', { name: /^Spark \(local\) in gtm: machine's total applies/ }).waitFor()
    } finally {
      await restore()
      await page.close()
    }
  })

  test("a column's Set for every space… writes a sub-limit at each space; a column the + column added with no entry is removed from its ⋯", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openWithSparkCaps(page)
      const spaces = page.getByRole('table', { name: 'Spaces' })
      // a column of Codex, added: no entry yet, so every space shows no sub-limit
      await page.getByRole('button', { name: '+ column', exact: true }).click()
      await page.getByRole('menuitem', { name: /^Codex/ }).first().click()
      await spaces.getByRole('button', { name: /^Codex in gtm: no sub-limit$/ }).waitFor()
      // Set for every space…: each space gets 3 of its own
      await page.getByRole('button', { name: 'More for Codex', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Set for every space…' }).click()
      const dialog = page.getByRole('alertdialog', { name: 'Codex at once: every space' })
      await pickLimit(dialog, '3')
      await dialog.getByRole('button', { name: 'Set for 2 spaces', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await spaces.getByRole('button', { name: /^Codex in gtm: 0 of 3 at once/ }).waitFor()
      await spaces.getByRole('button', { name: /^Codex in herdr-projects: 1 of 3 at once/ }).waitFor()
      // the entries now name the column, so it stays; a column with no entry is removed from its ⋯
      await world.act({ type: 'setting', key: 'models.maxAtOnce', value: null, place: 'p:vm-str:herdr-projects' } as never)
      await world.act({ type: 'setting', key: 'models.maxAtOnce', value: null, place: 'p:vm-str:gtm' } as never)
      const more = page.getByRole('table', { name: 'Spaces' }).getByRole('button', { name: 'More for Codex', exact: true })
      await more.click()
      await page.getByRole('menuitem', { name: 'Remove this column' }).click()
      await spaces.getByRole('columnheader', { name: /^Codex at once/ }).waitFor({ state: 'detached' })
    } finally {
      await restore()
      await page.close()
    }
  })
})
