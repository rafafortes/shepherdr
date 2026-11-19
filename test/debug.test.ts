// Swallowed parser errors: quiet by default, one gated line with the detail, and a count per reader for the doctor.
// Every CLI's reader is driven through a path that fails on purpose: the behaviour stays the same, only the logging
// changes. The error's message is never written, so a chat line or a secret in it cannot leak into the log.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resetSwallowed, swallow, swallowedReport } from '../server/live/debug.ts'
import { piEnabled } from '../server/live/models.ts'
import { claudeProjectDir, findClaudeLog, findCodexLog, findOpencodeLog, findPiLog } from '../server/live/readers/find.ts'
import { recorderScript } from '../server/live/readers/hooks.ts'
import { LogTail, readerFor } from '../server/live/readers/index.ts'
import { opencodeLogPath } from '../server/live/opencode.ts'
import { home } from '../server/store.ts'
import { tmp } from './tmp.ts'

/** point a CLI's home at this test's own folder, and put it back afterwards */
function env(name: string, value: string) {
  const saved = process.env[name]
  process.env[name] = value
  return () => {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  }
}

const day = (root: string, t: number, utc: boolean) => {
  const d = new Date(t)
  const y = utc ? d.getUTCFullYear() : d.getFullYear()
  const m = utc ? d.getUTCMonth() + 1 : d.getMonth() + 1
  const dd = utc ? d.getUTCDate() : d.getDate()
  return join(root, 'sessions', String(y), String(m).padStart(2, '0'), String(dd).padStart(2, '0'))
}

