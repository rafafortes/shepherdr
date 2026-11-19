// The live source itself: a turn the provider cut off, machine health, unread, startup menus, a dismissed card, the
// live switch, launch controls, Settings → Models and the chat rebuild shortcuts.
import { afterAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('source')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
// no OpenCode database of this machine: its mirror copies rows from one that isn't there (an OpenCode log reads as a
// copy of its session)
process.env.SHEPHERDR_OPENCODE_DB = join(process.env.SHEPHERDR_HOME, 'no-opencode.db')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { HOST, NAME, placeId } = await import('../server/live/places.ts')
const { herdr } = await import('../server/live/herdr.ts')
const { isAgentProcess } = await import('../server/live/agent-process.ts')
const { carryOn, momentOf } = await import('../server/live/retry.ts')
const { Worktrees } = await import('../server/live/engine/worktrees.ts')
const { fakeHerdr } = await import('./fake-herdr.ts')

const src = new LiveSource()
// this file is not about the spacing between starts: with machine.startEvery's 2 minutes, the shared machine of these
// tests would start one task every two minutes (every start Shepherdr makes by itself follows it now, engine.startGate)
src.settings.set('machine.startEvery', '0', 'machine')
/** the live switch is private: drive it directly with an injected io (the action path is covered too) */
const liveSwitch = (key: string, pick: unknown, io?: unknown) => (src as unknown as { liveSwitch: (k: string, p: unknown, io?: unknown) => Promise<unknown> }).liveSwitch(key, pick, io)
// herdr makes task worktrees: a stand-in on real git; no terminal opens for their agents (no herdr is there)
const fake = fakeHerdr()
fake.h.createTab = async () => {
  throw new Error('herdr is not here')
}
Object.assign(src.engine, { wt: new Worktrees(fake.h as never) })
afterAll(() => src.stop())

/** what a test waits for has come true, however slow the machine (a timer, another process) */
const until = async (f: () => boolean, ms = 8000, said = 'it') => {
  for (const t0 = Date.now(); !f(); await Bun.sleep(20)) if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${said}`)
}

/** a repo a test made, with its first commit (never the folder the tests run from) */
const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'

/**
 * The test's own git, bounded: 30 s, and a stalled one says which command it was, instead of bun taking the whole test
 * away with no word on the step (SHE-9 bounded the engine worlds' and herdr's stand-in after run 42020185856, but a
 * timeout there reads just "ETIMEDOUT", which names nothing either).
 */
const run = (cmd: string, cwd: string): string => {
  try {
    return execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8', timeout: 30_000 }).trim()
  } catch (e) {
    throw new Error(`\`${cmd}\` in ${cwd}: ${(e as Error).message.trim()}`, { cause: e })
  }
}

/** a project with a task whose agent has committed work on its branch (herdr isn't there: its agent can't start) */
async function workedTask(name: string) {
  const dir = tmp('src-repo')
  run(REPO, dir)
  const p = await src.places.add(dir, name)
  return { t: await worked(p), dir, place: placeId.space(p.name) }
}

/**
 * The worktree herdr's stand-in makes for a task, waited for until it is there or the start has said why it can't be —
 * so a start that never gets one fails with the app's own words, inside the 20 s a test has unless it says otherwise.
 */
async function worktree(t: { id: string; worktree?: string; trouble?: string }, ms = 15_000) {
  await until(() => !!t.worktree || !!t.trouble, ms, `${t.id}'s worktree`)
  if (!t.worktree) throw new Error(`${t.id} got no worktree: ${t.trouble}`)
}

/**
 * A task in a place already there, its agent's work committed on its branch (herdr isn't there: its agent can't
 * start). It waits for the worktree herdr's stand-in makes, so the commit never lands in a folder not there yet.
 */
async function worked(p: { name: string }, file = 'x.txt') {
  const t = src.engine.add({ project: p.name, title: 'Worked', by: 'test' })
  await worktree(t)
  run(`echo x > ${file} && git add -A && git commit -qm work`, t.worktree!)
  return t
}

