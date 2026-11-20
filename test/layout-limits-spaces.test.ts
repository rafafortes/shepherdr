// Settings → Limits, the spaces under the limits: Set for every space…, the Priority column and its arrows, and the
// tables fitting the Settings width, in a real browser (layout.ts).
import { afterAll, describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { at, layout, pickLimit, rowLabels, settled, until } from './layout.ts'
import { piOffers } from './pi-offers.ts'

// pi lists nvidia and amd-tokenlab, which nothing in the demo uses: they are the providers under Other providers
const restorePi = piOffers()
afterAll(restorePi)
const { browser, world, url } = await layout()

/** the file's tests share one world and one browser: each starts from the demo's own limits, with no column of this browser's */
async function fresh(page: Page) {
  const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
  await set('machine.maxTasks', null, 'm:vm-str')
  await set('space.maxTasks', '2', 'p:vm-str:gtm')
  await set('space.maxTasks', null, 'p:vm-str:herdr-projects')
  for (const place of ['all', 'm:vm-str', 'p:vm-str:gtm', 'p:vm-str:herdr-projects']) await set('models.maxAtOnce', null, place)
  await set('space.maxTasks', null, 'all')
  await page.goto(url())
  await page.evaluate(() => localStorage.removeItem('limits:columns'))
}

/** the Priority value each space of this machine holds now, as Settings → Limits reads it (off: no number) */
const places = async () => {
  const v = (await world.act({ type: 'limits-view' } as never)) as { spaces: { rows: { name: string; cells: Record<string, { row: { value: string } }> }[] } }
  return Object.fromEntries(v.spaces.rows.map((r) => [r.name, r.cells['space.priority']!.row.value]))
}

/** the Limits page on a desktop, opened from Settings → How Shepherdr runs */
async function openLimits(page: Page, phone = false) {
  await fresh(page)
  await page.goto(url())
  if (phone) await page.getByRole('button', { name: 'Spaces', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('region', { name: 'Settings' }).getByRole('button', { name: 'Limits', exact: true }).click()
  await settled(page)
}

describe.skipIf(!browser)('Settings → Limits on a desktop', () => {
  test('a press outside an open editor closes it without writing; Set for every space… with Everywhere resets the spaces to it', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      const cell = page.getByRole('button', { name: /^vm-str · Max tasks working at once: 10/ })
      await cell.scrollIntoViewIfNeeded()
      await cell.click()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      await pop.waitFor()
      // a press outside the editor closes it, and writes nothing (Escape would close the sheet too)
      await page.getByRole('heading', { name: 'Waiting now', exact: true }).click()
      await pop.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: /^vm-str · Max tasks working at once: 10/ }).waitFor()
      // the column's Everywhere mode: Everywhere gets 5, and each space loses its own value (gtm had 2)
      await page.getByRole('button', { name: 'More for Max tasks', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Set for every space…', exact: true }).click()
      const dialog = page.getByRole('alertdialog', { name: 'Set Max tasks for every space' })
      await dialog.getByRole('radio', { name: /Everywhere, and reset the spaces/ }).check()
      await pickLimit(dialog, '5')
      await dialog.getByRole('button', { name: 'Set for 2 spaces', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      // gtm now reads Everywhere's value, faint, from there
      const gtm = page.getByRole('button', { name: /^gtm · Max tasks: 5, / })
      await gtm.waitFor()
      await gtm.getByText('Everywhere', { exact: true }).waitFor()
    } finally {
      await page.close()
    }
  })
  test("a column's Set for every space… writes each space its own value, and the dialog closes once they are written", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      await page.getByRole('button', { name: 'More for Max tasks', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Set for every space…', exact: true }).click()
      const dialog = page.getByRole('alertdialog', { name: 'Set Max tasks for every space' })
      await pickLimit(dialog, '4')
      await dialog.getByRole('button', { name: 'Set for 2 spaces', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: /^gtm · Max tasks: 4, / }).waitFor()
      await page.getByRole('button', { name: /^herdr-projects · Max tasks: 4, / }).waitFor()
    } finally {
      await page.close()
    }
  })
  test('a browser that keeps no storage still shows the page, and a column added stays for the page while it is open', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      // the columns' keys are refused by the browser's storage: the page keeps them for this view only
      await page.addInitScript(() => {
        const get = Storage.prototype.getItem
        const put = Storage.prototype.setItem
        Storage.prototype.getItem = function (k: string) {
          if (k.startsWith('limits:')) throw new Error('no storage')
          return get.call(this, k)
        }
        Storage.prototype.setItem = function (k: string, v: string) {
          if (k.startsWith('limits:')) throw new Error('no storage')
          put.call(this, k, v)
        }
      })
      await openLimits(page)
      await page.getByRole('button', { name: '+ column', exact: true }).click()
      await page.getByRole('menuitem', { name: /^pi · Spark \(local\) provider$/ }).click()
      await page
        .getByRole('table', { name: 'Spaces' })
        .getByRole('button', { name: /^pi · Spark \(local\) in gtm: no sub-limit$/ })
        .waitFor()
      // opening a Waiting section with no storage still works: its opened state is kept for this page only
      await page.getByRole('region', { name: 'Scheduled' }).getByRole('button', { name: 'Scheduled' }).click()
      await page.getByRole('region', { name: 'Scheduled' }).getByText('Starts', { exact: false }).first().waitFor()
    } finally {
      await page.close()
    }
  })
  test('the Priority column lists the spaces in order; an arrow swaps two numbers by keyboard, and re-orders the list', async () => {
    const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      await set('space.priority', '1', 'p:vm-str:herdr-projects')
      await set('space.priority', '2', 'p:vm-str:gtm')
      const table = page.getByRole('table', { name: 'Spaces' })
      await table.scrollIntoViewIfNeeded()
      await table.getByRole('button', { name: /^herdr-projects · Priority: 1/ }).waitFor()
      await table.getByRole('button', { name: /^gtm · Priority: 2/ }).waitFor()
      const labels = await rowLabels(table)
      expect(labels.indexOf('herdr-projects')).toBeLessThan(labels.indexOf('gtm'))
      // keyboard: Tab to gtm's ↑ and press Enter. The two numbered spaces swap their numbers, so Priority: 1 proves the write
      const up = table.getByRole('button', { name: 'Move gtm up' })
      await up.focus()
      await page.keyboard.press('Enter')
      await table.getByRole('button', { name: /^gtm · Priority: 1/ }).waitFor()
      expect((await rowLabels(table)).indexOf('gtm')).toBeLessThan((await rowLabels(table)).indexOf('herdr-projects'))
      await table.getByRole('button', { name: /^herdr-projects · Priority: 2/ }).waitFor()
      // the other direction works too: gtm is first now, so its ↓ is on and swaps the two back
      await table.getByRole('button', { name: 'Move gtm down' }).click()
      await table.getByRole('button', { name: /^herdr-projects · Priority: 1/ }).waitFor()
      expect(await up.isEnabled()).toBe(true)
      expect(await table.getByRole('button', { name: 'Move herdr-projects up' }).isDisabled()).toBe(true)
      expect(await table.getByRole('button', { name: 'Move herdr-projects down' }).isEnabled()).toBe(true)
      // one line under the table says what no number means
      await page.getByText('A space with no number goes by age, after the numbered ones.').first().waitFor()
    } finally {
      await set('space.priority', null, 'p:vm-str:herdr-projects')
      await set('space.priority', null, 'p:vm-str:gtm')
      await page.close()
    }
  })
  test('the arrows keep a space with no number without one: ↑ puts it last among the numbered ones, ↓ on the last clears it', async () => {
    const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      const table = page.getByRole('table', { name: 'Spaces' })
      await table.scrollIntoViewIfNeeded()
      // nothing is numbered yet: ↑ gives it the first place, in one write; ↓ has nothing to go below
      expect(await table.getByRole('button', { name: 'Move gtm down' }).isDisabled()).toBe(true)
      // ↑ on a space with no number puts it last among the numbered ones: one value written, the other space keeps none
      await table.getByRole('button', { name: 'Move gtm up' }).click()
      await table.getByRole('button', { name: /^gtm · Priority: 1/ }).waitFor()
      expect(await places()).toEqual({ gtm: '1', 'herdr-projects': 'off' })
      expect(await table.getByRole('button', { name: 'Move gtm up' }).isDisabled()).toBe(true)
      // the second one goes after it, and only its own value changes
      await table.getByRole('button', { name: 'Move herdr-projects up' }).click()
      await table.getByRole('button', { name: /^herdr-projects · Priority: 2/ }).waitFor()
      expect(await places()).toEqual({ gtm: '1', 'herdr-projects': '2' })
      // ↓ on the last numbered space clears its number: it goes back to by age, and the other keeps its own
      await table.getByRole('button', { name: 'Move herdr-projects down' }).click()
      await table.getByRole('button', { name: /^herdr-projects · Priority: Off/ }).waitFor()
      expect(await places()).toEqual({ gtm: '1', 'herdr-projects': 'off' })
      expect(await table.getByRole('button', { name: 'Move herdr-projects down' }).isDisabled()).toBe(true)
    } finally {
      await set('space.priority', null, 'p:vm-str:herdr-projects')
      await set('space.priority', null, 'p:vm-str:gtm')
      await page.close()
    }
  })
  test("two quick taps cannot take each other's place: the arrows are off while a move is written, and the second is dropped", async () => {
    const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      await set('space.priority', '1', 'p:vm-str:gtm')
      const table = page.getByRole('table', { name: 'Spaces' })
      await table.scrollIntoViewIfNeeded()
      await table.getByRole('button', { name: /^gtm · Priority: 1/ }).waitFor()
      const up = table.getByRole('button', { name: 'Move herdr-projects up' })
      // two taps in the same tick, as a quick double tap sends them: the first writes hp=2, the second would swap both
      // back if it went through
      await up.evaluate((el) => {
        ;(el as HTMLElement).click()
        ;(el as HTMLElement).click()
      })
      await table.getByRole('button', { name: /^herdr-projects · Priority: 2/ }).waitFor()
      await settled(page)
      expect(await places()).toEqual({ gtm: '1', 'herdr-projects': '2' })
      expect(await rowLabels(table).then((l) => l.indexOf('gtm'))).toBeLessThan(await rowLabels(table).then((l) => l.indexOf('herdr-projects')))
    } finally {
      await set('space.priority', null, 'p:vm-str:herdr-projects')
      await set('space.priority', null, 'p:vm-str:gtm')
      await page.close()
    }
  })
  test('two spaces with the same number: an arrow still moves its row one place, and the numbered ones are given 1, 2, 3, …', async () => {
    const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
    // biome-ignore lint/style/noNonNullAssertion: the describe skips every test of this file when no browser opened
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      // both spaces say 1, so the list keeps its own listing order: herdr-projects is below gtm with the same number
      await set('space.priority', '1', 'p:vm-str:gtm')
      await set('space.priority', '1', 'p:vm-str:herdr-projects')
      const table = page.getByRole('table', { name: 'Spaces' })
      await table.scrollIntoViewIfNeeded()
      await table.getByRole('button', { name: /^herdr-projects · Priority: 1/ }).waitFor()
      expect(at(await rowLabels(table), 'gtm')).toBeLessThan(at(await rowLabels(table), 'herdr-projects'))
      // ↑ on the second one is on, as it is on any row with rows above it: equal numbers are no order at all (the two go
      // by age), so the numbered ones get 1, 2, 3, … in the order the move makes, writing only what changes
      await table.getByRole('button', { name: 'Move herdr-projects up' }).click()
      await table.getByRole('button', { name: /^herdr-projects · Priority: 1/ }).waitFor()
      await settled(page)
      expect(await places()).toEqual({ gtm: '2', 'herdr-projects': '1' })
      expect(at(await rowLabels(table), 'herdr-projects')).toBeLessThan(at(await rowLabels(table), 'gtm'))
      // and the row it passed went exactly one place: one move, one place
      expect(at(await rowLabels(table), 'herdr-projects') + 1).toBe(at(await rowLabels(table), 'gtm'))
    } finally {
      await set('space.priority', null, 'p:vm-str:gtm')
      await set('space.priority', null, 'p:vm-str:herdr-projects')
      await page.close()
    }
  })
  test('a tie between other spaces: one arrow still moves its row one place, never past the numbers between them', async () => {
    const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
    // biome-ignore lint/style/noNonNullAssertion: the describe skips every test of this file when no browser opened
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    // a third space of this machine, so a tie can sit between two rows rather than at the moved row's own number
    world.places.push({ id: 'p:vm-str:notes', name: 'notes', machine: 'vm-str', level: 2, status: 'need', mode: 'regular', chat: 'p:vm-str:notes', githubRemote: false })
    world.emit('snapshot')
    try {
      await openLimits(page)
      await set('space.priority', '1', 'p:vm-str:gtm')
      await set('space.priority', '3', 'p:vm-str:herdr-projects')
      await set('space.priority', '3', 'p:vm-str:notes')
      const table = page.getByRole('table', { name: 'Spaces' })
      await table.scrollIntoViewIfNeeded()
      await table.getByRole('button', { name: /^notes · Priority: 3/ }).waitFor()
      const labels = await rowLabels(table)
      expect(at(labels, 'gtm')).toBeLessThan(at(labels, 'herdr-projects'))
      // gtm's own number is not shared, but the two below it share one: a swap with herdr-projects would leave gtm at 3
      // too, tied with notes and listed after it, two rows down. One move, one place
      await table.getByRole('button', { name: 'Move gtm down' }).click()
      await table.getByRole('button', { name: /^gtm · Priority: 2/ }).waitFor()
      await settled(page)
      expect(await places()).toEqual({ gtm: '2', 'herdr-projects': '1', notes: '3' })
      expect(at(await rowLabels(table), 'gtm')).toBe(1)
    } finally {
      await set('space.priority', null, 'p:vm-str:gtm')
      await set('space.priority', null, 'p:vm-str:herdr-projects')
      await set('space.priority', null, 'p:vm-str:notes')
      world.places.splice(
        world.places.findIndex((x) => x.name === 'notes'),
        1,
      )
      world.emit('snapshot')
      await page.close()
    }
  })
  test('a stored number Settings reads as no place is no place in the page either: ↑ gives that space a place, it swaps nothing', async () => {
    const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
    // biome-ignore lint/style/noNonNullAssertion: the describe skips every test of this file when no browser opened
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    // a settings.json the human edited by hand: 201 is outside the range Settings keeps, so spacePriority reads no place
    const raw = world.stores['vm-str'] as unknown as { d: { spaces: Record<string, Record<string, string>> } }
    try {
      await openLimits(page)
      await set('space.priority', '1', 'p:vm-str:gtm')
      raw.d.spaces['herdr-projects'] = { 'space.priority': '201' }
      // a write of a setting sends a snapshot, so the page reads the view with it
      await set('space.maxTasks', '2', 'p:vm-str:gtm')
      const table = page.getByRole('table', { name: 'Spaces' })
      await table.scrollIntoViewIfNeeded()
      await table.getByRole('button', { name: /^gtm · Priority: 1/ }).waitFor()
      // the page treats it as a space with no number: ↑ puts it last among the numbered ones instead of swapping with gtm
      await table.getByRole('button', { name: 'Move herdr-projects up' }).click()
      await table.getByRole('button', { name: /^herdr-projects · Priority: 2/ }).waitFor()
      expect(await places()).toEqual({ gtm: '1', 'herdr-projects': '2' })
    } finally {
      delete raw.d.spaces['herdr-projects']
      await set('space.priority', null, 'p:vm-str:gtm')
      await set('space.priority', null, 'p:vm-str:herdr-projects')
      await page.close()
    }
  })
  test('a read that fails says why under the table, and the arrows wait for a read that lands', async () => {
    const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
    // biome-ignore lint/style/noNonNullAssertion: the describe skips every test of this file when no browser opened
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    // the page's own reads, refused while the test says so: the screen's error path, which a live server cannot be made
    // to take from this table
    let fails = false
    await page.route('**/api/action', (route) => {
      const a = route.request().postDataJSON() as { type?: string }
      return fails && a.type === 'limits-view' ? route.abort() : route.continue()
    })
    try {
      await openLimits(page)
      await set('space.priority', '1', 'p:vm-str:gtm')
      const table = page.getByRole('table', { name: 'Spaces' })
      await table.scrollIntoViewIfNeeded()
      const up = table.getByRole('button', { name: 'Move herdr-projects up' })
      await table.getByRole('button', { name: /^gtm · Priority: 1/ }).waitFor()
      await up.waitFor()
      await expect(up.isEnabled()).resolves.toBe(true)
      // the move is written, and the read that follows it fails: the table says so, and its rows are the ones before the
      // write, so the arrows stay off (a move from them would be worked out on numbers that are no longer true)
      fails = true
      await up.click()
      await page.getByRole('alert').filter({ hasText: 'Failed to fetch' }).waitFor()
      expect(await places()).toEqual({ gtm: '1', 'herdr-projects': '2' })
      expect(await up.isDisabled()).toBe(true)
      // a read that lands brings the rows and the arrows back, and the word with them
      fails = false
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      await table.getByRole('button', { name: /^herdr-projects · Priority: 2/ }).waitFor()
      await until(
        () => up.isEnabled(),
        (on) => on,
        10_000,
      )
      expect(await page.getByRole('alert').filter({ hasText: 'Failed to fetch' }).count()).toBe(0)
    } finally {
      await set('space.priority', null, 'p:vm-str:gtm')
      await set('space.priority', null, 'p:vm-str:herdr-projects')
      await page.close()
    }
  })
  test('a move the server refuses says why under the table, and writes nothing', async () => {
    const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    // the demo's own answer for one move: the screen's error path, which a real refusal (the home space, another machine)
    // cannot reach from this machine's table
    const real = world.act.bind(world)
    let asked = 0
    ;(world as unknown as { act: (a: unknown) => Promise<unknown> }).act = async (a: unknown) => {
      if ((a as { type?: string }).type !== 'space-order') return real(a as never)
      asked++
      return { ok: false, error: 'That space cannot move: it is not on this machine.' }
    }
    try {
      await openLimits(page)
      const table = page.getByRole('table', { name: 'Spaces' })
      await table.scrollIntoViewIfNeeded()
      await table.getByRole('button', { name: 'Move gtm up' }).click()
      const refused = page.getByRole('alert').filter({ hasText: 'That space cannot move: it is not on this machine.' })
      await refused.waitFor()
      expect(asked).toBe(1)
      expect(await places()).toEqual({ gtm: 'off', 'herdr-projects': 'off' })
      // the arrows come back on once it has answered
      expect(await table.getByRole('button', { name: 'Move gtm up' }).isEnabled()).toBe(true)
    } finally {
      ;(world as unknown as { act: (a: unknown) => Promise<unknown> }).act = real as never
      await set('space.priority', null, 'p:vm-str:gtm')
      await set('space.priority', null, 'p:vm-str:herdr-projects')
      await page.close()
    }
  })
  test('the Providers and the Machine tables fit the Settings width at 1440 px: no horizontal scroll, their columns in view', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openLimits(page)
      for (const name of ['Providers and models', 'Machine limits']) {
        const table = page.getByRole('table', { name, exact: true })
        await table.waitFor()
        // the table's own box is its scroll box's width, and the box never scrolls sideways
        const fit = await table.evaluate((t) => {
          const box = t.parentElement!
          return { scroll: box.scrollWidth - box.clientWidth, width: t.getBoundingClientRect().width - box.clientWidth }
        })
        expect(fit.scroll).toBe(0)
        expect(fit.width).toBeLessThanOrEqual(1)
      }
    } finally {
      await page.close()
    }
  })
})

