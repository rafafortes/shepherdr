// The screen's state is drawn with box-shadow rings and alpha hairlines, so under Windows High Contrast (forced
// colors) the status dots' rings, a picked tab's ring and the focus rings drawn as shadows would all vanish. The
// forced-colors and prefers-contrast media queries in styles.css give each of them a mark of its own, in the
// system's colours, and a prefers-contrast: more page reads the quiet tokens darker: asserted here on a real
// browser, emulated (layout.ts).
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { layout, settled } from './layout.ts'

const { browser, url } = await layout()

/** the demo's one working task: its dot's pie, and the minutes under it */
const workRow = (page: Page) => page.locator('section[aria-label="Tasks"] li', { hasText: 'HP-202' }).first()
const open = async (opts: Record<string, unknown> = {}) => {
  const page = await browser?.newPage({ viewport: { width: 1200, height: 800 }, ...opts })
  if (!page) throw new Error('no browser')
  await page.goto(url())
  await page.waitForSelector('section[aria-label="Tasks"] li')
  await settled(page)
  return page
}
const solid = (v: string) => v !== 'none' && alpha(v) > 0
/** the alpha of a computed colour (a transparent page ground reads rgba(255,255,255,0) under forced colors, so the
 *  number, not the string, is what is checked) */
const alpha = (v: string) => (v.startsWith('rgba(') ? parseFloat(v.slice(v.lastIndexOf(',') + 1)) : 1)

