// The room the restart sheet shows beside each CLI and model (server/live/rooms.ts): whether one more agent fits there now
// under Settings → Limits (models.maxAtOnce), with the engine's own choice (choose.ts) over that key, in short for a list's
// row and in words for the line under the pickers. Every CLI with its own keys: Claude Code, Codex, Antigravity by their
// own name, pi and OpenCode by harness.provider.
import { describe, expect, test } from 'bun:test'
import { roomOf, runsWords, withRooms, type RoomInput } from '../server/live/rooms.ts'
import { capWords, roomLeft, type Run } from '../server/live/engine/choose.ts'
import type { MaxEntry } from '../shared/model-caps.ts'
import type { QuotaFigure, RestartCli } from '../shared/types.ts'

const e = (pattern: string, max: number): MaxEntry => ({ pattern, max })
const run = (key: string, id?: string, role: Run['role'] = 'task', space = 'app'): Run => ({ key, space, role, ...(id ? { id } : {}) })
const input = (o: Partial<RoomInput> = {}): RoomInput => ({ space: 'app', runs: [], machine: [], own: [], ...o })

/** a model key of each CLI, its provider (the pattern a provider entry names) and the words a line names it by */
const CLIS = [
  { cli: 'claude', key: 'claude/claude-opus-5-5', other: 'claude/claude-sonnet-5-5', provider: 'claude', words: 'Claude' },
  { cli: 'codex', key: 'codex/gpt-6-sol', other: 'codex/gpt-6-luna', provider: 'codex', words: 'Codex' },
  { cli: 'pi', key: 'pi.spark/qwen3.8-flash-next-mlx4-mtp-tensorfold', other: 'pi.spark/ornith-1.5-122b', provider: 'pi.spark', words: 'Pi · spark' },
  { cli: 'opencode', key: 'opencode.opencode-go/deepseek-v4.1-flash', other: 'opencode.opencode-go/kimi-k3', provider: 'opencode.opencode-go', words: 'Opencode · opencode-go' },
  { cli: 'agy', key: 'agy/gemini-4-argon', other: 'agy/claude-opus-5-5', provider: 'agy', words: 'Agy' },
]

for (const c of CLIS) {
  describe(`${c.cli}'s models`, () => {
    test('no limit: nothing to say while nothing runs, how many run on its provider when some do, and a line only with a quota', () => {
      expect(roomOf(c.key, input())).toEqual({ state: 'room', short: '', words: '' })
      const runs = [run(c.other, 'POL-1'), run(c.key, 'POL-2'), run('elsewhere/x', 'POL-3')]
      expect(roomOf(c.key, input({ runs }))).toEqual({ state: 'room', short: '2 running', words: '' })
      const quota = () => ({ windows: [{ name: 'Week', usedPct: 10 }], source: 'read', at: 0 })
      expect(roomOf(c.key, input({ runs, quota }))).toEqual({ state: 'room', short: '2 running', words: `No limit on ${c.provider.replace('.', ' · ')}; POL-1 and POL-2 run on it now.`, quota: 'Week 10%' })
      expect(roomOf(c.key, input({ runs: [run(c.key, 'POL-2')], quota })).words).toContain('POL-2 runs on it now.')
      expect(roomOf(c.key, input({ quota })).words).toContain('nothing runs on it now.')
    })

    test('room under its provider entry: its count of the limit, what runs, how many more fit', () => {
      const r = roomOf(c.key, input({ machine: [e(c.provider, 3)], runs: [run(c.other, 'POL-7')] }))
      expect(r).toEqual({ state: 'room', short: '1 of 3', words: `${c.words}: 1 of 3 at once now (POL-7); 2 more fit.` })
    })

    test('full: the entry at its limit and what holds it', () => {
      const r = roomOf(c.key, input({ machine: [e(c.provider, 2)], runs: [run(c.other, 'POL-7'), run(c.key, undefined, 'coordinator')] }))
      expect(r).toEqual({ state: 'full', short: 'Full 2 of 2', words: `${c.words} is at its limit (2 of 2 at once): POL-7 and 1 coordinator.` })
    })

    test('blocked: 0 allowed, by its model entry or its provider entry, whatever runs', () => {
      expect(roomOf(c.key, input({ machine: [e(c.key, 0)] }))).toMatchObject({ state: 'blocked', short: 'Blocked' })
      expect(roomOf(c.key, input({ machine: [e(c.provider, 0)] })).words).toBe(`${c.words} is blocked (0 allowed).`)
      // a model entry blocks that model alone
      expect(roomOf(c.other, input({ machine: [e(c.key, 0)] })).state).toBe('room')
    })

    test('out: its provider is out now, until its reset; a time today is said without its day in a row', () => {
      const r = roomOf(c.key, input({ out: (k) => (k === c.key ? { until: 'Today 17:30' } : undefined) }))
      expect(r).toMatchObject({ state: 'out', short: 'Out until 17:30' })
      expect(r.words).toBe(`${c.words} is out until Today 17:30.`)
      expect(roomOf(c.key, input({ out: () => ({}) })).short).toBe('Out')
    })

    test('withRooms: its CLI gets its default model\'s room, each of its models its own', () => {
      // a model's id as its CLI names it: pi's and OpenCode's with their provider (spark/qwen…), the others' alone
      const id = (key: string) => (c.provider.includes('.') ? `${c.provider.split('.')[1]}${key.slice(key.indexOf('/'))}` : key.slice(key.indexOf('/') + 1))
      const [cli] = withRooms([{ kind: c.cli, name: c.cli, defaultModel: id(c.key), models: [{ id: id(c.other), label: 'Other', efforts: [] }] }], input({ machine: [e(c.key, 0)] }))
      expect(cli!.room?.state).toBe('blocked')
      expect(cli!.models![0]!.room?.state).toBe('room')
    })
  })
}

