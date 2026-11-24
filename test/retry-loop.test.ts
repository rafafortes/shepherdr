// biome-ignore-all lint/style/noNonNullAssertion: the index and regex captures were checked just above
// A provider retrying inside a CLI's turn: what its own status, messages or waiting line say, how the words are
// classified by the same rules as a cut at the end of a turn, and when the retry window hands over to the backup.
import { describe, expect, test } from 'bun:test'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('retry-loop')
const { loopError, Retries, WAITS } = await import('../server/live/retry.ts')
type Retry = import('../server/live/retry.ts').Retry
const { forgetOpencodeRetry, messagesRetry, opencodeRetry, QUIET_FOR, screenRetry, statusRetry } = await import('../server/live/retry-loop.ts')

const T0 = Date.UTC(2026, 10, 24, 12, 0)
const MIN = 60_000

describe("a CLI's own retry state", () => {
  test("OpenCode's waiting line names the attempt and the provider's own words", () => {
    const s = screenRetry('⚠ Retrying in 836s · attempt 7 · Rate limit exceeded. Please try again later.\nBuild · HungerG Free', T0)
    expect(s).toEqual({ attempt: 7, message: 'Rate limit exceeded. Please try again later.', next: T0 + 836_000, source: 'screen' })
    // a clock in minutes or hours, and a redraw that moved the line, are read the same way
    expect(screenRetry('retrying in 2m · attempt 3 · Go usage limit exceeded', T0)).toMatchObject({ attempt: 3, next: T0 + 2 * MIN, message: 'Go usage limit exceeded' })
    expect(screenRetry('Retrying in 1h · attempt 12 · Provider overloaded', T0)).toMatchObject({ next: T0 + 3_600_000, message: 'Provider overloaded' })
    expect(loopError(screenRetry('Retrying in 836s · attempt 7 · Rate limit exceeded. Please try again later.', T0)!)).toEqual({ passing: true, reason: 'Rate limited' })
    expect(loopError(screenRetry('retrying in 2m · attempt 3 · Go usage limit exceeded', T0)!).passing).toBe(false)
  })

  test('Claude Code, pi and agy have their own waiting line, read by the same rule', () => {
    // checked in each CLI's own screen strings (Nov 2026): Claude's dim "· retrying in 25s · attempt 2/5", pi's
    // "Retrying (2/5) in 30s..." status indicator and agy's "Retrying in 12s (attempt 3/8)"
    expect(screenRetry('● working\n · retrying in 25s · attempt 2/5', T0, 'claude')).toMatchObject({ attempt: 2, next: T0 + 25_000, source: 'screen' })
    expect(screenRetry('Retrying (2/5) in 30s... (Ctrl+C to interrupt)', T0, 'pi')).toMatchObject({ attempt: 2, next: T0 + 30_000, source: 'screen' })
    expect(screenRetry('Retrying in 12s (attempt 3/8)...', T0, 'agy')).toMatchObject({ attempt: 3, next: T0 + 12_000, source: 'screen' })
    // Claude's countdown that still says only "retrying…" has no wait to read; the next pass will
    expect(screenRetry('· retrying… · attempt 4/5', T0, 'claude')).toMatchObject({ attempt: 4, message: '' })
    // OpenCode's countdown that reached zero still says it is retrying, with no wait to read
    expect(screenRetry('⚠ Retry due · attempt 7 · Rate limit exceeded', T0)).toMatchObject({ attempt: 7, message: 'Rate limit exceeded' })
    expect(screenRetry('⚠ Retry due · attempt 7 · Rate limit exceeded', T0)?.next).toBeUndefined()
    // a real OpenCode pane has the retry line above its input and footer, and blank rows: still read
    const pane = [
      '⚠ Retrying in 836s · attempt 7 · Rate limit exceeded. Please try again later.',
      '',
      'Build · HungerG Free',
      '> ',
      '╭──────────────────────────────────────────────────────╮',
      '│ Type a message                                       │',
      '╰──────────────────────────────────────────────────────╯',
      '',
      '  tab 1: Agent    tab 2: Review  1 git worktree',
    ].join('\n')
    expect(screenRetry(pane, T0)).toMatchObject({ attempt: 7, next: T0 + 836_000, message: 'Rate limit exceeded. Please try again later.' })
    // a pane that says nothing about a retry is not one; a line of prose 20 lines up in a diff is not a status
    expect(screenRetry('Build · HungerG Free\n> doing the work', T0)).toBeUndefined()
    expect(screenRetry(['Retrying in 836s · attempt 7 · Rate limit exceeded', ...Array(20).fill('diff --git'), 'done'].join('\n'), T0)).toBeUndefined()
    // an ordinary sentence is not a retry; an in-turn retry needs its own line with an attempt
    expect(screenRetry('I am retrying the build now', T0)).toBeUndefined()
    // Codex is not installed here and has no in-turn retry status line of its own
    expect(screenRetry('Reconnecting to server...', T0, 'codex')).toBeUndefined()
    // the latest waiting line wins
    expect(screenRetry('Retrying in 8s · attempt 2 · Rate limit exceeded\nRetrying in 836s · attempt 7 · Rate limit exceeded', T0)).toMatchObject({ attempt: 7, next: T0 + 836_000 })
  })

  test('OpenCode status and session messages hold the same state where the version keeps it', () => {
    expect(statusRetry({ type: 'retry', attempt: 7, message: 'Rate Limited', next: T0 + 836_000 })).toEqual({ attempt: 7, message: 'Rate Limited', next: T0 + 836_000, source: 'api' })
    const map = { 'ses-1': { type: 'idle' }, 'ses-2': { type: 'retry', attempt: 2, message: 'Too Many Requests' } }
    expect(statusRetry(map, 'ses-2')).toMatchObject({ attempt: 2, message: 'Too Many Requests' })
    // a sibling's retry is never attributed to this session
    expect(statusRetry(map, 'ses-1')).toBeUndefined()
    expect(statusRetry({ 'ses-1': { type: 'busy' } }, 'ses-1')).toBeUndefined()
    // `order=desc` returns newest first, so the current retry is the first row
    expect(messagesRetry([{ content: [{ type: 'retry', attempt: 4, error: { message: 'Rate limit exceeded. Please try again later.' } }] }, { type: 'user' }])).toMatchObject({
      attempt: 4,
      message: 'Rate limit exceeded. Please try again later.',
      source: 'messages',
    })
    expect(messagesRetry([])).toBeUndefined()
  })

  test('the API is asked first, at most once in a while, and a version without the operations falls to the screen', async () => {
    forgetOpencodeRetry()
    const calls: string[] = []
    const call = async (args: string[]) => {
      calls.push(args[0]!)
      return args[0] === 'session.status' ? { type: 'retry', attempt: 3, message: 'Rate Limited', next: T0 + 10_000 } : undefined
    }
    expect(await opencodeRetry('ses-1', '/repo', call, T0)).toMatchObject({ attempt: 3, source: 'api' })
    expect(await opencodeRetry('ses-1', '/repo', call, T0 + 1_000)).toMatchObject({ attempt: 3, source: 'api' })
    expect(calls).toEqual(['session.status'])
    // a "no retry" answer is held briefly, so a polling pass does not spawn a CLI for every agent
    calls.length = 0
    expect(await opencodeRetry('ses-2', '/repo', async () => undefined, T0)).toBeUndefined()
    expect(await opencodeRetry('ses-2', '/repo', async () => undefined, T0 + 5_000)).toBeUndefined()
    expect(calls.length).toBe(0)
    expect(await opencodeRetry('ses-2', '/repo', async () => undefined, T0 + QUIET_FOR + 1)).toBeUndefined()
    // OpenCode 2.3.2 has no session.status (checked by running it); its messages keep no retry part either, so the
    // API path is asked once for status and then skipped: no CLI spawn every 30 s on a version that cannot answer.
    forgetOpencodeRetry()
    calls.length = 0
    const none = async (args: string[]) => {
      calls.push(args[0]!)
      throw new Error(`Operation not found: ${args[0]}`)
    }
    expect(await opencodeRetry('ses-3', '/repo', none, T0)).toBeUndefined()
    expect(await opencodeRetry('ses-4', '/repo', none, T0)).toBeUndefined()
    // with no session.status there is no new retry format in messages either: do not ask 10 agents every 30 s
    expect(calls).toEqual(['session.status'])
    forgetOpencodeRetry()
  })

  test('the words use the cut-off rules: rate limit waits, an allowance hands over at once', () => {
    expect(loopError({ attempt: 1, message: 'Rate limit exceeded. Please try again later.', source: 'screen' })).toEqual({ passing: true, reason: 'Rate limited' })
    expect(loopError({ attempt: 1, message: 'Go usage limit exceeded', source: 'screen' })).toMatchObject({ passing: false, reason: 'Out of allowance' })
    expect(loopError({ attempt: 1, message: 'Insufficient account funds', source: 'screen' })).toMatchObject({ passing: false, reason: 'Out of credit' })
    // a CLI that prints only a countdown is still waiting, not a refusal
    expect(loopError({ attempt: 2, message: '', source: 'screen' })).toEqual({ passing: true, reason: 'Provider retrying' })
  })
})

