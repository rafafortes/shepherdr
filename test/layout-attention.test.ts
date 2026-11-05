// Aggregate notifications keep categories separate, in the real sidebar, the Needs you tab and the Tasks tab.
import { describe, expect, test } from 'bun:test'
import { layout, settled, until } from './layout.ts'

const { browser, world, url } = await layout()
const badge = '[data-attention-badge]'
const place = 'p:vm-str:gtm'

describe.skipIf(!browser)('attention count circles', () => {
  for (const width of [390, 820, 1440]) {
    test(`zero, one-sided and capped counts beside their own lists, both themes at ${width}px`, async () => {
      const saved = world.tasks
      const page = await browser!.newPage({ viewport: { width, height: 1000 } })
      const template = saved.find((t) => t.status === 'ready')!
      const requests = world.chats[place].messages
      const asks = world.asks
      // No coordinator request in the state matrix; the scoped coordinator counting is checked below.
      world.chats[place].messages = []
      world.asks = {}
      const tasks = (need: number, ready: number) => Array.from({ length: need + ready }, (_, i) => ({
        ...template, id: `BADGE-${i}`, place, status: i < need ? 'need' as const : 'ready' as const,
        agent: undefined,
      }))
      /** a badge of one scope, its label, its printed numbers and its shape */
      const one = async (scope: string, need: number, ready: number) => {
        const el = page.locator(`${badge}[aria-label$="${scope}"]`).filter({ visible: true }).first()
        expect(await until(() => el.count(), (n) => n === (need || ready ? 1 : 0))).toBe(need || ready ? 1 : 0)
        if (!need && !ready) return
        expect(await until(() => el.getAttribute('aria-label'), (s) => s === `${need} needs you, ${ready} ready · ${scope}`)).toBe(`${need} needs you, ${ready} ready · ${scope}`)
        expect(await el.getAttribute('data-attention-badge')).toBe(need && ready ? 'both' : need ? 'need' : 'ready')
        expect(await el.locator(':scope > span').allTextContents()).toEqual([...(need ? [need > 9 ? '9+' : `${need}`] : []), ...(ready ? [ready > 9 ? '9+' : `${ready}`] : [])])
        const geometry = await el.evaluate((node) => {
          const b = node.getBoundingClientRect()
          return { w: b.width, h: b.height, radius: getComputedStyle(node).borderRadius, fits: [...node.children].every((c) => c.scrollWidth <= c.clientWidth) }
        })
        expect(geometry.w).toBe(geometry.h)
        expect(geometry.radius).toBe('50%')
        expect(geometry.fits).toBe(true)
      }
      try {
        await page.goto(url().replace('vm-str/home', 'vm-str/gtm'))
        await page.locator('[aria-label^="Message"]').first().waitFor()
        for (const theme of ['light', 'dark']) {
          await page.evaluate((value) => {
            localStorage.setItem('shepherdr.appearance', value)
            dispatchEvent(new StorageEvent('storage', { key: 'shepherdr.appearance' }))
          }, theme)
          for (const [need, ready] of [[0, 0], [1, 0], [0, 1], [2, 3], [12, 108]]) {
            // Neither archived tasks nor tasks in a different space belong to this panel's counts.
            world.tasks = [...tasks(need, ready), { ...template, id: 'ARCHIVED', place, archived: Date.now() }, { ...template, id: 'ELSEWHERE', place: 'p:mac:lilla-varlden' }]
            world.emit('snapshot')
            // the Needs you tab counts what it lists, the Tasks tab its own Ready group: one number each, where it shows
            await one('needs scope', need, 0)
            await one('panel scope', 0, ready)
            const colour = theme === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)'
            if (need || ready) expect(await page.locator(`${badge}[aria-label$="panel scope"]`).filter({ visible: true }).first().evaluate((el) => getComputedStyle(el).color)).toBe(colour)
            const row = page.locator(`nav[aria-label="Places"] li[data-project="${place}"]`)
            if (!await row.isVisible()) await page.getByRole('button', { name: 'Places', exact: true }).click()
            if (need || ready) {
              await row.locator(badge).first().waitFor({ state: 'attached' })
              // the space's own row counts both: what it holds waiting and ready
              expect(await row.locator(badge).getAttribute('aria-label')).toBe(`${need} needs you, ${ready} ready · here`)
              expect(await row.locator(badge).count()).toBe(1)
            } else expect(await row.locator(badge).count()).toBe(0)
            // Clicking the same space keeps the existing navigation and closes the phone drawer.
            await row.getByRole('button', { name: /^gtm,/ }).click()
            await settled(page)
            expect(page.url()).toContain('gtm')
            expect(await page.locator('[data-attention]').count()).toBe(0)
            expect(await page.getByText(/^Task updates ·/).count()).toBe(0)
          }
        }
        // A coordinator question is one more row of Needs you, and of the space's row: never a number on the Tasks tab.
        world.tasks = tasks(1, 1)
        world.chats[place].messages = requests
        world.asks = asks
        world.emit('snapshot')
        await one('needs scope', 2, 0)
        await one('panel scope', 0, 1)
        if (!await page.locator(`li[data-project="${place}"]`).isVisible()) await page.getByRole('button', { name: 'Places', exact: true }).click()
        expect(await until(() => page.locator(`li[data-project="${place}"] ${badge}`).getAttribute('aria-label'), (s) => s === '2 needs you, 1 ready · here')).toBe('2 needs you, 1 ready · here')
      } finally {
        world.tasks = saved
        world.chats[place].messages = requests
        world.asks = asks
        world.emit('snapshot')
        await page.close()
      }
      // a wide window draws the docked lists too, and the counting with them: more to wait through
    }, 60_000)
  }
})
