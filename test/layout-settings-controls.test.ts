// SHE-112: the controls the Settings shell shares with its lazy pages moved to settings-parts.tsx. These are the few
// paths the other Settings tests never took; run them here so the extraction leaves no line of that file unrun.
import { describe, expect, test } from 'bun:test'
import { layout, settled, until } from './layout.ts'

const { browser, world, url } = await layout()

describe.skipIf(!browser)('the controls shared by Settings and its pages', () => {
  test('a number steps by button and key, takes a value that is not a number, and a doc saves with Ctrl+S', async () => {
    const store = world.stores['vm-str']
    const rounds = store.get('review.rounds')
    const instructions = store.get('task.instructions', '~')
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('button', { name: 'How tasks work', exact: true }).click()
      await settled(page)
      const more = settings.getByRole('button', { name: 'More: Review rounds', exact: true })
      const less = settings.getByRole('button', { name: 'Less: Review rounds', exact: true })
      const box = settings.getByRole('textbox', { name: 'Review rounds (rounds)', exact: true })
      await more.click()
      await until(
        async () => (await box.inputValue()) === '4',
        (v) => v,
      )
      await box.press('ArrowDown')
      await until(
        async () => (await box.inputValue()) === '3',
        (v) => v,
      )
      await less.click()
      await until(
        async () => (await box.inputValue()) === '2',
        (v) => v,
      )
      // a value that is not a number steps to the least the setting takes
      await box.fill('many')
      await more.click()
      await until(
        async () => (await box.inputValue()) === '1',
        (v) => v,
      )
      // a picker with no scrolling ancestor still opens: roomFor's window fallback
      await page.addStyleTag({ content: '* { overflow: visible !important; }' })
      await settings.getByRole('button', { name: /^Editing:/ }).click()
      await page.getByRole('menuitemradio', { name: 'Everywhere', exact: true }).waitFor()
      // a whole file's words save on Ctrl+S too
      await page.reload()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await settings.getByRole('button', { name: 'Private instructions', exact: true }).click()
      await settled(page)
      const doc = settings.getByRole('textbox', { name: 'Task agents', exact: true })
      await doc.fill('Saved with a shortcut.')
      await doc.press('Control+s')
      await until(
        async () => (await store.get('task.instructions', '~')) === 'Saved with a shortcut.',
        (v) => v,
      )
    } finally {
      store.set('review.rounds', rounds)
      store.set('task.instructions', instructions, { space: '~' })
      world.emit('snapshot')
      await page.close()
    }
  })
})
