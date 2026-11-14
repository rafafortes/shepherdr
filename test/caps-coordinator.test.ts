// The caps for coordinators, and the way back for a cap start (source.ts coordinator, coordinatorStart, coordinatorCantGoOn,
// coordinatorsWaiting, backFromCap): a coordinator's first start takes the first harness of its chain with room, or waits
// for one (never past a cap, never onto a provider that is out) and starts once one has room; its takeover takes the first
// backup with room, or waits for one the same way; a start by hand or a relaunch on a full model is refused; a task or
// coordinator a cap put on a backup goes back to its primary once it is idle and the primary has room. A real LiveSource,
// its agents' starts and status stubbed (no herdr, no CLI run).
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { readJson } from '../server/store.ts'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('caps-coordinator')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
/** waits until a condition holds (the starts are asynchronous: a worktree is made first) */
const until = async (f: () => boolean, ms = 8000) => {
  const t0 = Date.now()
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await Bun.sleep(20)
  }
}

const src = new LiveSource()
src.settings.set('machine.startEvery', '0', 'machine')
afterAll(() => src.stop())

const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'
const SPARK = 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold'

/** the agents this source started (its coordinators' and tasks' spawns), in order */
let starts: { key: string; kind: string; model?: string; first?: string }[] = []
/** the keys the test says are working (a status the real herdr would report) */
let working = new Set<string>()
/** the keys the test says are idle */
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

