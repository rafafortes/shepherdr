// Settings → Limits: every limit in one place. A machine row's value is edited where it is set (Everywhere or this machine),
// a space's Max tasks is its own, a column of a provider or model is a space's sub-limit (added with + column), a provider's
// machine total is its cap, Waiting now lists what holds the tasks, a column's Set for every space… writes each space, and a
// phone draws one card per section, space and provider. Each test is short, so the browser tests fit on a loaded machine.
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { layout, settled } from './layout.ts'

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
      await pop.getByRole('textbox', { name: 'Max tasks working at once' }).fill('6')
      await pop.getByRole('textbox', { name: 'Max tasks working at once' }).press('Enter')
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
      await pop.getByRole('textbox', { name: 'Max tasks of this space working at once' }).fill('3')
      await pop.getByRole('textbox', { name: 'Max tasks of this space working at once' }).press('Enter')
      await pop.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: /^gtm · Max tasks: 3, 0 of 3 working · 1 held/ }).waitFor()
    } finally {
      await page.close()
    }
  })

  test("+ column adds a provider; a space's sub-limit under it is set at that space, and reads its runs of the cap", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      await page.getByRole('button', { name: '+ column', exact: true }).click()
      await page.getByRole('menuitem', { name: /^Spark \(local\) provider$/ }).click()
      // the new column, with each space's sub-limit empty: the machine's total applies there, or none
      const empty = page.getByRole('table', { name: 'Spaces' }).getByRole('button', { name: /^Spark \(local\) in gtm: no sub-limit$/ })
      await empty.scrollIntoViewIfNeeded()
      await empty.click()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      await pop.getByRole('radio', { name: 'This space' }).check()
      await pop.getByLabel('Most Spark (local) at once, in gtm').fill('2')
      await pop.getByRole('button', { name: 'Save', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      await page.getByRole('table', { name: 'Spaces' }).getByRole('button', { name: /^Spark \(local\) in gtm: 0 of 2 at once/ }).waitFor()
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
      await pop.getByLabel('Most Spark (local) at once, this machine').fill('4')
      await pop.getByRole('button', { name: 'Save', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      await spark.getByRole('button', { name: /^Spark \(local\): 0 of 4 at once/ }).waitFor()
      // and the same entry is cleared again, back to no cap
      await spark.getByRole('button', { name: /^Spark \(local\): 0 of 4 at once/ }).click()
      await pop.getByRole('button', { name: 'Clear here', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      await spark.getByRole('button', { name: /^Spark \(local\): 0 at once · no cap/ }).waitFor()
    } finally {
      await page.close()
    }
  })

  test('Waiting now groups the held tasks by what holds them, with each task id a link and the advisor and reviews listed', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      const waiting = page.getByRole('region', { name: 'Waiting now' })
      await waiting.waitFor()
      await waiting.getByText('The machine is too busy', { exact: false }).first().waitFor()
      await waiting.getByText('Space cap · gtm', { exact: false }).first().waitFor()
      await waiting.getByText('Questions waiting for the advisor').waitFor()
      await waiting.getByText('Review rounds waiting for a reviewer').waitFor()
      // each task id is a button that opens it
      expect(await waiting.getByRole('button', { name: 'HP-204', exact: true }).count()).toBe(1)
    } finally {
      await page.close()
    }
  })

  test('a press outside an open editor closes it without writing; Set for every space… with Everywhere resets the spaces to it', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      const cell = page.getByRole('button', { name: /^vm-str · Max tasks working at once: 10/ })
      await cell.scrollIntoViewIfNeeded()
      await cell.click()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      await pop.waitFor()
      // a press outside the editor closes it, and writes nothing (Escape would close the sheet too)
      await page.getByRole('heading', { name: 'Waiting now', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: /^vm-str · Max tasks working at once: 10/ }).waitFor()
      // the column's Everywhere mode: Everywhere gets 5, and each space loses its own value (gtm had 2)
      await page.getByRole('button', { name: 'More for Max tasks', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Set for every space…', exact: true }).click()
      const dialog = page.getByRole('alertdialog', { name: 'Set Max tasks for every space' })
      await dialog.getByRole('radio', { name: /Everywhere, and reset the spaces/ }).check()
      await dialog.getByRole('textbox', { name: 'Max tasks of this space working at once' }).fill('5')
      await dialog.getByRole('textbox', { name: 'Max tasks of this space working at once' }).press('Enter')
      await dialog.getByRole('button', { name: 'Set for 2 spaces', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      // gtm now reads Everywhere's value, faint, from there
      const gtm = page.getByRole('button', { name: /^gtm · Max tasks: 5, / })
      await gtm.waitFor()
      await gtm.getByText('Everywhere', { exact: true }).waitFor()
    } finally {
      await page.close()
    }
  })

  test("a column's Set for every space… writes each space its own value, and the dialog closes once they are written", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      await page.getByRole('button', { name: 'More for Max tasks', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Set for every space…', exact: true }).click()
      const dialog = page.getByRole('alertdialog', { name: 'Set Max tasks for every space' })
      await dialog.getByRole('textbox', { name: 'Max tasks of this space working at once' }).fill('4')
      await dialog.getByRole('textbox', { name: 'Max tasks of this space working at once' }).press('Enter')
      await dialog.getByRole('button', { name: 'Set for 2 spaces', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: /^gtm · Max tasks: 4, / }).waitFor()
      await page.getByRole('button', { name: /^herdr-projects · Max tasks: 4, / }).waitFor()
    } finally {
      await page.close()
    }
  })
  test('a browser that keeps no storage still shows the page, and a column added stays for the page while it is open', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      // the columns' keys are refused by the browser's storage: the page keeps them for this view only
      await page.addInitScript(() => {
        const get = Storage.prototype.getItem
        const put = Storage.prototype.setItem
        Storage.prototype.getItem = function (k: string) {
          if (k.startsWith('limits:')) throw new Error('no storage')
          return get.call(this, k)
        }
        Storage.prototype.setItem = function (k: string, v: string) {
          if (k.startsWith('limits:')) throw new Error('no storage')
          put.call(this, k, v)
        }
      })
      await openLimits(page)
      await page.getByRole('button', { name: '+ column', exact: true }).click()
      await page.getByRole('menuitem', { name: /^Spark \(local\) provider$/ }).click()
      await page.getByRole('table', { name: 'Spaces' }).getByRole('button', { name: /^Spark \(local\) in gtm: no sub-limit$/ }).waitFor()
    } finally {
      await page.close()
    }
  })

  test('the Providers and the Machine tables fit the Settings width at 1440 px: no horizontal scroll, their columns in view', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      for (const name of ['Providers and models', 'Machine limits']) {
        const table = page.getByRole('table', { name, exact: true })
        await table.waitFor()
        // the table's own box is its scroll box's width, and the box never scrolls sideways
        const fit = await table.evaluate((t) => {
          const box = t.parentElement!
          return { scroll: box.scrollWidth - box.clientWidth, width: t.getBoundingClientRect().width - box.clientWidth }
        })
        expect(fit.scroll).toBe(0)
        expect(fit.width).toBeLessThanOrEqual(1)
      }
    } finally {
      await page.close()
    }
  })
})