describe('the retry window for a loop', () => {
  const world = () => {
    const over: { key: string; retry: Retry }[] = []
    const changed: string[] = []
    const runOut: string[] = []
    const r = new Retries(
      {
        nudge: () => undefined,
        over: (key, x) => over.push({ key, retry: x }),
        changed: (key) => changed.push(key),
        runOut: (_key, _cut, reason) => runOut.push(reason),
      },
      WAITS,
    )
    return { r, over, changed, runOut }
  }
  const limited = (attempt: number, next?: number) => ({ attempt, message: 'Rate limit exceeded. Please try again later.', next, source: 'screen' as const })

  test('a short retry that recovers is not handed over, and leaves no retry behind', () => {
    const w = world()
    w.r.loop('P/Agent', limited(7, T0 + 836_000), T0)
    expect(w.r.get('P/Agent')).toMatchObject({ inTurn: true, attempt: 7, reason: 'Rate limited', loopSince: T0, next: T0 + 836_000, source: 'screen' })
    expect(w.over).toEqual([])
    // a reading that says no retry ended the loop: it went on by itself
    // a request in flight or a countdown at zero shows no line for a moment: hold the loop for two misses
    w.r.loopEnded('P/Agent')
    expect(w.r.get('P/Agent')).toMatchObject({ attempt: 7, loopMisses: 1, loopSince: T0 })
    w.r.loopEnded('P/Agent')
    expect(w.r.get('P/Agent')).toMatchObject({ loopMisses: 2 })
    w.r.loopEnded('P/Agent')
    expect(w.r.get('P/Agent')).toBeUndefined()
    w.r.stop()
  })

  test('a loop past the window hands over once, and the primary is watched', () => {
    const w = world()
    w.r.loop('Q/Agent', limited(2, T0 + 2_000), T0)
    w.r.loop('Q/Agent', limited(9, T0 + 20_000), T0 + 16 * MIN)
    expect(w.over).toHaveLength(1)
    expect(w.over[0]!.retry).toMatchObject({ over: true, lasting: true, inTurn: true, attempt: 9, reason: 'Rate limited, still after 9 tries' })
    // the same pass again, and a log cut from the old turn ending later, say it no second time
    w.r.loop('Q/Agent', limited(10), T0 + 17 * MIN)
    w.r.seen('Q/Agent', { id: 'late-cut', at: T0 + 17 * MIN, text: 'Rate limit exceeded. Please try again later.', status: 429 })
    expect(w.over).toHaveLength(1)
    expect(w.runOut).toEqual([])
    w.r.stop()
  })

  test('a next try beyond what is left of the window is a cut now', () => {
    const w = world()
    // attempt 7 is told to wait 20 minutes: longer than the whole 15-minute window from when it was first seen
    w.r.loop('R/Agent', limited(7, T0 + 20 * MIN), T0)
    expect(w.over).toHaveLength(1)
    expect(w.over[0]!.retry).toMatchObject({ over: true, lasting: true, attempt: 7 })
    // one within the window waits
    const w2 = world()
    w2.r.loop('S/Agent', limited(7, T0 + 14 * MIN), T0)
    expect(w2.over).toEqual([])
    w.r.stop()
    w2.r.stop()
  })

  test('an out-of-allowance message hands over at once and is kept as a run-out', () => {
    const w = world()
    w.r.loop('U/Agent', { attempt: 1, message: 'Go usage limit exceeded', source: 'api' }, T0)
    expect(w.over).toHaveLength(1)
    expect(w.over[0]!.retry).toMatchObject({ over: true, lasting: true, reason: 'Out of allowance' })
    expect(w.runOut).toEqual(['Out of allowance'])
    w.r.stop()
  })
})