describe('the room in words', () => {
  test('the tightest entry is the one shown: a model entry with less room than its provider\'s', () => {
    const r = roomOf('pi.spark/a', input({ machine: [e('pi.spark', 4), e('pi.spark/a', 2)], runs: [run('pi.spark/a', 'T-1'), run('pi.spark/b', 'T-2')] }))
    expect(r).toMatchObject({ state: 'room', short: '1 of 2', words: 'Pi · spark/a: 1 of 2 at once now (T-1); one more fits.' })
  })

  test("a space's own sub-limit says its space, counts its runs only, and a full one names it", () => {
    const runs = [run('codex/x', 'A-1', 'task', 'app'), run('codex/x', 'B-1', 'task', 'web')]
    const shown = (s: string) => (s === 'app' ? 'The App' : s)
    expect(roomOf('codex/x', input({ own: [e('codex', 2)], runs, shown }))).toMatchObject({ state: 'room', short: '1 of 2', words: 'Codex in The App: 1 of 2 at once now (A-1); one more fits.' })
    expect(roomOf('codex/x', input({ own: [e('codex', 1)], runs, shown }))).toMatchObject({ state: 'full', words: 'Codex in The App is at its limit (1 of 1 at once): A-1.' })
    // the machine's total full first: it is what holds it
    expect(roomOf('codex/x', input({ machine: [e('codex', 2)], own: [e('codex', 1)], runs, shown })).words).toBe('Codex is at its limit (2 of 2 at once): A-1 and B-1.')
  })

  test("its provider's quota: in the line, and in the row with a warning once a window reaches the warning share", () => {
    const q: QuotaFigure = { windows: [{ name: '5 h', usedPct: 91.6 }, { name: 'Week', usedPct: 40 }, { name: 'Credits', left: 3 }], source: 'read', at: 0 }
    const quota = (p: string) => (p === 'claude' ? q : undefined)
    const r = roomOf('claude/claude-opus-5-5', input({ quota, alertAt: 90 }))
    expect(r).toEqual({ state: 'room', short: '5 h 92%', warn: true, words: 'No limit on claude; nothing runs on it now.', quota: '5 h 92% · Week 40%' })
    // below the share: in the line only; an estimate says so
    expect(roomOf('claude/claude-opus-5-5', input({ quota: () => ({ ...q, estimate: true }), alertAt: 95, machine: [e('claude', 2)] }))).toEqual({ state: 'room', short: '0 of 2', words: 'Claude: 0 of 2 at once now; 2 more fit.', quota: '5 h 92% · Week 40% (estimate)' })
    // with the alert off, a window past its whole share warns
    expect(roomOf('claude/x', input({ quota: () => ({ ...q, windows: [{ name: 'Week', usedPct: 104 }] }), machine: [e('claude', 2)] }))).toMatchObject({ short: '0 of 2 · Week 104%', warn: true })
    // a model that can't take one more: its row says what holds it, its line the quota
    const full = roomOf('claude/x', input({ quota, alertAt: 90, machine: [e('claude', 0)] }))
    expect(full).toEqual({ state: 'blocked', short: 'Blocked', warn: true, words: 'Claude is blocked (0 allowed).', quota: '5 h 92% · Week 40%' })
  })

  test('what runs, in words: tasks by id first, the other roles by count', () => {
    expect(runsWords([])).toBe('')
    expect(runsWords([run('k', 'A-1')])).toBe('A-1')
    expect(runsWords([run('k', 'A-1'), run('k', 'A-2'), run('k', undefined, 'coordinator'), run('k', undefined, 'coordinator'), run('k', 'r1', 'reviewer'), run('k', 'a1', 'advisor'), run('k')])).toBe('A-1, A-2, 1 task, 2 coordinators, 1 reviewer run and 1 advisor run')
  })

  test('a list of CLIs with no model list: its CLI still gets its room', () => {
    const clis: RestartCli[] = [{ kind: 'codex', name: 'Codex' }]
    expect(withRooms(clis, input({ machine: [e('codex', 0)] }))[0]).toEqual({ kind: 'codex', name: 'Codex', room: { state: 'blocked', short: 'Blocked', words: 'Codex is blocked (0 allowed).' } })
  })
})

