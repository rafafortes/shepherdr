// Bulk task actions: the Tasks list's selection mode and the bar that loops each row's own verb once per task (FUNC-06).
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import type { Action } from '../shared/types.ts'
import { layout } from './layout.ts'

const { browser, world, url } = await layout({ everything: true })
/** the shared browser, when this file's tests are not skipped for the lack of one */
const newPage = () => {
  if (!browser) throw new Error('no browser')
  return browser.newPage({ viewport: { width: 1440, height: 900 } })
}
const task = (id: string) => {
  const t = world.tasks.find((x) => x.id === id)
  if (!t) throw new Error(`no task ${id}`)
  return t
}

const tick = (page: Page, id: string) => page.locator(`li[data-flip="${id}"] > button`).first().click()
const row = (page: Page, id: string) => page.locator(`li[data-flip="${id}"]`)
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Bulk actions' })
const select = async (page: Page) => {
  await page.getByRole('button', { name: 'Group tasks' }).click()
  await page.getByRole('menuitem', { name: 'Select tasks' }).click()
}
/** Scope a page's list to one space, overriding the everything chip this file's layout puts in each new page. */
const open = async (page: Page, place: string) => {
  await page.addInitScript((p) => localStorage.setItem('shepherdr.lists', JSON.stringify({ pinned: false, chips: [p], at: null })), place)
  const at = new URL(url())
  at.searchParams.set('place', place)
  at.searchParams.set('tab', 'tasks')
  await page.goto(at.href)
}
const emit = () => (world as unknown as { emit(e: string): void }).emit('snapshot')
/** Record the acts the screen sends, forwarding each to the fake server. */
type Sent = { type: string; chat?: string; on?: boolean }
function record(override?: (a: Action) => Promise<unknown> | undefined) {
  const sent: Sent[] = []
  const real = world.act.bind(world)
  world.act = async (a: Action) => {
    sent.push(a as Sent)
    return (await override?.(a)) ?? real(a)
  }
  return {
    sent,
    restore: () => {
      world.act = real
    },
  }
}