describe('a turn the provider cut off, end to end', () => {
  /** a Claude Code log whose last turn the API cut off: one more line for each try that is cut off too */
  const cutLog = (dir: string) => {
    const f = join(dir, 'log.jsonl')
    let n = 0
    const cut = () => {
      const at = new Date().toISOString()
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      const line = (o: object) => `${JSON.stringify(o)}\n`
      appendFileSync(f, line({ type: 'user', isSidechain: false, uuid: `u-${id}`, timestamp: at, sessionId: 's', message: { role: 'user', content: 'go on' } }))
      appendFileSync(
        f,
        line({
          type: 'assistant',
          isSidechain: false,
          uuid: id,
          timestamp: at,
          error: 'server_error',
          isApiErrorMessage: true,
          apiErrorStatus: 529,
          message: { id: `m-${id}`, role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: 529 Overloaded.' }] },
        }),
      )
    }
    return { f, cut }
  }

  test("a coordinator's cut-off turn is tried again after each wait, then it says so in its chat, with an alert", async () => {
    const key = placeId.space('cutco')
    const dir = tmp('cut')
    const log = cutLog(dir)
    src.agents.records[key] = { key, name: 'shep-cutco-test', kind: 'claude', cwd: dir, workspace: 'cutco', logs: [log.f], started: 0 }
    Object.assign(src.retries, { waits: [30, 30, 30, 30] })
    const sent: string[] = []
    const send = src.agents.send
    src.agents.send = (async (k: string, text: string) => {
      // what other tests' news sends meanwhile aside
      if (k === key) sent.push(`${k} ${text}`)
      return { waiting: false, item: { id: 'x', key: k, text, at: Date.now() } }
    }) as never
    const alerts: { title: string; body: string }[] = []
    // other tests' tasks may still alert meanwhile: only this chat's are looked at
    const off = src.on('alert', (a) => void (a.tag === `cut:${key}` && alerts.push(a)))
    try {
      for (let i = 1; i <= 5; i++) {
        log.cut()
        src.agents.emit('status', key, 'idle')
        expect(src.retries.get(key)?.tries).toBe(i)
        // its log named the cut at once: its log is not watched for another, so a try that is cleared stays cleared
        expect((src as unknown as { lateCuts: Map<string, number> }).lateCuts.has(key)).toBe(false)
        if (i === 5) break
        // told to carry on once its wait is over; the line it is told is no message of yours: the count goes on
        await until(() => sent.length === i)
        src.agents.emit('sent', { id: `n${i}`, key, text: carryOn('Provider overloaded'), at: Date.now() })
      }
      expect(sent).toEqual(Array(4).fill(`${key} ${carryOn('Provider overloaded')}`))
      expect(src.retries.get(key)).toMatchObject({ over: true, reason: 'Provider overloaded, still after 5 tries' })
      expect(src.chats.log(key).posted.at(-1)?.card?.text).toBe('Cut off by its provider: provider overloaded, still after 5 tries. Write to carry on.')
      expect(alerts.at(-1)?.body).toStartWith('Provider overloaded, still after 5 tries.')
      // you write: it goes on, and the count starts again
      src.agents.emit('sent', { id: 'y', key, text: 'Go on please', at: Date.now() })
      expect(src.retries.get(key)).toBeUndefined()
    } finally {
      src.agents.send = send
      off()
      delete src.agents.records[key]
    }
  })

  test('a stopped task is never told to carry on, nor started again for it', async () => {
    const { t } = await workedTask('cutstop')
    const key = `${t.id}/Agent`
    const log = cutLog(tmp('cut'))
    src.agents.records[key] = { key, name: 'shep-cutstop-test', kind: 'claude', cwd: t.worktree!, workspace: 'cutstop', logs: [log.f], started: 0 }
    Object.assign(src.retries, { waits: [30, 30, 30, 30] })
    const sent: string[] = []
    const send = src.agents.send
    src.agents.send = (async (k: string, text: string) => {
      if (k === key) sent.push(k)
      return { waiting: false, item: { id: 'x', key: k, text, at: Date.now() } }
    }) as never
    try {
      log.cut()
      src.agents.emit('status', key, 'idle')
      expect(src.retries.get(key)?.due).toBeGreaterThan(0)
      await src.engine.stopTask(t.id)
      // stopping it clears the wait; one seen again after that is let be when it is due
      expect(src.retries.get(key)).toBeUndefined()
      log.cut()
      src.agents.emit('status', key, 'idle')
      await Bun.sleep(80)
      expect(sent).toEqual([])
      expect(src.retries.get(key)).toBeUndefined()
    } finally {
      src.agents.send = send
    }
  })

  test('WEB-137: a cut its log names seconds after the turn ended is still seen, and OpenCode’s free-limit keeps its reset', async () => {
    const key = 'OC-137/Agent'
    const dir = join(process.env.SHEPHERDR_HOME!, 'opencode')
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'ses_e1415158bffes7UEypyB1KQKPL.jsonl')
    const row = (o: object) => appendFileSync(f, `${JSON.stringify(o)}\n`)
    // a turn that ended a minute ago (the run-out is kept only so long after it)
    const t0 = Date.now() - 60_000
    // its turn ended well, and its log has no failure yet: nothing to see when its status changes
    row({ id: 'u1', type: 'user', seq: 1, time: t0, data: { text: 'Go on', time: { created: t0 } } })
    row({
      id: 'a1',
      type: 'assistant',
      seq: 2,
      time: t0 + 1000,
      data: {
        agent: 'build',
        model: { providerID: 'opencode', id: 'hy4-flash-free' },
        content: [{ type: 'text', text: 'Running the check.' }],
        finish: 'stop',
        time: { created: t0 + 1000, completed: t0 + 1100 },
      },
    })
    src.agents.records[key] = { key, name: 'shep-oc-137-test', kind: 'opencode', cwd: '/w/137', workspace: 'web', logs: [f], started: 0 }
    Object.assign(src.retries, { waits: [30, 30, 30, 30] })
    try {
      src.agents.emit('status', key, 'idle')
      expect(src.retries.get(key)).toBeUndefined()
      // seconds later the mirror copies the failure: its provider's free models ran out for ~41 minutes
      row({
        id: 'a2',
        type: 'assistant',
        seq: 3,
        time: t0 + 5000,
        data: {
          agent: 'build',
          model: { providerID: 'opencode', id: 'hy4-flash-free' },
          content: [],
          finish: 'error',
          error: {
            type: 'provider.free-limit',
            message: 'Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.',
            status: 429,
            retryAfterMs: 2_447_000,
          },
          time: { created: t0 + 5000, completed: t0 + 5100 },
        },
      })
      row({
        id: 'i2',
        type: 'idle',
        seq: 4,
        time: t0 + 5200,
        data: { time: { created: t0 + 5200 }, outcome: 'failed', error: { type: 'provider.free-limit', message: 'Free usage limit reached.', status: 429, retryAfterMs: 2_447_000 } },
      })
      await until(() => src.retries.get(key) !== undefined, 8000, 'the late cut')
      // nothing waits on a limit that is out: it is the backup's, or the human's, at once, and its reset is known
      expect(src.retries.get(key)).toMatchObject({ over: true, lasting: true, reason: `Out of allowance until ${momentOf(t0 + 5000 + 2_447_000)}` })
      // its run-out keeps the reset its CLI named, so the Limits page and the models held for it say until when
      const runOut = src.usage.runOuts((k) => k.includes('opencode')).at(-1)
      expect(runOut?.reason).toStartWith('Out of allowance')
      expect(runOut?.resetAt).toBe(t0 + 5000 + 2_447_000)
      // once it is known, it is not looked for again
      expect((src as unknown as { lateCuts: Map<string, number> }).lateCuts.has(key)).toBe(false)
    } finally {
      delete src.agents.records[key]
    }
  })

  test('a turn that ends with no cut in its log is watched a while, and let go when it goes back to work or its window ends', async () => {
    const key = 'OC-138/Agent'
    const dir = join(process.env.SHEPHERDR_HOME!, 'opencode')
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'ses_e1416ef58ffeVNFzRxvs0xiNK2.jsonl')
    const row = (o: object) => appendFileSync(f, `${JSON.stringify(o)}\n`)
    row({ id: 'u1', type: 'user', seq: 1, time: 1000, data: { text: 'Go on', time: { created: 1000 } } })
    src.agents.records[key] = { key, name: 'shep-oc-138-test', kind: 'opencode', cwd: '/w/138', workspace: 'web', logs: [f], started: 0 }
    const late = (src as unknown as { lateCuts: Map<string, number> }).lateCuts
    const was = src.lateCutFor
    try {
      const look = (src as unknown as { lookForLateCut: () => void }).lookForLateCut.bind(src)
      src.lateCutFor = 5000
      src.agents.emit('status', key, 'idle')
      expect(late.has(key)).toBe(true)
      // it went back to work (herdr says working again): its log is no longer watched for a cut that ended the turn
      const status = src.agents.status
      const working = (k: string) => (k === key ? 'working' : status.call(src.agents, k))
      src.agents.status = working as never
      try {
        look()
        expect(late.has(key)).toBe(false)
      } finally {
        src.agents.status = status
      }
      // a window that runs out lets go by itself, so an agent left quiet is not read for ever
      src.lateCutFor = 100
      src.agents.emit('status', key, 'idle')
      expect(late.has(key)).toBe(true)
      await Bun.sleep(150)
      look()
      expect(late.has(key)).toBe(false)
      expect(src.retries.get(key)).toBeUndefined()
    } finally {
      src.lateCutFor = was
      delete src.agents.records[key]
    }
  })
})