describe.skipIf(!browser)('Settings → Limits on a phone', () => {
  test('a phone draws one card per section, space and provider, and a value opens its editor under its line', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await openLimits(page, true)
      await page.getByRole('heading', { name: 'Machine · vm-str', exact: true }).waitFor()
      const space = page.getByRole('region', { name: 'Space gtm' })
      await space.scrollIntoViewIfNeeded()
      await space.getByRole('button', { name: /^gtm · Max tasks: 2, / }).tap()
      await page.getByRole('textbox', { name: 'Max tasks of this space working at once' }).waitFor()
      await page.getByRole('region', { name: 'Providers and models' }).scrollIntoViewIfNeeded()
      await page.getByRole('region', { name: 'Claude Code' }).waitFor()
    } finally {
      await page.close()
    }
  })

  test("a space's sub-limit line on a phone opens its editor under it, with the number of its runs now", async () => {
    const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await openLimits(page, true)
      // set after the page opened (opening starts from the demo's own limits): the page reads again on the change
      await set('models.maxAtOnce', 'spark=4', 'm:vm-str')
      await set('models.maxAtOnce', 'spark=2', 'p:vm-str:gtm')
      const space = page.getByRole('region', { name: 'Space gtm' })
      await space.scrollIntoViewIfNeeded()
      await space.getByRole('button', { name: /^Spark \(local\) in gtm: 0 of 2 at once/ }).tap()
      await page.getByRole('spinbutton', { name: 'Most Spark (local) at once, in gtm' }).waitFor()
      await page.getByRole('button', { name: 'Cancel', exact: true }).tap()
      await page.getByRole('spinbutton', { name: 'Most Spark (local) at once, in gtm' }).waitFor({ state: 'detached' })
    } finally {
      await set('models.maxAtOnce', null, 'm:vm-str')
      await set('models.maxAtOnce', null, 'p:vm-str:gtm')
      await page.close()
    }
  })
})
