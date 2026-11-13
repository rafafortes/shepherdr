// Settings → Models → Quotas: Claude Code's own /usage, read in a sealed run (plan-limits.ts). The /usage words are parsed
// (a missing week line leaves one window), the reset words are UTC and become a moment, the seal is bubblewrap and is
// refused without it, a login near renewal is not read, and a read keeps its figure, reason or hint. The fake machine
// means no real CLI or login is ever touched; the real host's few functions are run on a folder of the test's own.
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { claudeLoginDue, claudeReset, HOST, type Host, parseClaude, readClaude, sealed } from '../server/live/plan-limits.ts'
import { tmp } from './tmp.ts'

const NOW = Date.UTC(2026, 10, 13, 9, 30)
const SAMPLE = ['Current session: 10% used · resets 3pm (UTC)', 'Current week (all models): 41% used · resets Nov 16, 11:59am (UTC)'].join('\n')

/** a fake machine: which programs exist, which paths exist and what their text is, and what a run answers */
function fake(over: Partial<{ bins: string[]; paths: Record<string, string>; answer: string; timedOut: boolean; stdout: string }> = {}) {
  const runs: { argv: string[]; env: Record<string, string | undefined>; timeoutMs: number }[] = []
  const bins = new Set(over.bins ?? ['claude', 'bwrap', 'nice'])
  const paths: Record<string, string> = { '/home/t/.claude': '', '/home/t/.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { expiresAt: NOW + 5 * 3600_000 } }), ...over.paths }
  const host: Host = {
    home: '/home/t',
    env: { PATH: '/bin' },
    which: (name) => (bins.has(name) ? `/usr/bin/${name}` : null),
    exists: (path) => path in paths,
    read: (path) => (path in paths ? paths[path]! : null),
    run: async (argv, options) => {
      runs.push({ argv, env: options.env, timeoutMs: options.timeoutMs })
      const stdout = over.stdout ?? JSON.stringify({ type: 'result', result: over.answer ?? SAMPLE })
      return { stdout, timedOut: over.timedOut ?? false }
    },
  }
  return { host, runs }
}

describe('the words of /usage', () => {
  test('the session and the week are two windows, named in the screen\'s words, with their shares and their refills', () => {
    const got = parseClaude(SAMPLE, NOW)
    expect(got).toEqual({
      state: 'ok',
      windows: [
        { name: '5 h', usedPct: 10, resetAt: Date.UTC(2026, 10, 13, 15) },
        { name: 'Week (all models)', usedPct: 41, resetAt: Date.UTC(2026, 10, 16, 11, 59) },
      ],
    })
  })

  test('a week line that is missing leaves the session alone; a line with no reset keeps its share and no moment', () => {
    const got = parseClaude('Current session: 72% used', NOW)
    expect(got).toEqual({ state: 'ok', windows: [{ name: '5 h', usedPct: 72 }] })
  })

  test('a signed-out answer, a no-plan one (only the session cost) and an answer with nothing in it', () => {
    expect(parseClaude('Not logged in · Run /login', NOW)).toEqual({ state: 'signed-out' })
    expect(parseClaude('Total cost: $0.12\nTotal duration: 3s', NOW)).toEqual({ state: 'no-plan' })
    expect(parseClaude('something else', NOW)).toEqual({ state: 'unknown', why: "Claude Code's answer had no limits in it" })
  })
})

describe('when a limit refills, in UTC as Claude Code words it', () => {
  test('a time of day is the next such moment, today or tomorrow', () => {
    expect(claudeReset('3pm (UTC)', NOW)).toBe(Date.UTC(2026, 10, 13, 15))
    // 9:30 is past 9am: the next 9am is tomorrow; the minute itself is still today
    expect(claudeReset('9am (UTC)', NOW)).toBe(Date.UTC(2026, 10, 14, 9))
    expect(claudeReset('9:30am', NOW)).toBe(Date.UTC(2026, 10, 13, 9, 30))
  })

  test('a date with a time, with or without its year, and "at" between them', () => {
    expect(claudeReset('Nov 6, 11:59am (UTC)', NOW)).toBe(Date.UTC(2027, 10, 6, 11, 59))
    expect(claudeReset('Nov 20 at 3pm (UTC)', NOW)).toBe(Date.UTC(2026, 10, 20, 15))
    expect(claudeReset('Dec 1, 2027, 12am (UTC)', NOW)).toBe(Date.UTC(2027, 11, 1, 0))
    // a date that passed a day ago is next year's
    expect(claudeReset('Nov 1, 3pm (UTC)', NOW)).toBe(Date.UTC(2027, 10, 1, 15))
  })

  test('words that are no time give none', () => {
    expect(claudeReset('soon', NOW)).toBeUndefined()
    expect(claudeReset('Foo 6, 3pm', NOW)).toBeUndefined()
  })
})

describe('the seal: bubblewrap, the root read-only, and no read without it', () => {
  test('the command runs under bwrap with the root read-only and a throwaway /tmp', () => {
    const args = sealed(['nice', '-n', '19', 'claude', '-p', '/usage'], '/usr/bin/bwrap')!
    expect(args.slice(0, 4)).toEqual(['/usr/bin/bwrap', '--ro-bind', '/', '/'])
    expect(args).toContain('--tmpfs')
    expect(args[args.indexOf('--tmpfs') + 1]).toBe('/tmp')
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['nice', '-n', '19', 'claude', '-p', '/usage'])
  })

  test('without bubblewrap the seal is refused: there is no unsealed command', () => {
    expect(sealed(['claude', '-p', '/usage'], null)).toBeUndefined()
  })

  test('a read without bubblewrap is never run, and says it needs bubblewrap', async () => {
    const { host, runs } = fake({ bins: ['claude'] })
    expect(await readClaude(() => NOW, host)).toEqual({ hint: expect.stringMatching(/^Needs bubblewrap \(bwrap\)/) })
    expect(runs).toEqual([])
  })

  test('without Claude Code there is nothing to read, and no run', async () => {
    const { host, runs } = fake({ bins: ['bwrap'] })
    expect(await readClaude(() => NOW, host)).toEqual({ hint: 'Claude Code is not installed on this machine.' })
    expect(runs).toEqual([])
  })
})

