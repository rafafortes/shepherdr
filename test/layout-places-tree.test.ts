// The places tree, calm like Slack: the ⋯ menu they share, one machine or many, and what folding a machine hides, in
// a real browser (layout.ts).
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

describe.skipIf(!browser)('the ⋯ menu is one design', () => {
  for (const [name, viewport] of [
    ['phone', { width: 390, height: 844 }],
    ['desktop', { width: 1600, height: 900 }],
  ] as const)
    test(`rows share one height, one icon slot and one hint column; no ring after a click (${name})`, async () => {
      const page = await browser!.newPage({ viewport, hasTouch: name === 'phone' })
      await page.goto(url())
      const button = page.getByRole('button', { name: 'Menu', exact: true })
      await button.click()
      await page.getByRole('menu').waitFor()
      await settled(page)
      // a click shows no focus ring: that is for the keyboard; the button is round, so its ring would be too
      expect(await button.evaluate((b) => b.matches(':focus-visible'))).toBe(false)
      expect(await button.evaluate((b) => parseFloat(getComputedStyle(b).borderRadius) >= b.getBoundingClientRect().width / 2)).toBe(true)
      const rows = await page.$$eval('[role=menu] [role^=menuitem]', (rs) =>
        rs.map((r) => {
          const [slot, text, hint] = [...r.children].map((c) => c.getBoundingClientRect())
          return { h: r.getBoundingClientRect().height, slot: slot.left, text: text.left, hint: hint?.right, lines: text.height }
        }),
      )
      expect(rows.length).toBeGreaterThanOrEqual(2)
      for (const r of rows) {
        expect(r.h).toBe(rows[0].h)
        expect(r.slot).toBe(rows[0].slot)
        expect(r.text).toBe(rows[0].text)
        // every row is one line
        expect(r.lines).toBeLessThan(r.h)
      }
      const hints = rows.map((r) => r.hint).filter((x) => x !== undefined)
      expect(new Set(hints).size).toBeLessThanOrEqual(1)
      // the menu's corner is the shared popover corner
      expect(await page.getByRole('menu').evaluate((m) => getComputedStyle(m).borderRadius)).toBe('14px')
      await page.close()
    }, 30_000)

  for (const [name, viewport] of [
    ['phone', { width: 390, height: 844 }],
    ['desktop', { width: 1600, height: 900 }],
  ] as const)
    test(`a click or tap outside, Escape or a pick closes it, and the click outside presses nothing under it (${name})`, async () => {
      const page = await browser!.newPage({ viewport, hasTouch: name === 'phone' })
      await page.goto(url())
      const plus = page.getByRole('button', { name: 'Attach files and more' })
      const more = page.getByRole('button', { name: 'Menu', exact: true })
      const menus = page.getByRole('menu')
      const gone = () => menus.waitFor({ state: 'detached' })
      // a tap or click on the chat just below the ⋯ menu, which grew a row with pause (and is taller on a phone):
      // a fixed centre of the screen would now land on a menu item and pick it instead of closing the menu
      const outside = async () => {
        const box = await menus.boundingBox()
        if (!box) throw new Error('no menu to click outside of')
        const y = Math.min(viewport.height - 90, box.y + box.height + 30)
        if (name === 'phone') await page.touchscreen.tap(viewport.width / 2, y)
        else await page.mouse.click(viewport.width / 2, y)
      }
      await plus.click()
      await menus.waitFor()
      await outside()
      await gone()
      await plus.click()
      await menus.waitFor()
      await page.keyboard.press('Escape')
      await gone()
      // File or photo closes it as the device's picker opens
      await plus.click()
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('menuitem', { name: 'File or photo' }).click()
      await chooser
      await gone()
      // its own button closes it rather than opening it again
      await plus.click()
      await menus.waitFor()
      await plus.click()
      await gone()
      // the ⋯ the same way, and the click that closes it doesn't open the + under it
      await more.click()
      await menus.waitFor()
      await outside()
      await gone()
      await more.click()
      await menus.waitFor()
      await plus.click()
      await gone()
      await settled(page)
      expect(await menus.count()).toBe(0)
      await page.close()
    }, 30_000)

  test('the keyboard opens it, moves through it with the arrows, and Escape gives the focus back (desktop)', async () => {
    const page = await browser!.newPage({ viewport: { width: 1600, height: 900 } })
    await page.goto(url())
    const button = page.getByRole('button', { name: 'Menu', exact: true })
    await button.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menu').waitFor()
    const focused = () => page.evaluate(() => document.activeElement?.firstElementChild?.nextElementSibling?.textContent)
    // the Autopilot switch first, a row like the others
    expect(await focused()).toBe('Autopilot')
    await page.keyboard.press('ArrowDown')
    expect(await focused()).toBe('Pause space')
    await page.keyboard.press('ArrowDown')
    expect(await focused()).toBe('Search in this chat')
    await page.keyboard.press('ArrowDown')
    expect(await focused()).toBe('Search this chat and beyond')
    await page.keyboard.press('ArrowDown')
    expect(await focused()).toBe('Restart agent…')
    await page.keyboard.press('ArrowDown')
    expect(await focused()).toBe('Terminal')
    await page.keyboard.press('ArrowDown')
    expect(await focused()).toBe('Artifacts')
    await page.keyboard.press('ArrowDown')
    expect(await focused()).toBe('Autopilot')
    await page.keyboard.press('End')
    expect(await focused()).toBe('Artifacts')
    // the focused row shows the ring inside its own corners
    expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineOffset)).toBe('-2px')
    await page.keyboard.press('Escape')
    expect(await page.getByRole('menu').count()).toBe(0)
    expect(await button.evaluate((b) => b === document.activeElement && b.matches(':focus-visible'))).toBe(true)
    // the screen behind it stays: Escape only closed the menu
    expect(new URL(page.url()).searchParams.get('place')).toBe('vm-str/home')
    await page.close()
  }, 30_000)
})

