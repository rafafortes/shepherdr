// An axe-core scan of the demo world's screens, in the same browser harness as the other layout tests (layout.ts):
// one app per file, both engines over the one server (WebKit on the phone screens it can draw), skipped where a
// browser won't start. Run in the gate's tests step like every other browser test, not as a gate step of its own (A11Y-07).

import { afterAll, describe, expect, test } from 'bun:test'
import AxeBuilder from '@axe-core/playwright'
import type { Browser, Page } from 'playwright-core'
import { launchWebkit } from './chromium.ts'
import { layout, settled } from './layout.ts'

const { browser, url } = await layout()
const base = url().split('?')[0]
const at = (query: string) => `${base}?${query}`
// the iPhone harness has its own file; here WebKit is a second pair of eyes on the same screens, never its own app
const webkit = browser ? await launchWebkit() : null
if (webkit) afterAll(() => webkit.close())

/** Violations accepted for now. Each one names the finding or task that owns its fix, so the list can only shrink;
 *  anything nobody owns stays a failure. `target` and `screens` tie an entry to the exact nodes and screens audited
 *  here, so the same rule still fails everywhere else. When a follow-up task fixes its entry, remove the entry. */
type Pair = { target: RegExp; screens?: string[] }
type Allow = { rule: string; why: string; finding: string; pairs: Pair[] }
const ALLOW: Allow[] = [
  {
    rule: 'color-contrast',
    pairs: [{ target: /iframe\[title="This week across machines"\]/ }],
    why: 'The demo chart labels use --fg3 inside an artifact frame, which still carries the old #a1a1aa; SHE-114 darkened the app token but not the frame token (axe 2.56:1).',
    finding: 'A11Y-03',
  },
  {
    rule: 'aria-required-children',
    pairs: [
      { target: /^div\[data-flip="automations:p:vm-str:gtm"\] > ul$/, screens: ['desktop: places + chat + tasks', 'artifact viewer'] },
      { target: /^div > ul$/, screens: ['Needs you view'] },
      { target: /^#search-list$/, screens: ['search sheet'] },
    ],
    why: 'Three lists have non-li children: the automations ul, the Needs you ul and the search listbox; SHE-176 owns their markup.',
    finding: 'SHE-176',
  },
]

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']
type Violation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number]

/** an entry applies only when a target-and-screens pair fits every node and, where named, the screen; a new failure
 *  anywhere else is still reported with its rule id */
const accepts = (v: Violation, screen?: string) =>
  ALLOW.some(
    (a) => a.rule === v.id && a.pairs.some((p) => (!p.screens || (!!screen && p.screens.includes(screen))) && v.nodes.every((n) => n.target.some((t) => typeof t === 'string' && p.target.test(t)))),
  )

/** the rule id, impact and the targets: enough for a failure to name what to fix */
const detail = (v: Violation) => `${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`

/** scan one settled screen, print its pass count, and return the violations this file does not accept */
async function scan(page: Page, where: string, screen: string) {
  await settled(page)
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const accepted = result.violations.filter((v) => accepts(v, screen))
  const open = result.violations.filter((v) => !accepts(v, screen))
  console.log(
    `a11y · ${where}: ${result.passes.length} rules passed, ${result.violations.length} violation(s)${accepted.length ? `, ${accepted.length} accepted` : ''}` +
      (result.violations.length ? ` — ${result.violations.map((v) => `${v.id}${accepts(v, screen) ? ' (accepted)' : ''}`).join(', ')}` : ''),
  )
  return open
}

type Screen = {
  name: string
  query: string
  viewport: { width: number; height: number }
  phone?: boolean
  open: (page: Page) => Promise<void>
}