/** the page's own reads of the view, held at its fetch until the test lets them through (an answer the test decides when
 *  to land: SHE-165's move stamp is about which read came back when) */
async function holdViews(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { viewGate: boolean; held: (() => void)[] }
    w.viewGate = false
    w.held = []
    const send = window.fetch
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const back = send(input, init)
      if (!w.viewGate || !(typeof init?.body === 'string' && init.body.includes('"limits-view"'))) return back
      return new Promise((res, rej) => w.held.push(() => back.then(res, rej)))
    }) as typeof window.fetch
  })
}
const gateViews = (page: Page, on: boolean) => page.evaluate((v) => void ((window as unknown as { viewGate: boolean }).viewGate = v), on)
const heldViews = (page: Page) => page.evaluate(() => (window as unknown as { held: (() => void)[] }).held.length)
const letViewsGo = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { held: (() => void)[] }
    const list = w.held
    w.held = []
    for (const go of list) go()
  })

/** the write of a move, held at its fetch until the test lets it go, as a slow server would (the read of it is held by
 *  holdViews' own gate, so a test can decide which answer lands first) */
async function holdMoves(page: Page) {
  const w = { release: undefined as undefined | (() => void), asked: 0 }
  await page.route('**/api/action', async (route) => {
    const a = route.request().postDataJSON() as { type?: string }
    if (a.type !== 'space-order') return route.continue()
    w.asked++
    await new Promise<void>((go) => (w.release = go))
    return route.continue()
  })
  return w
}

