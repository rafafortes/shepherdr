// A message another agent sent is a row of its own: on the left, naming the sender it declared, in a shade apart from
// both the human's bubbles and this agent's. The sender is only what that side wrote, so nothing vouches for it.
import { describe, expect, test } from 'bun:test'
import type { Message } from '../shared/types.ts'
import { layout } from './layout.ts'

const { browser, world, url } = await layout()

const said: Message = {
  id: 'from-she-17',
  who: 'peer',
  text: 'Relayed from the operator: merge it once the checks pass, then tell me in one line.',
  peer: { name: 'SHE-17 agent', pane: 'w7R:p2', space: 'shepherdr', task: 'SHE-17' },
  at: Date.now() + 1,
}

describe.skipIf(!browser)('a message from another agent', () => {
  test('phone width: left, its sender and pane above it, a shade of its own; the human’s and the agent’s bubbles unchanged', async () => {
    const chat = world.chats['p:vm-str:~']
    const before = chat.messages
    chat.messages = [...before, said]
    try {
      const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
      try {
        await page.goto(url())
        const whole = page.locator('[data-whole="from-she-17"]')
        const bubble = page.locator('[data-msg="from-she-17"]')
        await whole.waitFor()
        // not the human's: nothing marks it yours
        expect(await bubble.getAttribute('data-you')).toBeNull()
        expect(await page.locator('[data-you][data-whole="from-she-17"]').count()).toBe(0)
        // it says who sent it, and where that runs, before the words
        const head = whole.locator('[data-peer]')
        expect(await head.textContent()).toContain('SHE-17 agent')
        expect(await head.locator('[data-peer-where]').textContent()).toBe('SHE-17 · pane w7R:p2')
        expect(await head.locator('svg').count()).toBe(1)
        expect(await bubble.locator('[data-text]').textContent()).toBe(said.text!)
        // the header sits above the bubble, both on the left of the screen; the human's own stay right
        const top = (await head.boundingBox())!
        const box = (await bubble.locator('[data-anchor]').boundingBox())!
        expect(top.y + top.height).toBeLessThanOrEqual(box.y + 1)
        expect(box.x).toBeLessThan(390 / 2)
        const mine = (await page.locator('[data-you] [data-anchor]').first().boundingBox())!
        expect(mine.x).toBeGreaterThan(390 / 2)
        // its own shade: neither the human's reply shade nor the agent's bubble shade
        const bg = (sel: string) => page.locator(sel).first().evaluate((b) => getComputedStyle(b).backgroundColor)
        const shades = await page.evaluate(() => {
          const css = getComputedStyle(document.documentElement)
          return { reply: css.getPropertyValue('--reply').trim(), bubble: css.getPropertyValue('--bubble').trim(), peer: css.getPropertyValue('--peer').trim() }
        })
        expect(Object.values(shades).every(Boolean)).toBe(true)
        expect(new Set(Object.values(shades)).size).toBe(3)
        expect(await bubble.locator('[data-anchor]').evaluate((b) => getComputedStyle(b).backgroundColor)).toBe(await bg('.bg-peer'))
        expect(await bg('.bg-bubble')).not.toBe(await bg('.bg-peer'))
        expect(await bg('.bg-reply')).not.toBe(await bg('.bg-peer'))
        // and the words wrap inside the screen rather than pushing it wide
        expect(await bubble.locator('[data-text]').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      } finally {
        await page.close()
      }
    } finally {
      chat.messages = before
    }
  }, 30_000)
})
