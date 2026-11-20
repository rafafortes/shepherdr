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

/** Violations accepted for now. Each one names the audit finding that owns its fix, so the list can only shrink;
 *  anything a finding does not own stays a failure and is reported as a follow-up, never silently allowed here. */
const ALLOW: { rule: string; why: string; finding: string }[] = [
  {
    rule: 'color-contrast',
    why: 'The demo chart labels use --fg3 inside an artifact frame, which still carries the old #a1a1aa; SHE-114 darkened the app token but not the frame token (axe 2.56:1).',
    finding: 'A11Y-03',
  },
]

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']
type Violation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number]

/** the rule id, impact and first few targets: enough for a failure to name what to fix */
const detail = (v: Violation) =>
  `${v.id} (${v.impact}) ${v.nodes
    .slice(0, 3)
    .map((n) => n.target.join(' '))
    .join(', ')}`

/** scan one settled screen, print its pass count, and return the violations this file does not accept */
async function scan(page: Page, where: string) {
  await settled(page)
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const accepted = result.violations.filter((v) => ALLOW.some((a) => a.rule === v.id))
  const open = result.violations.filter((v) => !ALLOW.some((a) => a.rule === v.id))
  console.log(
    `a11y · ${where}: ${result.passes.length} rules passed, ${result.violations.length} violation(s)${accepted.length ? `, ${accepted.length} accepted` : ''}` +
      (result.violations.length ? ` — ${result.violations.map((v) => `${v.id}${ALLOW.some((a) => a.rule === v.id) ? ' (accepted)' : ''}`).join(', ')}` : ''),
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
        const open = await scan(page, `${engine} · ${screen.name}`)
        expect(open.map(detail)).toEqual([])
      } finally {
        await ctx.close()
      }
    }, 30_000)

  // the check has teeth: a visually hidden div with a button that has no name must fail the same scan
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
      const open = await scan(page, `${engine} · fixture`)
      expect(open.map((v) => v.id)).toContain('button-name')
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
    expect(a.finding).toMatch(/^A11Y-\d+$/)
  }
  expect(new Set(ALLOW.map((a) => a.rule)).size).toBe(ALLOW.length)
})
