// Mentioning a space or a task in the chat, in a real browser (layout.ts): "#" lists the spaces and "@" the tasks, a
// pick goes in as words and its mention is what the agent reads, and a message draws it as a chip that opens it. Both
// hands: a phone's taps and a desktop's arrows, Enter and Escape.
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { layout } from './layout.ts'

const { browser, world, url } = await layout()

describe.skipIf(!browser)('mentions in the chat', () => {
  const box = (page: Page) => page.getByRole('textbox', { name: /Message/ })
  const spaces = (page: Page) => page.getByRole('listbox', { name: 'Mention a space' })
  const tasks = (page: Page) => page.getByRole('listbox', { name: 'Mention a task' })

  test('the # list: the spaces, chosen with the arrows and taken with Enter', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.goto(url())
      const text = box(page)
      await text.click()
      await text.fill('look at #')
      await spaces(page).waitFor()
      // every space, the sidebar's order, each with its machine
      const rows = spaces(page).getByRole('option')
      // every space (the list shows six at most)
      expect(await rows.count()).toBe(Math.min(6, world.snapshot().places.length))
      expect(await rows.first().textContent()).toContain('home')
      await text.pressSequentially('gt')
      expect(await rows.count()).toBe(1)
      expect(await rows.first().textContent()).toContain('gtm')
      // Enter takes the row, never sends; the box holds the words the person can read
      await text.press('ArrowDown')
      await text.press('Enter')
      await spaces(page).waitFor({ state: 'detached' })
      expect(await text.inputValue()).toBe('look at #gtm ')
      // Tab takes it too, and the arrows wrap round the list
      await text.fill('see @')
      await tasks(page).waitFor()
      await text.press('ArrowUp')
      expect(await tasks(page).getByRole('option').last().getAttribute('aria-selected')).toBe('true')
      await text.press('Tab')
      await tasks(page).waitFor({ state: 'detached' })
      expect(await text.inputValue()).toMatch(/^see @\S+ $/)
      // a heading typed in the box is no list either: only "#word" is
      await text.fill('# Release notes')
      expect(await spaces(page).count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 45_000)

  test('Escape closes the list and leaves the words; typing on opens it again', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.goto(url())
      const text = box(page)
      await text.click()
      await text.fill('@')
      await tasks(page).waitFor()
      await text.press('Escape')
      // the box keeps the focus and its words; the key only closed the list
      expect(await tasks(page).count()).toBe(0)
      expect(await text.evaluate((el) => el === document.activeElement)).toBe(true)
      expect(await text.inputValue()).toBe('@')
      await text.pressSequentially('HP')
      await tasks(page).waitFor()
    } finally {
      await page.close()
    }
  }, 45_000)

  test('the @ list: waiting on you and at work first, Done last, and a pick sends as its mention', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.goto(url())
      const text = box(page)
      await text.click()
      await text.fill('@')
      await tasks(page).waitFor()
      const rows = tasks(page).getByRole('option')
      const shown = await rows.allInnerTexts()
      // the first rows are the ones waiting on the person or at work; a Done one comes only past the rest
      expect(shown[0]).toContain('Needs you')
      expect(shown.length).toBeLessThanOrEqual(8)
      expect(shown.some((t) => t.includes('Done'))).toBe(false)
      await text.fill('@HP-202')
      expect(await rows.count()).toBe(1)
      expect(await rows.first().textContent()).toContain('Working')
      await text.press('Enter')
      expect(await text.inputValue()).toBe('@HP-202 ')
      // Send writes the mention the agent reads: the words go in as text, and the chat draws them back as a chip
      await text.press('Enter')
      // the chip stands in the message the log handed back (not one still on its way): drawn from the words, not a token
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-you] [data-anchor]')].some(
          (e) => e.textContent?.includes('HP-202') && !!e.querySelector('[data-mention="open"]') && !e.closest('[data-msg]')?.getAttribute('data-msg')?.startsWith('out:'),
        ),
      )
      const chip = page.getByRole('button', { name: 'Open task HP-202' }).last()
      await chip.click()
      await page.waitForFunction(() => location.search.includes('task=HP-202'))
      await page.close()
    } finally {
      await page.close()
    }
  }, 45_000)

  test('a pick comes back with the draft it belongs to when the screen reloads', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.goto(url())
      const text = box(page)
      await text.click()
      await text.fill('see #')
      await spaces(page).waitFor()
      await spaces(page).getByRole('option', { name: /gtm/ }).click()
      expect(await text.inputValue()).toBe('see #gtm ')
      // the screen reloads itself on a new build, keeping the half-typed words (kernel.ts): the pick goes with them,
      // so the mention is not sent as plain words
      await page.evaluate(() => sessionStorage.setItem('shepherdr.kept', JSON.stringify({ text: { 'p:vm-str:~': 'see #gtm ' } })))
      await page.goto(url())
      await box(page).waitFor()
      expect(await box(page).inputValue()).toBe('see #gtm ')
      await box(page).press('Enter')
      await page.getByRole('button', { name: 'Open space gtm' }).last().waitFor()
    } finally {
      await page.close()
    }
  }, 45_000)

  test('a phone: a tap picks, the Send button sends, and the chip opens the space', async () => {
    const ctx = await browser!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const page = await ctx.newPage()
    try {
      await page.goto(url())
      const text = box(page)
      await text.tap()
      await text.fill('see #')
      const list = spaces(page)
      await list.waitFor()
      // the list fits the phone: never wider than the screen, and no taller than a phone's list may be
      const size = await page
        .locator('[data-mentions]')
        .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, height: el.getBoundingClientRect().height, room: innerHeight }))
      expect(size.scroll).toBeLessThanOrEqual(size.client + 1)
      expect(size.height).toBeLessThanOrEqual(size.room * 0.45)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await list.getByRole('option', { name: /gtm/ }).tap()
      await list.waitFor({ state: 'detached' })
      expect(await text.inputValue()).toBe('see #gtm ')
      // the box kept the keyboard up (the tap never took the focus away)
      expect(await text.evaluate((el) => el === document.activeElement)).toBe(true)
      await page.getByRole('button', { name: 'Send' }).tap()
      const chip = page.locator('[data-you]').last().getByRole('button', { name: 'Open space gtm' })
      await chip.waitFor()
      await chip.tap()
      await page.waitForFunction(() => new URL(location.href).searchParams.get('place') === 'vm-str/gtm')
    } finally {
      await ctx.close()
    }
  }, 45_000)

  test("an agent's reply draws a mention as a chip, and code keeps its words", async () => {
    world.chats['p:vm-str:~'].messages.push({
      id: 'mention-reply',
      who: 'agent',
      at: Date.now() + 5,
      text: 'Ask [#gtm](space:p:vm-str:gtm) about it; [@HP-202](task:HP-202) holds the call fix, and [#gone](space:p:vm-str:gone) is a space that left.\n\n```sh\n[@HP-202](task:HP-202)\n```',
    })
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.goto(url())
      const reply = page.locator('[data-msg="mention-reply"]')
      await reply.waitFor()
      // one chip for the space and one for the task, each naming what it opens
      expect(await reply.getByRole('button', { name: 'Open space gtm' }).count()).toBe(1)
      expect(await reply.getByRole('button', { name: 'Open task HP-202' }).count()).toBe(1)
      // the code block is code: the tokens in it are words
      expect((await reply.locator('pre code').first().textContent())?.trim()).toBe('[@HP-202](task:HP-202)')
      // a space that isn't here any more is its words alone, and no button: nothing to open
      expect(await reply.locator('[data-mention="gone"]').count()).toBe(1)
      expect(await reply.getByRole('button', { name: 'Open space gone' }).count()).toBe(0)
      await reply.getByRole('button', { name: 'Open space gtm' }).click()
      await page.waitForFunction(() => new URL(location.href).searchParams.get('place') === 'vm-str/gtm')
      // mail keeps its @, and nothing opens a list for it
      await box(page).click()
      await box(page).fill('mail me at a@b.com')
      expect(await tasks(page).count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 45_000)
})