describe.skipIf(!browser)('selecting rows for a bulk action', () => {
  test('Select enters the mode, ticks toggle with a ring, Clear selection and Esc leave no task acted on', async () => {
    const rec = record()
    try {
      const page = await newPage()
      await page.goto(url())
      await row(page, 'GTM-12').waitFor()
      await select(page)
      await tick(page, 'GTM-12')
      expect(await row(page, 'GTM-12').getAttribute('data-selected')).toBe('true')
      await tick(page, 'GTM-12')
      expect(await row(page, 'GTM-12').getAttribute('data-selected')).toBe(null)
      await tick(page, 'GTM-12')
      expect((await bar(page).textContent())?.trim()).toContain('1 selected')
      // Clear selection empties it without sending anything
      await bar(page).getByRole('button', { name: 'Clear selection' }).click()
      await bar(page).waitFor({ state: 'detached' })
      expect(await row(page, 'GTM-12').getAttribute('data-selected')).toBe(null)
      // Esc does the same, ahead of the list's other back steps
      await tick(page, 'GTM-15')
      await page.keyboard.press('Escape')
      await bar(page).waitFor({ state: 'detached' })
      // navigating goes back to the plain list too
      await bar(page).waitFor({ state: 'detached' })
      await select(page)
      await tick(page, 'GTM-15')
      await page.keyboard.press('[')
      await bar(page).waitFor({ state: 'detached' })
      expect(rec.sent.length).toBe(0)
      await page.close()
    } finally {
      rec.restore()
    }
  }, 30_000)

  test('selecting 3 done tasks and archiving sends one act each, then clears the selection', async () => {
    const done = task('GTM-12')
    const extra = Array.from({ length: 3 }, (_, i) => ({ ...done, id: `BULK-A${i}`, name: `Bulk done ${i}`, agent: undefined, archived: undefined, pinned: undefined }))
    world.tasks.push(...extra)
    emit()
    const rec = record()
    try {
      const page = await newPage()
      await page.goto(url())
      await row(page, 'BULK-A0').waitFor()
      await select(page)
      for (const t of extra) await tick(page, t.id)
      expect((await bar(page).textContent())?.trim()).toContain('3 selected')
      await bar(page).getByRole('button', { name: 'Archive' }).click()
      const ask = page.getByRole('alertdialog', { name: 'Archive 3 tasks?' })
      await ask.waitFor()
      expect(await ask.textContent()).toContain('Each task gets its own line')
      await ask.getByRole('button', { name: 'Archive' }).click()
      for (const t of extra) await row(page, t.id).waitFor({ state: 'detached' })
      await bar(page).waitFor({ state: 'detached' })
      expect(rec.sent.map((a) => [a.type, a.chat])).toEqual(extra.map((t) => ['archive', `${t.id}/Agent`]))
      await page.close()
    } finally {
      world.tasks.splice(world.tasks.indexOf(extra[0]), extra.length)
      for (const t of extra) t.archived = undefined
      emit()
      rec.restore()
    }
  }, 30_000)

  test('a working task in a Stop selection is named first; a refusal shows once and the others still stop', async () => {
    const rec = record()
    try {
      const page = await newPage()
      await page.goto(url())
      await row(page, 'HP-202').waitFor()
      await row(page, 'GTM-12').waitFor()
      await select(page)
      await tick(page, 'HP-202')
      await tick(page, 'GTM-12')
      await bar(page).getByRole('button', { name: 'Stop' }).click()
      const ask = page.getByRole('alertdialog', { name: 'Stop 2 tasks?' })
      await ask.waitFor()
      expect(await ask.textContent()).toContain('HP-202 is at work; stop stops it first')
      await ask.getByRole('button', { name: 'Stop' }).click()
      const result = page.getByRole('alertdialog', { name: '1 task could not be stopped' })
      await result.waitFor()
      const words = await result.textContent()
      expect(words).toContain('1 stopped')
      expect(words).toContain('GTM-12: It is done already.')
      expect(
        rec.sent
          .filter((a) => a.type === 'stop')
          .map((a) => a.chat)
          .sort(),
      ).toEqual(['GTM-12/Agent', 'HP-202/Agent'])
      // the refusal does not strand the selection
      await bar(page).waitFor({ state: 'detached' })
      await result.getByRole('button', { name: 'OK' }).click()
      await page.close()
    } finally {
      const hp = task('HP-202')
      const done = task('GTM-12')
      Object.assign(hp, { status: 'work', sub: 'Reading the call helper', report: { msg: 'Tracing why mute ends the call', progress: 40, eta: 12 } })
      Object.assign(done, { status: 'done' })
      emit()
      rec.restore()
    }
  }, 30_000)

  test('a thrown act is collected with the refusals and the loop goes on', async () => {
    const rec = record(async (a) => ((a as { chat?: string }).chat === 'BULK-E1/Agent' ? Promise.reject(new Error('herdr is down')) : undefined))
    const done = task('GTM-12')
    const extra = Array.from({ length: 2 }, (_, i) => ({ ...done, id: `BULK-E${i}`, name: `Bulk error ${i}`, agent: undefined, archived: undefined, pinned: undefined }))
    world.tasks.push(...extra)
    emit()
    try {
      const page = await newPage()
      await page.goto(url())
      await row(page, 'BULK-E0').waitFor()
      await select(page)
      for (const t of extra) await tick(page, t.id)
      await bar(page).getByRole('button', { name: 'Pin' }).click()
      const ask = page.getByRole('alertdialog', { name: 'Pin 2 tasks?' })
      await ask.waitFor()
      await ask.getByRole('button', { name: 'Pin' }).click()
      const result = page.getByRole('alertdialog', { name: '1 task could not be pinned' })
      await result.waitFor()
      expect(await result.textContent()).toContain('BULK-E1:')
      expect(await result.textContent()).toContain('herdr is down')
      expect(rec.sent.map((a) => a.chat)).toEqual(['BULK-E0/Agent', 'BULK-E1/Agent'])
      await page.close()
    } finally {
      world.tasks.splice(world.tasks.indexOf(extra[0]), extra.length)
      emit()
      rec.restore()
    }
  }, 30_000)

  test('the Archived view offers Unarchive instead of Archive, Stop or Pin', async () => {
    const rec = record()
    try {
      const page = await newPage()
      await open(page, 'p:vm-str:gtm')
      await row(page, 'GTM-17').waitFor()
      await page.getByRole('button', { name: /^Archived\s*2$/ }).click()
      await row(page, 'GTM-9').waitFor()
      await select(page)
      await tick(page, 'GTM-9')
      const buttons = (await bar(page).getByRole('button').allTextContents()).map((b) => b.trim())
      expect(buttons).toContain('Unarchive')
      expect(buttons).not.toContain('Archive')
      expect(buttons).not.toContain('Stop')
      expect(buttons).not.toContain('Pin')
      await bar(page).getByRole('button', { name: 'Unarchive' }).click()
      const ask = page.getByRole('alertdialog', { name: 'Unarchive 1 task?' })
      await ask.waitFor()
      await ask.getByRole('button', { name: 'Unarchive' }).click()
      await row(page, 'GTM-9').waitFor({ state: 'detached' })
      expect(rec.sent.map((a) => [a.type, a.chat, a.on])).toEqual([['archive', 'GTM-9/Agent', false]])
      await page.close()
    } finally {
      const archived = task('GTM-9')
      archived.archived = Date.now() - 9 * 86_400_000
      emit()
      rec.restore()
    }
  }, 30_000)

  test('Delete stays on one row: the bar has no Delete', async () => {
    const page = await newPage()
    await page.goto(url())
    await row(page, 'GTM-12').waitFor()
    await select(page)
    await tick(page, 'GTM-12')
    const buttons = await bar(page).getByRole('button').allTextContents()
    expect(buttons.some((b) => /delete/i.test(b))).toBe(false)
    await page.close()
  }, 30_000)
})