describe('machine health', () => {
  test("past a limit: a card in the home space's chat, news with the numbers for its coordinator, once; held tasks say why", async () => {
    const machine = placeId.home()
    const mon = src.health as unknown as { take: () => unknown; last?: unknown; watch: object }
    const take = mon.take
    const sent: { key: string; text: string }[] = []
    const send = src.agents.send
    src.agents.send = (async (key: string, text: string) => (sent.push({ key, text }), { waiting: false })) as typeof send
    src.places.setMode(machine, 'regular')
    const reach = src.agents.reachable
    mon.take = () => ({ at: 0, cores: 16, load: 2, memTotal: 100 * 2 ** 30, memUsed: 96 * 2 ** 30, disks: [{ path: '/tmp', pct: 40, freeGb: 60, dev: 1 }], gpus: [] })
    // browsers done tasks left open (never this machine's real ones): closed first, and counted in the news
    const browsers = src.browsers!
    const sweep = browsers.sweep
    let keep: ((t: string) => boolean) | undefined
    browsers.sweep = async (k) => ((keep = k), ['TG-4', 'TG-5'])
    try {
      src.agents.reachable = true
      src.healthTick()
      await until(() => sent.some((s) => s.key === machine && s.text.includes('<health ')))
      const card = src.chats.chat(machine).messages.find((m) => m.card?.health)
      expect(card?.card).toMatchObject({ text: 'memory is 96% used', health: { level: 'over', machine: HOST } })
      const news = sent.find((s) => s.key === machine && s.text.includes('<health '))!.text
      expect(news).toStartWith(
        `<shepherdr><health kind="memory" what="over">Machine ${HOST}: memory is over 90%: 96% in use.\nCPU 13% (load 2.0 on 16 cores) · Memory 96% (96 GB of 100 GB) · Disk /tmp 40% (60 GB free)\nTasks: `,
      )
      expect(news).toContain('Using it most now:')
      expect(news).toContain('Shepherdr closed 2 shared browsers that finished tasks left open (TG-4, TG-5).')
      expect(keep!('TG-4')).toBe(false)
      expect(news).toContain('shepherdr task pause <id>')
      expect(news).toContain(
        'Act on it if the human asked you to handle such things. If it can’t wait, alert the human with shepherdr alert and say why. A card in this chat already shows the human the news: reply after it in one or two short lines',
      )
      // only the home space hears it: no coordinator of All machines any more
      expect(sent.filter((s) => s.text.includes('<health ')).map((s) => s.key)).toEqual([machine])
      expect(news).toContain('Never <no-reply> to it.')
      expect(news).not.toMatch(/recommend|do not act/i)
      // shown on the machine: red memory, amber is nothing else
      const h = src.snapshot().machines.find((m) => m.id === placeId.machine())!.health!
      expect(h.meters.find((m) => m.name === 'Memory')).toMatchObject({ pct: 96, level: 'over' })
      expect(h.hostWarning).toContain('shepherdr set app.hosts <host>')
      // told once
      const n = sent.length
      src.healthTick(Date.now() + 31_000)
      await Bun.sleep(1200)
      expect(sent.slice(n).filter((s) => s.text.includes('<health '))).toEqual([])
      // new tasks wait for the machine, and the command says so
      const dir = tmp('src-held')
      run('git init -q -b main && git -c user.email=t@t -c user.name=T commit -q --allow-empty -m init', dir)
      await src.places.add(dir, 'held')
      const r = await src.cli(['task', 'add', 'Wait for room', '--desc', 'Add y.txt.', '--project', 'held'], { chat: placeId.space('held') })
      expect(r.out).toContain('held: the machine is busy')
      expect(r.out).toContain("starts by itself when there's room")
      expect((await src.cli(['show'], {})).out).toContain(`${HOST} now: CPU 13%`)
      // back under: told so
      mon.take = () => ({ at: 0, cores: 16, load: 2, memTotal: 100 * 2 ** 30, memUsed: 50 * 2 ** 30, disks: [{ path: '/tmp', pct: 40, freeGb: 60, dev: 1 }], gpus: [] })
      src.healthTick(Date.now() + 62_000)
      await until(() => sent.some((s) => s.key === machine && s.text.includes('memory is back under 90%')))
    } finally {
      browsers.sweep = sweep
      src.agents.send = send
      src.agents.reachable = reach
      src.places.setMode(machine, 'regular')
      mon.take = take
      mon.last = undefined
    }
  })

  test('an I/O-pressure tell closes no finished browser and lists no process: a browser is memory and CPU, not I/O', async () => {
    const mon = src.health as unknown as { take: () => unknown; last?: unknown; watch: Record<string, unknown> }
    const take = mon.take
    const watch = mon.watch
    const browsers = src.browsers as NonNullable<typeof src.browsers>
    const sweep = browsers.sweep
    const send = src.agents.send
    let swept = 0
    browsers.sweep = async () => {
      swept++
      return []
    }
    src.agents.send = (async (k: string, text: string) => ({ waiting: false, item: { id: 'x', key: k, text, at: Date.now() } })) as never
    src.settings.set('machine.startIoPressure', '25%', 'machine')
    try {
      // over its 2 minutes: this look tells the coordinator (kind pressure), so onHealth runs too
      mon.watch = { pressure: { since: Date.now() - 200_000 } }
      mon.take = () => ({ at: 0, cores: 16, load: 1, load5: 1, ioSome: 60, memTotal: 100 * 2 ** 30, memUsed: 40 * 2 ** 30, disks: [{ path: '/tmp', pct: 40, freeGb: 60, dev: 1 }], gpus: [] })
      mon.last = undefined
      src.healthTick()
      expect(src.health.busy()).toBe('io')
      await Bun.sleep(50)
      expect(swept).toBe(0)
    } finally {
      browsers.sweep = sweep
      src.agents.send = send
      src.settings.set('machine.startIoPressure', null, 'machine')
      mon.take = take
      mon.watch = watch
      mon.last = undefined
    }
  })

  test("herdr's socket refusing is said plainly", async () => {
    const e = await herdr.ping().catch((x: Error) => x)
    expect((e as Error).message).toBe("herdr isn't answering")
  })
})

