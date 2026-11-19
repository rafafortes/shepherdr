// A chat push sends the whole chat again, but only the rows whose message changed may redraw. The counter is the test
// hook in plugins/chat/rows.ts: the app never sets it, this file does, and Bubble/Album count one render per row.
import { describe, expect, test } from 'bun:test'
import { layout, until } from './layout.ts'
import type { Action, Message } from '../shared/types.ts'

const { browser, world, url } = await layout()

/** the chat the demo opens at: the home space's coordinator */
const KEY = 'p:vm-str:~'
const emit = () => (world as unknown as { emit(e: string, k: string): void }).emit('chat', KEY)

type Counts = Record<string, number>
const counts = (page: { evaluate<T>(f: () => T): Promise<T> }) => page.evaluate(() => ({ ...(window as unknown as { shepRenderCount: Counts }).shepRenderCount }))
/** what redrew since the last reading, by row key */
const drawn = (now: Counts, before: Counts) =>
  Object.entries(now)
    .filter(([k, n]) => n > (before[k] ?? 0))
    .map(([k]) => k)

describe.skipIf(!browser)('chat rows redraw only when their message changes', () => {
  test('a 300-message chat redraws only the new row, then only the row that reacted or changed', async () => {
    const chat = world.chats[KEY]
    const base = Date.now() - 300_000
    chat.messages = Array.from({ length: 300 }, (_, i): Message => ({ id: `row-${i}`, who: 'agent', text: `Message ${i}`, at: base + i * 1000 }))
    // two pictures sent together are one album row (Album, not Bubble, is the one that redraws)
    chat.messages.push(
      { id: 'pic-1', who: 'agent', file: { name: 'one.png', path: '/one.png' }, at: base + 300_000, cid: 'album-cid' },
      { id: 'pic-2', who: 'agent', file: { name: 'two.png', path: '/two.png' }, at: base + 300_000, cid: 'album-cid' },
    )
    // a card and a message waiting on it: answering must redraw the card's row, and take the "Go to question" link
    // out of the waiting row without redrawing the waiting bubble itself
    chat.messages.push(
      { id: 'row-question', who: 'agent', question: { id: 'q:rows', title: 'Which one?', kind: 'Form', choices: [{ label: 'A' }, { label: 'B' }], to: 'test' }, at: base + 301_000 },
      { id: 'row-waiting', who: 'agent', text: 'Waiting for your answer above.', waiting: true, waitsFor: 'menu', at: base + 302_000 },
    )
    emit()
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(url())
      await page.locator('[data-msg="pic-2"]').waitFor()
      await page.locator('[data-msg="row-waiting"]').getByRole('button', { name: 'Go to question' }).waitFor()
      await page.evaluate(() => {
        ;(window as unknown as { shepRenderCount: Counts }).shepRenderCount = {}
      })

      // one new message: only its row draws, not the old last one, the album, or any of the 300 before it
      chat.messages.push({ id: 'row-new', who: 'agent', text: 'A new message', at: base + 303_000 })
      emit()
      await until(
        () => counts(page),
        (c) => c[`${KEY}:row-new`] === 1,
      )
      const added = await counts(page)
      expect(drawn(added, {})).toEqual([`${KEY}:row-new`])

      // a reaction on one message redraws that message alone
      chat.messages.find((m) => m.id === 'row-10')!.reactions = [{ emoji: '👍', by: 'them' }]
      emit()
      await until(
        () => counts(page),
        (c) => c[`${KEY}:row-10`] === 1,
      )
      const reacted = await counts(page)
      expect(drawn(reacted, added)).toEqual([`${KEY}:row-10`])

      // an edit to one message redraws that message alone
      chat.messages.find((m) => m.id === 'row-20')!.text = 'An edited message'
      emit()
      await until(
        () => counts(page),
        (c) => c[`${KEY}:row-20`] === 1,
      )
      const edited = await counts(page)
      expect(drawn(edited, reacted)).toEqual([`${KEY}:row-20`])

      // answering the card redraws its row (and the new rows the answer brings), not the 300 existing rows or the
      // waiting one; GoToQuestion is its own subscriber, so its link goes without redrawing the waiting bubble
      const beforeAnswer = new Set(chat.messages.map((m) => `${KEY}:${m.id}`))
      await world.act({ type: 'answer', chat: KEY, question: 'q:rows', choice: 0, choices: [0, 1] } as Action)
      await page.getByText('Answered “Which one?”', { exact: false }).waitFor()
      await page.locator('[data-msg="row-waiting"]').getByRole('button', { name: 'Go to question' }).waitFor({ state: 'detached' })
      const answered = await counts(page)
      expect(drawn(answered, edited).filter((k) => beforeAnswer.has(k))).toEqual([`${KEY}:row-question`])

      // a push that changes no message (the log became unreadable) redraws no row at all. Wait for its own line,
      // not a blind sleep: a push under load can take longer than a fixed pause to reach the screen.
      chat.unreadable = 'Cannot read this log'
      emit()
      await page.getByText('Cannot read this log').waitFor()
      const idle = await counts(page)
      expect(drawn(idle, answered)).toEqual([])
    } finally {
      await page.close()
    }
  }, 60_000)
})
