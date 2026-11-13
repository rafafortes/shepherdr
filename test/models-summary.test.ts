// Settings → Models → Summary, the server's side: the configured slots at each place, what runs and waits now, the usage
// and run-outs per provider and per model, the quota slot a read fills (4b), and each warning the rules raise, with the
// cases that must stay silent (a local server, a backup on another provider, a single run-out).
import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { placeId } from '../server/live/places.ts'
import { configuredOf, keyOf, labelOf, LOCAL, modelsSummary, providerName, roleOfChat, titled, type LiveAgent, type SummaryInput, type TaskFact } from '../server/live/models-summary.ts'
import { opencodeList, setModels, type CliModels } from '../server/live/models.ts'
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
    expect(shared[0]!.words).toBe('2 agents on Spark now (q), and no cap holds them: set a cap for it.')
    expect(shared[0]!.fix).toBe('A cap says how many run at once; the others wait for a free slot.')
    expect(shared[0]!.go).toEqual({ row: 'cap', slot: 'spark/q' })
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

describe('the quota side: a provider shows its figure and its read, and a window at the share is a warning', () => {
  const at = NOW + 2 * HOUR
  /** a figure of one window, as a read gave it */
  const fig = (windows: { name: string; usedPct?: number; used?: number; cap?: number; resetAt?: number; left?: number }[], extra: { estimate?: boolean } = {}) => ({ windows, source: 'a read', at: NOW, ...extra })
  // Claude Code runs the gtm space's tasks and coordinators only: that space's two slots are the cells the warning names
  const claudeHome = settings({ everywhere: { 'task.agent': 'pi', 'task.model': GO, 'coordinator.agent': 'pi' }, spaces: { gtm: { 'task.agent': 'Claude Code', 'task.model': 'default', 'coordinator.agent': 'Claude Code' } } })

  test('the figure set for this look wins over the ledger; a read gives its state; no quota side, no read', () => {
    const u = ledger('quota-side')
    u.setQuota('anthropic', fig([{ name: '5 h', usedPct: 12 }]))
    const sum = modelsSummary(input(claudeHome, u, { quota: { figures: { anthropic: fig([{ name: '5 h', usedPct: 40, resetAt: at }]) }, reads: { anthropic: { on: true, tried: NOW, failed: 'not signed in' } } } }))
    expect(provider(sum, 'anthropic').quota).toMatchObject({ windows: [{ name: '5 h', usedPct: 40 }] })
    expect(provider(sum, 'anthropic').quotaRead).toEqual({ on: true, tried: NOW, failed: 'not signed in' })
    const bare = modelsSummary(input(claudeHome, u))
    expect(provider(bare, 'anthropic').quota).toMatchObject({ windows: [{ name: '5 h', usedPct: 12 }] })
    expect(provider(bare, 'anthropic').quotaRead).toBeUndefined()
  })

  test('a window at the share is a note, with what is left, when it refills, and the cells that use the provider most', () => {
    const u = ledger('quota-warn')
    const sum = modelsSummary(input(claudeHome, u, { quota: { figures: { anthropic: fig([{ name: '5 h', usedPct: 85, resetAt: at }, { name: 'Week', usedPct: 41, resetAt: at + 24 * HOUR }]) }, reads: {}, alertAt: 80 } }))
    const w = warn(sum, 'quota:')
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ id: 'quota:anthropic', level: 'note' })
    expect(w[0]!.words).toMatch(/^Claude Code: 5 h is at 85%: 15% left, refills .+\.$/)
    // the gtm space's task and coordinator slots are Claude Code's: the busiest cell opens its primary
    expect(w[0]!.fix).toMatch(/^Most of its slots are Tasks in gtm \(1 slot\) and Coordinators in gtm \(1 slot\)\./)
    expect(w[0]!.go).toEqual({ row: placeId.space('gtm', HOST), slot: 'task.0' })
  })

  test('the share is reached at 100% as a risk; a window that refilled says nothing of now; a count has its share too', () => {
    const u = ledger('quota-risk')
    const risk = modelsSummary(input(claudeHome, u, { quota: { figures: { anthropic: fig([{ name: '5 h', usedPct: 100, resetAt: at }]) }, reads: {}, alertAt: 80 } }))
    expect(warn(risk, 'quota:')[0]).toMatchObject({ level: 'risk' })
    expect(warn(risk, 'quota:')[0]!.words).toMatch(/^Claude Code: 5 h is at 100%: at its limit, refills /)
    const over = modelsSummary(input(claudeHome, u, { quota: { figures: { anthropic: fig([{ name: 'Week', usedPct: 143 }], { estimate: true }) }, reads: {}, alertAt: 80 } }))
    expect(warn(over, 'quota:')[0]!.words).toBe('Claude Code: Week is at 143%: over its limit.')
    const refilled = modelsSummary(input(claudeHome, u, { quota: { figures: { anthropic: fig([{ name: '5 h', usedPct: 99, resetAt: NOW - HOUR }]) }, reads: {}, alertAt: 80 } }))
    expect(warn(refilled, 'quota:')).toEqual([])
    const count = modelsSummary(input(claudeHome, u, { quota: { figures: { anthropic: fig([{ name: 'Team', used: 90, cap: 100 }]) }, reads: {}, alertAt: 80 } }))
    expect(warn(count, 'quota:')[0]!.words).toMatch(/^Claude Code: Team is at 90%: 10% left\.$/)
    // a window with no cap has no share, and a share off warns about nothing
    const left = modelsSummary(input(claudeHome, u, { quota: { figures: { anthropic: fig([{ name: 'Credits', left: 5 }]) }, reads: {}, alertAt: 80 } }))
    expect(warn(left, 'quota:')).toEqual([])
    const off = modelsSummary(input(claudeHome, u, { quota: { figures: { anthropic: fig([{ name: '5 h', usedPct: 99, resetAt: at }]) }, reads: {} } }))
    expect(warn(off, 'quota:')).toEqual([])
  })

  test('a provider with no slot in any space has no cell to point at: its words and its fix still say what to do; a local server is not warned', () => {
    const u = ledger('quota-noslot')
    u.count('T-1/Agent', 'opencode-go/deepseek-v4.1-flash', { id: 'q1', at: NOW - HOUR, tokens: 100 }, NOW)
    const got = modelsSummary(input(settings(), u, { quota: { figures: { 'opencode-go': fig([{ name: '5 h', usedPct: 90, resetAt: at }], { estimate: true }) }, reads: {}, alertAt: 80 } }))
    const w = warn(got, 'quota:')
    expect(w).toHaveLength(1)
    expect(w[0]!.words).toMatch(/^OpenCode Go: 5 h is at 90%/)
    expect(w[0]!.go).toBeUndefined()
    expect(w[0]!.fix).toBe('Give its roles a backup on another provider, or let the window refill before the work does.')
    const local = modelsSummary(input(settings({ everywhere: { 'task.agent': 'pi', 'task.model': 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold' } }), u, { quota: { figures: { spark: fig([{ name: '5 h', usedPct: 99, resetAt: at }]) }, reads: {}, alertAt: 80 } }))
    expect(warn(local, 'quota:')).toEqual([])
  })
})

describe('the providers a CLI offers, nothing uses yet: listed under Other providers, with their models', () => {
  const NV = 'nvidia/mistralai/mistral-large-4-1t-a52b'
  const AMD = 'amd-tokenlab/Qwen3.8-27B'
  /** pi's list as pi gives it: the models of the test, two of which its enabledModels names (the test's own folder); the
   *  task model is one it lists too, so the roles it runs on are known (not pi's default) */
  const PI: CliModels = { models: [NV, AMD, 'spark/qwen3', GO].map((id) => ({ id, label: id, efforts: [] })), efforts: ['off', 'low'] }
  /** pi's catalog with its enabledModels (none: every model it lists), its folder the test's own, for the test's span */
  function withPi(enabled: string[] | undefined, fn: () => void) {
    const dir = tmp('pi-offers')
    if (enabled) writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledModels: enabled }))
    const was = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = dir
    setModels('pi', PI)
    try {
      fn()
    } finally {
      setModels('pi', undefined)
      if (was === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = was
    }
  }
  // every role runs on pi's OpenCode Go model, with no backup: that provider is the one in use, and the others are not
  const roles = { 'task.agent': 'pi', 'task.model': GO, 'task.fallback': 'off', 'coordinator.agent': 'pi', 'coordinator.model': GO, 'reviewer.agent': 'pi', 'reviewer.model': GO }
  const used = settings({ everywhere: roles })
  /** the same roles, with the machine's own or a space's caps */
  const capped = (machine: Record<string, string>, spaces: Record<string, Record<string, string>> = {}) => settings({ everywhere: roles, machine, spaces })

  test("pi's enabled models are offered: nvidia and amd-tokenlab are idle, named, with their models and no numbers", () => {
    withPi([NV, AMD], () => {
      const sum = modelsSummary(input(used, ledger('offer-idle')))
      const nv = provider(sum, 'nvidia')
      expect(nv).toMatchObject({ name: 'NVIDIA API', idle: true, local: false, configured: { primary: 0, backup: 0, roles: {}, spaces: {} }, now: { agents: 0 }, runOuts: { count7d: 0, out: false }, usage: { h24: { tokens: 0, calls: 0 }, d7: { tokens: 0, calls: 0 } } })
      // its models are the ones pi lists, named as the rows name them (the provider in front is already said)
      expect(nv.models.map((m) => [m.key, m.label])).toEqual([[NV, 'mistralai/mistral-large-4-1t-a52b']])
      expect(nv.models[0]!.configured.primary).toBe(0)
      expect(provider(sum, 'amd-tokenlab')).toMatchObject({ name: 'AMD TokenLab', idle: true, models: [{ key: AMD, label: 'Qwen3.8-27B' }] })
      // the used provider lists the models in use only: the offered ones it has no run of stay off its list
      expect(provider(sum, 'opencode-go').models.map((m) => m.key)).toEqual([GO])
      // what pi's enabledModels leaves out is not offered
      expect(sum.providers.map((p) => p.provider)).not.toContain('spark')
      // the providers in use come first, the idle ones after, by name
      expect(sum.providers.filter((p) => !p.idle).map((p) => p.provider)).toEqual(['opencode-go'])
      // by the name the row shows: AMD TokenLab, Claude Code, Codex, NVIDIA API
      expect(sum.providers.map((p) => p.provider).slice(1)).toEqual(['amd-tokenlab', 'anthropic', 'openai', 'nvidia'])
    })
  })

  test('with no enabledModels, every model pi lists is offered, a local one too (local, no quota)', () => {
    withPi(undefined, () => {
      const sum = modelsSummary(input(used, ledger('offer-all')))
      expect(provider(sum, 'spark')).toMatchObject({ name: 'Spark (local)', local: true, idle: true, models: [{ key: 'spark/qwen3', label: 'qwen3' }] })
      expect(provider(sum, 'nvidia').idle).toBe(true)
    })
  })

  test("an idle Claude Code and Codex list their own catalogs under anthropic and openai, their models' names as Settings has them", () => {
    const sum = modelsSummary(input(used, ledger('offer-claude')))
    expect(provider(sum, 'anthropic')).toMatchObject({ name: 'Claude Code', idle: true })
    expect(provider(sum, 'anthropic').models.map((m) => m.label)).toEqual(['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'])
    expect(provider(sum, 'openai')).toMatchObject({ name: 'Codex', idle: true })
    expect(provider(sum, 'openai').models.map((m) => m.key)).toContain('openai/gpt-6-sol')
  })

  test("OpenCode's providers are named as the map names them, its Zen models listed while nothing uses them", () => {
    setModels('opencode', opencodeList([{ id: 'opencode/minimax-m3.1-flash-free', label: 'opencode/minimax-m3.1-flash-free', efforts: [] }], undefined))
    try {
      const sum = modelsSummary(input(used, ledger('offer-zen')))
      expect(provider(sum, 'opencode')).toMatchObject({ name: 'OpenCode Zen (free)', idle: true, models: [{ key: 'opencode/minimax-m3.1-flash-free', label: 'minimax-m3.1-flash-free' }] })
    } finally {
      setModels('opencode', undefined)
    }
  })

  test('a cap set on an idle provider, or on one of its models, puts it in use: its row carries the cap and it moves up', () => {
    withPi([NV, AMD], () => {
      const sum = modelsSummary(input(capped({ 'models.maxAtOnce': 'nvidia=2' }), ledger('offer-cap')))
      const nv = provider(sum, 'nvidia')
      expect(nv).toMatchObject({ idle: false, atOnce: { now: 0, held: 0, own: { pattern: 'nvidia', max: 2, from: 'machine' } } })
      // capped, it still lists every model its CLI offers: the cap is set where its models are, and they stay there
      expect(nv.models.map((m) => m.key)).toEqual([NV])
      // in use now, it sits with the providers in use, before the idle ones
      expect(sum.providers.findIndex((p) => p.provider === 'nvidia')).toBeLessThan(sum.providers.findIndex((p) => p.provider === 'amd-tokenlab'))
      // a model's cap on an idle provider makes that model, and so its provider, in use
      const model = modelsSummary(input(capped({ 'models.maxAtOnce': `${AMD}=1` }), ledger('offer-cap-model')))
      // the cap is written in lowercase, as the text keeps it: the model's row still finds it
      expect(provider(model, 'amd-tokenlab')).toMatchObject({ idle: false, models: [{ key: AMD, atOnce: { own: { pattern: 'amd-tokenlab/qwen3.8-27b', max: 1 } } }] })
      // a space's own sub-limit is a cap too
      const spaced = modelsSummary(input(capped({}, { gtm: { 'models.maxAtOnce': 'nvidia=1' } }), ledger('offer-cap-space')))
      expect(provider(spaced, 'nvidia')).toMatchObject({ idle: false, atOnce: { spaces: [{ key: 'gtm', max: 1, now: 0 }] } })
    })
  })

  test("a provider in use by its slot lists the model in use; with a cap of its own it lists every model its CLI offers", () => {
    // Claude Code runs the task agent on its Opus only: anthropic is in use, and its list is that one model
    const claude = { 'task.agent': 'Claude Code', 'task.model': 'Opus 5.5', 'task.fallback': 'off', 'coordinator.agent': 'pi', 'coordinator.model': GO, 'reviewer.agent': 'pi', 'reviewer.model': GO }
    const plain = modelsSummary(input(settings({ everywhere: claude }), ledger('offer-used')))
    expect(provider(plain, 'anthropic')).toMatchObject({ idle: false })
    expect(provider(plain, 'anthropic').models.map((m) => m.key)).toEqual([`anthropic/${CLAUDE}`])
    // its own cap: the row lists the four models Claude Code offers, the cap cell of each among them
    const capped = modelsSummary(input(settings({ everywhere: claude, machine: { 'models.maxAtOnce': 'anthropic=2' } }), ledger('offer-used-cap')))
    expect(provider(capped, 'anthropic')).toMatchObject({ idle: false, atOnce: { own: { pattern: 'anthropic', max: 2 } } })
    expect(provider(capped, 'anthropic').models.map((m) => m.label)).toEqual(['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'])
  })

  test('a provider with no name in the map gets its id in words, and the acronyms of its name stay upper-cased', () => {
    expect(titled('acme-lab')).toBe('Acme Lab')
    expect(titled('some_new-ai_api')).toBe('Some New AI API')
    expect(titled('amd-tokenlab')).toBe('AMD Tokenlab')
    expect(titled('--nvidia--cloud')).toBe('NVIDIA Cloud')
    expect(titled('')).toBe('')
    expect(providerName('amd-tokenlab')).toBe('AMD TokenLab')
    expect(providerName('acme-lab')).toBe('Acme Lab')
    // the map names what it names; an id the map has none for is its words, not "constructor" or "toString" in words
    expect(providerName('constructor')).toBe('Constructor')
    withPi([`acme-lab/model-x`], () => {
      setModels('pi', { models: [{ id: 'acme-lab/model-x', label: 'acme-lab/model-x', efforts: [] }], efforts: [] })
      const sum = modelsSummary(input(used, ledger('offer-fallback')))
      expect(provider(sum, 'acme-lab')).toMatchObject({ name: 'Acme Lab', idle: true })
    })
  })
})