describe('unread', () => {
  test("something new in a chat shows unread until read; a new message alerts as one (only Notify All lets it buzz), a task's card doesn't", async () => {
    const key = placeId.home()
    const alerts: import('../shared/types.ts').Alert[] = []
    const off = src.on('alert', (a) => void (a.message && alerts.push(a)))
    const read0 = src.snapshot().read!['*']
    expect(read0).toBeGreaterThan(0)
    src.chats.post(key, { id: 'unread-q', question: { id: 'ask:unread', title: 'Clean the disk now?', kind: 'Question', choices: [{ label: 'Yes' }, { label: 'Later' }], to: key } })
    const at = src.snapshot().last![key]
    expect(at).toBeGreaterThan(read0)
    expect(alerts.map((a) => [a.title, a.body, a.go.place])).toEqual([[src.chatName(key), 'Clean the disk now?', key]])
    // a card about a task: unread, but its task's own alert tells of it
    src.chats.post(key, { id: 'unread-card', card: { id: 'unread-card', task: 'X-1', status: 'done', text: 'X-1 is merged' } })
    expect(src.snapshot().last![key]).toBeGreaterThanOrEqual(at)
    expect(alerts).toHaveLength(1)
    // a task's chat: never unread, and no new-message alert (its own alerts say what it needs)
    src.chats.post('X-1/Agent', { id: 'unread-task', question: { id: 'ask:unread-task', title: 'Which port?', kind: 'Question', choices: [{ label: '80' }, { label: '443' }], to: 'X-1' } })
    expect(src.snapshot().last!['X-1/Agent']).toBeUndefined()
    expect(alerts).toHaveLength(1)
    off()
    // read on one device: every device's snapshot has it
    await src.act({ type: 'read', chats: { [key]: src.snapshot().last![key] } })
    expect(src.snapshot().read![key]).toBe(src.snapshot().last![key])
    // never back, and never the '*' mark
    await src.act({ type: 'read', chats: { [key]: 1, '*': 1 } })
    expect(src.snapshot().read![key]).toBe(src.snapshot().last![key])
    expect(src.snapshot().read!['*']).toBe(read0)
  })
})

describe('startup menus before the first message', () => {
  test('unparsed blockers preserve the screen and offer the terminal; changed cards cannot send keys', async () => {
    const key = 'startup-fixture'
    const originals = { info: src.agents.info, status: src.agents.status, visible: herdr.visible, refresh: src.agents.refresh, keys: src.agents.keys }
    let screen = 'A new CLI asks for a secret\nType your answer to continue'
    let sent = 0
    src.agents.info = (() => ({ pane_id: 'startup-pane', agent: 'claude', agent_status: 'blocked', cwd: '/tmp', tab_id: 'startup-tab', workspace_id: 'startup-space' })) as typeof src.agents.info
    src.agents.status = (() => 'blocked') as typeof src.agents.status
    herdr.visible = async () => screen
    src.agents.refresh = async () => {}
    src.agents.keys = async () => {
      sent++
      screen = 'Ready for your message'
    }
    try {
      await src.chats.readMenu(key, true)
      const fallback = src.chats.chat(key).messages.find((m) => m.question)?.question
      expect(fallback?.screen).toBe(screen)
      expect(fallback?.terminal).toBe(true)
      expect(fallback?.noNote).toBe(true)
      expect(fallback?.choices).toEqual([])
      screen = 'Allow this tool? [y/n]'
      await src.chats.readMenu(key, true)
      expect(await src.act({ type: 'answer', chat: key, question: fallback!.id, choice: 0 })).toMatchObject({ ok: false })
      expect(sent).toBe(0)
      const q = src.chats.chat(key).messages.find((m) => m.question)?.question
      expect(await src.act({ type: 'answer', chat: key, question: q!.id, choice: -1 })).toMatchObject({ ok: false })
      expect(sent).toBe(0)
      // A checkbox redraw is still the same open prompt, not proof of a successful submission.
      screen = '2 new MCP servers found in this project\n❯ [✔] one\n  [✔] two\n     Enable selected\nSpace to select · Esc to reject all'
      await src.chats.readMenu(key, true)
      const checkboxes = src.chats.chat(key).messages.find((m) => m.question)?.question
      src.agents.status = (() => 'idle') as typeof src.agents.status
      expect(await src.agents.send(key, 'Wait until MCP consent closes')).toMatchObject({ waiting: true, waitsFor: 'menu' })
      src.agents.outbox = src.agents.outbox.filter((o) => o.key !== key)
      src.agents.keys = async () => {
        screen = screen.replace('[✔] one', '[ ] one')
      }
      expect(await src.act({ type: 'answer', chat: key, question: checkboxes!.id, choice: 1, choices: [1] })).toMatchObject({ ok: false, error: expect.stringContaining('still shows this prompt') })
      expect(src.chats.log(key).posted.some((m) => m.answered)).toBe(false)
    } finally {
      Object.assign(src.agents, { info: originals.info, status: originals.status, refresh: originals.refresh, keys: originals.keys })
      herdr.visible = originals.visible
      src.agents.outbox = src.agents.outbox.filter((o) => o.key !== key)
      src.chats.forget(key)
    }
  })
})

