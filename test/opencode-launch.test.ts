// Starting and resuming an OpenCode agent: its session is made (or kept) through OpenCode's API before the TUI starts on
// it, and the TUI gets --standalone, --session and --auto. A fake `opencode` script records each call and answers
// FAKE_OUT (SHEPHERDR_OPENCODE_BIN points at it); herdr.start is spied on, and a fixture database stands in for
// OpenCode's session table.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Spec } from '../server/live/agents.ts'
import { tmp } from './tmp.ts'

const { Agents } = await import('../server/live/agents.ts')
const { herdr } = await import('../server/live/herdr.ts')
const { writeJson, home } = await import('../server/store.ts')
const { opencodeLogPath } = await import('../server/live/opencode.ts')
const { opencodeList, setModels } = await import('../server/live/models.ts')

const MODEL = 'opencode/minimax-m3.1-flash-free'
const savedEnv: Record<string, string | undefined> = {}
const setEnv = (k: string, v: string | undefined) => {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k]
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

const dir = tmp('opencode-launch')
const bin = join(dir, 'fake-opencode')
const log = join(dir, 'fake-calls.jsonl')
const db = join(dir, 'opencode.db')

beforeAll(() => {
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      "import { appendFileSync } from 'node:fs'",
      'appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n")',
      'process.stdout.write(process.env.FAKE_OUT ?? "")',
      'process.stderr.write(process.env.FAKE_ERR ?? "")',
      'process.exit(Number(process.env.FAKE_CODE ?? 0))',
      '',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  // a folder with one session of its own (the newest there), and a session of another folder
  const d = new Database(db, { create: true })
  d.run('CREATE TABLE session_v2 (id text primary key, directory text, parent_id text, time_archived integer, time_updated integer)')
  d.run('CREATE TABLE session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)')
  d.run('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)', ['ses_found', join(dir, 'found'), null, null, Date.now()])
  d.run('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)', ['ses_known', join(dir, 'known'), null, null, 1])
  d.run('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)', ['ses_found-1', 'ses_found', 'user', 1, 1, 1, JSON.stringify({ text: 'hello', files: [] })])
  d.run('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)', ['ses_known-1', 'ses_known', 'user', 1, 1, 1, JSON.stringify({ text: 'known', files: [] })])
  d.close()
  setEnv('SHEPHERDR_OPENCODE_BIN', bin)
  setEnv('SHEPHERDR_OPENCODE_DB', db)
  setEnv('FAKE_LOG', log)
  setEnv('FAKE_OUT', JSON.stringify({ data: { id: 'ses_fake1' } }))
  setEnv('FAKE_CODE', '0')
  setModels('opencode', opencodeList([{ id: MODEL, label: 'MiniMax', efforts: ['low', 'high'] }]))
})

afterAll(() => {
  setModels('opencode', undefined)
  for (const k of Object.keys(savedEnv)) setEnv(k, savedEnv[k])
  rmSync(dir, { recursive: true, force: true })
})

/** every call the fake opencode got since the last reset */
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; cwd: string }) : [])
const reset = () => {
  writeFileSync(log, '')
  setEnv('FAKE_OUT', JSON.stringify({ data: { id: 'ses_fake1' } }))
  setEnv('FAKE_CODE', '0')
}
const isPut = (c: { argv: string[] }) => c.argv[2] === 'experimental.session.instructions.entry.put'
const isCreate = (c: { argv: string[] }) => c.argv[2] === 'session.create'
const isSwitch = (c: { argv: string[] }) => c.argv[2] === 'session.switchModel'

/** an Agents server that starts nothing real: herdr.start is the spy's, refresh and routing are no-ops, and what is
 *  queued is kept for the test to read */
function harness(records: Record<string, unknown> = {}) {
  // what the server reads back at its start: each test's own records, none of the test before
  writeJson('agents.json', records)
  const a = new Agents()
  const queued: string[][] = []
  Object.assign(a, {
    refresh: async () => undefined,
    bindRoute: async () => undefined,
    queue: (_key: string, texts: string[]) => queued.push(texts),
  })
  return { a, queued }
}

