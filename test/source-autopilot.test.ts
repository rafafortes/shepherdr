// Autopilot, its news and its artifacts: the mode, the heartbeat, automations, the news a coordinator gets, artifacts
// from the command and another machine's, a task row's menu, and Autopilot from the command.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmp } from './tmp.ts'
import { CODEX_WORDS, PI_WORDS, reviewerLineFor } from './reviewer-line.ts'

process.env.SHEPHERDR_HOME = tmp('source')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
// no OpenCode database of this machine: its mirror copies rows from one that isn't there (an OpenCode log reads as a
// copy of its session)
process.env.SHEPHERDR_OPENCODE_DB = join(process.env.SHEPHERDR_HOME, 'no-opencode.db')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { HOST, NAME, placeId, Places } = await import('../server/live/places.ts')
const { herdr } = await import('../server/live/herdr.ts')
const { hidden } = await import('../server/live/agents.ts')
const { isAgentProcess } = await import('../server/live/agent-process.ts')
const { heartbeatFile } = await import('../server/live/heartbeat.ts')
const { carryOn, momentOf } = await import('../server/live/retry.ts')
const { parseUserLine } = await import('../server/live/chatlines.ts')
const { WorkerHealth } = await import('../server/live/recovery.ts')
const { Worktrees } = await import('../server/live/engine/worktrees.ts')
const { fakeHerdr } = await import('./fake-herdr.ts')
const { setPicks } = await import('../server/live/model-picks.ts')
const { NO_PICKS } = await import('../shared/picks.ts')
const { ADVISOR_AT_ONCE } = await import('../shared/apply-waiting.ts')

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

/**
 * Something that only has to settle before the tests after this one (an agent herdr can't start): waited for at
 * most 8 s — the 20 s these tests run in is the other bound — and the test goes on either way, however slow the
 * machine. The fixed 5 s these had failed a slow runner; a longer wait would only spend a test's own time.
 */
const settle = (f: () => boolean, said: string) => until(f, 8000, said).catch(() => undefined)

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

/** how many tasks a place holds: what a refused add must leave exactly as it was, whatever else the home holds */
const tasksIn = (place: string) => src.engine.tasks.filter((t) => t.project === place).length

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

describe('modes: regular and Autopilot', () => {
  test('a saved mode that is neither loads as regular and is dropped', () => {
    writeFileSync(join(process.env.SHEPHERDR_HOME!, 'modes.json'), JSON.stringify({ 'p:h:old': 'manual', 'p:h:co': 'copilot', 'p:h:auto': 'autopilot', 'p:h:reg': 'Regular' }))
    const places = new Places()
    expect([places.mode('p:h:old'), places.mode('p:h:co'), places.mode('p:h:auto'), places.mode('p:h:reg'), places.mode('p:h:new')]).toEqual(['regular', 'regular', 'autopilot', 'regular', 'regular'])
    places.save()
    expect(JSON.parse(readFileSync(join(process.env.SHEPHERDR_HOME!, 'modes.json'), 'utf8'))).toEqual({ 'p:h:auto': 'autopilot', 'p:h:reg': 'regular' })
  })
  test('shepherdr mode takes regular and autopilot, any case', async () => {
    expect((await src.cli(['mode', 'home', 'Autopilot'], {})).out.trim()).toBe('home: Autopilot on.')
    expect((await src.cli(['mode', 'home', 'regular'], {})).out.trim()).toBe('home: Autopilot off.')
    for (const m of ['copilot', 'manual', 'sleepy']) expect((await src.cli(['mode', 'home', m], {})).code).toBe(1)
  })
})

