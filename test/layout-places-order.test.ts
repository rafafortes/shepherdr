// The order of the places and taking one away: a mouse drag, Alt+Shift+↑/↓, a finger hold, and the question a remove
// asks first, in a real browser (layout.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { layout, settled, type Box } from './layout.ts'

const { browser, world, server, url } = await layout()

/** adds vm-str's quiet project: nothing waits on you there and nothing is unread, so folding vm-str hides it (what has
 *  something in it stays in sight). Gives back a function that takes it away again */
async function quietProject() {
  await world.addSpace({ machine: 'vm-str', path: '~/dev/quiet', create: true })
  return () => {
    world.places = world.places.filter((p) => p.id !== 'p:vm-str:quiet')
    world.emit('snapshot')
  }
}

describe.skipIf(!browser)('removing a space', () => {
  /** the demo world as it was: removing takes its tasks too */
  const keep = () => {
    const was = { places: world.places, tasks: world.tasks }
    return () => {
      Object.assign(world, was)
      world.emit('snapshot')
    }
  }

  test("a space row's ⋯ removes it from Shepherdr, asked first; its folder stays; open, its home space takes its place; a home space has no Remove (desktop)", async () => {
    const back = keep()
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await page.goto(`http://127.0.0.1:${server.port}/?place=${encodeURIComponent('p:vm-str:gtm')}`)
      const row = page.locator('#places li', { hasText: 'gtm' })
      const more = row.getByRole('button', { name: 'More for gtm' })
      await more.waitFor()
      // tucked away until the pointer is on the row
      expect(await more.evaluate((b) => getComputedStyle(b).opacity)).toBe('0')
      await row.hover()
      expect(await more.evaluate((b) => getComputedStyle(b).opacity)).toBe('1')
      await more.click()
      // beside its row, past the sidebar's edge: it covers none of the rows under it
      const box = (await page.getByRole('menu').boundingBox())!
      const at = (await row.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(at.x + at.width)
      expect(Math.abs(box.y - at.y)).toBeLessThan(8)
      expect(await page.getByRole('menuitem').last().textContent()).toContain('Remove from Shepherdr…')
      await page.getByRole('menuitem', { name: 'Remove from Shepherdr…', exact: true }).click()
      const ask = page.getByRole('alertdialog', { name: 'Remove gtm from Shepherdr?' })
      await ask.waitFor()
      const words = (await ask.textContent())!
      expect(words).toContain('Its files and folder stay on disk.')
      expect(words).toContain('Its 5 open tasks hide with it')
      // Escape keeps it, and the focus goes back to its ⋯
      await page.keyboard.press('Escape')
      await ask.waitFor({ state: 'detached' })
      expect(await more.evaluate((b) => b === document.activeElement)).toBe(true)
      // its ring shows as the keyboard was used last, and goes at the press of a pointer
      const ring = () => more.evaluate((b) => getComputedStyle(b).boxShadow)
      expect(await ring()).not.toBe('none')
      await page.evaluate(() => dispatchEvent(new PointerEvent('pointerdown')))
      expect(await ring()).toBe('none')
      // a right click opens the same menu
      await row.click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Remove from Shepherdr…', exact: true }).click()
      await ask.getByRole('button', { name: 'Remove' }).click()
      await row.waitFor({ state: 'detached' })
      await page.waitForURL(/place=vm-str%2Fhome/)
      // its tasks fade out of the home space's list, then are gone
      await page.locator('section[aria-label="Tasks"]').getByText('GTM-17').waitFor({ state: 'detached', timeout: 2000 })
      // the home space's menu renames it but has no Remove
      const home = page.locator('#places li[data-home]').filter({ hasText: 'home' }).last()
      await home.click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor()
      expect(await page.getByRole('menuitem', { name: 'Remove from Shepherdr…', exact: true }).count()).toBe(0)
      await page.keyboard.press('Escape')
      expect(await world.act({ type: 'space-remove', place: 'p:vm-str:~' })).toEqual({ ok: false, error: "home is vm-str's home space: it can be renamed, not removed." })
    } finally {
      await page.close()
      back()
    }
  }, 30_000)

  test('a space with a task at work is not removed: it says which', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(url())
    const row = page.locator('#places li', { hasText: 'herdr-projects' })
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Remove from Shepherdr…', exact: true }).click()
    const ask = page.getByRole('alertdialog', { name: 'herdr-projects can’t be removed yet' })
    await ask.waitFor()
    expect(await ask.textContent()).toContain('HP-202 is still working. Stop it or let it finish first.')
    expect(await ask.getByRole('button', { name: 'Remove' }).count()).toBe(0)
    await ask.getByRole('button', { name: 'OK' }).click()
    await ask.waitFor({ state: 'detached' })
    expect(await row.count()).toBe(1)
    await page.close()
  }, 30_000)

  test('a phone: holding a space in the drawer opens its menu; the question slides up, whole, dark too', async () => {
    const back = keep()
    const ctx = await browser!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' })
    const page = await ctx.newPage()
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Places' }).first().click()
      const row = page.locator('nav[aria-label="Places"] li', { hasText: 'lilla-varlden' })
      await row.waitFor()
      expect(await row.getByRole('button', { name: 'More for lilla-varlden' }).isVisible()).toBe(false)
      // the drawer has slid in
      await settled(page)
      const box = (await row.boundingBox())!
      const cdp = await ctx.newCDPSession(page)
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
      await page.waitForTimeout(700)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.getByRole('menuitem', { name: 'Remove from Shepherdr…', exact: true }).tap()
      // the hold didn't open the space
      expect(page.url()).not.toContain('lilla-varlden')
      const ask = page.getByRole('alertdialog', { name: 'Remove lilla-varlden from Shepherdr?' })
      await ask.waitFor()
      await settled(page)
      const b = (await ask.boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(390)
      expect(b.y + b.height).toBeLessThanOrEqual(844)
      await ask.getByRole('button', { name: 'Remove' }).tap()
      await row.waitFor({ state: 'detached' })
    } finally {
      await ctx.close()
      back()
    }
  }, 30_000)
})

