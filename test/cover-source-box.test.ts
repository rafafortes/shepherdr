// The live source as a worker for another machine (box.ts): what only a worker does — the Everywhere defaults read from
// the main machine's settings, a command for Everywhere or for another space run by the main machine's Shepherdr, its
// mirror of the machine's logs, and the news a home space there does not need. The machine is one that can't be
// reached: an ssh on PATH that never connects, so nothing leaves this machine, and the main machine is a server of the
// test's own on loopback.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const home = tmp('cover-box')
process.env.SHEPHERDR_HOME = home
process.env.HERDR_SOCKET_PATH = join(home, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
// a worker starts agents on its machine only for a main server that is the human's own: this one starts none
process.env.SHEPHERDR_LAUNCH_AGENTS = '0'
// every ssh to that machine fails at once, as one to a machine that is off does; herdr and agent-browser answer nothing
const bin = tmp('cover-box-bin')
const sshLog = join(bin, 'ssh.log')
writeFileSync(join(bin, 'ssh'), `#!/bin/sh\necho "$@" >> '${sshLog}'\necho "ssh: Could not resolve hostname (test)" >&2\nexit 255\n`, { mode: 0o755 })
for (const n of ['herdr', 'agent-browser']) writeFileSync(join(bin, n), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.SHEPHERDR_AGENT_BROWSER = join(bin, 'agent-browser')
// Bun looks a command up in the PATH this process started with unless it is given an environment: each command this
// process starts is given this one, so the stand-ins above are what runs, never this machine's ssh or herdr
{
  type Opts = { env?: Record<string, string | undefined> } | undefined
  const withEnv = (a: unknown, o?: Opts) => (Array.isArray(a) ? [a, { ...o, env: o?.env ?? process.env }] : [{ ...(a as object), env: (a as Opts)?.env ?? process.env }])
  const [spawn, spawnSync] = [Bun.spawn, Bun.spawnSync] as unknown as ((...x: unknown[]) => unknown)[]
  Bun.spawn = ((a: unknown, o?: Opts) => spawn(...withEnv(a, o))) as typeof Bun.spawn
  Bun.spawnSync = ((a: unknown, o?: Opts) => spawnSync(...withEnv(a, o))) as typeof Bun.spawnSync
}
// the main machine's home (its server.json), and the settings it shares with its workers
const main = tmp('cover-box-main')
const shared = tmp('cover-box-shared')
writeFileSync(join(shared, 'settings.json'), JSON.stringify({ everywhere: { 'review.rounds': '4' } }))
process.env.SHEPHERDR_MAIN_HOME = main
process.env.SHEPHERDR_SHARED_HOME = shared
// the machine's home sits in the worker's own store, so its files are read here and never over ssh (mfs.ts)
const boxHome = join(home, 'box')
process.env.SHEPHERDR_BOX = JSON.stringify({ label: 'faraway', target: 'faraway.invalid', session: 'default', herdr: join(bin, 'no-herdr'), home: boxHome, path: bin, os: 'Linux' })

const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { PROFILES_ON_MAIN } = await import('../server/live/profiles.ts')

const src = new LiveSource()
afterAll(() => src.stop())
const priv = src as unknown as Record<string, (...a: unknown[]) => unknown>

/** the main machine's Shepherdr: what its /api/cli was asked, and what it answers */
let answer = { out: 'done there', code: 0 }
const asked: { args: string[]; chat?: string }[] = []
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: async (req) => {
    asked.push((await req.json()) as { args: string[] })
    return Response.json(answer)
  },
})
afterAll(() => server.stop(true))
const listen = () => writeFileSync(join(main, 'server.json'), JSON.stringify({ port: server.port }))

