// Choice cards: ordinary answers, deliberate approvals, forwarded sources and accessible controls.
import { describe, expect, test } from 'bun:test'
import { layout } from './layout.ts'
import type { Action } from '../shared/types.ts'

const until = async (f: () => boolean, ms = 5000) => {
  for (const t0 = Date.now(); !f(); await Bun.sleep(20)) if (Date.now() - t0 > ms) throw new Error('timed out')
}
const { browser, server, world, url } = await layout()

describe.skipIf(!browser)('answer cards', () => {
  const at = (q: string) => `http://127.0.0.1:${server!.port}/?${q}`

  test('ordinary choice buttons send once; Add a note keeps a draft and explicit Send', async () => {
    const chat = world.chats['p:vm-str:~']
    const q = { id: 'fast:q', title: 'Which colour?', kind: 'Form' as const, ordinary: true, choices: [{ label: 'Blue' }, { label: 'Green' }], to: 'LV-3 agent' }
    chat.messages.push({ id: 'fast-copy', who: 'agent', at: Date.now(), card: { id: 'fast-copy', task: 'LV-3', status: 'need', text: 'needs you', ask: { chat: 'LV-3/Agent', open: true, questions: [q] } } })
    const sent: Action[] = []
    const act = world.act
    let finish: (() => void) | undefined
    world.act = async (a: Action) => {
      if (a.type !== 'answer') return act(a)
      sent.push(a)
      await new Promise<void>((resolve) => { finish = resolve })
      return { ok: true }
    }
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
    try {
      await page.goto(url())
      const card = page.locator('[data-whole="fast-copy"] [data-card]')
      await card.waitFor()
      expect(await card.getByRole('button', { name: 'Send', exact: true }).count()).toBe(0)
      const blue = card.getByRole('button', { name: 'Send: Blue', exact: true })
      expect((await blue.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      expect(await blue.getAttribute('aria-pressed')).toBeNull()
      await card.getByRole('button', { name: 'Add a note', exact: true }).tap()
      const note = card.getByRole('textbox', { name: 'Note', exact: true })
      expect(await note.evaluate((el) => el === document.activeElement)).toBe(true)
      await note.fill('the darker one')
      expect(await note.inputValue()).toBe('the darker one')
      await card.getByRole('button', { name: 'Green', exact: true }).tap()
      expect(sent.length).toBe(0)
      const send = card.getByRole('button', { name: 'Send', exact: true })
      await send.focus()
      await page.keyboard.press('Enter')
      await until(() => sent.length === 1)
      expect(sent[0]).toMatchObject({ type: 'answer', chat: 'LV-3/Agent', question: q.id, choice: 1, note: 'the darker one', space: chat.key })
      expect(await send.isDisabled()).toBe(true)
      finish!()
      // A successful request stays locked while its answered snapshot is still on the way.
      await page.waitForTimeout(100)
      expect(await send.isDisabled()).toBe(true)
      const copy = chat.messages.find((m) => m.id === 'fast-copy')!.card!.ask!
      copy.questions = [{ ...q, sent: 1, elsewhere: { label: 'Answered in', chat: 'LV-3/Agent', name: 'LV-3 chat' } }]
      await page.reload()
      expect(await card.locator('[data-card-source]').textContent()).toBe('LV-3 · Upload page for files')
      expect(await card.textContent()).toContain('Answered inLV-3 chat')
      expect(await card.getByRole('button', { name: 'Green', exact: true }).getAttribute('aria-pressed')).toBe('true')
      expect(sent.length).toBe(1)
      // A new ordinary card: Enter on the clearly named choice sends without a second Send.
      copy.questions = [{ ...q, id: 'fast:next' }]
      await page.reload()
      await blue.focus()
      await page.keyboard.press('Enter')
      await until(() => sent.length === 2)
      expect(sent[1]).toMatchObject({ type: 'answer', chat: 'LV-3/Agent', question: 'fast:next', choice: 0, space: chat.key })
      expect(await blue.isDisabled()).toBe(true)
      await blue.evaluate((el: HTMLButtonElement) => el.click())
      expect(sent.length).toBe(2)
      finish!()
    } finally {
      finish?.()
      world.act = act
      chat.messages = chat.messages.filter((m) => m.id !== 'fast-copy')
      await page.close()
    }
  }, 30_000)

  test('permissions, startup prompts, plans, multiple picks, required notes and unknown cards keep confirmation', async () => {
    const chat = world.chats['p:vm-str:~']
    const base = { title: 'Choose', kind: 'Form' as const, ordinary: true, choices: [{ label: 'First' }, { label: 'Second' }], to: 'home' }
    const cases = [
      { ordinary: undefined, kind: 'Question' as const, title: 'Allow writing files?' },
      { terminal: true, noNote: true, title: 'Trust this folder?' },
      { kind: 'Plan' as const, steps: ['Build it'] },
      { multi: true },
      { noteRequiredFor: 0 },
      { kind: 'Future' as unknown as 'Form' },
      { id: 'menu:permission' },
    ]
    chat.messages.push(...cases.map((c, i) => ({ id: `safe-${i}`, who: 'agent' as const, at: Date.now() + i, question: { ...base, id: `safe:${i}`, ...c } })))
    const sent: Action[] = []
    const act = world.act
    world.act = async (a: Action) => a.type === 'answer' ? (sent.push(a), { ok: true }) : act(a)
    const page = await browser!.newPage({ viewport: { width: 820, height: 1180 }, hasTouch: true })
    try {
      await page.goto(url())
      for (let i = 0; i < cases.length; i++) {
        const card = page.locator(`[data-whole="safe-${i}"] [data-card]`)
        const send = card.getByRole('button', { name: 'Send', exact: true })
        expect(await send.isDisabled()).toBe(true)
        const first = card.getByRole('button', { name: 'First', exact: true })
        await first.tap()
        expect(await first.getAttribute('aria-pressed')).toBe('true')
        expect(sent.length).toBe(0)
        expect(await send.isEnabled()).toBe(true)
      }
      const required = page.locator('[data-whole="safe-4"] [data-card]')
      await required.getByRole('button', { name: 'Send', exact: true }).click()
      expect(sent.length).toBe(0)
      expect(await required.getByRole('textbox', { name: 'Note' }).evaluate((el) => el === document.activeElement)).toBe(true)
    } finally {
      world.act = act
      chat.messages = chat.messages.filter((m) => !m.id.startsWith('safe-'))
      await page.close()
    }
  }, 30_000)

  test('an unreadable startup prompt keeps its screen and offers the terminal without a dead Send button', async () => {
    const chat = world.chats['p:vm-str:~']
    chat.messages.push({ id: 'startup-fallback', who: 'agent', at: Date.now(), question: { id: 'menu:fallback', title: 'The terminal is waiting for you', screen: 'A CLI asks for your input', terminal: true, noNote: true, kind: 'Form', choices: [], to: 'home' } })
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(url())
      const card = page.locator('[data-whole="startup-fallback"] [data-card]')
      await card.waitFor()
      expect(await card.locator('pre').textContent()).toBe('A CLI asks for your input')
      expect(await card.getByRole('button', { name: 'Open terminal', exact: true }).count()).toBe(1)
      expect(await card.getByRole('button', { name: 'Send', exact: true }).count()).toBe(0)
      expect(await card.getByRole('textbox', { name: 'Note' }).count()).toBe(0)
    } finally {
      chat.messages = chat.messages.filter((m) => m.id !== 'startup-fallback')
      await page.close()
    }
  }, 30_000)

  test("a needs-you card answers its task's question right in the space's chat, and says where once answered", async () => {
    const chat = world.chats['p:vm-str:~']
    const now = Date.now()
    const q = { id: 'ask:copy', title: 'Which colour?', kind: 'Form' as const, choices: [{ label: 'Blue' }, { label: 'Green' }], to: 'LV-3 agent' }
    chat.messages.push(
      { id: 'ask-done', who: 'agent', at: now - 2, card: { id: 'ask-done', task: 'LV-3', status: 'need', text: 'needs you: Question for you', ask: { chat: 'LV-3/Agent', answered: { where: 'space' }, questions: [{ ...q, id: 'ask:old', sent: 0, elsewhere: { label: 'Answered here ·', chat: 'LV-3/Agent', name: 'LV-3 chat' } }] } } },
      { id: 'ask-reply', who: 'agent', at: now - 1, card: { id: 'ask-reply', task: 'LV-3', status: 'need', text: 'needs you: Waits for your reply', ask: { chat: 'LV-3/Agent', open: true, reply: { id: 'lv3-q', text: 'Keep the old API around?' } } } },
      { id: 'ask-open', who: 'agent', at: now, card: { id: 'ask-open', task: 'LV-3', status: 'need', text: 'needs you: Question for you', ask: { chat: 'LV-3/Agent', open: true, questions: [q] } } },
    )
    const sent: Action[] = []
    const act = world.act
    world.act = async (a: Action) => (a.type === 'answer' || (a.type === 'send' && a.chat === 'LV-3/Agent') ? (sent.push(a), { ok: true }) : act(a))
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(url())
      const card = page.locator('[data-whole="ask-open"] [data-card]')
      await card.waitFor()
      expect(await card.locator('[data-card-source]').textContent()).toBe('LV-3 · Upload page for files')
      await card.getByRole('button', { name: 'Green' }).click()
      await card.getByRole('textbox', { name: 'Note' }).fill('the darker one')
      await card.getByRole('button', { name: 'Send', exact: true }).click()
      await until(() => sent.length > 0)
      expect(sent[0]).toMatchObject({ type: 'answer', chat: 'LV-3/Agent', question: 'ask:copy', choice: 1, note: 'the darker one', space: 'p:vm-str:~' })
      // a plain question: its words and a reply box
      const reply = page.locator('[data-whole="ask-reply"] [data-card]')
      expect(await reply.locator('[data-ask-text]').textContent()).toBe('Keep the old API around?')
      await reply.getByRole('textbox', { name: 'Reply to LV-3' }).fill('Yes, one more release')
      await reply.getByRole('button', { name: 'Send', exact: true }).click()
      await until(() => sent.length > 1)
      expect(sent[1]).toMatchObject({ type: 'send', chat: 'LV-3/Agent', text: 'Yes, one more release', reply: 'lv3-q', space: 'p:vm-str:~' })
      // answered: where, a link to the task's chat, and no Send
      const done = page.locator('[data-whole="ask-done"] [data-card]')
      expect(await done.textContent()).toContain('Answered here ·LV-3 chat')
      expect(await done.getByRole('button', { name: 'Send', exact: true }).count()).toBe(0)
      // Every copy keeps its source inside the card, including plain replies and answered cards.
      for (const c of [card, reply, done]) {
        expect(await c.locator('[data-card-source]').textContent()).toBe('LV-3 · Upload page for files')
        expect((await c.boundingBox())!.width).toBeLessThanOrEqual(390)
      }
    } finally {
      world.act = act
      chat.messages = chat.messages.filter((m) => !m.id.startsWith('ask-'))
      await page.close()
    }
  }, 30_000)

  for (const width of [390, 1440])
    test(`forwarded permission cards keep their source and answer routing (${width}px)`, async () => {
      const task = world.tasks.find((t) => t.id === 'LV-3')!
      const oldName = task.name
      task.name = 'Upload page for files with resumable transfers and a readable progress indicator on every device'
      const chat = world.chats['p:vm-str:~']
      const q = { id: 'source:permission', title: 'Allow writing the upload route?', kind: 'Question' as const, choices: [{ label: 'Allow once' }, { label: 'Deny' }], to: 'LV-3 agent' }
      chat.messages.push(
        { id: 'source-permission', who: 'agent', at: Date.now(), card: { id: 'source-permission', task: 'LV-3', status: 'need', text: 'needs you: Asks permission', ask: { chat: 'LV-3/Agent', open: true, questions: [q] } } },
        { id: 'source-missing', who: 'agent', at: Date.now() + 1, card: { id: 'source-missing', task: 'MISSING-1', status: 'need', text: 'needs you', ask: { chat: 'MISSING-1/Agent', questions: [{ ...q, id: 'source:missing' }] } } },
      )
      const sent: Action[] = []
      const act = world.act
      world.act = async (a: Action) => a.type === 'answer' ? (sent.push(a), { ok: true }) : act(a)
      const page = await browser!.newPage({ viewport: { width, height: 900 } })
      try {
        await page.goto(url())
        const card = page.locator('[data-whole="source-permission"] [data-card]')
        await card.waitFor()
        const source = card.locator('[data-card-source]')
        expect(await source.textContent()).toBe(`LV-3 · ${task.name}`)
        expect(await card.locator('[data-card-title]').textContent()).toBe(q.title)
        const size = await source.evaluate((el) => ({ width: el.clientWidth, content: el.scrollWidth, height: el.clientHeight, contentHeight: el.scrollHeight }))
        expect(size.content).toBeLessThanOrEqual(size.width)
        expect(size.contentHeight).toBeLessThanOrEqual(size.height)
        expect((await card.boundingBox())!.width).toBeLessThanOrEqual(Math.min(width, 440))
        expect(await card.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true)
        await card.getByRole('button', { name: 'Allow once', exact: true }).click()
        await card.getByRole('button', { name: 'Send', exact: true }).click()
        await until(() => sent.length > 0)
        expect(sent[0]).toMatchObject({ type: 'answer', chat: 'LV-3/Agent', question: q.id, choice: 0, space: 'p:vm-str:~' })
        // A later snapshot (answered in the task chat) preserves the source on the forwarded copy.
        const copy = chat.messages.find((m) => m.id === 'source-permission')!.card!.ask!
        copy.open = false
        copy.questions = [{ ...q, sent: 0, elsewhere: { label: 'Answered in', chat: 'LV-3/Agent', name: 'LV-3 chat' } }]
        await page.reload()
        await card.waitFor()
        expect(await source.textContent()).toBe(`LV-3 · ${task.name}`)
        expect(await card.textContent()).toContain('Answered inLV-3 chat')
        expect(await card.getByRole('button', { name: 'Send', exact: true }).count()).toBe(0)
        expect(await page.locator('[data-whole="source-missing"] [data-card-source]').textContent()).toBe('MISSING-1')
      } finally {
        task.name = oldName
        world.act = act
        chat.messages = chat.messages.filter((m) => !m.id.startsWith('source-'))
        await page.close()
      }
    }, 30_000)

  test('a choice card starts with nothing picked: Send waits for a pick or a typed answer', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(at('place=p:mac:lilla-varlden&task=LV-3'))
    const card = page.locator('[data-card]').filter({ hasText: 'Which upload limit?' })
    await card.waitFor()
    expect(await card.locator('[data-card-source]').count()).toBe(0)
    expect(await card.locator('button[aria-pressed=true]').count()).toBe(0)
    const send = card.getByRole('button', { name: 'Send', exact: true })
    expect(await send.isDisabled()).toBe(true)
    await card.getByRole('textbox', { name: 'Other answer' }).fill('1 GB')
    expect(await send.isDisabled()).toBe(false)
    await card.getByRole('textbox', { name: 'Other answer' }).fill('')
    expect(await send.isDisabled()).toBe(true)
    await card.getByRole('button', { name: /^50 MB per file/ }).click()
    expect(await send.isDisabled()).toBe(false)
    await page.close()
  }, 30_000)

  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ] as const)
    test(`a long question wraps on its card (${name}), the ? on its first line, and each choice's description in grey under it`, async () => {
      const title = "Should the rebuilt workflow also read the founders' own LinkedIn profiles and recent posts, or only the company page as before?"
      world.chats['p:vm-str:~'].messages.push({
        id: 'long-q',
        who: 'agent',
        at: Date.now(),
        question: { id: 'menu:long-q', title, kind: 'Form', to: 'home', asks: 'Claude Code asks', choices: [{ label: 'Company page only', description: 'Same as before: just the company page' }, { label: 'Company page and founders', description: "Also read each founder's profile" }] },
      })
      const page = await browser!.newPage({ viewport, hasTouch: name === 'phone' })
      await page.goto(url())
      const card = page.locator('[data-whole="long-q"] [data-card]')
      await card.waitFor()
      const head = card.locator('[data-card-title]')
      // all of it, over more than one line
      expect(await head.textContent()).toBe(title)
      const t = await head.evaluate((el) => ({ lines: el.getClientRects().length, h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight), top: el.getBoundingClientRect().top, cut: el.scrollWidth > el.clientWidth }))
      expect(t.h).toBeGreaterThan(t.lh * 1.5)
      expect(t.cut).toBe(false)
      // the ? sits in the middle of the first line
      const icon = (await head.evaluate((el) => el.previousElementSibling!.getBoundingClientRect().toJSON())) as { top: number; height: number }
      expect(Math.abs(icon.top + icon.height / 2 - (t.top + t.lh / 2))).toBeLessThan(1.5)
      // the label on its line, the description in grey below it
      const choice = card.getByRole('button', { name: /^Company page only/ })
      const [label, desc] = await choice.evaluate((b) => [...b.querySelectorAll('span > span')].map((s) => ({ bottom: s.getBoundingClientRect().bottom, top: s.getBoundingClientRect().top, color: getComputedStyle(s).color })))
      expect(desc.top).toBeGreaterThanOrEqual(label.bottom - 1)
      expect(desc.color).not.toBe(label.color)
      world.chats['p:vm-str:~'].messages = world.chats['p:vm-str:~'].messages.filter((m) => m.id !== 'long-q')
      await page.close()
    }, 30_000)

  // SHEP-71: a card closed without an answer. Every question, permission and plan card has Dismiss (Esc on a card you
  // pressed), and what it sends is a dismissal, never a pick; the card says Dismissed afterwards.
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ] as const)
    test(`a question, a permission and a plan card each have Dismiss, and Esc on a pressed card does the same (${name})`, async () => {
      const chat = world.chats['p:vm-str:~']
      const now = Date.now()
      chat.messages.push(
        { id: 'dis-ask', who: 'agent', at: now, question: { id: 'ask:dis', title: 'Which colour?', kind: 'Form', choices: [{ label: 'Blue' }, { label: 'Green' }], to: 'LV-3 agent' } },
        { id: 'dis-plan', who: 'agent', at: now + 1, question: { id: 'plan:dis', title: 'Plan for LV-3', kind: 'Plan', steps: ['Build it'], choices: [{ label: 'Approve the plan' }, { label: 'Send it back with a note' }], noteRequiredFor: 1, to: 'LV-3 agent' } },
        { id: 'dis-perm', who: 'agent', at: now + 2, question: { id: 'menu:dis-perm', title: 'Allow writing files?', kind: 'Form', terminal: true, noNote: true, choices: [{ label: 'Yes' }, { label: 'No' }], to: 'LV-3 agent', asks: 'Claude Code asks' } },
        { id: 'dis-note', who: 'agent', at: now + 3, question: { id: 'ask:dis-note', title: 'Which branch?', kind: 'Question', choices: [{ label: 'main' }, { label: 'next' }], to: 'LV-3 agent' } },
        { id: 'dis-start', who: 'agent', at: now + 4, question: { id: 'menu:dis-start', title: 'Choose a login method:', kind: 'Form', terminal: true, noNote: true, choices: [{ label: 'Log in' }, { label: 'Skip' }], to: 'LV-3 agent', asks: 'Its screen waits', noDismiss: true } },
      )
      const sent: Action[] = []
      const act = world.act
      world.act = async (a: Action) => (a.type === 'answer' ? (sent.push(a), { ok: true }) : act(a))
      const page = await browser!.newPage({ viewport, hasTouch: name === 'phone' })
      try {
        await page.goto(url())
        for (const id of ['dis-ask', 'dis-plan', 'dis-perm']) {
          const card = page.locator(`[data-whole="${id}"] [data-card]`)
          await card.waitFor()
          const dismiss = card.getByRole('button', { name: 'Dismiss', exact: true })
          expect(await dismiss.count()).toBe(1)
          // a finger's reach on a phone
          expect((await dismiss.boundingBox())!.height).toBeGreaterThanOrEqual(name === 'phone' ? 44 : 20)
        }
        // a start stopped on its own screen: Esc there would end the launch, so it has none
        expect(await page.locator('[data-whole="dis-start"] [data-card]').getByRole('button', { name: 'Dismiss', exact: true }).count()).toBe(0)
        // Dismiss: closed without a pick, and nothing else goes with it
        const ask = page.locator('[data-whole="dis-ask"] [data-card]')
        await ask.getByRole('button', { name: 'Dismiss', exact: true }).click()
        await until(() => sent.length === 1)
        expect(sent[0]).toMatchObject({ type: 'answer', chat: chat.key, question: 'ask:dis', choice: -1, dismiss: true })
        expect((sent[0] as { choices?: unknown }).choices).toBeUndefined()
        expect((sent[0] as { other?: unknown }).other).toBeUndefined()
        // Esc on a card you pressed: the same, and the page stays where it was
        const plan = page.locator('[data-whole="dis-plan"] [data-card]')
        await plan.locator('[data-card-title]').click()
        expect(await plan.evaluate((el) => el === document.activeElement)).toBe(true)
        await page.keyboard.press('Escape')
        await until(() => sent.length === 2)
        expect(sent[1]).toMatchObject({ type: 'answer', chat: chat.key, question: 'plan:dis', choice: -1, dismiss: true })
        expect(await page.locator('[data-whole="dis-ask"]').count()).toBe(1)
        // Esc typed in the card's own box is the box's, not the card's
        const noted = page.locator('[data-whole="dis-note"] [data-card]')
        await noted.getByRole('textbox', { name: 'Note' }).click()
        await noted.getByRole('textbox', { name: 'Note' }).fill('half a thought')
        await page.keyboard.press('Escape')
        await page.waitForTimeout(150)
        expect(sent.length).toBe(2)
        // dismissed: the card says so, and asks nothing more
        for (const m of chat.messages)
          if (m.question && ['ask:dis', 'plan:dis', 'menu:dis-perm'].includes(m.question.id)) m.question = { ...m.question, sent: -1, dismissed: true, said: 'The person dismissed this without answering.' }
        await page.reload()
        const done = page.locator('[data-whole="dis-ask"] [data-card]')
        await done.waitFor()
        expect(await done.textContent()).toContain('Dismissed')
        // the words heard are the agent's, not a quote of an answer on the card
        expect(await done.textContent()).not.toContain('without answering')
        expect(await done.getByRole('button', { name: 'Dismiss', exact: true }).count()).toBe(0)
        expect(await done.getByRole('button', { name: 'Send', exact: true }).count()).toBe(0)
        const planDone = page.locator('[data-whole="dis-plan"] [data-card]')
        expect(await planDone.textContent()).toContain('Dismissed')
        expect(await planDone.getByRole('button', { name: 'Approve the plan', exact: true }).isDisabled()).toBe(true)
      } finally {
        world.act = act
        chat.messages = chat.messages.filter((m) => !m.id.startsWith('dis-'))
        await page.close()
      }
    }, 40_000)

  // Esc belongs to the card the person pressed: the app's own Esc (back to the task list) must not run behind it.
  test('Esc on a pressed card is the card’s, not the app’s own back', async () => {
    const key = 'LV-3/Agent'
    const chat = world.chats[key]
    chat.messages.push({ id: 'dis-in-task', who: 'agent', at: Date.now(), question: { id: 'menu:dis-in-task', title: 'Allow writing the upload route?', kind: 'Form', terminal: true, noNote: true, choices: [{ label: 'Yes' }, { label: 'No' }], to: 'LV-3 agent', asks: 'Claude Code asks' } })
    const sent: Action[] = []
    const act = world.act
    world.act = async (a: Action) => (a.type === 'answer' ? (sent.push(a), { ok: true }) : act(a))
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await page.goto(at('place=p:mac:lilla-varlden&task=LV-3'))
      const card = page.locator('[data-whole="dis-in-task"] [data-card]')
      await card.waitFor()
      await card.locator('[data-card-title]').click()
      await page.keyboard.press('Escape')
      await until(() => sent.length === 1)
      expect(sent[0]).toMatchObject({ type: 'answer', chat: key, question: 'menu:dis-in-task', choice: -1, dismiss: true })
      // still in the task: Esc did not close it behind the card
      await page.waitForTimeout(200)
      expect(await page.locator('[data-whole="dis-in-task"]').count()).toBe(1)
      expect(await page.evaluate(() => location.search)).toContain('task=LV-3')
    } finally {
      world.act = act
      chat.messages = chat.messages.filter((m) => m.id !== 'dis-in-task')
      await page.close()
    }
  }, 30_000)
})
