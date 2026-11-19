// The search surface's own chat loads: an empty query must not ask the server for any chat, and a query must stay
// bounded. The search socket is the one whose watch frames carry `visible: false` (the screen's own watch is visible).
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import type { Message } from '../shared/types.ts'
import { layout, until } from './layout.ts'

const { browser, world, url } = await layout({ everything: true })
type Watch = { type: string; chats: string[]; term: unknown; visible: boolean }

const watchFrames = (page: Page) => {
  const watches: Watch[] = []
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => {
      try {
        const m = JSON.parse(String(payload))
        if (m.type === 'watch' && m.visible === false) watches.push(m)
      } catch {
        /* other socket traffic */
      }
    }),
  )
  return watches
}

describe.skipIf(!browser)('bounded search chat loads', () => {
  test('opening with no query sends no chat watch and builds no message hits', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    const watches = watchFrames(page)
    const key = 'LV-3/Agent'
    const source = world.chats[key]
    const old = source.messages
    const needle = 'lazy-search-needle'
    source.messages = [...old, { id: 'lazy-search-hit', who: 'agent', text: `A ${needle} reply`, at: Date.now() }]
    try {
      await page.goto(url())
      await page.locator('textarea[name="message"]').first().waitFor()
      await page.keyboard.press('Control+k')
      const search = page.getByRole('combobox', { name: 'Search or jump to' })
      await search.waitFor()
      // past the 120 ms settle and a whole batch window: there is no socket at all until a query arrives
      await page.waitForTimeout(700)
      expect(watches).toEqual([])
      const status = await page.getByRole('status').textContent()
      expect(status).toContain('Recent items')
      expect(status).not.toContain('Loading messages')
      expect(await page.getByRole('listbox', { name: 'Search results' }).getAttribute('aria-busy')).toBe('false')
      // recent items are still useful: snapshot items show, with no Messages group at all
      expect(await page.getByRole('group', { name: 'Spaces', exact: true }).getByRole('option').count()).toBeGreaterThan(0)
      expect(await page.getByRole('group', { name: 'Messages', exact: true }).getByRole('option').count()).toBe(0)

      // a settled query does start the load, and clearing it drops the chats again without another watch
      await search.fill(needle)
      await until(
        () => Promise.resolve(watches.length),
        (n) => n > 0,
        10_000,
      )
      await page
        .getByRole('option', { name: new RegExp(needle) })
        .first()
        .waitFor()
      const before = watches.length
      await search.fill('')
      await page.waitForTimeout(300)
      expect(watches.length).toBe(before)
      expect(await page.getByRole('group', { name: 'Messages', exact: true }).getByRole('option').count()).toBe(0)
      await page.keyboard.press('Escape')
      expect(watches.length).toBe(before)
    } finally {
      source.messages = old
      await page.close()
    }
  }, 90_000)

  test('a long chat shows the capped footer and its newest hit still jumps to the message', async () => {
    const key = 'LV-3/Agent'
    const source = world.chats[key]
    const old = source.messages
    const needle = 'capped-search-needle'
    const messages: Message[] = Array.from({ length: 520 }, (_, n): Message => ({ id: `cap-${n}`, who: 'agent', text: `filler ${n}`, at: n + 1 }))
    messages[2] = { id: 'cap-outside', who: 'agent', text: `old ${needle}`, at: 3 }
    messages[519] = { id: 'cap-inside', who: 'agent', text: `new ${needle}`, at: 520 }
    source.messages = messages
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await page.goto(url())
      await page.locator('textarea[name="message"]').first().waitFor()
      await page.keyboard.press('Control+k')
      await page.getByRole('combobox', { name: 'Search or jump to' }).fill(needle)
      const group = page.getByRole('group', { name: 'Messages', exact: true })
      await group.getByText(/Older messages not searched/).waitFor({ timeout: 45_000 })
      // only the message inside the window is a hit; the older one with the same words is not
      expect(await group.getByRole('option').count()).toBe(1)
      const hit = group.getByRole('option', { name: new RegExp(`new ${needle}`) })
      await hit.click()
      expect(page.url()).toContain('task=LV-3')
      const target = page.locator('[data-msg="cap-inside"]')
      await target.waitFor()
      expect(
        await until(
          () => target.locator('[data-flash]').count(),
          (n) => n > 0,
        ),
      ).toBeGreaterThan(0)
    } finally {
      source.messages = old
      await page.close()
    }
  }, 120_000)
})