describe('news for coordinators', () => {
  test('helper task add forwards the full remote identity, options and known requesting coordinator', async () => {
    const peers = src.peers!
    const list = peers.list
    const fetch = peers.fetch
    const chat = placeId.home()
    const record = src.agents.records[chat]
    src.agents.records[chat] = { key: chat, name: 'home', kind: 'codex', cwd: '/', workspace: 'home', logs: [], started: 1 }
    // durable at once: save() coalesces agents.json to the end of the event-loop turn, and the command reads it back
    // synchronously (the tests before this one had left the record on disk, so this file's order was doing the work)
    src.agents.save()
    src.agents.flushRecords()
    const calls: { args: string[]; chat?: string }[] = []
    peers.list = (() => [{ rec: { machine: 'desktop' }, snap: { places: [{ id: 'p:desktop:remote', name: 'Remote', home: false }] } }]) as never
    peers.fetch = (async (_l, path, init) => {
      expect(path).toBe('/api/cli')
      calls.push(JSON.parse(String(init!.body)))
      return Response.json({ code: 0, out: 'Added REM-1: Remote task.' })
    }) as typeof fetch
    try {
      const result = await src.cli(['task', 'add', 'Remote task', '--space', 'p:desktop:remote', '--desc', 'Whole brief', '--later'], { chat })
      expect(result.code).toBe(0)
      expect(calls[0]).toEqual({ args: ['task', 'add', 'Remote task', '--space', 'remote', '--desc', 'Whole brief', '--later'], chat })
      await src.cli(['task', 'add', 'Terminal task', '--space', 'p:desktop:remote'], { chat: 'invented' })
      expect(calls[1].chat).toBeUndefined()
    } finally {
      peers.list = list
      peers.fetch = fetch
      if (record) src.agents.records[chat] = record
      else delete src.agents.records[chat]
      src.agents.save()
    }
  })
  test('requester news preserves owner/home routes, carries no extra card, and drops removed origins', async () => {
    const { t, place } = await workedTask('requestnews')
    const originDir = tmp('request-origin')
    run('git init -q -b main', originDir)
    const origin = await src.places.add(originDir, 'requestorigin')
    const requester = placeId.space(origin.name)
    const sent: { chat: string; text: string }[] = []
    const send = src.agents.send
    const old = src.agents.records[requester]
    src.agents.records[requester] = { key: requester, name: 'coordinator', kind: 'codex', logs: [], cwd: originDir, workspace: 'origin', started: 1 }
    src.agents.send = (async (chat: string, text: string) => { sent.push({ chat, text }); return { waiting: false } }) as never
    const drain = () => (src as unknown as { drainRequestedNews(): Promise<void> }).drainRequestedNews()
    try {
      t.requester = requester
      const before = src.chats.chat(requester).messages.length
      src.engine.emit('news', place, `${t.id} is ready`, 'ready', { task: t.id, event: 'ready' })
      await until(() => sent.some((n) => n.chat === requester))
      expect(sent.map((n) => n.chat).sort()).toEqual([place, placeId.home(), requester].sort())
      expect(sent.find((n) => n.chat === requester)!.text).toContain('You requested this task')
      expect(src.chats.chat(requester).messages).toHaveLength(before)
      await drain()
      expect(sent.filter((n) => n.chat === requester)).toHaveLength(1)
      // Ordinary same-space tasks keep their original single delivery.
      t.requester = place
      sent.length = 0
      src.engine.emit('news', place, `${t.id} is ready`, 'ready', { task: t.id, event: 'ready' })
      await drain()
      expect(sent.map((n) => n.chat).sort()).toEqual([place, placeId.home()].sort())
      // A saved return address cannot resurrect a removed space.
      t.requester = requester
      src.places.spaces = src.places.spaces.filter((p) => p !== origin)
      sent.length = 0
      src.engine.emit('news', place, `${t.id} merged`, 'done', { task: t.id, event: 'merged' })
      await until(() => !(src as unknown as { drainingNews: boolean }).drainingNews)
      expect(sent.some((n) => n.chat === requester)).toBe(false)
    } finally {
      src.agents.send = send
      if (old) src.agents.records[requester] = old
      else delete src.agents.records[requester]
      if (!src.places.spaces.includes(origin)) src.places.spaces.push(origin)
    }
  })
  test("every space starts regular; the main machine's home space hears every space's news, a task added only on Autopilot", async () => {
    const project = placeId.space('newsco')
    const home = placeId.home()
    const sent: string[] = []
    const send = src.agents.send
    src.agents.send = (async (k: string) => (k === project || k === home ? sent.push(k) : 0, { waiting: false })) as never
    const modes = { ...src.places.modes }
    const news = (kind: 'added' | 'ready', at = project) => (sent.length = 0, src.engine.emit('news', at, 'NC-1 is ready', kind, { task: 'NC-1', event: kind }), [...sent].sort())
    try {
      for (const id of [project, home]) delete src.places.modes[id]
      expect(news('ready')).toEqual([home, project].sort())
      expect(news('added')).toEqual([])
      src.places.modes[project] = 'regular'
      src.places.modes[home] = 'autopilot'
      expect(news('ready')).toEqual([home, project].sort())
      expect(news('added')).toEqual([home])
      // the home space's own news goes to it once
      expect(news('ready', home)).toEqual([home])
    } finally {
      src.agents.send = send
      src.places.modes = modes
    }
  })
  test("news the human sees as a card gets its coordinator's short reply after it; unseen news may get <no-reply>", async () => {
    const project = placeId.space('newsreply')
    const said = new Map<string, string>()
    const send = src.agents.send
    src.agents.send = (async (k: string, text: string) => (said.set(k, text), { waiting: false })) as never
    const modes = { ...src.places.modes }
    const engine = src.engine as unknown as { emit(e: string, ...a: unknown[]): void }
    try {
      for (const id of [project, placeId.home()]) delete src.places.modes[id]
      // a status's card goes up, then its news: the coordinator replies after the card, never quietly
      const t = { id: 'NR-1', project, posted: 'ready|' } as never
      engine.emit('card', t, 'ready', '')
      engine.emit('news', project, 'NR-1 is ready to merge', 'ready', { task: 'NR-1', event: 'ready' })
      expect(said.get(project)).toContain('A card in this chat already shows the human the news: reply after it in one or two short lines')
      expect(said.get(project)).toContain('Never <no-reply> to it.')
      // the main machine's home space sees no card: it may stay quiet, or alert what can't wait
      expect(said.get(placeId.home())).toContain('newsreply: NR-1 is ready to merge')
      expect(said.get(placeId.home())).toContain('alert the human with shepherdr alert')
      expect(said.get(placeId.home())).toContain('<no-reply>reason</no-reply>')
      // a second word on the same merge (what its cleanup kept) has no card of its own
      engine.emit('news', project, 'NR-1 was merged; kept notes.md', 'done', { task: 'NR-1', event: 'merged' })
      expect(said.get(project)).toContain('reply with only <no-reply>reason</no-reply>')
      // main went red: a one-line card in the project's chat, and the coordinator's reply after it
      engine.emit('news', project, 'main went red on GitHub at 1a2b3c4: Check failed (link).', 'red', { task: '', event: 'main-red' }, { red: 'main', text: 'went red: Check failed' })
      expect(src.chats.chat(project).messages.filter((m) => m.card?.red).map((m) => m.text)).toEqual(['main went red: Check failed'])
      expect(said.get(project)).toContain('Never <no-reply> to it.')
    } finally {
      src.agents.send = send
      src.places.modes = modes
    }
  })
})

