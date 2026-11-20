// biome-ignore-all lint/style/noNonNullAssertion: the demo chat and the browser are there once the page has opened
// Screen-reader announcements for new chat messages (A11Y-01), in real browsers against the demo world. The rows are
// memoized and windowed, so the announcer reads the store; these tests read the sr-only live region's textContent.
// The lead asked for both engines: Chromium and WebKit (Safari's engine, the phone) each run the same suite.
import { describe, expect, test } from 'bun:test'
import { devices, type Page } from 'playwright-core'
import { layout } from './layout.ts'
import type { Message } from '../shared/types.ts'

type World = Awaited<ReturnType<typeof layout>>
type Ctx = { browser: World['browser']; world: World['world']; url: () => string }

/** the chat the demo opens at: the home space's coordinator */
const KEY = 'p:vm-str:~'
const region = (page: Page) => page.locator('[data-announce]')
/** the chat's scroll box (the overflow of StickToBottom) */
const box = (page: Page) => page.locator('[data-msg]').first().locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]')

/** waits until it holds, or says what did not arrive */
async function waitFor(read: () => Promise<boolean> | boolean, what: string) {
  for (let i = 0; i < 60; i++) {
    if (await read()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out: ${what}`)
}

function suite(engine: string, ctx: Ctx) {
  const { browser, world, url } = ctx
  const emit = () => (world as unknown as { emit(e: string, k: string): void }).emit('chat', KEY)
  let n = 0
  /** a new message in the demo chat's log: `who` says who sent it, `peer` the declared name of another agent */
  function say(text: string, who: Message['who'] = 'agent', peer?: string) {
    const c = world.chats[KEY]!
    c.messages.push({
      id: `announce-${engine}-${++n}`,
      who,
      text,
      ...(peer ? { peer: { name: peer } } : {}),
      at: Date.now() + 2000 + n,
    })
    emit()
  }
  const open = async () => {
    const context = await browser!.newContext(
      engine === 'WebKit' ? { ...devices['iPhone 15'], viewport: { width: 393, height: 793 }, reducedMotion: 'reduce' } : { viewport: { width: 390, height: 844 } },
    )
    try {
      const page = await context.newPage()
      const old = [...world.chats[KEY]!.messages]
      await page.goto(url())
      const live = region(page)
      await live.waitFor()
      // nothing already in the chat when it opened is replayed
      expect(await live.textContent()).toBe('')
      return { page, live, restore: () => (world.chats[KEY]!.messages = old), close: () => context.close() }
    } catch (e) {
      await context.close()
      throw e
    }
  }

  describe.skipIf(!browser)(`new chat messages are announced to a screen reader (${engine})`, () => {
    test('a reply is announced with its sender and first words; your own, and a second inside the window, are not', async () => {
      const { page, live, restore, close } = await open()
      try {
        const words = `The build passed on main and the deploy is green. ${'X'.repeat(100)}`
        say(words)
        await waitFor(async () => (await live.textContent())?.includes('The build passed') ?? false, 'first announcement')
        // the sender, the start of the words, and no more than 120 of them
        expect(await live.textContent()).toBe(`home: ${words.slice(0, 120)}`)

        const first = await live.textContent()
        const later = 'A second reply, still inside the two-second window.'
        say(later)
        say('My own words', 'you')
        await page.waitForTimeout(300)
        expect(await live.textContent()).toBe(first)
        // held for the rest of the window, then said once: coalesced, not dropped
        await waitFor(async () => (await live.textContent())?.includes(later) ?? false, 'coalesced announcement')
        expect(await live.textContent()).toBe(`home: ${later}`)
      } finally {
        restore()
        await close()
      }
    })

    test('ten replies arriving together are one announcement, of the last', async () => {
      const { live, restore, close } = await open()
      try {
        for (let i = 0; i < 10; i++) {
          world.chats[KEY]!.messages.push({ id: `batch-${engine}-${i}`, who: 'agent', text: `Batch reply number ${i}`, at: Date.now() + 3000 + i })
        }
        emit()
        await waitFor(async () => (await live.textContent())?.includes('Batch reply number 9') ?? false, 'batch announcement')
        expect(await live.textContent()).toBe('home: Batch reply number 9')
      } finally {
        restore()
        await close()
      }
    })

    test('a text-less update in the same batch does not swallow the reply that has words', async () => {
      const { live, restore, close } = await open()
      try {
        world.chats[KEY]!.messages.push({ id: `quiet-${engine}`, who: 'agent', text: 'A reply with words.', at: Date.now() + 2500 })
        world.chats[KEY]!.messages.push({ id: `wake-${engine}`, who: 'agent', pilot: 'Autopilot woke · nothing to report', at: Date.now() + 2501 })
        emit()
        await waitFor(async () => (await live.textContent())?.includes('A reply with words.') ?? false, 'reply among quiet lines')
        expect(await live.textContent()).toBe('home: A reply with words.')
      } finally {
        restore()
        await close()
      }
    })

    test("another agent's relay is announced under the name it declares", async () => {
      const { live, restore, close } = await open()
      try {
        say('SHE-42 finished the audit.', 'peer', 'SHE-42 agent')
        await waitFor(async () => (await live.textContent())?.includes('finished the audit') ?? false, 'peer announcement')
        expect(await live.textContent()).toBe('SHE-42 agent: SHE-42 finished the audit.')
      } finally {
        restore()
        await close()
      }
    })

    test('a picture alone is announced as sent a picture', async () => {
      const { live, restore, close } = await open()
      try {
        world.chats[KEY]!.messages.push({ id: `announce-pic-${engine}`, who: 'agent', file: { name: 'shot.png', path: '~/inbox/shot.png' }, at: Date.now() + 4000 })
        emit()
        await waitFor(async () => (await live.textContent())?.includes('sent a picture') ?? false, 'picture announcement')
        expect(await live.textContent()).toBe('home: sent a picture')
      } finally {
        restore()
        await close()
      }
    })

    test('a message arriving while the reader is up reading old messages is not announced (the unread jump still shows)', async () => {
      const { page, live, restore, close } = await open()
      try {
        await page.locator('[data-msg]').first().waitFor()
        // read further up: the same condition the unread marker and the jump use. Settle at the bottom first, so the
        // box's last known scroll is the bottom and the trip up reads as scrolling away, not as its first paint.
        const b = box(page)
        await b.evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
        // WebKit under load can still be laying out after the scroll to the bottom, and can snap a programmatic trip
        // back up before it fires the scroll event that marks the reader as reading back. Wait for the bottom, then
        // use the app's own unpin (a jump to a message) with an explicit scroll event so the jump shows reliably.
        await waitFor(async () => await b.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 8), 'settled at the bottom')
        await b.evaluate((el) => {
          el.dispatchEvent(new Event('chat-jump'))
          el.scrollTop = 0
          el.dispatchEvent(new Event('scroll', { bubbles: true }))
        })
        await page.locator('button[aria-label*="latest"]').waitFor()

        // WebKit under a loaded gate can take longer than the default 20 s to scroll up, settle and show the jump
        say('A reply you did not hear while reading back.')
        await page.locator('button[aria-label*="new reply"]').waitFor()
        await page.waitForTimeout(300)
        expect(await live.textContent()).toBe('')
      } finally {
        restore()
        await close()
      }
    }, 60_000)
  })
}

suite('Chromium', await layout())
suite('WebKit', await layout({ webkit: true }))