describe.skipIf(!browser)('places, calm like Slack', () => {
  /** each place row: its name (in the button going there), the counts on its right (needs you, ready), whether its
   *  name is bold, any status mark left in it, and whether it says news came in */
  const rows = (page: import('playwright-core').Page, sel: string) =>
    page.$$eval(`${sel} li`, (ls) =>
      ls.map((l) => {
        const name = l.querySelector('button > span')!
        const badge = l.querySelector('[data-attention-badge]')
        const said = l.querySelector('button')?.getAttribute('aria-label') ?? ''
        return {
          name: name.textContent,
          count: Number(l.querySelector('.attention-badge-need')?.textContent ?? 0) + Number(l.querySelector('.attention-badge-ready')?.textContent ?? 0),
          said: badge?.getAttribute('aria-label') ?? '',
          unread: /, unread(?:,|$)/.test(said),
          bold: Number(getComputedStyle(name).fontWeight) >= 600,
          dots: l.querySelectorAll('.dot').length,
          text: l.textContent,
        }
      }),
    )
  const check = (rs: Awaited<ReturnType<typeof rows>>) => {
    // no status marks; only rows with something waiting on you (or news in their chat) have a count or a bold name
    expect(rs.every((r) => r.dots === 0)).toBe(true)
    expect(rs.every((r) => r.bold === (r.count > 0 || r.unread))).toBe(true)
    // each row counts its own coordinator's chat alone: nothing rolls up from the rows shown under it
    for (const m of ['vm-str', 'mac']) expect(rs.find((r) => r.name === m)!.count).toBe(0)
    expect(rs.some((r) => r.count > 0)).toBe(true)
    // a machine Shepherdr can't reach says so quietly
    expect(rs.find((r) => r.name === 'nas')!.text).toBe("nasCan't reach")
  }

  test('desktop and the phone drawer: no marks, a count only where something waits on you', async () => {
    const desk = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
    await desk.goto(url())
    await desk.waitForSelector('#places li')
    check(await rows(desk, '#places'))
    await desk.close()
    const phone = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
    await phone.goto(url())
    await phone.getByRole('button', { name: 'Spaces', exact: true }).first().click()
    await phone.waitForSelector('nav[aria-label="Spaces"] li')
    check(await rows(phone, 'nav[aria-label="Spaces"]'))
    await phone.close()
  }, 30_000)

  for (const [name, opts] of [
    ['desktop, light', { viewport: { width: 1440, height: 800 }, colorScheme: 'light' }],
    ['phone, dark', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' }],
  ] as const)
    test(`each place has its icon before its name, grey, lit with the name where it is open or bold; search and Settings' picker show it too (${name})`, async () => {
      const ctx = await browser!.newContext(opts)
      const page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('m:vm-str')}`)
      const phone = opts.viewport.width < 600
      const side = phone ? 'nav[aria-label="Spaces"]' : '#places'
      if (phone) await page.getByRole('button', { name: 'Spaces', exact: true }).first().click()
      await page.waitForSelector(`${side} li`)
      const rs = await page.$$eval(`${side} li`, (ls) =>
        ls.map((l) => {
          const name = l.querySelector('button > span')!
          const icon = l.querySelector('[data-icon]')!
          const [i, n] = [icon.getBoundingClientRect(), name.getBoundingClientRect()]
          return {
            name: name.textContent,
            icon: icon.getAttribute('data-icon'),
            size: i.width,
            gap: n.left - i.right,
            color: getComputedStyle(icon).color,
            nameColor: getComputedStyle(name).color,
            bold: Number(getComputedStyle(name).fontWeight) >= 600,
            sel: l.classList.contains('bg-sel'),
          }
        }),
      )
      // each machine's server on its heading (no emoji given), each space's # (its home space first); no level over them
      expect(rs.map((r) => [r.name, r.icon])).toEqual([
        ['mac', 'server'],
        ['home', 'hash'],
        ['lilla-varlden', 'hash'],
        ['nas', 'server'],
        ['home', 'hash'],
        ['vm-str', 'server'],
        ['home', 'hash'],
        ['gtm', 'hash'],
        ['herdr-projects', 'hash'],
      ])
      const fg2 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fg2').trim())
      const rgb = await page.evaluate((c) => {
        const el = document.createElement('i')
        el.style.color = c
        document.body.append(el)
        const v = getComputedStyle(el).color
        el.remove()
        return v
      }, fg2)
      for (const [i, r] of rs.entries()) {
        expect(r.size).toBeWithin(15, 16.5)
        expect(r.gap).toBeWithin(4, 9)
        // a space's: lit with the name on the open row and the bold ones; grey on the rest (nas's home can't be
        // reached: greyer still); a heading's stays quiet
        if (r.icon !== 'hash') continue
        if (r.sel || r.bold) expect(r.color).toBe(r.nameColor)
        else if (i !== 4) expect(r.color).toBe(rgb)
      }
      // a link to the machine from before spaces opens its home space
      expect(rs.findIndex((r) => r.sel)).toBe(6)
      expect(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).resolves.toBe(true)
      if (!phone) {
        // the header's title has its icon too
        expect(await page.locator('main [data-icon], [data-chrome] [data-icon]').first().getAttribute('data-icon')).toBe('hash')
        // ⌘K: a place's icon where a task has its dot
        await page.keyboard.press('Control+k')
        const list = page.getByRole('listbox', { name: 'Search results' })
        await list.waitFor()
        const first = list.getByRole('option').first().locator('[data-icon]')
        expect(await first.getAttribute('data-icon')).toBe('hash')
        // lit on the row the arrow keys are on, as the sidebar's open row
        expect(await first.evaluate((e) => getComputedStyle(e).color)).toBe(
          await list
            .getByRole('option')
            .first()
            .evaluate((e) => getComputedStyle(e).color),
        )
        expect(await list.getByRole('option', { name: /^gtm/ }).locator('[data-icon]').getAttribute('data-icon')).toBe('hash')
        await page.keyboard.press('Escape')
      }
      // Settings' place picker: its value and each choice with its place's icon
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:gtm')}`)
      if (phone) await page.getByRole('button', { name: 'Spaces', exact: true }).first().click()
      await page.getByRole('navigation', { name: 'Spaces' }).getByRole('button', { name: 'Settings', exact: true }).click()
      const pick = page.getByRole('button', { name: /^Editing: / }).first()
      await pick.waitFor()
      expect(await pick.locator('[data-icon]').getAttribute('data-icon')).toBe('hash')
      await pick.click()
      const menu = page.getByRole('menu', { name: 'Choices' })
      expect(await menu.getByRole('menuitemradio').evaluateAll((ms) => ms.slice(0, 6).map((m) => m.querySelector('[data-icon]')?.getAttribute('data-icon')))).toEqual([
        'layers',
        'server',
        'hash',
        'hash',
        'server',
        'hash',
      ])
      await ctx.close()
    }, 30_000)
})