describe("every machine's news reaches the main machine's home space", () => {
  test("another machine's needs-you, red main and health come over its worker's link in one line each; the space's coordinator has the whole", async () => {
    const { startApp } = await import('../server/app.ts')
    const { Emitter } = await import('../server/source.ts')
    // the other machine's worker: its app, its news as its LiveSource emits it
    const worker = Object.assign(new Emitter(), {
      kind: 'live',
      snapshot: () => ({ name: 'S', host: 'faraway', places: [{ id: 'p:faraway:shop', name: 'shop', machine: 'faraway', level: 1, status: 'need', mode: 'regular', chat: 'p:faraway:shop' }], machines: [{ id: 'm:faraway', machine: 'faraway', name: 'faraway', status: 'need' }], tasks: [{ id: 'FS-1', name: 'Colours', status: 'need', place: 'p:faraway:shop', age: '1m', state: '', on: '', created: '' }], automations: {}, asks: {}, settings: [], overrides: {}, user: 'u' }),
      chat: () => undefined,
      watch: () => {},
    })
    const app = startApp({ source: worker as never, dist: '/nonexistent', port: 0 })
    // news from before the main machine's link (its server restarting) waits for it
    worker.emit('news', { place: 'p:faraway:shop', line: 'FS-0 is ready to merge', kind: 'ready', about: { task: 'FS-0', event: 'ready' } })
    const home = placeId.home()
    const said: string[] = []
    const send = src.agents.send
    src.agents.send = (async (k: string, text: string) => (k === home && said.push(text), { waiting: false })) as never
    const alerts: { title: string; go: { place: string; task?: string }; task?: true }[] = []
    const off = src.on('alert', (a) => alerts.push(a))
    try {
      const l = src.peers!.adopt('faraway', `http://127.0.0.1:${app.port}`)
      await until(() => l.ws?.readyState === WebSocket.OPEN)
      await until(() => said.length > 0)
      expect(said.shift()).toContain('faraway · shop: FS-0 is ready to merge.')
      worker.emit('news', { place: 'p:faraway:shop', line: 'FS-1 needs you: Which colour?', kind: 'need', about: { task: 'FS-1', event: 'needs-you' } })
      await until(() => said.length > 0)
      expect(said[0]).toContain('<news task="FS-1" event="needs-you">faraway · shop: FS-1 needs you: Which colour?.')
      expect(said[0]).toContain('Its own coordinator has the whole of it.')
      expect(said[0]).toContain('alert the human with shepherdr alert')
      // main red: only its first line, never the log under it
      worker.emit('news', { place: 'p:faraway:shop', line: 'main went red on GitHub at 1a2b3c4: Check failed (link).\nIts log ends:\n> boom', kind: 'red', about: { task: '', event: 'main-red' } })
      worker.emit('news', { place: 'p:faraway:~', line: "herdr isn't answering (since 10:00), so its agents can't hear anything", kind: 'health', about: { kind: 'herdr', what: 'over' } })
      // a task added: only while the main machine's home space is on Autopilot
      worker.emit('news', { place: 'p:faraway:shop', line: 'FS-2 was added: More', kind: 'added', about: { task: 'FS-2', event: 'added' } })
      await until(() => said.length >= 3)
      await Bun.sleep(100)
      expect(said.length).toBe(3)
      expect(said[1]).toContain('faraway · shop: main went red on GitHub at 1a2b3c4: Check failed (link).')
      expect(said[1]).not.toContain('boom')
      expect(said[2]).toContain('<health kind="herdr" what="over">Machine faraway: herdr isn')
      // its alert about that task opens on it, and buzzes while the task waits on you
      expect((await src.cli(['alert', 'FS-1 waits on a colour', '--task', 'FS-1'], { chat: home })).out.trim()).toBe('Alert sent.')
      expect(alerts.at(-1)).toMatchObject({ title: 'FS-1 waits on a colour', go: { place: 'p:faraway:shop', task: 'FS-1' }, task: true })
    } finally {
      off()
      src.agents.send = send
      app.stop(true)
    }
  })
  test("a worker passes each piece of its machine's news on, for its link to carry to the main machine", () => {
    const got: { place: string; line: string; kind: string }[] = []
    const off = src.on('news', (n) => got.push(n))
    const send = src.agents.send
    src.agents.send = (async () => ({ waiting: false })) as never
    try {
      src.engine.emit('news', placeId.space('newsout'), 'NO-1 needs you: Signed out', 'need', { task: 'NO-1', event: 'needs-you' })
      expect(got).toEqual([{ place: placeId.space('newsout'), line: 'NO-1 needs you: Signed out', kind: 'need', about: { task: 'NO-1', event: 'needs-you' } } as never])
    } finally {
      off()
      src.agents.send = send
    }
  })
})

describe('Autopilot switched on or off', () => {
  test("posts one card in the place's chat and tells its coordinator quietly; no change, no card", async () => {
    const place = placeId.home(HOST)
    src.places.setMode(place, 'regular')
    // only this test's (shepherdr mode switched the home space before)
    const since = Date.now()
    const cards = () => src.chats.chat(place).messages.filter((m) => m.card?.mode && (m.at ?? 0) >= since)
    const sent: string[] = []
    const send = src.agents.send
    const status = src.agents.status
    src.agents.send = (async (_k: string, text: string) => (sent.push(text), { waiting: false })) as typeof send
    src.agents.status = (() => 'idle') as typeof status
    try {
      expect(await src.act({ type: 'mode', place, mode: 'regular' })).toEqual({})
      expect(cards()).toEqual([])
      expect(sent).toEqual([])
      expect((await src.cli(['mode', 'home', 'autopilot'], {})).code).toBe(0)
      expect(await src.act({ type: 'mode', place, mode: 'autopilot' })).toEqual({})
      expect((await src.cli(['mode', 'home', 'regular'], {})).code).toBe(0)
      expect(await src.act({ type: 'mode', place, mode: 'copilot' as never })).toEqual({ ok: false, error: 'No such mode.' })
    } finally {
      src.agents.send = send
      src.agents.status = status
    }
    expect(cards().map((m) => [m.card!.mode, m.text])).toEqual([
      ['autopilot', 'Autopilot on · works on its own'],
      ['autopilot', 'Autopilot off · does what you ask'],
    ])
    expect(sent).toHaveLength(2)
    expect(sent[0]).toContain('<shepherdr><mode mode="autopilot">Autopilot is now on: you also work on your own')
    expect(sent[1]).toContain('<shepherdr><mode mode="regular">Autopilot is now off: do what the human asks, nothing on your own, and no more heartbeats.')
    expect(sent[0]).toContain("don't announce it, reply with only <no-reply>reason</no-reply>")
  })
})

