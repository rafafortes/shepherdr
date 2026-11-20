// The one persistent log (server/live/server-log.ts): every line dated, the file bounded to one previous generation,
// and nothing that belongs to the human written into it. The console call sites stay where they are; install() is the
// only place console is swapped, at the supervisor and server process edges.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { install, logFile, LOG_CAP, redact, rotate, stamp, write } from '../server/live/server-log.ts'
import { tmp } from './tmp.ts'

const at = new Date('2026-11-18T21:44:03.000Z')
const day = '2026-11-18T21:44:03.000Z'

const noop = (..._args: unknown[]) => {}
function sink() {
  const methods = { log: noop, info: noop, warn: noop, error: noop, debug: noop }
  return { methods, log: methods.log }
}

describe('the server log', () => {
  test('every physical line gets one ISO date-time, including each line of a message', () => {
    expect(stamp('one line', at)).toBe(`${day} one line\n`)
    expect(stamp('first\nsecond\n', at)).toBe(`${day} first\n${day} second\n`)
    expect(stamp('', at)).toBe(`${day} \n`)
    expect(stamp('now', new Date('2020-01-02T03:04:05.678Z'))).toBe('2020-01-02T03:04:05.678Z now\n')
  })

  test('the path is the state folder for the server and the machine home for its worker', () => {
    const home = tmp('log-path')
    expect(logFile(home, join(home, 'run'))).toBe(join(home, 'run', 'server.log'))
    expect(logFile(home, undefined, 'box')).toBe(join(home, 'worker.log'))
    expect(logFile()).toMatch(/server\.log$/)
  })

  test('secrets and chat text are redacted, not written as they came', () => {
    expect(redact('shepherdr: Authorization: Bearer abc123')).toBe('shepherdr: Authorization: [redacted] [redacted]')
    expect(redact('shepherdr: api_key=sk-live-1234 refused')).toBe('shepherdr: api_key=[redacted] refused')
    expect(redact('password: "hunter2"')).toBe('password: [redacted]')
    expect(redact('shepherdr: the event loop stalled')).toBe('shepherdr: the event loop stalled')
  })

  test('a write prefixes, redacts and appends, and rotates once a file is over the cap', () => {
    const dir = tmp('log-write')
    const log = join(dir, 'server.log')
    write(log, ['shepherdr: token=abc123 answered'], at, 200)
    expect(readFileSync(log, 'utf8')).toBe(`${day} shepherdr: token=[redacted] answered\n`)
    write(log, ['shepherdr: still up'], at)
    expect(readFileSync(log, 'utf8').split('\n')).toHaveLength(3)
    const other = join(dir, 'other.log')
    write(other, ['shepherdr: default arguments'])
    expect(readFileSync(other, 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(LOG_CAP).toBe(10 * 1024 * 1024)
  })

  test('run the rotation twice past the cap: the .1 holds the previous log, the live one starts over', () => {
    const dir = tmp('log-rotate')
    const log = join(dir, 'server.log')
    writeFileSync(log, 'first generation\n'.repeat(20))
    expect(rotate(log, 100)).toBe(true)
    expect(readFileSync(`${log}.1`, 'utf8')).toBe('first generation\n'.repeat(20))
    expect(existsSync(log)).toBe(false)

    writeFileSync(log, 'second generation\n'.repeat(20))
    expect(rotate(log, 100)).toBe(true)
    expect(readFileSync(`${log}.1`, 'utf8')).toBe('second generation\n'.repeat(20))
    expect(existsSync(log)).toBe(false)
    // the next line creates a fresh live log, with the same prefix as before
    write(log, ['shepherdr: up again'], at, 100)
    expect(readFileSync(log, 'utf8')).toBe(`${day} shepherdr: up again\n`)
  })

  test('rotation is skipped below the cap, with no file yet, and when the old generation cannot be replaced', () => {
    const dir = tmp('log-no-rotate')
    const log = join(dir, 'server.log')
    writeFileSync(log, 'short\n')
    expect(rotate(log, 100)).toBe(false)
    expect(existsSync(`${log}.1`)).toBe(false)
    expect(rotate(join(dir, 'not-there.log'), 100)).toBe(false)
    writeFileSync(log, 'x'.repeat(200))
    mkdirSync(`${log}.1`)
    writeFileSync(join(`${log}.1`, 'child'), 'held')
    expect(rotate(log, 100)).toBe(false)
  })

  test('a log that cannot be written is ignored, not thrown into the server', () => {
    const dir = tmp('log-unwritable')
    const asDir = join(dir, 'a-directory')
    mkdirSync(asDir)
    expect(() => write(asDir, ['shepherdr: nope'])).not.toThrow()
  })

  test('a real process at the edge writes a dated line to the log and keeps its stdout', async () => {
    const dir = tmp('log-child')
    const log = join(dir, 'server.log')
    const module = join(import.meta.dir, '../server/live/server-log.ts')
    const code = `import { install } from ${JSON.stringify(module)}; install(${JSON.stringify(log)}); console.log('shepherdr: from a child')`
    const p = Bun.spawn([process.execPath, '-e', code], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NODE_ENV: 'production' },
    })
    const out = await new Response(p.stdout).text()
    await p.exited
    expect(out).toBe('')
    expect(readFileSync(log, 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z shepherdr: from a child\n$/)
  })

  test('console is left alone in a test, and at a process edge every level is dated until put back', () => {
    const dir = tmp('log-install')
    const log = join(dir, 'server.log')
    const env = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'test'
      const quiet = sink()
      install(join(dir, 'default-sink.log'))
      install(log, quiet.methods)
      quiet.methods.log('shepherdr: not in the log')
      expect(existsSync(log)).toBe(false)

      process.env.NODE_ENV = 'production'
      const live = sink()
      const restore = install(log, live.methods)
      live.methods.log('shepherdr: started on %s', '7787')
      live.methods.error('first\nsecond')
      expect(readFileSync(log, 'utf8').split('\n')).toEqual([
        expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z shepherdr: started on 7787$/),
        expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z first$/),
        expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z second$/),
        '',
      ])
      restore()
      expect(live.methods.log).toBe(live.log)
      live.methods.log('shepherdr: after the edge')
      expect(readFileSync(log, 'utf8').split('\n')).toHaveLength(4)
    } finally {
      process.env.NODE_ENV = env
    }
  })
})
