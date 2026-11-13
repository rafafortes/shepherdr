// Settings → Models: every level's agent settings in one table. Its rows and columns, a cell that is strong where its row
// sets it and faint where it inherits, the popover that writes at the row's level (and asks about the waiting tasks), the
// "+" that adds a backup, the bulk actions (every space, or Everywhere with the spaces reset; copy a space's models), the
// plain columns, and the phone's cards.
import { describe, expect, test } from 'bun:test'
import type { Locator, Page } from 'playwright-core'
import { layout, settled } from './layout.ts'

const { browser, world, url } = await layout()

/** the Models page on a desktop, opened from Settings */
async function openModels(page: Page) {
  await page.goto(url())
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Models', exact: true }).click()
  await settled(page)
  return settings
}
/** the cell button of a row's slot, by its accessible name ("gtm · Tasks · Primary: Codex · high") */
const cell = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first()
/** the open popover (a desktop's cell editor, or a phone's inline one) */
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit this setting' })
/** the question about the waiting tasks, when it is asked */
const askedWaiting = (page: Page) => page.getByRole('alertdialog')
/** until what it checks holds (a write goes through the server, a moment after the key is pressed) */
async function waitFor(ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await Bun.sleep(50)
  expect(ok()).toBe(true)
}
/** the question about the waiting tasks, which the change just made asks: Only new tasks (it is asked once the change is
 *  through, so it is waited for), and it closes */
async function answerOnlyNew(page: Page) {
  const ask = askedWaiting(page)
  await ask.getByRole('button', { name: 'Only new tasks', exact: true }).click()
  await ask.waitFor({ state: 'detached' })
}
/** the store of this machine (vm-str) and its spaces' keys */
const vm = () => world.stores['vm-str']
/** a key as one level reads it (its value, and where it comes from) */
const pick = (key: string, space?: string) => vm().pick(key, space ? { space } : 'all')

/** the demo's Settings and tasks back as this file found them */
async function reset() {
  const store = world.stores['vm-str']
  const chain = ['reviewer.fallback', 'reviewer.fallback2', 'reviewer.fallback3', 'reviewer.fallback4', 'reviewer.fallback5']
  for (const space of ['gtm', 'herdr-projects']) {
    for (const k of ['task.agent', 'task.model', 'task.effort', 'space.maxTasks', 'merge.train', 'task.fallback2', 'task.fallback2Model', 'task.fallback2Effort', ...chain]) store.set(k, null, { space })
  }
  for (const k of ['task.agent', 'task.model', 'task.effort', 'task.fallback2', 'task.fallback2Model', 'task.fallback2Effort', 'space.maxTasks', ...chain]) store.set(k, null, 'all')
  // the demo's own: gtm runs Codex
  store.set('task.agent', 'Codex', { space: 'gtm' })
  world.sections = (await import('../server/demo/data.ts')).settings(world.stores)
  world.emit('snapshot')
}

