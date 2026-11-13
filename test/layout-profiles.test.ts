// Settings → Models → profiles: the bar above the table on a desktop and a phone. Saving the current settings (asking before
// a name is replaced), the preview of what applying a profile changes, applying it (the question about the waiting tasks,
// once), undo (with what it left as it was), a refused value that holds the apply back, the lines about spaces added or
// removed since the save, and managing the profiles (rename, delete).
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
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
/** the profiles bar, and its menu's items */
const bar = (page: Page) => page.getByRole('region', { name: 'Profiles', exact: true })
const menu = async (page: Page) => {
  await bar(page).getByRole('button', { name: 'Profiles', exact: true }).click()
  return page.getByRole('menu', { name: 'Profiles' })
}
/** the question about the waiting tasks, when it is asked */
const askedWaiting = (page: Page) => page.getByRole('alertdialog').filter({ hasText: 'Apply to the tasks already created?' })
/** the demo's machine (vm-str) and its settings */
const vm = () => world.stores['vm-str']
/** the profiles as the demo keeps them (a test breaks one on purpose, the way a stored file could be broken) */
type Kept = { profiles: { name: string; values: { all: Record<string, string | null>; machine: Record<string, string | null>; spaces: Record<string, Record<string, string | null>> } }[]; last?: unknown; undo: unknown[] }
const kept = () => (world.profiles as unknown as { store: { f: Kept } }).store.f
/** until what it checks holds (a write goes through the server, a moment after the key is pressed) */
async function waitFor(ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await Bun.sleep(50)
  expect(ok()).toBe(true)
}
/** the question about the waiting tasks: Only new tasks, then it is gone */
async function answerOnlyNew(page: Page) {
  const ask = askedWaiting(page)
  await ask.waitFor()
  await ask.getByRole('button', { name: 'Only new tasks', exact: true }).click()
  await ask.waitFor({ state: 'detached' })
}

/** the demo's Settings, profiles and undo points back as the tests found them */
async function reset() {
  const store = vm()
  const chain = ['reviewer.fallback', 'reviewer.fallback2', 'reviewer.fallback3', 'reviewer.fallback4', 'reviewer.fallback5']
  for (const space of ['gtm', 'herdr-projects']) {
    for (const k of ['task.agent', 'task.model', 'task.effort', 'space.maxTasks', 'merge.train', ...chain]) store.set(k, null, { space })
  }
  for (const k of ['task.agent', 'task.model', 'task.effort', 'space.maxTasks', ...chain]) store.set(k, null, 'all')
  // the demo's own: gtm runs Codex
  store.set('task.agent', 'Codex', { space: 'gtm' })
  world.sections = (await import('../server/demo/data.ts')).settings(world.stores)
  for (const p of ((await world.act({ type: 'profiles' })) as { profiles: { name: string }[] }).profiles) await world.act({ type: 'profile-delete', name: p.name })
  kept().undo = []
  kept().last = undefined
  world.emit('snapshot')
}