const cwd = join(dir, 'app')
const key = 'OC-1/Agent'
const base = (o: Partial<Spec> = {}): Spec => ({
  key,
  name: 'shep-oc-test',
  kind: 'opencode',
  cwd,
  workspace: 'test',
  access: 'full',
  pane: async () => 'fake-pane',
  ...o,
}) as Spec

describe('starting an OpenCode agent', () => {
  test('a fresh start creates its session with the folder, title, model and variant, puts its instructions in, and starts the TUI on it', async () => {
    reset()
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    const h = harness()
    try {
      await h.a.ensure(base({ model: MODEL, effort: 'high', system: 'Be brief.', first: 'first' }))
      const [create, put] = calls()
      expect(create.argv.slice(0, 3)).toEqual(['api', '--standalone', 'session.create'])
      expect(create.cwd).toBe(cwd)
      expect(JSON.parse(create.argv[4])).toEqual({ title: 'shep-oc-test', location: { directory: cwd }, model: { providerID: 'opencode', id: 'minimax-m3.1-flash-free', variant: 'high' } })
      expect(put.argv.slice(2, 7)).toEqual(['experimental.session.instructions.entry.put', '--param', 'sessionID=ses_fake1', '--param', 'key=shepherdr'])
      expect(JSON.parse(put.argv[8])).toEqual({ value: 'Be brief.' })
      expect(start).toHaveBeenCalledTimes(1)
      const [name, kind, pane, args] = start.mock.calls[0] as unknown as [string, string, string, string[]]
      expect([name, kind, pane]).toEqual(['shep-oc-test', 'opencode', 'fake-pane'])
      expect(args).toEqual(['--standalone', '--session', 'ses_fake1', '--auto'])
      const r = h.a.record(key)!
      expect(r.sessionId).toBe('ses_fake1')
      expect(r.logs).toEqual([opencodeLogPath(home(), 'ses_fake1')])
      expect(h.queued).toEqual([['first']])
    } finally {
      h.a.stop()
      start.mockRestore()
      timer.mockRestore()
    }
  })

  test('access ask: no --auto, and the session asks before editing, running a shell, fetching, leaving the folder or using a subagent', async () => {
    reset()
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    const h = harness()
    try {
      await h.a.ensure(base({ access: 'ask', first: 'first' }))
      const [create] = calls()
      const body = JSON.parse(create.argv[4])
      expect(body.model).toBeUndefined()
      expect(body.permissions).toEqual(['edit', 'shell', 'webfetch', 'external_directory', 'subagent'].map((action) => ({ action, resource: '*', effect: 'ask' })))
      expect((start.mock.calls[0] as unknown as unknown[])[3]).toEqual(['--standalone', '--session', 'ses_fake1'])
      expect(calls().some(isPut)).toBe(false)
    } finally {
      h.a.stop()
      start.mockRestore()
      timer.mockRestore()
    }
  })

  test('a session that cannot be created fails the launch, and its record keeps why', async () => {
    reset()
    setEnv('FAKE_CODE', '1')
    setEnv('FAKE_ERR', 'no database here')
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const h = harness()
    try {
      await expect(h.a.ensure(base({ model: MODEL }))).rejects.toThrow(/session\.create exited with 1: no database here/)
      expect(start).not.toHaveBeenCalled()
      expect(h.a.record(key)?.startError).toMatch(/session\.create exited with 1/)
    } finally {
      h.a.stop()
      start.mockRestore()
      setEnv('FAKE_ERR', undefined)
      setEnv('FAKE_CODE', '0')
    }
  })

  test('a session id that is not an OpenCode one fails the launch', async () => {
    reset()
    setEnv('FAKE_OUT', JSON.stringify({ data: { id: 'not-a-session' } }))
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const h = harness()
    try {
      await expect(h.a.ensure(base({ model: MODEL }))).rejects.toThrow(/gave no session id/)
      expect(start).not.toHaveBeenCalled()
    } finally {
      h.a.stop()
      start.mockRestore()
      setEnv('FAKE_OUT', JSON.stringify({ data: { id: 'ses_fake1' } }))
    }
  })
})