describe('a worker for another machine', () => {
  test("reaches its machine's herdr and logs over ssh, here the stand-in that never connects", async () => {
    for (const t0 = Date.now(); !existsSync(sshLog) && Date.now() - t0 < 5000; ) await Bun.sleep(20)
    const calls = readFileSync(sshLog, 'utf8')
    expect(calls).toContain('faraway.invalid')
    expect(calls).toContain('remote-api-bridge')
  })

  test("starts on the main machine's Everywhere defaults, and takes them again as they change", () => {
    expect(src.settings.everywhere()['review.rounds']).toBe('4')
    const snaps: number[] = []
    const off = src.on('snapshot', () => snaps.push(1))
    writeFileSync(join(shared, 'settings.json'), JSON.stringify({ everywhere: { 'review.rounds': '5' } }))
    priv.adoptEverywhere()
    expect(src.settings.everywhere()['review.rounds']).toBe('5')
    expect(snaps.length).toBeGreaterThan(0)
    // the same again changes nothing; a settings file it can't read, or none, leaves them as they are
    snaps.length = 0
    priv.adoptEverywhere()
    writeFileSync(join(shared, 'settings.json'), '{ not json')
    priv.adoptEverywhere()
    const was = process.env.SHEPHERDR_SHARED_HOME
    delete process.env.SHEPHERDR_SHARED_HOME
    try {
      priv.adoptEverywhere()
    } finally {
      process.env.SHEPHERDR_SHARED_HOME = was
    }
    expect(snaps).toEqual([])
    expect(src.settings.everywhere()['review.rounds']).toBe('5')
    off()
  })

  test("mirrors the hooks, Claude Code's and pi's session folders and each agent's logs", () => {
    const followed: { dirs: string[]; files: string[] }[] = []
    const mirror = src.mirror!
    const follow = mirror.follow
    mirror.follow = ((dirs: string[], files: string[]) => void followed.push({ dirs, files })) as never
    src.agents.records['p:faraway:a'] = { key: 'p:faraway:a', name: 'a', kind: 'claude', cwd: join(boxHome, 'a'), logs: [join(boxHome, 'a.jsonl')], started: Date.now() } as never
    src.agents.records['p:faraway:b'] = { key: 'p:faraway:b', name: 'b', kind: 'pi', cwd: join(boxHome, 'b'), logs: [], started: Date.now() } as never
    try {
      priv.followLogs()
    } finally {
      mirror.follow = follow
      delete src.agents.records['p:faraway:a']
      delete src.agents.records['p:faraway:b']
    }
    const { dirs, files } = followed[0]
    expect(dirs[0]).toBe(join(boxHome, '.shepherdr', 'helper', 'hooks'))
    expect(dirs[1]).toBe(`${boxHome}/.claude/sessions`)
    expect(dirs.some((d) => d.startsWith(`${boxHome}/.codex/sessions/`))).toBe(true)
    expect(dirs.length).toBe(6)
    expect(files).toEqual([join(boxHome, 'a.jsonl')])
  })

  test("a setting for Everywhere is set by the main machine's Shepherdr, and taken here at once", async () => {
    listen()
    answer = { out: 'review.rounds = 3 (Everywhere)', code: 0 }
    const r = await src.cli(['set', 'review.rounds', '3'], {})
    expect(asked.at(-1)?.args).toEqual(['set', 'review.rounds', '3'])
    expect(r.code).toBe(0)
    answer = { out: 'No such setting.\n', code: 1 }
    expect(await src.cli(['unset', 'review.rounds'], {})).toEqual({ out: 'No such setting.\n', code: 1 })
    expect(asked.at(-1)?.args).toEqual(['unset', 'review.rounds'])
  })

  test("the main machine's Shepherdr out of reach: try again in a minute", async () => {
    writeFileSync(join(main, 'server.json'), '{}')
    const r = await src.cli(['set', 'review.rounds', '3'], {})
    expect(r.code).toBe(1)
    expect(r.out).toContain("The main machine's Shepherdr can't be reached right now")
  })

  test('a task for a space this machine does not have is added by the main machine', async () => {
    listen()
    answer = { out: 'Added WEB-7: Fix it.\n', code: 0 }
    expect(await src.cli(['task', 'add', 'Fix it', '--desc', 'the brief', '--space', 'website'], {})).toEqual({ out: 'Added WEB-7: Fix it.\n', code: 0 })
    expect(asked.at(-1)?.args).toEqual(expect.arrayContaining(['task', 'add', 'Fix it', '--space', 'website']))
    answer = { out: 'No space called website\n', code: 1 }
    expect(await src.cli(['task', 'add', 'Fix it', '--space', 'website'], {})).toEqual({ out: 'No space called website\n', code: 1 })
  })

  test('doctor runs on the main machine only', async () => {
    const r = await src.cli(['doctor'], {})
    expect(r.code).toBe(1)
    expect(r.out).toContain('shepherdr doctor checks every machine from the main one')
  })

  test("a space's news wakes no home space there that is not on Autopilot: the main machine's overview has it", () => {
    const sent: string[] = []
    const send = src.agents.send
    src.agents.send = (async (key: string) => (sent.push(key), {})) as never
    try {
      priv.news('p:faraway:web', 'WEB-1 is ready', 'ready', { task: 'WEB-1', event: 'ready' })
    } finally {
      src.agents.send = send
    }
    expect(sent).not.toContain(placeId.home())
  })

  test("an artifact's pictures that can't be copied to the machine are named as such", async () => {
    // (its page is read on that machine, which can't be reached: the check itself is what is looked at here)
    const check = (priv.checkArtifact as (html: string, data: unknown, missing: string[]) => Promise<{ report: string }>).bind(src)
    src.checker = async () => ({ errors: [], warnings: [], shots: { light: join(home, 'gone.png'), dark: join(home, 'gone-dark.png') } })
    expect((await check('<h1>Board</h1>', undefined, [])).report).toContain('No pictures: they could not be copied to')
    src.checker = async () => ({ errors: [], warnings: [], skipped: 'agent-browser: no display' })
    expect((await check('<h1>Board</h1>', undefined, [])).report).toContain('the main machine could not open its browser')
  })

  test("a merge gate runs on that machine over its link, and its failure there refuses the merge", async () => {
    // (it is not left running detached, as on the main machine: there it ends with this worker, as every command does)
    const t = { id: 'FA-1', title: 'Gate there', base: 'main', set: { 'merge.gate': 'tools/far-gate.sh' } }
    const gate = (src.engine as unknown as Record<string, (...a: unknown[]) => Promise<{ ok: boolean; error?: string }>>).gate.bind(src.engine)
    const r = await gate(t, join(boxHome, 'repo'), 'far', join(boxHome, 'wt'))
    expect(r.ok).toBe(false)
    expect(r.error).toContain("FA-1's merge gate (tools/far-gate.sh) failed (exit 255): nothing was merged")
    expect((t as { mergeStop?: string }).mergeStop).toBe('Refused by the gate: ssh: Could not resolve hostname (test)')
    expect(readFileSync(sshLog, 'utf8')).toContain('tools/far-gate.sh')
  })

  test("a file a chat names outside that machine's inbox is none of its own, even with no older inbox there", async () => {
    mkdirSync(join(boxHome, '.shepherdr', 'helper', 'inbox'), { recursive: true })
    const file = join(home, 'elsewhere.png')
    writeFileSync(file, 'x')
    const chat = src.chat
    src.chat = (() => ({ key: 'p:faraway:a', messages: [{ id: 'm1', file: { path: file, name: 'elsewhere.png' } }] })) as never
    try {
      expect(await src.attachment('p:faraway:a', file)).toBeNull()
    } finally {
      src.chat = chat
    }
  })

  test('profiles are kept on the main machine: a worker reads none and writes none', async () => {
    expect(await src.act({ type: 'profiles' })).toEqual({ profiles: [], active: 'Custom', unavailable: PROFILES_ON_MAIN })
    for (const a of [
      { type: 'profile-save', name: 'x' },
      { type: 'profile-preview', name: 'x' },
      { type: 'profile-apply', name: 'x' },
      { type: 'profile-undo' },
      { type: 'profile-rename', name: 'x', to: 'y' },
      { type: 'profile-delete', name: 'x' },
    ] as const) expect(await src.act(a as never)).toEqual({ ok: false, error: PROFILES_ON_MAIN })
    expect(await src.cli(['profile', 'list'], {})).toEqual({ out: `${PROFILES_ON_MAIN}\n`, code: 1 })
  })
})
