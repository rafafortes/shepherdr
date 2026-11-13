// Settings → Models → Summary, the server's side: the configured slots at each place, what runs and waits now, the usage
// and run-outs per provider and per model, the quota slot a read fills (4b), and each warning the rules raise, with the
// cases that must stay silent (a local server, a backup on another provider, a single run-out).
import { describe, expect, test } from 'bun:test'
import { placeId } from '../server/live/places.ts'
import { configuredOf, keyOf, labelOf, LOCAL, modelsSummary, roleOfChat, type LiveAgent, type SummaryInput, type TaskFact } from '../server/live/models-summary.ts'
import { Settings } from '../server/live/settings.ts'
import { HOUR, UsageLedger, type RunOut } from '../server/live/usage-ledger.ts'
import { tmp } from './tmp.ts'

const NOW = Date.now()
const HOST = 'box'
// the home space first, as the table lists it (matrixSpaces): its own values read like any space's
const SPACES = [
  { key: '~', name: 'home' },
  { key: 'gtm', name: 'gtm' },
  { key: 'docs', name: 'Docs site' },
]
const GO = 'opencode-go/deepseek-v4.1-flash'
const CLAUDE = 'claude-opus-5-5'

/** a Settings world of its own: the values as written at each level */
const settings = (seed: Partial<{ everywhere: Record<string, string>; machine: Record<string, string>; spaces: Record<string, Record<string, string>> }> = {}) => new Settings({ everywhere: {}, machine: {}, spaces: {}, ...seed })
const ledger = (name: string) => new UsageLedger(tmp(name), true)
/** a call of a model, h hours ago */
const call = (l: UsageLedger, key: string, h: number, tokens = 100, cost?: number, chat = 'T-1/Agent') => l.count(chat, key, { id: `${key}-${h}-${tokens}-${chat}`, at: NOW - h * HOUR + 1000, tokens, ...(cost !== undefined ? { cost } : {}) }, NOW)
const runOut = (l: UsageLedger, key: string, h: number, extra: Partial<RunOut> = {}) => l.runOut({ at: NOW - h * HOUR, key, chat: 'T-1/Agent', role: 'task', reason: 'Out of allowance', words: '', ...extra }, NOW)

/** the input the summary reads, from the parts a test sets */
function input(s: Settings, u: UsageLedger, over: Partial<SummaryInput> = {}): SummaryInput {
  return {
    now: NOW,
    settings: s,
    host: HOST,
    spaces: SPACES,
    rows: [placeId.space('gtm', HOST), placeId.space('docs', HOST), placeId.machine(HOST), 'all'],
    usage: u,
    agents: [],
    tasks: [],
    watch: [],
    ...over,
  }
}
const provider = (sum: ReturnType<typeof modelsSummary>, name: string) => sum.providers.find((p) => p.provider === name)!
const warn = (sum: ReturnType<typeof modelsSummary>, prefix: string) => sum.warnings.filter((w) => w.id.startsWith(prefix))

