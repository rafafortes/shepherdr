// Settings → Limits, Waiting now: what holds the held tasks, the advisor and reviews, the empty page, and 300 waiting
// tasks drawn lightly, in a real browser (layout.ts).
import { afterAll, describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import type { LimitsQueue } from '../shared/types.ts'
import { layout, settled } from './layout.ts'
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
  if (phone) await page.getByRole('button', { name: 'Places', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('region', { name: 'Settings' }).getByRole('button', { name: 'Limits', exact: true }).click()
  await settled(page)
}

describe.skipIf(!browser)('Settings → Limits on a desktop', () => {
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
  test('Waiting now names every kind, numbers the held tasks in the engine order, marks the chain that needs you and remembers what you opened', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await page.goto(url())
      await page.evaluate(() => localStorage.removeItem('limits:waiting'))
      await openLimits(page)
      const waiting = page.getByRole('region', { name: 'Waiting now' })
      expect(await waiting.locator('h2 + div').textContent()).toBe('2 held for room · 3 queued after other tasks · 1 scheduled · 1 waiting for a go · 1 merge waiting')
      // one line per space with something waiting
      await waiting.getByText(/herdr-projects:.*queued/).waitFor()
      // Held for room is open, its tasks numbered 1 and 2 in the engine's start order
      const held = page.getByRole('region', { name: 'Held for room' })
      expect(await held.getByRole('button', { name: 'Held for room' }).getAttribute('aria-expanded')).toBe('true')
      expect(await held.locator('li', { hasText: 'HP-204' }).last().textContent()).toContain('1.')
      expect(await held.locator('li', { hasText: 'GTM-17' }).last().textContent()).toContain('2.')
      // the other four sections start closed
      for (const name of ['Queued after other tasks', 'Scheduled', 'Waiting for a go', 'Merges waiting']) {
        const sec = page.getByRole('region', { name })
        expect(await sec.getByRole('button', { name }).getAttribute('aria-expanded')).toBe('false')
      }
      // open Queued: the needs-you line, the direct mark and the chain of two
      const queued = page.getByRole('region', { name: 'Queued after other tasks' })
      await queued.getByRole('button', { name: 'Queued after other tasks' }).click()
      await queued.getByText('2 tasks wait behind 1 task that needs you: HP-201').waitFor()
      await queued.getByText('After HP-201, which waits for your reply').waitFor()
      await queued.getByText('After HP-205 · HP-201 waits for your reply').waitFor()
      for (const [name, text] of [
        ['Scheduled', 'Starts'],
        ['Waiting for a go', 'Added'],
        ['Merges waiting', "Waiting for GTM-18's merge"],
      ] as const) {
        const sec = page.getByRole('region', { name })
        await sec.getByRole('button', { name }).click()
        await sec.getByText(text, { exact: false }).first().waitFor()
      }
      // what the viewer opened is kept across a fresh look
      await openLimits(page)
      expect(await page.getByRole('region', { name: 'Queued after other tasks' }).getByRole('button', { name: 'Queued after other tasks' }).getAttribute('aria-expanded')).toBe('true')
      expect(await page.getByRole('region', { name: 'Scheduled' }).getByRole('button', { name: 'Scheduled' }).getAttribute('aria-expanded')).toBe('true')
    } finally {
      await page.close()
    }
  })
  test('with nothing waiting it says what it always did, and an empty section says so too', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    world.waitingEmpty = true
    try {
      await openLimits(page)
      const waiting = page.getByRole('region', { name: 'Waiting now' })
      expect(await waiting.locator('h2 + div').textContent()).toBe('Nothing is held for room')
      await waiting.getByText('Every limit has room now: nothing waits for a slot, a load or a cap.').waitFor()
      expect(await waiting.locator('li[data-group]').count()).toBe(0)
      // no empty section headers either: the page says only what it said before
      expect(await page.getByRole('region', { name: 'Held for room' }).count()).toBe(0)
      expect(await page.getByRole('region', { name: 'Scheduled' }).count()).toBe(0)
      // an empty section reached another way (a queue override with only held) says so in its group
      world.waitingEmpty = false
      world.queueOverride = { queued: [], scheduled: [], todo: [], merges: [] }
      await world.act({ type: 'setting', key: 'machine.maxTasks', value: '7', place: 'm:vm-str' } as never)
      await page.goto(url())
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('region', { name: 'Settings' }).getByRole('button', { name: 'Limits', exact: true }).click()
      await settled(page)
      const scheduled = page.getByRole('region', { name: 'Scheduled' })
      await scheduled.getByRole('button', { name: 'Scheduled' }).click()
      await scheduled.getByText('Nothing here now.').waitFor()
      await world.act({ type: 'setting', key: 'machine.maxTasks', value: null, place: 'm:vm-str' } as never)
    } finally {
      world.waitingEmpty = undefined
      await page.close()
    }
  })
  test('a group of 200 shows ten rows and Show all 200, and a line of 300 tasks builds and renders quickly', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    world.queueOverride = bigQueue()
    try {
      const t0 = Date.now()
      await openLimits(page)
      await page.getByRole('region', { name: 'Queued after other tasks' }).getByRole('button', { name: 'Queued after other tasks' }).click()
      const group = page.locator('li[data-group="queued:herdr-projects"]')
      await group.waitFor()
      const render = Date.now() - t0
      const t1 = Date.now()
      await world.act({ type: 'limits-view' })
      const build = Date.now() - t1
      console.log(`SHE-162 300 waiting tasks: view built in ${build}ms, page rendered in ${render}ms`)
      expect(build).toBeLessThan(2000)
      expect(render).toBeLessThan(15_000)
      // ten rows show, and Show all 200 opens them all
      expect(await group.locator('ul > li').count()).toBe(10)
      await group.getByRole('button', { name: 'Show all 200' }).click()
      expect(await group.locator('ul > li').count()).toBe(200)
      await group.getByRole('button', { name: 'Show less' }).click()
      expect(await group.locator('ul > li').count()).toBe(10)
      // the other kinds have the same count and Show all: their rows stay light too
      const scheduled = page.getByRole('region', { name: 'Scheduled' })
      await scheduled.getByRole('button', { name: 'Scheduled' }).click()
      const schedGroup = page.locator('li[data-group="list:scheduled"]')
      expect(await schedGroup.locator('ul > li').count()).toBe(10)
      await schedGroup.getByRole('button', { name: 'Show all 50' }).click()
      expect(await schedGroup.locator('ul > li').count()).toBe(50)
    } finally {
      world.queueOverride = undefined
      await page.close()
    }
  })
})