describe.skipIf(!browser)('Settings → Models: the profiles bar on a desktop', () => {
  test('the bar names the profile the settings match, Custom when none does; Save current as… keeps them, and asks before a name is replaced', async () => {
    await reset()
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      await bar(page).getByText('Custom', { exact: true }).waitFor()
      await bar(page).getByText('Save the settings as a profile to switch them in one step.').waitFor()
      // saved under a name, with the limits ticked: the bar names it, the settings being what they are
      await (await menu(page)).getByRole('menuitem', { name: 'Save current as…', exact: true }).click()
      const save = page.getByRole('alertdialog', { name: 'Save the current settings as a profile' })
      await save.getByRole('textbox', { name: 'Name' }).fill('night')
      await save.getByRole('checkbox').check()
      await save.getByRole('button', { name: 'Save', exact: true }).click()
      await save.waitFor({ state: 'detached' })
      await bar(page).getByText('night', { exact: true }).waitFor()
      expect(await bar(page).getByRole('status').textContent()).toBe('Saved night, the models and the limits.')
      expect(kept().profiles.map((p) => p.name)).toEqual(['night'])
      // a name saved already: the dialog asks, says so, and only then replaces it
      await (await menu(page)).getByRole('menuitem', { name: 'Save current as…', exact: true }).click()
      const again = page.getByRole('alertdialog', { name: 'Save the current settings as a profile' })
      await again.getByRole('textbox', { name: 'Name' }).fill('night')
      await again.getByRole('button', { name: 'Save', exact: true }).click()
      await again.getByRole('status').filter({ hasText: 'night is a profile already.' }).waitFor()
      expect(await again.getByRole('button', { name: 'Replace night', exact: true }).count()).toBe(1)
      // the name typed again goes back to Save; Enter saves a new name
      await again.getByRole('textbox', { name: 'Name' }).fill('day')
      await again.getByRole('textbox', { name: 'Name' }).press('Enter')
      await again.waitFor({ state: 'detached' })
      expect(kept().profiles.map((p) => p.name)).toEqual(['night', 'day'])
      // both match the settings as they are: the bar names the first saved
      await bar(page).getByText('night', { exact: true }).waitFor()
      // Cancel leaves nothing saved
      await (await menu(page)).getByRole('menuitem', { name: 'Save current as…', exact: true }).click()
      await page.getByRole('alertdialog', { name: 'Save the current settings as a profile' }).getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(kept().profiles.length).toBe(2)
    } finally {
      await reset()
      await page.close()
    }
  })

  test('Apply shows what it changes by level, writes it, and asks about the waiting tasks once; Undo puts it back and asks again', async () => {
    await reset()
    // day keeps herdr-projects on pi; by hand it runs Claude Code now, where its two waiting tasks run
    vm().set('task.agent', 'pi', { space: 'herdr-projects' })
    await world.act({ type: 'profile-save', name: 'day' })
    vm().set('task.agent', 'Claude Code', { space: 'herdr-projects' })
    world.emit('snapshot')
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      await bar(page).getByText('Custom', { exact: true }).waitFor()
      await (await menu(page)).getByRole('menuitem', { name: 'Apply day…' }).click()
      const dlg = page.getByRole('alertdialog', { name: 'Apply day?' })
      await dlg.getByRole('heading', { name: 'herdr-projects', exact: true }).waitFor()
      expect(await dlg.textContent()).toContain('Tasks · Primary · Agent: Claude Code → pi')
      await dlg.getByRole('button', { name: 'Apply 1 change', exact: true }).click()
      await dlg.waitFor({ state: 'detached' })
      expect(vm().get('task.agent', 'herdr-projects')).toBe('pi')
      await bar(page).getByText('day', { exact: true }).waitFor()
      expect(await bar(page).getByRole('status').textContent()).toBe('Applied day: 1 setting changed. Undo last apply puts them back.')
      // the question about the waiting tasks it reaches: once, and the two move to pi
      const ask = askedWaiting(page)
      await ask.getByRole('button', { name: 'Apply to 2 tasks', exact: true }).click()
      await ask.getByRole('button', { name: 'Done', exact: true }).click()
      await ask.waitFor({ state: 'detached' })
      expect(world.tasks.filter((t) => ['HP-203', 'HP-204'].includes(t.id)).map((t) => t.agent?.cli)).toEqual(['pi', 'pi'])
      expect(await askedWaiting(page).count()).toBe(0)

      // Undo last apply: back to Claude Code, the question again
      await (await menu(page)).getByRole('menuitem', { name: 'Undo last apply' }).click()
      const undo = page.getByRole('alertdialog', { name: 'Undo the last apply?' })
      await undo.getByRole('button', { name: 'Undo', exact: true }).click()
      await undo.waitFor({ state: 'detached' })
      expect(vm().get('task.agent', 'herdr-projects')).toBe('Claude Code')
      expect(await bar(page).getByRole('status').textContent()).toBe("Undone: day's apply put back 1 setting.")
      await answerOnlyNew(page)
    } finally {
      await reset()
      await page.close()
    }
  })

  test('a setting changed since an apply is left as it is by its undo, and the bar says so', async () => {
    await reset()
    await world.act({ type: 'profile-save', name: 'keep' })
    vm().set('task.agent', 'pi', { space: 'gtm' })
    world.emit('snapshot')
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      await (await menu(page)).getByRole('menuitem', { name: 'Apply keep…' }).click()
      await page.getByRole('alertdialog', { name: 'Apply keep?' }).getByRole('button', { name: 'Apply 1 change', exact: true }).click()
      await answerOnlyNew(page)
      // by hand, once more: gtm runs pi again, which the undo must not take back
      vm().set('task.agent', 'pi', { space: 'gtm' })
      world.emit('snapshot')
      await bar(page).getByText('Changed since keep was applied').waitFor()
      await (await menu(page)).getByRole('menuitem', { name: 'Undo last apply' }).click()
      await page.getByRole('alertdialog', { name: 'Undo the last apply?' }).getByRole('button', { name: 'Undo', exact: true }).click()
      await bar(page).getByRole('status').filter({ hasText: 'Left as they are' }).waitFor()
      expect(vm().get('task.agent', 'gtm')).toBe('pi')
      expect(await bar(page).getByRole('status').textContent()).toBe("Undone: keep's apply put back 0 settings. Left as they are, changed since: Tasks · Primary · Agent (gtm).")
    } finally {
      await reset()
      await page.close()
    }
  })

  test('a value refused holds the apply back, and the dialog says which; an undo a value refuses is not made', async () => {
    await reset()
    await world.act({ type: 'profile-save', name: 'broken' })
    vm().set('task.agent', 'pi', { space: 'gtm' })
    world.emit('snapshot')
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      await (await menu(page)).getByRole('menuitem', { name: 'Apply broken…' }).click()
      const dlg = page.getByRole('alertdialog', { name: 'Apply broken?' })
      await dlg.getByRole('button', { name: 'Apply 1 change', exact: true }).waitFor()
      // the stored profile goes bad after the preview was read: the apply is refused, and the dialog says so
      kept().profiles[0]!.values.all['task.model'] = 'bad!'
      await dlg.getByRole('button', { name: 'Apply 1 change', exact: true }).click()
      await dlg.getByRole('status').filter({ hasText: 'Nothing was applied: 1 setting would be refused.' }).waitFor()
      expect(await dlg.getByRole('button', { name: 'Apply 1 change', exact: true }).isDisabled()).toBe(true)
      expect(await dlg.textContent()).toContain('Everywhere · Tasks · Primary · Model:')
      expect(vm().get('task.agent', 'gtm')).toBe('pi')
      await dlg.getByRole('button', { name: 'Cancel', exact: true }).click()
      await dlg.waitFor({ state: 'detached' })
      // read again, it is refused before anything is written: Apply stays off
      await (await menu(page)).getByRole('menuitem', { name: 'Apply broken…' }).click()
      const again = page.getByRole('alertdialog', { name: 'Apply broken?' })
      // both changes are listed (gtm's agent, and the refused model), and Apply is off
      await again.getByRole('status').filter({ hasText: 'Nothing is applied while a value is refused:' }).waitFor()
      expect(await again.getByRole('button', { name: 'Apply 2 changes', exact: true }).isDisabled()).toBe(true)
      await again.getByRole('button', { name: 'Cancel', exact: true }).click()
    } finally {
      await reset()
      await page.close()
    }
  })

  test('a profile that reads as the settings already says so, and the spaces added or removed since the save are said', async () => {
    await reset()
    await world.act({ type: 'profile-save', name: 'same' })
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      // a saved space gone, another one added since: the lines say what is left out
      const profile = kept().profiles.find((p) => p.name === 'same')!
      profile.values.spaces.ghost = { ...profile.values.spaces.gtm! }
      delete profile.values.spaces['herdr-projects']
      await (await menu(page)).getByRole('menuitem', { name: 'Apply same…' }).click()
      const dlg = page.getByRole('alertdialog', { name: 'Apply same?' })
      await dlg.getByText('The settings read as same says already: nothing to change.').waitFor()
      expect(await dlg.getByRole('button', { name: 'Apply', exact: true }).isDisabled()).toBe(true)
      expect(await dlg.textContent()).toContain('Skipped, no longer a space: ghost. Its saved values are left out.')
      expect(await dlg.textContent()).toContain('Left as it is, added since the save: herdr-projects.')
      await dlg.getByRole('button', { name: 'Cancel', exact: true }).click()
      // nothing to undo until an apply has been made
      expect(await (await menu(page)).getByRole('menuitem', { name: 'Undo last apply' }).count()).toBe(0)
    } finally {
      await reset()
      await page.close()
    }
  })

  test('an undo a value refuses is not made, and says why', async () => {
    await reset()
    await world.act({ type: 'profile-save', name: 'undone' })
    vm().set('task.agent', 'pi', { space: 'gtm' })
    world.emit('snapshot')
    await world.act({ type: 'profile-apply', name: 'undone' })
    const point = kept().undo.at(-1) as { changes: { before: string }[] }
    point.changes[0]!.before = 'bad!'
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      await (await menu(page)).getByRole('menuitem', { name: 'Undo last apply' }).click()
      const dlg = page.getByRole('alertdialog', { name: 'Undo the last apply?' })
      await dlg.getByRole('button', { name: 'Undo', exact: true }).click()
      await dlg.getByRole('status').filter({ hasText: 'Nothing was undone: 1 setting would be refused.' }).waitFor()
      // the apply it would have undone stays: gtm still runs what the apply gave it
      expect(vm().get('task.agent', 'gtm')).toBe('Codex')
      await dlg.getByRole('button', { name: 'Cancel', exact: true }).click()
    } finally {
      await reset()
      await page.close()
    }
  })

  test('Manage profiles: rename (a taken name is refused), delete (asks first)', async () => {
    await reset()
    await world.act({ type: 'profile-save', name: 'a1' })
    await world.act({ type: 'profile-save', name: 'a2' })
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openModels(page)
      await (await menu(page)).getByRole('menuitem', { name: 'Manage profiles…' }).click()
      const dlg = page.getByRole('alertdialog', { name: 'Manage profiles' })
      const row = (name: string) => dlg.getByRole('listitem').filter({ hasText: name })
      await row('a1').getByRole('button', { name: 'Rename', exact: true }).click()
      const box = dlg.getByRole('textbox', { name: 'New name for a1' })
      await box.fill('a2')
      await dlg.locator('form').getByRole('button', { name: 'Rename', exact: true }).click()
      await dlg.getByRole('status').filter({ hasText: 'a2 is a profile already.' }).waitFor()
      await box.fill('a3')
      await dlg.locator('form').getByRole('button', { name: 'Rename', exact: true }).click()
      await row('a3').waitFor()
      expect(kept().profiles.map((p) => p.name)).toEqual(['a3', 'a2'])
      // a rename that is cancelled changes nothing
      await row('a2').getByRole('button', { name: 'Rename', exact: true }).click()
      await dlg.getByRole('button', { name: 'Cancel', exact: true }).click()
      // delete asks first
      await row('a2').getByRole('button', { name: 'Delete', exact: true }).click()
      await dlg.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(kept().profiles.length).toBe(2)
      await row('a2').getByRole('button', { name: 'Delete', exact: true }).click()
      await row('a2').getByRole('button', { name: 'Delete', exact: true }).click()
      await row('a2').waitFor({ state: 'detached' })
      expect(kept().profiles.map((p) => p.name)).toEqual(['a3'])
      await dlg.getByRole('button', { name: 'Done', exact: true }).click()
    } finally {
      await reset()
      await page.close()
    }
  })

  test('a worker keeps no profiles: the bar says where they are kept', async () => {
    await reset()
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    const act = world.act.bind(world)
    world.act = async (a) => (a.type === 'profiles' ? { profiles: [], active: 'Custom', unavailable: 'Profiles are kept on the main machine: run this there.' } : act(a))
    try {
      await openModels(page)
      await bar(page).getByText('Profiles are kept on the main machine: run this there.').waitFor()
      expect(await bar(page).getByRole('button').count()).toBe(0)
    } finally {
      world.act = act
      await page.close()
    }
  })
})

describe.skipIf(!browser)('Settings → Models: the profiles bar on a phone', () => {
  test('the bar is one row with the profile in force and its menu; Apply opens the same preview, and nothing wider than the screen', async () => {
    await reset()
    await world.act({ type: 'profile-save', name: 'night' })
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Places', exact: true }).click()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Models', exact: true }).tap()
      await settled(page)
      await bar(page).getByText('night', { exact: true }).waitFor()
      await bar(page).getByRole('button', { name: 'Profiles', exact: true }).tap()
      await page.getByRole('menuitem', { name: 'Apply night…' }).tap()
      const dlg = page.getByRole('alertdialog', { name: 'Apply night?' })
      await dlg.getByText('The settings read as night says already: nothing to change.').waitFor()
      await dlg.getByRole('button', { name: 'Cancel', exact: true }).tap()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    } finally {
      await reset()
      await page.close()
    }
  })
})
