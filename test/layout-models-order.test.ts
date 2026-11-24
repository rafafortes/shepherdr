// Settings → Models: a chain entry drags with a mouse or a held finger, and its menu moves it or inserts a new entry
// above it. Every move carries the CLI, model and effort together and writes only the row's scope.
import { describe, expect, test } from 'bun:test'
import type { Locator, Page } from 'playwright-core'
import { rolePairs } from '../server/live/settings.ts'
import { layout, settled, until } from './layout.ts'

const { browser, world, url } = await layout()
const vm = () => world.stores['vm-str']
const TASK_KEYS = rolePairs('task').flatMap((p) => [p.cli, p.model, p.effort])
const COORDINATOR_KEYS = rolePairs('coordinator').flatMap((p) => [p.cli, p.model, p.effort])
const CHAIN_KEYS = [...TASK_KEYS, ...COORDINATOR_KEYS]
const ROW = 'p:vm-str:gtm'

/** a mixed chain in gtm, with a value owned by each of the five CLIs Shepherdr supports */
async function mixed() {
  const store = vm()
  for (const level of ['all', 'machine', { space: 'gtm' }] as const) for (const key of CHAIN_KEYS) store.set(key, null, level)
  for (const [key, value] of Object.entries({
    'task.agent': 'Claude Code',
    'task.model': 'claude-opus-5-5',
    'task.effort': 'high',
    'task.fallback': 'Codex',
    'backup.model': 'gpt-6-sol',
    'backup.effort': 'xhigh',
    'task.fallback2': 'pi',
    'task.fallback2Model': 'opencode-go/deepseek-v4.1-flash',
    'task.fallback2Effort': 'medium',
    'task.fallback3': 'OpenCode',
    'task.fallback3Model': 'opencode-go/hungerg-free',
    'task.fallback4': 'Antigravity',
    'task.fallback4Model': 'gemini-4-hydrogen',
  }))
    store.set(key, value, { space: 'gtm' })
  world.sections = (await import('../server/demo/data.ts')).settings(world.stores)
  world.emit('snapshot')
}

async function reset() {
  const store = vm()
  for (const level of ['all', 'machine', { space: 'gtm' }] as const) for (const key of CHAIN_KEYS) store.set(key, null, level)
  store.set('task.agent', 'Codex', { space: 'gtm' })
  world.sections = (await import('../server/demo/data.ts')).settings(world.stores)
  world.emit('snapshot')
}

async function openModels(page: Page) {
  await page.goto(url())
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Models', exact: true }).click()
  await settled(page)
  return settings
}

/** the CLIs in gtm's task chain, in position order */
const order = (page: Page) =>
  page.locator(`[data-chain^="${ROW}|task."]`).evaluateAll((els) =>
    els.map((el) => {
      const cell = el.querySelector('[data-cell]')
      const spans = cell?.querySelectorAll(':scope > span')
      const words = spans && spans.length > 1 ? (spans[1]?.childNodes[0]?.textContent ?? '') : (cell?.textContent ?? '')
      return words.trim().split(' · ')[0]
    }),
  )

async function box(loc: Locator) {
  const b = await loc.boundingBox()
  if (!b) throw new Error('The chain entry is not on screen.')
  return b
}

/** a task-agent change can ask about waiting tasks; leave them for their next start */
async function onlyNew(page: Page) {
  await page.waitForTimeout(700)
  const ask = page.getByRole('alertdialog', { name: 'Apply to the tasks already created?' })
  if (await ask.count()) {
    await ask.getByRole('button', { name: 'Only new tasks', exact: true }).click()
    await ask.waitFor({ state: 'detached' })
  }
}