describe.skipIf(!browser)('the places tree', () => {
  let unquiet = () => {}
  beforeAll(async () => {
    unquiet = await quietProject()
  })
  afterAll(() => unquiet())
  const box = (page: Page, sel: string) =>
    page
      .locator(sel)
      .first()
      .evaluate((n) => n.getBoundingClientRect().toJSON() as Box)
  const row = (page: Page, name: string) => page.locator('#places li', { has: page.getByText(name, { exact: true }) }).first()

  test('each machine heading its own + on hover, opening New space on it; a chevron or a tap folds its spaces, remembered; it opens nothing (desktop)', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
    await page.goto(url())
    await page.waitForSelector('#places li')
    // the + waits for the mouse; the offline machine has none
    const plus = page.getByRole('button', { name: 'New space on mac' })
    const shows = () => plus.evaluate((b) => getComputedStyle(b).opacity === '1' && getComputedStyle(b).position !== 'absolute')
    expect(await shows()).toBe(false)
    await row(page, 'mac').hover()
    expect(await shows()).toBe(true)
    expect(await page.getByRole('button', { name: 'New space on nas' }).count()).toBe(0)
    await plus.click()
    const dialog = page.getByRole('dialog', { name: 'New space' })
    await dialog.getByRole('button', { name: 'Machine: mac' }).waitFor()
    await dialog.getByRole('button', { name: 'Close' }).click()
    // a heading is no place: a tap on its name folds it as its chevron does, and the screen stays where it was
    const at = () => new URL(page.url()).searchParams.get('place')
    await row(page, 'mac').getByRole('button', { name: 'mac', exact: true }).click()
    await page.getByRole('button', { name: "Show mac's spaces" }).waitFor()
    expect(at()).toBe('vm-str/home')
    expect(await row(page, 'mac').getAttribute('aria-current')).toBeNull()
    expect(await row(page, 'mac').locator('[aria-current]').count()).toBe(0)
    expect(await page.locator('#places li[data-heading="m:mac"] [data-autopilot], #places li[data-heading="m:mac"] [aria-label$="need you here"]').count()).toBe(0)
    await row(page, 'mac').getByRole('button', { name: 'mac', exact: true }).click()
    await page.getByRole('button', { name: "Hide mac's spaces" }).waitFor()
    expect(at()).toBe('vm-str/home')
    // its ⋯ has New space, New section and Rename machine, nothing of a chat (no Notify, no Mark as read, no Pin)
    await row(page, 'mac').hover()
    await page.getByRole('button', { name: 'More for mac' }).click()
    const menu = page.getByRole('menu', { name: 'mac' })
    expect((await menu.getByRole('menuitem').allTextContents()).map((t) => t.trim())).toEqual(['New space…', 'New section…', 'Rename machine…'])
    await page.keyboard.press('Escape')
    // folded, every vm-str space goes, those waiting on you and the open home too; its heading has a red dot for them,
    // no count (it makes room for the + and ⋯ while the pointer is on it, as a count does)
    await page.getByRole('button', { name: "Hide vm-str's spaces" }).click()
    await page.mouse.move(900, 400)
    await page.locator('#places li', { hasText: 'quiet' }).waitFor({ state: 'detached' })
    expect(await page.locator('#places li[data-project][data-machine="m:vm-str"]').count()).toBe(0)
    expect(await page.locator('#places li[aria-current], #places li:has([aria-current])').count()).toBe(0)
    expect(await row(page, 'vm-str').locator('span[aria-label$="need you here"]').count()).toBe(0)
    expect(await row(page, 'vm-str').getByRole('img', { name: 'Something in it waits on you' }).count()).toBe(1)
    expect(at()).toBe('vm-str/home')
    // the screen remembers it, and the chevron brings them back
    await page.reload()
    await page.getByRole('button', { name: "Show vm-str's spaces" }).waitFor()
    expect(await page.locator('#places li', { hasText: 'quiet' }).count()).toBe(0)
    await page.getByRole('button', { name: "Show vm-str's spaces" }).click()
    await page.locator('#places li', { hasText: 'quiet' }).waitFor()
    // the keyboard reaches the +: Tab from the chevron to the name, then on to it
    await page.mouse.move(900, 400)
    await row(page, 'mac').locator('button').first().focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('New space on mac')
    expect(await shows()).toBe(true)
    await page.close()
  }, 30_000)

  test('folded, a machine hides every space in it, the open one too; going to one of them from elsewhere opens it (desktop)', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
    const names = () => page.$$eval('#places li', (ls) => ls.map((l) => (l as HTMLElement).innerText.split('\n')[0]))
    const at = () => new URL(page.url()).searchParams.get('place')
    await page.goto(url().replace('place=vm-str/home', 'place=p%3Avm-str%3Aquiet'))
    await page.getByRole('button', { name: "Hide vm-str's spaces" }).click()
    await page.getByRole('button', { name: "Show vm-str's spaces" }).waitFor()
    await page.mouse.move(900, 400)
    // quiet stays open, out of sight; gtm and herdr-projects wait on you, so the heading has a red dot, not a count
    expect(await names()).toEqual(['mac', 'home', 'lilla-varlden', 'nas', 'home', 'vm-str'])
    expect(at()).toBe('vm-str/quiet')
    expect(await row(page, 'vm-str').locator('span[aria-label$="need you here"]').count()).toBe(0)
    expect(await row(page, 'vm-str').getByRole('img', { name: 'Something in it waits on you' }).count()).toBe(1)
    // remembered; Alt+↑ from the hidden one goes to the space shown above where it sits, and leaves the fold as it is
    await page.reload()
    await page.getByRole('button', { name: "Show vm-str's spaces" }).waitFor()
    await page.locator('[data-composer] textarea').focus()
    await page.keyboard.press('Alt+ArrowUp')
    await page.waitForFunction(() => new URL(location.href).searchParams.get('place') === 'nas/home')
    expect(await names()).toEqual(['mac', 'home', 'lilla-varlden', 'nas', 'home', 'vm-str'])
    // gone to from elsewhere (search), its machine opens
    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: 'Search or jump to' })
    await dialog.getByRole('option', { name: /^gtm/ }).first().click()
    await page.locator('#places li', { hasText: 'quiet' }).waitFor()
    expect(await row(page, 'vm-str').getByRole('img').count()).toBe(0)
    await page.close()
  }, 30_000)

  test("machines are sections side by side, as Pinned is: no level over them, their small chevrons at the left edge, their spaces' # under their names, as Slack's (desktop)", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
    await page.goto(url())
    await page.waitForSelector('#places li')
    expect(await page.locator('#places li[data-heading]').evaluateAll((ls) => ls.map((l) => l.getAttribute('data-heading')))).toEqual(['m:mac', 'm:nas', 'm:vm-str'])
    const chevrons = await page.locator('#places li[data-heading] > button[aria-label^="Hide"]').evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().left)))
    expect(new Set(chevrons).size).toBe(1)
    const left = (name: string) => page.$eval(`#places li:has-text("${name}") button > span`, (l) => l.getBoundingClientRect().left)
    expect(await left('vm-str')).toBeLessThan(await left('gtm'))
    // a space's # under its machine's name, as a Slack channel's sits under its section's (SHE-225); the chevron near
    // the edge
    const icon = (sel: string) =>
      page
        .locator(sel)
        .locator('[data-icon]')
        .first()
        .evaluate((i) => Math.round(i.getBoundingClientRect().left))
    const name = await page.locator('#places li[data-heading="m:vm-str"] h2 span').evaluate((n) => Math.round(n.getBoundingClientRect().left))
    expect(Math.abs((await icon('#places li[data-project="p:vm-str:gtm"]')) - name)).toBeLessThanOrEqual(1)
    const side = await page.locator('#places').evaluate((n) => n.getBoundingClientRect().left)
    expect(chevrons[0] - side).toBeLessThanOrEqual(14)
    await page.close()
  }, 30_000)

  test('a narrow sidebar cuts names short; the + and counts stay inside', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
    await page.addInitScript(() => localStorage.setItem('shepherdr.sidebars', JSON.stringify({ left: 200, right: 400, open: true })))
    await page.goto(url())
    await page.waitForSelector('#places li')
    await row(page, 'vm-str').hover()
    const side = await box(page, '#places')
    for (const sel of ['#places button[aria-label="New space on vm-str"]', '#places [data-attention-badge]', '#places li:has-text("herdr-projects")']) {
      expect((await box(page, sel)).right).toBeLessThanOrEqual(side.right)
    }
    await page.close()
  }, 30_000)
})