const SCREENS: Screen[] = [
  {
    name: 'desktop: places + chat + tasks',
    query: 'place=vm-str/home',
    viewport: { width: 1440, height: 900 },
    open: async (page) => {
      await page.getByRole('textbox', { name: /Message/ }).waitFor()
    },
  },
  {
    name: 'phone 320: places + chat + tasks',
    query: 'place=vm-str/home',
    viewport: { width: 320, height: 740 },
    phone: true,
    open: async (page) => {
      await page.getByRole('textbox', { name: /Message/ }).waitFor()
    },
  },
  {
    name: 'Needs you view',
    query: 'place=vm-str/home',
    viewport: { width: 1440, height: 900 },
    open: async (page) => {
      await page
        .getByRole('group', { name: 'Show' })
        .getByRole('button', { name: /Needs you/ })
        .click()
      await page.locator('section[aria-label="Needs you"]').waitFor()
    },
  },
  {
    name: 'task side panel',
    query: 'place=p%3Avm-str%3Aherdr-projects&task=HP-201',
    viewport: { width: 1440, height: 900 },
    open: async (page) => {
      await page.locator('#task-panel').waitFor()
    },
  },
  {
    name: 'Settings: Notifications',
    query: 'place=vm-str/home',
    viewport: { width: 1440, height: 900 },
    open: async (page) => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Notifications', exact: true }).click()
      await settings.getByRole('group', { name: 'Notify', exact: true }).waitFor()
    },
  },
  {
    name: 'Keyboard shortcuts',
    query: 'place=vm-str/home',
    viewport: { width: 1440, height: 900 },
    open: async (page) => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click()
      await page.getByRole('heading', { name: 'Keyboard shortcuts' }).waitFor()
    },
  },
  {
    name: 'artifact viewer',
    query: 'place=vm-str/home&artifact=a1',
    viewport: { width: 1440, height: 900 },
    open: async (page) => {
      await page.getByRole('dialog', { name: 'This week across machines' }).waitFor()
    },
  },
  {
    name: 'search sheet',
    query: 'place=vm-str/home',
    viewport: { width: 390, height: 844 },
    phone: true,
    open: async (page) => {
      await page.getByRole('button', { name: 'Search', exact: true }).click()
      await page.getByRole('dialog', { name: 'Search or jump to' }).waitFor()
    },
  },
  {
    name: 'phone drawer',
    query: 'place=vm-str/home',
    viewport: { width: 390, height: 844 },
    phone: true,
    open: async (page) => {
      await page.getByRole('button', { name: 'Places', exact: true }).click()
      await page.getByRole('button', { name: 'Close', exact: true }).waitFor()
    },
  },
]

/** a context per screen: AxeBuilder reuses the page's context for its own work, and a page made by browser.newPage()
 *  owns one it cannot use (axe-core-npm's error-handling guide). Reduced motion keeps WebKit's desktop renderer from
 *  stalling on the app's endless animations (as the iPhone harness does too). */
async function open(b: Browser, viewport: { width: number; height: number }, phone = false) {
  const ctx = await b.newContext({ viewport, hasTouch: phone, isMobile: phone, reducedMotion: 'reduce' })
  return { ctx, page: await ctx.newPage() }
}

/** each engine gets its own pages off the one app; a browser that did not start skips its whole describe. The screens
 *  argument lets WebKit take the phone ones: its desktop renderer leaves the composer hidden and a suspense fallback
 *  in place on this host, so a desktop scan there would be of an unfinished screen (a separate app issue). */
function run(engine: string, b: Browser, screens: Screen[]) {
  for (const screen of screens)
    test(`${engine}: ${screen.name}`, async () => {
      const { ctx, page } = await open(b, screen.viewport, !!screen.phone)
      try {
        await page.goto(at(screen.query))
        await screen.open(page)
        const open = await scan(page, `${engine} · ${screen.name}`, screen.name)
        expect(open.map(detail)).toEqual([])
      } finally {
        await ctx.close()
      }
    }, 30_000)

  // the check has teeth: a visually hidden div with an unlabeled button must fail the same scan
  test(`${engine}: a broken button fails the scan (fixture)`, async () => {
    const { ctx, page } = await open(b, { width: 390, height: 844 }, true)
    try {
      await page.goto(at('place=vm-str/home'))
      await page.getByRole('textbox', { name: /Message/ }).waitFor()
      await page.evaluate(() => {
        const div = document.createElement('div')
        div.id = 'a11y-fixture'
        div.setAttribute('style', 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)')
        const button = document.createElement('button')
        button.type = 'button'
        div.append(button)
        document.body.append(div)
      })
      const found = (await scan(page, `${engine} · fixture`, 'fixture')).map((v) => v.id)
      expect(found).toContain('button-name')
    } finally {
      await ctx.close()
    }
  }, 30_000)
}

describe.skipIf(!browser)('axe-core scan (chromium)', () => {
  if (browser) run('chromium', browser, SCREENS)
})

describe.skipIf(!webkit)('axe-core scan (webkit)', () => {
  if (webkit)
    run(
      'webkit',
      webkit,
      SCREENS.filter((s) => s.phone),
    )
})

test('every accepted rule names its reason and the finding that will remove it', () => {
  for (const a of ALLOW) {
    expect(a.rule).toMatch(/^[a-z-]+$/)
    expect(a.why.length).toBeGreaterThan(20)
    expect(a.finding).toMatch(/^(A11Y-\d+|SHE-\d+)$/)
    expect(a.pairs.length).toBeGreaterThan(0)
    for (const p of a.pairs) {
      expect(p.target).toBeInstanceOf(RegExp)
      if (p.screens) expect(p.screens.length).toBeGreaterThan(0)
    }
  }
  expect(ALLOW.length).toBe(new Set(ALLOW.map((a) => a.rule)).size)
})