describe("Autopilot's heartbeat", () => {
  const min = 60_000
  test('on its time rule, only while its coordinator is idle; the news its event rules name wakes it at once, the rest waits for it', async () => {
    const dir = tmp('beat')
    run('git init -q -b main', dir)
    const p = await src.places.add(dir, 'beat')
    const place = placeId.space(p.name)
    const sent: { k: string; text: string }[] = []
    const send = src.agents.send
    const status = src.agents.status
    const reachable = src.agents.reachable
    let st = 'working'
    src.agents.send = (async (k: string, text: string) => (sent.push({ k, text }), { waiting: false })) as typeof send
    src.agents.status = ((k: string) => (k === place ? st : 'gone')) as typeof status
    src.agents.reachable = true
    const beats = () => sent.filter((x) => x.k === place && x.text.includes('<heartbeat>'))
    // on a half hour: every 30 minutes runs on the clock's :00 and :30
    const t0 = Math.floor(Date.now() / (30 * min)) * 30 * min
    try {
      src.places.setMode(place, 'autopilot')
      src.heartbeats.switched(place, true, t0)
      src.heartbeat(t0 + 29 * min)
      expect(beats()).toEqual([])
      // due, but busy: it waits for the turn to end
      src.heartbeat(t0 + 31 * min)
      expect(beats()).toEqual([])
      // all news (the default) wakes the coordinator at once, merged news too: none waits for the heartbeat
      src.engine.emit('news', place, 'BE-1 was added: Fix it', 'added', { task: 'BE-1', event: 'added' })
      src.engine.emit('news', place, 'BE-2 needs you: a question', 'need', { task: 'BE-2', event: 'needs-you' })
      src.engine.emit('news', place, 'BE-3 is merged', 'done', { task: 'BE-3', event: 'merged' })
      expect(sent.filter((x) => x.k === place).map((x) => x.text)).toEqual([
        expect.stringContaining('<news task="BE-1" event="added">BE-1 was added'),
        expect.stringContaining('<news task="BE-2" event="needs-you">BE-2 needs you'),
        expect.stringContaining('<news task="BE-3" event="merged">BE-3 is merged'),
      ])
      // only what needs you wakes it: other news waits for the next heartbeat
      expect(src.settings.set('heartbeat.on', 'needs-you', { space: p.name }).ok).toBe(true)
      src.engine.emit('news', place, 'BE-4 is ready to merge', 'ready', { task: 'BE-4', event: 'ready' })
      expect(sent.filter((x) => x.k === place).some((x) => x.text.includes('BE-4'))).toBe(false)
      st = 'idle'
      src.heartbeat(t0 + 32 * min)
      expect(beats()).toHaveLength(1)
      const beat = beats()[0].text
      expect(beat).toStartWith('<shepherdr><heartbeat>Heartbeat. Go through your HEARTBEAT.md: ')
      expect(beat).toContain('Your HEARTBEAT.md:\n# Heartbeat')
      expect(beat).not.toContain('BE-1')
      expect(beat).toContain('News since the last heartbeat')
      expect(beat).toContain('- BE-4 is ready to merge')
      src.settings.set('heartbeat.on', null, { space: p.name })
      expect(beat).toContain('<no-reply>heartbeat: nothing to do</no-reply>')
      // the quiet marker the coordinator answers with shows nothing in the chat
      expect((await src.cli(['heartbeat'], { chat: place })).out).toMatch(/heartbeat: Every 30 minutes \(.+\); last .+; next .+ once idle\. Wakes at once on: all news\./)
      // read and changed with the command, from any machine: the checklist itself, never its path
      expect((await src.cli(['heartbeat'], { chat: place })).out).toContain('HEARTBEAT.md:\n# Heartbeat')
      expect((await src.cli(['heartbeat', 'set'], { chat: place })).out).toContain('on stdin')
      expect((await src.cli(['heartbeat', 'set', p.name], { stdin: '- Check the ROM builds\n' })).out).toContain('is saved')
      const shown = (await src.cli(['heartbeat', p.name], {})).out
      expect(shown).toContain('HEARTBEAT.md:\n- Check the ROM builds')
      expect(shown).not.toContain(heartbeatFile(place))
      const show = (await src.cli(['show'], { chat: place })).out
      expect(show).toContain('Heartbeat on Autopilot: Every 30 minutes (')
      expect(show).toContain("news that wakes it at once: all news, the rest waits for the heartbeat. Each brings the place's HEARTBEAT.md")
      // once given, the next is the rule's next run
      src.heartbeat(t0 + 40 * min)
      expect(beats()).toHaveLength(1)
      src.heartbeat(t0 + 62 * min)
      expect(beats()).toHaveLength(2)
      // an empty HEARTBEAT.md, edited in Settings: no heartbeat
      expect(await src.act({ type: 'setting', key: 'heartbeat.md', value: '', place })).toEqual({ ok: true })
      expect(src.snapshot().settings.find((x) => x.level === place && x.name === 'Autopilot')!.rows.find((r) => r.key === 'heartbeat.md')).toMatchObject({ value: '', doc: true })
      src.heartbeat(t0 + 93 * min)
      expect(beats()).toHaveLength(2)
      // off Autopilot: no heartbeat however long it waits
      src.places.setMode(place, 'regular')
      src.heartbeats.switched(place, false)
      await src.act({ type: 'setting', key: 'heartbeat.md', value: '- check things', place })
      src.heartbeat(t0 + 300 * min)
      expect(beats()).toHaveLength(2)
    } finally {
      src.agents.send = send
      src.agents.status = status
      src.agents.reachable = reachable
    }
  })
  test('the quiet marker shows nothing in the chat', async () => {
    const { agentLines } = await import('../server/live/chatlines.ts')
    expect(agentLines('<no-reply>heartbeat: nothing to do</no-reply>').text).toBe('')
  })

  test("Run now: one wake on the human's word, refused while one waits or runs, and the command wakes it too", async () => {
    const dir = tmp('now')
    run('git init -q -b main', dir)
    const p = await src.places.add(dir, 'now')
    const place = placeId.space(p.name)
    // the time rule is not what this test is about: with it off, the clock's half hours cannot add a beat to the count
    expect(src.settings.set('heartbeat.when', 'off', { space: p.name }).ok).toBe(true)
    const sent: { k: string; text: string }[] = []
    const send = src.agents.send
    const status = src.agents.status
    const reachable = src.agents.reachable
    let st = 'idle'
    src.agents.send = (async (k: string, text: string) => (sent.push({ k, text }), { waiting: false })) as typeof send
    src.agents.status = ((k: string) => (k === place ? st : 'gone')) as typeof status
    src.agents.reachable = true
    const wakes = () => sent.filter((x) => x.k === place && x.text.includes('<heartbeat'))
    const runNow = () => src.snapshot().places.find((x) => x.id === place)?.runNow
    // the turn runs, and is over: what the 30 s tick sees, at the clock this test keeps
    const turn = (t: number) => {
      st = 'working'
      src.heartbeat(t)
      st = 'idle'
      src.heartbeat(t + 60_000)
    }
    try {
      // off Autopilot: the screens offer nothing, and one that asks is refused
      src.places.setMode(place, 'regular')
      expect(runNow()).toBeUndefined()
      expect(await src.act({ type: 'heartbeat', place, op: 'run' })).toEqual({ ok: false, error: `${p.name} is not on Autopilot: switch it on first.` })
      src.places.setMode(place, 'autopilot')
      expect(runNow()).toBe('ready')
      // nothing to go through: refused, and no turn is spent
      await src.act({ type: 'setting', key: 'heartbeat.md', value: '', place })
      expect(await src.act({ type: 'heartbeat', place, op: 'run' })).toEqual({ ok: false, error: `Nothing to run: ${p.name}'s HEARTBEAT.md is empty and no news waits for it.` })
      expect(wakes()).toEqual([])
      // with its checklist: one wake, now, carrying the checklist itself (never a path)
      expect(await src.act({ type: 'setting', key: 'heartbeat.md', value: '- Check the tasks', place })).toEqual({ ok: true })
      expect(await src.act({ type: 'heartbeat', place, op: 'run' })).toEqual({ ok: true, queued: false })
      expect(wakes()).toHaveLength(1)
      expect(wakes()[0].text).toContain('<heartbeat reason="run now">')
      expect(wakes()[0].text).toContain('- Check the tasks')
      expect(wakes()[0].text).not.toContain(heartbeatFile(place))
      // the screens say Waking, and a second tap is refused: one wake at a time
      expect(runNow()).toBe('waking')
      expect(await src.act({ type: 'heartbeat', place, op: 'run' })).toEqual({ ok: false, error: `${p.name}'s coordinator is already waking: one wake at a time.` })
      expect(wakes()).toHaveLength(1)
      turn(Date.now())
      expect(runNow()).toBe('ready')
      // a tap while its coordinator is busy is kept for its turn: one wake when that is over, never two at once
      st = 'working'
      expect(await src.act({ type: 'heartbeat', place, op: 'run' })).toEqual({ ok: true, queued: true })
      expect(runNow()).toBe('queued')
      expect(wakes()).toHaveLength(1)
      st = 'idle'
      src.heartbeat(Date.now() + 120_000)
      expect(wakes()).toHaveLength(2)
      // its turn over again: the command wakes it once, as a human's own terminal would
      turn(Date.now() + 180_000)
      const r = await src.cli(['heartbeat', 'run', p.name], {})
      expect(r.code).toBe(0)
      expect(r.out).toContain(`Woke ${p.name}'s coordinator: one heartbeat now`)
      expect(wakes()).toHaveLength(3)
      expect(wakes()[2].text).toContain('reason="run now"')
      // and the command refuses what the screens hide: a place off Autopilot
      src.places.setMode(place, 'regular')
      const off = await src.cli(['heartbeat', 'run', p.name], {})
      expect(off.code).toBe(1)
      expect(off.out).toContain('is not on Autopilot: switch it on first.')
    } finally {
      src.places.setMode(place, 'regular')
      src.agents.send = send
      src.agents.status = status
      src.agents.reachable = reachable
    }
  })
})

