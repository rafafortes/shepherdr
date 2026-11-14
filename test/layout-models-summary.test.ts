// Settings → Models → Summary, on the screen: the providers and their models with what each was configured as, ran and
// used (the share bars), the run-out that is out now with its time; a warning's Change opens the cell it names; Hide keeps
// a warning away for the browser session only; and the phone's cards, nothing wider than the screen.
import { afterAll, describe, expect, test } from 'bun:test'
import type { Locator, Page } from 'playwright-core'
import { at, layout, rowLabels, settled } from './layout.ts'
import { piOffers } from './pi-offers.ts'

// pi lists nvidia and amd-tokenlab, which nothing in the demo uses: they are the providers under Other providers
const restorePi = piOffers()
afterAll(restorePi)
const { browser, world, url } = await layout()

/** the Models page on a desktop, opened from Settings */
async function openModels(page: Page) {
  await page.goto(url())
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Models', exact: true }).click()
  await settled(page)
  return page.locator('section[aria-label="Summary"]')
}
/** whether the second element comes after the first in the page */
const follows = (first: Locator, second: Locator) => second.elementHandle().then((h) => first.evaluate((el, other) => (el.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, h))
/** the warnings still shown */
const warnings = (page: Page) => page.locator('section[aria-label="Warnings"] li')
/** the open cell editor */
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit this setting' })

describe.skipIf(!browser)('Settings → Models → Summary on a desktop', () => {
  test('providers are grouped under their harness: Claude Code and Codex as rows, pi and OpenCode with a heading each, OpenCode Go under both', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      const labels = await rowLabels(s.getByRole('table', { name: 'Providers and models' }))
      expect(at(labels, 'Claude Code')).toBeLessThan(at(labels, 'Codex'))
      expect(at(labels, 'Codex')).toBeLessThan(at(labels, '[pi]'))
      expect(at(labels, '[pi]')).toBeLessThan(at(labels, 'Spark (local)'))
      expect(at(labels, 'Spark (local)')).toBeLessThan(at(labels, '[OpenCode]'))
      expect(at(labels, '[OpenCode]')).toBeLessThan(labels.lastIndexOf('OpenCode Go'))
      // OpenCode Go's plan is two rows, one under each harness, each with its own usage
      expect(labels.filter((l) => l === 'OpenCode Go')).toHaveLength(2)
    } finally {
      await page.close()
    }
  })

  test('Anthropic API under pi and Claude Code are separate rows, each with the cap set for it', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await world.act({ type: 'setting', key: 'models.maxAtOnce', value: 'claude=3, pi.anthropic=2', place: 'm:vm-str' } as never)
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      const table = s.getByRole('table', { name: 'Providers and models' })
      const labels = await rowLabels(table)
      expect(at(labels, 'Claude Code')).toBeLessThan(at(labels, '[pi]'))
      expect(at(labels, 'Anthropic API')).toBeGreaterThan(at(labels, '[pi]'))
      await table.getByRole('button', { name: /^Anthropic API: \d+ of 2 at once/ }).waitFor()
      await table.getByRole('button', { name: /^Claude Code: \d+ of 3 at once/ }).waitFor()
    } finally {
      await world.act({ type: 'setting', key: 'models.maxAtOnce', value: null, place: 'm:vm-str' } as never)
      await page.close()
    }
  })

  test('each provider with its models: what is configured and running, the share of the tokens, the usage of each window, the run-out out now with its time', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      const table = s.getByRole('table', { name: 'Providers and models' })
      // the providers, by their names, then the models under them
      for (const name of ['Claude Code', 'Codex', 'OpenCode Go']) await table.getByRole('rowheader', { name: new RegExp(`^${name}`) }).first().waitFor()
      expect(await table.getByRole('rowheader', { name: /^Opus 5\.5/ }).count()).toBeGreaterThan(0)
      // a bar per provider: its share of the tokens in a day and in a week
      expect(await s.getByRole('img', { name: /^24 h: \d+% of the tokens$/ }).count()).toBeGreaterThan(0)
      expect(await s.getByRole('img', { name: /^7 d: \d+% of the tokens$/ }).count()).toBeGreaterThan(0)
      // what each window used, one compact line ("5 h 237k · 12"); the words in full and pi's cost as an estimate are its tooltip
      expect(await table.getByText(/^5 h \d+k · \d+$/).count()).toBeGreaterThan(0)
      expect(await table.locator('li[title$="est."]').count()).toBeGreaterThan(0)
      expect(await table.locator('li[title^="5 h: "]').first().getAttribute('title')).toMatch(/^5 h: .+ tokens · \d+ calls?/)
      // OpenCode Go ran out twice this week, and is out now until a time
      expect(await table.getByText(/^2 run-outs in 7 d$/).count()).toBeGreaterThan(0)
      expect(await table.getByText(/^Out until /).count()).toBeGreaterThan(0)
      // the quota slot is there: the windows a read gave, the refilled one left out; — where none was read
      expect(await table.getByRole('columnheader', { name: 'Quota' }).count()).toBe(1)
      expect(await table.getByRole('img', { name: '5 h: 62% used' }).count()).toBe(1)
      expect(await table.getByText(/Last month/).count()).toBe(0)
      expect(await table.getByText('—').count()).toBeGreaterThan(0)
    } finally {
      await page.close()
    }
  })

  test('the providers nothing uses yet are under Other providers, closed: their models under them with the full id as a title, and dashes for the numbers', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      const group = s.locator('details').filter({ hasText: /^Other providers \(\d+\)/ })
      expect(await group.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
      await group.locator('summary').click()
      const idle = s.getByRole('table', { name: 'Other providers' })
      await idle.getByRole('rowheader', { name: /^NVIDIA API/ }).waitFor()
      // its model names its provider in its title, and shows the id without it; nothing ran, so no "none in 7 d" but a dash
      expect(await idle.locator('span[title="pi.nvidia/mistralai/mistral-large-4-1t-a52b"]').textContent()).toBe('mistralai/mistral-large-4-1t-a52b')
      expect(await idle.getByText('none in 7 d').count()).toBe(0)
      expect(await idle.getByText('—').count()).toBeGreaterThan(0)
      // a provider in use is not among them
      expect(await idle.getByRole('rowheader', { name: /^OpenCode Go/ }).count()).toBe(0)
    } finally {
      await page.close()
    }
  })

  test('the columns in order, Provider first and Configured last; the whole summary fits a 1440 px window with no sideways scroll', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      const table = s.getByRole('table', { name: 'Providers and models' })
      expect(await table.getByRole('columnheader').allTextContents()).toEqual(['Provider', 'Quota', 'Run-outs', 'Used', 'Configured, and now'])
      // the table is no wider than its box, and the page does not scroll sideways
      const fit = await table.evaluate((el) => {
        const box = el.parentElement!
        return { table: el.getBoundingClientRect().width, box: box.clientWidth, scroll: box.scrollWidth, page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }
      })
      expect(fit.scroll).toBeLessThanOrEqual(fit.box)
      expect(fit.page).toBeLessThanOrEqual(fit.view)
      // a long model id is cut with an ellipsis and keeps its full name in the tooltip
      const id = table.locator('th[scope="row"] span.truncate').last()
      expect(await id.getAttribute('title')).toBeTruthy()
    } finally {
      await page.close()
    }
  })

  test("a warning's Change opens the cell it names, with its CLI, model and effort", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      // the first warning names a backup that runs the same model as its primary: Change opens that backup's editor
      expect(await warnings(page).count()).toBeGreaterThan(0)
      await warnings(page).first().getByRole('button', { name: 'Change…', exact: true }).click()
      const pop = editor(page)
      await pop.waitFor()
      expect(await pop.textContent()).toMatch(/· Tasks · Backup \d/)
      expect(await pop.getByRole('button', { name: /^(Agent|Backup): / }).count()).toBe(1)
    } finally {
      await page.close()
    }
  })

  test("OpenCode Go's plan, which pi and OpenCode both run, is warned about once, naming both harnesses", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      // its figure is on both of its rows: one warning for the plan, not one for each row
      const plan = warnings(page).filter({ hasText: /OpenCode Go( \(|:).*is at \d+%/ })
      expect(await plan.count()).toBe(1)
      expect(await plan.first().textContent()).toContain('OpenCode Go (pi and OpenCode): ')
    } finally {
      await page.close()
    }
  })

  test('a hidden warning stays hidden through a reload of this session, and comes back in a new one', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    const fresh = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      const shown = await warnings(page).count()
      await warnings(page).first().getByRole('button', { name: /^Hide for this session/ }).click()
      expect(await warnings(page).count()).toBe(shown - 1)
      // the same tab, reloaded: still hidden
      const again = await openModels(page)
      await again.scrollIntoViewIfNeeded()
      expect(await warnings(page).count()).toBe(shown - 1)
      // another browser session: every warning is there
      const other = await openModels(fresh)
      await other.scrollIntoViewIfNeeded()
      expect(await warnings(fresh).count()).toBe(shown)
      // hidden one by one, the last one takes the list with it
      for (let left = shown - 1; left > 0; left--) await warnings(fresh).first().getByRole('button', { name: /^Hide for this session/ }).click()
      await warnings(fresh).first().getByRole('button', { name: /^Hide for this session/ }).click()
      expect(await fresh.locator('section[aria-label="Warnings"]').count()).toBe(0)
    } finally {
      await page.close()
      await fresh.close()
    }
  })
})

