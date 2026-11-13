// Settings → Models → Summary, the live source's side: the action reads the summary; a turn cut off by a provider's
// run-out is kept in the ledger (retry.ts runOutOf) and alerted once per run of run-outs, the first after the provider was
// fine; the logs of the agents' records feed the summary's usage; a 402 is out of credit with its reset in local time.
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('models-summary-source')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { HOUR } = await import('../server/live/usage-ledger.ts')

const src = new LiveSource()
afterAll(() => src.stop())

const MODEL = 'opencode-go/deepseek-v4.1-flash'
/** each test's own model, so one test's outage is not another's */
const MODEL2 = 'commandcode/deepseek/deepseek-v4.1-flash'
/** a pi agent's record on the model, with its log (a file of the test's own) */
function agent(key: string, logs: string[] = [], model = MODEL) {
  src.agents.records[key] = { key, name: `shep-${key.replace(/\W+/g, '-')}`, kind: 'pi', model, cwd: process.env.SHEPHERDR_HOME!, workspace: 'w', logs, started: Date.now() } as never
}
/** the cut-off turn a log would show for the agent, a minute before `ago` ms of the clock (each turn has its own time) */
const cut = (id: string, text: string, status?: number, ago = 60_000) => ({ id, at: Date.now() - ago, text, status })
/** the alerts a run-out sent, as titles and tags */
function alerts(): { title: string; tag?: string; body: string }[] {
  const got: { title: string; tag?: string; body: string }[] = []
  src.alert = ((a: { title: string; tag?: string; body: string }) => got.push(a)) as never
  return got
}
// a cut-off turn of a task's agent is handed on by its backups in engine.ts: no backup takes over in this test
;(src as unknown as { cannotGoOn: () => void }).cannotGoOn = () => undefined

describe('a provider run-out in a chat', () => {
  test('is kept in the ledger with its reset, and alerted once: the next run-out while it is out is not', () => {
    agent('T-901/Agent')
    const got = alerts()
    // a 402 with an ISO reset, a few hours ahead: out of credit until it, and the reset shown in this machine's time
    const reset = new Date(Date.now() + 3 * HOUR).toISOString().replace(/\.\d+Z$/, 'Z')
    src.retries.seen('T-901/Agent', cut('e1', `Insufficient account funds. resets at ${reset}`, 402))
    const runs = src.usage.runOuts((k) => k === MODEL)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ chat: 'T-901/Agent', role: 'task', reason: expect.stringMatching(/^Out of credit until /) })
    expect(runs[0]!.resetAt).toBe(Date.parse(reset))
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ title: 'OpenCode Go ran out', tag: 'runout:opencode-go', go: { place: 'T-901/Agent' }, task: true })
    expect(got[0]!.body).toMatch(/^T-901 agent was cut off: out of credit until .+\.$/)
    // another cut-off turn while it is still out: recorded, not alerted again
    src.retries.seen('T-901/Agent', cut('e2', 'Insufficient account funds', 402, 50_000))
    expect(src.usage.runOuts((k) => k === MODEL)).toHaveLength(2)
    expect(got).toHaveLength(1)
  })

  test('after a call of the provider goes through, the next run-out alerts again: a new outage', () => {
    agent('T-902/Agent', [], MODEL2)
    const got = alerts()
    src.retries.seen('T-902/Agent', cut('f1', "You've hit your limit · resets 5pm", 429))
    expect(got).toHaveLength(1)
    // the provider answers again (a call of it, counted in an hour after the run-out)
    src.usage.count('T-902/Agent', MODEL2, { id: 'answer-1', at: Date.now() + HOUR, tokens: 12 }, Date.now() + 2 * HOUR)
    src.retries.seen('T-902/Agent', cut('f2', "You've hit your limit · resets 5pm", 429, 30_000))
    expect(got).toHaveLength(2)
    expect(got[1]!.title).toBe('Command Code ran out')
  })

  test('a refusal is not a run-out: no ledger entry, no alert', () => {
    agent('T-903/Agent')
    const got = alerts()
    const before = src.usage.runOuts(() => true).length
    src.retries.seen('T-903/Agent', cut('g1', 'bad request', 400))
    expect(src.usage.runOuts(() => true).length).toBe(before)
    expect(got).toEqual([])
  })

  test('a record that is not there is nothing to keep', () => {
    const got = alerts()
    const before = src.usage.runOuts(() => true).length
    src.retries.seen('T-904/Agent', cut('h1', "You've hit your session limit · resets 5pm", 429))
    expect(src.usage.runOuts(() => true).length).toBe(before)
    expect(got).toEqual([])
  })
})

describe('the summary action', () => {
  test('reads the providers, their usage fed by the logs of the records, and the run-out in them', async () => {
    const log = join(process.env.SHEPHERDR_HOME!, 'T-905.jsonl')
    writeFileSync(log, JSON.stringify({ type: 'message', id: 'sum-1', timestamp: new Date(Date.now() - HOUR).toISOString(), message: { role: 'assistant', provider: 'opencode-go', model: 'deepseek-v4.1-flash', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', usage: { totalTokens: 250, cost: { total: 0.002 } } } }) + '\n')
    agent('T-905/Agent', [log])
    type Sum = { at: number; providers: { provider: string; usage: { h24: { tokens: number; calls: number; cost?: number } }; runOuts: { out: boolean; count7d: number } }[]; warnings: unknown[] }
    const read = async () => (await src.act({ type: 'models-summary' })) as Sum
    const go = (s: Sum) => s.providers.find((p) => p.provider === 'opencode-go')!
    const before = go(await read()).usage.h24
    // the feed reads the record's log, twice: the reply is counted once
    src.usageFeed.pass()
    src.usageFeed.pass()
    const sum = await read()
    // the feed counted the reply once, however often it was read: 250 tokens and one call, and its estimate
    expect(go(sum).usage.h24.tokens - before.tokens).toBe(250)
    expect(go(sum).usage.h24.calls - before.calls).toBe(1)
    expect(go(sum).usage.h24.cost).toBeCloseTo((before.cost ?? 0) + 0.002)
    expect(go(sum).runOuts.count7d).toBeGreaterThanOrEqual(1)
    expect(typeof sum.at).toBe('number')
    expect(Array.isArray(sum.warnings)).toBe(true)
  })
})

describe('the quota alert setting', () => {
  test('quota.alertAt is Everywhere only: 50 to 95 percent, or off; 4b reads it, and a run-out alerts whatever it is', () => {
    expect(src.settings.set('quota.alertAt', '70%', 'all')).toEqual({ ok: true })
    expect(src.settings.get('quota.alertAt')).toBe('70%')
    expect(src.settings.set('quota.alertAt', 'off', 'all')).toEqual({ ok: true })
    expect(src.settings.set('quota.alertAt', '40%', 'all').ok).toBe(false)
    expect(src.settings.set('quota.alertAt', '96%', 'all').ok).toBe(false)
    expect(src.settings.set('quota.alertAt', '70%', { space: 'gtm' }).ok).toBe(false)
    expect(src.settings.set('quota.alertAt', '80%', 'all')).toEqual({ ok: true })
  })
})