describe('resuming an OpenCode agent', () => {
  const old = (o: Record<string, unknown> = {}) => ({
    key,
    name: 'shep-oc-test',
    kind: 'opencode',
    cwd,
    workspace: 'test',
    logs: [opencodeLogPath(home(), 'ses_old')],
    sessionId: 'ses_old',
    started: 0,
    access: 'full',
    model: MODEL,
    effort: 'low',
    system: 'Old rule.',
    ...o,
  })

  test('keeps its session: no new one, the model switched, the instructions left alone when unchanged', async () => {
    reset()
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    const h = harness({ [key]: old() })
    try {
      await h.a.ensure(base({ model: MODEL, effort: 'high', system: 'Old rule.', first: 'Go on.' }))
      expect(calls().some(isCreate)).toBe(false)
      expect(calls().some(isPut)).toBe(false)
      const [sw] = calls()
      expect(isSwitch(sw)).toBe(true)
      expect(sw.argv.slice(3, 5)).toEqual(['--param', 'sessionID=ses_old'])
      expect(JSON.parse(sw.argv[6])).toEqual({ model: { providerID: 'opencode', id: 'minimax-m3.1-flash-free', variant: 'high' } })
      expect((start.mock.calls[0] as unknown as unknown[])[3]).toEqual(['--standalone', '--session', 'ses_old', '--auto'])
      expect(h.queued).toEqual([['Go on.']])
    } finally {
      h.a.stop()
      start.mockRestore()
      timer.mockRestore()
    }
  })

  test('puts its instructions in again only when the prompt changed', async () => {
    reset()
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    try {
      const h = harness({ [key]: old() })
      await h.a.ensure(base({ model: MODEL, effort: 'low', system: 'New rule.', first: 'Go on.' }))
      h.a.stop()
      const puts = calls().filter(isPut)
      expect(puts.length).toBe(1)
      expect(puts[0].argv.slice(4, 5)).toEqual(['sessionID=ses_old'])
      expect(JSON.parse(puts[0].argv[8])).toEqual({ value: 'New rule.' })
      expect(calls().some(isCreate)).toBe(false)
    } finally {
      start.mockRestore()
      timer.mockRestore()
    }
  })

  test('no model set: nothing is switched', async () => {
    reset()
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    const h = harness({ [key]: old({ model: undefined, effort: undefined }) })
    try {
      await h.a.ensure(base({ system: 'Old rule.' }))
      expect(calls().some(isSwitch)).toBe(false)
      expect(start).toHaveBeenCalledTimes(1)
    } finally {
      h.a.stop()
      start.mockRestore()
      timer.mockRestore()
    }
  })

  test('a failing model switch or instructions update is logged, and the launch goes on', async () => {
    reset()
    setEnv('FAKE_CODE', '1')
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    const err = spyOn(console, 'error').mockImplementation(() => undefined)
    const h = harness({ [key]: old() })
    try {
      await h.a.ensure(base({ model: MODEL, effort: 'high', system: 'New rule.' }))
      expect(err.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringMatching(/shep-oc-test could not switch its model: opencode api session\.switchModel exited with 1/),
        expect.stringMatching(/shep-oc-test could not update its instructions: opencode api experimental\.session\.instructions\.entry\.put exited with 1/),
      ])
      expect(start).toHaveBeenCalledTimes(1)
      expect((start.mock.calls[0] as unknown as unknown[])[3]).toEqual(['--standalone', '--session', 'ses_old', '--auto'])
    } finally {
      h.a.stop()
      err.mockRestore()
      start.mockRestore()
      timer.mockRestore()
      setEnv('FAKE_CODE', '0')
    }
  })

  test('a record with its log but no session id starts a new session', async () => {
    reset()
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    const h = harness({ [key]: old({ sessionId: undefined }) })
    try {
      await h.a.ensure(base({ model: MODEL, system: 'Old rule.' }))
      expect(calls().filter(isCreate).length).toBe(1)
      expect((start.mock.calls[0] as unknown as unknown[])[3]).toEqual(['--standalone', '--session', 'ses_fake1', '--auto'])
      expect(h.a.record(key)?.sessionId).toBe('ses_fake1')
    } finally {
      h.a.stop()
      start.mockRestore()
      timer.mockRestore()
    }
  })
})