describe('automations add tasks with fresh agents', () => {
  test('on a time rule and on an event, each run a new task from its template; paused, run now, edited, removed', async () => {
    const { t, place } = await workedTask('autos')
    const name = src.places.space(place)!.name
    const tasks = () => src.engine.tasks.filter((x) => x.project === place && x.by.startsWith('the automation'))
    const add = await src.cli(['automation', 'add', 'Nightly', '--task', 'Bump deps', '--brief', 'Bump and test.', '--when', 'FREQ=MINUTELY;INTERVAL=5', '--agent', 'codex'], { chat: place })
    expect(add.out).toMatch(/^Automation “Nightly” is on: Every 5 minutes \(.+\); next .+ \[--when "DTSTART:20260101T000000 RRULE:FREQ=MINUTELY;INTERVAL=5"\]\. It adds the task “Bump deps” to autos, with a fresh agent/)
    // its first run is the rule's first after it was made: as if made six minutes ago
    src.automations.find(place, 'Nightly')!.since = Date.now() - 6 * 60_000
    ;(src as unknown as { runSchedules(): void }).runSchedules()
    expect(tasks().map((x) => [x.title, x.by, x.agent?.kind])).toEqual([['Bump deps', 'the automation “Nightly”', 'codex']])
    expect(tasks()[0].desc).toStartWith('Bump and test.')
    // the next run is five minutes after the last
    ;(src as unknown as { runSchedules(): void }).runSchedules()
    expect(tasks()).toHaveLength(1)
    expect(src.snapshot().automations[place][0]).toMatchObject({ name: 'Nightly', when: expect.stringMatching(/^Every 5 minutes \(/), what: 'Bump deps', on: true, next: expect.any(Array), runs: [{ task: tasks()[0].id }] })
    // an event: a task merged adds one; a task an automation added sets off no 'added' automation
    await src.cli(['automation', 'add', 'Notes', '--task', 'Write notes', '--on', 'merged'], { chat: place })
    await src.cli(['automation', 'add', 'Echo', '--task', 'Echo', '--on', 'added'], { chat: place })
    await src.cli(['merge', t.id], {})
    await until(() => tasks().some((x) => x.title === 'Write notes'))
    expect(tasks().filter((x) => x.title === 'Echo')).toHaveLength(0)
    // from the screen: paused, run now, removed; changed only by the command
    expect(await src.act({ type: 'automation', place, op: 'pause', name: 'Nightly' })).toEqual({ ok: true })
    expect(src.automations.dueNow(src.settings.zone(), Date.now() + 3_600_000).map((a) => a.name)).not.toContain('Nightly')
    expect(await src.act({ type: 'automation', place, op: 'run', name: 'Nightly' })).toEqual({ ok: true })
    expect(tasks().filter((x) => x.title === 'Bump deps')).toHaveLength(2)
    await src.cli(['automation', 'edit', 'Nightly', '--when', 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0', '--task', 'Bump all deps', '--brief', ''], { chat: place })
    expect(src.automations.find(place, 'Nightly')).toMatchObject({ trigger: { time: 'DTSTART:20260101T000000 RRULE:FREQ=DAILY;BYHOUR=3;BYMINUTE=0' }, task: { title: 'Bump all deps', agent: { kind: 'codex' } }, on: false })
    expect(src.automations.find(place, 'Nightly')!.task.desc).toBeUndefined()
    expect((await src.cli(['automation', 'add', 'Bad', '--task', 'x', '--when', 'sometimes'], { chat: place })).out).toContain("Can't read the time rule")
    // the old flags are gone
    expect((await src.cli(['automation', 'add', 'Old', '--task', 'x', '--schedule', 'daily 9:00'], { chat: place })).out).toContain('takes no --schedule')
    // the screen adds or changes none
    expect(await src.act({ type: 'automation', place, op: 'save', name: 'Nightly' } as never)).toMatchObject({ ok: false })
    expect(await src.act({ type: 'automation', place, op: 'remove', name: 'Echo' })).toEqual({ ok: true })
    expect((await src.cli(['automation', 'list', '--space', name], {})).out).toMatch(/Nightly · Every day at 3:00 \(.+\) \[--when "DTSTART:20260101T000000 RRULE:FREQ=DAILY;BYHOUR=3;BYMINUTE=0"\] · adds “Bump all deps” \(codex\) · autos · paused · last ran/)
    // the old kinds are gone
    expect((await src.cli(['automation', 'add', 'Ask', '--ask', 'What waits?', '--when', 'FREQ=DAILY'], { chat: place })).out).toContain('takes no --ask')
  })
})

describe('artifacts from the command', () => {
  const files = tmp('src-art')
  writeFileSync(join(files, 'board.html'), '<h1>Board</h1>')
  writeFileSync(join(files, 'data.json'), '{"n":2}')
  const ok = async () => ({ errors: [], warnings: [], skipped: 'no browser in the test' })

  test('made in a task chat: a card there, kept in its project; an update is a new version, data alone keeps the page', async () => {
    src.checker = ok
    const { t, place } = await workedTask('arts')
    const chat = `${t.id}/Agent`
    const r = await src.cli(['artifact', 'new', 'board.html', '--title', 'Weekly board'], { chat, cwd: files })
    expect(r.code).toBe(0)
    expect(r.out).toContain('No pictures: no browser in the test')
    const id = r.out.match(/artifact (\w+) “Weekly board” v1/)![1]
    expect(src.snapshot().artifacts.find((a) => a.id === id)).toMatchObject({ title: 'Weekly board', place, v: 1, by: `${t.id} agent`, keeper: `${t.id} agent` })
    expect(src.chats.chat(chat).messages.find((m) => m.artifact?.id === id)?.artifact).toEqual({ id, v: 1 })
    // its coordinator brings new numbers: v2, the same page, a card in the coordinator's chat
    const u = await src.cli(['artifact', 'update', id, '--data', 'data.json', '--note', 'fresh'], { chat: place, cwd: files })
    expect(u.out).toContain(`${id} “Weekly board” is v2 (same page, new data)`)
    expect(await src.artifact(id)).toEqual({ html: '<h1>Board</h1>', data: { n: 2 }, sent: undefined })
    expect(src.chats.chat(place).messages.find((m) => m.artifact?.id === id)?.artifact).toEqual({ id, v: 2 })
    expect((await src.cli(['artifact', 'show', id], {})).out).toContain(`v2  now  arts  (data only)  fresh`)
    expect((await src.cli(['artifact', 'list'], {})).out).toContain(`${id}  v2  Weekly board  · arts`)
  })

  test('its card is a message of its own after the words it came with; a reaction or reply to it names it, and reads back on it', async () => {
    src.checker = ok
    const { t } = await workedTask('artre')
    const chat = `${t.id}/Agent`
    const id = (await src.cli(['artifact', 'new', 'board.html', '--title', 'Weekly board'], { chat, cwd: files })).out.match(/artifact (\w+)/)![1]
    const ev = (src.chats as unknown as { events: Map<string, unknown[]> }).events
    const log = (e: object) => ev.set(chat, [...(ev.get(chat) ?? []), { at: Date.now(), ...e }])
    // the agent's words of that turn come after it, and the card shows under them
    log({ kind: 'agent', id: 'w1', text: 'Here is the board.' })
    const msgs = () => src.chats.chat(chat).messages
    const at = msgs().findIndex((m) => m.id === 'w1')
    expect(msgs()[at]).not.toHaveProperty('artifact')
    const card = msgs()[at + 1]
    expect(card).toMatchObject({ who: 'agent', artifact: { id, v: 1 } })
    const sent: string[] = []
    const send = src.agents.send
    src.agents.send = (async (_k: string, text: string) => (sent.push(text), { waiting: false })) as typeof send
    try {
      expect(await src.act({ type: 'react', chat, message: card.id, emoji: '👍' })).toEqual({})
      await src.act({ type: 'send', chat, text: 'Bars in blue', reply: card.id })
    } finally {
      src.agents.send = send
    }
    expect(sent).toEqual([
      `<reaction from="${src.user}" emoji="👍" title="Weekly board" artifact="${id}" version="1"/>`,
      `<reply from="${src.user}" to="Weekly board · v1" artifact="${id}">Bars in blue</reply>`,
    ])
    log({ kind: 'user', id: 'u1', text: sent[0] })
    log({ kind: 'user', id: 'u2', text: sent[1] })
    expect(msgs().find((m) => m.id === card.id)?.reactions).toEqual([{ emoji: '👍', by: 'me' }])
    expect(msgs().find((m) => m.id === 'w1')?.reactions).toBeUndefined()
    expect(msgs().find((m) => m.id === 'u2')).toMatchObject({ text: 'Bars in blue', reply: { id: card.id, who: 'agent', text: 'Weekly board · v1', artifact: true } })
    // taken back
    log({ kind: 'user', id: 'u3', text: sent[0].replace('<reaction ', '<reaction-removed ') })
    expect(msgs().find((m) => m.id === card.id)?.reactions ?? []).toEqual([])
  })

  test('a page whose scripts break or that reaches for the network is refused, with what broke', async () => {
    src.checker = ok
    const id = (await src.cli(['artifact', 'new', 'board.html', '--title', 'Fine'], { cwd: files })).out.match(/artifact (\w+)/)![1]
    src.checker = async () => ({ errors: ['script error: x is not defined', 'blocked: https://cdn.example/x.js (artifacts load nothing: put it inline)'], warnings: [], shots: { light: '/p.png', dark: '/p-dark.png' } })
    const bad = await src.cli(['artifact', 'update', id, 'board.html'], { cwd: files })
    expect(bad.code).toBe(1)
    expect(bad.out).toContain('Not updated')
    expect(bad.out).toContain('- script error: x is not defined')
    expect(bad.out).toContain('/p.png')
    expect(src.artifacts.get(id)!.versions.length).toBe(1)
    src.checker = ok
  })

  test('its keeper: the agent that made it while its task is open, the coordinator once that task is merged', async () => {
    src.checker = ok
    const { t, place } = await workedTask('kept')
    const id = (await src.cli(['artifact', 'new', 'board.html', '--title', 'Kept'], { chat: `${t.id}/Agent`, cwd: files })).out.match(/artifact (\w+)/)![1]
    expect(src.snapshot().artifacts.find((a) => a.id === id)!.keeper).toBe(`${t.id} agent`)
    await src.cli(['merge', t.id], {})
    expect(src.snapshot().artifacts.find((a) => a.id === id)!.keeper).toBe('kept')
  })

  test("one snapshot builds the places list once, however many artifacts name their keeper by it", async () => {
    src.checker = ok
    // kept by the coordinator: each one's keeper is a place, named from the places list
    const { t } = await workedTask('many-kept')
    await src.cli(['merge', t.id], {})
    for (let i = 0; i < 5; i++) await src.cli(['artifact', 'new', 'board.html', '--title', `Kept ${i}`], { chat: `${t.id}/Agent`, cwd: files })
    // each build of the list reads every coordinator's restart hint: once per artifact was seconds on a real machine
    const side = src as unknown as { listed(): unknown }
    const build = side.listed
    let built = 0
    side.listed = function (this: unknown) {
      built++
      return build.call(this)
    }
    try {
      const keepers = src.snapshot().artifacts.filter((a) => a.title.startsWith('Kept ')).map((a) => a.keeper)
      expect(keepers).toEqual(Array(5).fill('many-kept'))
      expect(built).toBe(1)
      // outside a snapshot, a name is read directly from places without building the full places list
      expect(src.chatName(t.project)).toBe('many-kept')
      expect(built).toBe(1)
    } finally {
      side.listed = build
    }
  })

  test('render and preview are gone and say what replaced them', async () => {
    for (const c of ['render', 'preview']) {
      const r = await src.cli([c, 'board.html'], { cwd: files })
      expect(r.code).toBe(1)
      expect(r.out).toContain('shepherdr artifact new')
    }
  })
})

describe("another machine's artifacts", () => {
  test('listed, shown, pictured and acted on through the main machine, by their place', async () => {
    const got: { path: string; body?: unknown }[] = []
    const art = { id: 'farx', title: 'Far board', place: 'p:far2:proj', at: 1, v: 2, when: '1m', by: 'proj', keeper: 'proj', versions: [] }
    const far = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const u = new URL(req.url)
        got.push({ path: u.pathname + u.search, body: req.method === 'POST' ? await req.json() : undefined })
        if (u.pathname === '/api/snapshot')
          return Response.json({ name: 'S', host: 'far2', places: [{ id: 'p:far2:~', name: 'home', machine: 'far2', home: true, level: 1, status: 'idle', mode: 'manual', chat: 'p:far2:~' }], machines: [{ id: 'm:far2', machine: 'far2', name: 'far2', status: 'idle' }], tasks: [], automations: {}, artifacts: [art], asks: {}, settings: [], user: 'u' })
        if (u.pathname === '/api/artifacts/farx/raw') return Response.json({ html: `<p>far v${u.searchParams.get('v')}</p>`, data: { n: 1 } })
        if (u.pathname === '/api/artifacts/farx/thumb') return new Response('png', { headers: { 'content-type': 'image/png' } })
        if (u.pathname === '/api/action') return Response.json({ to: 'proj' })
        return new Response('no', { status: 404 })
      },
    })
    try {
      src.peers!.adopt('far2', `http://127.0.0.1:${far.port}`)
      await until(() => !!src.peers!.list().find((l) => l.rec.machine === 'far2')?.snap, 8000, 'the far peer to have a snapshot')
      expect(src.snapshot().artifacts.find((a) => a.id === 'farx')).toMatchObject({ title: 'Far board', place: 'p:far2:proj' })
      expect(await src.artifact('farx', 2)).toEqual({ html: '<p>far v2</p>', data: { n: 1 } })
      expect(await (await src.artifactThumb('farx', true))!.text()).toBe('png')
      expect(got.some((g) => g.path === '/api/artifacts/farx/thumb?dark=1')).toBe(true)
      const a = { type: 'artifact-send' as const, place: 'p:far2:proj', artifact: 'farx', v: 2, text: 'Colour: Grey' }
      expect(await src.act(a)).toEqual({ to: 'proj' })
      expect(got.find((g) => g.path === '/api/action')?.body).toEqual(a)
      // one this machine doesn't know at all is nowhere
      expect(await src.artifact('nope')).toBeUndefined()
    } finally {
      far.stop(true)
    }
  })
})