/** a place's coordinator (a space), as its first start leaves it */
async function space(name: string) {
  const dir = tmp('caps-coord-repo')
  execSync(REPO, { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, name)
  return { p, id: placeId.space(p.name) }
}

/** the chat's cards, as their words */
const cards = (key: string) => src.chats.chat(key).messages.filter((m) => m.card).map((m) => m.card!.text)

/** a coordinator's start, as the source makes it (a private method: the test drives it the way a restart does) */
const startCoordinator = (id: string) => (src as unknown as { coordinator(id: string): Promise<unknown> }).coordinator(id).catch(() => undefined)

describe('a coordinator starts on the caps: the first harness with room, or it waits for one', () => {
  test('its primary is full: its first start is on its backup, with a card that says why', async () => {
    // a pi coordinator of another space is working on the provider pi (its key is pi/unknown): the cap is full
    src.settings.set('models.maxAtOnce', 'pi/unknown=1', 'machine')
    const busy = await space('caps-busy')
    src.agents.records[busy.id] = { key: busy.id, name: 'busy', kind: 'pi', logs: [], started: Date.now() } as never
    working.add(busy.id)
    const { id } = await space('caps-first')
    await startCoordinator(id)
    expect(starts.at(-1)).toMatchObject({ key: id, kind: 'codex' })
    expect(cards(id)).toContain('Started on Codex: pi/unknown is at its limit (1 of 1 at once)')
  })

  test('every harness full: it does not start, its chat says it waits, and the way back starts it once one has room', async () => {
    src.settings.set('models.maxAtOnce', 'pi/unknown=1, codex=1', 'machine')
    const busy = await space('caps-busy-2')
    src.agents.records[busy.id] = { key: busy.id, name: 'busy', kind: 'pi', logs: [], started: Date.now() } as never
    working.add(busy.id)
    const codex = await space('caps-busy-3')
    src.agents.records[codex.id] = { key: codex.id, name: 'busy3', kind: 'codex', logs: [], started: Date.now() } as never
    working.add(codex.id)
    const { id } = await space('caps-past')
    await startCoordinator(id)
    // asked again while it waits (news for it, say): still nothing, and no second card
    await startCoordinator(id)
    expect(starts.some((x) => x.key === id)).toBe(false)
    const waits = 'Not started yet: every model it may use is full or out: pi (default) (1 of 1 at once), Codex (default) (1 of 1 at once). It starts once one has room.'
    expect(cards(id).filter((c) => c === waits)).toHaveLength(1)
    expect(readJson<Record<string, unknown>>('cap-waits.json', {})[id]).toMatchObject({ kind: 'start' })
    // still full at the next pass: it waits on
    await src.watchReturns()
    expect(starts.some((x) => x.key === id)).toBe(false)
    // the codex one ends: the pass starts it on its backup, the first of its chain with room, and its wait is over
    working.delete(codex.id)
    await src.watchReturns()
    expect(starts.at(-1)).toMatchObject({ key: id, kind: 'codex' })
    expect(readJson<Record<string, unknown>>('cap-waits.json', {})[id]).toBeUndefined()
  })

  test('a wait whose start fails is logged, and a wait over by itself (its place gone, or its coordinator running) is dropped', async () => {
    src.settings.set('models.maxAtOnce', 'pi/unknown=1, codex=0', 'machine')
    const busy = await space('caps-wfail-busy')
    src.agents.records[busy.id] = { key: busy.id, name: 'busy', kind: 'pi', logs: [], started: Date.now() } as never
    working.add(busy.id)
    const { id } = await space('caps-wfail')
    await startCoordinator(id)
    expect(starts.some((x) => x.key === id)).toBe(false)
    const waits = (src as unknown as { capWaits: Map<string, unknown> }).capWaits
    waits.set('p:gone:nowhere', { kind: 'start', at: Date.now() })
    const other = await space('caps-wfail-other')
    src.agents.records[other.id] = { key: other.id, name: 'other', kind: 'pi', logs: [], started: Date.now() } as never
    idle.add(other.id)
    waits.set(other.id, { kind: 'start', at: Date.now() })
    // room on pi now, but the start throws: the wait is over and the log says why
    working.delete(busy.id)
    const ensure = src.agents.ensure
    src.agents.ensure = (async () => {
      throw new Error('herdr is not answering')
    }) as never
    const errors: string[] = []
    const was = console.error
    console.error = (...a: unknown[]) => void errors.push(a.join(' '))
    try {
      await src.watchReturns()
    } finally {
      console.error = was
      src.agents.ensure = ensure
    }
    expect(errors.some((e) => e.includes(`couldn't start ${id}'s agent: herdr is not answering`))).toBe(true)
    expect(waits.has(id)).toBe(false)
    expect(waits.has('p:gone:nowhere')).toBe(false)
    expect(waits.has(other.id)).toBe(false)
  })

  test('a start by hand on a full model is refused with a card, and nothing waits; one on a model with room starts with no card', async () => {
    src.settings.set('models.maxAtOnce', 'pi/unknown=1', 'machine')
    const busy = await space('caps-busy-4')
    src.agents.records[busy.id] = { key: busy.id, name: 'busy', kind: 'pi', logs: [], started: Date.now() } as never
    working.add(busy.id)
    const { id } = await space('caps-manual')
    src.agents.records[id] = { key: id, name: 'manual', kind: 'codex', logs: [], started: Date.now() } as never
    const as = (kind: string) => (src as unknown as { coordinator(id: string, o: { as: { kind: string } }): Promise<unknown> }).coordinator(id, { as: { kind } }).catch((e: Error) => e)
    const err = await as('pi')
    expect((err as Error).message).toBe('Not started: pi/unknown is at its limit (1 of 1 at once): wait for a free slot, or pick another model.')
    expect(starts.some((x) => x.key === id)).toBe(false)
    expect(cards(id)).toContain('Not started: pi/unknown is at its limit (1 of 1 at once): wait for a free slot, or pick another model.')
    expect((src as unknown as { capWaits: Map<string, unknown> }).capWaits.has(id)).toBe(false)
    await as('codex')
    expect(starts.at(-1)).toMatchObject({ key: id, kind: 'codex' })
    expect(cards(id).filter((c) => c.startsWith('Started on'))).toEqual([])
  })

  test('a relaunch of a stopped coordinator on a full model waits, without a try counted, and goes once its model has room', async () => {
    src.settings.set('models.maxAtOnce', 'pi/unknown=1', 'machine')
    const busy = await space('caps-revive-busy')
    src.agents.records[busy.id] = { key: busy.id, name: 'busy', kind: 'pi', logs: [], started: Date.now() } as never
    working.add(busy.id)
    const { id } = await space('caps-revive')
    // a coordinator that stopped (its pane is gone) on pi, the full model
    src.agents.records[id] = { key: id, name: 'revive', kind: 'pi', logs: [], started: Date.now() } as never
    const s = src as unknown as { revivals: unknown; revive(now?: number): Promise<void> }
    const { Revivals } = await import('../server/live/revive.ts')
    const was = { revivals: s.revivals, wrong: src.agents.wrong, reachable: src.agents.reachable, lastReach: src.agents.lastReach, relaunch: src.agents.relaunch }
    s.revivals = new Revivals({ grace: 0, gaps: [0], steady: 60_000 })
    src.agents.wrong = (async (k: string) => (k === id ? 'gone' : undefined)) as never
    src.agents.reachable = true
    src.agents.lastReach = Date.now()
    src.agents.relaunch = (async (_k: string, _close: boolean, start: () => Promise<unknown>) => void (await start())) as never
    try {
      await s.revive()
      await s.revive()
      expect(starts.some((x) => x.key === id)).toBe(false)
      const held = 'Its agent stopped, and starts again once its model has room: pi/unknown is at its limit (1 of 1 at once).'
      expect(cards(id).filter((c) => c === held)).toHaveLength(1)
      // the busy one ends: the next look starts it again on its own model (no try was spent waiting)
      working.delete(busy.id)
      await s.revive()
      await until(() => starts.some((x) => x.key === id))
      expect(starts.at(-1)).toMatchObject({ key: id, kind: 'pi' })
    } finally {
      Object.assign(src.agents, { wrong: was.wrong, reachable: was.reachable, lastReach: was.lastReach, relaunch: was.relaunch })
      s.revivals = was.revivals
    }
  })
})

describe("a coordinator's takeover: the first backup with room, or it waits for one", () => {
  const cantGoOn = (id: string, cut = 'c1') => (src as unknown as { coordinatorCantGoOn(key: string, r: unknown): Promise<void> }).coordinatorCantGoOn(id, { cut, tries: 1, reason: 'Out of allowance until 5pm', words: 'out', over: true, lasting: true })

  test('its backup is full: no takeover past the cap; the cut-off card says it waits, and it takes over once the backup has room', async () => {
    src.settings.set('models.maxAtOnce', 'codex=1', 'machine')
    const busy = await space('caps-take-busy')
    src.agents.records[busy.id] = { key: busy.id, name: 'busy', kind: 'codex', logs: [], started: Date.now() } as never
    working.add(busy.id)
    const { id } = await space('caps-take')
    // a coordinator on pi that a cut-off ran out of allowance
    src.agents.records[id] = { key: id, name: 'take', kind: 'pi', logs: [], started: Date.now() } as never
    await cantGoOn(id)
    expect(starts.some((x) => x.key === id)).toBe(false)
    expect(cards(id)).toContain('Cut off by its provider: out of allowance until 5pm. Its backup waits for room: Codex (default) (1 of 1 at once); it takes over once one has room. Write to carry on.')
    expect(readJson<Record<string, unknown>>('cap-waits.json', {})[id]).toMatchObject({ kind: 'takeover', on: 'pi/unknown' })
    // still full: the pass leaves it waiting
    idle.add(id)
    await src.watchReturns()
    expect(starts.some((x) => x.key === id)).toBe(false)
    // the codex one ends: the pass takes its backup over, and its wait is over
    working.delete(busy.id)
    await src.watchReturns()
    expect(starts.at(-1)).toMatchObject({ key: id, kind: 'codex' })
    expect(readJson<Record<string, unknown>>('cap-waits.json', {})[id]).toBeUndefined()
  })

  test('its backup is out: it waits for it too, never starting on a provider that is out (it once went in past its run-out)', async () => {
    const { id } = await space('caps-take-out')
    src.agents.records[id] = { key: id, name: 'out', kind: 'pi', logs: [], started: Date.now() } as never
    const s = src as unknown as { engine: { outNow?: (key: string) => { until?: string } | undefined } }
    const was = s.engine.outNow
    s.engine.outNow = (key: string) => (key.startsWith('codex/') ? { until: 'Today 21:00' } : undefined)
    try {
      await cantGoOn(id)
      expect(starts.some((x) => x.key === id)).toBe(false)
      expect(cards(id)).toContain('Cut off by its provider: out of allowance until 5pm. Its backup waits for room: Codex (default) (out until Today 21:00); it takes over once one has room. Write to carry on.')
      expect(cards(id).some((c) => c.includes('past the cap'))).toBe(false)
    } finally {
      s.engine.outNow = was
    }
  })

  test('a wait for a takeover is over once the coordinator runs on another model (restarted by hand), or is at work again', async () => {
    src.settings.set('models.maxAtOnce', 'codex=1', 'machine')
    const busy = await space('caps-take-moved-busy')
    src.agents.records[busy.id] = { key: busy.id, name: 'busy', kind: 'codex', logs: [], started: Date.now() } as never
    working.add(busy.id)
    const { id } = await space('caps-take-moved')
    src.agents.records[id] = { key: id, name: 'moved', kind: 'pi', logs: [], started: Date.now() } as never
    await cantGoOn(id, 'c2')
    const waits = (src as unknown as { capWaits: Map<string, unknown> }).capWaits
    expect(waits.has(id)).toBe(true)
    // restarted by hand on claude meanwhile: the takeover it waited for is no longer wanted
    src.agents.records[id] = { key: id, name: 'moved', kind: 'claude', logs: [], started: Date.now() } as never
    idle.add(id)
    working.delete(busy.id)
    await src.watchReturns()
    expect(waits.has(id)).toBe(false)
    expect(starts.some((x) => x.key === id)).toBe(false)
    // a wait whose coordinator is at work again is over too
    waits.set(id, { kind: 'takeover', at: Date.now(), on: 'claude/unknown', r: { cut: 'c3', tries: 1, reason: 'x', words: 'x' } })
    idle.delete(id)
    working.add(id)
    await src.watchReturns()
    expect(waits.has(id)).toBe(false)
  })
})

describe('a start the caps put on a backup goes back to its primary once it is idle and the primary has room', () => {
  let n = 0
  /** a task of that space, as its start leaves it: its worktree is there, its agent runs `kind` on `model`, and a cap start
   *  put it on a backup (onBackup) when `on` is given. Pushed, not added: a task's start needs herdr for its worktree */
  /** `project`: the space's name */
  function pushTask(project: string, kind: string, model: string | undefined, on?: { step: number; kind: string }) {
    const id = `CAP-${++n}`
    const worktree = tmp('caps-wt')
    src.engine.tasks.push({ id, n, project: placeId.space(project), base: 'main', title: id, desc: 'Add x.', by: 'test', created: Date.now(), updated: Date.now(), told: 'work', worktree, branch: `work/${n}-x`, agent: { kind: 'pi', model: SPARK }, ...(on ? { onBackup: { ...on, at: Date.now() } } : {}) } as never)
    const key = `${id}/Agent`
    src.agents.records[key] = { key, name: id, kind, ...(model ? { model } : {}), cwd: worktree, logs: [], started: Date.now() } as never
    return { t: src.engine.tasks.find((x) => x.id === id)!, key }
  }

  test('a task on its backup for a full primary goes back when idle and the primary has room (go back)', async () => {
    src.settings.set('models.maxAtOnce', 'spark=1', 'machine')
    const p = await space('caps-back')
    // the busy one fills spark=1 while it works; the task on its backup is idle
    const busy = pushTask(p.p.name, 'pi', SPARK)
    working.add(busy.key)
    const t = pushTask(p.p.name, 'codex', undefined, { step: 1, kind: 'codex' })
    idle.add(t.key)
    await src.watchReturns()
    // still full: it stays on its backup
    expect(starts.filter((s) => s.key === t.key)).toHaveLength(0)
    // the busy one ends: spark has room, and the task goes back to its primary
    // the busy task ends (stopped: it holds no slot any more), so spark has room
    working.delete(busy.key)
    idle.add(busy.key)
    busy.t.stopped = true
    await src.watchReturns()
    expect(starts.at(-1)).toMatchObject({ key: t.key, kind: 'pi' })
    expect(t.t.onBackup).toBeUndefined()
    expect(cards(t.key).some((c) => c.startsWith('Back on pi (') && c.endsWith('): its model has room under its cap now'))).toBe(true)
  })

  test('a task whose way back fails is logged, and it stays on its backup', async () => {
    src.settings.set('models.maxAtOnce', 'spark=1', 'machine')
    const p = await space('caps-back-fail')
    const busy = pushTask(p.p.name, 'pi', SPARK)
    working.add(busy.key)
    const t = pushTask(p.p.name, 'codex', undefined, { step: 1, kind: 'codex' })
    idle.add(t.key)
    busy.t.stopped = true
    working.delete(busy.key)
    const restart = src.agents.restart
    src.agents.restart = (async () => {
      throw new Error('herdr is not answering')
    }) as never
    const errors: string[] = []
    const was = console.error
    console.error = (...a: unknown[]) => void errors.push(a.join(' '))
    try {
      await src.watchReturns()
    } finally {
      console.error = was
      src.agents.restart = restart
    }
    expect(errors.some((e) => e.includes(`couldn't move ${t.t.id} back to its primary: herdr is not answering`))).toBe(true)
    expect(t.t.onBackup).toBeDefined()
  })

  test('a task on its backup is left there while it works, and never moved mid-turn', async () => {
    src.settings.set('models.maxAtOnce', 'spark=1', 'machine')
    const p = await space('caps-busy-back')
    const t = pushTask(p.p.name, 'codex', undefined, { step: 1, kind: 'codex' })
    working.add(t.key)
    await src.watchReturns()
    expect(starts.filter((s) => s.key === t.key)).toHaveLength(0)
    expect(t.t.onBackup).toBeDefined()
  })
})

describe("a coordinator a cap started on a backup goes back too, and a way back that fails is logged", () => {
  test('its primary has room again and it is idle: it goes back to the primary; a stale mark of a gone place is dropped', async () => {
    src.settings.set('models.maxAtOnce', 'pi/unknown=1', 'machine')
    const busy = await space('caps-cback-busy')
    src.agents.records[busy.id] = { key: busy.id, name: 'busy', kind: 'pi', logs: [], started: Date.now() } as never
    working.add(busy.id)
    const { id } = await space('caps-cback')
    await startCoordinator(id)
    expect(starts.at(-1)).toMatchObject({ key: id, kind: 'codex' })
    // a mark of a place that is gone is no coordinator any more
    ;(src as unknown as { capStarts: Map<string, { step: number }> }).capStarts.set('p:gone:nowhere', { step: 1 })
    // still busy: it stays on its backup
    await src.watchReturns()
    expect(starts.filter((x) => x.key === id)).toHaveLength(1)
    // the busy one ends, and the coordinator is idle: it goes back to its primary
    working.delete(busy.id)
    idle.add(id)
    working.delete(id)
    await src.watchReturns()
    expect(starts.at(-1)).toMatchObject({ key: id, kind: 'pi' })
    expect((src as unknown as { capStarts: Map<string, unknown> }).capStarts.has(id)).toBe(false)
    expect(cards(id).some((c) => c.startsWith('Back on pi'))).toBe(true)
  })

  test('a coordinator a cap put on its backup is still on it after a restart, and its way back still applies', async () => {
    src.settings.set('models.maxAtOnce', 'pi/unknown=1', 'machine')
    const busy = await space('caps-restart-busy')
    src.agents.records[busy.id] = { key: busy.id, name: 'busy', kind: 'pi', logs: [], started: Date.now() } as never
    working.add(busy.id)
    const { id } = await space('caps-restart')
    await startCoordinator(id)
    expect(starts.at(-1)).toMatchObject({ key: id, kind: 'codex' })
    // the mark is kept on disk: a Shepherdr started again reads it
    expect(readJson<Record<string, unknown>>('cap-starts.json', {})[id]).toEqual({ step: 1 })
    const again = new LiveSource()
    try {
      expect((again as unknown as { capStarts: Map<string, unknown> }).capStarts.get(id)).toEqual({ step: 1 })
      // the busy one ends, and the coordinator is idle: the restarted Shepherdr takes it back to its primary
      const restarts: { key: string; kind: string }[] = []
      again.agents.status = (() => 'idle') as never
      again.agents.restart = (async (spec: { key: string; kind: string }) => {
        restarts.push({ key: spec.key, kind: spec.kind })
        return null
      }) as never
      again.agents.record = ((k: string) => (k === id ? { key: id, name: id, kind: 'codex', logs: [], started: Date.now() } : undefined)) as never
      again.agents.reachable = true
      await again.watchReturns()
      expect(restarts.at(-1)).toMatchObject({ key: id, kind: 'pi' })
      expect(readJson<Record<string, unknown>>('cap-starts.json', {})[id]).toBeUndefined()
    } finally {
      again.stop()
    }
  })

  test('a way back that fails is logged and the agent stays where it is', async () => {
    src.settings.set('models.maxAtOnce', 'pi/unknown=1', 'machine')
    const busy = await space('caps-fail-busy')
    src.agents.records[busy.id] = { key: busy.id, name: 'busy', kind: 'pi', logs: [], started: Date.now() } as never
    working.add(busy.id)
    const { id } = await space('caps-fail')
    await startCoordinator(id)
    working.delete(busy.id)
    idle.add(id)
    working.delete(id)
    const restart = src.agents.restart
    src.agents.restart = (async () => {
      throw new Error('herdr is not answering')
    }) as never
    const errors: string[] = []
    const was = console.error
    console.error = (...a: unknown[]) => void errors.push(a.join(' '))
    try {
      await src.watchReturns()
    } finally {
      console.error = was
      src.agents.restart = restart
    }
    expect(errors.some((e) => e.includes(`couldn't move ${id} back to its primary: herdr is not answering`))).toBe(true)
    expect(starts.at(-1)).toMatchObject({ key: id, kind: 'codex' })
  })
})


describe('a restart by hand, and the way back, never put a coordinator on a full model', () => {
  test('shepherdr restart onto a full model is refused before anything is saved or stopped', async () => {
    src.settings.set('models.maxAtOnce', 'pi/unknown=1', 'machine')
    const busy = await space('caps-hand-busy')
    src.agents.records[busy.id] = { key: busy.id, name: 'busy', kind: 'pi', logs: [], started: Date.now() } as never
    working.add(busy.id)
    const { p, id } = await space('caps-hand')
    src.agents.records[id] = { key: id, name: 'hand', kind: 'codex', logs: [], started: Date.now() } as never
    idle.add(id)
    src.settings.set('coordinator.agent', 'Codex', { space: p.name })
    const restart = (src as unknown as { restart(key: string, to: { kind?: string }, save?: boolean): Promise<string> }).restart.bind(src)
    const err = await restart(id, { kind: 'pi' }, true).catch((e: Error) => e)
    expect((err as Error).message).toBe('Not restarted: pi/unknown is at its limit (1 of 1 at once): wait for a free slot, or pick another model.')
    // nothing saved, nothing started
    expect(src.settings.pick('coordinator.agent', { space: p.name }).value).toBe('Codex')
    expect(starts.some((x) => x.key === id)).toBe(false)
    src.settings.set('coordinator.agent', null, { space: p.name })
  })

  test('the way back takes a coordinator to its primary only while the primary has room: full, it waits for a later pass', async () => {
    src.settings.set('models.maxAtOnce', 'pi/unknown=1', 'machine')
    const busy = await space('caps-wayback-busy')
    src.agents.records[busy.id] = { key: busy.id, name: 'busy', kind: 'pi', logs: [], started: Date.now() } as never
    working.add(busy.id)
    const { id } = await space('caps-wayback')
    // on its backup since a takeover long ago, idle: the way back takes it in, and its primary answers
    src.agents.records[id] = { key: id, name: 'wayback', kind: 'codex', logs: [], started: Date.now() } as never
    idle.add(id)
    src.agents.markTookOver(id, { from: 'pi', to: 'codex', why: 'out of allowance', at: Date.now() - 6 * 3_600_000 })
    const probe = src.returns.probe
    src.returns.probe = (async () => ({ ok: true, said: 'ok' })) as never
    try {
      await src.watchReturns(Date.now())
      // pi is full: it stays on its backup, and is not given up for it
      expect(starts.some((x) => x.key === id)).toBe(false)
      working.delete(busy.id)
      await src.watchReturns(Date.now())
      expect(starts.at(-1)).toMatchObject({ key: id, kind: 'pi' })
    } finally {
      src.returns.probe = probe
    }
  })
})

describe("shepherdr set models.maxAtOnce says what it fitted to the provider's limit", () => {
  test("a model above its provider's limit is saved at the provider's number, and the answer says so", async () => {
    const r = await src.cli(['set', 'models.maxAtOnce', `spark=2, ${SPARK}=3`, '--machine'], {})
    expect(r.code).toBe(0)
    expect(r.out).toContain(`models.maxAtOnce = pi.spark=2, pi.${SPARK}=2`)
    expect(r.out).toContain(`Lowered to fit their provider: pi · ${SPARK} from 3 to 2 (pi · spark allows 2 at once).`)
    // nothing to fit: no such line
    const plain = await src.cli(['set', 'models.maxAtOnce', 'spark=2', '--machine'], {})
    expect(plain.out).not.toContain('Lowered')
  })
})
