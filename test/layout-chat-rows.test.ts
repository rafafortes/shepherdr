// A chat push sends the whole chat again, but only the rows whose message changed may redraw. The counter is the test
// hook in plugins/chat/rows.ts: the app never sets it, this file does, and Bubble/Album count one render per row.
import { describe, expect, test } from 'bun:test'
import { layout, until } from './layout.ts'
import type { Action, Message } from '../shared/types.ts'

const { browser, world, url, server } = await layout()

/** the chat the demo opens at: the home space's coordinator */
const KEY = 'p:vm-str:~'
const emit = () => (world as unknown as { emit(e: string, k: string): void }).emit('chat', KEY)

type Counts = Record<string, number>
const counts = (page: { evaluate<T>(f: () => T): Promise<T> }) => page.evaluate(() => ({ ...(window as unknown as { shepRenderCount: Counts }).shepRenderCount }))
/** what redrew since the last reading, by row key; 'app' is the layout probe, not a row */
const drawn = (now: Counts, before: Counts) =>
  Object.entries(now)
    .filter(([k, n]) => k !== 'app' && n > (before[k] ?? 0))
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

      // a reaction on one message redraws that message alone (row-280: in the rendered window, the older rows
      // are outside it, and reaching them is the window's own test)
      chat.messages.find((m) => m.id === 'row-280')!.reactions = [{ emoji: '👍', by: 'them' }]
      emit()
      await until(
        () => counts(page),
        (c) => c[`${KEY}:row-280`] === 1,
      )
      const reacted = await counts(page)
      expect(drawn(reacted, added)).toEqual([`${KEY}:row-280`])

      // an edit to one message redraws that message alone
      chat.messages.find((m) => m.id === 'row-270')!.text = 'An edited message'
      emit()
      await until(
        () => counts(page),
        (c) => c[`${KEY}:row-270`] === 1,
      )
      const edited = await counts(page)
      expect(drawn(edited, reacted)).toEqual([`${KEY}:row-270`])

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

describe.skipIf(!browser)('a snapshot push redraws only when its revision changed', () => {
  test('a heartbeat with the same revision redraws nothing, then one task changed redraws the layout', async () => {
    const pushSnap = () => (world as unknown as { emit(e: string): void }).emit('snapshot')
    const heartbeat = () => (world as unknown as { emit(e: string): void }).emit('heartbeat')
    // a second socket to the same server sees the same broadcasts, just after the page (it connected later). Waiting
    // for it is how the test knows a snapshot reached the screen, rather than guessing at the server's debounce.
    const observer = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws`)
    const revs: number[] = []
    observer.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { type: string; snapshot?: { rev?: number } }
      if (msg.type === 'snapshot') revs.push(msg.snapshot?.rev ?? 0)
    }
    await new Promise<void>((r) => (observer.onopen = () => r()))
    if (!browser) return
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(url())
      await page.locator('[data-device]').waitFor()
      await until(
        () => counts(page),
        (c) => (c.app ?? 0) > 0,
      )
      // let any snapshot queued while the page opened land before the one whose cost is measured
      await Bun.sleep(100)
      const settled = revs.length
      await page.evaluate(() => {
        ;(window as unknown as { shepRenderCount: Counts }).shepRenderCount = {}
      })

      // the 30-second heartbeat: the server pushes a snapshot whose revision did not move. A chat message after it
      // is an ordering barrier: the observer says the snapshot was broadcast, and the barrier says the page read it.
      heartbeat()
      await until(
        () => Promise.resolve(revs.length),
        (n) => n > settled,
      )
      world.chats[KEY].messages.push({ id: 'snap-barrier', who: 'agent', text: 'Barrier for the snapshot test', at: Date.now() })
      emit()
      await page.getByText('Barrier for the snapshot test').waitFor()
      expect((await counts(page)).app ?? 0).toBe(0)

      // a task name that really changed advances the revision: the layout draws again
      const afterHeartbeat = revs.length
      const name = `Renamed for the snapshot test ${Date.now()}`
      world.tasks[0].name = name
      pushSnap()
      await until(
        () => Promise.resolve(revs.length),
        (n) => n > afterHeartbeat,
      )
      await until(
        () => counts(page),
        (c) => (c.app ?? 0) > 0,
      )
    } finally {
      observer.close()
      await page.close()
    }
  }, 60_000)
})