describe('reading an OpenCode agent\'s log', () => {
  test('discoverLog of a session it has: its mirror; without one, the newest session of its folder', () => {
    const h = harness()
    try {
      h.a.adopt('OC-2/Agent', { name: 'shep-oc-known', cwd: join(dir, 'known') } as never, 'opencode', 'test')
      const known = h.a.record('OC-2/Agent')!
      known.sessionId = 'ses_known'
      h.a.discoverLog('OC-2/Agent')
      expect(known.logs).toEqual([opencodeLogPath(home(), 'ses_known')])
      expect(readFileSync(opencodeLogPath(home(), 'ses_known'), 'utf8')).toContain('known')

      h.a.adopt('OC-3/Agent', { name: 'shep-oc-found', cwd: join(dir, 'found') } as never, 'opencode', 'test')
      const found = h.a.record('OC-3/Agent')!
      found.started = 0
      h.a.discoverLog('OC-3/Agent')
      expect(found.logs).toEqual([opencodeLogPath(home(), 'ses_found')])
    } finally {
      h.a.stop()
    }
  })

  test('a mirror that cannot be read is logged, and the log path is still kept', () => {
    const broken = join(dir, 'broken.db')
    writeFileSync(broken, 'not a database')
    setEnv('SHEPHERDR_OPENCODE_DB', broken)
    const err = spyOn(console, 'error').mockImplementation(() => undefined)
    const h = harness()
    try {
      h.a.adopt('OC-4/Agent', { name: 'shep-oc-broken', cwd: join(dir, 'known') } as never, 'opencode', 'test')
      h.a.record('OC-4/Agent')!.sessionId = 'ses_known'
      h.a.discoverLog('OC-4/Agent')
      expect(h.a.record('OC-4/Agent')!.logs).toEqual([opencodeLogPath(home(), 'ses_known')])
      expect(err.mock.calls.some((c) => /could not mirror OpenCode session ses_known/.test(String(c[0])))).toBe(true)
    } finally {
      h.a.stop()
      err.mockRestore()
      setEnv('SHEPHERDR_OPENCODE_DB', db)
    }
  })

  test('follow takes the session id of the mirrored log for OpenCode, not a uuid', () => {
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn()
      return 0
    }) as never)
    const h = harness()
    try {
      h.a.adopt('OC-5/Agent', { name: 'shep-oc-follow', cwd: join(dir, 'found') } as never, 'opencode', 'test')
      const r = h.a.record('OC-5/Agent')!
      r.sessionId = 'ses_before'
      h.a.follow('OC-5/Agent', Date.now() - 60_000)
      expect(r.sessionId).toBe('ses_found')
      expect(r.logs).toEqual([opencodeLogPath(home(), 'ses_found')])
    } finally {
      h.a.stop()
      timer.mockRestore()
    }
  })

  test('herdr\'s report of an OpenCode session path is never followed', () => {
    const h = harness()
    try {
      h.a.adopt('OC-6/Agent', { name: 'shep-oc-herdr', cwd: join(dir, 'found') } as never, 'opencode', 'test')
      const r = h.a.record('OC-6/Agent')!
      r.sessionId = 'ses_mine'
      h.a['learnSession']('OC-6/Agent', { name: 'shep-oc-herdr', agent_session: { kind: 'path', value: '/elsewhere/ses_other.jsonl' } } as never)
      expect(r.logs).toEqual([])
      expect(r.sessionId).toBe('ses_mine')
    } finally {
      h.a.stop()
    }
  })
})
