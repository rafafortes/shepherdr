// The live source's corners the other files leave: the screen's smaller actions (sections, archive, pause, keys, a
// plugin's switch, artifacts and secrets), the shepherdr command's less used subcommands, and a few of the ways it
// reads another machine. A real LiveSource with a herdr socket that isn't there; what an agent is sent, and the
// alerts, are caught where they go, and no CLI runs.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const home = tmp('cover-source')
process.env.SHEPHERDR_HOME = home
process.env.HERDR_SOCKET_PATH = join(home, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
// No CLI of this machine runs here: herdr (asked which agents it starts) and agent-browser (asked its version) are
// stand-ins that answer nothing. Bun looks a command up in the PATH this process started with unless it is given an
// environment, so each command this process starts is given this one.
const standIns = tmp('cover-source-bin')
for (const n of ['herdr', 'agent-browser']) writeFileSync(join(standIns, n), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
process.env.PATH = `${standIns}:${process.env.PATH}`
process.env.SHEPHERDR_AGENT_BROWSER = join(standIns, 'agent-browser')
{
  type Opts = { env?: Record<string, string | undefined> } | undefined
  const withEnv = (a: unknown, o?: Opts) => (Array.isArray(a) ? [a, { ...o, env: o?.env ?? process.env }] : [{ ...(a as object), env: (a as Opts)?.env ?? process.env }])
  const [spawn, spawnSync] = [Bun.spawn, Bun.spawnSync] as unknown as ((...x: unknown[]) => unknown)[]
  Bun.spawn = ((a: unknown, o?: Opts) => spawn(...withEnv(a, o))) as typeof Bun.spawn
  Bun.spawnSync = ((a: unknown, o?: Opts) => spawnSync(...withEnv(a, o))) as typeof Bun.spawnSync
}
// Before it starts: the note herdr-projects' take-over left, and a page from before artifacts, both said once at start
writeFileSync(join(home, 'took-over-herdr-projects.json'), JSON.stringify({ at: 1, backup: '/b', text: 'Shepherdr took over from herdr-projects.' }))
mkdirSync(join(home, 'pages'), { recursive: true })
writeFileSync(join(home, 'pages', 'oldpage.html'), '<h1>Old</h1>')
writeFileSync(join(home, 'pages', 'oldtask.html'), '<h1>Old task</h1>')
writeFileSync(
  join(home, 'pages.json'),
  JSON.stringify({
    oldpage: { id: 'oldpage', title: 'Old page', by: 'me', chat: 'p:here:gone', at: 1 },
    oldtask: { id: 'oldtask', title: 'Old task page', by: 'me', chat: 'NOPE-1/Agent', at: 2 },
  }),
)
// no git name anywhere and no user in config.json: the name is the login's, capitalized
const was = { git: process.env.GIT_CONFIG_GLOBAL, user: process.env.USER }
process.env.GIT_CONFIG_GLOBAL = join(home, 'no-gitconfig')
process.env.USER = 'tester'

const { LiveSource } = await import('../server/live/source.ts')
const { placeId, NAME } = await import('../server/live/places.ts')
const { readJson, writeJson } = await import('../server/store.ts')
const { herdr } = await import('../server/live/herdr.ts')

const src = new LiveSource()
/** the checker it starts with, which opens a page in agent-browser (the tests put their own in its place) */
const browserCheck = src.checker
if (was.git === undefined) delete process.env.GIT_CONFIG_GLOBAL
else process.env.GIT_CONFIG_GLOBAL = was.git
if (was.user === undefined) delete process.env.USER
else process.env.USER = was.user
afterAll(() => src.stop())

const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'

let sent: { key: string; text: string; opts?: Record<string, unknown> }[] = []
let alerts: { title: string; body: string; go?: unknown; tag?: string }[] = []
const realSend = src.agents.send
beforeEach(() => {
  sent = []
  alerts = []
  src.agents.send = (async (key: string, text: string, opts?: Record<string, unknown>) => {
    sent.push({ key, text, opts })
    return { waiting: false }
  }) as never
  src.alert = ((a: { title: string; body: string }) => alerts.push(a)) as never
})
afterAll(() => {
  src.agents.send = realSend
})

/** a space on a real repo of its own */
async function space(name: string) {
  const dir = tmp('cover-repo')
  execSync(REPO, { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, name)
  return { p, dir, place: placeId.space(p.name) }
}

let n = 0
/** a task of that space as the engine keeps one, with no agent started (none can be here) */
function task(sp: { p: { name: string }; dir: string }, extra: Record<string, unknown> = {}) {
  const id = `COV-${++n}`
  const t = { id, n, project: placeId.space(sp.p.name), base: 'main', branch: `cov-${n}`, worktree: sp.dir, title: `Task ${n}`, desc: 'Do it.', by: 'test', created: Date.now(), updated: Date.now(), told: 'work', ...extra }
  src.engine.tasks.push(t as never)
  return src.engine.task(id)!
}

const priv = src as unknown as Record<string, (...a: unknown[]) => unknown>

describe('starting up', () => {
  test("with no name in git or config.json, the human is called by the login's name", () => {
    expect(src.user).toBe('Tester')
  })
  test("herdr-projects' take-over note shows once in the home space's chat", () => {
    expect(src.chats.chat(placeId.home())?.messages.some((m) => m.text === 'Shepherdr took over from herdr-projects.')).toBe(true)
    expect(readJson<{ said?: boolean }>('took-over-herdr-projects.json', {}).said).toBe(true)
  })
  test('a page from before artifacts is an artifact now, kept in the place its chat was in', () => {
    expect(src.artifacts.get('oldpage')?.place).toBe('p:here:gone')
    // a task chat of a task no longer here: the home space keeps it
    expect(src.artifacts.get('oldtask')?.place).toBe(placeId.home())
    expect(existsSync(join(home, 'pages.json'))).toBe(false)
  })
  test('a retired coordinator is closed once herdr shows it, and looked for again a few times until then', () => {
    const closed: string[] = []
    const closePane = herdr.closePane
    herdr.closePane = (async (pane: string) => void closed.push(pane)) as never
    const timers = (src as unknown as { timers: unknown[] }).timers
    const n = timers.length
    src.agents.live.set('Retired', { pane_id: 'nope:1' } as never)
    try {
      priv.retire(['Retired', 'Never'], 1)
      // the one herdr doesn't show yet is looked for again; with no tries left, never
      expect(timers.length).toBe(n + 1)
      priv.retire(['Never'], 0)
      expect(timers.length).toBe(n + 1)
    } finally {
      herdr.closePane = closePane
      src.agents.live.delete('Retired')
    }
    expect(closed).toEqual(['nope:1'])
  })
  test('before it stops, the merges on their way finish: none are on their way here', async () => {
    try {
      expect(await src.drain()).toBe(false)
    } finally {
      // it would refuse every merge after it, as a server about to stop does
      ;(src.engine as unknown as { closing: boolean }).closing = false
    }
  })
  test('the Everywhere defaults are what Settings keep for every machine', () => {
    expect(src.everywhere()).toEqual(src.settings.everywhere())
  })
})

describe("a chat's events", () => {
  test('a chat read anew shows, and a terminal on screen follows its output', async () => {
    const shown: string[] = []
    const off = src.on('chat', (k) => shown.push(k))
    src.chats.onRead!('p:here:read')
    expect(shown).toContain('p:here:read')
    const screens: string[] = []
    const screen = src.agents.screen
    src.agents.screen = (async () => ({ rows: [] })) as never
    const offTerm = src.on('terminal', (k) => screens.push(k))
    try {
      src.watch(['p:here:read'], ['p:here:term'])
      // once for the watch itself, once for what it printed
      src.agents.emit('output', 'p:here:term')
      src.agents.emit('output', 'p:here:other')
      await Bun.sleep(10)
    } finally {
      src.watch([], [])
      src.agents.screen = screen
      off()
      offTerm()
    }
    expect(screens).toEqual(['p:here:term', 'p:here:term'])
  })
  test('a voice call hears the newest reply, once it changes', async () => {
    const heard: string[] = []
    const fns = (src as unknown as { replyFns: Map<string, Set<(t: string) => void>> }).replyFns
    const last = src.chats.lastReply
    let reply = 'first'
    src.chats.lastReply = (() => reply) as never
    fns.set('p:here:voice', new Set([(t) => heard.push(t)]))
    fns.set('p:here:none', new Set())
    try {
      await priv.pollChats()
      reply = 'second'
      await priv.pollChats()
    } finally {
      fns.delete('p:here:voice')
      fns.delete('p:here:none')
      src.chats.lastReply = last
    }
    expect(heard).toEqual(['second'])
  })
})

describe('the screen acts', () => {
  test('a section is made, renamed, moved into and deleted; Pinned stays', async () => {
    const made = (await src.act({ type: 'section', op: 'new', name: '  Work   stuff ', emoji: '🛠️' } as never)) as { ok: boolean; id: string }
    expect(made.ok).toBe(true)
    expect(await src.act({ type: 'section', op: 'new', name: 'Bad', emoji: 'ab' } as never)).toEqual({ ok: false, error: 'One emoji at a time.' })
    expect(await src.act({ type: 'section', op: 'new', name: 'Far', machine: 'nowhere' } as never)).toEqual({ ok: false, error: 'No such machine.' })
    expect(((await src.act({ type: 'section', op: 'new', name: '' } as never)) as { ok: boolean }).ok).toBe(false)
    expect(await src.act({ type: 'rename', id: made.id, name: 'Work', emoji: '🔧' } as never)).toEqual({ ok: true })
    expect(await src.act({ type: 'rename', id: made.id, name: 'Work', emoji: 'xy' } as never)).toEqual({ ok: false, error: 'One emoji at a time.' })
    expect(((await src.act({ type: 'rename', id: made.id, name: '' } as never)) as { ok: boolean }).ok).toBe(false)
    expect(await src.act({ type: 'move', id: 5, to: made.id } as never)).toEqual({ ok: false, error: 'Nothing to move.' })
    expect(((await src.act({ type: 'move', id: 'p:here:nothing', to: made.id } as never)) as { ok: boolean }).ok).toBe(false)
    expect(await src.act({ type: 'move', id: placeId.home(), to: made.id } as never)).toEqual({ ok: true })
    expect(await src.act({ type: 'section', op: 'delete', id: 'pinned' } as never)).toEqual({ ok: false, error: 'Pinned stays.' })
    expect(await src.act({ type: 'section', op: 'delete', id: 'nope' } as never)).toEqual({ ok: false, error: 'No such section.' })
    expect(await src.act({ type: 'section', op: 'delete', id: made.id } as never)).toEqual({ ok: true })
    expect(src.places.sections[made.id]).toBeUndefined()
  })

  test('keys and text go into the terminal; a call is nothing to do here', async () => {
    const typed: unknown[] = []
    const keys = src.agents.keys
    const text = src.agents.text
    src.agents.keys = (async (k: string, ks: string[]) => void typed.push([k, ks])) as never
    src.agents.text = (async (k: string, t: string) => void typed.push([k, t])) as never
    try {
      expect(await src.act({ type: 'keys', chat: 'p:here:k', keys: ['enter'] } as never)).toEqual({})
      expect(await src.act({ type: 'text', chat: 'p:here:k', text: 'hi' } as never)).toEqual({})
      expect(await src.act({ type: 'call', chat: 'p:here:k' } as never)).toEqual({})
    } finally {
      src.agents.keys = keys
      src.agents.text = text
    }
    expect(typed).toEqual([
      ['p:here:k', ['enter']],
      ['p:here:k', 'hi'],
    ])
  })

  test("a plugin's switch is the human's own list; a setting goes to its level", async () => {
    expect(await src.act({ type: 'setting', key: 'plugin.nosuch', value: 'off' } as never)).toEqual({ ok: false, error: 'No plugin nosuch.' })
    expect(await src.act({ type: 'setting', key: 'plugin.voice', value: 'off' } as never)).toEqual({ ok: true })
    expect(readJson<{ off: string[] }>('plugins.json', { off: [] }).off).toContain('voice')
    expect(await src.act({ type: 'setting', key: 'plugin.voice', value: 'on' } as never)).toEqual({ ok: true })
    const sp = await space('levels')
    expect(await src.act({ type: 'setting', key: 'task.model', value: 'x', place: 'p:here:none' } as never)).toEqual({ ok: false, error: 'No such space.' })
    expect(await src.act({ type: 'setting', key: 'review.rounds', value: '3', place: sp.place } as never)).toEqual({ ok: true })
    expect(src.settings.pick('review.rounds', { space: sp.p.name }).from).toBe('space')
    expect(await src.act({ type: 'setting', key: 'review.rounds', value: null, place: sp.place } as never)).toEqual({ ok: true })
    expect(await src.act({ type: 'setting', key: 'machine.maxTasks', value: '3', place: placeId.machine() } as never)).toEqual({ ok: true })
    expect(src.settings.pick('machine.maxTasks', 'machine').from).toBe('machine')
    expect(await src.act({ type: 'setting', key: 'machine.maxTasks', value: null, place: placeId.machine() } as never)).toEqual({ ok: true })
    expect(((await src.act({ type: 'setting', key: 'no.such.key', value: '1' } as never)) as { ok: boolean }).ok).toBe(false)
  })

  test('a task is archived and brought back, paused, and a stop that fails says why', async () => {
    const sp = await space('acts')
    const t = task(sp)
    const chat = `${t.id}/Agent`
    expect(await src.act({ type: 'archive', chat: 'NOPE-9/Agent', on: true } as never)).toEqual({ ok: false, error: 'No such task.' })
    expect(await src.act({ type: 'archive', chat, on: true } as never)).toEqual({ ok: true })
    expect(src.engine.task(t.id)?.archived).toBeTruthy()
    expect(await src.act({ type: 'archive', chat, on: false } as never)).toEqual({ ok: true })
    expect(src.engine.task(t.id)?.archived).toBeFalsy()
    expect(await src.act({ type: 'pause', chat: 'NOPE-9/Agent' } as never)).toEqual({ ok: false, error: 'No such task.' })
    const pause = src.engine.pause
    const stop = src.engine.stopTask
    src.engine.pause = (async () => {
      throw new Error('it would not pause')
    }) as never
    src.engine.stopTask = (async () => {
      throw new Error('it would not stop')
    }) as never
    try {
      expect(await src.act({ type: 'pause', chat } as never)).toEqual({ ok: false, error: 'it would not pause' })
      expect(await src.act({ type: 'stop', chat } as never)).toEqual({ ok: false, error: 'it would not stop' })
    } finally {
      src.engine.pause = pause
      src.engine.stopTask = stop
    }
    src.engine.pause = (async () => undefined) as never
    try {
      expect(await src.act({ type: 'pause', chat } as never)).toEqual({ ok: true })
    } finally {
      src.engine.pause = pause
    }
  })

  test('restart questions, a restart of them all and a close that fail say why', async () => {
    expect(((await src.act({ type: 'restart-info', chat: 'NOPE-9/Agent' } as never)) as { ok: boolean }).ok).toBe(false)
    const all = priv.restartAllCoordinators
    priv.restartAllCoordinators = async () => {
      throw new Error('no coordinators')
    }
    try {
      expect(await src.act({ type: 'restart-all' } as never)).toEqual({ ok: false, error: 'no coordinators' })
    } finally {
      priv.restartAllCoordinators = all
    }
    const sp = await space('closes')
    const t = task(sp)
    const close = src.engine.close
    src.engine.close = (async () => {
      throw new Error('it would not close')
    }) as never
    try {
      expect(await src.act({ type: 'close', chat: `${t.id}/Agent`, force: true } as never)).toEqual({ ok: false, error: 'it would not close' })
    } finally {
      src.engine.close = close
    }
  })

  test("a secret an agent asked for is kept: its card says where, and its agent is told by name", async () => {
    const chat = placeId.home()
    const asked = await src.cli(['secret', 'ask', 'COVER_TOKEN', '--why', 'for the test'], { chat })
    expect(asked.code).toBe(0)
    const card = src.chats.log(chat).posted.find((x) => x.secret?.name === 'COVER_TOKEN')!
    expect(await src.act({ type: 'secret-saved', chat, card: card.id, name: 'COVER_TOKEN', level: 'all' } as never)).toEqual({ ok: false, error: 'That secret is not kept there.' })
    expect(await src.act({ type: 'secret', level: 'all', name: 'COVER_TOKEN', value: 'v1\n', card: { chat, id: card.id } } as never)).toEqual({ ok: true })
    expect(src.chats.log(chat).posted.find((x) => x.id === card.id)?.secret?.saved).toBe('Everywhere')
    expect(sent.at(-1)?.text).toContain('COVER_TOKEN')
    expect(sent.at(-1)?.text).not.toContain('v1')
    // a level its card did not offer is named all the same
    src.vault.set(placeId.machine(), 'COVER_TOKEN', 'v2')
    expect(await src.act({ type: 'secret-saved', chat, card: card.id, name: 'COVER_TOKEN', level: placeId.machine() } as never)).toEqual({ ok: true })
    src.vault.set('all', 'COVER_TOKEN', null)
    src.vault.set(placeId.machine(), 'COVER_TOKEN', null)
  })

  test("an artifact's words go to its keeper: sent, noted on, said about; deleted, it is gone", async () => {
    const sp = await space('arts')
    src.checker = async () => ({ errors: [], warnings: [], skipped: 'no browser in the test' })
    const files = tmp('cover-art')
    writeFileSync(join(files, 'board.html'), '<h1>Board</h1>')
    const made = await src.cli(['artifact', 'new', 'board.html', '--title', 'Board'], { chat: sp.place, cwd: files })
    const id = made.out.match(/artifact (\w+)/)![1]
    expect(await src.act({ type: 'artifact-send', place: sp.place, artifact: 'gone', v: 1, text: 'x' } as never)).toEqual({ ok: false, error: 'That artifact is gone.' })
    expect(await src.act({ type: 'artifact-send', place: sp.place, artifact: id, v: 1, text: 'Ship it' } as never)).toEqual({ to: 'arts' })
    expect(await src.act({ type: 'artifact-say', place: sp.place, artifact: id, v: 1, text: 'Nice' } as never)).toEqual({ to: 'arts' })
    expect(await src.act({ type: 'artifact-note', place: sp.place, artifact: id, v: 1, note: 'Bigger', target: 'h1' } as never)).toEqual({ to: 'arts' })
    expect(sent.map((s) => s.key)).toEqual([sp.place, sp.place, sp.place])
    expect(sent[0].text).toContain('Ship it')
    expect(await src.artifactThumb(id, false)).toBeNull()
    expect(await src.artifactThumb('gone', true)).toBeNull()
    // the CLI's check only looks, and its rm deletes
    expect((await src.cli(['artifact', 'check'], { cwd: files })).out).toContain('shepherdr artifact check <file.html>')
    expect((await src.cli(['artifact', 'check', 'board.html'], { cwd: files })).out).toContain('No errors.')
    expect((await src.cli(['artifact', 'frobnicate'], { cwd: files })).out).toContain('shepherdr artifact new|update|check|list|show|rm')
    const again = (await src.cli(['artifact', 'new', 'board.html', '--title', 'Board 2'], { chat: sp.place, cwd: files })).out.match(/artifact (\w+)/)![1]
    expect((await src.cli(['artifact', 'rm', again], {})).out).toContain(`Deleted ${again} “Board 2”`)
    expect(await src.act({ type: 'artifact-delete', artifact: id } as never)).toEqual({})
    expect(await src.act({ type: 'artifact-delete', artifact: id } as never)).toEqual({ ok: false, error: 'That artifact is gone.' })
  })

  test("a page's notes from its shared browser go to the task, with only shots from that chat's inbox", async () => {
    const chat = 'COVB-1/Agent'
    expect(await src.act({ type: 'browser-notes', chat, url: 'http://x', notes: [] } as never)).toEqual({ ok: false })
    const inbox = join(home, 'inbox', 'COVB-1_Agent')
    const shot = join(inbox, 'abc-note-1.png')
    const r = await src.act({
      type: 'browser-notes',
      chat,
      url: 'http://localhost:3000/',
      title: 'Home',
      viewport: { w: 390, h: 800 },
      notes: [
        { comment: 'Too big', pick: { element: 'h1', selector: 'h1', box: { x: 0, y: 0, w: 10, h: 10 }, shot } },
        { comment: undefined, pick: { element: 'p', selector: 'p', box: { x: 0, y: 20, w: 10, h: 10 }, shot: '/etc/passwd' } },
      ],
    } as never)
    expect(r).toEqual({})
    expect(sent.at(-1)?.key).toBe(chat)
    expect(sent.at(-1)?.text).toContain('Too big')
    expect(sent.at(-1)?.text).not.toContain('/etc/passwd')
  })
})

describe('the shepherdr command', () => {
  const cli = async (args: string[], ctx: Record<string, unknown> = {}) => src.cli(args, ctx)

  test('a word it does not know says so, and each group names its own subcommands', async () => {
    expect((await cli(['frobnicate'])).out).toBe('No command frobnicate; shepherdr help lists them\n')
    expect((await cli(['space', 'frob'])).out).toBe('shepherdr space add|list|rename|remove\n')
    expect((await cli(['secret', 'frob'])).out).toContain('shepherdr secret list | ask NAME')
  })

  test('the ElevenLabs key comes on stdin and is kept for voice calls', async () => {
    expect((await cli(['secret', 'elevenlabs'])).code).toBe(1)
    expect((await cli(['secret', 'elevenlabs'], { stdin: ' key-1 \n' })).out).toBe('Saved. Voice calls use it from now on.\n')
    expect(readJson<Record<string, string>>('secrets.json', {}).elevenlabs).toBe('key-1')
  })

  test("doctor names this machine's herdr and shared browser, the alerts' warnings and each space", async () => {
    src.pushWarnings = () => ['no device yet']
    const sp = await space('doc')
    const r = await cli(['doctor'])
    src.pushWarnings = () => []
    expect(r.code).toBe(0)
    expect(r.out).toContain(`${NAME} (this machine, the main one): herdr does not answer`)
    expect(r.out).toContain('shared browser')
    expect(r.out).toContain('Alerts: no device yet')
    expect(r.out).toContain(`doc: ${sp.dir}`)
  })

  test('a plan needs its steps, and is posted on its task', async () => {
    const sp = await space('plans')
    const t = task(sp)
    expect((await cli(['plan', t.id])).out).toContain('shepherdr plan <id> --step')
    const plan = src.engine.plan
    const got: unknown[] = []
    src.engine.plan = (async (id: string, steps: string[]) => void got.push([id, steps])) as never
    try {
      expect((await cli(['plan', t.id, '--step', 'one', '--step', 'two'], { chat: `${t.id}/Agent` })).out).toContain('Plan posted.')
    } finally {
      src.engine.plan = plan
    }
    expect(got).toEqual([[t.id, ['one', 'two']]])
  })

  test("an alert about nothing in particular opens the chat it came from, or the home space", async () => {
    expect((await cli(['alert', 'Heads up', '--body', 'the build is slow'])).out).toBe('Alert sent.\n')
    expect(alerts.at(-1)).toMatchObject({ title: 'Heads up', body: 'the build is slow', go: { place: placeId.home() } })
    await cli(['alert', 'From a task'], { chat: 'COVX-1/Agent' })
    expect(alerts.at(-1)).toMatchObject({ title: 'From a task', go: { place: placeId.home() }, task: true })
    const sp = await space('alerts')
    await cli(['alert', 'From a space'], { chat: sp.place })
    expect(alerts.at(-1)).toMatchObject({ go: { place: sp.place } })
  })

  test('an automation is paused, resumed, run and removed by name; one that cannot add its task says why', async () => {
    const sp = await space('autos')
    expect((await cli(['automation', 'add', 'Nightly', '--task', 'Check deps', '--when', 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0', '--space', 'autos'])).code).toBe(0)
    expect((await cli(['automation', 'pause', '--space', 'autos'])).out).toBe('shepherdr automation pause "<name>"\n')
    expect((await cli(['automation', 'pause', 'Nightly', '--space', 'autos'])).out).toBe('Paused “Nightly”.\n')
    expect((await cli(['automation', 'resume', 'Nightly', '--space', 'autos'])).out).toBe('“Nightly” is on again.\n')
    const add = src.engine.add
    src.engine.add = (() => ({ id: 'AUTO-1' })) as never
    try {
      expect((await cli(['automation', 'run', 'Nightly', '--space', 'autos'])).out).toBe('Ran “Nightly”: added AUTO-1.\n')
      src.engine.add = (() => {
        throw new Error('no room for it')
      }) as never
      expect((await cli(['automation', 'run', 'Nightly', '--space', 'autos'])).out).toBe('no room for it\n')
    } finally {
      src.engine.add = add
    }
    expect((await cli(['automation', 'remove', 'Nightly', '--space', 'autos'])).out).toBe('Removed.\n')
    expect(src.automations.find(sp.place, 'Nightly')).toBeUndefined()
  })

  test('task stop, pause, archive and unarchive say what became of the task', async () => {
    const sp = await space('tasks')
    const t = task(sp)
    const e = src.engine
    const was = { stopTask: e.stopTask, pause: e.pause, archive: e.archive }
    e.stopTask = (async () => ['its branch cov-x']) as never
    e.pause = (async () => undefined) as never
    try {
      expect((await cli(['task', 'stop', t.id])).out).toContain(`Stopped ${t.id}: its agent is closed; kept its branch cov-x.`)
      e.stopTask = (async () => []) as never
      expect((await cli(['task', 'stop', t.id])).out).toBe(`Stopped ${t.id}: its agent is closed. Writing to it starts it again.\n`)
      expect((await cli(['task', 'pause', t.id], { chat: `${t.id}/Agent` })).out).toContain(`To wait yourself: shepherdr todo ${t.id}`)
      expect((await cli(['task', 'pause', t.id])).out).toContain(`Paused ${t.id}`)
      expect((await cli(['task', 'archive', t.id], { chat: `${t.id}/Agent` })).out).toContain('Only a coordinator archives tasks')
      expect((await cli(['task', 'unarchive', t.id])).out).toBe(`${t.id} isn't archived.\n`)
      e.archive = (async (id: string) => {
        e.task(id)!.archived = Date.now() as never
        return { stopped: true, kept: ['its worktree'] }
      }) as never
      expect((await cli(['task', 'archive', t.id])).out).toContain(`Archived ${t.id}: its agent was stopped first; kept its worktree.`)
      expect((await cli(['task', 'archive', t.id])).out).toBe(`${t.id} is archived already.\n`)
      expect((await cli(['task', 'unarchive', t.id])).out).toContain(`Brought ${t.id} back`)
      e.archive = (async (id: string) => {
        e.task(id)!.archived = Date.now() as never
        return { stopped: false, kept: [] }
      }) as never
      expect((await cli(['task', 'archive', t.id])).out).toContain(`Archived ${t.id}. It is out of every list`)
      e.unarchive(t.id)
    } finally {
      Object.assign(e, was)
    }
  })

  test('task queue --at and --in set when it starts; --at none starts it now, or says what it still waits for', async () => {
    const sp = await space('queues')
    const t = task(sp)
    const e = src.engine
    const was = { schedule: e.schedule, queue: e.queue }
    const asked: unknown[] = []
    try {
      expect((await cli(['task', 'queue', t.id, '--at', 'none', '--after', 'X-1'])).out).toContain('One at a time')
      e.schedule = ((id: string, at: number | null) => (asked.push(at), { queued: ['COV-A'] })) as never
      expect((await cli(['task', 'queue', t.id, '--at', 'none'])).out).toBe(`${t.id} no longer waits for a time: it starts once COV-A is done.\n`)
      e.schedule = (() => ({ held: { why: 'slots' } })) as never
      expect((await cli(['task', 'queue', t.id, '--at', 'off'])).out).toContain(`${t.id} no longer waits for a time, but is held`)
      e.schedule = (() => ({})) as never
      expect((await cli(['task', 'queue', t.id, '--at', ''])).out).toBe(`${t.id} no longer waits for a time: it starts now.\n`)
      e.schedule = ((id: string, at: number | null) => (asked.push(at), {})) as never
      expect((await cli(['task', 'queue', t.id, '--in', '2h'])).out).toContain(`${t.id} starts `)
      expect(asked[0]).toBe(null)
      expect(asked.at(-1)).toBeGreaterThan(Date.now())
      // one that waits for a time keeps it, whatever it waits for
      t.scheduled = { at: Date.now() + 3_600_000 } as never
      e.queue = (() => ({ queued: [] })) as never
      expect((await cli(['task', 'queue', t.id, '--after', 'none'])).out).toContain(`${t.id} waits for no task now; it keeps its time`)
      e.queue = (() => ({ queued: ['COV-B'] })) as never
      expect((await cli(['task', 'queue', t.id, '--after', 'COV-B'])).out).toContain(`${t.id} waits for COV-B once its time comes`)
      delete (t as { scheduled?: unknown }).scheduled
      e.queue = (() => ({ queued: [] })) as never
      expect((await cli(['task', 'queue', t.id, '--after', 'none'])).out).toBe(`${t.id} was not queued.\n`)
      expect((await cli(['task', 'queue', t.id, '--after', 'COV-C'])).out).toBe(`${t.id} isn't queued: what it would wait for is done already.\n`)
    } finally {
      Object.assign(e, was)
    }
  })

  test('a task added for a time has no agent yet: it says when it starts, and what else it waits for', async () => {
    await space('timed')
    const r = await cli(['task', 'add', 'Later on', '--desc', 'brief', '--space', 'timed', '--in', '3h', '--later'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('It has no agent yet: it starts by itself then, once the machine has room')
    expect(r.out).toContain('reads the brief and waits for a go')
    const id = r.out.match(/Added (\S+):/)![1]
    const r2 = await cli(['task', 'add', 'After that', '--desc', 'brief', '--space', 'timed', '--in', '4h', '--after', id])
    expect(r2.out).toContain(`once ${id} is done and the machine has room`)
  })

  test('park lists what it would park, and what it keeps, before --yes', async () => {
    const sp = await space('parks')
    const a = task(sp)
    const b = task(sp)
    const c = task(sp)
    const parkable = src.engine.parkable
    src.engine.parkable = (async () => [
      { t: a, notes: [] },
      { t: b, notes: ['n1', 'n2'] },
      { t: c, keep: 'its agent is at work', notes: [] },
    ]) as never
    try {
      const all = (await cli(['task', 'park'])).out
      expect(all).toContain('2 waiting tasks would be parked')
      expect(all).toContain('2 notes from another agent go into its brief')
      expect(all).toContain('1 kept as it is:')
      expect(all).toContain(`${c.id}`)
      expect(all).toContain('Park them: shepherdr task park --yes')
      const one = (await cli(['task', 'park', a.id.toLowerCase()])).out
      expect(one).toContain('1 waiting task would be parked')
      expect(one).toContain(`Park it: shepherdr task park ${a.id.toLowerCase()} --yes`)
      const kept = (await cli(['task', 'park', c.id])).out
      expect(kept).toContain('None can be parked.')
      expect(kept).toContain('1 kept as it is:')
      src.engine.parkable = (async () => [{ t: b, notes: ['only'] }]) as never
      expect((await cli(['task', 'park'])).out).toContain('a note from another agent goes into its brief')
    } finally {
      src.engine.parkable = parkable
    }
  })

  test('restart names what it restarts on: what Settings say, or the CLI, model and effort it is given', async () => {
    const sp = await space('restarts')
    const t = task(sp)
    const act = src.act.bind(src)
    const restarts: unknown[] = []
    let info: unknown = { ok: true, info: { want: { kind: 'claude', model: 'sonnet', effort: 'high' } } }
    let done: unknown = { ok: true, on: 'Claude Code, sonnet' }
    src.act = (async (a: { type: string }) => (a.type === 'restart-info' ? info : a.type === 'restart' ? (restarts.push(a), done) : act(a as never))) as never
    try {
      expect((await cli(['restart'])).out).toContain('shepherdr restart <space|task id>')
      expect((await cli(['restart', t.id, '--odd', 'x'])).out).toContain('Restart takes no --odd')
      expect((await cli(['restart', 'nothing-here'])).out).toContain('No space or task nothing-here')
      expect((await cli(['restart', sp.p.name], { chat: `${t.id}/Agent` })).out).toContain("A task's agent restarts only its own agent")
      expect((await cli(['restart', t.id, '--agent', 'notacli'])).out).toContain('No CLI called notacli')
      expect((await cli(['restart', t.id])).out).toBe(`Restarted ${t.id} on Claude Code, sonnet. A card in its chat says so.\n`)
      expect(restarts.at(-1)).toMatchObject({ chat: `${t.id}/Agent`, kind: 'claude', model: 'sonnet', effort: 'high', save: false })
      expect((await cli(['restart', sp.p.name, '--agent', 'pi', '--save'])).out).toContain(`Restarted ${sp.p.name} on Claude Code, sonnet, now its space's Settings too.`)
      expect(restarts.at(-1)).toMatchObject({ chat: sp.place, kind: 'pi', model: undefined, effort: undefined, save: true })
      done = { ok: false, waiting: true }
      expect((await cli(['restart', t.id])).out).toContain("machine is out of reach: it restarts once it is back")
      done = { ok: false }
      expect((await cli(['restart', t.id])).out).toBe('It could not be restarted.\n')
      done = { ok: false, error: 'it broke' }
      expect((await cli(['restart', t.id])).out).toBe('it broke\n')
      info = { ok: false, waiting: true }
      expect((await cli(['restart', t.id])).out).toContain('machine is out of reach: restart it once it is back')
      info = { ok: false }
      expect((await cli(['restart', t.id])).out).toBe('It could not be restarted.\n')
      // a task another machine runs is restarted there, by its id
      const peers = src.peers!
      const list = peers.list
      peers.list = (() => [{ rec: { machine: 'far' }, snap: { tasks: [{ id: 'FAR-1' }] } }]) as never
      info = { ok: true, info: { want: { kind: 'claude' } } }
      done = { ok: true, on: 'Claude Code' }
      try {
        expect((await cli(['restart', 'far-1'])).out).toBe('Restarted FAR-1 on Claude Code. A card in its chat says so.\n')
      } finally {
        peers.list = list
      }
    } finally {
      src.act = act as never
    }
  })
})

/** a link to another machine, as test/source.test.ts stands one in: owner() names it, fetch() answers for it */
function peerLink(reply: (path: string, init?: RequestInit) => Response | Promise<Response>, o: { reachable?: boolean; url?: string } = {}) {
  const peers = src.peers as unknown as { owner: (k: string) => unknown; fetch: (l: unknown, p: string, init?: RequestInit) => Promise<Response> }
  const was = { owner: peers.owner, fetch: peers.fetch }
  const asked: string[] = []
  peers.owner = () => ({ rec: { machine: 'laptop', url: o.url ?? 'http://127.0.0.1:9' }, reachable: o.reachable ?? true })
  peers.fetch = async (_l, p, init) => (asked.push(p), reply(p, init))
  return { asked, done: () => Object.assign(peers, was) }
}

describe('another machine', () => {
  test('a file uploaded for a chat there goes to that machine, which says where it put it', async () => {
    const l = peerLink(async (p, init) => {
      expect(p).toBe('/api/upload')
      const body = init!.body as FormData
      expect(body.get('chat')).toBe('p:laptop:x')
      return Response.json({ path: '/far/inbox/a.png' })
    })
    try {
      expect(await src.upload('p:laptop:x', 'a.png', new Uint8Array([1, 2]))).toBe('/far/inbox/a.png')
    } finally {
      l.done()
    }
  })

  test("a chat's file there is fetched from it, and one it doesn't have is nothing", async () => {
    const chat = src.chat
    src.chat = (() => ({ key: 'p:laptop:x', messages: [] })) as never
    const l = peerLink((p) => (p.includes('a.png') ? new Response(new Uint8Array([7])) : new Response('no', { status: 404 })))
    try {
      expect(await (await src.attachment('p:laptop:x', '/far/a.png'))!.arrayBuffer()).toEqual(new Uint8Array([7]).buffer)
      expect(await src.attachment('p:laptop:x', '/far/b.png')).toBeNull()
    } finally {
      l.done()
      src.chat = chat
    }
  })

  test("a chat's activity there is asked of it, unless it is out of reach", async () => {
    let l = peerLink((p) => Response.json({ turn: { id: 't1', p } }))
    try {
      expect(await src.activity({ chat: 'p:laptop:x', what: 'turn', id: 't1' } as never)).toMatchObject({ turn: { id: 't1' } })
      expect(l.asked[0]).toStartWith('/api/activity?')
    } finally {
      l.done()
    }
    l = peerLink(() => Response.json({}), { reachable: false })
    try {
      expect(await src.activity({ chat: 'p:laptop:x', what: 'turn', id: 't1' } as never)).toEqual({ error: "Can't reach laptop right now." })
      await expect(src.worktree({ task: 'FAR-1', what: 'files' } as never)).rejects.toThrow("Can't reach laptop right now.")
    } finally {
      l.done()
    }
    l = peerLink((p) => Response.json({ files: [], p }))
    try {
      expect(await src.worktree({ task: 'FAR-1', what: 'file', path: 'a.ts' } as never)).toMatchObject({ files: [] })
      expect(l.asked[0]).toBe('/api/worktree?task=FAR-1&what=file&path=a.ts')
      await src.worktree({ task: 'FAR-1', what: 'diff' } as never)
      expect(l.asked[1]).toBe('/api/worktree?task=FAR-1&what=diff')
    } finally {
      l.done()
    }
  })

  test("another machine's alert about its coordinator says the name the human gave the place here", () => {
    const peers = src.peers as unknown as { owner: (k: string) => unknown }
    const owner = peers.owner
    peers.owner = () => ({ snap: { places: [{ id: 'p:laptop:web', name: 'web' }] } })
    src.places.names['p:laptop:web'] = 'Website'
    const renamed = (a: unknown) => (priv.renamed as (a: unknown) => { title: string })(a)
    try {
      expect(renamed({ title: 'web stopped', go: { place: 'p:laptop:web' } }).title).toBe('Website stopped')
      // a task's alert, or a title that doesn't start with the old name, stays as it came
      expect(renamed({ title: 'web stopped', go: { place: 'p:laptop:web', task: 'W-1' } }).title).toBe('web stopped')
      expect(renamed({ title: 'Something else', go: { place: 'p:laptop:web' } }).title).toBe('Something else')
    } finally {
      peers.owner = owner
      delete src.places.names['p:laptop:web']
    }
  })

  test("a task's shared browser there is reached through that machine's own socket", async () => {
    const got: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response('no', { status: 400 })),
      websocket: {
        open: (ws) => void ws.send('hello'),
        message: (ws, m) => {
          got.push(String(m))
          ws.send('x'.repeat(30_000))
          ws.close()
        },
      },
    })
    const l = peerLink(() => Response.json({}), { url: `http://127.0.0.1:${server.port}` })
    const out: string[] = []
    let closed = false
    try {
      const bridge = src.browser('FAR-1', { send: (d: string) => out.push(d), close: () => (closed = true), buffered: () => 0 } as never)
      // what is said before the socket opens waits for it
      bridge.message('early')
      const t0 = Date.now()
      while (!closed && Date.now() - t0 < 5000) await Bun.sleep(10)
      bridge.message('late')
      bridge.end()
    } finally {
      l.done()
      server.stop(true)
    }
    expect(got).toEqual(['early'])
    expect(out[0]).toBe('hello')
    expect(out[1]).toHaveLength(30_000)
    expect(closed).toBe(true)
  })
})

describe("a task's worktree", () => {
  test('its files, a file, its diff and a patch, and its pull request, asked once in a while', async () => {
    const sp = await space('trees')
    const t = task(sp, { branch: 'main' })
    await expect(src.worktree({ task: 'NOPE-9', what: 'files' } as never)).rejects.toThrow('No task NOPE-9.')
    expect(((await src.worktree({ task: t.id, what: 'files' } as never)) as { files: unknown[] }).files.length).toBeGreaterThan(0)
    expect(await src.worktree({ task: t.id, what: 'file', path: 'README.md' } as never)).toMatchObject({ text: 'hi\n' })
    expect(await src.worktree({ task: t.id, what: 'diff' } as never)).toBeDefined()
    // a file changed in it has a patch; one that isn't, says so
    writeFileSync(join(sp.dir, 'README.md'), 'changed\n')
    expect(await src.worktree({ task: t.id, what: 'patch', path: 'README.md' } as never)).toBeDefined()
    const pr = await src.worktree({ task: t.id, what: 'pr' } as never)
    expect(pr).toEqual({ pr: null, why: 'This space has no GitHub remote.' })
    // asked again within half a minute: the same answer, not asked of GitHub again
    expect(await src.worktree({ task: t.id, what: 'pr' } as never)).toBe(pr)
    const prs = (src as unknown as { prs: Map<string, { at: number; v: Promise<unknown> }> }).prs
    prs.set('OLD-1', { at: Date.now() - 400_000, v: Promise.resolve(null) })
    prs.get(t.id)!.at = Date.now() - 60_000
    await src.worktree({ task: t.id, what: 'pr' } as never)
    expect(prs.has('OLD-1')).toBe(false)
  })

  test('one with no worktree yet, or Done and put away, says so', async () => {
    const sp = await space('notrees')
    const fresh = task(sp, { worktree: undefined })
    await expect(src.worktree({ task: fresh.id, what: 'files' } as never)).rejects.toThrow(`${fresh.id} has no worktree yet.`)
    const merged = task(sp, { worktree: join(sp.dir, 'gone'), merged: Date.now() })
    await expect(src.worktree({ task: merged.id, what: 'files' } as never)).rejects.toThrow(`${merged.id} is Done (merged): its worktree was put away.`)
    const closed = task(sp, { worktree: undefined, closed: Date.now() })
    await expect(src.worktree({ task: closed.id, what: 'files' } as never)).rejects.toThrow('nothing to merge')
  })

  test("a chat's activity here is its own chat's, and a chat that isn't here is none", async () => {
    expect(await src.activity({ chat: 'p:here:none', what: 'turn', id: 'x' } as never)).toEqual({ error: 'No such chat.' })
    const key = 'COVACT-1/Agent'
    src.agents.records[key] = { key, name: 'COVACT-1', kind: 'claude', cwd: home, logs: [], started: Date.now() } as never
    try {
      expect(await src.activity({ chat: key, what: 'turn', id: 'x' } as never)).toEqual({ error: 'That turn is no longer in its log.' })
    } finally {
      delete src.agents.records[key]
    }
  })
})

/** the chat events a CLI's log gives, standing in for what its reader found */
const events = () => (src.chats as unknown as { events: Map<string, unknown[]> }).events
const logged = (key: string, e: object) => events().set(key, [...(events().get(key) ?? []), { at: Date.now(), ...e }])

describe("the CLI's own question tool", () => {
  const items = [
    { question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false },
    { question: 'Which sizes?', options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }], multiSelect: true },
  ]
  /** what went into its terminal, in order */
  let typed: unknown[] = []
  const was = { keys: src.agents.keys, text: src.agents.text }
  beforeEach(() => {
    typed = []
    src.agents.keys = (async (_k: string, ks: string[]) => void typed.push(ks)) as never
    src.agents.text = (async (_k: string, t: string) => void typed.push(t)) as never
  })
  afterAll(() => Object.assign(src.agents, was))

  test('a choice is its number key, several are theirs and enter, its own words the slot after the options', async () => {
    const key = 'COVQ-1/Agent'
    logged(key, { kind: 'question', id: 'q1', tool: 'AskUserQuestion', items })
    expect(await src.act({ type: 'answer', chat: key, question: 'q1:0', choice: 1 } as never)).toEqual({ ok: true })
    expect(await src.act({ type: 'answer', chat: key, question: 'q1:1', choice: 0, choices: [0, 2] } as never)).toEqual({ ok: true })
    expect(typed).toEqual([['2'], ['1', '3', 'enter']])
    // a part answered already takes no second answer
    expect(await src.act({ type: 'answer', chat: key, question: 'q1:0', choice: 0 } as never)).toEqual({ ok: false })
    const posted = src.chats.log(key).posted.filter((p) => p.id.startsWith('cli-answer:'))
    expect(posted.map((p) => p.text)).toEqual(['Blue', 'S, L'])
    // one question alone, answered in words
    const one = 'COVQ-2/Agent'
    logged(one, { kind: 'question', id: 'q2', tool: 'AskUserQuestion', items: [items[0]] })
    typed = []
    expect(await src.act({ type: 'answer', chat: one, question: 'q2', choice: 0, other: 'Green' } as never)).toEqual({ ok: true })
    expect(typed).toEqual([['3'], 'Green', ['enter']])
    // an old alert's button for a question no longer asked
    expect(await src.act({ type: 'answer', chat: one, question: 'q-old', choice: 0 } as never)).toEqual({ ok: false })
  })

  test("its Dismiss is the CLI's Esc, while the CLI still waits on it; the whole form closes", async () => {
    const key = 'COVQ-3/Agent'
    logged(key, { kind: 'question', id: 'q3', tool: 'AskUserQuestion', items })
    const status = src.agents.status
    expect(await src.act({ type: 'answer', chat: key, question: 'q3:0', choice: 0, dismiss: true } as never)).toEqual({ ok: false, error: 'The CLI no longer waits on this question: read the chat again.' })
    src.agents.status = (() => 'blocked') as never
    try {
      expect(await src.act({ type: 'answer', chat: key, question: 'q3:1', choice: 0, dismiss: true } as never)).toEqual({ ok: true })
      expect(typed).toEqual([['escape']])
      expect(src.chats.log(key).answers['q3:0']).toBe(-1)
      expect(src.chats.log(key).answers['q3:1']).toBe(-1)
      expect(sent.at(-1)?.text).toContain('Which sizes?')
      expect(await src.act({ type: 'answer', chat: key, question: 'q3:0', choice: 0, dismiss: true } as never)).toEqual({ ok: false, error: 'This card is answered already.' })
      // a single question's own id
      const one = 'COVQ-4/Agent'
      logged(one, { kind: 'question', id: 'q4', tool: 'AskUserQuestion', items: [items[0]] })
      expect(await src.act({ type: 'answer', chat: one, question: 'q4', choice: 0, dismiss: true } as never)).toEqual({ ok: true })
      expect(src.chats.log(one).answers.q4).toBe(-1)
    } finally {
      src.agents.status = status
    }
  })
})

describe('what you send', () => {
  test('a slash command goes into the CLI as typed once its turn is over, its files as a message of their own', async () => {
    const sp = await space('slashes')
    const t = task(sp)
    const key = `${t.id}/Agent`
    const r = (await src.act({ type: 'send', chat: key, text: '/compact ', attachments: ['/x/inbox/abc-a.png'] } as never)) as { at: number }
    expect(r.at).toBeGreaterThan(0)
    expect(sent.map((s) => [s.key, s.text, s.opts?.command])).toEqual([
      [key, '/compact', true],
      [key, expect.stringContaining('a.png'), undefined],
    ])
    // to a coordinator not running: it is started first
    sent = []
    const coordinator = priv.coordinator
    const started: string[] = []
    priv.coordinator = async (id: unknown) => void started.push(id as string)
    try {
      await src.act({ type: 'send', chat: sp.place, text: '/clear' } as never)
    } finally {
      priv.coordinator = coordinator
    }
    expect(started).toEqual([sp.place])
    expect(sent.map((s) => s.text)).toEqual(['/clear'])
  })

  test('to a task held before it ever started: your words, or a slash command, start it on its brief', async () => {
    const sp = await space('unstarted')
    const t = task(sp, { worktree: undefined })
    const told: unknown[] = []
    const tell = src.engine.tell
    src.engine.tell = (async (id: string, text: string) => (told.push([id, text]), {})) as never
    try {
      expect(await src.act({ type: 'send', chat: `${t.id}/Agent`, text: 'go on' } as never)).toMatchObject({ waiting: true })
      expect(await src.act({ type: 'send', chat: `${t.id}/Agent`, text: '/compact' } as never)).toMatchObject({ waiting: true })
    } finally {
      src.engine.tell = tell
    }
    expect(told).toEqual([
      [t.id, 'go on'],
      [t.id, '/compact'],
    ])
    expect(sent).toEqual([])
  })
})

describe('the Browser and voice', () => {
  test("a task's shared browser here: none for a task not here or stopped, its own hub otherwise", () => {
    const out: string[] = []
    let closed = 0
    const client = { send: (d: string) => out.push(d), close: () => closed++ }
    src.browser('NOPE-9', client as never).message('x')
    expect(JSON.parse(out[0])).toMatchObject({ type: 'error', gone: true, message: 'No such task here.' })
    const t = { id: 'COVBR-1', project: 'p:here:x', stopped: Date.now() }
    src.engine.tasks.push(t as never)
    src.browser('COVBR-1', client as never).end()
    expect(JSON.parse(out[1]).message).toBe('The browser closed when the task was stopped.')
    expect(closed).toBe(2)
    delete (t as { stopped?: number }).stopped
    const attach = src.browsers!.attach
    const hub = { message() {}, end() {} }
    src.browsers!.attach = (() => hub) as never
    try {
      expect(src.browser('COVBR-1', client as never)).toBe(hub)
    } finally {
      src.browsers!.attach = attach
    }
  })

  test('a voice call needs its ElevenLabs key, and a chat that cannot be called says why', async () => {
    const s = readJson<Record<string, string>>('secrets.json', {})
    delete s.elevenlabs
    writeJson('secrets.json', s)
    const key = process.env.ELEVENLABS_API_KEY
    delete process.env.ELEVENLABS_API_KEY
    const out: string[] = []
    let closed = 0
    const client = { send: (d: string) => out.push(String(d)), close: () => closed++ }
    try {
      const call = src.voice(placeId.home(), client)
      await Bun.sleep(20)
      call.end()
      expect(out.some((m) => m.includes('Voice needs an ElevenLabs key'))).toBe(true)
      const tools = src.voiceTools
      src.voiceTools = (() => {
        throw new Error('No such chat.')
      }) as never
      try {
        const none = src.voice('p:here:nothing', client)
        none.audio(new ArrayBuffer(1))
        none.end()
      } finally {
        src.voiceTools = tools
      }
      expect(JSON.parse(out.at(-1)!)).toEqual({ type: 'error', message: 'No such chat.' })
      expect(closed).toBe(1)
    } finally {
      if (key !== undefined) process.env.ELEVENLABS_API_KEY = key
    }
  })
})

describe('who and where a command comes from', () => {
  test('a task its space by its task, a folder by the space it is in, and the only space when there is one', async () => {
    const sp = await space('wheres')
    const t = task(sp)
    const projectFor = (ctx: object) => (priv.projectFor as (p: unknown, c: unknown) => { name: string })({ words: [], opts: {}, flags: new Set() }, ctx)
    expect(projectFor({ chat: `${t.id}/Agent` }).name).toBe(sp.p.name)
    expect(projectFor({ cwd: sp.dir }).name).toBe(sp.p.name)
    const spaces = src.places.spaces
    try {
      src.places.spaces = [spaces.find((x) => x.name === sp.p.name)!]
      expect(projectFor({}).name).toBe(sp.p.name)
      src.places.spaces = []
      expect(() => projectFor({})).toThrow('Which space? Add --space NAME')
    } finally {
      src.places.spaces = spaces
    }
  })

  test("a message from another agent names it as we do, with its pane and the space or task it works in", () => {
    const sp = { p: { name: 'peers' }, dir: home }
    const t = task(sp)
    const tkey = `${t.id}/Agent`
    src.agents.records[tkey] = { key: tkey, name: 'herdr-name-1', kind: 'claude', cwd: home, logs: [], started: Date.now() } as never
    src.agents.records['p:here:coord'] = { key: 'p:here:coord', name: 'coord-name', kind: 'claude', cwd: home, logs: [], started: Date.now() } as never
    const info = src.agents.info
    src.agents.info = ((k: string) => (k === tkey ? { pane_id: 'w1:p1' } : undefined)) as never
    const peerOf = (p: object) => (priv.peerOf as (p: unknown) => unknown)(p)
    try {
      expect(peerOf({ name: 'herdr-name-1', text: '' })).toEqual({ name: `${t.id} agent`, pane: 'w1:p1', task: t.id, space: placeId.space('peers') })
      expect(peerOf({ name: 'w1:p1', text: '' })).toMatchObject({ pane: 'w1:p1', task: t.id })
      expect(peerOf({ name: 'coord-name', text: '' })).toEqual({ name: 'p:here:coord', space: 'p:here:coord' })
      // the chat's own reader asks the same
      expect((src.chats as unknown as { whoOf: (p: unknown) => unknown }).whoOf({ name: 'nobody', text: '' })).toEqual({ name: 'nobody' })
    } finally {
      src.agents.info = info
      delete src.agents.records[tkey]
      delete src.agents.records['p:here:coord']
    }
  })
})

/** swaps these of an object for the test's own while f runs, and puts them back after, failing or not */
async function swap<T extends object>(o: T, parts: Partial<Record<keyof T, unknown>>, f: () => unknown) {
  const was = Object.fromEntries(Object.keys(parts).map((k) => [k, (o as Record<string, unknown>)[k]]))
  Object.assign(o, parts)
  try {
    return await f()
  } finally {
    Object.assign(o, was)
  }
}

describe('agents Shepherdr keeps running', () => {
  test('a coordinator that stopped is started again, one that stays wrong is given up on with a card and an alert', async () => {
    const sp = await space('revives')
    const key = sp.place
    src.agents.records[key] = { key, name: 'revives', kind: 'claude', cwd: sp.dir, logs: [], started: Date.now() } as never
    const relaunched: unknown[] = []
    const t = task(sp)
    const tkey = `${t.id}/Agent`
    src.agents.records[tkey] = { key: tkey, name: t.id, kind: 'claude', cwd: sp.dir, logs: [], started: Date.now() } as never
    let wrong: Record<string, string | null | undefined> = { [key]: 'gone', [tkey]: null }
    let seen = 'go'
    const errors: string[] = []
    const error = console.error
    console.error = (m: string) => void errors.push(m)
    try {
      await swap(src.agents, { reachable: true, lastReach: Date.now(), wrong: async (k: string) => wrong[k], wasWorking: () => true, relaunch: async (k: string, close: boolean, start: () => Promise<unknown>) => (relaunched.push([k, close]), await start().catch(() => undefined)) }, async () => {
        await swap(src.revivals, { seen: () => seen }, async () => {
          await swap(src.engine, { mayRetry: () => true }, async () => {
            await swap(src as never, { coordinator: async () => undefined } as never, async () => {
              await src.revive()
              await Bun.sleep(10)
              expect(relaunched).toEqual([[key, false]])
              // it was at work: it is told it started again
              expect(sent.at(-1)).toMatchObject({ key })
              expect(errors.some((m) => m.includes(`${key}'s agent stopped: starting it again`))).toBe(true)
              // runs on outdated settings, and starting it fails
              wrong = { [key]: 'stale' }
              src.agents.relaunch = (async () => {
                throw new Error('herdr said no')
              }) as never
              await src.revive()
              await Bun.sleep(10)
              expect(errors.some((m) => m.includes("couldn't start") && m.includes('herdr said no'))).toBe(true)
              // fine now: its tries are forgotten in time
              wrong = { [key]: undefined }
              await src.revive()
              // given up on
              wrong = { [key]: 'stale' }
              seen = 'give-up'
              await src.revive()
              wrong = { [key]: 'gone' }
              await src.revive()
            })
          })
        })
      })
    } finally {
      console.error = error
      delete src.agents.records[key]
      delete src.agents.records[tkey]
    }
    const cards = src.chats.log(key).posted.filter((p) => p.id.startsWith('revive:')).map((p) => p.card?.text)
    expect(cards).toEqual([
      "Its agent keeps running on outdated settings, and starting it again didn't help. Restart it from ⋯ → Restart agent.",
      "Its agent stopped, and starting it again didn't help. Restart it from ⋯ → Restart agent.",
    ])
    expect(alerts.map((a) => a.tag)).toEqual([`revive:${key}`, `revive:${key}`])
  })

  test("a home space's coordinator running outside its folder starts again in its own once its turn is over", async () => {
    const key = placeId.home()
    const c = src.places.coordinator(key)!
    src.agents.records[key] = { key, name: 'home', kind: 'claude', cwd: join(home, 'elsewhere'), logs: [], started: Date.now() } as never
    const steps: string[] = []
    try {
      await swap(src.agents, { status: () => 'idle', background: () => false, finish: async () => void steps.push('finish') }, async () => {
        await swap(src as never, { coordinator: async () => void steps.push('start') } as never, async () => {
          priv.reseat(key)
          // a second look while it is at it starts nothing more
          priv.reseat(key)
          await Bun.sleep(10)
        })
      })
    } finally {
      delete src.agents.records[key]
    }
    expect(c.home).toBeTruthy()
    expect(steps).toEqual(['finish', 'start'])
  })

  test('a start whose screen moved on drops its card; a fresh start that fails says why; a look that throws is passed over', async () => {
    const key = 'COVST-1/Agent'
    src.agents.records[key] = { key, name: 'COVST-1', kind: 'claude', cwd: home, logs: [], started: Date.now() } as never
    const failed: unknown[] = []
    try {
      await swap(src.chats, { clearStartMenu: () => true }, () => priv.startStep(key, { do: 'clear' }))
      await swap(src.agents, { relaunch: async () => Promise.reject(new Error('no pane')), save: () => undefined }, async () => {
        await swap(src.engine, { startFailed: (k: string, why: string) => void failed.push([k, why]) }, () => priv.startStep(key, { do: 'error', fresh: true, why: '' }))
      })
      expect(failed).toEqual([[key, 'Claude Code couldn\'t start: no pane']])
      const looked: string[] = []
      await swap(src.agents, { reachable: true, lastReach: Date.now(), busy: () => false }, async () => {
        await swap(src as never, { lookStart: async (k: string) => (looked.push(k), Promise.reject(new Error('screen gone'))) } as never, async () => {
          await src.watchStarts()
          // nothing holds it: the next pass looks at it again
          await src.watchStarts()
        })
      })
      expect(looked.filter((k) => k === key)).toEqual([key, key])
    } finally {
      delete src.agents.records[key]
    }
  })
})

describe('when a provider cuts an agent off', () => {
  test("a note of it that can't be kept never stops what happens to the agent", async () => {
    const errors: string[] = []
    const error = console.error
    console.error = (m: string) => void errors.push(m)
    const key = 'p:here:cut'
    src.agents.records[key] = { key, name: 'cut', kind: 'claude', model: 'opus', cwd: home, logs: [], started: Date.now() } as never
    try {
      await swap(src.settings, { harness: () => { throw new Error('settings unreadable') } }, () => priv.coordinatorStuck(key, { lasting: true, reason: 'Out of credit' }, []))
      expect(errors.at(-1)).toContain("couldn't keep that a coordinator of this machine waits for its provider: settings unreadable")
      // its backup went in, and the note that it runs on one can't be written
      await swap(src.engine, { backupsFor: () => [{ n: 1, to: { kind: 'pi' } }] }, async () => {
        await swap(src.settings, { harness: () => ({ kind: 'claude', model: 'opus' }) }, async () => {
          await swap(src.returns, { note: () => { throw new Error('disk full') } }, async () => {
            await swap(src as never, { restartCoordinator: async () => 'pi' } as never, () => priv.coordinatorCantGoOn(key, { lasting: true, reason: 'Out of credit', cut: 1, words: '' }))
          })
        })
      })
      expect(errors.at(-1)).toContain(`couldn't keep that ${key} runs on a backup: disk full`)
      await swap(src.returns, { list: () => { throw new Error('returns unreadable') } }, () => priv.refreshGoingBack())
      expect(errors.at(-1)).toContain("couldn't tell which tasks go back to work: returns unreadable")
    } finally {
      console.error = error
      delete src.agents.records[key]
    }
  })

  test("a probe of the primary that throws is a failed probe: silent, and a longer wait", async () => {
    const errors: string[] = []
    const error = console.error
    console.error = (m: string) => void errors.push(m)
    const failed: unknown[] = []
    const o = { role: 'coordinator', space: 'probes', primary: { kind: 'claude' }, to: { kind: 'pi' }, why: 'x', at: Date.now() }
    try {
      await swap(src.returns, { list: () => [o], probe: async () => Promise.reject(new Error('probe broke')), failed: (...a: unknown[]) => void failed.push(a), tooOften: () => false }, async () => {
        await swap(src.engine, { installed: () => true }, async () => {
          await swap(src as never, { backTo: () => ({ primary: { kind: 'claude' }, chats: [{ key: 'p:here:probes' }] }) } as never, () => src.watchReturns())
        })
      })
    } finally {
      console.error = error
    }
    expect(errors.some((m) => m.includes("claude doesn't answer yet: probe broke"))).toBe(true)
    expect(failed.length).toBe(1)
  })

  test('news for a coordinator that asked for it, which herdr cannot take now, stays on disk for later', async () => {
    const x = src as unknown as { requestedNews: { drain: unknown }; drainingNews: boolean }
    await swap(x.requestedNews, { drain: async () => Promise.reject(new Error('herdr is down')) }, () => priv.drainRequestedNews())
    // the next pass tries again
    expect(x.drainingNews).toBe(false)
  })
})

describe("this machine's health", () => {
  const sample = { at: Date.now(), cores: 8, load: 1, memTotal: 16, memUsed: 4, disks: [{ path: '/data', pct: 97, freeGb: 3 }], gpus: [] }
  test('herdr answering again, and a disk filling up, each tell the home coordinator what to do', async () => {
    const send = src.agents.send
    const wakes = priv.wakes
    priv.wakes = () => true
    try {
      await priv.onHealth({ kind: 'herdr', what: 'back', since: Date.now() - 60_000, sample })
      await priv.onHealth({ kind: 'disk', what: 'over', sample })
    } finally {
      priv.wakes = wakes
    }
    expect(send).toBe(src.agents.send)
    const lines = sent.filter((s) => s.key === placeId.home()).map((s) => s.text)
    expect(lines.some((l) => l.includes('Agents it ran may have stopped with it'))).toBe(true)
    expect(lines.some((l) => l.includes('/data is 97% full') && l.includes('clean up'))).toBe(true)
  })
})

describe('restarting from the screen', () => {
  test('a restart saved as its space\'s Settings sets what differs; one Settings refuse is not made', async () => {
    const sp = await space('saves')
    const set: unknown[] = []
    await swap(src.engine, { installed: () => true }, async () => {
      await swap(src as never, { restartCoordinator: async () => 'Claude Code, sonnet, high effort' } as never, async () => {
        expect(await src.act({ type: 'restart', chat: sp.place, kind: 'claude', model: 'sonnet', effort: 'high', save: true } as never)).toEqual({ ok: true, on: 'Claude Code, sonnet, high effort' })
        expect(src.settings.pick('coordinator.agent', { space: sp.p.name }).value).toBe('Claude Code')
        expect(src.settings.pick('coordinator.model', { space: sp.p.name }).from).toBe('space')
        const real = src.settings.set.bind(src.settings)
        await swap(src.settings, { set: (k: string, v: string, at: unknown) => (set.push(k), k === 'coordinator.model' ? { ok: false } : real(k, v, at as never)) }, async () => {
          expect(await src.act({ type: 'restart', chat: sp.place, kind: 'pi', model: 'm2', effort: 'low', save: true } as never)).toEqual({ ok: false, error: "Couldn't save coordinator.model" })
        })
      })
    })
    expect(set).toEqual(['coordinator.agent', 'coordinator.model'])
    for (const k of ['agent', 'model', 'effort']) src.settings.set(`coordinator.${k}`, null, { space: sp.p.name })
  })

  test('restart --all names a coordinator it could not read as failed, and goes on', async () => {
    await swap(src as never, { restartable: () => { throw new Error('unreadable') } } as never, async () => {
      const r = (await src.act({ type: 'restart-all' } as never)) as { ok: boolean; failed: number }
      expect(r.ok).toBe(true)
      expect(r.failed).toBeGreaterThan(0)
    })
  })
})

describe('the rest', () => {
  test("Talk to type needs whisper.cpp and its model: without them it says what's missing", async () => {
    src.settings.set('dictate.model', join(home, 'no-model.bin'), 'machine')
    try {
      await expect(src.dictate(new Blob([new Uint8Array(4)]))).rejects.toThrow(/Talk to type needs/)
    } finally {
      src.settings.set('dictate.model', null, 'machine')
    }
  })

  test("a shared browser's idle close follows its task's space, and a sweep closes what finished tasks left", async () => {
    const sp = await space('browsers')
    const t = task(sp)
    const o = (src.browsers as unknown as { o: { idleClose: (task: string) => unknown } }).o
    expect(o.idleClose(t.id)).toBe(src.settings.idleClose({ space: sp.p.name }))
    expect(o.idleClose('NOPE-9')).toBe(src.settings.idleClose('machine'))
    const kept: unknown[] = []
    await swap(src.browsers!, { sweep: async (keep: (id: string) => boolean, forget: (id: string) => boolean) => (kept.push([keep(t.id), forget(t.id), forget('NOPE-9')]), []) }, () => src.sweepBrowsers())
    expect(kept).toEqual([[true, false, true]])
  })
})

describe('the advisor, while the human may still answer', () => {
  /** a space with its advisor set, and a task of it, as test/advisor.test.ts makes one */
  async function world(name: string) {
    const sp = await space(name)
    for (const [k, v] of [['advisor.agent', 'pi'], ['advisor.model', 'opencode-go/deepseek-v4.1-flash']]) expect(src.settings.set(k, v, { space: sp.p.name }).ok).toBe(true)
    const t = task(sp, { updated: Date.now() - 3_600_000 })
    const key = `${t.id}/Agent`
    src.agents.records[key] = { key, name: t.id, kind: 'pi', cwd: sp.dir, workspace: sp.p.name, logs: [], started: Date.now() } as never
    const card = (id: string, kind = 'Form') => src.chats.post(key, { id, question: { id, title: `Which one, ${id}?`, kind, choices: [{ label: 'A' }, { label: 'B' }], to: key } } as never)
    return { key, card, done: () => (delete src.agents.records[key], ['advisor.agent', 'advisor.model'].forEach((k) => src.settings.set(k, null, { space: sp.p.name }))) }
  }
  const answer = (o: object) => ({ ok: true, out: JSON.stringify({ decide: 'advisor', sure: true, why: 'Simpler.', ...o }) })

  test('answered meanwhile: its answer is kept, and nothing goes in', async () => {
    const w = await world('adv-meanwhile')
    try {
      w.card('ask:m1')
      await swap(src.engine, { installed: () => true }, () =>
        swap(src, { runAdvisor: (async () => (src.chats.answer(w.key, 'ask:m1', 0), answer({ choice: 2 }))) as never }, async () => {
          expect(await src.advise(w.key, 'ask:m1')).toEqual({ ok: true })
        }),
      )
      expect(src.advices.get(w.key, 'ask:m1')?.state).toBe('human')
      expect(sent).toEqual([])
    } finally {
      w.done()
    }
  })

  test("an answer that can't go in is kept as failed, and says why", async () => {
    const w = await world('adv-fails')
    try {
      w.card('ask:f1')
      await swap(src.engine, { installed: () => true }, () =>
        swap(src as never, { runAdvisor: async () => answer({ choice: 1 }), deliverAdvice: async () => ({ ok: false, error: 'the card moved on' }) } as never, async () => {
          expect(await src.advise(w.key, 'ask:f1')).toEqual({ ok: false, error: 'the card moved on' })
        }),
      )
      expect(src.advices.get(w.key, 'ask:f1')?.state).toBe('failed')
    } finally {
      w.done()
    }
  })

  test("what it said that made no sense is kept whole, unless its folder can't be written", async () => {
    const w = await world('adv-nonsense')
    // a file where its folder would be
    writeFileSync(join(home, 'advisor'), 'not a folder')
    const errors: string[] = []
    const error = console.error
    console.error = (m: string) => void errors.push(m)
    try {
      w.card('ask:n1')
      await swap(src.engine, { installed: () => true }, () =>
        swap(src, { runAdvisor: (async () => ({ ok: true, out: 'no json here' })) as never }, async () => {
          expect(await src.advise(w.key, 'ask:n1')).toEqual({ ok: false, error: 'The advisor gave no answer.' })
        }),
      )
    } finally {
      console.error = error
      w.done()
    }
    expect(errors.some((m) => m.includes('gave no answer') && !m.includes('(whole:'))).toBe(true)
  })

  test('Send it on a suggestion whose plan was answered meanwhile sends nothing', async () => {
    const w = await world('adv-plan-gone')
    try {
      w.card('plan:g1', 'Plan')
      await swap(src.engine, { installed: () => true }, () =>
        swap(src, { runAdvisor: (async () => answer({ choice: 1 })) as never }, async () => {
          expect(await src.advise(w.key, 'plan:g1')).toEqual({ ok: true })
        }),
      )
      const a = src.chats.chat(w.key).messages.find((m) => m.question?.id.startsWith('advice:'))!.question!
      src.chats.answer(w.key, 'plan:g1', 0)
      expect(await src.act({ type: 'answer', chat: w.key, question: a.id, choice: 0 } as never)).toEqual({ ok: false, error: 'The question no longer waits: it was answered meanwhile.' })
      expect(src.advices.byCard(a.id)?.state).toBe('human')
      expect(sent).toEqual([])
    } finally {
      w.done()
    }
  })
})

describe("an artifact's check in agent-browser", () => {
  test('opens the page in agent-browser at phone width; where it cannot, the artifact is shown without pictures', async () => {
    const bin = tmp('cover-bin')
    writeFileSync(join(bin, 'agent-browser'), '#!/bin/sh\necho "$@" >> "$(dirname "$0")/args"\necho "no display here" >&2\nexit 1\n', { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      const r = await browserCheck('<h1>Hi</h1>', { n: 1 })
      expect(r.skipped).toContain('no display here')
    } finally {
      process.env.PATH = path
    }
    expect(readFileSync(join(bin, 'args'), 'utf8')).toContain('set viewport 390 844')
  })

  test('shepherdr attach with no file lists what the folder has, and a folder that is gone lists nothing', async () => {
    const dir = tmp('cover-attach')
    writeFileSync(join(dir, 'shot.png'), 'x')
    expect((await src.cli(['attach'], { chat: placeId.home(), cwd: dir })).out).toContain('Here: shot.png')
    const none = (await src.cli(['attach'], { chat: placeId.home(), cwd: join(dir, 'gone') })).out
    expect(none).toContain('shepherdr attach <file>')
    expect(none).not.toContain('Here:')
  })
})