describe("a card dismissed on the CLI's own screen", () => {
  test('takes Esc, as the person’s own Esc would; a start’s screen has none', async () => {
    const key = 'dismiss-menu'
    const originals = { info: src.agents.info, status: src.agents.status, visible: herdr.visible, refresh: src.agents.refresh, keys: src.agents.keys }
    let screen = 'Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don’t ask again\n  3. No\nEsc to cancel'
    const keysSent: string[][] = []
    src.agents.info = (() => ({ pane_id: 'dismiss-pane', agent: 'claude', agent_status: 'blocked', cwd: '/tmp', tab_id: 'dismiss-tab', workspace_id: 'dismiss-space' })) as typeof src.agents.info
    src.agents.status = (() => 'blocked') as typeof src.agents.status
    herdr.visible = async () => screen
    src.agents.refresh = async () => {}
    src.agents.keys = async (_k: string, keys: string[]) => {
      keysSent.push(keys)
      screen = ''
    }
    const told: string[] = []
    const send = src.agents.send
    src.agents.send = (async (k: string, text: string) => (k === key && told.push(text), { waiting: false })) as never
    try {
      await src.chats.readMenu(key, true)
      const q = src.chats.chat(key).messages.find((m) => m.question)?.question
      expect(q?.terminal).toBe(true)
      expect(q?.choices).toHaveLength(3)
      expect(q?.noDismiss).toBeUndefined()
      // a permission card: Esc, never the card's first choice (a yes)
      expect(await src.act({ type: 'answer', chat: key, question: q!.id, choice: -1, dismiss: true })).toMatchObject({ ok: true })
      expect(keysSent).toEqual([['escape']])
      expect(src.chats.menu(key)).toBeUndefined()
      // its own Esc declines it, and the person's words reach the agent too: it carries on rather than stops
      expect(told.join('\n')).toContain('<dismissed')
      expect(told.join('\n')).toContain('Do you want to proceed?')
      expect(told.join('\n')).toContain('carry on with your best judgment')
      // one line, not two: the line it hears is the one the chat shows, so none is posted beside it
      expect(src.chats.chat(key).messages.some((m) => m.answered?.startsWith('Dismissed'))).toBe(false)
      // a start stopped on its own screen: Esc there would end the launch, so it has no Dismiss
      screen = 'Choose a login method:\n❯ 1. Log in\n  2. Skip'
      await src.chats.readMenu(key, true)
      src.chats.showStartMenu(key, src.chats.menu(key)!)
      const start = src.chats.chat(key).messages.find((m) => m.question)?.question
      expect(start?.noDismiss).toBe(true)
      expect(await src.act({ type: 'answer', chat: key, question: start!.id, choice: -1, dismiss: true })).toMatchObject({ ok: false, error: expect.stringContaining('start waits on its own screen') })
      expect(keysSent).toHaveLength(1)
      // a prompt whose choices could not be read: its keys are a guess, so it has no Dismiss and refuses one
      src.chats.clearStartMenu(key)
      screen = 'A new CLI asks for a secret\nType your answer to continue'
      await src.chats.readMenu(key, true)
      screen = 'A new CLI asks for a secret\nType your answer to continue'
      await src.chats.readMenu(key, true)
      const blind = src.chats.chat(key).messages.find((m) => m.question)?.question
      expect(blind?.choices).toEqual([])
      expect(blind?.noDismiss).toBe(true)
      expect(await src.act({ type: 'answer', chat: key, question: blind!.id, choice: -1, dismiss: true })).toMatchObject({ ok: false, error: expect.stringContaining('no choices to decline') })
      expect(keysSent).toHaveLength(1)
      // a menu a slash command opened asks the agent nothing: Esc closes it, and nothing is sent to the agent
      screen = 'Choose a model:\n❯ 1. Sonnet\n  2. Opus\nEnter to select · Esc to cancel'
      await src.chats.readMenu(key, true)
      expect(await src.chats.commandMenu(key)).toBe(true)
      const picker = src.chats.chat(key).messages.findLast((m) => m.question)?.question
      const before = told.length
      expect(await src.act({ type: 'answer', chat: key, question: picker!.id, choice: -1, dismiss: true })).toMatchObject({ ok: true })
      expect(keysSent.at(-1)).toEqual(['escape'])
      expect(told).toHaveLength(before)
      // and the chat keeps the dismissal itself: a key press is not in the CLI's log
      expect(src.chats.chat(key).messages.some((m) => m.answered === 'Dismissed “Choose a model:”')).toBe(true)
    } finally {
      src.agents.send = send
      Object.assign(src.agents, { info: originals.info, status: originals.status, refresh: originals.refresh, keys: originals.keys })
      herdr.visible = originals.visible
      src.agents.outbox = src.agents.outbox.filter((o) => o.key !== key)
      src.chats.forget(key)
    }
  })
})

