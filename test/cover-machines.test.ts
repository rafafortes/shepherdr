// Every machine run from the main one (server/live/machines.ts), end to end against fakes: an `ssh` in place of the
// real one, answering as a machine would (its look, the helper going there, Chrome, an old install's records), and a
// worker in place of server/main.ts (process.execPath, which the main server starts its workers with, points at it),
// serving a snapshot, actions and the live link. No real SSH, herdr, agent CLI or Shepherdr worker runs; the records
// go in this file's own home under /tmp (test/preload.ts).
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Action, Chat } from '../shared/types.ts'
import { HOME, writeJson } from '../server/store.ts'
import { Machines, codeVersion, machineHome } from '../server/live/machines.ts'
import { helperVersion, type Probe, type Saved } from '../server/live/install.ts'
import { tmp } from './tmp.ts'

type Link = ReturnType<Machines['list']>[number]

const bun = process.execPath
const dir = tmp('cover-machines')
const bin = join(dir, 'bin')
mkdirSync(bin)

/** ssh as a machine answers it: what <target>.json says for each command Shepherdr sends, each one written down */
writeFileSync(
  join(dir, 'fake-ssh.ts'),
  `import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const dir = ${JSON.stringify(dir)}
const args = process.argv.slice(2)
const target = args[args.length - 2]
const line = args[args.length - 1]
// the script as the machine's shell runs it: ssh hands it \`/bin/sh -c '<script>'\`
const script = Bun.spawnSync(['/bin/sh', '-c', 'printf %s ' + line.slice('/bin/sh -c '.length)]).stdout.toString()
const kind = script.includes('echo "home=$HOME"') ? 'probe' : script.includes('tar xf - -C "$d"') ? 'install' : / install$/.test(script) ? 'chrome' : script.includes('tar cf -') ? 'copy' : script.includes('plugin disable shepherdr') ? 'disable' : 'other'
const f = dir + '/' + target + '.json'
const c = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}
const stdin = kind === 'install' ? (await Bun.stdin.arrayBuffer()).byteLength : 0
appendFileSync(dir + '/calls.jsonl', JSON.stringify({ target, kind, script, stdin }) + '\\n')
async function answer(out, err, code) {
  if (out) await Bun.write(Bun.stdout, out)
  if (err) await Bun.write(Bun.stderr, err)
  process.exit(code ?? 0)
}
if (kind === 'probe') {
  if (c.probeDelay) await Bun.sleep(c.probeDelay)
  await answer(c.probe, c.probeErr, c.probeCode)
} else if (kind === 'install') await answer('', c.installErr, c.installCode)
else if (kind === 'chrome') await answer(c.chromeOut, c.chromeErr, c.chromeCode)
else if (kind === 'copy') {
  // the tar of its old records runs for real, in a folder that stands for that machine's home
  const p = Bun.spawn(['/bin/sh', '-c', script], { env: { ...process.env, HOME: c.remote }, stdout: 'inherit', stderr: 'inherit' })
  process.exit(await p.exited)
} else await answer('', '', 0)
`,
)
writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nexec '${bun}' '${join(dir, 'fake-ssh.ts')}' "$@"\n`)
chmodSync(join(bin, 'ssh'), 0o755)

/** a machine's worker: what it was started with written down, then it serves and says where in its server.json */
writeFileSync(
  join(dir, 'fake-worker.ts'),
  `import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const home = process.env.SHEPHERDR_HOME
