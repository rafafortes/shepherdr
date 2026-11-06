// Send now on a message Claude Code holds in its own queue: the line under your bubble, and what a tap asks for, in a
// real browser (layout.ts). The press itself, read off the pane, is source.test.ts's with a fake pane.
import { describe, expect, test } from 'bun:test'
import { layout } from './layout.ts'
import type { Action } from '../shared/types.ts'

const { browser, world, url } = await layout()

/** the chat the demo opens at: the home space's coordinator, on Claude Code */
const KEY = 'p:vm-str:~'
const emit = (key: string) => (world as unknown as { emit(e: string, k: string): void }).emit('chat', key)

/** its agent at work, so what you send waits in its CLI's own queue (world.ts), and long enough that its next step
 *  does not take it before the test got to Send now */
function atWork() {
  const chat = world.chats[KEY]
  chat.working = true
  const was = world.queueMs
  world.queueMs = 60_000
  return () => {
    chat.working = undefined
    chat.agent = chat.agent && { ...chat.agent, kind: 'claude' }
    world.queueMs = was
    emit(KEY)
  }
}

describe.skipIf(!browser)("Send now on a message in Claude Code's queue", () => {
  test('a message its CLI holds says Queued · Send now, and a tap has the CLI take it now', async () => {
    const done = atWork()
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
    const text = 'Also rerun the flaky test'
    try {
      await page.goto(url())
      const box = page.getByRole('textbox', { name: /Message/ })
      await box.waitFor()
      await box.fill(text)
      await page.getByRole('button', { name: 'Send' }).click()
      // in its CLI's queue, not in the chat yet: the bubble says so, and Send now is right there
      const bubble = page.locator('[data-msg^="out:"]').filter({ hasText: text })
      await bubble.waitFor()
      const now = bubble.getByRole('button', { name: 'Send now', exact: true })
      await now.waitFor()
      expect(await bubble.textContent()).toContain('Queued · Send now')
      // another CLI keeps its own queue and has no such key: nothing to press, and nothing said
      const agent = world.chats[KEY].agent!
      world.chats[KEY].agent = { ...agent, kind: 'pi' }
      emit(KEY)
      await now.waitFor({ state: 'detached' })
      expect(await bubble.textContent()).toBe(text)
      // Claude Code again, but its turn is over: what it queued goes in on its own
      world.chats[KEY].agent = agent
      world.chats[KEY].working = false
      emit(KEY)
      await page.waitForFunction((t) => document.querySelector('[data-msg^="out:"]')?.textContent === t, text)
      expect(await now.count()).toBe(0)
      // at work again: the same message is still in its queue, and can be taken now
      world.chats[KEY].working = true
      emit(KEY)
      await now.waitFor()
      // a tap: its CLI takes it, and the real message takes the bubble's place without the line
      await now.click()
      await page.waitForFunction(() => !document.querySelector('[data-msg^="out:"]'))
      const real = page.locator('[data-you]').filter({ hasText: text })
      await real.waitFor()
      expect(await real.textContent()).toBe(text)
      expect(await page.getByRole('button', { name: 'Send now', exact: true }).count()).toBe(0)
    } finally {
      done()
      await page.close()
    }
  }, 30_000)
  test('a tap asks its pane for it once, and a screen that offers nothing says so, then lets it be tried again', async () => {
    const done = atWork()
    const acted: Action[] = []
    let answer: unknown = { ok: true }
    const act = world.act.bind(world)
    world.act = async (a: Action) => {
      if (a.type !== 'steer') return act(a)
      acted.push(a)
      return answer
    }
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
    const text = 'And update the changelog'
    /** what the server was told, once the tap's answer has landed */
    const told = async (n: number) => {
      for (let i = 0; i < 100 && acted.length < n; i++) await Bun.sleep(50)
      return acted
    }
    try {
      await page.goto(url())
      const box = page.getByRole('textbox', { name: /Message/ })
      await box.waitFor()
      await box.fill(text)
      await page.getByRole('button', { name: 'Send' }).click()
      const bubble = page.locator('[data-msg^="out:"]').filter({ hasText: text })
      const now = bubble.getByRole('button', { name: 'Send now', exact: true })
      await now.waitFor()
      await now.click()
      expect(await told(1)).toEqual([{ type: 'steer', chat: KEY }])
      // still in its queue: Send now is there for the next tap, and that one asks again, once
      await now.waitFor()
      await now.click()
      expect(await told(2)).toHaveLength(2)
      // the screen offered nothing: why, in place of Send now, and the words stay; a moment later it can be tried again
      answer = { ok: false, error: "It couldn't take it now." }
      await now.waitFor()
      await now.click()
      await bubble.getByText("It couldn't take it now.", { exact: false }).waitFor()
      expect(await bubble.textContent()).toContain("Queued · It couldn't take it now.")
      expect(await bubble.locator('[data-text]').textContent()).toBe(text)
      expect(await told(3)).toHaveLength(3)
      await now.waitFor({ timeout: 10_000 })
    } finally {
      world.act = act
      done()
      await page.close()
    }
  }, 40_000)
})
