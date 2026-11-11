// Minimal restart dialogs for both chat roles; the whole check runs these browser tests (`bun run check:local`).
import { describe, expect, test } from 'bun:test'
import { layout, settled } from './layout.ts'

const { browser, world, server } = await layout({ everything: true })

describe.skipIf(!browser)('restarting an agent', () => {
  test('Settings mismatches show no banner and do not restart either role', async () => {
    const p = world.snapshot().places.find((x) => !x.home)!
    for (const task of [false, true]) {
      const key = task ? 'GTM-17/Agent' : p.chat
      const c = world.chats[key]
      c.restart = { on: 'Claude Code', want: 'Codex' }
      const before = JSON.stringify(c.agent)
      const cards = c.messages.filter((m) => m.card?.restart).length
      const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent(p.id)}${task ? '&task=GTM-17' : ''}`)
      const controls = page.locator('[data-agent-controls]:visible').last()
      // a task's chat sits over the coordinator's: only the box on screen is the one you type in
      await page.locator('[data-composer]:visible').last().waitFor()
      expect(await controls.count()).toBe(0)
      await page.locator('[data-composer]:visible button[aria-label="Attach files and more"]').last().click()
      await controls.waitFor()
      expect(await page.locator('[data-restart-hint]').count()).toBe(0)
      expect(await controls.getByRole('menuitem').count()).toBe(3)
      expect(JSON.stringify(c.agent)).toBe(before)
      expect(c.messages.filter((m) => m.card?.restart).length).toBe(cards)
      await page.close()
    }
  }, 30_000)

  test("a task's ⋯ opens the sheet: Settings' CLI picked, another CLI offers its models; Restart posts the card", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:gtm')}`)
    const row = page.locator('section[aria-label="Tasks"] li', { hasText: 'GTM-17' })
    await row.hover()
    await row.getByRole('button', { name: 'More for this task' }).click()
    await page.getByRole('menuitem', { name: 'Restart agent…' }).click()
    const sheet = page.getByRole('alertdialog', { name: 'Restart GTM-17 agent?' })
    await sheet.waitFor()
    await sheet.locator('[data-restart]').waitFor()
    expect(await sheet.textContent()).not.toMatch(/Recorded launch|Settings for|unknown|CLI|resumes|meanwhile/)
    expect(await sheet.getByRole('switch').count()).toBe(0)
    await sheet.getByRole('button', { name: /^Agent: / }).click()
    await page.getByRole('menuitemradio', { name: 'Codex' }).click()
    expect(await sheet.textContent()).toContain('Codex starts a new session with this chat, the brief and branch.')
    await sheet.getByRole('button', { name: /^Model: / }).click()
    await page.getByRole('menuitemradio', { name: 'GPT-6-Sol', exact: true }).click()
    await sheet.getByRole('button', { name: /^Effort: / }).click()
    await page.getByRole('menuitemradio', { name: 'High', exact: true }).click()
    await sheet.getByRole('button', { name: 'Restart', exact: true }).click()
    await sheet.waitFor({ state: 'detached' })
    expect(world.chats['GTM-17/Agent'].messages.at(-1)?.card).toMatchObject({ restart: true, text: 'Restarted on Codex (GPT-6-Sol, high)' })
    await page.close()
  }, 30_000)

  test('the sheet fits a phone, and Cancel leaves the agent as it was', async () => {
    const p = world.snapshot().places.find((x) => !x.home)!
    const ctx = await browser!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent(p.id)}`)
    await page.getByRole('button', { name: /^Menu/ }).click()
    await page.getByRole('menuitem', { name: 'Restart agent…' }).click()
    const sheet = page.getByRole('alertdialog', { name: 'Restart coordinator?' })
    await sheet.locator('[data-restart]').waitFor()
    expect(await sheet.textContent()).not.toMatch(/Recorded launch|Settings for|unknown|CLI|resumes|meanwhile/)
    expect(await sheet.getByRole('switch').count()).toBe(0)
    const box = (await sheet.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    const cards = world.chats[p.chat].messages.filter((m) => m.card?.restart).length
    await sheet.getByRole('button', { name: 'Cancel' }).click()
    await sheet.waitFor({ state: 'detached' })
    expect(world.chats[p.chat].messages.filter((m) => m.card?.restart).length).toBe(cards)
    await ctx.close()
  }, 30_000)

  // Every coordinator on new Settings from the places list's own menu: one action, one answer in the row itself, its
  // label carrying how many it will touch, and no task's agent.
  const newSettings = () => {
    for (const c of Object.values(world.chats)) c.restart = undefined
    world.chats['p:vm-str:gtm'].restart = { on: 'Claude Code', want: 'Codex' }
    world.chats['p:vm-str:herdr-projects'].restart = { on: 'Claude Code', want: 'pi' }
    world.chats['HP-204/Agent'].restart = { on: 'Claude Code', want: 'Codex' }
    world.emit('snapshot')
  }

  test("this machine's menu restarts every coordinator on new Settings, its label carrying how many, and no task's agent", async () => {
    newSettings()
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:gtm')}`)
      await page.waitForSelector('#places li')
      // another machine's menu has no such item: its coordinators are its own to restart
      const mac = page.locator('#places li[data-heading="m:mac"]')
      await mac.hover()
      await mac.getByRole('button', { name: 'More for mac' }).click()
      expect(await page.getByRole('menuitem', { name: /Restart/ }).count()).toBe(0)
      await page.keyboard.press('Escape')
      const mine = page.locator('#places li[data-heading="m:vm-str"]')
      await mine.hover()
      await mine.getByRole('button', { name: 'More for vm-str' }).click()
      // the two whose chat says Settings moved; the task's agent that also differs is no coordinator
      const item = page.getByRole('menuitem', { name: 'Restart 2 coordinators', exact: true })
      await item.waitFor()
      const taskCards = world.chats['HP-204/Agent'].messages.filter((m) => m.card?.restart).length
      await item.click()
      await page.getByRole('menuitem', { name: 'Restarted 2', exact: true }).waitFor()
      expect(world.chats['p:vm-str:gtm'].messages.at(-1)?.card).toMatchObject({ restart: true, text: 'Restarted on Codex' })
      expect(world.chats['p:vm-str:herdr-projects'].messages.at(-1)?.card).toMatchObject({ restart: true, text: 'Restarted on pi' })
      // the card in each chat, the task's agent left as it was, and nothing left to count
      expect(world.chats['HP-204/Agent'].messages.filter((m) => m.card?.restart).length).toBe(taskCards)
      expect(world.chats['HP-204/Agent'].restart).toMatchObject({ want: 'Codex' })
      expect(world.snapshot().places.filter((p) => p.restart)).toEqual([])
    } finally {
      await page.close()
    }
  }, 30_000)

  test('a phone: the same item in the machine\'s menu, one tap, its answer in the row', async () => {
    newSettings()
    const ctx = await browser!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const page = await ctx.newPage()
    try {
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:gtm')}`)
      await page.getByRole('button', { name: 'Places' }).first().click()
      const nav = 'nav[aria-label="Places"]'
      const heading = page.locator(`${nav} li[data-heading="m:vm-str"]`)
      await heading.waitFor()
      await settled(page)
      // a finger holds the machine's heading: its menu, with the coordinators' restart on it
      const box = (await heading.boundingBox())!
      const cdp = await ctx.newCDPSession(page)
      const pt = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] })
      await page.waitForTimeout(700)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.getByRole('menuitem', { name: 'Restart 2 coordinators', exact: true }).tap()
      await page.getByRole('menuitem', { name: 'Restarted 2', exact: true }).waitFor()
      expect(world.chats['p:vm-str:gtm'].messages.at(-1)?.card).toMatchObject({ restart: true, text: 'Restarted on Codex' })
    } finally {
      await ctx.close()
    }
  }, 30_000)

  test('saving defaults is optional, scoped to the role, and sent only when selected', async () => {
    const p = world.snapshot().places.find((x) => !x.home)!
    for (const task of [false, true]) {
      const chat = task ? 'GTM-17/Agent' : p.chat
      world.chats[chat].agent = { kind: 'codex' }
      world.chats[chat].cli = 'Codex'
      world.chats[chat].restart = undefined
      const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
      let restart: unknown
      page.on('request', (r) => {
        if (r.url().endsWith('/api/action') && r.method() === 'POST') {
          const action = r.postDataJSON()
          if (action.type === 'restart') restart = action
        }
      })
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent(p.id)}${task ? '&task=GTM-17' : ''}`)
      // the chat's own box: a phone draws the place's under the task's
      const box = page.locator(`[data-composer]:has(textarea[data-chat="${chat}"])`)
      for (const save of [false, true]) {
        await box.locator('button[aria-label="Attach files and more"]').click()
        await page.locator('[data-agent-controls]:visible').last().getByRole('menuitem', { name: /^Model:/ }).click()
        const sheet = page.getByRole('alertdialog')
        await sheet.locator('[data-restart]').waitFor()
        // nothing is kept for later unless a pick changes it and the switch says so
        if (await sheet.getByRole('switch').count()) expect(await sheet.getByRole('switch').first().getAttribute('aria-checked')).toBe('false')
        await sheet.getByRole('button', { name: /^Effort: / }).click()
        await page.getByRole('menuitemradio', { name: save ? 'Low' : 'High', exact: true }).click()
        // its own role, and the space the chat is in: a task's, not the place the page shows behind it
        const toggle = sheet.getByRole('switch', { name: `Use for future ${task ? 'task agents' : 'coordinators'} in ${task ? 'gtm' : p.name}` })
        expect(await toggle.getAttribute('aria-checked')).toBe('false')
        if (save) await toggle.click()
        await sheet.getByRole('button', { name: 'Restart', exact: true }).click()
        await sheet.waitFor({ state: 'detached' })
        expect(restart).toMatchObject({ type: 'restart', chat, kind: 'codex', model: '', effort: save ? 'low' : 'high', save })
      }
      await page.close()
    }
  }, 30_000)


  test("a waiting task's ⋯ offers Start now and Start now with…: the sheet picks what it would run on, saves nothing for others", async () => {
    const sent: { type: string; chat?: string; kind?: string; model?: string; effort?: string }[] = []
    const act = world.act
    world.act = async (a) => (a.type === 'start-now' ? (sent.push(a as never), { ok: true }) : act(a))
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:herdr-projects')}`)
      const row = page.locator('section[aria-label="Tasks"] li', { hasText: 'HP-203' })
      const open = async () => {
        await row.hover()
        await row.getByRole('button', { name: 'More for this task' }).click()
      }
      await open()
      await page.getByRole('menuitem', { name: 'Start now', exact: true }).click()
      expect(sent.at(-1)).toEqual({ type: 'start-now', chat: 'HP-203/Agent' })
      await open()
      await page.getByRole('menuitem', { name: 'Start now with…' }).click()
      const sheet = page.getByRole('alertdialog', { name: 'Start HP-203 now?' })
      await sheet.locator('[data-restart]').waitFor()
      // for this task alone: no switch to keep it for the others, and the words say what stays as Settings say
      expect(await sheet.getByRole('switch').count()).toBe(0)
      expect(await sheet.textContent()).toContain("Only this task's agent runs on it; its reviewer and backups stay as Settings say.")
      await sheet.getByRole('button', { name: /^Agent: / }).click()
      await page.getByRole('menuitemradio', { name: 'pi' }).click()
      await sheet.getByRole('button', { name: 'Start now', exact: true }).click()
      await sheet.waitFor({ state: 'detached' })
      expect(sent.at(-1)).toMatchObject({ type: 'start-now', chat: 'HP-203/Agent', kind: 'pi' })
      // a task at work offers neither
      const working = page.locator('section[aria-label="Tasks"] li', { hasText: 'HP-202', hasNotText: 'After HP-202' })
      await working.hover()
      await working.getByRole('button', { name: 'More for this task' }).click()
      expect(await page.getByRole('menuitem', { name: 'Start now', exact: true }).count()).toBe(0)
      expect(await page.getByRole('menuitem', { name: 'Restart agent…' }).count()).toBe(1)
    } finally {
      world.act = act
      await page.close()
    }
  }, 30_000)
})
