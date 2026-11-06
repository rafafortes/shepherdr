// Choosing a model from a long list: every model the CLI reports, a search box, the pinned ones first and the recent
// ones next. The whole check runs these browser tests (`bun run check:local`).
import { describe, expect, test } from 'bun:test'
import { layout, settled } from './layout.ts'
import { setModels } from '../server/live/models.ts'

// pi's list as a machine with many providers has it: each model under its provider, named without it, and more than a
// glance can take in
const MODELS = ['alpha/one', 'alpha/two', 'beta/three', 'beta/four', 'gamma/five', 'delta/six', 'epsilon/seven', 'zeta/eight', 'eta/nine', 'theta/ten'].map((id) => ({
  id,
  label: id.split('/')[1].replace(/^./, (c) => c.toUpperCase()),
  efforts: ['low', 'medium', 'high', 'xhigh'],
}))
setModels('pi', { models: MODELS, efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] })

const { browser, url, world } = await layout()

describe.skipIf(!browser)('picking a model', () => {
  test('a phone: the whole list, searched, a pin to tap, the pinned one first and the one picked under Recent', async () => {
    const ctx = await browser!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const page = await ctx.newPage()
    try {
      await page.goto(url())
      const open = async () => {
        await page.locator('[data-composer]:visible button[aria-label="Attach files and more"]').last().click()
        await page.locator('[data-agent-controls]:visible').last().getByRole('menuitem', { name: /^Model:/ }).click()
        const sheet = page.getByRole('alertdialog', { name: 'Restart coordinator?' })
        await sheet.locator('[data-restart]').waitFor()
        // pi reports many providers' models: its list is the long one
        await sheet.getByRole('button', { name: /^Agent: / }).click()
        await page.getByRole('menuitemradio', { name: 'Pi', exact: true }).click()
        await sheet.getByRole('button', { name: /^Model: / }).click()
        const menu = page.getByRole('menu', { name: 'Choices' })
        await menu.waitFor()
        return { sheet, menu }
      }
      let { sheet, menu } = await open()
      // every model it reports, with Default over them and a search box for ten and more
      expect(await menu.getByRole('menuitemradio').count()).toBe(MODELS.length + 1)
      const search = menu.getByRole('searchbox')
      await search.fill('seven')
      expect(await menu.getByRole('menuitemradio').allTextContents()).toEqual(['Seven'])
      // by its provider too, which the name leaves out
      await search.fill('alpha')
      expect(await menu.getByRole('menuitemradio').allTextContents()).toEqual(['One', 'Two'])
      await search.fill('nothing like it')
      expect(await menu.getByRole('menuitemradio').count()).toBe(0)
      await search.fill('')
      // a tap on a row's pin keeps it there, and the list says so where it belongs
      await menu.getByRole('menuitemcheckbox', { name: 'Pin Seven' }).click()
      await menu.getByRole('menuitemcheckbox', { name: 'Unpin Seven' }).waitFor()
      expect(world.picks.pinned).toEqual(['pi:epsilon/seven'])
      expect((await menu.textContent())!.indexOf('Pinned')).toBeGreaterThan(-1)
      // the sheet still fits a phone
      const box = (await sheet.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
      // the pinned one leads, right after Default
      expect((await menu.getByRole('menuitemradio').allTextContents()).slice(0, 2)).toEqual(['Default', 'Seven'])
      // Escape closes the sheet, leaving the agent as it was
      await page.keyboard.press('Escape')
      await page.getByRole('alertdialog').waitFor({ state: 'detached' })
      // opened again, the pin is still there and the list still leads with it
      ;({ sheet, menu } = await open())
      expect((await menu.getByRole('menuitemradio').allTextContents()).slice(0, 2)).toEqual(['Default', 'Seven'])
      // the one picked is a restart on it, and the next list has it under Recent
      await menu.getByRole('menuitemradio', { name: 'Three', exact: true }).click()
      await sheet.getByRole('button', { name: 'Restart', exact: true }).click()
      await sheet.waitFor({ state: 'detached' })
      expect(world.chats['p:vm-str:~'].agent).toMatchObject({ kind: 'pi', model: 'beta/three' })
      expect(world.picks.recent[0]).toBe('pi:beta/three')
      ;({ sheet, menu } = await open())
      const order = await menu.getByRole('menuitemradio').allTextContents()
      expect(order.slice(0, 3)).toEqual(['Default', 'Seven', 'Three'])
      expect(await menu.textContent()).toContain('Recent')
      await page.keyboard.press('Escape')
      await page.getByRole('alertdialog').waitFor({ state: 'detached' })
    } finally {
      await ctx.close()
    }
  }, 60_000)

  test('a keyboard: typing narrows the list and Enter takes the first one left', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await page.goto(url())
      await page.locator('[data-composer]:visible button[aria-label="Attach files and more"]').last().click()
      await page.locator('[data-agent-controls]:visible').last().getByRole('menuitem', { name: /^Model:/ }).click()
      const sheet = page.getByRole('alertdialog', { name: 'Restart coordinator?' })
      await sheet.locator('[data-restart]').waitFor()
      await sheet.getByRole('button', { name: /^Agent: / }).click()
      await page.getByRole('menuitemradio', { name: 'Pi', exact: true }).click()
      await sheet.getByRole('button', { name: /^Model: / }).click()
      const menu = page.getByRole('menu', { name: 'Choices' })
      const search = menu.getByRole('searchbox')
      await search.click()
      await page.keyboard.type('theta')
      await settled(page)
      expect(await menu.getByRole('menuitemradio').allTextContents()).toEqual(['Ten'])
      // the arrow keys walk on to a row's pin, and Enter pins it, no mouse needed
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Pin Ten')
      await page.keyboard.press('Enter')
      expect(world.picks.pinned).toContain('pi:theta/ten')
      // and Enter in the box takes the first one left
      await menu.getByRole('searchbox').click()
      await page.keyboard.press('Enter')
      await menu.waitFor({ state: 'detached' })
      expect(await sheet.getByRole('button', { name: /^Model: / }).getAttribute('aria-label')).toBe('Model: Ten')
      // the effort levels are words, not the CLI's own names
      await sheet.getByRole('button', { name: /^Effort: / }).click()
      expect(await page.getByRole('menu', { name: 'Choices' }).getByRole('menuitemradio').allTextContents()).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high'])
      await page.keyboard.press('Escape')
      await page.getByRole('alertdialog').waitFor({ state: 'detached' })
    } finally {
      await page.close()
    }
  }, 60_000)
})

