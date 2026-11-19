// The sidebars: their width, hiding and coming back, and the drawer or docking the room chooses, in a real browser
// (layout.ts).
import { describe, expect, test } from 'bun:test'
import { layout, settled } from './layout.ts'

const { browser, url } = await layout()

describe.skipIf(!browser)('sidebars', () => {
  const width = (page: import('playwright-core').Page, sel: string) => page.$eval(sel, (el) => Math.round(el.getBoundingClientRect().width))
  const places = '#places'
  const tasks = 'section[aria-label="Tasks"]'
  /** drags a separator's middle by dx */
  const drag = async (page: import('playwright-core').Page, name: string, dx: number) => {
    const b = (await page.getByRole('separator', { name }).boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 6 })
    await page.mouse.up()
  }
  const settled = (page: import('playwright-core').Page) => page.waitForTimeout(350)

  test('drag an inner edge to resize, double-click to reset; this device remembers (desktop)', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
    await page.goto(url())
    await page.getByRole('separator', { name: 'Resize places' }).waitFor()
    expect(await width(page, places)).toBe(260)
    expect(await width(page, tasks)).toBe(400)
    await drag(page, 'Resize places', 80)
    await drag(page, 'Resize tasks', -100)
    expect(await width(page, places)).toBe(340)
    expect(await width(page, tasks)).toBe(500)
    // no wider than their max, and the chat keeps its room
    await drag(page, 'Resize places', 400)
    expect(await width(page, places)).toBe(400)
    // the arrow keys resize a focused edge
    await page.getByRole('separator', { name: 'Resize tasks' }).focus()
    await page.keyboard.press('ArrowLeft')
    await settled(page)
    expect(await width(page, tasks)).toBe(516)
    await page.reload()
    await page.getByRole('separator', { name: 'Resize places' }).waitFor()
    expect(await width(page, places)).toBe(400)
    expect(await width(page, tasks)).toBe(516)
    await page.getByRole('separator', { name: 'Resize places' }).dblclick()
    await page.getByRole('separator', { name: 'Resize tasks' }).dblclick()
    await settled(page)
    expect(await width(page, places)).toBe(260)
    expect(await width(page, tasks)).toBe(400)
    await page.close()
  }, 30_000)

  test('places hides with its toggle, ⌘B, or dragged narrow, and comes back as wide as it was (desktop)', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
    await page.goto(url())
    const hide = page.getByRole('button', { name: 'Hide Places' })
    const show = page.getByRole('button', { name: 'Show Places' })
    await drag(page, 'Resize places', 60)
    expect(await width(page, places)).toBe(320)
    // the toggle at the top of places; hidden, the chat's header keeps the place's name and the toggle
    await hide.click()
    await settled(page)
    expect(await page.$eval(places, (n) => n.parentElement!.getBoundingClientRect().width)).toBe(0)
    expect(await page.$eval(places, (n) => n.parentElement!.inert)).toBe(true)
    expect(await page.getByRole('separator', { name: 'Resize places' }).count()).toBe(0)
    expect(await page.locator('section').first().getByText('home', { exact: true }).isVisible()).toBe(true)
    expect(await page.locator('section').first().getByText('Home · every machine', { exact: true }).isVisible()).toBe(true)
    expect(await show.getAttribute('aria-expanded')).toBe('false')
    // focus follows the toggle to its other spot
    expect(await show.evaluate((b) => b === document.activeElement)).toBe(true)
    await show.click()
    await settled(page)
    expect(await width(page, places)).toBe(320)
    // ⌘B (Ctrl+B) works while typing too
    await page.getByRole('textbox', { name: /Message/ }).focus()
    await page.keyboard.press('Control+b')
    await settled(page)
    expect(await show.isVisible()).toBe(true)
    await page.keyboard.press('Control+b')
    await settled(page)
    expect(await hide.isVisible()).toBe(true)
    // dragged narrow enough, it snaps shut; it stays shut after a reload
    await drag(page, 'Resize places', -200)
    await settled(page)
    expect(await show.isVisible()).toBe(true)
    await page.reload()
    await show.waitFor()
    expect(await page.$eval(places, (n) => n.parentElement!.getBoundingClientRect().width)).toBe(0)
    // the sidebar's foot holds Settings alone
    expect(await page.getByText('Keyboard', { exact: true }).count()).toBe(0)
    // and Settings' Keyboard shortcuts lists the key: ? opens it there and shuts it again
    await page.keyboard.press('?')
    const settings = page.getByRole('region', { name: 'Settings' })
    expect(await settings.getByRole('button', { name: 'Keyboard shortcuts' }).getAttribute('aria-current')).toBe('page')
    expect(await settings.getByText('Show or hide Places').count()).toBe(1)
    await page.keyboard.press('?')
    expect(await settings.count()).toBe(0)
    await show.click()
    await settled(page)
    expect(await width(page, places)).toBe(320)
    await page.close()
  }, 30_000)

  test('while dragging, the chat beside reflows with every move: nothing overlaps it, nothing jumps on letting go (desktop)', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
    await page.goto(url())
    await page.getByRole('separator', { name: 'Resize places' }).waitFor()
    /** the chat's content (its right edge) against the columns either side of it */
    const edges = () =>
      page.evaluate(() => {
        const chat = document.querySelector('#places')!.parentElement!.nextElementSibling!.firstElementChild!.getBoundingClientRect()
        return {
          chatLeft: Math.round(chat.left),
          chatRight: Math.round(chat.right),
          places: Math.round(document.querySelector('#places')!.parentElement!.getBoundingClientRect().right),
          tasks: Math.round(document.querySelector('section[aria-label="Tasks"]')!.getBoundingClientRect().left),
        }
      })
    for (const [name, dx] of [
      ['Resize tasks', -300],
      ['Resize tasks', 60],
      ['Resize places', 120],
    ] as const) {
      const b = (await page.getByRole('separator', { name }).boundingBox())!
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
      await page.mouse.down()
      await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 6 })
      // a frame later, still held: the chat fills just the room between, as it will after letting go
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      const held = await edges()
      expect(held.chatLeft).toBe(held.places)
      expect(held.chatRight).toBe(held.tasks)
      await page.mouse.up()
      expect(await edges()).toEqual(held)
    }
    await page.close()
  }, 30_000)

  test('available room chooses a drawer at 820/1024/1100 and docking at 1180; resized lists keep chat readable', async () => {
    const page = await browser!.newPage({ viewport: { width: 1024, height: 850 } })
    await page.goto(url())
    await page.getByRole('textbox', { name: 'Message home…' }).waitFor()
    for (const w of [820, 1024, 1100, 1180, 1440]) {
      await page.setViewportSize({ width: w, height: 850 })
      await settled(page)
      const docked = w >= 1180
      expect(await page.getByRole('button', { name: 'Hide Places', exact: true }).count()).toBe(docked ? 1 : 0)
      expect(await page.getByRole('button', { name: 'Places', exact: true }).count()).toBe(docked ? 0 : 1)
      expect(
        await page
          .locator('[data-messages]')
          .first()
          .evaluate((e) => e.getBoundingClientRect().width),
      ).toBeGreaterThanOrEqual(480)
      if (!docked) {
        await page.getByRole('button', { name: 'Places', exact: true }).click()
        // the drawer, over the docked one the screen behind still holds
        await page.getByRole('button', { name: 'Close', exact: true }).waitFor()
        await page.getByRole('button', { name: 'Close', exact: true }).click()
      }
    }
    await drag(page, 'Resize tasks', -300)
    await page.setViewportSize({ width: 1180, height: 850 })
    await settled(page)
    expect(await page.getByRole('button', { name: 'Places', exact: true }).count()).toBe(1)
    expect(
      await page
        .locator('[data-messages]')
        .first()
        .evaluate((e) => e.getBoundingClientRect().width),
    ).toBeGreaterThanOrEqual(480)
    await page.reload()
    await page.getByRole('button', { name: 'Places', exact: true }).waitFor()
    await page.setViewportSize({ width: 1920, height: 850 })
    await page.getByRole('button', { name: 'Hide Places', exact: true }).waitFor()
    expect(await width(page, tasks)).toBe(700)
    // Explicitly hidden places and task tools stay hidden on wider windows.
    await page.getByRole('button', { name: 'Hide Places', exact: true }).click()
    await page.setViewportSize({ width: 2560, height: 850 })
    await page.getByRole('button', { name: 'Show Places', exact: true }).waitFor()
    expect(await page.locator('#task-panel').count()).toBe(0)
    await page.close()
  }, 30_000)

  test('a drawer open while widening does not reopen when the window narrows again', async () => {
    const page = await browser!.newPage({ viewport: { width: 1100, height: 850 } })
    await page.goto(url())
    await page.getByRole('button', { name: 'Places', exact: true }).click()
    await page.getByRole('button', { name: 'Close', exact: true }).waitFor()
    await page.setViewportSize({ width: 1180, height: 850 })
    await page.getByRole('button', { name: 'Hide Places', exact: true }).waitFor()
    await page.setViewportSize({ width: 1100, height: 850 })
    await settled(page)
    expect(await page.getByRole('button', { name: 'Close', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Places', exact: true }).click()
    await page.getByRole('button', { name: 'Close', exact: true }).waitFor()
    await page.close()
  })

  test('a tablet resizes tasks only; a phone keeps its drawer', async () => {
    const tablet = await browser!.newPage({ viewport: { width: 900, height: 800 } })
    await tablet.goto(url())
    await tablet.getByRole('separator', { name: 'Resize tasks' }).waitFor()
    expect(await tablet.getByRole('separator', { name: 'Resize places' }).count()).toBe(0)
    expect(await tablet.getByRole('button', { name: /^(Hide|Show) Places$/ }).count()).toBe(0)
    const before = await width(tablet, tasks)
    await drag(tablet, 'Resize tasks', -40)
    expect(await width(tablet, tasks)).toBe(Math.min(before + 40, 900 - 480))
    await tablet.close()
    const phone = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
    await phone.goto(url())
    await phone.getByRole('button', { name: 'Places' }).waitFor()
    expect(await phone.getByRole('separator').count()).toBe(0)
    expect(await phone.getByRole('button', { name: /^(Hide|Show) Places$/ }).count()).toBe(0)
    await phone.close()
  }, 30_000)
})