describe.skipIf(!browser)('Settings → Models on a desktop', () => {
  test('the table lists Everywhere, this machine and each space; the role columns, then Max tasks and Merge train', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const settings = await openModels(page)
      expect(await settings.getByRole('heading', { name: 'Models', exact: true }).count()).toBeGreaterThan(0)
      const table = settings.getByRole('table', { name: 'Models by level', exact: true })
      expect(await table.locator('tbody th[scope="row"] span.truncate').allTextContents()).toEqual(['Everywhere', 'vm-str', 'gtm', 'herdr-projects'])
      expect(await table.locator('thead th[scope="colgroup"]').allTextContents()).toEqual(['Tasks', 'Coordinators', 'Reviewer', 'Advisor'])
      // each role's columns: Primary, Backup 1 and the "+" that adds the next, then the two plain columns
      expect(await table.locator('thead tr').nth(1).locator('th').allTextContents()).toEqual(['Primary', 'Backup 1', '+', 'Primary', 'Backup 1', '+', 'Primary', 'Backup 1', '+', 'Primary', 'Backup 1', '+'])
      expect(await table.locator('thead tr').nth(0).locator('th').allTextContents()).toEqual(['Level', 'Tasks', 'Coordinators', 'Reviewer', 'Advisor', 'Max tasks', 'Merge train'])
      // a value the row sets is strong; one it inherits is faint, its words and where it comes from
      const gtm = await cell(page, 'gtm · Tasks · Primary').evaluate((el) => getComputedStyle(el).fontWeight)
      const herdr = await cell(page, 'herdr-projects · Tasks · Primary').evaluate((el) => getComputedStyle(el).fontWeight)
      expect([gtm, herdr]).toEqual(['500', '400'])
      expect(await cell(page, 'gtm · Tasks · Primary').textContent()).toBe('Codex · high')
      expect(await cell(page, 'herdr-projects · Tasks · Primary').textContent()).toBe('Claude Code · high')
      // the inherited CLI names its source under it
      const inherited = await table.locator('tbody tr').nth(3).locator('td').first().textContent()
      expect(inherited).toContain('default')
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440)
    } finally {
      await page.close()
    }
  })

  test('a cell opens a popover with its CLI, model and effort; a change writes it at the row level, and Reset to inherited takes it back', async () => {
    await reset()
    const everywhere = pick('task.agent').value
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      await cell(page, 'gtm · Tasks · Primary').click()
      const pop = editor(page)
      await pop.waitFor()
      expect(await pop.textContent()).toContain('gtm · Tasks · Primary')
      // the three controls of a slot: Agent, Model and Effort, with the reset (the row sets the CLI)
      await pop.getByRole('button', { name: 'Agent: Codex', exact: true }).click()
      await page.getByRole('menuitemradio', { name: 'Pi', exact: true }).click()
      await pop.getByRole('button', { name: 'Agent: Pi', exact: true }).waitFor()
      // written at gtm's own level, not Everywhere's
      expect(vm().get('task.agent', 'gtm')).toBe('pi')
      expect(pick('task.agent').value).toBe(everywhere)
      // the question about the waiting tasks closes the popover too (a click outside it): the cell opens it again
      await answerOnlyNew(page)
      await cell(page, 'gtm · Tasks · Primary').click()
      await pop.waitFor()
      // Reset to inherited: back to what Everywhere gives, and gtm no longer sets it
      await pop.getByRole('button', { name: 'Reset to inherited', exact: true }).click()
      await pop.getByRole('button', { name: `Agent: ${everywhere}`, exact: true }).waitFor()
      expect(vm().pick('task.agent', { space: 'gtm' }).from).not.toBe('space')
      expect(vm().get('task.agent', 'gtm')).toBe(everywhere)
      // back on what the waiting task runs on (Claude Code): no change, so no question
      await page.keyboard.press('Escape')
      await pop.waitFor({ state: 'detached' })
    } finally {
      await reset()
      await page.close()
    }
  })

  test('a task agent changed in a space asks about the waiting tasks once: Apply moves them; a model after it is written at the space', async () => {
    await reset()
    const tasks = structuredClone(world.tasks)
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      await cell(page, 'herdr-projects · Tasks · Primary').click()
      const pop = editor(page)
      await pop.getByRole('button', { name: 'Agent: Claude Code', exact: true }).click()
      await page.getByRole('menuitemradio', { name: 'Pi', exact: true }).click()
      const ask = askedWaiting(page)
      await ask.waitFor()
      const text = (await ask.textContent()) ?? ''
      expect(text).toContain('2 waiting tasks of herdr-projects (queued, To do, scheduled) start on pi (high) when their turn comes.')
      expect(text).toContain('Running tasks keep their agent.')
      await ask.getByRole('button', { name: 'Apply to 2 tasks', exact: true }).click()
      await ask.getByText('Applied to 2 waiting tasks.').waitFor()
      await ask.getByRole('button', { name: 'Done', exact: true }).click()
      await ask.waitFor({ state: 'detached' })
      expect(world.tasks.filter((t) => ['HP-203', 'HP-204'].includes(t.id)).map((t) => t.agent?.cli)).toEqual(['pi', 'pi'])
      // the model of the same row is a change too (its own question, not a second one for the same tasks)
      // pi lists no models until it is asked, so its model is a box: any id goes
      const model = pop.getByRole('textbox', { name: 'Model', exact: true })
      await model.fill('opencode-go/deepseek-v4.1-flash')
      await model.press('Enter')
      await waitFor(() => vm().get('task.model', 'herdr-projects') === 'opencode-go/deepseek-v4.1-flash')
      // the demo compares a waiting task's CLI only, so a model alone asks nothing here (a live machine asks, by the model too)
      expect(await askedWaiting(page).count()).toBe(0)
    } finally {
      world.tasks = tasks
      await reset()
      await page.close()
    }
  })

  test('a CLI change takes a model the new CLI lacks back to default; an effort change is written at the row', async () => {
    await reset()
    vm().set('task.agent', 'Claude Code', { space: 'gtm' })
    vm().set('task.model', 'Opus 5.5', { space: 'gtm' })
    world.sections = (await import('../server/demo/data.ts')).settings(world.stores)
    world.emit('snapshot')
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      await cell(page, 'gtm · Tasks · Primary').click()
      const pop = editor(page)
      await pop.getByRole('button', { name: 'Agent: Claude Code', exact: true }).click()
      await page.getByRole('menuitemradio', { name: 'Codex', exact: true }).click()
      // Opus 5.5 is no Codex model: the model goes back to default with the CLI, in the same change
      await waitFor(() => vm().get('task.model', 'gtm') === 'default')
      expect(vm().get('task.agent', 'gtm')).toBe('Codex')
      await answerOnlyNew(page)
      // the effort it inherits from this machine is high
      await pop.getByRole('button', { name: 'Effort: High', exact: true }).click()
      await page.getByRole('menuitemradio', { name: 'Low', exact: true }).click()
      await waitFor(() => vm().get('task.effort', 'gtm') === 'low')
      await answerOnlyNew(page)
    } finally {
      await reset()
      await page.close()
    }
  })

  test('a value refused is said in its popover, and nothing is written', async () => {
    await reset()
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      await cell(page, 'gtm · Max tasks').click()
      const box = editor(page).getByRole('textbox', { name: 'Max tasks' })
      await box.fill('500')
      await box.press('Enter')
      await editor(page).getByRole('status').filter({ hasText: 'Write a number from 1 to 200' }).waitFor()
      expect(vm().pick('space.maxTasks', { space: 'gtm' }).from).not.toBe('space')
      await page.keyboard.press('Escape')
    } finally {
      await reset()
      await page.close()
    }
  })

  test('a column whose backups are full: the row that is full shows a dash, and the column goes once every row is full', async () => {
    await reset()
    const store = world.stores['vm-str']
    for (const k of ['reviewer.fallback', 'reviewer.fallback2', 'reviewer.fallback3', 'reviewer.fallback4']) store.set(k, 'Codex', 'all')
    store.set('reviewer.fallback5', 'Codex', { space: 'gtm' })
    world.sections = (await import('../server/demo/data.ts')).settings(world.stores)
    world.emit('snapshot')
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const settings = await openModels(page)
      const table = settings.getByRole('table', { name: 'Models by level', exact: true })
      // gtm has all five backups: its "+" is a dash; the others still have one to add
      expect(await table.locator('tbody tr').nth(2).locator('td').filter({ hasText: '—' }).count()).toBe(1)
      expect(await page.getByRole('button', { name: 'Add Backup 5 to herdr-projects' }).count()).toBe(1)
      // every row full: the column goes
      store.set('reviewer.fallback5', 'Codex', 'all')
      world.sections = (await import('../server/demo/data.ts')).settings(world.stores)
      world.emit('snapshot')
      await page.getByRole('button', { name: 'Add Backup 5 to herdr-projects' }).waitFor({ state: 'detached' })
      expect(await table.locator('thead tr').nth(1).locator('th', { hasText: '+' }).count()).toBe(3)
    } finally {
      await reset()
      await page.close()
    }
  })

  test('a bulk set that is refused stays open and says why, in every space it failed in', async () => {
    await reset()
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const settings = await openModels(page)
      await settings.getByRole('button', { name: 'More for Tasks · Primary' }).click()
      await page.getByRole('menuitem', { name: 'Set for every space…', exact: true }).click()
      const dlg = page.getByRole('alertdialog', { name: 'Set Tasks · Primary for every space' })
      await dlg.getByRole('button', { name: 'Agent: Claude Code', exact: true }).click()
      await page.getByRole('menuitemradio', { name: 'Pi', exact: true }).click()
      // pi lists no models: the model is a box, and a model id can't carry a "!"
      const model = dlg.getByRole('textbox', { name: 'Model', exact: true })
      await model.fill('bad!')
      await model.press('Enter')
      await dlg.getByRole('button', { name: 'Set for 2 spaces', exact: true }).click()
      await dlg.getByRole('status').filter({ hasText: 'Write a model id' }).waitFor()
      expect(await dlg.textContent()).toContain('gtm: Write a model id')
      expect(await dlg.textContent()).toContain('herdr-projects: Write a model id')
      expect(vm().pick('task.model', { space: 'gtm' }).from).not.toBe('space')
      // Cancel closes it; the question about the one change that went through follows it
      await dlg.getByRole('button', { name: 'Cancel', exact: true }).click()
      await dlg.waitFor({ state: 'detached' })
      await answerOnlyNew(page)
    } finally {
      await reset()
      await page.close()
    }
  })

  test('the "+" adds the next backup of a row on the CLI of the one before it; the popover then edits it', async () => {
    await reset()
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      // Everywhere has Backup 1 (Codex by default): its "+" is Backup 2, on Codex too
      await page.getByRole('button', { name: 'Add Backup 2 to Everywhere' }).click()
      await editor(page).getByRole('button', { name: 'Backup: Codex', exact: true }).waitFor()
      expect(pick('task.fallback2').value).toBe('Codex')
      // its column is there now, and the "+" moves on to Backup 3
      expect(await page.getByRole('table', { name: 'Models by level', exact: true }).locator('thead th', { hasText: 'Backup 2' }).count()).toBe(1)
      expect(await page.getByRole('button', { name: 'Add Backup 3 to Everywhere' }).count()).toBe(1)
      await page.keyboard.press('Escape')
      await editor(page).waitFor({ state: 'detached' })
    } finally {
      await reset()
      await page.close()
    }
  })

  test('Set for every space, each space\'s own: written at each space; Everywhere and reset: the spaces and this machine lose their own', async () => {
    await reset()
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const settings = await openModels(page)
      const dlg = page.getByRole('alertdialog', { name: 'Set Tasks · Primary for every space' })
      await settings.getByRole('button', { name: 'More for Tasks · Primary' }).click()
      await page.getByRole('menuitem', { name: 'Set for every space…', exact: true }).click()
      await dlg.waitFor()
      await dlg.getByRole('button', { name: 'Agent: Claude Code', exact: true }).click()
      await page.getByRole('menuitemradio', { name: 'Codex', exact: true }).click()
      await dlg.getByRole('button', { name: 'Set for 2 spaces', exact: true }).click()
      // the dialog closes once written; the waiting tasks are asked about after it
      await dlg.waitFor({ state: 'detached' })
      expect(vm().pick('task.agent', { space: 'gtm' })).toEqual({ value: 'Codex', from: 'space' })
      expect(vm().pick('task.agent', { space: 'herdr-projects' })).toEqual({ value: 'Codex', from: 'space' })
      expect(pick('task.agent').from).toBe('default')
      await askedWaiting(page).getByRole('button', { name: 'Only new tasks', exact: true }).click()
      await askedWaiting(page).waitFor({ state: 'detached' })

      // again, Everywhere and reset: Pi for every space, the spaces' own values reset
      await settings.getByRole('button', { name: 'More for Tasks · Primary' }).click()
      await page.getByRole('menuitem', { name: 'Set for every space…', exact: true }).click()
      const again = page.getByRole('alertdialog', { name: 'Set Tasks · Primary for every space' })
      await again.getByRole('radio', { name: /Everywhere, and reset the spaces/ }).check()
      await again.getByRole('button', { name: 'Agent: Claude Code', exact: true }).click()
      await page.getByRole('menuitemradio', { name: 'Pi', exact: true }).click()
      await again.getByRole('button', { name: 'Set for 2 spaces', exact: true }).click()
      await again.waitFor({ state: 'detached' })
      expect(pick('task.agent').value).toBe('pi')
      expect(vm().pick('task.agent', { space: 'gtm' }).from).not.toBe('space')
      expect(vm().pick('task.agent', { space: 'herdr-projects' }).from).not.toBe('space')
      await askedWaiting(page).getByRole('button', { name: 'Only new tasks', exact: true }).click()
    } finally {
      await reset()
      await page.close()
    }
  })

  test("Copy this space's models to…: the chosen spaces get its values, each slot of every role", async () => {
    await reset()
    vm().set('task.agent', 'pi', { space: 'gtm' })
    vm().set('task.effort', 'low', { space: 'gtm' })
    world.sections = (await import('../server/demo/data.ts')).settings(world.stores)
    world.emit('snapshot')
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      const settings = await openModels(page)
      await settings.getByRole('button', { name: 'More for gtm' }).click()
      await page.getByRole('menuitem', { name: "Copy this space's models to…", exact: true }).click()
      const dlg = page.getByRole('alertdialog', { name: "Copy gtm's models to…" })
      await dlg.waitFor()
      expect(await dlg.getByRole('checkbox', { name: 'herdr-projects' }).isChecked()).toBe(true)
      await dlg.getByRole('button', { name: 'Copy to 1 space', exact: true }).click()
      await dlg.waitFor({ state: 'detached' })
      expect(vm().pick('task.agent', { space: 'herdr-projects' })).toEqual({ value: 'pi', from: 'space' })
      expect(vm().get('task.effort', 'herdr-projects')).toBe('low')
      await askedWaiting(page).getByRole('button', { name: 'Only new tasks', exact: true }).click()
    } finally {
      await reset()
      await page.close()
    }
  })

  test('the plain columns: a space sets its Max tasks in its popover, a number', async () => {
    await reset()
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      await cell(page, 'gtm · Max tasks').click()
      const pop = editor(page)
      await pop.waitFor()
      const box = pop.getByRole('textbox', { name: 'Max tasks' })
      await box.fill('4')
      await box.press('Enter')
      await waitFor(() => vm().pick('space.maxTasks', { space: 'gtm' }).value === '4')
      expect(vm().pick('space.maxTasks', { space: 'gtm' })).toEqual({ value: '4', from: 'space' })
      await page.keyboard.press('Escape')
    } finally {
      await reset()
      await page.close()
    }
  })
})

