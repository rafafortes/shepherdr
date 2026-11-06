// Send now on a message Claude Code holds in its own queue: the line under your bubble, and what a tap asks for, in a
// real browser (layout.ts). The press itself, read off the pane, is source.test.ts's with a fake pane.
import { describe, expect, test } from 'bun:test'
import { layout } from './layout.ts'
import type { Action } from '../shared/types.ts'

const { browser, world, url } = await layout()

/** the chat the demo opens at: the home space's coordinator, on Claude Code */
const KEY = 'p:vm-str:~'
const emit = (key: string) => (world as unknown as { emit(e: string, k: string): void }).emit('chat', key)

/** one of yours still in its CLI's queue: the screen keeps it until the agent's log has it (src/outbox.ts) */
const stillQueued = (text: string) => ({ cid: 'queued-1', chat: KEY, text, files: [], at: Date.now(), state: 'sent', serverAt: Date.now() })

/** it at work, and one of your messages the log doesn't have yet: the browser opens on both */
async function opened(text: string) {
  const chat = world.chats[KEY]
  chat.working = true
  const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
  await page.addInitScript((o) => localStorage.setItem('shepherdr.outbox', JSON.stringify([o])), stillQueued(text))
  await page.goto(url())
  const bubble = page.locator('[data-msg^="out:"]').filter({ hasText: text })
  await bubble.waitFor()
  return { page, chat, bubble, now: bubble.getByRole('button', { name: 'Send now', exact: true }) }
}

describe.skipIf(!browser)("Send now on a message in Claude Code's queue", () => {
  test('it shows on one still in its queue while the agent works, and on Claude Code alone', async () => {
    const text = 'Also rerun the flaky test'
    const { page, chat, bubble, now } = await opened(text)
    const agent = chat.agent!
    try {
      await now.waitFor()
      expect(await bubble.textContent()).toContain('Queued · Send now')
      // another CLI keeps its own queue and has no such key: nothing to press, and nothing said
      chat.agent = { ...agent, kind: 'pi' }
      emit(KEY)
      await now.waitFor({ state: 'detached' })
      expect(await bubble.textContent()).toBe(text)
      // Claude Code again, but its turn is over: what it queued goes in on its own
      chat.agent = agent
      chat.working = false
      emit(KEY)
      await page.waitForFunction((t) => document.querySelector(`[data-msg^="out:"]`)?.textContent === t, text)
      expect(await now.count()).toBe(0)
      // at work again: the same message is still in its queue, and can be taken now
      chat.working = true
      emit(KEY)
      await now.waitFor()
    } finally {
      chat.agent = agent
      chat.working = undefined
      emit(KEY)
      await page.close()
    }
  }, 30_000)
  test('a tap asks its pane for it once, stays for the next one, and says why when it could not', async () => {
    const text = 'And update the changelog'
    const acted: Action[] = []
    let answer: unknown = { ok: true }
    const act = world.act.bind(world)
    world.act = async (a: Action) => {
      if (a.type !== 'steer') return act(a)
      acted.push(a)
      return answer
    }
    const { page, chat, bubble, now } = await opened(text)
    /** what the server was told, once the tap's answer has landed */
    const told = async (n: number) => {
      for (let i = 0; i < 100 && acted.length < n; i++) await Bun.sleep(50)
      return acted
    }
    try {
      await now.click()
      expect(await told(1)).toEqual([{ type: 'steer', chat: KEY }])
      // still in its queue: Send now is there for the next tap, and that one asks again, once
      await now.waitFor()
      await now.click()
      expect(await told(2)).toHaveLength(2)
      // its screen offered nothing: the reason it couldn't, in place of Send now, and the words stay
      answer = { ok: false, error: "It couldn't take it now." }
      await now.waitFor()
      await now.click()
      await bubble.getByText("It couldn't take it now.", { exact: false }).waitFor()
      expect(await bubble.textContent()).toContain("Queued · It couldn't take it now.")
      expect(await bubble.locator('[data-text]').textContent()).toBe(text)
      expect(await told(3)).toHaveLength(3)
      expect(await now.count()).toBe(0)
    } finally {
      world.act = act
      chat.working = undefined
      emit(KEY)
      await page.close()
    }
  }, 30_000)
})