describe.skipIf(!browser)('reordering a model chain', () => {
  test('desktop: a mouse drags an entry across the columns; the menu moves it and inserts above on its CLI', async () => {
    if (!browser) return
    await mixed()
    const everywhere = vm().everywhere()
    const page = await browser.newPage({ viewport: { width: 1800, height: 900 } })
    try {
      await openModels(page)
      await page.locator(`[data-chain="${ROW}|task.0"]`).waitFor()
      expect(await order(page)).toEqual(['Claude Code', 'Codex', 'pi', 'OpenCode', 'Antigravity'])

      const source = page.locator(`[data-chain="${ROW}|task.4"]`)
      const target = page.locator(`[data-chain="${ROW}|task.0"]`)
      await source.scrollIntoViewIfNeeded()
      const from = await box(source)
      const to = await box(target)
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
      await page.mouse.up()
      await until(
        () => order(page),
        (xs) => xs[0] === 'Antigravity',
      )
      expect(vm().get('task.agent', 'gtm')).toBe('Antigravity')
      expect(vm().get('task.model', 'gtm')).toBe('gemini-4-hydrogen')
      expect(vm().get('task.fallback', 'gtm')).toBe('Claude Code')
      expect(vm().everywhere()).toEqual(everywhere)
      await onlyNew(page)

      await page.getByRole('button', { name: 'Chain actions for gtm · Tasks · Primary', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Move down', exact: true }).click()
      await until(
        async () => vm().get('task.agent', 'gtm'),
        (v) => v === 'Claude Code',
      )
      expect(vm().get('task.fallback', 'gtm')).toBe('Antigravity')
      await onlyNew(page)

      await page.getByRole('button', { name: 'Chain actions for gtm · Tasks · Backup 1', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Insert above', exact: true }).click()
      await page.getByRole('dialog', { name: 'Edit this setting' }).getByRole('button', { name: 'Backup: Antigravity', exact: true }).waitFor()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      const beforeEditorMove = vm().chainAt('task', { space: 'gtm' })
      const popBox = await box(pop)
      await page.mouse.move(popBox.x + popBox.width / 2, popBox.y + popBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(popBox.x + popBox.width / 2 + 30, popBox.y + popBox.height / 2)
      await page.mouse.up()
      expect(vm().chainAt('task', { space: 'gtm' })).toEqual(beforeEditorMove)
      expect(await pop.count()).toBe(1)
      expect(vm().get('task.fallback', 'gtm')).toBe('Antigravity')
      expect(vm().get('backup.model', 'gtm')).toBe('default')
      expect(vm().get('task.fallback2Model', 'gtm')).toBe('gemini-4-hydrogen')
      expect(vm().everywhere()).toEqual(everywhere)
      await onlyNew(page)
      const inserted = page.locator(`[data-cell="${ROW}|task.1"]`)
      if ((await inserted.getAttribute('aria-expanded')) === 'true') await inserted.click()

      // an off backup cannot become the reviewer's Primary: the whole move is refused and the row says why
      const reviewer = vm().get('coordinator.fallback', 'gtm')
      await page.getByRole('button', { name: 'Chain actions for gtm · Coordinators · Backup 1', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Move up', exact: true }).click()
      await page.getByRole('status').filter({ hasText: 'gtm · Coordinators:' }).waitFor()
      expect(vm().get('coordinator.fallback', 'gtm')).toBe(reviewer)

      // A default entry moved into Coordinator Backup 1 keeps its own CLI default instead of following the tasks' model.
      const store = vm()
      for (const [key, value] of Object.entries({
        'task.fallback': 'Codex',
        'backup.model': 'gpt-6-sol',
        'backup.effort': 'xhigh',
        'coordinator.agent': 'Claude Code',
        'coordinator.fallback': 'off',
        'coordinator.fallback2': 'Codex',
      }))
        store.set(key, value, { space: 'gtm' })
      world.sections = (await import('../server/demo/data.ts')).settings(world.stores)
      world.emit('snapshot')
      await page.getByRole('button', { name: 'Chain actions for gtm · Coordinators · Backup 2', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Move up', exact: true }).click()
      await until(
        async () => store.get('coordinator.fallback', 'gtm'),
        (v) => v === 'Codex',
      )
      expect(store.readAt('coordinator.fallbackModel', { space: 'gtm' }).value).toBe('default')
      expect(store.readAt('coordinator.fallbackEffort', { space: 'gtm' }).value).toBe('default')
      await until(
        async () => page.getByRole('button', { name: 'Chain actions for gtm · Coordinators · Backup 1', exact: true }).isDisabled(),
        (disabled) => !disabled,
      )
      expect(await page.getByRole('status').filter({ hasText: 'gtm · Coordinators:' }).count()).toBe(0)

      // a cancelled pointer leaves the chain where it was
      const beforeCancel = await order(page)
      const cancelCell = page.locator(`[data-chain="${ROW}|task.2"]`)
      await cancelCell.scrollIntoViewIfNeeded()
      const cancelFrom = await box(cancelCell)
      await page.mouse.move(cancelFrom.x + cancelFrom.width / 2, cancelFrom.y + cancelFrom.height / 2)
      await page.mouse.down()
      await page.mouse.move(cancelFrom.x + cancelFrom.width / 2 + 30, cancelFrom.y + cancelFrom.height / 2)
      expect(await page.evaluate(() => document.documentElement.style.cursor)).toBe('grabbing')
      await page.locator(`[data-chain="${ROW}|task.2"]`).dispatchEvent('pointercancel', { pointerId: 1 })
      expect(await page.evaluate(() => document.documentElement.style.cursor)).toBe('')
      await page.mouse.up()
      expect(await order(page)).toEqual(beforeCancel)
    } finally {
      await page.close()
      await reset()
    }
  }, 30_000)

  test('phone: the menu moves and inserts, and a held finger drags a whole entry up the list', async () => {
    if (!browser) return
    await mixed()
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Spaces', exact: true }).click()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Models', exact: true }).tap()
      await settled(page)
      await page.locator(`[data-chain="${ROW}|task.0"]`).waitFor()
      expect(await order(page)).toEqual(['Claude Code', 'Codex', 'pi', 'OpenCode', 'Antigravity'])

      await page.getByRole('button', { name: 'Chain actions for gtm · Tasks · Primary', exact: true }).tap()
      await page.getByRole('menuitem', { name: 'Move down', exact: true }).tap()
      await until(
        async () => vm().get('task.agent', 'gtm'),
        (v) => v === 'Codex',
      )
      await onlyNew(page)

      await page.getByRole('button', { name: 'Chain actions for gtm · Tasks · Backup 1', exact: true }).tap()
      await page.getByRole('menuitem', { name: 'Insert above', exact: true }).tap()
      await until(
        async () => vm().get('task.fallback', 'gtm'),
        (v) => v === 'Claude Code',
      )
      expect(vm().get('backup.model', 'gtm')).toBe('default')
      await onlyNew(page)
      // the new entry's inline editor is open: close it before dragging the list
      await page.locator(`[data-cell="${ROW}|task.1"]`).tap()
      await page.locator(`[data-cell="${ROW}|task.2"]`).scrollIntoViewIfNeeded()
      const source = page.locator(`[data-chain="${ROW}|task.2"]`)
      const target = page.locator(`[data-chain="${ROW}|task.0"]`)
      const from = await box(source)
      const to = await box(target)
      const cdp = await page.context().newCDPSession(page)
      const x = from.x + from.width / 2
      const y = from.y + from.height / 2
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      await page.waitForTimeout(600)
      for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + ((to.y + to.height / 2 - y) * i) / 8 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await until(
        async () => vm().get('task.agent', 'gtm'),
        (v) => v === 'Claude Code',
      )
      expect(vm().get('task.model', 'gtm')).toBe('claude-opus-5-5')
      expect(await page.locator(`[data-cell="${ROW}|task.0"]`).getAttribute('aria-expanded')).toBe('false')
      await onlyNew(page)

      const reviewer = vm().get('coordinator.fallback', 'gtm')
      await page.getByRole('button', { name: 'Chain actions for gtm · Coordinators · Backup 1', exact: true }).tap()
      await page.getByRole('menuitem', { name: 'Move up', exact: true }).tap()
      await page.getByRole('status').filter({ hasText: 'gtm · Coordinators:' }).waitFor()
      expect(vm().get('coordinator.fallback', 'gtm')).toBe(reviewer)
    } finally {
      await page.close()
      await reset()
    }
  }, 30_000)
})