describe('a live switch', () => {
  test('changes the launch record in place, after the chat reports it; a busy agent or a CLI with no switch does not', async () => {
    const dir = tmp('live-switch')
    run(REPO, dir)
    const p = await src.places.add(dir, 'live-switch')
    const t = src.engine.add({ project: p.name, title: 'Live switch', by: 'test' })
    const key = `${t.id}/Agent`
    const name = `ls-${t.id.toLowerCase()}`
    const set = { kind: 'claude', model: 'claude-opus-5-5', effort: 'high' }
    src.agents.records[key] = { key, name, kind: 'claude', model: 'claude-opus-5-5', effort: 'high', cwd: dir, workspace: p.name, logs: [], started: 0, set } as never
    const live = { agent: 'claude', agent_status: 'idle', cwd: dir, name, pane_id: 'p-live-switch', tab_id: 't', workspace_id: 'w' }
    src.agents.live.set(name, live as never)
    const chat = { model: '', effort: '' }
    const io = {
      send: async (text: string) => {
        if (text.startsWith('/model')) chat.model = 'claude-sonnet-5-5'
        if (text.startsWith('/effort')) chat.effort = 'low'
      },
      keys: async (..._keys: string[]) => {},
      screen: async () => '',
      chat: async () => ({ ...chat }),
      sleep: async (_ms: number) => {},
    }
    try {
      const r = await liveSwitch(key, { kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' }, io)
      expect(r).toMatchObject({ live: true })
      expect(src.agents.records[key]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' })
      expect(src.agents.records[key]!.set).toEqual(set)
      // the same values: nothing to switch, so nothing is typed — the real io is still built and looked at
      expect(await liveSwitch(key, { kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })).toMatchObject({ live: true })
      expect(await src.act({ type: 'live-switch', chat: key, kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })).toMatchObject({ ok: true, live: true })
      expect(await src.act({ type: 'live-switch', chat: key, kind: 'not-a-cli', model: '' })).toMatchObject({ ok: false })
      expect(await src.act({ type: 'live-switch', chat: key, kind: 'claude', model: 'retired-model' })).toMatchObject({ ok: false })
      // the real io: typed into the pane, read back from the chat window's own log path. The host's herdr is a
      // stand-in here, so the transport and the chat read are stubbed; the switch itself is the one from live-switch.
      const realSend = src.agents.send
      const realPull = src.chats.pull
      const realChat = src.chats.chat
      const realRead = herdr.read
      chat.model = 'claude-opus-5-5'
      chat.effort = 'high'
      ;(src.agents as { send: unknown }).send = async (text: string) => {
        if (text.startsWith('/model')) chat.model = 'claude-opus-5-5'
        if (text.startsWith('/effort')) chat.effort = 'high'
        return { waiting: false, item: {} }
      }
      ;(src.chats as { pull: unknown }).pull = () => true
      ;(src.chats as { chat: unknown }).chat = (k: string) => ({ key: k, cli: 'Claude Code', messages: [], agent: { runtime: chat } })
      ;(herdr as { read: unknown }).read = async () => ''
      try {
        expect(await liveSwitch(key, { kind: 'claude', model: 'claude-opus-5-5', effort: 'high' })).toMatchObject({ live: true })
        expect(src.agents.records[key]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
        ;(src.agents as { send: unknown }).send = async () => ({ waiting: true, item: {} })
        await expect(liveSwitch(key, { kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })).rejects.toThrow("couldn't take the command")
        expect(await src.act({ type: 'live-switch', chat: key, kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })).toMatchObject({
          ok: false,
          error: expect.stringContaining("couldn't take the command"),
        })
        // "Default" is resolved to a concrete id/level before proof; no switch is needed when it is what runs now
        ;(src.agents.records[key] as { effort?: string }).effort = 'medium'
        expect(await liveSwitch(key, { kind: 'claude', model: '', effort: '' })).toMatchObject({ live: true })
        // the same Settings → Limits as a restart: a blocked model cannot be switched to
        await src.settings.set('models.maxAtOnce', 'claude/claude-opus-5-5=0', { space: p.name })
        try {
          await expect(liveSwitch(key, { kind: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, io)).rejects.toThrow('blocked (0 allowed)')
        } finally {
          await src.settings.set('models.maxAtOnce', null, { space: p.name })
        }
      } finally {
        src.agents.send = realSend
        src.chats.pull = realPull
        src.chats.chat = realChat
        herdr.read = realRead
      }
      // a turn under way, a question, or no agent at all: no switch, no stopped turn
      for (const [status, word] of [
        ['working', 'busy with a turn'],
        ['blocked', 'waiting on a question'],
        ['gone', "isn't running"],
      ] as const) {
        src.agents.live.set(name, { ...live, agent_status: status } as never)
        await expect(liveSwitch(key, { kind: 'claude', model: 'claude-sonnet-5-5' }, io)).rejects.toThrow(word)
      }
      src.agents.live.delete(name)
      await expect(liveSwitch(key, { kind: 'claude', model: 'claude-opus-5-5' })).rejects.toThrow("isn't running")
      // OpenCode has no in-session switch: the caller keeps the restart path
      await expect(liveSwitch(key, { kind: 'opencode', model: 'a-model' }, io)).rejects.toThrow()
    } finally {
      src.agents.live.delete(name)
      delete src.agents.records[key]
    }
  }, 30_000)
})

test('a CLI settings file is read and written in that CLI own home', async () => {
  const dir = tmp('claude-settings')
  process.env.CLAUDE_CONFIG_DIR = dir
  try {
    const files = src as unknown as { readAgentFile: (r: string) => Promise<string | null>; writeAgentFile: (r: string, t: string) => Promise<void> }
    await files.writeAgentFile('.claude/settings.json', '{"theme":"dark"}\n')
    expect(await files.readAgentFile('.claude/settings.json')).toBe('{"theme":"dark"}\n')
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR
  }
})

describe('visible launch controls', () => {
  test('coordinator and task metadata comes from the launch record, never new Settings; old actions cannot claim an unapplied change', async () => {
    const dir = tmp('controls')
    run(REPO, dir)
    const p = await src.places.add(dir, 'launch-controls')
    const place = placeId.space(p.name)
    const t = src.engine.add({ project: p.name, title: 'Launch controls', by: 'test', later: true })
    const keys = [place, `${t.id}/Agent`]
    try {
      src.settings.set('coordinator.agent', 'Claude Code', { space: p.name })
      src.settings.set('task.agent', 'Claude Code', { space: p.name })
      for (const key of keys) {
        src.agents.records[key] = { key, name: `launch-${key}`, kind: 'codex', model: 'gpt-6-sol', effort: 'high', cwd: dir, workspace: 'launch', logs: [], started: 0 }
        expect(src.chat(key)?.agent).toEqual({ kind: 'codex', model: 'gpt-6-sol', modelLabel: 'GPT-6-Sol', effort: 'high' })
        const before = { ...src.agents.records[key] }
        expect(await src.act({ type: 'model', chat: key, model: 'gpt-6-luna' })).toMatchObject({ ok: false, error: expect.stringContaining('Restart') })
        expect(await src.act({ type: 'effort', chat: key, effort: 'low' })).toMatchObject({ ok: false })
        expect(src.agents.records[key]).toEqual(before)
        // Missing values are kept missing: no guessed model or effort, even when Settings specifies them.
        delete src.agents.records[key].model
        delete src.agents.records[key].effort
        expect(src.chat(key)?.agent).toEqual({ kind: 'codex' })
        const info = (await src.act({ type: 'restart-info', chat: key })) as { info: { on: unknown; want: unknown } }
        expect(info.info.on).toEqual({ kind: 'codex' })
        expect(info.info.want).toMatchObject({ kind: 'claude' })
        const bad = await src.act({ type: 'restart', chat: key, kind: 'codex', model: 'no-longer-available', save: true })
        expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('no available model') })
        expect(src.chat(key)?.agent).toEqual({ kind: 'codex' })
      }
    } finally {
      for (const key of keys) delete src.agents.records[key]
      src.settings.set('coordinator.agent', null, { space: p.name })
      src.settings.set('task.agent', null, { space: p.name })
    }
  })
})

test('native and npm agent CLI process identities', () => {
  expect(isAgentProcess('codex', ['/opt/bin/codex', '--resume'])).toBe(true)
  expect(isAgentProcess('pi', ['/usr/bin/node', '/opt/node_modules/@mariozechner/pi-coding-agent/dist/cli.js'])).toBe(true)
  expect(isAgentProcess('claude', ['/usr/bin/node', '/opt/node_modules/@anthropic-ai/claude-code/cli.js'])).toBe(true)
  expect(isAgentProcess('pi', ['/usr/bin/node', '/some/app.js', 'pi'])).toBe(false)
  // OpenCode is a native binary: its argv[0] is its own name, wherever it is installed
  expect(isAgentProcess('opencode', ['/home/u/.opencode/bin/opencode', '--standalone', '--session', 'ses_x', '--auto'])).toBe(true)
  expect(isAgentProcess('opencode', ['/home/u/.local/bin/bash', '-c', 'opencode'])).toBe(false)
})

describe('Settings → Models: the table of this machine, read and written by the live source', () => {
  test('models-matrix lists Everywhere, this machine and its spaces, and a write at a space shows in its row', async () => {
    const dir = tmp('models-repo')
    run(REPO, dir)
    const p = await src.places.add(dir, 'models-src')
    const place = placeId.space(p.name)
    // the file's other tests add spaces to this same source: the rows are found by their place
    const at = (m: import('../shared/types.ts').ModelsMatrix, id: string) => m.rows.find((r) => r.id === id)!
    const m = (await src.act({ type: 'models-matrix' })) as import('../shared/types.ts').ModelsMatrix
    expect(m.machine).toEqual({ id: placeId.machine(), name: NAME })
    expect(m.rows.slice(0, 2).map((r) => r.id)).toEqual(['all', placeId.machine()])
    expect(
      m.rows
        .map((r) => r.kind)
        .slice(2)
        .every((k) => k === 'space'),
    ).toBe(true)
    expect(at(m, place)!.name).toBe(p.name)
    expect(at(m, place)!.values['space.maxTasks']).toEqual({ value: 'off', from: 'default', set: false })
    expect(await src.act({ type: 'setting', key: 'space.maxTasks', value: '5', place })).toEqual({ ok: true })
    const after = (await src.act({ type: 'models-matrix' })) as import('../shared/types.ts').ModelsMatrix
    expect(at(after, place).values['space.maxTasks']).toEqual({ value: '5', from: 'space', set: true })
    expect(at(after, placeId.machine()).values['space.maxTasks']).toEqual({ value: 'off', from: 'default', set: false })
    // a cell's keys go to the level of the row they are in: an agent's CLI at the space, not Everywhere
    expect(await src.act({ type: 'setting', key: 'task.agent', value: 'pi', place })).toEqual({ ok: true })
    const cli = (await src.act({ type: 'models-matrix' })) as import('../shared/types.ts').ModelsMatrix
    expect(at(cli, place).values['task.agent']).toEqual({ value: 'pi', from: 'space', set: true })
    expect(at(cli, 'all').values['task.agent']!.value).not.toBe('pi')
    expect(await src.act({ type: 'setting', key: 'space.maxTasks', value: null, place })).toEqual({ ok: true })
  })
})

describe('chatName, needs and withAsks avoid rebuilding unrelated chats', () => {
  test('chatName resolves local and peer places without invoking listed() or asks()', async () => {
    const dir = tmp('fast-name')
    run(REPO, dir)
    const p = await src.places.add(dir, 'fast-name')
    const id = placeId.space(p.name)
    const listedSpy = jestSpy(src as unknown as Record<string, () => unknown>, 'listed')
    const peerPlace1 = { id: 'p:peer-box:app', chat: 'p:peer-box:app', name: 'app', machine: 'peer-box', status: 'idle' }
    const peerPlace2 = { id: 'p:peer-box:api', chat: 'p:peer-box:api', name: 'api', machine: 'peer-box', status: 'idle' }
    const origPeers = src.peers
    src.peers = {
      list: () => [
        { rec: { machine: 'peer-box', url: 'http://unused' }, reachable: true, snap: { places: [peerPlace1, peerPlace2] } },
        { rec: { machine: 'bare-box', url: 'http://unused' }, reachable: false, snap: undefined },
      ],
    } as never
    src.places.rename('p:peer-box:app', 'web')
    src.places.rename('p:peer-box:api', 'app')
    try {
      expect(src.chatName(id)).toBe('fast-name')
      expect(src.chatName('p:peer-box:app')).toBe('web')
      expect(src.chatName('p:peer-box:api')).toBe('app')
      expect(src.chatName('p:bare-box:~')).toBe('home')
      expect(src.chatName('p:unknown:nope')).toBe('p:unknown:nope')
      expect(listedSpy.calls.length).toBe(0)
    } finally {
      listedSpy.restore()
      src.peers = origPeers
      src.places.rename('p:peer-box:app', '')
      src.places.rename('p:peer-box:api', '')
    }
  })

  test('tellWaits skips building idle coordinator chats and withAsks settles archived task cards once', async () => {
    const dir = tmp('fast-asks')
    run(REPO, dir)
    const p = await src.places.add(dir, 'fast-asks')
    const coord = placeId.space(p.name)
    const chatSpy = jestSpy(src.chats as unknown as Record<string, (...args: unknown[]) => unknown>, 'chat')
    src.tellWaits(Date.now())
    expect(chatSpy.calls.filter((c) => c[0] === coord).length).toBe(0)
    // 1) archived task with choice card answered in its chat, 2) archived task closed by a peer relay ("No longer waits ·"),
    // 3) archived task with plain-reply ask, and 4) archived task whose background log read is still in flight (must not persist yet)
    const baseAt = Date.now() - 20_000
    const mkTask = (tid: string) => {
      src.engine.tasks.push({
        id: tid,
        n: 1,
        project: coord,
        base: 'main',
        branch: 'main',
        worktree: dir,
        title: `Task ${tid}`,
        desc: 'Done.',
        by: 'test',
        created: baseAt,
        updated: baseAt + 5000,
        merged: true,
        archived: true,
      } as never)
      return `${tid}/Agent`
    }
    const k1 = mkTask('FA-1')
    src.chats.post(k1, { id: 'ask:fa', at: baseAt + 1000, question: { id: 'ask:fa', title: 'Which?', kind: 'Question', choices: [{ label: 'A' }], to: k1 } } as never)
    src.chats.answer(k1, 'ask:fa', 0)
    src.chats.post(coord, {
      id: 'need:FA-1:1',
      at: baseAt + 2000,
      card: {
        id: 'need:FA-1:1',
        task: 'FA-1',
        title: 'Task FA-1',
        status: 'need',
        text: 'needs you',
        ask: { chat: k1, questions: [{ id: 'ask:fa', title: 'Which?', kind: 'Question', choices: [{ label: 'A' }], to: k1 }] },
      },
    } as never)

    const k2 = mkTask('FA-2')
    src.chats.post(k2, { id: 'ask:fa2', at: baseAt + 1000, question: { id: 'ask:fa2', title: 'Keep?', kind: 'Question', choices: [{ label: 'Y' }], to: k2 } } as never)
    src.chats.post(k2, { id: 'you:fa2', at: baseAt + 1500, who: 'you', text: 'Skip it' })
    src.chats.post(coord, {
      id: 'need:FA-2:1',
      at: baseAt + 2000,
      card: {
        id: 'need:FA-2:1',
        task: 'FA-2',
        title: 'Task FA-2',
        status: 'need',
        text: 'needs you',
        ask: { chat: k2, questions: [{ id: 'ask:fa2', title: 'Keep?', kind: 'Question', choices: [{ label: 'Y' }], to: k2 }] },
      },
    } as never)

    // also verify hostFor does not attach a posted card to an agent reply across a hidden browser note
    const eventsMap = (src.chats as unknown as { events: Map<string, unknown[]> }).events
    src.chats.post(k2, { id: 'ask:note', at: baseAt + 3000, question: { id: 'ask:note', title: 'Color?', kind: 'Question', choices: [{ label: 'Blue' }], to: k2 } } as never)
    eventsMap.set(k2, [
      { kind: 'agent', id: 'a-before', at: baseAt + 3010, text: 'Asking.' },
      { kind: 'user', id: 'u-note', at: baseAt + 3100, text: '<shepherdr><browser from="Elias">Use blue</browser></shepherdr>' },
      { kind: 'agent', id: 'a-after', at: baseAt + 3200, text: 'Done.' },
    ])
    src.chats.post(k2, { id: 'art:1', at: baseAt + 3210, artifact: { id: 'a1', v: 1 } })
    src.chats.post(k2, { id: 'ask:art', at: baseAt + 3220, question: { id: 'ask:art', title: 'Ok?', kind: 'Question', choices: [{ label: 'Yes' }], to: k2 } } as never)
    src.chats.post(k2, { id: 'sec:1', at: baseAt + 3300, secret: { id: 'sec:1', name: 'API_KEY', levels: [{ id: 'all', label: 'All' }] } })
    const k2Chat = src.chats.chat(k2)
    expect(k2Chat.messages.find((m) => m.question?.id === 'ask:note')?.at).toBeLessThan(baseAt + 3100)
    expect(k2Chat.messages.some((m) => m.question?.id === 'ask:art')).toBe(true)
    expect(k2Chat.messages.some((m) => m.secret?.name === 'API_KEY')).toBe(true)
    expect(src.chats.tokens(k2)).toBe(0)
    expect(src.chats.openCardsQuick(k2).map((m) => m.question.id)).toContain('ask:art')
    src.chats.answer(k2, 'ask:art', 0)
    expect(src.chats.openCardsQuick(k2)).toEqual([])

    const k3 = mkTask('FA-3')
    src.chats.post(coord, {
      id: 'need:FA-3:1',
      at: baseAt + 2000,
      card: { id: 'need:FA-3:1', task: 'FA-3', title: 'Task FA-3', status: 'need', text: 'needs you', ask: { chat: k3, reply: { id: 'r-3', text: 'Ready?' } } },
    } as never)

    const k4 = mkTask('FA-4')
    src.chats.post(coord, {
      id: 'need:FA-4:1',
      at: baseAt + 2000,
      card: { id: 'need:FA-4:1', task: 'FA-4', title: 'Task FA-4', status: 'need', text: 'needs you', ask: { chat: k4, reply: { id: 'r-4', text: 'Still reading?' } } },
    } as never)
    const readingSet = (src.chats as unknown as { reading: Set<string> }).reading
    readingSet.add(k4)
    try {
      chatSpy.calls.length = 0
      const first = src.chat(coord)!
      expect(first.messages.find((m) => m.card?.id === 'need:FA-1:1')?.card?.ask?.answered).toEqual({ where: 'task', text: undefined, dismissed: undefined })
      expect(first.messages.find((m) => m.card?.id === 'need:FA-2:1')?.card?.ask?.open).toBe(false)
      expect(first.messages.find((m) => m.card?.id === 'need:FA-2:1')?.card?.ask?.questions?.[0]?.elsewhere?.label).toBe('No longer waits ·')
      expect(first.messages.find((m) => m.card?.id === 'need:FA-3:1')?.card?.ask?.answered).toEqual({ where: 'task' })
      expect([k1, k2, k3, k4].every((k) => chatSpy.calls.filter((c) => c[0] === k).length === 1)).toBe(true)

      readingSet.delete(k4)
      chatSpy.calls.length = 0
      const second = src.chat(coord)!
      expect(second.messages.find((m) => m.card?.id === 'need:FA-1:1')?.card?.ask?.open).toBe(false)
      expect(second.messages.find((m) => m.card?.id === 'need:FA-2:1')?.card?.ask?.open).toBe(false)
      expect(second.messages.find((m) => m.card?.id === 'need:FA-3:1')?.card?.ask?.open).toBe(false)
      // FA-1, FA-2, FA-3 were persisted and skipped; FA-4 was still reading on pass 1, so pass 2 reads and settles it once
      expect(chatSpy.calls.filter((c) => c[0] === k1).length).toBe(0)
      expect(chatSpy.calls.filter((c) => c[0] === k2).length).toBe(0)
      expect(chatSpy.calls.filter((c) => c[0] === k3).length).toBe(0)
      expect(chatSpy.calls.filter((c) => c[0] === k4).length).toBe(1)

      chatSpy.calls.length = 0
      src.chat(coord)
      expect(chatSpy.calls.filter((c) => c[0] === k4).length).toBe(0)
    } finally {
      readingSet.delete(k4)
      chatSpy.restore()
    }
  })
})

function jestSpy<T extends Record<string, (...args: never[]) => unknown>>(obj: T, method: keyof T) {
  const orig = obj[method]
  const calls: unknown[][] = []
  obj[method] = ((...args: unknown[]) => {
    calls.push(args)
    return orig.apply(obj, args as never[])
  }) as unknown as T[keyof T]
  return {
    calls,
    restore: () => {
      obj[method] = orig
    },
  }
}
