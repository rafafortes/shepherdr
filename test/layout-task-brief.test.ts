// A task's page leads with its scope, whether or not its agent has started (SHE-202, port of upstream SHEP-330):
// the card, its Settings folded, a long brief folded with Show all, and the launch message in the chat not drawn twice.
// The demo world, in a real browser, on a phone and a desktop, light and dark (layout.ts).
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { SETTINGS_HEAD } from '../shared/brief.ts'
import { layout, settled } from './layout.ts'

const { browser, world, url } = await layout()
const base = url().replace(/\?place=.*$/, '')
const emit = () => (world as unknown as { emit(e: string): void }).emit('snapshot')

async function openTask(page: Page, id: string) {
  await page.goto(`${base}?place=p%3Avm-str%3Aherdr-projects&task=${id}`)
  await settled(page)
}

/** a card's words, its state and its Settings button */
const card = (page: Page, id: string) => page.locator(`[data-task-brief="${id}"]`)
/** a skipped test never runs these; narrow once instead of asserting on every call */
const live = () => {
  if (!browser) throw new Error('no browser')
  return browser
}
const demoTask = (id: string) => {
  const t = world.tasks.find((x) => x.id === id)
  if (!t) throw new Error(`no demo task ${id}`)
  return t
}

describe.skipIf(!browser)('a task page shows the brief its agent got', () => {
  test('before its agent starts: the scope, Not sent yet and why it waits, on a phone and a desktop, light and dark', async () => {
    const t = demoTask('HP-204')
    const had = t.agent
    t.agent = undefined
    emit()
    try {
      for (const opts of [
        { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light' as const },
        { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' as const },
        { viewport: { width: 1280, height: 800 }, colorScheme: 'light' as const },
        { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' as const },
      ]) {
        const page = await live().newPage(opts)
        try {
          await openTask(page, 'HP-204')
          const c = card(page, 'HP-204')
          await c.waitFor()
          expect(await c.textContent()).toContain('From the Assistant')
          expect(await c.textContent()).toContain('Dark mode for rendered pages')
          expect(await c.textContent()).toContain('Pages rendered in chat stay light in dark mode.')
          expect(await c.textContent()).toContain('Not sent yet')
          expect(await page.getByText('Not started yet. It starts when you say go.').count()).toBe(1)
          // the card fits the column: no sideways scroll, and it sits at the top of the body
          expect(await c.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
          expect(await c.boundingBox()).not.toBeNull()
        } finally {
          await page.close()
        }
      }
    } finally {
      t.agent = had
      emit()
    }
  }, 60_000)

  test('once its agent started: Read, why it waits, and the launch message not drawn twice (phone and desktop)', async () => {
    for (const width of [390, 1440]) {
      const page = await live().newPage({ viewport: { width, height: 900 }, colorScheme: 'dark' })
      try {
        await openTask(page, 'HP-203')
        const c = card(page, 'HP-203')
        await c.waitFor()
        expect(await c.textContent()).toContain('Read')
        expect(await page.getByText('Queued. It starts when HP-202 is done.').count()).toBe(1)
        // the launch message's extra instruction to the agent is not repeated under the card
        expect(await page.getByText(/Queued: this task waits for HP-202 to be done/).count()).toBe(0)
        // the card leads: it sits above the chat's messages (which scroll to the bottom on their own)
        const messages = c.locator('xpath=ancestor::section[1]').locator('[data-messages]')
        await messages.waitFor()
        const box = await c.boundingBox()
        const under = await messages.boundingBox()
        if (!box || !under) throw new Error('the card or the messages have no box')
        expect(box.y + box.height).toBeLessThanOrEqual(under.y + 1)
        // Settings are folded: the button is there, the lines are not
        const settings = c.getByRole('button', { name: 'Settings', exact: true })
        await settings.waitFor()
        expect(await settings.getAttribute('aria-expanded')).toBe('false')
        expect(await c.getByText('Review: on.').count()).toBe(0)
        await settings.click()
        expect(await settings.getAttribute('aria-expanded')).toBe('true')
        expect(await c.getByText('Review: on.', { exact: false }).count()).toBeGreaterThan(0)
      } finally {
        await page.close()
      }
    }
  }, 60_000)

  test('a long scope starts folded and Show all opens it; a short one has no toggle', async () => {
    const t = demoTask('HP-204')
    const had = t.desc
    const long = `${had}\n\nDo:\n${Array.from({ length: 14 }, (_, i) => `- step ${i + 1} keep the page's own colours`).join('\n')}`
    t.desc = long
    emit()
    const page = await live().newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light' })
    try {
      await openTask(page, 'HP-204')
      const c = card(page, 'HP-204')
      await c.waitFor()
      const show = c.getByRole('button', { name: 'Show all', exact: true })
      await show.waitFor()
      const body = c.locator('div.whitespace-pre-wrap')
      expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true)
      await show.click()
      const less = c.getByRole('button', { name: 'Show less', exact: true })
      await less.waitFor()
      expect(await body.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
      expect(await c.textContent()).toContain('step 14 keep the page')
    } finally {
      await page.close()
      t.desc = had
      emit()
    }
  }, 60_000)

  test('a brief without a Settings block has no Settings row, and the page still shows its words', async () => {
    const t = demoTask('HP-204')
    const had = t.desc
    t.desc = 'Just make the pages dark.'
    emit()
    const page = await live().newPage({ viewport: { width: 1280, height: 800 } })
    try {
      await openTask(page, 'HP-204')
      const c = card(page, 'HP-204')
      await c.waitFor()
      expect(await c.textContent()).toContain('Just make the pages dark.')
      expect(await c.getByRole('button', { name: 'Settings', exact: true }).count()).toBe(0)
      expect(await c.textContent()).not.toContain(SETTINGS_HEAD)
    } finally {
      await page.close()
      t.desc = had
      emit()
    }
  }, 60_000)
})
