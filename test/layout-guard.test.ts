// Every plugin is guarded, including the built-ins: one whose view throws stops only its own parts and says so in the
// bar. A break outside any plugin leaves a Reload card instead of a blank screen, and one that comes back after a
// reload says reloading is not helping.
import { describe, expect, test } from 'bun:test'
import type { Message } from '../shared/types.ts'
import { layout } from './layout.ts'

const { browser, world, url } = await layout()

describe.skipIf(!browser)('the guard on every plugin', () => {
  test('a built-in view that throws leaves the rest of the screen and names the plugin', async () => {
    // a reaction that is a string has a length, so the bubble tries to draw its pills, but no map: a throw inside the
    // reactions plugin's view, not the app's own render
    world.chats['p:vm-str:~'].messages.push({
      id: 'broken-reactions',
      who: 'agent',
      text: 'This message has a broken reaction',
      at: Date.now(),
      reactions: 'not-an-array',
    } as unknown as Message)
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(url())
    await page.getByText('This message has a broken reaction').waitFor()
    // the rest of the screen is still usable
    expect(await page.getByText('Shepherdr', { exact: true }).first().isVisible()).toBe(true)
    expect(await page.locator('section[aria-label="Tasks"]').isVisible()).toBe(true)
    const bar = page.getByRole('status').filter({ hasText: 'plugin' })
    await bar.waitFor()
    expect(await bar.textContent()).toContain('built-in plugin')
    expect(await bar.textContent()).toContain('reactions')
    await page.close()
  }, 30_000)

  test('a break outside any plugin shows a Reload card; the same one after reloading says so', async () => {
    const good = world.snapshot.bind(world)
    // a malformed snapshot: no places for the app to lay out, so the app itself throws while rendering, outside every
    // plugin's guard
    world.snapshot = () => ({ ...good(), places: undefined }) as never
    try {
      const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
      await page.goto(url())
      const card = page.locator('[data-screen-crash]')
      await card.waitFor()
      expect(await card.getAttribute('role')).toBe('alert')
      // the fallback stands alone, without App's data-device: it names the phone itself so touch sizes still apply
      expect(await card.getAttribute('data-device')).toBe('phone')
      expect(await card.textContent()).toContain('Something on the screen broke')
      expect(await card.locator('details').count()).toBe(1)
      // reload: the same break comes back, and the card still offers a way out
      await card.getByRole('button', { name: 'Reload' }).click()
      const again = page.locator('[data-screen-crash]')
      await again.waitFor()
      expect(await again.textContent()).toContain('Something on the screen broke')
      // twice more and it stops asking for another tap: it says to restart instead
      await again.getByRole('button', { name: 'Reload' }).click()
      const third = page.locator('[data-screen-crash]')
      await third.waitFor()
      expect(await third.textContent()).toContain("Reloading hasn't fixed this after 3 tries")
      expect((await third.locator('details').textContent())?.length).toBeGreaterThan(10)
      await page.close()
    } finally {
      world.snapshot = good
    }
  }, 30_000)
})
