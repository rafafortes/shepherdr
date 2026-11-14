// 0 blocks a model in every role, as the source runs them (source.ts, engine.ts): a coordinator never starts on a blocked
// model, not even past a full cap, and a coordinator whose every model is blocked does not start (its chat says why); a
// takeover skips the blocked backups; the way back never moves an agent to a blocked primary; the advisor whose every
// model is blocked is not asked, and its card says the limits block it. A real LiveSource with its agents' starts and
// status stubbed (no herdr, no CLI run), as caps-coordinator.test.ts does.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { providerOf } from '../server/live/usage-ledger.ts'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('caps-blocked')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { keyOf } = await import('../server/live/models-summary.ts')

const src = new LiveSource()
src.settings.set('machine.startEvery', '0', 'machine')
afterAll(() => src.stop())

const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'
/** the model keys of the CLIs a coordinator starts on here: its primary (pi), and its backup (Codex) */
const PI = keyOf('pi')
const CODEX = keyOf('codex')
/** the blocked-words of a coordinator's refusal, and of its chat card */
/** the mark a cap start on a backup keeps for the way back, as the file has it */
const readJsonCap = (id: string) => (src as unknown as { capStarts: Map<string, unknown> }).capStarts.get(id)
const REFUSED = 'Not started: every model it may use is blocked (0 allowed): change its agent or a limit in Settings → Limits.'

/** the agents this source started, in order */
let starts: { key: string; kind: string; model?: string; first?: string }[] = []
let working = new Set<string>()
let idle = new Set<string>()
const realStatus = src.agents.status.bind(src.agents)

beforeEach(() => {
  starts = []
  working = new Set()
  idle = new Set()
  src.engine.installed = () => true
  src.engine.tasks.length = 0
  for (const k of Object.keys(src.agents.records)) delete src.agents.records[k]
  for (const o of src.returns.list()) src.returns.forget(o.role, o.space)
  src.settings.set('backup.watchReturn', 'go back')
  src.settings.set('task.fallback', 'Codex', 'all')
  src.settings.set('coordinator.fallback', 'Codex', 'all')
  src.settings.set('coordinator.agent', 'pi', 'all')
  src.settings.set('task.agent', 'pi', 'all')
  src.settings.set('models.maxAtOnce', 'off', 'all')
  src.settings.set('models.maxAtOnce', 'off', 'machine')
  src.agents.status = ((k: string) => (working.has(k) ? 'working' : idle.has(k) ? 'idle' : realStatus(k))) as never
  src.agents.ensure = (async (spec: { key: string; kind: string; model?: string; first?: string }) => {
    starts.push({ key: spec.key, kind: spec.kind, ...(spec.model ? { model: spec.model } : {}), ...(spec.first ? { first: spec.first } : {}) })
    src.agents.records[spec.key] = { key: spec.key, name: spec.key, kind: spec.kind, model: spec.model, logs: [], started: Date.now() } as never
    working.add(spec.key)
    return null
  }) as never
  src.agents.restart = (async (spec: { key: string; kind: string; model?: string }, before?: () => Promise<string | void>) => {
    await before?.()
    starts.push({ key: spec.key, kind: spec.kind, ...(spec.model ? { model: spec.model } : {}) })
    src.agents.records[spec.key] = { key: spec.key, name: spec.key, kind: spec.kind, model: spec.model, logs: [], started: Date.now() } as never
    working.add(spec.key)
    return null
  }) as never
})

