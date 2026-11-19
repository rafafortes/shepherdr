// A place's Autopilot and Run now: the switch in the ⋯ menu, the pill beside it, and waking its coordinator, in a real
// browser (layout.ts).
import { describe, expect, test } from 'bun:test'
import { layout, settled } from './layout.ts'

const { browser, world, server, url } = await layout()

describe.skipIf(!browser)("a place's Autopilot", () => {
  for (const [name, opts] of [
    ['phone, dark', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' }],
    ['phone, light', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light' }],
    ['desktop, light', { viewport: { width: 1600, height: 900 }, colorScheme: 'light' }],
    ['desktop, dark', { viewport: { width: 1600, height: 900 }, colorScheme: 'dark' }],
  ] as const)
    test(`is a switch at the top of the ⋯ menu, over search and the terminal; a pill beside that menu shows it only while on (${name})`, async () => {
      const ctx = await browser!.newContext(opts)
      const page = await ctx.newPage()
      await page.goto(url())
      await page.getByRole('button', { name: 'Menu', exact: true }).waitFor()
      // with Autopilot off the header says nothing of it
      const pill = page.locator('[data-chrome] button[data-mode]')
      expect(await pill.count()).toBe(0)
      // no switch in the + menu: that keeps files, model and effort
      await page.locator('[data-composer] button[aria-label="Attach files and more"]').first().click()
      await page.getByRole('menuitem', { name: 'File or photo' }).waitFor()
      expect(await page.getByRole('menuitemcheckbox', { name: 'Autopilot' }).count()).toBe(0)
      await page.keyboard.press('Escape')
      // the ⋯ menu: the switch first, then search, the terminal, artifacts; no three-way picker
      await page.getByRole('button', { name: 'Menu', exact: true }).click()
      const pop = page.getByRole('menu', { name: 'Menu' })
      const sw = pop.getByRole('menuitemcheckbox', { name: 'Autopilot' })
      await sw.waitFor()
      expect(await pop.getByRole('menuitem').allTextContents()).toEqual([expect.stringContaining('Search in this chat'), 'Search this chat and beyond', 'Restart agent…', expect.stringContaining('Terminal'), 'Artifacts'])
      expect(await pop.locator('[role=group]').count()).toBe(0)
      expect(await sw.getAttribute('aria-checked')).toBe('false')
      expect(await pop.getByText('Off: does what you ask').count()).toBe(1)
      // a row as tall as the menu's other rows, its icon in their icon slot, its switch inside
      await settled(page)
      const items = await pop.locator('[role=menuitem]').evaluateAll((bs) => bs.map((b) => ({ h: b.getBoundingClientRect().height, slot: b.firstElementChild!.getBoundingClientRect().left })))
      const row = await sw.evaluate((b) => ({ h: b.getBoundingClientRect().height, slot: b.firstElementChild!.getBoundingClientRect().left }))
      expect(row.h).toBeCloseTo(items[0].h, 1)
      expect(row.slot).toBeCloseTo(items[0].slot, 1)
      const [menu, s] = [(await pop.boundingBox())!, (await sw.boundingBox())!]
      expect(s.x).toBeGreaterThanOrEqual(menu.x)
      expect(s.x + s.width).toBeLessThanOrEqual(menu.x + menu.width + 0.5)
      // on: the pill shows, red, and the switch says so; the menu stays open
      await sw.click()
      await pill.waitFor()
      expect(await sw.getAttribute('aria-checked')).toBe('true')
      expect(await pill.innerText()).toBe('Autopilot')
      expect(await pill.getAttribute('aria-label')).toBe('Autopilot is on. Change it')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      // off again: the pill goes, for the tests after
      await sw.click()
      await page.waitForFunction(() => !document.querySelector('[data-chrome] button[data-mode]'))
      expect(await sw.getAttribute('aria-checked')).toBe('false')
      await ctx.close()
    }, 30_000)

  for (const [name, opts] of [
    ['phone, dark', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' }],
    ['desktop, light', { viewport: { width: 1440, height: 800 }, colorScheme: 'light' }],
  ] as const)
    test(`a sidebar row on Autopilot has a red dot just before its name, clear of the chevrons; no name moves (${name})`, async () => {
      const on = ['p:vm-str:~', 'p:mac:~', 'p:vm-str:gtm']
      const was = on.map((id) => world.places.find((p) => p.id === id)!.mode)
      const ctx = await browser!.newContext(opts)
      const page = await ctx.newPage()
      await page.goto(url())
      // a phone's places are in its drawer
      const side = opts.viewport.width < 600 ? 'nav[aria-label="Places"]' : '#places'
      if (side !== '#places') await page.getByRole('button', { name: 'Places' }).first().click()
      await page.waitForSelector(`${side} li`)
      await settled(page)
      const rows = () =>
        page.$$eval(`${side} li[data-project]`, (ls) =>
          ls.map((l) => {
            const go = l.querySelector('button[aria-label]:not([aria-expanded]):not([aria-haspopup])')!
            const fold = l.querySelector('button[aria-label^="Show "], button[aria-label^="Hide "]')?.getBoundingClientRect()
            const mark = l.querySelector('[data-autopilot]')
            const m = mark?.getBoundingClientRect()
            // the place's icon, between the mark and the name (SHE-207)
            const icon = mark?.nextElementSibling?.getBoundingClientRect()
            return { said: go.getAttribute('aria-label')!, name: go.getBoundingClientRect().left, fold: fold?.right, icon: icon && { left: icon.left, right: icon.right }, mark: m && { left: m.left, right: m.right, w: m.width, h: m.height, round: parseFloat(getComputedStyle(mark!).borderRadius) >= m.width / 2, hidden: mark!.getAttribute('aria-hidden') } }
          }),
        )
      const before = await rows()
      expect(before.every((r) => !r.mark)).toBe(true)
      for (const id of on) await world.act({ type: 'mode', place: id, mode: 'autopilot' })
      await page.waitForFunction(([s, n]) => document.querySelectorAll(`${s} [data-autopilot]`).length === n, [side, on.length] as const)
      const after = await rows()
      // every name where it was, on Autopilot or not
      expect(after.map((r) => r.name)).toEqual(before.map((r) => r.name))
      for (const r of after.filter((r) => r.mark)) {
        // just before the space's # and its name, clear of the headings' chevrons
        expect(r.icon!.left - r.mark!.right).toBeWithin(0, 6)
        expect(r.name - r.icon!.right).toBeWithin(0, 8)
        if (r.fold !== undefined) expect(r.mark!.left).toBeGreaterThanOrEqual(r.fold)
        // the dot in its round tint, as the header's pill without the word; screen readers hear it in the row's name
        expect(r.mark!.w).toBeWithin(12, 18)
        expect(r.mark!.h).toBe(r.mark!.w)
        expect(r.mark!.round).toBe(true)
        expect(r.mark!.hidden).toBe('true')
        expect(r.said).toContain(', on Autopilot')
      }
      expect(after.filter((r) => r.mark).length).toBe(on.length)
      expect(await page.locator(`${side} [data-autopilot]`).first().evaluate((e) => getComputedStyle(e, '::before').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      for (const [i, id] of on.entries()) await world.act({ type: 'mode', place: id, mode: was[i] })
      // each switch left a card in its chat: read, for the tests after
      const last = world.snapshot().last ?? {}
      await world.act({ type: 'read', chats: Object.fromEntries(on.map((id) => [id, last[id]])) })
      await page.waitForFunction((s) => !document.querySelector(`${s} [data-autopilot]`), side)
      await ctx.close()
    }, 30_000)

  test("a task's attachment menu keeps files; agent controls live inside it on a small phone", async () => {
    const page = await browser!.newPage({ viewport: { width: 320, height: 640 }, hasTouch: true })
    await page.goto(`http://127.0.0.1:${server!.port}/?place=all&task=GTM-14`)
    await page.locator('[data-composer]').first().waitFor()
    expect(await page.locator('[data-agent-controls]').count()).toBe(0)
    await page.locator('[data-composer] button[aria-label="Attach files and more"]').first().click()
    await page.getByRole('menuitem', { name: 'File or photo' }).waitFor()
    expect(await page.getByRole('combobox', { name: 'Model' }).count()).toBe(0)
    expect(await page.getByRole('group', { name: 'Mode', exact: true }).count()).toBe(0)
    expect(await page.locator('[data-agent-controls] [role=menuitem]').count()).toBe(3)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.close()
  }, 30_000)
})

describe.skipIf(!browser)('Autopilot Run now', () => {
  const place = () => world.places.find((x) => x.id === 'p:vm-str:herdr-projects')!
  const at = (id: string) => `http://127.0.0.1:${server!.port}/?place=${encodeURIComponent(id)}`
  const line = 'Autopilot woke · Run now · nothing to report'
  for (const [name, opts] of [
    ['phone, light', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light' }],
    ['desktop, dark', { viewport: { width: 1440, height: 800 }, colorScheme: 'dark' }],
  ] as const)
    test(`one tap beside the pill wakes its coordinator once, leaves one quiet line in that chat, and says Waking while it runs (${name})`, async () => {
      const p = place()
      const was = p.mode
      await world.act({ type: 'mode', place: p.id, mode: 'autopilot' })
      const ctx = await browser!.newContext(opts)
      const page = await ctx.newPage()
      await page.goto(at(p.id))
      const chat = page.locator('[data-messages]')
      await chat.waitFor()
      // a wake another test made may already sit here: its own line, at the end of the chat
      const before = await chat.locator('[data-pilot]').count()
      const run = page.locator('[data-chrome] [data-run-now]')
      await run.waitFor()
      await run.click()
      // the wake's one quiet line, in the place's own chat: a line, never a card, and no words of its own
      const quiet = chat.locator('[data-pilot]')
      await page.waitForFunction((n) => document.querySelectorAll('[data-messages] [data-pilot]').length === n, before + 1)
      expect((await quiet.allInnerTexts()).slice(before)).toEqual([line])
      const last = quiet.last()
      expect(await last.evaluate((e) => !!e.closest('[data-card]'))).toBe(false)
      expect(await last.evaluate((e) => !!e.querySelector('[data-text]'))).toBe(false)
      expect(await last.evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeLessThan(15)
      // while its wake runs the button is off, saying so: a second tap can't stack another wake on it
      await page.waitForFunction(() => document.querySelector('[data-chrome] [data-run-now]')?.hasAttribute('disabled'))
      expect(await run.innerText()).toBe('Waking')
      // its turn over: ready again, one wake per tap
      await page.waitForFunction(() => !document.querySelector('[data-chrome] [data-run-now]')?.hasAttribute('disabled'))
      await run.click()
      await page.waitForFunction((n) => document.querySelectorAll('[data-messages] [data-pilot]').length === n, before + 2)
      expect((await quiet.allInnerTexts()).slice(before)).toEqual([line, line])
      await page.close()
      // another place's chat has none of it: the line belongs to the chat it woke
      const other = await browser!.newPage(opts)
      await other.goto(at('p:vm-str:gtm'))
      await other.locator('[data-messages]').waitFor()
      expect(await other.locator('[data-messages] [data-pilot]').count()).toBe(0)
      await other.close()
      await world.act({ type: 'mode', place: p.id, mode: was })
      await ctx.close()
    }, 40_000)

  test('Settings → Autopilot offers it too, at the top of the space level (phone)', async () => {
    const p = place()
    const was = p.mode
    await world.act({ type: 'mode', place: p.id, mode: 'autopilot' })
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const before = world.chat(p.chat).messages.length
    await page.goto(at(p.id))
    await page.getByRole('button', { name: 'Places' }).click()
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Autopilot', exact: true }).click()
    const run = page.getByRole('button', { name: /Run now: wake/ })
    await run.waitFor()
    expect(await run.innerText()).toBe('Run now')
    expect(await page.getByText('Wakes its coordinator once, now', { exact: false }).count()).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await run.click()
    // its coordinator wakes: one quiet line in the chat behind the page
    await page.waitForFunction(() => !document.querySelector('[aria-label*="Run now: wake"]')?.hasAttribute('disabled'))
    expect(world.chat(p.chat).messages.slice(before).filter((m) => m.pilot).map((m) => m.pilot)).toEqual([line])
    await world.act({ type: 'mode', place: p.id, mode: was })
    await page.close()
  }, 40_000)
})