describe.skipIf(!browser)('a single machine', () => {
  /** the other machines go away (or come back): the screen gets the new spaces at once */
  let all: { places: typeof world.places; machines: typeof world.machines } | null = null
  const machines = (only: boolean) => {
    if (only && !all) all = { places: world.places, machines: world.machines }
    if (only && all) Object.assign(world, { places: all.places.filter((p) => p.machine === 'vm-str'), machines: all.machines.filter((m) => m.machine === 'vm-str') })
    if (!only && all) Object.assign(world, all)
    if (!only) all = null
    world.emit('snapshot')
  }
  /** the sidebar's lines, counts left out */
  const sidebar = (page: Page, sel: string) => page.$eval(sel, (n) => (n as HTMLElement).innerText.split('\n').filter((l) => l && !/^\d+$/.test(l)))

  test('a single machine: its heading on top, its home space first under it, its own +', async () => {
    machines(true)
    try {
      // a link to All machines from before lands on the home space, and the address says so
      const desk = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
      await desk.goto(url().replace('place=vm-str/home', 'place=all'))
      await desk.waitForURL(/place=vm-str%2Fhome/)
      await desk.waitForSelector('#places li')
      const side = await sidebar(desk, '#places')
      expect(side).not.toContain('All machines')
      expect(side).not.toContain('Projects')
      expect(side.slice(side.indexOf('vm-str'), side.indexOf('Settings'))).toEqual(['vm-str', 'home', 'gtm', 'herdr-projects'])
      // a tree: the spaces sit in under the machine
      const left = (name: string) => desk.$eval(`#places li:has-text("${name}") button > span`, (l) => l.getBoundingClientRect().left)
      expect(await left('gtm')).toBeGreaterThan(await left('vm-str'))
      await desk.locator('#places li', { hasText: 'vm-str' }).hover()
      expect(await desk.locator('#places').getByRole('button', { name: 'New space on vm-str' }).isVisible()).toBe(true)
      // the chat header says what the space is
      expect(await desk.locator('section').first().getByText('Home space', { exact: true }).isVisible()).toBe(true)
      // search: no All machines either
      await desk.keyboard.press('Control+k')
      const dialog = desk.getByRole('dialog', { name: 'Search or jump to' })
      await dialog.waitFor()
      await dialog.getByRole('option', { name: /gtm/ }).first().waitFor()
      expect(await dialog.getByRole('option', { name: /All machines/ }).count()).toBe(0)
      await desk.close()
      // the phone drawer
      const phone = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
      await phone.goto(url())
      await phone.getByRole('button', { name: 'Spaces', exact: true }).first().click()
      await phone.waitForSelector('nav[aria-label="Spaces"] li')
      const drawer = await sidebar(phone, 'nav[aria-label="Spaces"]')
      expect(drawer).not.toContain('All machines')
      expect(drawer.slice(drawer.indexOf('vm-str'), drawer.indexOf('Settings'))).toEqual(['vm-str', 'home', 'gtm', 'herdr-projects'])
      await phone.close()
    } finally {
      machines(false)
    }
  }, 30_000)

  test('when the others go, their sections go and the screen stays; they come back, so do they', async () => {
    const desk = await browser!.newPage({ viewport: { width: 1440, height: 800 } })
    const headings = () => desk.locator('#places li[data-heading]').evaluateAll((ls) => ls.map((l) => l.getAttribute('data-heading')))
    try {
      await desk.goto(url())
      await desk.locator('#places li[data-heading="m:mac"]').waitFor()
      machines(true)
      await desk.locator('#places li[data-heading="m:mac"]').waitFor({ state: 'detached' })
      expect(await headings()).toEqual(['m:vm-str'])
      expect(new URL(desk.url()).searchParams.get('place')).toBe('vm-str/home')
      machines(false)
      await desk.locator('#places li[data-heading="m:mac"]').waitFor()
      expect(await headings()).toEqual(['m:mac', 'm:nas', 'm:vm-str'])
    } finally {
      machines(false)
      await desk.close()
    }
  }, 30_000)
})
