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

  // Every coordinator on new Settings from the places list's own menu: the label carries how many, a tap asks first
  // (the server stops a turn at work before it restarts, so a mis-tap must not interrupt), and no task's agent.
  const newSettings = () => {
    for (const c of Object.values(world.chats)) c.restart = undefined
    world.chats['p:vm-str:gtm'].restart = { on: 'Claude Code', want: 'Codex' }
    world.chats['p:vm-str:herdr-projects'].restart = { on: 'Claude Code', want: 'pi' }
    world.chats['HP-204/Agent'].restart = { on: 'Claude Code', want: 'Codex' }
    world.emit('snapshot')
  }
  const noSettings = () => {
    for (const c of Object.values(world.chats)) c.restart = undefined
    world.emit('snapshot')
  }

  test("this machine's menu restarts every coordinator on new Settings, asks first, names the places, marks the working one, and restarts nothing until Restart is pressed", async () => {
    newSettings()
    // gtm is the place the screen shows: it watches that chat, so it knows the coordinator's turn is at work (the other's
    // row says nothing of work, which it cannot know from here)
    world.chats['p:vm-str:gtm'].working = true
    world.emit('snapshot')
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
      const dialog = page.getByRole('alertdialog', { name: 'Restart 2 coordinators?' })
      await dialog.waitFor()
      // the places it names, by name, the working one marked
      expect(await dialog.getByText('gtm', { exact: true }).count()).toBe(1)
      expect(await dialog.getByText('herdr-projects', { exact: true }).count()).toBe(1)
      expect(await dialog.locator('[data-restart-all-row]', { hasText: 'gtm' }).textContent()).toContain('working, its turn stops first')
      expect(await dialog.locator('[data-restart-all-row]', { hasText: 'herdr-projects' }).textContent()).not.toContain('working')
      // the screen watches gtm (the place on screen) and not herdr-projects: its row can't be marked, so the
      // server's own rule is said
      expect(await dialog.getByText('A turn at work is stopped first: their work in progress stops.').count()).toBe(1)
      // asking has restarted nothing: no card yet
      expect(world.chats['p:vm-str:gtm'].messages.at(-1)?.card).toBeUndefined()
      expect(world.chats['p:vm-str:herdr-projects'].messages.filter((m) => m.card?.restart).length).toBe(0)
      await dialog.getByRole('button', { name: 'Restart', exact: true }).click()
      // the real run's answer, in the dialog, before it closes
      const answer = page.locator('[data-restart-all-answer]')
      await answer.waitFor()
      expect(await answer.textContent()).toBe('Restarted 2')
      expect(await answer.getAttribute('class')).toBe(null)
      await page.getByRole('button', { name: 'OK', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      expect(world.chats['p:vm-str:gtm'].messages.at(-1)?.card).toMatchObject({ restart: true, text: 'Restarted on Codex' })
      expect(world.chats['p:vm-str:herdr-projects'].messages.at(-1)?.card).toMatchObject({ restart: true, text: 'Restarted on pi' })
      // the card in each chat, the task's agent left as it was, and nothing left to count
      expect(world.chats['HP-204/Agent'].messages.filter((m) => m.card?.restart).length).toBe(taskCards)
      expect(world.chats['HP-204/Agent'].restart).toMatchObject({ want: 'Codex' })
      expect(world.snapshot().places.filter((p) => p.restart)).toEqual([])
    } finally {
      world.chats['p:vm-str:gtm'].working = undefined
      world.emit('snapshot')
      await page.close()
    }
  }, 30_000)

  test('the question is cancelled: the dialog closes and nothing is restarted', async () => {
    newSettings()
    const sent: string[] = []
    const origAct = world.act
    world.act = async (a) => {
      if (a.type === 'restart-all') sent.push('restart-all')
      return origAct(a)
    }
    // biome-ignore lint/style/noNonNullAssertion: the describe skips every test of this file when no browser opened
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    // what the screen itself asks the server for: the tap must not ask for a restart-all, only Restart may
    const asks: string[] = []
    page.on('request', (r) => {
      if (r.url().endsWith('/api/action') && r.method() === 'POST') asks.push(r.postDataJSON().type as string)
    })
    try {
      // biome-ignore lint/style/noNonNullAssertion: the describe skips every test of this file when no browser opened
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:gtm')}`)
      await page.waitForSelector('#places li')
      const mine = page.locator('#places li[data-heading="m:vm-str"]')
      await mine.hover()
      await mine.getByRole('button', { name: 'More for vm-str' }).click()
      await page.getByRole('menuitem', { name: 'Restart 2 coordinators', exact: true }).click()
      const dialog = page.getByRole('alertdialog', { name: 'Restart 2 coordinators?' })
      await dialog.waitFor()
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      // no act('restart-all') from the screen, in the world or over the wire, and the count stands
      expect(sent).toEqual([])
      expect(asks).not.toContain('restart-all')
      expect(world.snapshot().places.filter((p) => p.restart).length).toBe(2)
      // the menu's item still counts what it would do: the question can be asked again
      await mine.hover()
      await mine.getByRole('button', { name: 'More for vm-str' }).click()
      expect(await page.getByRole('menuitem', { name: 'Restart 2 coordinators', exact: true }).count()).toBe(1)
    } finally {
      world.act = origAct
      await page.close()
    }
  }, 30_000)

  test('nothing to do: the question says so, a run that touches nothing says so too, and nothing is restarted', async () => {
    newSettings()
    const sent: string[] = []
    const origAct = world.act
    world.act = async (a) => {
      if (a.type === 'restart-all') sent.push('restart-all')
      return origAct(a)
    }
    // biome-ignore lint/style/noNonNullAssertion: the describe skips every test of this file when no browser opened
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      // biome-ignore lint/style/noNonNullAssertion: the describe skips every test of this file when no browser opened
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:gtm')}`)
      await page.waitForSelector('#places li')
      const mine = page.locator('#places li[data-heading="m:vm-str"]')
      await mine.hover()
      await mine.getByRole('button', { name: 'More for vm-str' }).click()
      await page.getByRole('menuitem', { name: 'Restart 2 coordinators', exact: true }).click()
      const dialog = page.getByRole('alertdialog', { name: 'Restart 2 coordinators?' })
      await dialog.waitFor()
      // their Settings moved back while the question is open: nothing to confirm, so it closes, and nothing is restarted
      noSettings()
      await dialog.waitFor({ state: 'detached' })
      expect(sent).toEqual([])
      expect(await page.getByRole('alertdialog').count()).toBe(0)
      // a run that found nothing to touch answers with the same words, in the same place: the screen still saw two
      // (a real one only happens when the Settings move back between the tap and the Restart, on the server)
      newSettings()
      let ran = 0
      world.act = async (a) => {
        if (a.type !== 'restart-all') return origAct(a)
        ran++
        return { ok: true, restarted: 0, failed: 0 }
      }
      await mine.hover()
      await mine.getByRole('button', { name: 'More for vm-str' }).click()
      await page.getByRole('menuitem', { name: 'Restart 2 coordinators', exact: true }).click()
      await page.getByRole('alertdialog', { name: 'Restart 2 coordinators?' }).waitFor()
      await page.getByRole('button', { name: 'Restart', exact: true }).click()
      const answer = page.locator('[data-restart-all-answer]')
      await answer.waitFor()
      expect(await answer.textContent()).toBe('Nothing new in their Settings')
      expect(await answer.getAttribute('class')).toBe(null)
      expect(ran).toBe(1)
      await page.getByRole('button', { name: 'OK', exact: true }).click()
      await page.getByRole('alertdialog').waitFor({ state: 'detached' })
      // and where there is nothing at all, the item is not there: the menu has no restart row for this machine
      noSettings()
      await settled(page)
      await mine.hover()
      await mine.getByRole('button', { name: 'More for vm-str' }).click()
      expect(await page.getByRole('menuitem', { name: /Restart/ }).count()).toBe(0)
    } finally {
      world.act = origAct
      await page.close()
    }
  }, 30_000)

  test('a place that cannot restart: the answer names it, and it is still offered after', async () => {
    newSettings()
    const origAct = world.act
    // biome-ignore lint/style/noNonNullAssertion: the describe skips every test of this file when no browser opened
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      // biome-ignore lint/style/noNonNullAssertion: the describe skips every test of this file when no browser opened
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:gtm')}`)
      await page.waitForSelector('#places li')
      // the server would answer one that could not, by name, and keep the failed one's hint for another go: a refusal,
      // then the run it would give, with nothing else done (a mocked run, for this screen's own answer)
      const runs = [
        { ok: false, error: 'herdr is not answering.' },
        { ok: true, restarted: 1, failed: 1, failures: ['gtm'] },
      ] as const
      let ran = 0
      world.act = async (a) => {
        if (a.type !== 'restart-all') return origAct(a)
        const reply = runs[ran]
        ran++
        return reply
      }
      const mine = page.locator('#places li[data-heading="m:vm-str"]')
      await mine.hover()
      await mine.getByRole('button', { name: 'More for vm-str' }).click()
      await page.getByRole('menuitem', { name: 'Restart 2 coordinators', exact: true }).click()
      const dialog = page.getByRole('alertdialog', { name: 'Restart 2 coordinators?' })
      await dialog.waitFor()
      // a run the server refused keeps the question open, and says why in it
      await dialog.getByRole('button', { name: 'Restart', exact: true }).click()
      await dialog.getByText('herdr is not answering.').waitFor()
      await dialog.getByRole('button', { name: 'Restart', exact: true }).click()
      // the run that kept going names the one that could not, in red, and the dialog stays for it
      const answer = page.locator('[data-restart-all-answer]')
      await answer.waitFor()
      expect(await answer.textContent()).toContain('1 failed: gtm')
      expect(await answer.getAttribute('class')).toContain('text-need-fg')
      expect(ran).toBe(2)
      await page.getByRole('button', { name: 'OK', exact: true }).click()
      await page.getByRole('alertdialog').waitFor({ state: 'detached' })
      // and where the world is as the run found it, the question can be asked again, by its own count
      await mine.hover()
      await mine.getByRole('button', { name: 'More for vm-str' }).click()
      expect(await page.getByRole('menuitem', { name: 'Restart 2 coordinators', exact: true }).count()).toBe(1)
    } finally {
      world.act = origAct
      await page.close()
    }
  }, 30_000)

  test("a phone: the same item in the machine's menu, one tap, its answer in the row", async () => {
    newSettings()
    const ctx = await browser!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const page = await ctx.newPage()
    try {
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:gtm')}`)
      await page.getByRole('button', { name: 'Spaces', exact: true }).first().click()
      const nav = 'nav[aria-label="Spaces"]'
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
      const dialog = page.getByRole('alertdialog', { name: 'Restart 2 coordinators?' })
      await dialog.waitFor()
      // the question on the phone names the places too, before anything is interrupted
      expect(await dialog.getByText('gtm', { exact: true }).count()).toBe(1)
      expect(await dialog.getByText('herdr-projects', { exact: true }).count()).toBe(1)
      await dialog.getByRole('button', { name: 'Restart', exact: true }).tap()
      await dialog.waitFor({ state: 'detached' })
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
      // a working agent cannot switch in place: this keeps the test on the restart-and-save path
      world.chats[chat].working = true
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
        await page
          .locator('[data-agent-controls]:visible')
          .last()
          .getByRole('menuitem', { name: /^Model:/ })
          .click()
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
    world.act = async (a) => (a.type === 'start-now' || a.type === 'start-with' ? (sent.push(a as never), { ok: true }) : act(a))
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
      // Start with…: only its worker, it stays in line
      await open()
      await page.getByRole('menuitem', { name: 'Start with…' }).click()
      const later = page.getByRole('alertdialog', { name: 'Start HP-203 with?' })
      await later.locator('[data-restart]').waitFor()
      expect(await later.textContent()).toContain('when its turn comes; it stays in line as it is')
      await later.getByRole('button', { name: 'Save', exact: true }).click()
      await later.waitFor({ state: 'detached' })
      expect(sent.at(-1)).toMatchObject({ type: 'start-with', chat: 'HP-203/Agent' })
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

  test('Start with…: Save keeps the pick, and the sheet opened again shows it, not what its agent runs on now', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:herdr-projects')}`)
      const row = page.locator('section[aria-label="Tasks"] li', { hasText: 'HP-203' })
      const open = async () => {
        await row.hover()
        await row.getByRole('button', { name: 'More for this task' }).click()
        await page.getByRole('menuitem', { name: 'Start with…' }).click()
        const sheet = page.getByRole('alertdialog', { name: 'Start HP-203 with?' })
        await sheet.locator('[data-restart]').waitFor()
        return sheet
      }
      const sheet = await open()
      await sheet.getByRole('button', { name: /^Agent: / }).click()
      await page.getByRole('menuitemradio', { name: 'Codex', exact: true }).click()
      await sheet.getByRole('button', { name: /^Model: / }).click()
      await page.getByRole('menuitemradio', { name: 'GPT-6-Sol', exact: true }).click()
      await sheet.getByRole('button', { name: 'Save', exact: true }).click()
      await sheet.waitFor({ state: 'detached' })
      expect(world.workers.get('HP-203')).toMatchObject({ kind: 'codex', model: 'gpt-6-sol' })
      // opened again: the pick, as it was saved
      const again = await open()
      expect(await again.getByRole('button', { name: 'Agent: Codex', exact: true }).count()).toBe(1)
      expect(await again.getByRole('button', { name: 'Model: GPT-6-Sol', exact: true }).count()).toBe(1)
      await page.keyboard.press('Escape')
    } finally {
      world.workers.delete('HP-203')
      await page.close()
    }
  }, 30_000)

  test('each CLI and model shows its room under Settings → Limits: a full or blocked one marked, its line below, a restart there refused', async () => {
    const set = (value: string | null) => world.act({ type: 'setting', key: 'models.maxAtOnce', value, place: 'm:vm-str' } as never)
    // HP-202 works on Codex: Codex's one slot is taken; Claude Code has 2, its Sonnet blocked
    await set('codex=1, claude=2, claude/claude-sonnet-5-5=0')
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:gtm')}`)
      const row = page.locator('section[aria-label="Tasks"] li', { hasText: 'GTM-17' })
      await row.hover()
      await row.getByRole('button', { name: 'More for this task' }).click()
      await page.getByRole('menuitem', { name: 'Restart agent…' }).click()
      const sheet = page.getByRole('alertdialog', { name: 'Restart GTM-17 agent?' })
      await sheet.locator('[data-restart]').waitFor()
      await sheet.getByRole('button', { name: /^Agent: / }).click()
      // named by its name alone, its room told as its description and drawn at the row's end
      const codex = page.getByRole('menuitemradio', { name: 'Codex', exact: true })
      expect(await codex.getAttribute('aria-description')).toBe('Full 1 of 1')
      expect(await codex.locator('[data-note]').getAttribute('data-note')).toBe('off')
      expect(await page.getByRole('menuitemradio', { name: 'Claude Code', exact: true }).locator('[data-note]').textContent()).toBe('0 of 2')
      await codex.click()
      const line = sheet.locator('[data-room]')
      expect(await line.getAttribute('data-room')).toBe('full')
      expect(await line.textContent()).toBe('Codex is at its limit (1 of 1 at once): HP-202. It can’t restart on it until a slot frees up: pick one with room.')
      expect(await sheet.getByRole('button', { name: 'Restart', exact: true }).isDisabled()).toBe(true)
      // Claude Code's models: the blocked one marked
      await sheet.getByRole('button', { name: /^Agent: / }).click()
      await page.getByRole('menuitemradio', { name: 'Claude Code', exact: true }).click()
      await sheet.getByRole('button', { name: /^Model: / }).click()
      const sonnet = page.getByRole('menuitemradio', { name: /^Sonnet/ })
      expect(await sonnet.locator('[data-note]').textContent()).toBe('Blocked')
      await sonnet.click()
      expect(await line.textContent()).toMatch(
        /^Claude\/claude-sonnet-5-5 is blocked \(0 allowed\)\. It can’t restart on it: pick another model, or change the limit in Settings → Limits\. Quota: 5 h \d+%/,
      )
      expect(await sheet.getByRole('button', { name: 'Restart', exact: true }).isDisabled()).toBe(true)
      // one with room: its count, and it restarts
      await sheet.getByRole('button', { name: /^Model: / }).click()
      await page.getByRole('menuitemradio', { name: /^Opus/ }).click()
      expect(await line.getAttribute('data-room')).toBe('room')
      expect(await line.textContent()).toMatch(/^Claude: 0 of 2 at once now; 2 more fit\. Quota: /)
      expect(await sheet.getByRole('button', { name: 'Restart', exact: true }).isDisabled()).toBe(false)
      await page.keyboard.press('Escape')
      await sheet.waitFor({ state: 'detached' })
      // a start now on a full one is offered: it takes a backup with room, or waits first in line
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:herdr-projects')}`)
      const waiting = page.locator('section[aria-label="Tasks"] li', { hasText: 'HP-203' })
      await waiting.hover()
      await waiting.getByRole('button', { name: 'More for this task' }).click()
      await page.getByRole('menuitem', { name: 'Start now with…' }).click()
      const now = page.getByRole('alertdialog', { name: 'Start HP-203 now?' })
      await now.locator('[data-restart]').waitFor()
      await now.getByRole('button', { name: /^Agent: / }).click()
      await page.getByRole('menuitemradio', { name: 'Codex', exact: true }).click()
      expect(await now.locator('[data-room]').textContent()).toContain('It starts on a backup with room, or waits first in line for a free slot.')
      expect(await now.getByRole('button', { name: 'Start now', exact: true }).isDisabled()).toBe(false)
    } finally {
      await set(null)
      await page.close()
    }
  }, 30_000)

  test("on a phone a model's room sits before its pin, never under it", async () => {
    await world.act({ type: 'setting', key: 'models.maxAtOnce', value: 'claude/claude-sonnet-5-5=0', place: 'm:vm-str' } as never)
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    try {
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:gtm')}&task=GTM-17`)
      await page.locator('[data-composer]:visible').last().waitFor()
      await page.locator('[data-composer]:visible button[aria-label="Attach files and more"]').last().click()
      await page.locator('[data-agent-controls]:visible').last().getByRole('menuitem').first().click()
      const sheet = page.getByRole('alertdialog')
      await sheet.locator('[data-restart]').waitFor()
      await sheet.getByRole('button', { name: /^Agent: / }).click()
      await page.getByRole('menuitemradio', { name: 'Claude Code', exact: true }).click()
      await sheet.getByRole('button', { name: /^Model: / }).click()
      const note = (await page
        .getByRole('menuitemradio', { name: /^Sonnet/ })
        .locator('[data-note]')
        .boundingBox())!
      const pin = (await page.getByRole('menuitemcheckbox', { name: /^(Pin|Unpin) Sonnet/ }).boundingBox())!
      expect(note.x + note.width).toBeLessThanOrEqual(pin.x)
    } finally {
      await world.act({ type: 'setting', key: 'models.maxAtOnce', value: null, place: 'm:vm-str' } as never)
      await page.close()
    }
  }, 30_000)

  test('Switch to changes the model in place: the chat shows it, with no restart card', async () => {
    const chat = 'GTM-17/Agent'
    world.chats[chat].agent = { kind: 'claude', model: 'claude-opus-5-5', effort: 'high' }
    world.chats[chat].cli = 'Claude Code'
    world.chats[chat].restart = undefined
    world.chats[chat].working = false
    world.emit('snapshot')
    const cards = () => world.chats[chat].messages.filter((m) => m.card?.restart).length
    const before = cards()
    let sent: Record<string, unknown> | undefined
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    page.on('request', (r) => {
      if (r.url().endsWith('/api/action') && r.method() === 'POST') {
        const a = r.postDataJSON()
        if (a.type === 'live-switch') sent = a
      }
    })
    await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:gtm')}&task=GTM-17`)
    const box = page.locator(`[data-composer]:has(textarea[data-chat="${chat}"])`)
    await box.locator('button[aria-label="Attach files and more"]').click()
    await page
      .locator('[data-agent-controls]:visible')
      .last()
      .getByRole('menuitem', { name: /^Model:/ })
      .click()
    const sheet = page.getByRole('alertdialog')
    await sheet.locator('[data-restart]').waitFor()
    // no change, no switch button: the Restart path is all there is until a pick differs
    expect(await sheet.getByRole('button', { name: 'Switch to', exact: true }).count()).toBe(0)
    await sheet.getByRole('button', { name: /^Model: / }).click()
    await page.getByRole('menuitemradio', { name: 'Sonnet 5.5', exact: true }).click()
    await sheet.getByRole('button', { name: 'Switch to', exact: true }).click()
    await sheet.waitFor({ state: 'detached' })
    expect(sent).toMatchObject({ type: 'live-switch', chat, kind: 'claude', model: 'claude-sonnet-5-5' })
    expect(cards()).toBe(before)
    expect(world.chats[chat].agent?.runtime?.model).toBe('claude-sonnet-5-5')
    await page.close()
  }, 30_000)
})
