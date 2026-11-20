// The chat's message list is windowed: the last rows render, and the list grows upwards as the reader scrolls to
// the top (the sentinel, or their own wheel and keys) or a jump asks for a message outside the window. The store
// keeps every message; only the DOM is capped, and a reveal never moves the message the reader is on (the browser
// keeps their place while the batch goes in). The window's floor logic is test/chat-window.test.ts.
// biome-ignore-all lint/style/noNonNullAssertion: a Playwright bounding box is non-null once its element has appeared
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { layout } from './layout.ts'
import type { Message } from '../shared/types.ts'

const { browser, world, url, server } = await layout()

/** the chat the demo opens at: the home space's coordinator */
const KEY = 'p:vm-str:~'
const emit = () => (world as unknown as { emit(e: string, k: string): void }).emit('chat', KEY)

/** a long chat, one line a message, newest last */
const long = (n: number): Message[] =>
  Array.from(
    { length: n },
    (_, i): Message => ({
      id: `win-${i}`,
      who: i % 2 ? 'agent' : 'you',
      text: i % 2 ? `A reply number ${i}` : `Question number ${i}`,
      at: 1_700_000_000_000 + i * 1000,
    }),
  )

/** the scroll box of the chat (the overflow of StickToBottom) */
const box = (page: Page) => page.locator('[data-msg]').first().locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]')