test('the contrast allowance is confined to the artifact frame', () => {
  const violation = (target: string[]) => ({ id: 'color-contrast', nodes: [{ target }] }) as Violation
  expect(accepts(violation(['iframe[title="This week across machines"]', 'span:nth-child(1)']))).toBe(true)
  expect(accepts(violation(['.inset-0.absolute > iframe[title="This week across machines"]', 'span:nth-child(1)']))).toBe(true)
  // a new low-contrast line in the app itself, or on any other screen, still fails with its rule id
  expect(accepts(violation(['[data-msg] span']))).toBe(false)
})

test('the follow-up allowances only cover their own targets and screens', () => {
  const violation = (id: string, target: string[]) => ({ id, nodes: [{ target }] }) as Violation
  expect(accepts(violation('aria-required-children', ['#search-list']), 'search sheet')).toBe(true)
  expect(accepts(violation('aria-required-children', ['div[data-flip="automations:p:vm-str:gtm"] > ul']), 'artifact viewer')).toBe(true)
  expect(accepts(violation('aria-required-children', ['div[data-flip="automations:p:vm-str:gtm"] > ul']), 'desktop: places + chat + tasks')).toBe(true)
  expect(accepts(violation('aria-required-children', ['div > ul']), 'Needs you view')).toBe(true)
  expect(accepts(violation('aria-required-children', ['#search-list']), 'desktop: places + chat + tasks')).toBe(false)
  expect(accepts(violation('aria-required-children', ['ul']), 'search sheet')).toBe(false)
  // SHE-177 made the shortcuts scroller focusable, so its rule has no allowance left
  expect(ALLOW.some((a) => a.rule === 'scrollable-region-focusable')).toBe(false)
})

describe.skipIf(!browser)('the shortcuts scroll region is keyboard reachable (SHE-177)', () => {
  test('chromium: the scroller takes focus and scrolls with the arrow keys', async () => {
    if (!browser) return
    const { ctx, page } = await open(browser, { width: 1440, height: 900 })
    try {
      await page.goto(at('place=vm-str/home'))
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click()
      await page.getByRole('heading', { name: 'Keyboard shortcuts' }).waitFor()
      await settled(page)
      // the shared desktop Settings scroller is a named, focusable region (not just a scrollable div)
      const scroller = page.getByRole('region', { name: 'Settings content' })
      await scroller.waitFor()
      expect(await scroller.getAttribute('tabindex')).toBe('0')
      // the shortcuts list really overflows, so there is something to scroll
      const { sh, ch } = await scroller.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
      expect(sh).toBeGreaterThan(ch)
      await scroller.focus()
      expect(await scroller.evaluate((el) => document.activeElement === el)).toBe(true)
      const before = await scroller.evaluate((el) => el.scrollTop)
      for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown')
      const down = await scroller.evaluate((el) => el.scrollTop)
      expect(down).toBeGreaterThan(before)
      for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowUp')
      expect(await scroller.evaluate((el) => el.scrollTop)).toBeLessThan(down)
    } finally {
      await ctx.close()
    }
  }, 30_000)

  test('chromium: a focused control inside keeps its own arrow keys', async () => {
    if (!browser) return
    const { ctx, page } = await open(browser, { width: 1440, height: 900 })
    try {
      await page.goto(at('place=vm-str/home'))
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'How tasks work', exact: true }).click()
      await settled(page)
      const scroller = page.getByRole('region', { name: 'Settings content' })
      const box = settings.getByRole('textbox', { name: 'Review rounds (rounds)', exact: true })
      await box.waitFor()
      const { sh, ch } = await scroller.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
      expect(sh).toBeGreaterThan(ch)
      await box.focus()
      const before = await box.inputValue()
      const top = await scroller.evaluate((el) => el.scrollTop)
      await box.press('ArrowDown')
      // the number stepped, and the scroller did not move: the handler only acts on the scroller itself
      expect(await box.inputValue()).not.toBe(before)
      expect(await scroller.evaluate((el) => el.scrollTop)).toBe(top)
    } finally {
      await ctx.close()
    }
  }, 30_000)
})

test.skipIf(!browser)(
  'the contrast allowance is exercised by the real artifact frame',
  async () => {
    if (!browser) return
    const { ctx, page } = await open(browser, { width: 1440, height: 900 })
    try {
      await page.goto(at('place=vm-str/home&artifact=a1'))
      await page.getByRole('dialog', { name: 'This week across machines' }).waitFor()
      await settled(page)
      const found = (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations.filter((v) => v.id === 'color-contrast')
      // when A11Y-03 fixes the frame's palette, this and the ALLOW entry go together
      expect(found.length).toBeGreaterThan(0)
      expect(found.every((v) => accepts(v, 'artifact viewer'))).toBe(true)
    } finally {
      await ctx.close()
    }
  },
  30_000,
)
