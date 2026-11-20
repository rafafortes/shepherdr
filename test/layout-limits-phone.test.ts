// Settings → Limits on a phone: one card per section, space and provider, a value edited under its line, the spaces in
// queue order, and 300 waiting tasks, in a real browser (layout.ts).
import { afterAll, describe, expect, test } from 'bun:test'
import type { Locator, Page } from 'playwright-core'
import type { LimitsQueue } from '../shared/types.ts'
import { at, layout, settled } from './layout.ts'
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

/** whether the second element comes after the first in the page */
const follows = (first: Locator, second: Locator) => second.elementHandle().then((h) => first.evaluate((el, other) => (el.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, h))

/** 300 waiting tasks: 200 in one queued group (for Show all), the rest in the other kinds */
function bigQueue(): LimitsQueue {
  const task = (id: string, space: string, words: string) => ({ id, space, spaceName: space, words })
  return {
    queued: Array.from({ length: 200 }, (_, i) => task(`QP-${i}`, 'herdr-projects', `After QP-${i}-x`)),
    scheduled: Array.from({ length: 50 }, (_, i) => task(`SP-${i}`, 'gtm', 'Starts Tomorrow 9:00')),
    todo: Array.from({ length: 30 }, (_, i) => task(`TP-${i}`, 'gtm', 'Added 1h ago')),
    merges: Array.from({ length: 20 }, (_, i) => task(`MP-${i}`, 'gtm', "Waiting for other's merge")),
  }
}

/** the Limits page on a desktop, opened from Settings → How Shepherdr runs */
async function openLimits(page: Page, phone = false) {
  await fresh(page)
  await page.goto(url())
  if (phone) await page.getByRole('button', { name: 'Spaces', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('region', { name: 'Settings' }).getByRole('button', { name: 'Limits', exact: true }).click()
  await settled(page)
}

describe.skipIf(!browser)('Settings → Limits on a phone', () => {
  test('a phone draws one card per section, space and provider, and a value opens its editor under its line', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await openLimits(page, true)
      await page.getByRole('heading', { name: 'Machine · vm-str', exact: true }).waitFor()
      const space = page.getByRole('region', { name: 'Space gtm' })
      await space.scrollIntoViewIfNeeded()
      await space.getByRole('button', { name: /^gtm · Max tasks: 2, / }).tap()
      await page.getByRole('textbox', { name: 'Limit, from 1 to 200' }).first().waitFor()
      await page.getByRole('region', { name: 'Providers and models' }).scrollIntoViewIfNeeded()
      await page.getByRole('region', { name: 'Claude Code' }).waitFor()
      // the providers nothing uses yet, open under Other providers: a card each
      await page.getByRole('region', { name: 'NVIDIA API' }).waitFor()
    } finally {
      await page.close()
    }
  })
  test('on a phone each harness heading comes before its provider cards: pi, then its Spark card, then OpenCode', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await openLimits(page, true)
      const pi = page.getByRole('heading', { name: 'pi', exact: true }).first()
      const spark = page.getByRole('region', { name: 'Spark (local)' })
      const opencode = page.getByRole('heading', { name: 'OpenCode', exact: true })
      await pi.scrollIntoViewIfNeeded()
      await spark.waitFor()
      expect(await follows(pi, spark)).toBe(true)
      expect(await follows(spark, opencode)).toBe(true)
    } finally {
      await page.close()
    }
  })
  test('a phone lists the spaces in queue order and moves one by touch', async () => {
    const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await openLimits(page, true)
      await set('space.priority', '1', 'p:vm-str:gtm')
      await set('space.priority', '2', 'p:vm-str:herdr-projects')
      const gtm = page.getByRole('region', { name: 'Space gtm' })
      await gtm.scrollIntoViewIfNeeded()
      await gtm.getByRole('button', { name: /^gtm · Priority: 1/ }).waitFor()
      const hp = page.getByRole('region', { name: 'Space herdr-projects' })
      await hp.scrollIntoViewIfNeeded()
      await hp.getByRole('button', { name: /^herdr-projects · Priority: 2/ }).waitFor()
      expect(await follows(gtm, hp)).toBe(true)
      // touch: a tap of the ↑ moves it first, renumbers both spaces and re-orders the cards
      await hp.getByRole('button', { name: 'Move herdr-projects up' }).tap()
      await hp.getByRole('button', { name: /^herdr-projects · Priority: 1/ }).waitFor()
      await gtm.getByRole('button', { name: /^gtm · Priority: 2/ }).waitFor()
      expect(await follows(hp, gtm)).toBe(true)
    } finally {
      await set('space.priority', null, 'p:vm-str:gtm')
      await set('space.priority', null, 'p:vm-str:herdr-projects')
      await page.close()
    }
  })
  test("a space's sub-limit line on a phone opens its editor under it, with the number of its runs now", async () => {
    const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await openLimits(page, true)
      // set after the page opened (opening starts from the demo's own limits): the page reads again on the change
      await set('models.maxAtOnce', 'pi.spark=4', 'm:vm-str')
      await set('models.maxAtOnce', 'pi.spark=2', 'p:vm-str:gtm')
      const space = page.getByRole('region', { name: 'Space gtm' })
      await space.scrollIntoViewIfNeeded()
      await space.getByRole('button', { name: /^pi · Spark \(local\) in gtm: 0 of 2 at once/ }).tap()
      await page.getByRole('textbox', { name: 'Limit, from 1 to 200' }).waitFor()
      await page.getByRole('button', { name: 'Cancel', exact: true }).tap()
      await page.getByRole('textbox', { name: 'Limit, from 1 to 200' }).waitFor({ state: 'detached' })
    } finally {
      await set('models.maxAtOnce', null, 'm:vm-str')
      await set('models.maxAtOnce', null, 'p:vm-str:gtm')
      await page.close()
    }
  })
  test('a phone shows one card per group, the count line, and Show all 200 with 300 waiting tasks', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    world.queueOverride = bigQueue()
    try {
      const t0 = Date.now()
      await openLimits(page, true)
      await page.getByRole('region', { name: 'Queued after other tasks' }).getByRole('button', { name: 'Queued after other tasks' }).tap()
      const group = page.locator('li[data-group="queued:herdr-projects"]')
      await group.waitFor()
      const render = Date.now() - t0
      console.log(`SHE-162 phone, 300 waiting tasks: rendered in ${render}ms`)
      expect(render).toBeLessThan(15_000)
      const waiting = page.getByRole('region', { name: 'Waiting now' })
      expect(await waiting.locator('h2 + div').textContent()).toContain('200 queued after other tasks')
      expect(await group.locator('ul > li').count()).toBe(10)
      await group.getByRole('button', { name: 'Show all 200' }).tap()
      expect(await group.locator('ul > li').count()).toBe(200)
      // each other section opens to its own cards
      for (const [name, text] of [
        ['Scheduled', 'Starts'],
        ['Waiting for a go', 'Added'],
        ['Merges waiting', 'Waiting for other'],
      ] as const) {
        const sec = page.getByRole('region', { name })
        await sec.getByRole('button', { name }).tap()
        await sec.getByText(text, { exact: false }).first().waitFor()
      }
    } finally {
      world.queueOverride = undefined
      await page.close()
    }
  })
})