describe.skipIf(!browser)('forced colors', () => {
  test('a dot, a picked tab, a picked row and the keyboard focus keep a mark that is not colour', async () => {
    const page = await open({ forcedColors: 'active' })
    // the query is on: what the page sees is the system's colours, not the app's
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true)
    // the line and wash tokens are the system's, so a hairline drawn from them draws at all
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--line'))).toBe('GrayText')
    // a status dot: a real border, where its ring was an inset shadow
    const dot = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('section[aria-label="Tasks"] li .dot')
      if (!el) throw new Error('no dot in the task list')
      const cs = getComputedStyle(el)
      return { width: parseFloat(cs.borderTopWidth), style: cs.borderTopStyle, color: cs.borderTopColor }
    })
    expect(dot.width).toBeGreaterThan(0)
    expect(dot.style).toBe('solid')
    expect(solid(dot.color)).toBe(true)
    // a working dot: its pie is a gradient the forced colours drop, so a solid disc takes its place
    const pie = await workRow(page)
      .locator('.dot.work')
      .evaluate((el) => getComputedStyle(el, '::after').backgroundColor)
    expect(solid(pie)).toBe(true)
    // the picked tab: a 1px CanvasText outline, where its ring was a shadow
    const tab = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[role=group] button[aria-pressed=true]')
      if (!el) throw new Error('no picked tab')
      const cs = getComputedStyle(el)
      return { width: parseFloat(cs.outlineWidth), style: cs.outlineStyle, color: cs.outlineColor }
    })
    expect(tab.width).toBe(1)
    expect(tab.style).toBe('solid')
    expect(solid(tab.color)).toBe(true)
    // the picked task row: open the one working task and its row is current, drawn by the picked state's outline
    // now that its wash is dropped
    await page.getByRole('button', { name: /Voice call drops on mute/ }).click()
    const row = await page
      .locator('section[aria-label="Tasks"] button[aria-current]')
      .first()
      .evaluate((el) => {
        const cs = getComputedStyle(el)
        return { current: el.getAttribute('aria-current'), width: parseFloat(cs.outlineWidth), style: cs.outlineStyle, color: cs.outlineColor }
      })
    expect(row.current).toBe('true')
    expect(row.width).toBe(1)
    expect(row.style).toBe('solid')
    expect(solid(row.color)).toBe(true)
    // every kind of dot keeps a mark of its own: need and done are solid discs, ready and the idle a ring with the
    // page showing through, work a ring with a disc, merging a gapped ring (the masked one alone), queued a ring
    // with the clock, and the check on the done dot's disc is the page's colour where the ready check is the
    // system's text colour, so the kinds still tell apart where the colour went
    const kinds = await page.evaluate(() => {
      const el = (c: string) => document.querySelector<HTMLElement>(`section[aria-label="Tasks"] .dot.${c}`)
      const merge = el('merging')
      const ready = el('ready')
      const queued = el('queued')
      const need = el('need')
      const done = el('done')
      const idle = el('todo')
      if (!merge || !ready || !queued || !need || !done || !idle) throw new Error('a dot kind is missing from the list')
      const m = getComputedStyle(merge)
      const mg = getComputedStyle(merge, '::after')
      const bg = (e: HTMLElement) => getComputedStyle(e).backgroundColor
      return {
        mergeBase: m.borderTopWidth,
        mergeRing: mg.borderTopWidth,
        mergeMask: mg.webkitMaskImage !== 'none' || mg.maskImage !== 'none',
        readyCheck: getComputedStyle(ready, '::after').borderRightColor,
        queuedHand: getComputedStyle(queued, '::after').borderBottomColor,
        needBg: bg(need),
        idleBg: bg(idle),
        doneBg: bg(done),
        readyBg: bg(ready),
        doneCheck: getComputedStyle(done, '::after').borderRightColor,
      }
    })
    expect(kinds.mergeBase).toBe('0px')
    expect(parseFloat(kinds.mergeRing)).toBeGreaterThan(0)
    expect(kinds.mergeMask).toBe(true)
    expect(solid(kinds.readyCheck)).toBe(true)
    expect(solid(kinds.queuedHand)).toBe(true)
    expect(solid(kinds.needBg)).toBe(true)
    expect(alpha(kinds.idleBg)).toBe(0)
    // the two filled dots are discs of the system's own colours (ready the page's, done its text), and the checks
    // invert with them (text on ready, the page on done), so the two still tell apart where the colour went
    expect(solid(kinds.doneBg)).toBe(true)
    expect(solid(kinds.readyBg)).toBe(true)
    expect(kinds.doneBg).not.toBe(kinds.readyBg)
    expect(kinds.doneCheck).not.toBe(kinds.readyCheck)
    // the keyboard focus: a row and a field draw their ring as a shadow with outline-none, and the base outline
    // is the system's here — Tab a few controls of the page and at least one of them shows a solid outline of its
    // own, where the shadow would have died
    let saw = false
    for (let i = 0; i < 12 && !saw; i++) {
      await page.keyboard.press('Tab')
      saw = await page.evaluate(() => {
        const f = document.activeElement as HTMLElement | null
        if (!f?.matches(':focus-visible')) return false
        const cs = getComputedStyle(f)
        const w = parseFloat(cs.outlineWidth)
        return w >= 2 && cs.outlineStyle === 'solid' && cs.outlineColor !== 'rgba(0, 0, 0, 0)' && cs.outlineColor !== 'none'
      })
    }
    expect(saw).toBe(true)
    await page.close()
  }, 30_000)

  test('the message box keeps its edge, and the quiet tokens go up a shade on more contrast', async () => {
    const page = await open({ forcedColors: 'active' })
    // the message box's edge is a shadow, so it is drawn as the picked state's outline
    const box = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-composer]')
      if (!el) throw new Error('no message box')
      const cs = getComputedStyle(el)
      return { width: parseFloat(cs.outlineWidth), style: cs.outlineStyle }
    })
    expect(box.width).toBe(1)
    expect(box.style).toBe('solid')
    // a prefers-contrast: more page: the quiet tokens are the raised ones, not today's, in light and in dark
    const more = await open({ contrast: 'more' })
    const fg3 = await more.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fg3').trim().slice(1, 7))
    expect(fg3).toBe('55555e')
    const dark = await open({ contrast: 'more', colorScheme: 'dark' })
    const darkTokens = await dark.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      return { theme: document.documentElement.dataset.theme, fg3: root.getPropertyValue('--fg3').trim().slice(1, 7), fg2: root.getPropertyValue('--fg2').trim().slice(1, 7) }
    })
    expect(darkTokens.theme).toBe('dark')
    expect(darkTokens.fg3).toBe('a2a2ab')
    expect(darkTokens.fg2).toBe('c4c4cc')
    await dark.close()
    await more.close()
    await page.close()
  }, 30_000)

  test("without the queries, nothing moves: the tokens and the ring are today's", async () => {
    const page = await open()
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(false)
    // the tokens are the page's own, and a ringed dot's ring is its inset shadow, as before (a need or ready dot is
    // a fill, so the first one with a shadow is the one that keeps it)
    const today = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      const dots = [...document.querySelectorAll<HTMLElement>('section[aria-label="Tasks"] li .dot')]
      const ringed = dots.find((d) => getComputedStyle(d).boxShadow !== 'none')
      if (!ringed || !dots[0]) throw new Error('no dot in the task list')
      return {
        line: root.getPropertyValue('--line').trim(),
        fg3: root.getPropertyValue('--fg3').trim(),
        shadow: getComputedStyle(ringed).boxShadow,
        border: getComputedStyle(dots[0]).borderTopWidth,
      }
    })
    expect(today.line).toBe('#09090b12') // rgb(9 9 11 / 0.07), as the page computes it
    expect(today.fg3).toBe('#6f6f78')
    expect(today.shadow).toContain('inset')
    expect(today.border).toBe('0px')
    // and the picked tab's ring is its shadow, with no outline of its own
    const tab = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[role=group] button[aria-pressed=true]')
      if (!el) throw new Error('no picked tab')
      const cs = getComputedStyle(el)
      return { shadow: cs.boxShadow, outline: cs.outlineWidth }
    })
    expect(tab.shadow).not.toBe('none')
    expect(tab.outline).toBe('3px') // the width the browser reports for an outline of none
    await page.close()
  }, 30_000)
})