describe("a task row's menu, and pin from the command", () => {
  test('pin and unpin: coordinators only, said plainly, shown in task list', async () => {
    const { t } = await workedTask('pins')
    expect((await src.cli(['task', 'pin', t.id], { chat: `${t.id}/Agent` })).code).toBe(1)
    expect((await src.cli(['task', 'pin', t.id], {})).out).toContain(`Pinned ${t.id}`)
    expect((await src.cli(['task', 'list'], {})).out).toContain('(pinned)')
    expect(JSON.parse((await src.cli(['task', 'list', '--json'], {})).out).find((x: { id: string }) => x.id === t.id).pinned).toBeNumber()
    await src.cli(['task', 'unpin', t.id], {})
    expect((await src.cli(['task', 'unpin', t.id], {})).out).toContain(`${t.id} isn't pinned.`)
    expect(await src.act({ type: 'pin', chat: `${t.id}/Agent`, on: true })).toMatchObject({ ok: true })
    expect(t.pinned).toBeNumber()
  })

  test('Stop from the app closes its agent and puts the task in To do, its work kept: no false Needs you, and writing starts it again', async () => {
    const { t } = await workedTask('stopfromapp')
    expect(await src.act({ type: 'stop', chat: `${t.id}/Agent` })).toMatchObject({ ok: true })
    expect(t.stopped).toBe(true)
    // To do, though its chat ends on a card: the agent it would answer is closed, so it is no wait on you
    expect(src.engine.view(t)).toMatchObject({ status: 'todo', agent: { running: false } })
    expect(src.snapshot().needs.filter((n) => n.task === t.id)).toEqual([])
    expect(src.snapshot().tasks.find((x) => x.id === t.id)).toMatchObject({ status: 'todo' })
  })

  test('Mark done and Delete say what work stays unmerged, in words without paths, until forced', async () => {
    const { t } = await workedTask('rowmenu')
    expect(await src.act({ type: 'close', chat: `${t.id}/Agent` })).toEqual({ ok: false, held: [`work on ${t.branch} that main lacks`] })
    expect(await src.act({ type: 'delete', chat: `${t.id}/Agent` })).toMatchObject({ ok: false, held: [`work on ${t.branch} that main lacks`] })
    expect(src.engine.task(t.id)).toBe(t)
    expect(await src.act({ type: 'close', chat: `${t.id}/Agent`, force: true })).toMatchObject({ ok: true })
    expect(t.closed).toBeTruthy()
    // closed already: said, not swallowed
    expect(await src.act({ type: 'close', chat: `${t.id}/Agent` })).toMatchObject({ ok: false, error: expect.stringContaining('Done already (nothing to merge)') })
    expect(await src.act({ type: 'delete', chat: `${t.id}/Agent`, force: true })).toMatchObject({ ok: true })
    expect(src.engine.task(t.id)).toBeUndefined()
  })
})