const box = JSON.parse(process.env.SHEPHERDR_BOX)
const env = Object.fromEntries(['SHEPHERDR_HOME', 'SHEPHERDR_MACHINE', 'SHEPHERDR_PORT', 'SHEPHERDR_MAIN_HOME', 'SHEPHERDR_SHARED_HOME', 'CLAUDE_CONFIG_DIR'].map((k) => [k, process.env[k]]))
appendFileSync(${JSON.stringify(join(dir, 'workers.jsonl'))}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), box, env }) + '\\n')
const snapshot = { name: 'S', host: box.label, machines: [{ machine: box.label, status: 'idle' }], places: [], tasks: [], automations: {}, asks: {}, settings: [], overrides: {}, user: 'u' }
const s = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req, srv) {
    const u = new URL(req.url)
    if (u.pathname === '/api/ws') return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
    if (u.pathname === '/api/snapshot') return Response.json(snapshot)
    if (u.pathname === '/api/action') return Response.json({ ok: true, did: await req.json() })
    return new Response(box.label + ' ' + u.pathname)
  },
  websocket: { message() {} },
})
console.log('worker of ' + box.label + ' serves on ' + s.port)
writeFileSync(join(home, 'server.json'), JSON.stringify({ port: s.port, pid: process.pid }))
`,
)
const workerBin = join(dir, 'worker')
writeFileSync(workerBin, `#!/bin/sh\nexec '${bun}' '${join(dir, 'fake-worker.ts')}' "$@"\n`)
chmodSync(workerBin, 0o755)

// Bun.spawn finds a command by the PATH this process started with (one set here never reaches it), so every ssh
// Shepherdr starts from this file is the fake one: no real ssh runs here
const spawn = Bun.spawn
const fakeSsh = join(bin, 'ssh')
const bunObject = Bun as unknown as { spawn: (cmd: unknown, opts?: unknown) => unknown }
bunObject.spawn = (cmd, opts) => spawn((Array.isArray(cmd) && cmd[0] === 'ssh' ? [fakeSsh, ...cmd.slice(1)] : cmd) as string[], opts as never)
const state = process.env.XDG_STATE_HOME
// herdr's own record of where herdr is on a machine (install.ts herdrPath): none, here
process.env.XDG_STATE_HOME = join(dir, 'state')
// the main server starts a machine's worker as `<process.execPath> server/main.ts`: here, the fake one
process.execPath = workerBin
afterAll(() => {
  process.execPath = bun
  bunObject.spawn = spawn as never
  if (state === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = state
})

const OS = 'Linux'
// a system Shepherdr has no agent-browser for: the helper sent over is only its scripts and skills, not 18 MB
const ARCH = 'riscv64'
const HELPER = helperVersion(OS, ARCH)
const ALL = { herdr: true, git: true, perl: true, jsonpp: true, tar: true, gh: true, claude: true, codex: true }

/** what a machine says to Shepherdr's look (install.ts PROBE), and the Probe Shepherdr makes of it */
function looks(o: { home: string; path?: string; tools?: Record<string, boolean>; helper?: string; old?: boolean }): { text: string; probe: Probe } {
  const tools = o.tools ?? ALL
  const p = o.path ?? '/usr/bin:/bin'
  const lines = [`home=${o.home}`, `os=${OS}`, `arch=${ARCH}`, `path=${p}`]
  for (const [t, has] of Object.entries(tools)) if (has) lines.push(t === 'jsonpp' ? 'tool.jsonpp=1' : `tool.${t}=/usr/bin/${t}`)
  if (o.helper) lines.push(`helper=${o.helper}`)
  if (o.old) lines.push('old=1')
  const probe: Probe = { home: o.home, os: OS, arch: ARCH, path: p, herdr: tools.herdr ? '/usr/bin/herdr' : 'herdr', tools: Object.fromEntries(Object.entries(tools).filter(([, v]) => v)), helper: o.helper ?? '', browser: '', oldInstall: !!o.old }
  return { text: lines.join('\n') + '\n', probe }
}

/** how a machine answers ssh */
function machine(target: string, c: Record<string, unknown>) {
  writeFileSync(join(dir, `${target}.json`), JSON.stringify(c))
}

const saved = (label: string, session = 'default'): Saved => ({ id: label, label, target: `${label}.test`, session, enabled: true })
const remoteHome = (label: string) => {
  const h = join(dir, 'remote', label)
  mkdirSync(h, { recursive: true })
  return h
}

const jsonl = <T>(f: string): T[] => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [])
const calls = (label: string) => jsonl<{ target: string; kind: string; script: string; stdin: number }>(join(dir, 'calls.jsonl')).filter((c) => c.target === `${label}.test`)
const kinds = (label: string) => calls(label).map((c) => c.kind)
const workers = (label: string) => jsonl<{ pid: number; argv: string[]; box: { label: string; target: string; path: string; home: string }; env: Record<string, string> }>(join(dir, 'workers.jsonl')).filter((w) => w.box.label === label)