describe.skipIf(!browser)('Settings → Models on a phone', () => {
  test('one card per level, its roles and their primary and backups; a line opens its editor under it; nothing wider than the screen', async () => {
    await reset()
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Places', exact: true }).click()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Models', exact: true }).tap()
      await settled(page)
      // one card per level: the page's own section and the cards are told apart by their rows' headings
      const cards = page.locator('section[aria-label]:has(> div > h3)')
      expect(await cards.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(['Everywhere', 'vm-str', 'gtm', 'herdr-projects'])
      const gtm = page.locator('section[aria-label="gtm"]')
      expect(await gtm.getByRole('heading', { level: 4 }).allTextContents()).toEqual(['Tasks', 'Coordinators', 'Reviewer', 'Advisor'])
      // a line reads its label and its words (its text has no space between them): gtm's Primary runs Codex
      const primary = gtm.getByRole('button', { name: /^Primary\s*Codex/ }).first()
      await primary.tap()
      // a phone's editor opens under its line, in the card
      await gtm.getByRole('button', { name: 'Agent: Codex', exact: true }).tap()
      await page.getByRole('menuitemradio', { name: 'Pi', exact: true }).tap()
      await gtm.getByRole('button', { name: 'Agent: Pi', exact: true }).waitFor()
      expect(vm().get('task.agent', 'gtm')).toBe('pi')
      if (await askedWaiting(page).count()) await askedWaiting(page).getByRole('button', { name: 'Only new tasks', exact: true }).tap()
      // a space's card copies to another space, from its own ⋯
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    } finally {
      await reset()
      await page.close()
    }
  })
})