describe('Autopilot from the command', () => {
  test('three settings and no limits: the heartbeat, the news that wakes it and its checklist; no budget anywhere', async () => {
    const { place } = await workedTask('piloting')
    src.places.setMode(place, 'autopilot')
    try {
      // the coordinator, on its own: Shepherdr adds what it asks; the machine's max tasks at once bounds the rest
      expect((await src.cli(['task', 'add', 'Fix the typo', '--desc', 'Fix it.'], { chat: place })).out).toContain('Added')
      expect((await src.cli(['task', 'add', 'Fix the link', '--desc', 'Fix it.'], { chat: place })).out).toContain('Added')
      // a checklist is a space's own (the home space's too), not a default Everywhere or the machine passes down
      for (const s of src.snapshot().settings.filter((x) => x.name === 'Autopilot')) expect(s.rows.map((r) => r.label)).toEqual(['Heartbeat', 'Wakes at once on', ...(s.level?.startsWith('p:') ? ['Checklist'] : [])])
      const show = (await src.cli(['show'], {})).out
      expect(show).toContain('heartbeat.when')
      expect(show).toContain('heartbeat.on')
      expect(show).toContain('time.zone')
      expect(show).not.toMatch(/tasksPerDay|wake\.|used today|budget/)
    } finally {
      src.places.setMode(place, 'regular')
    }
  })
})