describe.skipIf(!browser)('the order of places', () => {
  /** the sidebar's places, top to bottom */
  const order = (page: Page, sel = '#places') => page.$$eval(`${sel} li`, (ls) => ls.map((l) => (l as HTMLElement).innerText.split('\n')[0]))
  const forget = () => {
    world.order = {}
    world.emit('snapshot')
  }
  /** drags a row's middle by dy with the mouse */
  const drag = async (page: Page, name: string, dy: number) => {
    const b = (await page.locator('#places li', { hasText: name }).first().boundingBox())!
    await page.mouse.move(b.x + 40, b.y + b.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + 40, b.y + b.height / 2 + dy, { steps: 8 })
    await page.mouse.up()
  }

  test('A to Z at first, each home space first until dragged; a mouse drags a machine with its spaces, or a space among its own; every device sees it (desktop)', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
    try {
      await page.goto(url())
      await page.waitForSelector('#places li')
      expect(await order(page)).toEqual(['mac', 'home', 'lilla-varlden', 'nas', 'home', 'vm-str', 'home', 'gtm', 'herdr-projects'])
      // vm-str up above mac: its spaces come along, and the press it ends with opens nothing
      await drag(page, 'vm-str', -250)
      expect(await order(page)).toEqual(['vm-str', 'home', 'gtm', 'herdr-projects', 'mac', 'home', 'lilla-varlden', 'nas', 'home'])
      expect(page.url()).toContain('place=vm-str%2Fhome')
      expect(world.order).toEqual({ all: ['m:vm-str', 'm:mac', 'm:nas'] })
      // herdr-projects up past gtm and the home space, as any space (SHE-225); it can't leave its machine
      await drag(page, 'herdr-projects', -200)
      expect(await order(page)).toEqual(['vm-str', 'herdr-projects', 'home', 'gtm', 'mac', 'home', 'lilla-varlden', 'nas', 'home'])
      expect(world.order['m:vm-str']).toEqual(['p:vm-str:herdr-projects', 'p:vm-str:~', 'p:vm-str:gtm'])
      // the keyboard: Alt+Shift+↓ on a focused space moves it one down
      await page.locator('#places li', { hasText: 'herdr-projects' }).getByRole('button', { name: /^herdr-projects/ }).focus()
      await page.keyboard.press('Alt+Shift+ArrowDown')
      await page.waitForFunction(() => [...document.querySelectorAll('#places li')][2]?.textContent?.includes('herdr-projects'))
      expect(await order(page)).toEqual(['vm-str', 'home', 'herdr-projects', 'gtm', 'mac', 'home', 'lilla-varlden', 'nas', 'home'])
      // and the home space moves the same way
      await page.locator('#places li[data-home][data-machine="m:vm-str"]').getByRole('button', { name: /^home/ }).focus()
      await page.keyboard.press('Alt+Shift+ArrowDown')
      await page.waitForFunction(() => [...document.querySelectorAll('#places li')][2]?.hasAttribute('data-home'))
      expect(await order(page)).toEqual(['vm-str', 'herdr-projects', 'home', 'gtm', 'mac', 'home', 'lilla-varlden', 'nas', 'home'])
      // another device has it too
      const other = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
      await other.goto(url())
      await other.waitForSelector('#places li')
      expect(await order(other)).toEqual(['vm-str', 'herdr-projects', 'home', 'gtm', 'mac', 'home', 'lilla-varlden', 'nas', 'home'])
      await other.close()
      // a new space slots in A to Z among the rest: after the last one before it A to Z
      await world.addSpace({ machine: 'vm-str', path: '~/dev/apps/hop', create: true })
      await page.locator('#places li', { hasText: 'hop' }).waitFor()
      expect(await order(page)).toEqual(['vm-str', 'herdr-projects', 'home', 'gtm', 'hop', 'mac', 'home', 'lilla-varlden', 'nas', 'home'])
    } finally {
      await page.close()
      world.places = world.places.filter((p) => !['hop'].includes(p.name))
      forget()
    }
  }, 30_000)

  test('Alt+Shift+↑/↓ moves a focused machine or section heading, its spaces along, as a drag does; only while its group has more than one (desktop)', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
    const headings = (p: Page = page) => p.$$eval('#places li[data-heading]', (ls) => ls.map((l) => l.getAttribute('data-heading')))
    const keys = (id: string) => page.locator(`#places li[data-heading="${id}"]`).getAttribute('aria-keyshortcuts')
    const folder = (id: string) => page.locator(`#places li[data-heading="${id}"] h2 button`)
    try {
      await page.goto(url())
      await page.waitForSelector('#places li')
      expect(await headings()).toEqual(['m:mac', 'm:nas', 'm:vm-str'])
      // a machine folded, then moved down with the keys: its spaces go with it, folded as they were
      await page.locator('#places li[data-heading="m:nas"]').getByRole('button', { name: 'nas', exact: true }).click()
      expect(await order(page)).toEqual(['mac', 'home', 'lilla-varlden', 'nas', 'vm-str', 'home', 'gtm', 'herdr-projects'])
      expect(await keys('m:nas')).toBe('Alt+Shift+ArrowUp Alt+Shift+ArrowDown')
      await folder('m:nas').focus()
      await page.keyboard.press('Alt+Shift+ArrowDown')
      await page.waitForFunction(() => [...document.querySelectorAll('#places li[data-heading]')].map((l) => l.getAttribute('data-heading')).join() === 'm:mac,m:vm-str,m:nas')
      expect(world.order.all).toEqual(['m:mac', 'm:vm-str', 'm:nas'])
      expect(await order(page)).toEqual(['mac', 'home', 'lilla-varlden', 'vm-str', 'home', 'gtm', 'herdr-projects', 'nas'])
      expect(await page.locator('#places li[data-heading="m:nas"] button[aria-expanded]').first().getAttribute('aria-expanded')).toBe('false')
      // the bottom stays the bottom
      await page.keyboard.press('Alt+Shift+ArrowDown')
      await page.waitForTimeout(200)
      expect(await headings()).toEqual(['m:mac', 'm:vm-str', 'm:nas'])

      // sections: two at the top beside a Pinned that holds nothing, two in a machine, and one alone in another
      world.groups = { 's:cli': { name: 'Clients' }, 's:lab': { name: 'Labs' }, 's:ops': { name: 'Ops', machine: 'vm-str' }, 's:qa': { name: 'QA', machine: 'vm-str' }, 's:solo': { name: 'Solo', machine: 'mac' } }
      world.order = { ...world.order, sections: ['pinned', 's:cli', 's:lab'], 'sections:m:vm-str': ['s:ops', 's:qa'] }
      world.emit('snapshot')
      await page.locator('#places li[data-heading="s:qa"]').waitFor()
      expect(await headings()).toEqual(['s:cli', 's:lab', 'm:mac', 's:solo', 'm:vm-str', 's:ops', 's:qa', 'm:nas'])
      // a section at the top moves among them, its spaces along, and Pinned keeps its place out of sight
      expect(await keys('s:cli')).toBe('Alt+Shift+ArrowUp Alt+Shift+ArrowDown')
      await folder('s:cli').focus()
      await page.keyboard.press('Alt+Shift+ArrowDown')
      await page.waitForFunction(() => [...document.querySelectorAll('#places li[data-heading]')].slice(0, 2).map((l) => l.getAttribute('data-heading')).join() === 's:lab,s:cli')
      expect(world.order.sections).toEqual(['pinned', 's:lab', 's:cli'])
      // and one in a machine, among the sections there
      expect(await keys('s:ops')).toBe('Alt+Shift+ArrowUp Alt+Shift+ArrowDown')
      await folder('s:ops').focus()
      await page.keyboard.press('Alt+Shift+ArrowDown')
      await page.waitForFunction(() => [...document.querySelectorAll('#places li[data-heading^="s:"][data-machine="m:vm-str"]')].map((l) => l.getAttribute('data-heading')).join() === 's:qa,s:ops')
      expect(world.order['sections:m:vm-str']).toEqual(['s:qa', 's:ops'])
      // alone among its siblings it says no key, and the keys move nothing
      expect(await keys('s:solo')).toBeNull()
      await folder('s:solo').focus()
      await page.keyboard.press('Alt+Shift+ArrowDown')
      await page.waitForTimeout(200)
      expect(world.order['sections:m:mac']).toBeUndefined()
      // another device has the order the keys left
      const other = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
      await other.goto(url())
      await other.waitForSelector('#places li[data-heading="s:qa"]')
      expect(await headings(other)).toEqual(['s:lab', 's:cli', 'm:mac', 's:solo', 'm:vm-str', 's:qa', 's:ops', 'm:nas'])
      await other.close()
    } finally {
      await page.close()
      world.groups = {}
      forget()
    }
  }, 30_000)

  test('a finger holds a space (its menu opens), slides it (the menu goes), and lets go: it lands there (phone)', async () => {
    const ctx = await browser!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const page = await ctx.newPage()
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Places' }).first().click()
      const nav = 'nav[aria-label="Places"]'
      const row = page.locator(`${nav} li`, { hasText: 'herdr-projects' })
      await row.waitFor()
      await settled(page)
      const box = (await row.boundingBox())!
      const cdp = await ctx.newCDPSession(page)
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      await page.waitForTimeout(600)
      await page.getByRole('menuitem', { name: 'Remove from Shepherdr…', exact: true }).waitFor()
      for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 8 }] })
      expect(await page.getByRole('menuitem', { name: 'Remove from Shepherdr…', exact: true }).count()).toBe(0)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await settled(page)
      expect(await order(page, nav)).toEqual(['mac', 'home', 'lilla-varlden', 'nas', 'home', 'vm-str', 'home', 'herdr-projects', 'gtm'])
      // it opened nothing, and the list didn't scroll away
      expect(page.url()).not.toContain('herdr-projects')
      expect(world.order).toEqual({ 'm:vm-str': ['p:vm-str:~', 'p:vm-str:herdr-projects', 'p:vm-str:gtm'] })
      // a finger that moves at once scrolls, and moves nothing
      const g = (await page.locator(`${nav} li`, { hasText: 'gtm' }).boundingBox())!
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: g.y + g.height / 2 }] })
      for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: g.y + g.height / 2 - i * 10 }] })
      await page.waitForTimeout(600)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await settled(page)
      expect(await order(page, nav)).toEqual(['mac', 'home', 'lilla-varlden', 'nas', 'home', 'vm-str', 'home', 'herdr-projects', 'gtm'])
      expect(await page.getByRole('menuitem').count()).toBe(0)
    } finally {
      await ctx.close()
      forget()
    }
  }, 30_000)

  test('Alt+↑/↓ goes to the space above or below as it shows, headings and folded ones skipped, typing in its box (desktop)', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
    const box = page.locator('[data-composer] textarea')
    const at = () => new URL(page.url()).searchParams.get('place')
    const unquiet = await quietProject()
    try {
      await page.goto(url())
      await page.waitForSelector('#places li')
      expect(await order(page)).toEqual(['mac', 'home', 'lilla-varlden', 'nas', 'home', 'vm-str', 'home', 'gtm', 'herdr-projects', 'quiet'])
      // from the message box, typing: vm-str's home is the last-but-three; up goes past the vm-str heading to nas's home
      await box.focus()
      await page.keyboard.press('Alt+ArrowUp')
      await page.waitForFunction(() => new URL(location.href).searchParams.get('place') === 'nas/home')
      await page.keyboard.press('Alt+ArrowUp')
      await page.waitForFunction(() => new URL(location.href).searchParams.get('place') === 'mac/lilla-varlden')
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA')
      await page.keyboard.type('hi')
      expect(await box.inputValue()).toBe('hi')
      await page.keyboard.press('Alt+ArrowUp')
      await page.waitForFunction(() => new URL(location.href).searchParams.get('place') === 'mac/home')
      // the top stays the top
      await page.keyboard.press('Alt+ArrowUp')
      await page.waitForTimeout(200)
      expect(at()).toBe('mac/home')
      // vm-str folded: every space in it is skipped, those waiting on you too; nas's home is the last
      await page.getByRole('button', { name: "Hide vm-str's spaces" }).click()
      await page.locator('#places li[data-home]').nth(1).getByRole('button', { name: /^home/ }).click()
      await page.waitForFunction(() => new URL(location.href).searchParams.get('place') === 'nas/home')
      await page.keyboard.press('Alt+ArrowDown')
      await page.waitForTimeout(200)
      expect(at()).toBe('nas/home')
      await page.keyboard.press('Alt+ArrowUp')
      await page.waitForFunction(() => new URL(location.href).searchParams.get('place') === 'mac/lilla-varlden')
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA')
      await page.getByRole('button', { name: "Show vm-str's spaces" }).click()
    } finally {
      unquiet()
      await page.close()
    }
  }, 30_000)
})