describe.skipIf(!browser)('Settings → Limits: a move waits for an answer the write could not have overtaken (SHE-165)', () => {
  test('the arrows come back with the rows the move made, not with an answer sent before it', async () => {
    const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await holdViews(page)
      await openLimits(page)
      await set('space.priority', '1', 'p:vm-str:gtm')
      await set('space.priority', '2', 'p:vm-str:herdr-projects')
      const table = page.getByRole('table', { name: 'Spaces' })
      await table.scrollIntoViewIfNeeded()
      await table.getByRole('button', { name: /^herdr-projects · Priority: 2/ }).waitFor()
      // a change asks the page for a read, and the page's fetch is held: the answer is out when the move is written
      await gateViews(page, true)
      world.emit('snapshot')
      await until(
        () => heldViews(page),
        (n) => n >= 1,
        10_000,
      )
      await table.getByRole('button', { name: 'Move herdr-projects up' }).click()
      await letViewsGo(page)
      // that answer was sent before the write, so the page asks again, and the arrows stay off until that one lands
      await until(
        () => heldViews(page),
        (n) => n >= 1,
        10_000,
      )
      expect(await table.getByRole('button', { name: 'Move herdr-projects down' }).isDisabled()).toBe(true)
      // the one the write asked for: the arrows come back with the rows the move made, never with the ones before it
      await letViewsGo(page)
      await table.getByRole('button', { name: /^herdr-projects · Priority: 1/ }).waitFor({ timeout: 5_000 })
      await table.getByRole('button', { name: /^gtm · Priority: 2/ }).waitFor()
      expect(await table.getByRole('button', { name: 'Move gtm up' }).isEnabled()).toBe(true)
      expect(await table.getByRole('button', { name: 'Move herdr-projects down' }).isEnabled()).toBe(true)
    } finally {
      await gateViews(page, false)
      await set('space.priority', null, 'p:vm-str:gtm')
      await set('space.priority', null, 'p:vm-str:herdr-projects')
      await page.close()
    }
  })
  test('the arrows stay off while the write is out, though a read sent before it lands meanwhile', async () => {
    const set = (key: string, value: string | null, place: string) => world.act({ type: 'setting', key, value, place } as never)
    // biome-ignore lint/style/noNonNullAssertion: the describe skips every test of this file when no browser opened
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await holdViews(page)
      const write = await holdMoves(page)
      await openLimits(page)
      await set('space.priority', '1', 'p:vm-str:gtm')
      await set('space.priority', '2', 'p:vm-str:herdr-projects')
      const table = page.getByRole('table', { name: 'Spaces' })
      await table.scrollIntoViewIfNeeded()
      await table.getByRole('button', { name: /^herdr-projects · Priority: 2/ }).waitFor()
      // a read is out, and the move is written while it is: its rows are the ones before the move, so its answer is no
      // reason to let a second tap through
      await gateViews(page, true)
      world.emit('snapshot')
      await until(
        () => heldViews(page),
        (n) => n >= 1,
        10_000,
      )
      await table.getByRole('button', { name: 'Move herdr-projects up' }).click()
      await until(
        async () => write.asked,
        (n) => n >= 1,
        10_000,
      )
      // that read lands while the write is still out: every arrow is off, as the answer says nothing of the move
      await letViewsGo(page)
      await settled(page)
      expect(await table.getByRole('button', { name: 'Move gtm up' }).isDisabled()).toBe(true)
      expect(await table.getByRole('button', { name: 'Move herdr-projects down' }).isDisabled()).toBe(true)
      // the write answers, the page reads the rows it made, and the arrows come back
      await gateViews(page, false)
      write.release?.()
      await table.getByRole('button', { name: /^herdr-projects · Priority: 1/ }).waitFor({ timeout: 10_000 })
      await until(
        () => table.getByRole('button', { name: 'Move gtm up' }).isEnabled(),
        (on) => on,
        10_000,
      )
    } finally {
      await gateViews(page, false)
      await set('space.priority', null, 'p:vm-str:gtm')
      await set('space.priority', null, 'p:vm-str:herdr-projects')
      await page.close()
    }
  })
})