describe.skipIf(!browser)('the chat windows its message list', () => {
  test('a 350-message chat renders its window; a reveal widens it without moving the reader; at the start it is all', async () => {
    const chat = world.chats[KEY]
    const old = chat.messages
    chat.messages = long(350)
    emit()
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(url())
      await page.locator('[data-msg="win-349"]').waitFor()
      // the whole chat is in the store; the DOM holds the window (the last 200 of the 350 rows)
      expect(await page.locator('[data-msg="win-0"]').count()).toBe(0)
      expect(await page.locator('[data-msg]').count()).toBe(200)
      expect(await page.locator('[data-earlier]').getAttribute('aria-label')).toBe('Earlier messages: show 100 more')

      // the reader's own reveal (a tap on the sentinel): one more batch, and the message they are on does not move
      // (the browser keeps their place while the batch goes in above)
      const marker = page.locator('[data-msg="win-340"]')
      const before = await marker.boundingBox()
      await page.locator('[data-earlier]').click()
      await page.locator('[data-msg="win-149"]').waitFor()
      const after = await marker.boundingBox()
      expect(Math.abs(after!.y - before!.y)).toBeLessThan(2)
      // the next (last) batch is offered, and the newest row is still there
      expect(await page.locator('[data-earlier]').getAttribute('aria-label')).toBe('Earlier messages: show 50 more')
      expect(await page.locator('[data-msg="win-349"]').count()).toBe(1)

      // the reader's own way up from there (wheel, and the sentinel once they are back at the top after a batch
      // goes in): at the start the sentinel is gone and the whole chat is rendered
      const b = box(page)
      const c = (await b.boundingBox())!
      await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2)
      for (let i = 0; i < 200; i++) {
        if (await page.locator('[data-msg="win-0"]').count()) break
        const top = await b.evaluate((el) => el.scrollTop)
        if (top >= 48) await page.mouse.wheel(0, -500)
        else await page.locator('[data-earlier]').click()
        await page.waitForTimeout(40)
      }
      await page.locator('[data-msg="win-0"]').waitFor()
      expect(await page.locator('[data-earlier]').count()).toBe(0)
      expect(await page.locator('[data-msg]').count()).toBe(350)
    } finally {
      chat.messages = old
      await page.close()
    }
  }, 60_000)

  test('a new message in a windowed chat lands at the bottom, and the reader back at the top reveals on their own', async () => {
    const chat = world.chats[KEY]
    const old = chat.messages
    chat.messages = long(350)
    emit()
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(url())
      await page.locator('[data-msg="win-349"]').waitFor()
      // one comes in: it lands at the end of the window, the newest row, with the reader following to it. The
      // window keeps its size (200 rows): the oldest one in it gives way
      chat.messages = [...chat.messages, { id: 'win-new', who: 'agent', text: 'A new reply', at: 1_700_000_000_000 + 350_000 }]
      emit()
      await page.locator('[data-msg="win-new"]').waitFor()
      expect(await page.locator('[data-msg]').count()).toBe(200)
      expect(await page.locator('[data-msg="win-150"]').count()).toBe(0)
      // the reader up at the top, wheeling: the reveal is theirs (the window had not moved by itself)
      const b = box(page)
      const c = (await b.boundingBox())!
      await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2)
      for (let i = 0; i < 200; i++) {
        if (await page.locator('[data-msg="win-149"]').count()) break
        const top = await b.evaluate((el) => el.scrollTop)
        if (top >= 48) await page.mouse.wheel(0, -500)
        else await page.locator('[data-earlier]').click()
        await page.waitForTimeout(40)
      }
      await page.locator('[data-msg="win-149"]').waitFor()
      expect(await page.locator('[data-msg="win-149"]').count()).toBe(1)
      expect(await page.locator('[data-msg="win-new"]').count()).toBe(1)
    } finally {
      chat.messages = old
      await page.close()
    }
  }, 60_000)

  test('search in the chat reaches a match outside the window, brought into view and lit', async () => {
    const chat = world.chats[KEY]
    const old = chat.messages
    chat.messages = long(1000)
    chat.messages[50]!.text = 'An old reply with the needle word in it'
    chat.messages[999]!.text = 'The newest, with the needle word'
    emit()
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(url())
      await page.locator('[data-msg="win-999"]').waitFor()
      // the chat's own search (⋯), over the whole chat: the bar finds across the store, not the window
      await page.getByRole('button', { name: /^Menu/ }).click()
      await page.getByRole('menuitem', { name: 'Search in this chat' }).click()
      const input = page.locator('input[name="find"]')
      await input.fill('needle word')
      // both matches are found across the whole chat; the newest of them (in the window) is looked at first
      // (the count goes from the newest, the list itself is the oldest first)
      await page.getByRole('status').getByText('2 of 2').waitFor()
      // stepping to the older one widens the window to its row and lights it
      await input.press('Enter')
      await page.locator('[data-msg="win-50"] [data-flash]').waitFor()
      expect(await page.locator('[data-msg="win-50"]').count()).toBe(1)
      // and the window keeps it after the jump: the next step back finds the newest again, no reveal asked
      await input.press('Enter')
      await page.locator('[data-msg="win-999"] [data-flash]').waitFor()
    } finally {
      chat.messages = old
      await page.close()
    }
  }, 60_000)

  test("the sentinel answers a tap, an Enter and the reader's keys alike, and a jump asks for a row outside the window", async () => {
    const chat = world.chats[KEY]
    const old = chat.messages
    chat.messages = long(400)
    chat.messages.push({
      id: 'quoted-new',
      who: 'agent',
      text: 'On to your other point.',
      at: 1_700_000_000_000 + 400_000,
      reply: { id: 'win-120', who: 'you', text: 'Question number 120' },
    })
    emit()
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(url())
      await page.locator('[data-msg="quoted-new"]').waitFor()
      expect(await page.locator('[data-msg]').count()).toBe(200)
      // the quoted message is above the window: its row is not there yet
      expect(await page.locator('[data-msg="win-120"]').count()).toBe(0)
      // a tap on the reply quote widens the window to the message it answers, and lights it
      await page.locator('[data-msg="quoted-new"] [data-quote]').click()
      await page.locator('[data-msg="win-120"] [data-flash]').waitFor()

      // the reader's own way up: an Enter on the sentinel reveals one batch (the reader sits at the top)
      await page.locator('[data-earlier]').focus()
      await page.keyboard.press('Enter')
      await page.locator('[data-msg="win-110"]').waitFor()
      // and the reader's keys: at the top, one more step up reveals the last one
      expect(await page.locator('[data-msg="win-0"]').count()).toBe(0)
      await page.keyboard.press('Home')
      await page.locator('[data-msg="win-0"]').waitFor()
      expect(await page.locator('[data-earlier]').count()).toBe(0)
    } finally {
      chat.messages = old
      await page.close()
    }
  }, 60_000)

  test("an alert's link to a card outside the window reveals it, lights it once, and keeps it on a push", async () => {
    const chat = world.chats[KEY]
    const old = chat.messages
    chat.messages = long(400)
    const base = 1_700_000_000_000
    // a question card high up in the chat: its row is outside the window when the chat opens
    chat.messages[150] = {
      id: 'alert-q',
      who: 'agent',
      text: 'Which one?',
      question: { id: 'alert:q', title: 'Which one?', kind: 'Form', choices: [{ label: 'A' }, { label: 'B' }], to: KEY },
      at: base + 150_000,
    }
    emit()
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
    // the light lasts a moment; remember it so a slow glide to the row still finds what was lit
    await page.addInitScript(() =>
      new MutationObserver((ms) => {
        for (const m of ms) {
          const el = m.target as Element
          if (!el.hasAttribute('data-flash')) continue
          for (const was of document.querySelectorAll('[data-lit]')) was.removeAttribute('data-lit')
          el.setAttribute('data-lit', '')
        }
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-flash'] }),
    )
    try {
      // the app's own cold-open path for a link: its ?focus address, the card's id
      await page.goto(`http://127.0.0.1:${server!.port}/?place=vm-str/home&focus=${encodeURIComponent('alert:q')}`)
      const flashed = await page.waitForFunction(() => {
        const f = document.querySelector('[data-lit]')
        const b = f?.getBoundingClientRect()
        if (!f || !b || b.top < 0 || b.top > innerHeight - 100) return null
        return { card: f.hasAttribute('data-card'), msg: f.closest('[data-whole]')?.getAttribute('data-whole'), inView: true }
      })
      // the window widened to the card's row, and it is lit in view
      expect(await flashed.jsonValue()).toEqual({ card: true, msg: 'alert-q', inView: true })
      expect(await page.locator('[data-msg="alert-q"]').count()).toBe(1)
      // a push in the meantime must not take the card out again: the floor only moves up
      chat.messages = [...chat.messages, { id: 'win-after', who: 'agent', text: 'And on.', at: base + 401_000 }]
      emit()
      await page.locator('[data-msg="win-after"]').waitFor()
      expect(await page.locator('[data-msg="alert-q"]').count()).toBe(1)
    } finally {
      chat.messages = old
      await page.close()
    }
  }, 60_000)
})