describe('what is configured, read at each space', () => {
  test('each slot counts where its settings read it: a space that inherits counts too, an off backup does not', () => {
    const s = settings({
      everywhere: { 'task.agent': 'pi', 'task.model': GO, 'task.fallback': 'Claude Code', 'task.fallbackModel': 'default', 'coordinator.agent': 'Claude Code', 'coordinator.model': CLAUDE, 'reviewer.agent': 'Codex', 'reviewer.model': 'gpt-6-sol' },
      spaces: { gtm: { 'task.agent': 'pi', 'task.model': 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold', 'task.fallback': 'off' } },
    })
    const conf = configuredOf(s, SPACES)
    const gtm = conf.filter((c) => c.spaceKey === 'gtm')
    expect(gtm.find((c) => c.role === 'task' && c.n === 0)?.key).toBe('spark/qwen3.8-flash-next-mlx4-mtp-tensorfold')
    expect(gtm.some((c) => c.role === 'task' && c.n === 1)).toBe(false)
    const docs = conf.filter((c) => c.spaceKey === 'docs')
    expect(docs.find((c) => c.role === 'task' && c.n === 0)?.key).toBe(GO)
    // a backup on Claude Code that follows the tasks' model (a pi one) starts on Claude's own default, not on that name
    expect(docs.find((c) => c.role === 'task' && c.n === 1)?.key).toBe(`anthropic/${CLAUDE}`)
    expect(docs.find((c) => c.role === 'reviewer')?.key).toBe('openai/gpt-6-sol')
    expect(keyOf('claude', 'default')).toBe(`anthropic/${CLAUDE}`)
    expect(keyOf('pi', 'opencode-go/deepseek-v4.1-flash')).toBe(GO)
    expect(roleOfChat('T-1/Reviewer')).toBe('reviewer')
    expect(roleOfChat('T-1/Agent')).toBe('task')
    expect(roleOfChat('p:box:gtm')).toBe('coordinator')
    expect(labelOf(`anthropic/${CLAUDE}`)).toBe('Opus 5.5')
    expect(labelOf('spark/qwen3')).toBe('qwen3')
    // pi's own list names its models with the provider in front: the row under the provider says that already
    expect(labelOf('opencode-go/deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash')
    // a CLI's default model is not named in its log: the provider says which one
    expect(labelOf('openai/unknown')).toBe('Codex default')
    expect(LOCAL.has('spark')).toBe(true)
  })
})

describe('the summary: providers, models, usage, run-outs, what runs now', () => {
  test('a provider row counts its slots, its agents and its waiting tasks, its usage in each window, and its share', () => {
    const s = settings({ everywhere: { 'task.agent': 'pi', 'task.model': GO, 'coordinator.agent': 'Claude Code', 'coordinator.model': CLAUDE, 'task.fallback': 'off', 'coordinator.fallback': 'off' } })
    const u = ledger('sum-rows')
    call(u, GO, 2, 300, 0.25)
    call(u, GO, 20, 100)
    call(u, `anthropic/${CLAUDE}`, 3, 600)
    call(u, `anthropic/${CLAUDE}`, 100, 50)
    const agents: LiveAgent[] = [
      { key: 'T-1/Agent', kind: 'pi', model: GO, status: 'working' },
      { key: 'T-2/Agent', kind: 'pi', model: GO, status: 'idle' },
      { key: 'T-2/Reviewer', kind: 'claude', model: CLAUDE, status: 'working' },
      { key: 'p:box:gtm', kind: 'claude', model: CLAUDE, status: 'idle' },
      { key: 'T-9/Agent', kind: 'pi', model: GO, status: 'gone' },
    ]
    const tasks: TaskFact[] = [
      { status: 'queued', agent: { kind: 'pi', model: GO }, reviewer: { kind: 'claude', model: CLAUDE } },
      { status: 'todo', agent: { kind: 'pi', model: GO } },
      { status: 'scheduled', agent: { kind: 'claude', model: CLAUDE } },
      { status: 'done', reviewer: { kind: 'claude', model: CLAUDE } },
    ]
    const sum = modelsSummary(input(s, u, { agents, tasks }))
    const go = provider(sum, 'opencode-go')
    expect(go).toMatchObject({ name: 'OpenCode Go', local: false })
    expect(go.configured).toEqual({ primary: 3, backup: 0, roles: { task: 3 }, spaces: { gtm: 1, 'Docs site': 1, home: 1 } })
    expect(go.now).toEqual({ agents: 2, working: 1, roles: { task: 2 }, starts: 2, reviews: 0 })
    expect(go.usage.h5).toEqual({ tokens: 300, calls: 1, cost: 0.25 })
    expect(go.usage.h24).toEqual({ tokens: 400, calls: 2, cost: 0.25 })
    expect(go.usage.d7).toEqual({ tokens: 400, calls: 2, cost: 0.25 })
    const claude = provider(sum, 'anthropic')
    expect(claude.name).toBe('Claude Code')
    expect(claude.now.reviews).toBe(1)
    expect(claude.now.agents).toBe(2)
    expect(claude.now.roles).toEqual({ reviewer: 1, coordinator: 1 })
    expect(claude.usage.h24).toEqual({ tokens: 600, calls: 1 })
    expect(claude.usage.d7).toEqual({ tokens: 650, calls: 2 })
    // the shares of the day and of the week, of all tokens
    expect(go.share.h24).toBeCloseTo(400 / 1000)
    expect(claude.share.d7).toBeCloseTo(650 / 1050)
    expect(go.share.d7).toBeCloseTo(400 / 1050)
    // the providers, by week's tokens: Claude Code first; Codex is the reviewer's default, configured and unused
    expect(sum.providers.map((p) => p.provider)).toEqual(['anthropic', 'opencode-go', 'openai'])
    expect(provider(sum, 'openai').configured).toEqual({ primary: 3, backup: 0, roles: { reviewer: 3 }, spaces: { home: 1, gtm: 1, 'Docs site': 1 } })
    // the models under each, with their labels and their own rows
    expect(go.models.map((m) => [m.key, m.label, m.configured.primary])).toEqual([[GO, 'deepseek-v4.1-flash', 3]])
    expect(claude.models[0]).toMatchObject({ key: `anthropic/${CLAUDE}`, label: 'Opus 5.5' })
    expect(sum.at).toBe(NOW)
    expect(sum.backfilled).toBeUndefined()
  })

  test('the quota slot: a provider shows the figure its read set, and none where no read set one', () => {
    const s = settings({ everywhere: { 'task.agent': 'pi', 'task.model': GO } })
    const u = ledger('sum-quota')
    call(u, GO, 1)
    expect(provider(modelsSummary(input(s, u)), 'opencode-go').quota).toBeUndefined()
    u.setQuota('opencode-go', { windows: [{ name: '5 h', usedPct: 62, resetAt: NOW + HOUR }], source: 'a read', at: NOW, estimate: true })
    expect(provider(modelsSummary(input(s, u)), 'opencode-go').quota).toEqual({ windows: [{ name: '5 h', usedPct: 62, resetAt: NOW + HOUR }], source: 'a read', at: NOW, estimate: true })
  })

  test('a provider that only ran out in the week shows, with its last run-out, its reset, and whether it is out now', () => {
    const s = settings({ everywhere: { 'task.agent': 'pi', 'task.model': GO } })
    const u = ledger('sum-runouts')
    runOut(u, GO, 30 * 24, { reason: 'Out of credit', reset: '11 Nov, 17:44 GMT-3', resetAt: NOW - 20 * HOUR })
    runOut(u, GO, 2, { reason: 'Out of allowance until 5pm', reset: '5pm', resetAt: NOW + 3 * HOUR })
    const sum = modelsSummary(input(s, u))
    const go = provider(sum, 'opencode-go')
    expect(go.runOuts.count7d).toBe(1)
    expect(go.runOuts.out).toBe(true)
    expect(go.runOuts.until).toBe(NOW + 3 * HOUR)
    expect(go.runOuts.last).toMatchObject({ reason: 'Out of allowance until 5pm', reset: '5pm', model: GO, role: 'task' })
    expect(go.models[0]!.runOuts).toMatchObject({ count7d: 1, out: true })
    // the reset passes: the provider is back
    const later = modelsSummary({ ...input(s, u), now: NOW + 4 * HOUR })
    expect(provider(later, 'opencode-go').runOuts.out).toBe(false)
    expect(provider(later, 'opencode-go').runOuts.until).toBeUndefined()
  })

  test('an open outage of the return watch keeps its provider out until the primary is seen back', () => {
    const s = settings({ everywhere: { 'task.agent': 'pi', 'task.model': GO } })
    const u = ledger('sum-watch')
    call(u, GO, 1)
    runOut(u, GO, 3)
    const open = modelsSummary(input(s, u, { watch: [{ key: GO }] }))
    expect(provider(open, 'opencode-go').runOuts.out).toBe(true)
    // the watch saw it back after the run-out: not out
    const back = modelsSummary(input(s, u, { watch: [{ key: GO, back: NOW - HOUR }] }))
    expect(provider(back, 'opencode-go').runOuts.out).toBe(false)
  })

  test('the backfill is shown once it is done', () => {
    const u = ledger('sum-backfill')
    u.markBackfilled(NOW - 5)
    expect(modelsSummary(input(settings(), u)).backfilled).toBe(NOW - 5)
  })
})

describe('the warnings: what the rules raise, with its fix', () => {
  test('a role whose primary and every backup sit on providers out right now is a risk, with a button to its backup', () => {
    const s = settings({
      everywhere: { 'task.agent': 'pi', 'task.model': GO, 'task.fallback': 'Claude Code', 'backup.model': 'default' },
      spaces: { gtm: { 'task.agent': 'pi', 'task.model': GO, 'task.fallback': 'off' } },
    })
    const u = ledger('warn-out')
    runOut(u, GO, 2, { reason: 'Out of allowance until 5pm', resetAt: NOW + 3 * HOUR })
    runOut(u, `anthropic/${CLAUDE}`, 1, { reason: 'Out of credit', resetAt: undefined })
    const sum = modelsSummary(input(s, u))
    const out = warn(sum, 'out:')
    // gtm: its primary alone, on OpenCode Go, which is out
    const gtm = out.find((w) => w.id === 'out:gtm:task')!
    expect(gtm.level).toBe('risk')
    expect(gtm.words).toContain('Tasks in gtm')
    expect(gtm.words).toContain('OpenCode Go: out of allowance until 5pm')
    expect(gtm.fix).toContain('backup on another provider')
    expect(gtm.go).toEqual({ row: placeId.space('gtm', HOST), slot: 'task.1' })
    // docs: a Claude backup, out too, but the primary is on OpenCode Go (out) and the backup Claude (out): every one out
    expect(out.find((w) => w.id === 'out:docs:task')).toBeDefined()
    expect(out.find((w) => w.id === 'out:docs:task')!.go).toEqual({ row: placeId.space('docs', HOST), slot: 'task.1' })
  })

  test('a backup on a provider that works keeps the role out of the warning; a local primary is never out-warned by a cloud run-out', () => {
    const s = settings({
      everywhere: { 'task.agent': 'pi', 'task.model': GO, 'task.fallback': 'pi', 'backup.model': 'spark/qwen3' },
      spaces: { docs: { 'task.agent': 'pi', 'task.model': 'spark/qwen3', 'task.fallback': 'off' } },
    })
    const u = ledger('warn-out-ok')
    runOut(u, GO, 2, { resetAt: NOW + 3 * HOUR })
    call(u, 'spark/qwen3', 1)
    const sum = modelsSummary(input(s, u))
    expect(warn(sum, 'out:gtm')).toEqual([])
    expect(warn(sum, 'out:docs')).toEqual([])
    expect(sum.warnings.some((w) => w.id.startsWith('same:'))).toBe(false)
  })

  test('a backup that is the primary\'s model on a cloud provider is a note, with its slot; a local one is not', () => {
    const s = settings({
      everywhere: { 'task.agent': 'Claude Code', 'task.model': CLAUDE, 'task.fallback': 'Claude Code', 'backup.model': 'Opus 5.5' },
      spaces: { docs: { 'task.agent': 'pi', 'task.model': 'spark/q', 'task.fallback': 'pi', 'backup.model': 'spark/q' } },
    })
    const sum = modelsSummary(input(s, ledger('warn-same')))
    const same = warn(sum, 'same:')
    // gtm and the home space both inherit it; docs runs its backup on a local server, which is no quota
    expect(same.map((w) => w.id).sort()).toEqual(['same:gtm:task:1', 'same:~:task:1'])
    expect(same.find((w) => w.id === 'same:gtm:task:1')).toMatchObject({ level: 'note', go: { row: placeId.space('gtm', HOST), slot: 'task.1' } })
    // the home space has no row of its own: its button opens this machine's row, where its settings are set
    expect(same.find((w) => w.id === 'same:~:task:1')!.go).toEqual({ row: placeId.machine(HOST), slot: 'task.1' })
    expect(same[0]!.words).toContain('Opus 5.5')
  })

  test('two or more roles on one cloud provider, with no backup elsewhere, is a note; a local server is not', () => {
    const s = settings({
      everywhere: { 'task.agent': 'Claude Code', 'task.model': CLAUDE, 'coordinator.agent': 'Claude Code', 'coordinator.model': CLAUDE, 'reviewer.agent': 'Claude Code', 'reviewer.model': CLAUDE, 'task.fallback': 'off', 'coordinator.fallback': 'off' },
      spaces: { docs: { 'task.agent': 'pi', 'task.model': 'spark/q', 'coordinator.agent': 'pi', 'coordinator.model': 'spark/q', 'reviewer.agent': 'pi', 'reviewer.model': 'spark/q' } },
    })
    const sum = modelsSummary(input(s, ledger('warn-single')))
    const single = warn(sum, 'single:')
    expect(single.map((w) => w.id).sort()).toEqual(['single:gtm', 'single:~'])
    expect(single.find((w) => w.id === 'single:gtm')).toMatchObject({ level: 'note', go: { row: placeId.space('gtm', HOST), slot: 'task.1' } })
    expect(single.find((w) => w.id === 'single:gtm')!.words).toContain('Every role in gtm runs on Claude Code')
    // one role alone is no single point of failure
    const one = settings({ everywhere: { 'task.agent': 'Claude Code', 'task.model': CLAUDE, 'task.fallback': 'off', 'coordinator.agent': 'off', 'reviewer.agent': 'off' } })
    expect(warn(modelsSummary(input(one, ledger('warn-one'))), 'single:')).toEqual([])
  })

  test('a provider that ran out twice in the week is a note; once is not', () => {
    const s = settings({ everywhere: { 'task.agent': 'pi', 'task.model': GO } })
    const twice = ledger('warn-twice')
    runOut(twice, GO, 5, { reason: 'Out of allowance', resetAt: NOW - HOUR })
    runOut(twice, GO, 1, { reason: 'Out of allowance until 5pm' })
    const w = warn(modelsSummary(input(s, twice)), 'runouts:')
    expect(w.map((x) => x.id)).toEqual(['runouts:opencode-go'])
    expect(w[0]).toMatchObject({ level: 'note' })
    expect(w[0]!.words).toContain('OpenCode Go ran out 2 times in the last 7 days; the last was out of allowance until 5pm.')
    expect(w[0]!.go).toBeUndefined()
    const once = ledger('warn-once')
    runOut(once, GO, 1)
    expect(warn(modelsSummary(input(s, once)), 'runouts:')).toEqual([])
  })

  test('a local model that several agents work on is counted, with no limit set; one agent alone is not', () => {
    const s = settings({ everywhere: { 'task.agent': 'pi', 'task.model': 'spark/q' } })
    const agents: LiveAgent[] = [
      { key: 'T-1/Agent', kind: 'pi', model: 'spark/q', status: 'working' },
      { key: 'T-2/Agent', kind: 'pi', model: 'spark/q', status: 'working' },
      { key: 'T-3/Agent', kind: 'pi', model: 'spark/q', status: 'idle' },
    ]
    const shared = warn(modelsSummary(input(s, ledger('warn-shared'), { agents })), 'shared:')
    expect(shared.map((w) => w.id)).toEqual(['shared:spark/q'])
    expect(shared[0]!.words).toBe('2 agents on Spark now (q): the model is shared, and Shepherdr sets no limit for it yet.')
    expect(shared[0]!.fix).toBeUndefined()
    expect(warn(modelsSummary(input(s, ledger('warn-shared-one'), { agents: agents.slice(0, 1) })), 'shared:')).toEqual([])
  })

  test('risks come before notes', () => {
    const s = settings({ everywhere: { 'task.agent': 'pi', 'task.model': GO, 'task.fallback': 'pi', 'backup.model': GO } })
    const u = ledger('warn-order')
    runOut(u, GO, 2, { resetAt: NOW + HOUR })
    runOut(u, GO, 1, { resetAt: NOW + HOUR })
    const levels = modelsSummary(input(s, u)).warnings.map((w) => w.level)
    expect(levels[0]).toBe('risk')
    expect(levels.includes('note')).toBe(true)
  })
})