describe.skipIf(!browser)('Settings → Limits: the Waiting now sections and their buttons', () => {
  test('each section is a level 3 heading around its button, which says whether it is open and what it controls', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      const waiting = page.getByRole('region', { name: 'Waiting now' })
      // the heading holds the button (a button holding the heading would lose it to a screen reader)
      const heading = waiting.getByRole('heading', { level: 3, name: 'Held for room', exact: true })
      await heading.waitFor()
      const button = heading.getByRole('button', { name: 'Held for room', exact: true })
      expect(await button.getAttribute('aria-expanded')).toBe('true')
      const controlled = (await button.getAttribute('aria-controls'))!
      expect(controlled).toBeTruthy()
      expect(await page.locator(`#${controlled}`).count()).toBe(1)
      expect(await page.locator(`#${controlled} li[data-group]`).count()).toBeGreaterThan(0)
      // closed: it says so, the region it names is still there and empty, and the heading is still a heading
      await button.click()
      expect(await button.getAttribute('aria-expanded')).toBe('false')
      expect(await page.locator(`#${controlled} li[data-group]`).count()).toBe(0)
      await waiting.getByRole('heading', { level: 3, name: 'Held for room', exact: true }).waitFor()
      await button.click()
      expect(await button.getAttribute('aria-expanded')).toBe('true')
      // every section of it is one, in order (a heading's name is what a screen reader reads: the sign is not in it)
      expect(await waiting.getByRole('heading', { level: 3 }).count()).toBe(5)
      for (const name of ['Held for room', 'Queued after other tasks', 'Scheduled', 'Waiting for a go', 'Merges waiting']) await waiting.getByRole('heading', { level: 3, name, exact: true }).waitFor()
    } finally {
      await page.close()
    }
  })

  test('the tasks that need you are buttons that open them, one after another and never run together', async () => {
    world.queueOverride = {
      queued: [
        { id: 'HP-205', space: 'herdr-projects', spaceName: 'herdr-projects', words: 'After HP-202', need: { id: 'HP-201', words: 'waits for your reply' } },
        { id: 'HP-206', space: 'herdr-projects', spaceName: 'herdr-projects', words: 'After HP-205', need: { id: 'HP-202', words: 'waits for your reply' } },
      ],
      scheduled: [],
      todo: [],
      merges: [],
    }
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      const section = page.getByRole('region', { name: 'Queued after other tasks' })
      await section.getByRole('button', { name: 'Queued after other tasks', exact: true }).click()
      const line = section.getByText(/tasks wait behind 2 tasks that need you:/).first()
      await line.waitFor()
      // the count stays words, and the ids are the rows' own buttons, kept apart as a sentence keeps them
      expect((await line.textContent())?.trim()).toBe('2 tasks wait behind 2 tasks that need you: HP-201, HP-202')
      const ids = line.getByRole('button', { name: /^[A-Z]+-\d+$/ })
      expect(await ids.count()).toBe(2)
      await ids.nth(1).click()
      await page.waitForURL(/[?&]task=HP-202(&|$)/, { timeout: 10_000 })
    } finally {
      world.queueOverride = undefined
      await page.close()
    }
  })
})