describe('swallow', () => {
  let savedDebug: string | undefined
  let logged: string[]
  let stderr: typeof console.error

  beforeEach(() => {
    savedDebug = process.env.SHEPHERDR_DEBUG
    delete process.env.SHEPHERDR_DEBUG
    resetSwallowed()
    logged = []
    stderr = console.error
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(' '))
  })

  afterEach(() => {
    console.error = stderr
    if (savedDebug === undefined) delete process.env.SHEPHERDR_DEBUG
    else process.env.SHEPHERDR_DEBUG = savedDebug
  })

  test('quiet by default, still counted', () => {
    swallow('pi settings parse', new Error('secret token in a chat line'), 'pi', '/home/u/.pi/settings.json')
    expect(logged).toEqual([])
    expect(swallowedReport()).toHaveLength(1)
  })

  test('with the gate set, one line names the reason, the error kind and the file name only', () => {
    process.env.SHEPHERDR_DEBUG = '1'
    swallow('pi settings parse', new SyntaxError('secret token in a chat line'), 'pi', '/home/u/.pi/settings.json')
    expect(logged).toEqual(['shepherdr: pi settings parse ignored: SyntaxError (settings.json)'])
    expect(logged.join(' ')).not.toContain('secret')
  })

  test('a thrown value that is not an error is named by its type', () => {
    process.env.SHEPHERDR_DEBUG = '1'
    swallow('strange throw', 'nope', 'codex')
    expect(logged).toEqual(['shepherdr: strange throw ignored: string'])
  })

  test('the doctor says one line per reader that ignored something, and none when they did not', () => {
    expect(swallowedReport()).toEqual([])
    swallow('x', new Error('x'), 'pi')
    swallow('x', new Error('x'), 'pi')
    swallow('x', new Error('x'), 'claude')
    expect(swallowedReport()).toEqual([
      'The claude reader ignored 1 line it could not read since this server started; set SHEPHERDR_DEBUG=1 to log each one.',
      'The pi reader ignored 2 lines it could not read since this server started; set SHEPHERDR_DEBUG=1 to log each one.',
    ])
    resetSwallowed()
    expect(swallowedReport()).toEqual([])
  })

  test("pi's settings the reader cannot parse: silent without the gate, one line with it", () => {
    const dir = tmp('debug-pi-settings')
    const restore = env('PI_CODING_AGENT_DIR', dir)
    const file = join(dir, 'settings.json')
    try {
      writeFileSync(file, '{ not json')
      expect(piEnabled()).toBeUndefined()
      expect(logged).toEqual([])
      const at = statSync(file).mtimeMs
      utimesSync(file, new Date(at + 2000), new Date(at + 2000))
      process.env.SHEPHERDR_DEBUG = '1'
      expect(piEnabled()).toBeUndefined()
      expect(logged).toEqual(['shepherdr: pi settings parse ignored: SyntaxError (settings.json)'])
      expect(swallowedReport()).toEqual(['The pi reader ignored 2 lines it could not read since this server started; set SHEPHERDR_DEBUG=1 to log each one.'])
    } finally {
      restore()
    }
  })

  test('pi settings that cannot be stated at all are counted too', () => {
    const restore = env('PI_CODING_AGENT_DIR', tmp('debug-pi-missing'))
    try {
      expect(piEnabled()).toBeUndefined()
      expect(logged).toEqual([])
      expect(swallowedReport()).toEqual(['The pi reader ignored 1 line it could not read since this server started; set SHEPHERDR_DEBUG=1 to log each one.'])
    } finally {
      restore()
    }
  })

  test('a Claude log that vanishes between listing and stat is counted for claude', () => {
    const root = tmp('debug-claude-log')
    const dir = join(root, 'projects', '-any-cwd')
    mkdirSync(dir, { recursive: true })
    symlinkSync(join(root, 'gone'), join(dir, 'gone.jsonl'))
    const restore = env('CLAUDE_CONFIG_DIR', root)
    try {
      process.env.SHEPHERDR_DEBUG = '1'
      expect(findClaudeLog('/any/cwd')).toBeUndefined()
      expect(logged).toEqual(['shepherdr: log stat ignored: Error (gone.jsonl)'])
      expect(swallowedReport()[0]).toContain('The claude reader ignored 1 line')
    } finally {
      restore()
    }
  })

  test('an unreadable Claude projects folder is counted for claude, without changing the path it returns', () => {
    const root = tmp('debug-claude-projects')
    const restore = env('CLAUDE_CONFIG_DIR', root)
    try {
      process.env.SHEPHERDR_DEBUG = '1'
      expect(claudeProjectDir('x'.repeat(201))).toBe(join(root, 'projects', 'x'.repeat(201)))
      expect(logged).toEqual([`shepherdr: claude project dirs ignored: Error (projects)`])
    } finally {
      restore()
    }
  })

  test('a pi log that vanishes between listing and stat is counted for pi', () => {
    const root = tmp('debug-pi-log')
    const dir = join(root, 'sessions', '--any-cwd--')
    mkdirSync(dir, { recursive: true })
    symlinkSync(join(root, 'gone'), join(dir, 'gone.jsonl'))
    const restore = env('PI_CODING_AGENT_DIR', root)
    try {
      process.env.SHEPHERDR_DEBUG = '1'
      expect(findPiLog('/any/cwd')).toBeUndefined()
      expect(logged).toEqual(['shepherdr: log stat ignored: Error (gone.jsonl)'])
      expect(swallowedReport()[0]).toContain('The pi reader ignored 1 line')
    } finally {
      restore()
    }
  })

  test('a Codex rollout that vanishes between listing and stat is counted for codex', () => {
    const root = tmp('debug-codex-log')
    const dirs = new Set<string>()
    for (const t of [Date.now(), Date.now() - 86_400_000])
      for (const utc of [false, true]) dirs.add(day(root, t, utc))
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true })
      symlinkSync(join(root, 'gone'), join(dir, 'rollout-gone.jsonl'))
    }
    const restore = env('CODEX_HOME', root)
    try {
      process.env.SHEPHERDR_DEBUG = '1'
      expect(findCodexLog('/any/cwd')).toBeUndefined()
      expect(logged).toContain('shepherdr: codex log stat ignored: Error (rollout-gone.jsonl)')
      expect(swallowedReport()[0]).toContain('The codex reader ignored')
    } finally {
      restore()
    }
  })

  /** a database whose one message is not JSON: the session is found, the mirror throws */
  function brokenOpencodeDb(dir: string) {
    const db = join(dir, 'opencode.db')
    const d = new Database(db, { create: true })
    d.run('CREATE TABLE session_v2 (id text primary key, directory text, parent_id text, time_archived integer, time_updated integer)')
    d.run('CREATE TABLE session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)')
    d.run("INSERT INTO session_v2 VALUES ('ses_bad', '/w/x', NULL, NULL, 5)")
    d.run("INSERT INTO session_message VALUES ('m', 'ses_bad', 'user', 1, 1, 1, 'not json')")
    d.close()
    return db
  }

  test('an OpenCode session that cannot be mirrored is counted for opencode, with its log path kept', () => {
    const dir = tmp('debug-opencode-log')
    const restore = env('SHEPHERDR_OPENCODE_DB', brokenOpencodeDb(dir))
    try {
      process.env.SHEPHERDR_DEBUG = '1'
      expect(findOpencodeLog('/w/x')).toBe(opencodeLogPath(home(), 'ses_bad'))
      expect(logged).toContain('shepherdr: opencode log mirror ignored: SyntaxError (ses_bad.jsonl)')
      expect(swallowedReport()[0]).toContain('The opencode reader ignored 1 line')
    } finally {
      restore()
    }
  })

  test('a tail whose OpenCode or agy mirror throws still reads without a throw, and says why under the gate', () => {
    const dir = tmp('debug-refresh')
    const restoreDb = env('SHEPHERDR_OPENCODE_DB', brokenOpencodeDb(dir))
    const agy = tmp('debug-agy-home')
    mkdirSync(join(agy, 'conversations'), { recursive: true })
    writeFileSync(join(agy, 'conversations', 'ses_bad.db'), 'not a database')
    const restoreAgy = env('SHEPHERDR_AGY_HOME', agy)
    try {
      const opencode = new LogTail(opencodeLogPath(home(), 'ses_bad'), readerFor('opencode')!)
      const agyTail = new LogTail(join(agy, 'logs', 'ses_bad.jsonl'), readerFor('agy')!)
      expect(opencode.read()).toEqual([])
      expect(agyTail.read()).toEqual([])
      expect(logged).toEqual([])
      process.env.SHEPHERDR_DEBUG = '1'
      expect(opencode.read()).toEqual([])
      expect(agyTail.read()).toEqual([])
      expect(logged).toContain('shepherdr: opencode log refresh ignored: SyntaxError (ses_bad.jsonl)')
      expect(logged).toContain('shepherdr: agy log refresh ignored: SQLiteError (ses_bad.jsonl)')
      expect(swallowedReport().join('\n')).toContain('The agy reader ignored 2 lines')
      expect(swallowedReport().join('\n')).toContain('The opencode reader ignored 2 lines')
    } finally {
      restoreDb()
      restoreAgy()
    }
  })
})

describe('the hook recorder', () => {
  test('its own gated line names the reason without the event text', async () => {
    const script = recorderScript()
    expect(script).toContain("if (process.env.SHEPHERDR_DEBUG) console.error")
    expect(script).toContain("note('hook event parse', e)")
    expect(script).toContain("note('hook log rotate', e)")
    const dir = tmp('debug-recorder')
    writeFileSync(join(dir, 'record.cjs'), script)
    const run = async (debug: boolean) => {
      const child = Bun.spawn([process.execPath, join(dir, 'record.cjs'), join(dir, 'events.jsonl')], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, SHEPHERDR_DEBUG: debug ? '1' : '' },
      })
      child.stdin.write('{ not json')
      child.stdin.end()
      const err = await new Response(child.stderr).text()
      await child.exited
      return err
    }
    expect(await run(false)).toBe('')
    expect(await run(true)).toBe('shepherdr: hook event parse ignored: SyntaxError\n')
  })
})