/** a space (a place's coordinator), as its first start leaves it */
async function space(name: string) {
  const dir = tmp('caps-blocked-repo')
  execSync(REPO, { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, name)
  return { p, id: placeId.space(p.name) }
}

/** the chat's cards, as their words */
const cards = (key: string) => src.chats.chat(key).messages.filter((m) => m.card).map((m) => m.card!.text)

/** a coordinator's first start, as the source makes it (a private method: the test drives it the way a restart does) */
const startCoordinator = (id: string) => (src as unknown as { coordinator(id: string): Promise<unknown> }).coordinator(id).catch((e: Error) => e)

describe('a coordinator never starts on a blocked model', () => {
  test('its primary is blocked: it starts on its backup, and its card says why', async () => {
    src.settings.set('models.maxAtOnce', `${providerOf(PI)}=0`, 'machine')
    const { id } = await space('blk-coord-backup')
    await startCoordinator(id)
    expect(starts.at(-1)).toMatchObject({ key: id, kind: 'codex' })
    expect(cards(id)).toContain('Started on Codex: pi is blocked (0 allowed)')
  })

  test('every model blocked: it does not start, and its chat says why and what to change', async () => {
    src.settings.set('models.maxAtOnce', `${PI}=0, ${CODEX}=0`, 'machine')
    const { id } = await space('blk-coord-none')
    const err = await startCoordinator(id)
    expect(starts.some((s) => s.key === id)).toBe(false)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toStartWith(REFUSED)
    expect(cards(id).at(-1)).toStartWith(REFUSED)
    expect(cards(id).at(-1)).toContain('(blocked · 0 allowed)')
  })

  test('a blocked model is never used, not even while the free one is full: the coordinator waits for the free one', async () => {
    // the primary is blocked, the backup is full (one codex run of this machine): the coordinator does not start, never on
    // the blocked primary and never past the backup's cap; it waits for room on the backup
    src.settings.set('models.maxAtOnce', `${PI}=0, ${CODEX}=1`, 'machine')
    const busy = await space('blk-coord-busy')
    src.agents.records[busy.id] = { key: busy.id, name: 'busy', kind: 'codex', logs: [], started: Date.now() } as never
    working.add(busy.id)
    const { id } = await space('blk-coord-past')
    await startCoordinator(id)
    expect(starts.some((s) => s.key === id)).toBe(false)
    expect(cards(id)).toContain('Not started yet: every model it may use is full or out: Codex (default) (1 of 1 at once). It starts once one has room.')
    // the backup frees: the way back's pass starts it there, never on the blocked primary, and marks the start on a backup
    working.delete(busy.id)
    await src.watchReturns()
    expect(starts.at(-1)).toMatchObject({ key: id, kind: 'codex' })
    expect(starts.some((s) => s.key === id && s.kind === 'pi')).toBe(false)
    expect(readJsonCap(id)).toEqual({ step: 1 })
  })

  test('a start by hand on a blocked model is refused the same way, with a card', async () => {
    src.settings.set('models.maxAtOnce', `${PI}=0`, 'machine')
    const { id } = await space('blk-coord-hand')
    const err = await (src as unknown as { coordinator(id: string, o: { as: { kind: string } }): Promise<unknown> }).coordinator(id, { as: { kind: 'pi' } }).catch((e: Error) => e)
    expect((err as Error).message).toStartWith(REFUSED)
    expect(starts.some((s) => s.key === id)).toBe(false)
  })

  test('a relaunch of a coordinator that is not running is refused on its blocked model; one that runs keeps running', async () => {
    src.settings.set('models.maxAtOnce', `${PI}=0, ${CODEX}=0`, 'machine')
    const { id } = await space('blk-coord-relaunch')
    src.agents.records[id] = { key: id, name: id, kind: 'pi', logs: [], started: Date.now() } as never
    const err = await startCoordinator(id)
    expect((err as Error).message).toStartWith(REFUSED)
    expect(starts.some((s) => s.key === id)).toBe(false)
    // a coordinator at work is not started again: its ensure gives it back as it is, so the block does not refuse it
    working.add(id)
    src.settings.set('models.maxAtOnce', `${PI}=0`, 'machine')
    expect(await startCoordinator(id)).not.toBeInstanceOf(Error)
  })
})

describe('a coordinator’s takeover, and its way back, leave the blocked models alone', () => {
  test('every backup blocked: a cut-off coordinator does not take over, and nothing starts', async () => {
    src.settings.set('models.maxAtOnce', `${CODEX}=0`, 'machine')
    const { id } = await space('blk-take-none')
    src.agents.records[id] = { key: id, name: 'take', kind: 'pi', logs: [], started: Date.now() } as never
    await (src as unknown as { coordinatorCantGoOn(key: string, r: unknown): Promise<void> }).coordinatorCantGoOn(id, { cut: 'c1', tries: 1, reason: 'Out of allowance until 5pm', words: 'out', over: true, lasting: true })
    expect(starts.some((s) => s.key === id)).toBe(false)
    expect(src.agents.tookOver(id)).toBeUndefined()
  })

  test('a blocked backup is skipped for the free one after it, never started past the cap', async () => {
    src.settings.set('models.maxAtOnce', `${CODEX}=0`, 'machine')
    src.settings.set('coordinator.fallback', 'Codex', 'all')
    src.settings.set('coordinator.fallback2', 'pi', 'all')
    const { id } = await space('blk-take-skip')
    src.agents.records[id] = { key: id, name: 'take', kind: 'pi', logs: [], started: Date.now() } as never
    await (src as unknown as { coordinatorCantGoOn(key: string, r: unknown): Promise<void> }).coordinatorCantGoOn(id, { cut: 'c2', tries: 1, reason: 'Out of allowance until 5pm', words: 'out', over: true, lasting: true })
    // the primary is pi, which runs out: Codex is blocked, and the next backup is pi on another model: not Codex
    expect(starts.some((s) => s.kind === 'codex')).toBe(false)
  })

  test('the way back never moves a coordinator to a blocked primary: it stays on its backup', async () => {
    src.settings.set('models.maxAtOnce', `${PI}=1`, 'machine')
    const busy = await space('blk-back-busy')
    src.agents.records[busy.id] = { key: busy.id, name: 'busy', kind: 'pi', logs: [], started: Date.now() } as never
    working.add(busy.id)
    const { id } = await space('blk-back')
    await startCoordinator(id)
    expect(starts.at(-1)).toMatchObject({ key: id, kind: 'codex' })
    // the busy one ends and the coordinator is idle; its primary is blocked now: it stays where it is
    working.delete(busy.id)
    idle.add(busy.id)
    idle.add(id)
    src.settings.set('models.maxAtOnce', `${PI}=0`, 'machine')
    const before = starts.length
    await src.watchReturns()
    expect(starts.slice(before).some((s) => s.key === id)).toBe(false)
  })
})

describe('the advisor whose every model is blocked is not asked', () => {
  test('nothing runs, and the card says the limits block the advisor', async () => {
    const dir = tmp('blk-advisor-repo')
    execSync(REPO, { cwd: dir, shell: '/bin/sh' })
    const p = await src.places.add(dir, 'blk-advisor')
    for (const [k, v] of [['advisor.agent', 'pi'], ['advisor.model', 'opencode-go/deepseek-v4.1-flash'], ['advisor.fallback', 'Codex']])
      expect(src.settings.set(k, v, { space: p.name }).ok).toBe(true)
    const asked: string[] = []
    const was = src.runAdvisor
    src.runAdvisor = (async (h: { kind: string }) => {
      asked.push(h.kind)
      return { ok: false, out: 'nothing' }
    }) as never
    src.settings.set('models.maxAtOnce', `opencode-go=0, ${CODEX}=0`, 'machine')
    try {
      const chat = placeId.space(p.name)
      src.chats.post(chat, { id: 'blk:q1', question: { id: 'blk:q1', title: 'Which store?', kind: 'Form', choices: [{ label: 'SQLite' }, { label: 'Postgres' }], to: chat } } as never)
      expect(await src.advise(chat, 'blk:q1')).toEqual({ ok: true })
      expect(asked).toEqual([])
      expect(src.advices.get(chat, 'blk:q1')!.state).toBe('waiting')
      expect(cards(chat).at(-1)).toBe('The advisor is blocked by the limits: every model it may use is blocked (0 allowed): change its agent or a limit in Settings → Limits.')
    } finally {
      src.runAdvisor = was
      src.settings.set('models.maxAtOnce', 'off', 'machine')
    }
  })
})