describe('the login near its renewal', () => {
  test('a login that ends within an hour, or has ended, is due; one that lasts longer is not', () => {
    expect(claudeLoginDue(JSON.stringify({ claudeAiOauth: { expiresAt: NOW + 30 * 60_000 } }), NOW)).toBe(true)
    expect(claudeLoginDue(JSON.stringify({ claudeAiOauth: { expiresAt: NOW - 1000 } }), NOW)).toBe(true)
    expect(claudeLoginDue(JSON.stringify({ claudeAiOauth: { expiresAt: NOW + 5 * 3600_000 } }), NOW)).toBe(false)
  })

  test('a login with no end time is not due; one that is not JSON is', () => {
    expect(claudeLoginDue(JSON.stringify({ claudeAiOauth: {} }), NOW)).toBe(false)
    expect(claudeLoginDue('not json', NOW)).toBe(true)
  })

  test('a due login is not read at all, and the read says it waits for the renewal', async () => {
    const { host, runs } = fake({ paths: { '/home/t/.claude': '', '/home/t/.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { expiresAt: NOW + 60_000 } }) } })
    expect(await readClaude(() => NOW, host)).toEqual({ hint: expect.stringMatching(/renewal/) })
    expect(runs).toEqual([])
  })
})

describe('one read', () => {
  test('a read runs /usage under the seal, in UTC, niced and time-limited, and keeps the windows as the figure', async () => {
    const { host, runs } = fake()
    const got = await readClaude(() => NOW, host)
    expect(got).toEqual({
      figure: {
        windows: [
          { name: '5 h', usedPct: 10, resetAt: Date.UTC(2026, 10, 13, 15) },
          { name: 'Week (all models)', usedPct: 41, resetAt: Date.UTC(2026, 10, 16, 11, 59) },
        ],
        source: "from Claude Code's /usage",
        at: NOW,
      },
    })
    expect(runs).toHaveLength(1)
    const [run] = runs
    expect(run!.argv[0]).toBe('/usr/bin/bwrap')
    expect(run!.argv).toContain('--share-net')
    expect(run!.argv.slice(run!.argv.indexOf('--') + 1)).toEqual(['nice', '-n', '19', '/usr/bin/claude', '-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config'])
    expect(run!.env).toMatchObject({ TZ: 'UTC', TMPDIR: '/tmp' })
    expect(run!.timeoutMs).toBe(60_000)
  })

  test('without nice the same run goes without it', async () => {
    const { host, runs } = fake({ bins: ['claude', 'bwrap'] })
    await readClaude(() => NOW, host)
    expect(runs[0]!.argv.slice(runs[0]!.argv.indexOf('--') + 1)).toEqual(['/usr/bin/claude', '-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config'])
  })

  test('signed out, no plan and an answer with no limits: a reason, a hint, and a reason', async () => {
    expect(await readClaude(() => NOW, fake({ answer: 'Not logged in' }).host)).toEqual({ reason: 'Claude Code is not signed in.' })
    expect(await readClaude(() => NOW, fake({ answer: 'Total cost: $1' }).host)).toEqual({ hint: expect.stringMatching(/no plan limits/) })
    expect(await readClaude(() => NOW, fake({ answer: 'nothing' }).host)).toEqual({ reason: "Claude Code's answer had no limits in it" })
  })

  test('a run past its minute, an answer that is not JSON, and one with no text are failures with their words', async () => {
    expect(await readClaude(() => NOW, fake({ timedOut: true }).host)).toEqual({ reason: 'Claude Code took longer than a minute to answer.' })
    expect(await readClaude(() => NOW, fake({ stdout: 'not json' }).host)).toEqual({ reason: "Couldn't read Claude Code's answer." })
    expect(await readClaude(() => NOW, fake({ stdout: '{"result": 3}' }).host)).toEqual({ reason: "Couldn't read Claude Code's answer." })
  })

  test('the config folder named by the environment is the one checked: none there is not signed in', async () => {
    const { host } = fake()
    host.env = { CLAUDE_CONFIG_DIR: '/elsewhere' }
    expect(await readClaude(() => NOW, host)).toEqual({ hint: 'Not signed in to Claude Code on this machine.' })
  })
})

describe('the real machine, on a folder of the test\'s own', () => {
  test('which finds a program on the PATH and nothing else; exists and read see a file as it is', async () => {
    expect(HOST.which('sh')).toBeTruthy()
    expect(HOST.which('no-such-program-shepherdr-test')).toBeNull()
    const dir = tmp('plan-limits-host')
    const file = join(dir, 'f.txt')
    writeFileSync(file, 'text')
    expect(HOST.exists(dir)).toBe(true)
    expect(HOST.exists(join(dir, 'missing'))).toBe(false)
    expect(HOST.read(file)).toBe('text')
    expect(HOST.read(join(dir, 'missing'))).toBeNull()
  })

  test('run gives a program\'s output, and kills one that is past its time', async () => {
    expect(await HOST.run(['/bin/echo', 'hi'], { env: { PATH: '/bin', TZ: undefined }, timeoutMs: 10_000 })).toEqual({ stdout: 'hi\n', timedOut: false })
    expect((await HOST.run(['sleep', '5'], { env: { PATH: '/bin' }, timeoutMs: 50 })).timedOut).toBe(true)
  })
})