describe.skipIf(!browser)('Settings’ per-role model row', () => {
  test('a long list opens inside the page, its search box in reach, the pinned one first, found by its id', async () => {
    const before = world.sections
    // as the server hands them over: Default, then the pinned model, then the CLI's order
    const options = ['default', 'Model 7', ...Array.from({ length: 40 }, (_, i) => `Model ${i + 1}`).filter((o) => o !== 'Model 7')]
    // the demo's Settings are fiction of its own: this row is a CLI's long list, as a live one has it
    world.sections = before.map((s) => ({
      ...s,
      rows: s.rows.map((r) => (r.key === 'task.model' ? { ...r, text: false, options, ordered: true, ids: Object.fromEntries(options.slice(1).map((o) => [o, `provider/${o.replace(' ', '-').toLowerCase()}`])) } : r)),
    }))
    world.emit('snapshot')
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Agents', exact: true }).click()
      const tasks = settings.getByRole('heading', { name: 'Tasks', exact: true }).locator('..')
      await tasks.getByRole('button', { name: /^Model: / }).click()
      const menu = page.getByRole('menu', { name: 'Choices' })
      const search = menu.getByRole('searchbox', { name: 'Search' })
      // the box is not drawn under the page's header: the row you would tap is the box itself
      const reachable = await search.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return { hit: at === el, top: r.top, bottom: r.bottom }
      })
      expect(reachable.hit).toBe(true)
      expect(reachable.top).toBeGreaterThanOrEqual(0)
      expect(reachable.bottom).toBeLessThanOrEqual(900)
      expect(await menu.getByRole('menuitemradio').count()).toBe(options.length)
      expect((await menu.getByRole('menuitemradio').allTextContents()).slice(0, 2)).toEqual(['Default', 'Model 7'])
      // a model is found by its own id, which its name leaves out
      await search.fill('')
      await search.click()
      await page.keyboard.type('provider/model-7')
      await settled(page)
      expect(await menu.getByRole('menuitemradio').allTextContents()).toEqual(['Model 7'])
    } finally {
      world.sections = before
      world.emit('snapshot')
      await page.close()
    }
  }, 60_000)
})
