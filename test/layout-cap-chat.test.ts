// The cards the caps write into a task's chat: a task started on a backup because its primary was full or out says so
// (its start card), and an advisor question that waits for a model with room says what it waits for (its advisor card).
// The demo world, with the cards pushed where the engine and the advisor post them.
import { describe, expect, test } from 'bun:test'
import { layout, settled } from './layout.ts'

const { browser, world, url } = await layout()

/** the chat of task HP-203 (its agent's chat, a task's own panel) on a desktop */
async function openTask(page: import('playwright-core').Page) {
  await page.goto(`${url().replace(/\?place=.*$/, '')}?place=p%3Avm-str%3Aherdr-projects&task=HP-203`)
  await settled(page)
}

describe.skipIf(!browser)('the cap cards in a task’s chat', () => {
  test('a task started on a backup shows its start card, with the harness it runs on and what was full', async () => {
    const chat = world.chats['HP-203/Agent']
    const id = 'cap:HP-203:test'
    chat.messages.push({ id, at: Date.now(), card: { id, task: 'HP-203', status: 'work', text: 'Started on Codex: spark is at its limit (1 of 1 at once)' } } as never)
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openTask(page)
      await page.getByText('Started on Codex: spark is at its limit (1 of 1 at once)').first().waitFor()
    } finally {
      chat.messages = chat.messages.filter((m) => m.id !== id)
      await page.close()
    }
  })

  test('an advisor question that waits says what it waits for, in a note in the chat', async () => {
    const chat = world.chats['HP-203/Agent']
    const id = 'advice-wait:ask:wait:chat'
    const words = 'The advisor waits: spark (4 of 4 at once), opencode-go (out until 17:00)'
    chat.messages.push({ id, at: Date.now(), card: { id, aside: true, text: words } } as never)
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await openTask(page)
      await page.getByText(words).first().waitFor()
      expect(await page.getByText(words).count()).toBeGreaterThan(0)
    } finally {
      chat.messages = chat.messages.filter((m) => m.id !== id)
      await page.close()
    }
  })
})
