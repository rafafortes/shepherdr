// OpenCode's local API client and session mirror: a fixture database (bun:sqlite, OpenCode's session_message table),
// and a fake `opencode` script that records its argv and prints canned JSON (SHEPHERDR_OPENCODE_BIN points at it).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { api, createSession, defaultModel, listModels, mirrorSession, opencodeDb, opencodeLogPath, parseModel, putInstructions, switchModel } from '../server/live/opencode.ts'
import { tmp } from './tmp.ts'

let dir = ''
let db = ''
const saved: Record<string, string | undefined> = {}
const setEnv = (k: string, v: string | undefined) => {
  if (!(k in saved)) saved[k] = process.env[k]
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
afterAll(() => {
  for (const k of Object.keys(saved)) setEnv(k, saved[k])
  rmSync(dir, { recursive: true, force: true })
})

/* ---------- fixture database ---------- */

const row = (sid: string, seq: number, type: string, data: object, id = `${sid}-${seq}`) => ({ id, sid, seq, type, data: JSON.stringify(data) })
const done = (created: number) => ({ created, completed: created + 5 })

function fixtureRows() {
  return [
    row('ses_A', 1, 'user', { time: { created: 100 }, text: 'What is the project word? One word.', files: [] }),
    row('ses_A', 2, 'system', { metadata: { notice: 'instructions' }, text: '<context key="shepherdr">be brief</context>', description: 'x' }),
    row('ses_A', 3, 'assistant', {
      time: done(110), agent: 'build', model: { id: 'm1', providerID: 'opencode', variant: 'high' },
      content: [{ type: 'reasoning', text: 'think' }, { type: 'tool', name: 'read' }], finish: 'tool-calls', rawFinish: 'tool-calls', cost: 0,
      tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
    }),
    row('ses_A', 4, 'assistant', {
      time: done(120), agent: 'build', model: { id: 'm1', providerID: 'opencode', variant: 'high' },
      content: [{ type: 'text', text: 'HERON' }], finish: 'stop', rawFinish: 'stop', cost: 0.5, tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    row('ses_A', 5, 'user', { time: { created: 130 }, text: 'second', files: [] }),
    // still streaming: the mirror stops here
    row('ses_A', 6, 'assistant', { time: { created: 140, streamed: 141 }, content: [{ type: 'text', text: 'Hal' }], finish: null }),
    row('ses_A', 7, 'assistant', { time: done(150), content: [{ type: 'text', text: 'after' }], finish: 'stop' }),
    row('ses_A', 8, 'idle', { time: { created: 160 }, outcome: 'succeeded' }),
    row('ses_B', 1, 'user', { time: { created: 100 }, text: 'other session', files: [] }),
    row('ses_B', 2, 'assistant', { time: done(110), content: [{ type: 'text', text: 'B says' }], finish: 'stop' }),
  ]
}

function writeFixture(file: string, rows: ReturnType<typeof fixtureRows>) {
  const d = new Database(file, { create: true })
  d.run('CREATE TABLE session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)')
  const ins = d.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (const r of rows) ins.run(r.id, r.sid, r.type, r.seq, 1, 1, r.data)
  d.close()
}

beforeAll(() => {
  dir = tmp('opencode')
  db = join(dir, 'opencode.db')
  writeFixture(db, fixtureRows())
  setEnv('SHEPHERDR_OPENCODE_DB', db)
})

const seqs = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).seq)

describe('session mirror', () => {
  test('copies the final rows in seq order and stops at the first streaming reply', () => {
    const out = join(dir, 'mirror', 'a.jsonl')
    expect(mirrorSession('ses_A', out)).toBe(5)
    expect(seqs(out)).toEqual([1, 2, 3, 4, 5])
    const first = JSON.parse(readFileSync(out, 'utf8').split('\n')[0])
    expect(first).toEqual({ id: 'ses_A-1', type: 'user', seq: 1, time: 1, data: { time: { created: 100 }, text: 'What is the project word? One word.', files: [] } })
    // nothing new while the reply still streams
    expect(mirrorSession('ses_A', out)).toBe(0)
    expect(seqs(out)).toEqual([1, 2, 3, 4, 5])
  })

  test('a second call after the reply completed appends only the new rows', () => {
    const out = join(dir, 'mirror', 'a.jsonl')
    const before = readFileSync(out, 'utf8')
    const d = new Database(db)
    d.run('UPDATE session_message SET data = ? WHERE id = ?', [JSON.stringify({ time: { created: 140, completed: 145 }, content: [{ type: 'text', text: 'Hallo' }], finish: 'stop' }), 'ses_A-6'])
    d.close()
    expect(mirrorSession('ses_A', out)).toBe(3)
    expect(readFileSync(out, 'utf8').startsWith(before)).toBe(true)
    expect(seqs(out)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(readFileSync(out, 'utf8')).not.toContain('B says')
  })

  test('another session\'s rows never appear in this one', () => {
    const out = join(dir, 'mirror', 'b.jsonl')
    expect(mirrorSession('ses_B', out)).toBe(2)
    const text = readFileSync(out, 'utf8')
    expect(text).toContain('B says')
    expect(text).not.toContain('HERON')
    expect(seqs(out)).toEqual([1, 2])
  })

  test('a session with no rows writes nothing, and creates no folder for them', () => {
    const out = join(dir, 'mirror', 'none', 'x.jsonl')
    expect(mirrorSession('ses_missing', out)).toBe(0)
    expect(existsSync(out)).toBe(false)
  })

  test('an empty log file is read from the start', () => {
    const out = join(dir, 'mirror', 'empty.jsonl')
    writeFileSync(out, '')
    expect(mirrorSession('ses_B', out)).toBe(2)
  })

  test('the last line is found in a log longer than one read', () => {
    const big = join(dir, 'big.db')
    writeFixture(big, [row('ses_C', 1, 'user', { text: 'x'.repeat(200_000) }), row('ses_C', 2, 'user', { text: 'small' })])
    const out = join(dir, 'mirror', 'c.jsonl')
    expect(mirrorSession('ses_C', out, big)).toBe(2)
    expect(mirrorSession('ses_C', out, big)).toBe(0)
  })

  test('a log whose last line is not JSON stops the mirror with a clear error', () => {
    const out = join(dir, 'mirror', 'broken.jsonl')
    writeFileSync(out, 'not json\n')
    expect(() => mirrorSession('ses_B', out)).toThrow(/ends in a line that is not JSON/)
  })

  test('no database: 0 and nothing created', () => {
    const out = join(dir, 'mirror', 'nodb', 'a.jsonl')
    expect(mirrorSession('ses_A', out, join(dir, 'nope.db'))).toBe(0)
    expect(existsSync(join(dir, 'mirror', 'nodb'))).toBe(false)
  })

  test('opencodeLogPath is <home>/opencode/<session>.jsonl', () => {
    expect(opencodeLogPath('/h/.shepherdr', 'ses_1')).toBe(join('/h/.shepherdr', 'opencode', 'ses_1.jsonl'))
  })
})

describe('database location and model ids', () => {
  test('opencodeDb: the override, then XDG_DATA_HOME, then ~/.local/share', () => {
    setEnv('SHEPHERDR_OPENCODE_DB', '/x/y.db')
    expect(opencodeDb()).toBe('/x/y.db')
    setEnv('SHEPHERDR_OPENCODE_DB', undefined)
    setEnv('XDG_DATA_HOME', '/xdg')
    expect(opencodeDb()).toBe(join('/xdg', 'opencode', 'opencode.db'))
    setEnv('XDG_DATA_HOME', undefined)
    expect(opencodeDb()).toBe(join(process.env.HOME ?? '', '.local', 'share', 'opencode', 'opencode.db'))
    setEnv('SHEPHERDR_OPENCODE_DB', db)
  })

  test('parseModel splits at the first slash', () => {
    expect(parseModel('opencode/minimax-m3.1-flash-free')).toEqual({ providerID: 'opencode', id: 'minimax-m3.1-flash-free' })
    expect(parseModel('nvidia/z-ai/glm-5.3-flash')).toEqual({ providerID: 'nvidia', id: 'z-ai/glm-5.3-flash' })
  })

  test('parseModel refuses an id without a provider or a model', () => {
    expect(() => parseModel('glm')).toThrow(/not an OpenCode model id/)
    expect(() => parseModel('/glm')).toThrow(/not an OpenCode model id/)
    expect(() => parseModel('opencode/')).toThrow(/not an OpenCode model id/)
  })
})

/* ---------- the API client, against a fake opencode ---------- */

let bin = ''
let log = ''
let fakeN = 0
let app = ''

beforeAll(() => {
  app = join(dir, 'app')
  mkdirSync(app, { recursive: true })
  bin = join(dir, 'fake-opencode')
  log = join(dir, 'fake-calls.jsonl')
  // a script run by this bun: records its argv and cwd, then answers with FAKE_OUT, FAKE_ERR and FAKE_CODE (env)
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      "import { appendFileSync } from 'node:fs'",
      'appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n")',
      'if (process.env.FAKE_SLEEP) await Bun.sleep(Number(process.env.FAKE_SLEEP))',
      'process.stdout.write(process.env.FAKE_OUT ?? "")',
      'process.stderr.write(process.env.FAKE_ERR ?? "")',
      'process.exit(Number(process.env.FAKE_CODE ?? 0))',
      '',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  setEnv('SHEPHERDR_OPENCODE_BIN', bin)
  setEnv('FAKE_LOG', log)
})

/** the next answer of the fake: its stdout (a JSON value is printed as {"data": value}) */
function answer(data: unknown, opts: { code?: number; err?: string; raw?: string; sleep?: number } = {}) {
  setEnv('FAKE_OUT', opts.raw ?? JSON.stringify({ data }))
  setEnv('FAKE_ERR', opts.err ?? '')
  setEnv('FAKE_CODE', String(opts.code ?? 0))
  setEnv('FAKE_SLEEP', opts.sleep === undefined ? undefined : String(opts.sleep))
}

/** the calls the fake got since the last reset: argv and cwd */
function calls(): { argv: string[]; cwd: string }[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
function reset() {
  rmSync(log, { force: true })
  fakeN++
}

describe('opencode api client', () => {
  test('api runs `opencode api <operation>` in the folder and returns the data of its answer', async () => {
    reset()
    answer({ hello: 'world' })
    expect(await api(['some.op', '--param', 'a=b'], { cwd: app })).toEqual({ hello: 'world' })
    expect(calls()).toEqual([{ argv: ['api', '--standalone', 'some.op', '--param', 'a=b'], cwd: app }])
  })

  test('a non-zero exit is an error with the CLI\'s stderr', async () => {
    answer(null, { code: 3, err: 'service down\n' })
    await expect(api(['x.y'], { cwd: dir })).rejects.toThrow('opencode api x.y exited with 3: service down')
  })

  test('a non-zero exit without stderr says what it printed', async () => {
    answer(null, { code: 2, err: '', raw: 'bad news' })
    await expect(api(['x.y'], { cwd: dir })).rejects.toThrow('exited with 2: bad news')
  })

  test('output that is not JSON is an error with the stderr', async () => {
    answer(null, { raw: 'not json', err: 'warn: slow' })
    await expect(api(['x.y'], { cwd: dir })).rejects.toThrow('opencode api x.y printed no JSON: warn: slow')
  })

  test('output that is not JSON without stderr says what it printed', async () => {
    answer(null, { raw: 'plain text' })
    await expect(api(['x.y'], { cwd: dir })).rejects.toThrow('printed no JSON: plain text')
  })

  test('exit 0 with no output is an answer with no data, not an error', async () => {
    answer(null, { raw: '' })
    expect(await api(['x.y'], { cwd: dir })).toBeUndefined()
    answer(null, { raw: ' \n\t\n' })
    expect(await api(['x.y'], { cwd: dir })).toBeUndefined()
  })

  test('exit 0 with no output and a warning on stderr is still no data', async () => {
    answer(null, { raw: '', err: 'warn: nothing to return\n' })
    expect(await api(['x.y'], { cwd: dir })).toBeUndefined()
  })

  test('putInstructions and switchModel resolve when OpenCode prints nothing', async () => {
    reset()
    answer(null, { raw: '' })
    await expect(putInstructions('ses_9', 'be brief', app)).resolves.toBeUndefined()
    await expect(switchModel('ses_9', 'opencode/minimax-m3.1-flash-free', 'high', app)).resolves.toBeUndefined()
    expect(calls().map((c) => c.argv[2])).toEqual(['experimental.session.instructions.entry.put', 'session.switchModel'])
  })

  test('an answer that does not come in time is an error', async () => {
    answer(null, { sleep: 5000 })
    await expect(api(['x.y'], { cwd: dir, timeoutMs: 300 })).rejects.toThrow('did not answer in 0.3 s')
  })

  test('a binary that cannot start is an error', async () => {
    setEnv('SHEPHERDR_OPENCODE_BIN', join(dir, 'missing-opencode'))
    await expect(api(['x.y'], { cwd: dir })).rejects.toThrow(/could not start/)
    setEnv('SHEPHERDR_OPENCODE_BIN', bin)
  })

  test('createSession sends the model split at its first slash, the effort as its variant, and the folder', async () => {
    reset()
    answer({ id: 'ses_e2ab579edffeA3epFVNN0uYn6Q' })
    const id = await createSession({ cwd: app, title: 'Build', model: 'opencode/minimax-m3.1-flash-free', effort: 'high' })
    expect(id).toBe('ses_e2ab579edffeA3epFVNN0uYn6Q')
    const [c] = calls()
    expect(c.argv.slice(0, 4)).toEqual(['api', '--standalone', 'session.create', '--data'])
    expect(JSON.parse(c.argv[4])).toEqual({
      title: 'Build',
      location: { directory: app },
      model: { providerID: 'opencode', id: 'minimax-m3.1-flash-free', variant: 'high' },
    })
    expect(c.argv).toHaveLength(5)
    expect(c.cwd).toBe(app)
  })

  test('createSession with ask puts the ask permissions in the body, and a model without effort has no variant', async () => {
    reset()
    answer({ id: 'ses_1' })
    await createSession({ cwd: app, title: 'Review', model: 'nvidia/z-ai/glm-5.3-flash', ask: true })
    const body = JSON.parse(calls()[0].argv[4])
    expect(body.model).toEqual({ providerID: 'nvidia', id: 'z-ai/glm-5.3-flash' })
    expect(body.permissions).toEqual(['edit', 'shell', 'webfetch', 'external_directory', 'subagent'].map((action) => ({ action, resource: '*', effect: 'ask' })))
  })

  test('createSession without a model or ask sends neither', async () => {
    reset()
    answer({ id: 'ses_2' })
    await createSession({ cwd: app, title: 'Plain' })
    expect(JSON.parse(calls()[0].argv[4])).toEqual({ title: 'Plain', location: { directory: app } })
  })

  test('createSession refuses an answer without a session id', async () => {
    answer({ id: 'abc' })
    await expect(createSession({ cwd: app, title: 'x' })).rejects.toThrow(/no session id/)
    answer({})
    await expect(createSession({ cwd: app, title: 'x' })).rejects.toThrow(/no session id: \{\}/)
  })

  test('putInstructions puts the text as the shepherdr entry of the session', async () => {
    reset()
    answer(true)
    await putInstructions('ses_9', 'Line one\n"quoted" text', app)
    expect(calls()[0].argv).toEqual([
      'api',
      '--standalone',
      'experimental.session.instructions.entry.put',
      '--param',
      'sessionID=ses_9',
      '--param',
      'key=shepherdr',
      '--data',
      JSON.stringify({ value: 'Line one\n"quoted" text' }),
    ])
  })

  test('switchModel sends the model with its variant, or without one', async () => {
    reset()
    answer(true)
    await switchModel('ses_9', 'opencode-go/deepseek-v4.1-flash', 'max', app)
    await switchModel('ses_9', 'opencode-go/deepseek-v4.1-flash', undefined, app)
    const [a, b] = calls().map((c) => c.argv)
    expect(a).toEqual(['api', '--standalone', 'session.switchModel', '--param', 'sessionID=ses_9', '--data', JSON.stringify({ model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'max' } })])
    expect(JSON.parse(b[6])).toEqual({ model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' } })
  })

  test('listModels keeps the enabled models as Shepherdr ids with their variants as efforts', async () => {
    reset()
    answer([
      { id: 'minimax-m3.1-flash-free', providerID: 'opencode', name: 'MiniMax M3.1 Flash', variants: [{ id: 'high' }, { id: 'none' }], enabled: true },
      { id: 'old', providerID: 'opencode', name: 'Old', variants: [], enabled: false },
      { id: 'z-ai/glm-5.3-flash', providerID: 'nvidia', name: 'GLM 5.3 Flash' },
    ])
    // named with the provider in front, as `opencode run -m` takes them, and grouped by provider (nvidia before opencode)
    expect(await listModels(app)).toEqual([
      { id: 'nvidia/z-ai/glm-5.3-flash', label: 'nvidia/z-ai/glm-5.3-flash', efforts: [] },
      { id: 'opencode/minimax-m3.1-flash-free', label: 'opencode/minimax-m3.1-flash-free', efforts: ['high', 'none'] },
    ])
    expect(calls()[0].argv).toEqual(['api', '--standalone', 'model.list'])
  })

  test("defaultModel is OpenCode's own default, as providerID/modelID; nothing when it has none or cannot say", async () => {
    reset()
    answer({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variants: [] })
    expect(await defaultModel(app)).toBe('opencode-go/deepseek-v4.1-flash')
    expect(calls()[0].argv).toEqual(['api', '--standalone', 'model.default'])
    answer(undefined, { raw: '' })
    expect(await defaultModel(app)).toBeUndefined()
    answer({ nope: true })
    expect(await defaultModel(app)).toBeUndefined()
    answer(undefined, { code: 1, err: 'no default' })
    expect(await defaultModel(app)).toBeUndefined()
  })

  test('listModels without a folder runs in the temp folder, and refuses an answer that is not a list', async () => {
    reset()
    answer([])
    expect(await listModels()).toEqual([])
    expect(calls()[0].cwd).toBe(tmpdir())
    answer({ nope: true })
    await expect(listModels(app)).rejects.toThrow('gave no model list')
  })
})