// a fake worker is a bun process of its own: on a loaded machine (load ~50) it can take longer than 15 s to answer
async function until(what: string, f: () => boolean, ms = 45_000) {
  const end = performance.now() + ms
  while (!f()) {
    if (performance.now() > end) throw new Error(`timed out waiting: ${what}`)
    await Bun.sleep(20)
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** a process that is not there any more: its pid, once it ended */
function deadPid() {
  const p = Bun.spawnSync(['true'])
  return p.pid
}

/** a worker left running from before: a process whose command is a server/main.ts, as Shepherdr's workers are */
const olds: ReturnType<typeof Bun.spawn>[] = []
async function oldWorker() {
  const d = tmp('cover-machines-old')
  mkdirSync(join(d, 'server'))
  writeFileSync(join(d, 'server', 'main.ts'), `const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('old') }); console.log(s.port)`)
  const p = Bun.spawn([bun, join(d, 'server', 'main.ts')], { stdout: 'pipe', stderr: 'ignore' })
  olds.push(p)
  const reader = p.stdout.getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  return { pid: p.pid, port: Number(new TextDecoder().decode(value).trim()) }
}

const made: Machines[] = []
function machines(list: Saved[] | null, status: Record<string, { status: string; error: string | null }> = {}) {
  const m = new Machines(list ? async () => list : null, async () => Object.fromEntries(Object.entries(status).map(([label, s]) => [label, { label, ...s }])))
  made.push(m)
  return m
}
const linkOf = (m: Machines, label: string) => m.byName(label)!

// each test ends with its server stopped, every worker it started gone, and no machine's records left for the next one
afterEach(async () => {
  for (const m of made.splice(0)) m.stop()
  const fake = join(dir, 'fake-worker.ts')
  for (const w of jsonl<{ pid: number }>(join(dir, 'workers.jsonl')))
    if (alive(w.pid) && Bun.spawnSync(['ps', '-o', 'command=', '-p', String(w.pid)]).stdout.toString().includes(fake)) process.kill(w.pid, 'SIGKILL')
  for (const p of olds.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL')
  rmSync(join(HOME, 'machines'), { recursive: true, force: true })
})

describe('a machine herdr saves', () => {
  test('is looked at, gets the helper, and its worker starts there and is reached', async () => {
    const label = 'one'
    const home = remoteHome(label)
    machine(`${label}.test`, { probe: looks({ home }).text })
    const m = machines([saved(label)], { [label]: { status: 'reachable', error: null } })
    // new to this server: it is shown at once, connecting
    await until('the machine to show', () => !!m.byName(label))
    const l = linkOf(m, label)
    expect(m.rows()).toEqual([{ name: label, state: 'Connecting…' }])
    await until('its worker to be reached', () => l.reachable && l.state === 'Ready', 20_000)
    expect(m.rows()).toEqual([{ name: label, state: `Ready · ${label}.test` }])
    expect(l.connecting).toBe(false)

    // it lacked the helper: the helper went there (a tar on its stdin), then Chrome for the shared browser
    await until('Chrome to be asked for', () => kinds(label).includes('chrome'))
    expect(kinds(label)).toEqual(['probe', 'install', 'chrome'])
    expect(calls(label)[1].stdin).toBeGreaterThan(0)
    expect(l.probe?.helper).toBe(HELPER)
    expect(l.chrome).toBeUndefined()

    // its worker is this Shepherdr, with that machine's records and facts
    const [w] = workers(label)
    expect(w.pid).toBe(l.worker!.pid)
    expect(w.argv[0].endsWith(join('server', 'main.ts'))).toBe(true)
    expect(w.box).toMatchObject({ label, target: `${label}.test`, home, path: `${home}/.shepherdr/helper/bin:/usr/bin:/bin` })
    expect(w.env).toEqual({
      SHEPHERDR_HOME: machineHome(label),
      SHEPHERDR_MACHINE: label,
      SHEPHERDR_PORT: '0',
      SHEPHERDR_MAIN_HOME: HOME,
      SHEPHERDR_SHARED_HOME: HOME,
      CLAUDE_CONFIG_DIR: `${machineHome(label)}/mirror${home}/.claude`,
    })

    // what you do there and the pages you open go through to it
    const a: Action = { type: 'send', chat: `p:${label}:web`, text: 'hi' }
    expect(await m.act(l, a)).toEqual({ ok: true, did: a })
    expect(await (await m.fetch(l, '/some/page')).text()).toBe(`${label} /some/page`)
    // and the doctor reads its own log
    expect(m.log(label)).toContain(`worker of ${label} serves on`)
    expect(m.log('nobody-here')).toBe('')
  }, 90_000)

  test("one herdr can't reach waits, with herdr's own words, and gets no look", async () => {
    const m = machines([saved('cut-a'), saved('cut-b')], { 'cut-a': { status: 'unreachable', error: 'Connection refused' }, 'cut-b': { status: 'auth-failed', error: null } })
    await until('both to be marked', () => m.list().length === 2 && m.list().every((l) => !l.connecting))
    expect(m.rows()).toEqual([
      { name: 'cut-a', state: "herdr can't reach it: Connection refused" },
      { name: 'cut-b', state: "herdr can't reach it: auth-failed" },
    ])
    expect(kinds('cut-a')).toEqual([])
    expect(kinds('cut-b')).toEqual([])
    expect(m.list().every((l) => !l.worker)).toBe(true)
  })

  test("one that lacks a tool says what it needs, and one SSH can't reach says why: neither gets a worker", async () => {
    machine('short.test', { probe: looks({ home: remoteHome('short'), tools: { herdr: true, perl: true } }).text })
    machine('gone.test', { probeCode: 255, probeErr: 'debug1: trying\nssh: connect to host gone.test port 22: Connection refused\n' })
    const m = machines([saved('short'), saved('gone')])
    await until('both to settle', () => m.list().length === 2 && m.list().every((l) => !l.connecting && !l.busy))
    expect(linkOf(m, 'short').state).toBe('Needs git, perl (with JSON::PP), tar, an agent CLI (Claude Code, Codex or pi)')
    expect(linkOf(m, 'short').lacks).toHaveLength(4)
    expect(linkOf(m, 'gone').state).toBe("Can't reach it: ssh: connect to host gone.test port 22: Connection refused")
    // the helper went to neither
    expect(kinds('short')).toEqual(['probe'])
    expect(kinds('gone')).toEqual(['probe'])
    expect(m.list().every((l) => !l.worker)).toBe(true)
  })

  test('with Shepherdr installed there before, its records come here once and that copy is turned off', async () => {
    // a: nothing of it here yet, so its records are copied; b: they came already, so only the old copy is turned off
    for (const label of ['old-a', 'old-b']) {
      const home = remoteHome(label)
      const there = join(home, '.shepherdr')
      mkdirSync(join(there, 'tasks'), { recursive: true })
      mkdirSync(join(there, 'helper'), { recursive: true })
      writeFileSync(join(there, 'spaces.json'), '{"from":"there"}')
      writeFileSync(join(there, 'tasks', 'A-1.json'), '{}')
      writeFileSync(join(there, 'helper', 'version'), 'old')
      writeFileSync(join(there, 'config.json'), '{"main":"desk"}')
      machine(`${label}.test`, { probe: looks({ home, path: '/opt/bin:/usr/bin', old: true }).text, remote: home })
    }
    mkdirSync(machineHome('old-b'), { recursive: true })
    writeFileSync(join(machineHome('old-b'), 'spaces.json'), '{"from":"here"}')
    const m = machines([saved('old-a', 'work'), saved('old-b')])
    await until('both to be ready', () => m.list().length === 2 && m.list().every((l) => l.state === 'Ready'), 20_000)

    const a = machineHome('old-a')
    expect(readFileSync(join(a, 'spaces.json'), 'utf8')).toBe('{"from":"there"}')
    expect(existsSync(join(a, 'tasks', 'A-1.json'))).toBe(true)
    // what is that machine's own (its helper, its config naming a main machine) stays there
    expect(existsSync(join(a, 'helper'))).toBe(false)
    expect(existsSync(join(a, 'config.json'))).toBe(false)
    expect(readFileSync(join(machineHome('old-b'), 'spaces.json'), 'utf8')).toBe('{"from":"here"}')

    expect(kinds('old-a').filter((k) => k === 'copy' || k === 'disable')).toEqual(['copy', 'disable'])
    expect(kinds('old-b').filter((k) => k === 'copy' || k === 'disable')).toEqual(['disable'])
    const off = calls('old-a').find((c) => c.kind === 'disable')!.script
    expect(off).toContain("PATH='/opt/bin:/usr/bin'; herdr --session 'work' plugin disable shepherdr")
    expect(off).toContain('config.json.before-one-install')
  }, 90_000)

  test('a worker still running there from before is stopped before a new one starts, never beside it', async () => {
    const old = await oldWorker()
    writeJson('machines/twice/server.json', { pid: old.pid })
    machine('twice.test', { probe: looks({ home: remoteHome('twice') }).text })
    const m = machines([saved('twice')])
    await until('the machine to show', () => !!m.byName('twice'))
    const l = linkOf(m, 'twice')
    let beside = false
    await until('the new worker to be reached', () => {
      if (alive(old.pid) && l.worker) beside = true
      return l.state === 'Ready'
    }, 20_000)
    expect(beside).toBe(false)
    expect(alive(old.pid)).toBe(false)
    expect(l.worker?.pid).not.toBe(old.pid)
    expect(workers('twice')).toHaveLength(1)
  }, 90_000)
})

describe('a restart of the main server', () => {
  /** what a machine showed before the restart: herdr's record of it and its last look */
  const keptLook = (label: string, probe: Probe) => writeJson(`machines/${label}/last.json`, { saved: saved(label), probe })

  test('a machine whose last look still fits starts its worker at once, and the new look that agrees changes nothing', async () => {
    const home = remoteHome('quick')
    const { text, probe } = looks({ home, helper: HELPER })
    keptLook('quick', probe)
    // its worker from before is gone: nothing to take back
    writeJson('machines/quick/server.json', { port: 1, pid: deadPid(), code: codeVersion() })
    machine('quick.test', { probe: text, probeDelay: 400 })
    const m = machines([saved('quick')])
    const l = linkOf(m, 'quick')
    // the worker starts on the last look, before the new one is back
    await until('a worker', () => !!l.worker)
    const first = l.worker!.pid
    await until('the look to be done', () => kinds('quick').includes('probe') && !l.busy)
    await until('the worker to be reached', () => l.state === 'Ready')
    // the helper there is this one's: none sent, and the worker it started goes on
    expect(kinds('quick')).toEqual(['probe'])
    expect(l.worker!.pid).toBe(first)
    expect(workers('quick')).toHaveLength(1)
  }, 90_000)

  test('a machine whose new look differs from the last gets its worker started again from the new one', async () => {
    const home = remoteHome('moved')
    keptLook('moved', looks({ home, helper: HELPER, path: '/old/bin' }).probe)
    machine('moved.test', { probe: looks({ home, helper: HELPER, path: '/new/bin' }).text, probeDelay: 500 })
    const m = machines([saved('moved')])
    const l = linkOf(m, 'moved')
    await until('the first worker', () => !!l.worker)
    const first = l.worker!.pid
    await until('a second worker to be reached', () => !!l.worker && l.worker.pid !== first && l.state === 'Ready', 20_000)
    expect(alive(first)).toBe(false)
    expect(workers('moved').find((w) => w.pid === l.worker!.pid)?.box.path).toBe(`${home}/.shepherdr/helper/bin:/new/bin`)
    expect(kinds('moved')).toEqual(['probe'])
  }, 90_000)

  test('a worker on other code is stopped first, and the machine starts again once it is gone', async () => {
    const old = await oldWorker()
    const home = remoteHome('newer')
    keptLook('newer', looks({ home, helper: HELPER }).probe)
    writeJson('machines/newer/server.json', { port: old.port, pid: old.pid, code: 'older' })
    machine('newer.test', { probe: looks({ home, helper: HELPER }).text })
    const m = machines([saved('newer')])
    const l = linkOf(m, 'newer')
    // the old one finishes what it does first: nothing starts beside it
    let beside = false
    await until('the old worker to stop', () => {
      if (!alive(old.pid)) return true
      if (l.worker) beside = true
      return false
    })
    expect(beside).toBe(false)
    await until('the new worker to be reached', () => l.state === 'Ready' && !!l.worker, 20_000)
    expect(l.worker!.pid).not.toBe(old.pid)
    expect(workers('newer')).toHaveLength(1)
  }, 90_000)

  test("what a machine showed is kept as the server stops, and a disk that can't take it doesn't stop it", async () => {
    const m = machines([saved('full')], { full: { status: 'unreachable', error: 'down' } })
    await until('the machine to show', () => !!m.byName('full') && !m.byName('full')!.connecting)
    // its record can't be written: a folder stands where it goes
    mkdirSync(join(HOME, 'machines', 'full', 'last.json'), { recursive: true })
    expect(() => m.stop()).not.toThrow()
    expect(statSync(join(HOME, 'machines', 'full', 'last.json')).isDirectory()).toBe(true)
  })
})

describe('shepherdr doctor', () => {
  test('checks every machine again: the helper and worker again, and what each lacks or why it is out of reach', async () => {
    machine('doc-chrome.test', { probe: looks({ home: remoteHome('doc-chrome'), tools: { herdr: true, git: true, perl: true, jsonpp: true, tar: true, pi: true } }).text, chromeCode: 1, chromeErr: 'downloading\nno space left on device\n' })
    machine('doc-out.test', { probe: looks({ home: remoteHome('doc-out') }).text, chromeCode: 1, chromeOut: 'fetching\ndone badly\n' })
    machine('doc-short.test', { probe: looks({ home: remoteHome('doc-short'), tools: { herdr: true, perl: true } }).text })
    machine('doc-gone.test', { probeCode: 255, probeErr: 'ssh: connect to host doc-gone.test port 22: Connection refused' })
    const m = machines(['doc-chrome', 'doc-out', 'doc-short', 'doc-gone'].map((x) => saved(x)))
    await until('all four to settle', () => m.list().length === 4 && m.list().every((l) => !l.busy && !l.connecting), 20_000)
    const chrome = linkOf(m, 'doc-chrome')
    const out = linkOf(m, 'doc-out')
    await until('their workers and Chrome', () => !!chrome.worker && !!out.worker && !!chrome.chrome && !!out.chrome)
    const before = [chrome.worker!.pid, out.worker!.pid]

    expect(await m.doctor()).toEqual([
      "doc-chrome (doc-chrome.test): helper put there again, worker started again; not there: gh (pull requests of GitHub repos), Claude Code, Codex; Chrome didn't install there: no space left on device",
      "doc-out (doc-out.test): helper put there again, worker started again; Chrome didn't install there: done badly",
      'doc-short (doc-short.test): needs git, perl (with JSON::PP), tar, an agent CLI (Claude Code, Codex or pi); not there: gh (pull requests of GitHub repos), Claude Code, Codex',
      "doc-gone (doc-gone.test): Can't reach it: ssh: connect to host doc-gone.test port 22: Connection refused",
    ])
    // the workers were stopped and started again, and the helper sent again although it was this one's
    expect(before.some(alive)).toBe(false)
    expect(chrome.worker!.pid).not.toBe(before[0])
    expect(kinds('doc-chrome').filter((k) => k === 'install')).toHaveLength(2)
  }, 40_000)

  test('with no other machine saved in herdr, says how to add one', async () => {
    expect(await machines([]).doctor()).toEqual(['No other machines saved in herdr (herdr machine add <ssh target> adds one).'])
  })
})

describe('the live link to a worker', () => {
  test('a chat it sends is kept and passed on, and a chat watched twice stays watched until both let go', async () => {
    const key = 'p:talk:web'
    const chat: Chat = { key, messages: [{ id: 'm1', who: 'agent', at: 1, text: 'Hello.' }] } as Chat
    const watches: string[][] = []
    const s = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname === '/api/ws') return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
        return Response.json({ machines: [{ machine: 'talk', status: 'idle' }], places: [], tasks: [] })
      },
      websocket: {
        message(ws, msg) {
          const m = JSON.parse(String(msg))
          if (m.type !== 'watch') return
          watches.push(m.chats)
          // the first watch is the link being made: the worker answers with a chat
          if (watches.length === 1) ws.send(JSON.stringify({ type: 'chat', chat }))
        },
      },
    })
    const m = machines(null)
    const seen: string[] = []
    m.on('chat', (k) => seen.push(`chat ${k}`))
    m.on('peerChat', (machine, k) => seen.push(`peerChat ${machine} ${k}`))
    try {
      const l = m.adopt('talk', `http://127.0.0.1:${s.port}/`)
      await until('the chat to come', () => !!m.chat(key))
      expect(m.chat(key)?.messages[0].text).toBe('Hello.')
      expect(seen).toEqual([`chat ${key}`, `peerChat talk ${key}`])
      expect(m.chat('p:nowhere:web')).toBeUndefined()

      // two listeners on the same chat (two voice calls): it stays watched while either listens
      const offA = m.subscribeChat(l, key, () => {})
      const offB = m.subscribeChat(l, key, () => {})
      expect(l.watching.chats).toEqual([key])
      offA()
      offA()
      expect(l.watching.chats).toEqual([key])
      offB()
      expect(l.watching.chats).toEqual([])
      await until('the worker to hear it', () => watches.length >= 3)
      expect(watches.at(-1)).toEqual([])
    } finally {
      s.stop(true)
    }
  })

  test('a worker that never got an address is replaced after three minutes without one', async () => {
    const m = machines(null)
    const now = Date.now
    let clock = now()
    Date.now = () => clock
    try {
      const l = m.adopt('no-address', '')
      const internals = m as unknown as { poll(l: Link): Promise<void>; start(l: Link): Promise<void> }
      let starts = 0
      let kills = 0
      let exit!: () => void
      internals.start = async () => {
        starts++
      }
      l.worker = { pid: -1, kill: () => void kills++, exited: new Promise<void>((r) => (exit = r)) }
      await internals.poll(l)
      expect(kills).toBe(0)
      clock += 180_001
      await internals.poll(l)
      expect(kills).toBe(1)
      exit()
      await until('a new start', () => starts === 1)
      expect(l.worker).toBeUndefined()
    } finally {
      Date.now = now
    }
  })

  test('a machine not reached within a minute of the start is shown out of reach, no longer connecting', async () => {
    const m = machines(null)
    // the minute passes at once: the link's own timer is caught as it is set
    const real = globalThis.setTimeout
    let minute: (() => void) | undefined
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (ms === 60_000) {
        minute = fn
        return real(() => {}, 0)
      }
      return real(fn, ms)
    }) as typeof setTimeout
    let l: Link
    try {
      l = m.adopt('late', 'http://127.0.0.1:1')
    } finally {
      globalThis.setTimeout = real
    }
    let snapshots = 0
    m.on('snapshot', () => snapshots++)
    await until('its first try to fail', () => l.down !== undefined && !l.polling)
    expect(m.rows()).toEqual([{ name: 'late', state: 'Connecting…' }])
    snapshots = 0
    minute!()
    expect(l.connecting).toBe(false)
    expect(snapshots).toBe(1)
    expect(m.rows()[0].state).toMatch(/^Can't reach since \d\d:\d\d$/)
  })
})
