// What a merge gate run, or a pre-flight run, leaves behind (server/live/engine/gate-log.ts): its log and one line of the
// ledger, both bounded.
import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { GATE_LEDGER_MAX, GATE_LOGS_KEPT, GateLedger, gateName, gateSlug, lastLine, pruneGateLogs, type GateRunInfo } from '../server/live/engine/gate-log.ts'

/** a log file of a run of `slug`'s space that started at `start`, with `text` in it: its name, as startGate names one */
const logOf = (dir: string, slug: string, start: number, text = 'out\n') => {
  const name = `${gateName(slug, 'POL-1', start, start.toString(16).padStart(8, '0').slice(-8))}.log`
  writeFileSync(join(dir, name), text)
  return join(dir, name)
}
const lines = (dir: string, file = 'ledger.jsonl') =>
  readFileSync(join(dir, file), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
const logs = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.log'))

describe('the names a gate run goes by', () => {
  test('a space is a slug in a file name: no space, no slash, never empty, never long', () => {
    expect(gateSlug('Lyvora App')).toBe('lyvora-app')
    expect(gateSlug('a/../b c')).toBe('a-b-c')
    expect(gateSlug('***')).toBe('space')
    expect(gateSlug('x'.repeat(80))).toHaveLength(40)
  })

  test('a run is named for its space, its task, its start and a random part; one with no space has no space part', () => {
    expect(gateName('Lyvora App', 'POL-1', 1700000000000, 'ab12cd34')).toBe('lyvora-app.POL-1-1700000000000-ab12cd34')
    expect(gateName(undefined, 'POL-1', 1700000000000, 'ab12cd34')).toBe('POL-1-1700000000000-ab12cd34')
  })

  test("a pre-flight run's files end in .pre, so its logs are told from a gate's by name", () => {
    expect(gateName('Lyvora App', 'POL-1', 1700000000000, 'ab12cd34', 'preflight')).toBe('lyvora-app.POL-1-1700000000000-ab12cd34.pre')
  })

  test("the last line is the gate's last non-empty one, without control characters, cut at 200", () => {
    expect(lastLine('building\n2 tests failed\n\n  \n')).toBe('2 tests failed')
    expect(lastLine('')).toBe('')
    expect(lastLine('a\u001b[31mred\u0007\n')).toBe('a [31mred')
    expect(lastLine('x'.repeat(300))).toHaveLength(200)
  })
})

describe('the ledger', () => {
  const run = (log: string, o: Partial<GateRunInfo> = {}): GateRunInfo => ({ log, at: 1_700_000_000_000, head: 'a'.repeat(40), tip: 'b'.repeat(40), space: 'lyvora-app', task: 'POL-1', ...o })

  test('a run is one line: when it started and ended, who it was for, the commits, seconds, its code and how it ended, its log and its last line', () => {
    const dir = tmp('gate-ledger')
    const log = logOf(dir, 'lyvora-app', 1_700_000_000_000)
    const ledger = new GateLedger(dir)
    ledger.record(run(log, { members: ['POL-1', 'POL-2'] }), 'refused', { code: 1, out: 'building\n3 failed\n' }, 1_700_000_002_400)
    expect(lines(dir)).toEqual([
      {
        started: '2023-11-14T22:13:20.000Z',
        ended: '2023-11-14T22:13:22.400Z',
        kind: 'gate',
        space: 'lyvora-app',
        task: 'POL-1',
        members: ['POL-1', 'POL-2'],
        head: 'a'.repeat(40),
        base: 'b'.repeat(40),
        seconds: 2.4,
        code: 1,
        end: 'refused',
        log: log.split('/').at(-1),
        last: '3 failed',
      },
    ])
  })

  test("a pre-flight run says so in its line, whose other fields are a gate run's", () => {
    const dir = tmp('gate-ledger-pre')
    const log = join(dir, `${gateName('lyvora-app', 'POL-1', 1_700_000_000_000, 'ab12cd34', 'preflight')}.log`)
    writeFileSync(log, 'lint: 2 problems\n')
    const ledger = new GateLedger(dir)
    ledger.record(run(log, { kind: 'preflight', members: ['POL-1', 'POL-2'] }), 'refused', { code: 1, out: 'lint: 2 problems\n' }, 1_700_000_001_000)
    ledger.record(run(''), 'passed', { code: 0, out: 'ok\n' }, 1_700_000_001_000)
    expect(lines(dir).map((l) => [l.kind, l.end, l.members, l.log])).toEqual([
      ['preflight', 'refused', ['POL-1', 'POL-2'], 'lyvora-app.POL-1-1700000000000-ab12cd34.pre.log'],
      ['gate', 'passed', undefined, ''],
    ])
  })

  test('a run with no exit code has none; one with no log, no members and no space says so', () => {
    const dir = tmp('gate-ledger-none')
    const ledger = new GateLedger(dir)
    ledger.record({ log: '', at: 1_700_000_000_000, head: 'h', tip: 't' }, 'not-started', undefined, 1_700_000_000_000)
    ledger.record({ log: join(dir, 'gone.log'), at: 1_700_000_000_001, head: 'h', tip: 't', task: 'POL-2' }, 'stopped', { code: -1, out: 'partial' }, 1_700_000_000_500)
    expect(lines(dir)).toMatchObject([
      { space: '', task: '', end: 'not-started', code: null, log: '', last: '', seconds: 0 },
      { task: 'POL-2', end: 'stopped', code: null, log: '', last: 'partial', seconds: 0.5 },
    ])
    expect(lines(dir)[0]).not.toHaveProperty('members')
  })

  test('a run is written once, whoever ends it; a run with no log is told apart by its start, its task and its end', () => {
    const dir = tmp('gate-ledger-once')
    const log = logOf(dir, 'lyvora-app', 1_700_000_000_000)
    const ledger = new GateLedger(dir)
    ledger.record(run(log), 'stopped')
    ledger.record(run(log), 'stopped', { code: -1, out: '' })
    ledger.record(run(''), 'not-started')
    ledger.record(run(''), 'not-started')
    ledger.record(run(''), 'stopped')
    expect(lines(dir).map((l) => l.end)).toEqual(['stopped', 'not-started', 'stopped'])
  })

  test('the ledger is rotated to ledger.jsonl.1 at its size, the older rotation going', () => {
    const dir = tmp('gate-ledger-rotate')
    const ledger = new GateLedger(dir)
    ledger.max = 700
    for (let i = 0; i < 7; i++) ledger.record(run('', { at: 1_700_000_000_000 + i, task: `POL-${i}` }), 'passed')
    const now = lines(dir)
    const before = lines(dir, 'ledger.jsonl.1')
    expect(statSync(join(dir, 'ledger.jsonl')).size).toBeLessThanOrEqual(700)
    expect(now.at(-1)?.task).toBe('POL-6')
    // what is left is the newest lines, in order, with nothing missing between the two files
    const tasks = [...before, ...now].map((l) => l.task)
    expect(tasks.at(-1)).toBe('POL-6')
    expect(tasks).toEqual(tasks.map((_, i) => `POL-${7 - tasks.length + i}`))
    expect(tasks.length).toBeLessThan(7)
  })

  test('the defaults are a few hundred logs a space and about a megabyte of ledger', () => {
    expect([GATE_LOGS_KEPT, GATE_LEDGER_MAX]).toEqual([200, 1_000_000])
  })

  test('words kept as a log are written beside the others; a folder that cannot be written loses the line, never the merge', () => {
    const dir = tmp('gate-ledger-keep')
    const ledger = new GateLedger(dir)
    const path = ledger.keepOutput('lyvora-app.POL-1-1700000000000-ab12cd34', 'all of it\n')
    expect(readFileSync(path, 'utf8')).toBe('all of it\n')
    // the folder is a file: nothing can be written there
    const blocked = new GateLedger(join(dir, 'lyvora-app.POL-1-1700000000000-ab12cd34.log'))
    expect(blocked.keepOutput('x', 'words')).toBe('')
    expect(() => blocked.record(run(''), 'passed')).not.toThrow()
  })
})

describe('the logs kept', () => {
  test("the newest of a space stay, and only logs named as a run names its own are ever removed, never another space's, the ledger, an exit file or what else is there", () => {
    const dir = tmp('gate-prune')
    const mine = [1, 2, 3, 4, 5].map((i) => logOf(dir, 'lyvora-app', 1_700_000_000_000 + i))
    const other = [1, 2].map((i) => logOf(dir, 'lyvora-site', 1_700_000_000_000 + i))
    const bare = logOf(dir, '', 1_700_000_000_000 + 9)
    for (const f of ['ledger.jsonl', 'ledger.jsonl.1', 'notes.txt', 'lyvora-app.POL-1-1700000000001-00000001.exit', 'lyvora-app.POL-1-1700000000001-00000001.log.bak', 'dead.log'])
      writeFileSync(join(dir, f), 'keep\n')
    expect(pruneGateLogs(dir, 'lyvora-app', 2)).toBe(3)
    const left = readdirSync(dir)
    expect(mine.filter((p) => left.includes(p.split('/').at(-1) as string))).toEqual(mine.slice(3))
    expect(other.every((p) => existsSync(p))).toBe(true)
    expect(existsSync(bare)).toBe(true)
    for (const f of ['ledger.jsonl', 'ledger.jsonl.1', 'notes.txt', 'lyvora-app.POL-1-1700000000001-00000001.exit', 'lyvora-app.POL-1-1700000000001-00000001.log.bak', 'dead.log'])
      expect(left).toContain(f)
    // a run's log with no space part is its own group: the ones made without a space
    expect(pruneGateLogs(dir, '', 0)).toBe(1)
    expect(existsSync(bare)).toBe(false)
  })

  test("a pre-flight's logs and a gate's are two groups: each keeps its own newest, and pruning one never touches the other", () => {
    const dir = tmp('gate-prune-kinds')
    const pre = (i: number) => {
      const path = join(dir, `${gateName('lyvora-app', 'POL-1', 1_700_000_000_000 + i, '0000000a', 'preflight')}.log`)
      writeFileSync(path, 'pre\n')
      return path
    }
    const gates = [1, 2, 3].map((i) => logOf(dir, 'lyvora-app', 1_700_000_000_000 + i))
    const pres = [4, 5, 6].map(pre)
    expect(pruneGateLogs(dir, 'lyvora-app', 1, [], 'preflight')).toBe(2)
    expect(pres.map((p) => existsSync(p))).toEqual([false, false, true])
    expect(gates.every((p) => existsSync(p))).toBe(true)
    expect(pruneGateLogs(dir, 'lyvora-app', 1)).toBe(2)
    expect(gates.map((p) => existsSync(p))).toEqual([false, false, true])
    expect(existsSync(pres[2])).toBe(true)
  })

  test("recording a pre-flight run prunes the pre-flight logs only: a busy line's cheap checks never push a gate's log out", () => {
    const dir = tmp('gate-prune-record-pre')
    const ledger = new GateLedger(dir)
    ledger.keep = 1
    const gate = logOf(dir, 'lyvora-app', 1_700_000_000_001)
    for (let i = 2; i <= 4; i++) {
      const log = join(dir, `${gateName('lyvora-app', 'POL-1', 1_700_000_000_000 + i, '0000000a', 'preflight')}.log`)
      writeFileSync(log, 'pre\n')
      ledger.record({ log, at: 1_700_000_000_000 + i, head: 'h', tip: 't', space: 'lyvora-app', task: 'POL-1', kind: 'preflight' }, 'passed')
    }
    expect(logs(dir).filter((f) => f.endsWith('.pre.log'))).toHaveLength(1)
    expect(existsSync(gate)).toBe(true)
  })

  test('the log of a run that is going on is never removed, however old', () => {
    const dir = tmp('gate-prune-live')
    const old = logOf(dir, 'lyvora-app', 1_700_000_000_001)
    logOf(dir, 'lyvora-app', 1_700_000_000_002)
    logOf(dir, 'lyvora-app', 1_700_000_000_003)
    expect(pruneGateLogs(dir, 'lyvora-app', 1, [old])).toBe(1)
    expect(existsSync(old)).toBe(true)
    expect(logs(dir)).toHaveLength(2)
  })

  test('a log that cannot be removed is left for the next run, and nothing throws', () => {
    const dir = tmp('gate-prune-locked')
    const first = logOf(dir, 'lyvora-app', 1_700_000_000_001)
    logOf(dir, 'lyvora-app', 1_700_000_000_002)
    // a folder nobody may write in: its files cannot be unlinked (root ignores that, and has nothing to prove here)
    chmodSync(dir, 0o555)
    try {
      expect(pruneGateLogs(dir, 'lyvora-app', 1)).toBe(process.getuid?.() === 0 ? 1 : 0)
    } finally {
      chmodSync(dir, 0o755)
    }
    if (process.getuid?.() !== 0) expect(existsSync(first)).toBe(true)
  })

  test('a folder that is not there has nothing to prune, and a keep of nothing keeps nothing', () => {
    expect(pruneGateLogs(join(tmp('gate-prune-none'), 'absent'), 'lyvora-app', 5)).toBe(0)
    const dir = tmp('gate-prune-zero')
    logOf(dir, 'lyvora-app', 1_700_000_000_001)
    expect(pruneGateLogs(dir, 'lyvora-app', -3)).toBe(1)
    expect(logs(dir)).toEqual([])
  })

  test("recording a run prunes its space's logs to the newest `keep`, sparing the ones of runs going on", () => {
    const dir = tmp('gate-prune-record')
    const ledger = new GateLedger(dir)
    ledger.keep = 2
    const first = logOf(dir, 'lyvora-app', 1_700_000_000_001)
    ledger.live = () => [first]
    for (let i = 2; i <= 6; i++) {
      const log = logOf(dir, 'lyvora-app', 1_700_000_000_000 + i)
      ledger.record({ log, at: 1_700_000_000_000 + i, head: 'h', tip: 't', space: 'lyvora-app', task: 'POL-1' }, 'passed')
    }
    // the two newest, and the one that is going on
    expect(logs(dir)).toHaveLength(3)
    expect(existsSync(first)).toBe(true)
    expect(lines(dir)).toHaveLength(5)
  })
})