describe('roomLeft and capWords (choose.ts)', () => {
  const at = (o: { machine?: MaxEntry[]; own?: MaxEntry[]; runs?: Run[] }) => ({ space: 'app', options: [], runs: o.runs ?? [], machine: o.machine ?? [], own: o.own ?? [] })
  test('the entry with the least room left, the machine first on a tie; none with no entry above 0', () => {
    expect(roomLeft(at({}), 'pi.spark/a')).toBeUndefined()
    expect(roomLeft(at({ machine: [e('pi.spark', 0)] }), 'pi.spark/a')).toBeUndefined()
    expect(roomLeft(at({ machine: [e('pi.spark', 2)], own: [e('pi.spark', 2)], runs: [run('pi.spark/a', 'T', 'task', 'web')] }), 'pi.spark/a')).toEqual({ scope: 'machine', count: 1, max: 2, pattern: 'pi.spark' })
    expect(roomLeft(at({ machine: [e('pi.spark', 4)], own: [e('pi.spark/a', 1)] }), 'pi.spark/a')).toEqual({ scope: 'space', count: 0, max: 1, pattern: 'pi.spark/a' })
    expect(roomLeft(at({ machine: [e('codex', 4)] }), 'pi.spark/a')).toBeUndefined()
  })

  test('capWords says each reason, a space\'s by its shown name', () => {
    expect(capWords({ harness: null, why: 'out', name: 'pi.opencode-go', until: '17:00' })).toBe('pi · opencode-go is out until 17:00')
    expect(capWords({ harness: null, why: 'out', name: 'codex' })).toBe('codex is out')
    expect(capWords({ harness: null, why: 'blocked', name: 'pi.spark', cap: { scope: 'space', space: 'app', count: 0, max: 0 } }, (s) => s.toUpperCase())).toBe('pi · spark in APP is blocked (0 allowed)')
    expect(capWords({ harness: null, why: 'full', name: 'claude', cap: { scope: 'machine', count: 2, max: 2 } })).toBe('claude is at its limit (2 of 2 at once)')
  })
})