describe.skipIf(!browser)('a browser that keeps no session storage for the hidden warnings', () => {
  test('the warnings still show, and Hide holds for this page only (the storage refuses both ways)', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      // the one key the hidden warnings use refuses to be read or written; every other key works as before
      await page.addInitScript(() => {
        const get = Storage.prototype.getItem
        const set = Storage.prototype.setItem
        Storage.prototype.getItem = function (key: string) {
          if (key === 'models-summary:hidden') throw new Error('storage denied')
          return get.call(this, key)
        }
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key === 'models-summary:hidden') throw new Error('storage denied')
          return set.call(this, key, value)
        }
      })
      const s = await openModels(page)
      await s.scrollIntoViewIfNeeded()
      const shown = await warnings(page).count()
      expect(shown).toBeGreaterThan(0)
      await warnings(page).first().getByRole('button', { name: /^Hide for this session/ }).click()
      expect(await warnings(page).count()).toBe(shown - 1)
    } finally {
      await page.close()
    }
  })
})

describe.skipIf(!browser)('Settings → Models → Summary on a phone', () => {
  test('each harness heading comes before its provider cards: pi, then Spark (local), then OpenCode', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Places', exact: true }).click()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('region', { name: 'Settings' }).getByRole('button', { name: 'Models', exact: true }).tap()
      await settled(page)
      const s = page.locator('section[aria-label="Summary"]')
      await s.scrollIntoViewIfNeeded()
      const pi = s.getByRole('heading', { name: 'pi', exact: true }).first()
      const spark = s.getByRole('heading', { name: /^Spark \(local\)/ })
      const opencode = s.getByRole('heading', { name: 'OpenCode', exact: true })
      await spark.waitFor()
      expect(await follows(pi, spark)).toBe(true)
      expect(await follows(spark, opencode)).toBe(true)
    } finally {
      await page.close()
    }
  })

  test('one card per provider with its models under it; the warnings with their buttons under their words; nothing wider than the screen', async () => {
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
      const cards = s.locator('ul > li').filter({ has: page.locator('h4') })
      expect(await s.locator('h4').allTextContents()).toEqual(expect.arrayContaining(['Claude Code', 'OpenCode Go']))
      expect(await cards.count()).toBeGreaterThanOrEqual(3)
      // the providers nothing uses yet are under Other providers, closed: opened, NVIDIA API's card is there
      await s.locator('summary', { hasText: /^Other providers \(\d+\)$/ }).tap()
      await s.locator('h4', { hasText: 'NVIDIA API' }).waitFor()
      // a warning's Change is under its words on a phone, and it opens the cell's editor under its line
      await warnings(page).first().getByRole('button', { name: 'Change…', exact: true }).tap()
      await page.getByText(/· Tasks · Backup \d/).first().waitFor()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    } finally {
      await page.close()
    }
  })
})
