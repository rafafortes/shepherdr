// OpenCode on the screens that list CLIs and models: Settings → Models, a slot's popover offers OpenCode among the CLIs and
// its models grouped by provider (the list OpenCode gives, named provider/model), and Settings → Limits has a row for an
// OpenCode provider of its own (the free Zen models) with what it used. Two short tests; the list is set here, as OpenCode
// would give it, since no OpenCode runs in a test.
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { opencodeList, setModels } from '../server/live/models.ts'
import { layout, settled } from './layout.ts'

const { browser, world, url } = await layout()

const GO = 'opencode-go/deepseek-v4.1-flash'
const ZEN = 'opencode/minimax-m3.1-flash-free'
const NV = 'nvidia/z-ai/glm-5.3-flash'

/** the Settings page of the demo, opened on one of its sections */
async function openSection(page: Page, section: 'Models' | 'Limits') {
  await page.goto(url())
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('region', { name: 'Settings' }).getByRole('button', { name: section, exact: true }).click()
  await settled(page)
}

describe.skipIf(!browser)('OpenCode on the Models and Limits screens', () => {
  test("a slot's popover offers OpenCode, and its models grouped by provider, named as OpenCode names them", async () => {
    setModels('opencode', { ...opencodeList([
      { id: NV, label: NV, efforts: [] },
      { id: ZEN, label: ZEN, efforts: [] },
      { id: GO, label: GO, efforts: ['high'] },
    ], GO), at: Date.now() })
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openSection(page, 'Models')
      await page.getByRole('button', { name: /^Everywhere · Tasks · Backup 1/ }).first().click()
      const pop = page.getByRole('dialog', { name: 'Edit this setting' })
      await pop.getByRole('button', { name: 'Backup: Codex', exact: true }).click()
      await page.getByRole('menuitemradio', { name: 'OpenCode', exact: true }).click()
      await pop.getByRole('button', { name: 'Backup: OpenCode', exact: true }).waitFor()
      await pop.getByRole('button', { name: 'Backup model: Default', exact: true }).click()
      // grouped by provider: nvidia's models, then opencode's, then opencode-go's, each named provider/model
      const menu = page.getByRole('menu', { name: 'Choices' })
      const names = await menu.getByRole('menuitemradio').allTextContents()
      expect(names.slice(0, 4)).toEqual(['Default', NV, ZEN, GO])
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
    } finally {
      // the demo's own backup again, and OpenCode's list gone from this process
      world.stores['vm-str'].set('task.fallback', null, 'all')
      world.emit('snapshot')
      setModels('opencode', undefined)
      await page.close()
    }
  })

  test('Limits has a row for OpenCode Zen (free), the provider of its own, with what it used', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openSection(page, 'Limits')
      const row = page.getByRole('rowheader', { name: 'OpenCode Zen (free)', exact: true })
      await row.scrollIntoViewIfNeeded()
      await row.waitFor()
      // its model under it, named without its provider (the row says it), and no quota: Zen has none to read
      await page.getByRole('rowheader', { name: 'minimax-m3.1-flash-free', exact: true }).waitFor()
      expect(await page.getByRole('table', { name: 'Providers and models' }).textContent()).toContain('OpenCode Zen (free)')
    } finally {
      await page.close()
    }
  })
})
