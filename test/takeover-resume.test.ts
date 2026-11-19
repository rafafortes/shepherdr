// A takeover that a restart of Shepherdr cuts short (engine.ts cantGoOn, resumeTakeovers): while it is on its way, the task
// keeps its handover; it is cleared once the backup is up or the takeover failed, and a restart that finds it takes the
// takeover again from where it stood before it. The takeover is the same code for every CLI: a pi agent taken over by
// Codex stands for all of them.
import { describe, expect, test } from 'bun:test'
import { repo, until, world } from './engine-world.ts'
const { HerdrError } = await import('../server/live/herdr.ts')

const SPARK = 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold'

/** a fresh world with its spacing off and every CLI installed (so the backups are real) */
function fresh() {
  const w = world()
  w.engine.tasks.splice(0)
  for (const k of ['machine.maxTasks', 'machine.startLoad', 'machine.startMemory', 'machine.startEvery', 'machine.startPressure']) w.settings.set(k, null)
  w.settings.set('machine.startEvery', '0')
  w.settings.set('machine.maxTasks', '10')
  w.engine.installed = () => true
  return w
}

/** a task on pi (or the CLI named), started at once */
async function running(w: ReturnType<typeof world>, name: string, kind = 'pi') {
  const p = await w.places.add(repo(), name)
  const t = w.engine.add({ project: p.name, title: 'T1', desc: 'Add t1.txt.', by: 'test', agent: { kind, ...(kind === 'pi' ? { model: SPARK } : {}) } })
  await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
  if (kind === 'pi') w.records[`${t.id}/Agent`] = { ...w.records[`${t.id}/Agent`], model: SPARK } as never
  w.brief(`${t.id}/Agent`)
  return { t, key: `${t.id}/Agent` }
}

const kindOf = (w: ReturnType<typeof world>, key: string) => ([...w.started].reverse().find((s) => s.key === key) as { kind?: string } | undefined)?.kind

describe('a takeover on its way keeps its handover until the backup is up', () => {
  test('kept while the backup starts, cleared once it is up', async () => {
    const w = fresh()
    const { t, key } = await running(w, 'handover-up')
    const ensure = w.agents.ensure
    let during: unknown
    w.agents.ensure = (async (s: { key: string }) => {
      if (s.key === key) during = t.handover
      return ensure(s as never)
    }) as never
    await w.engine.cantGoOn(t.id, 'Out of allowance', true)
    expect(during).toMatchObject({ why: 'Out of allowance', lasting: true })
    expect(t.handover).toBeUndefined()
    expect(kindOf(w, key)).toBe('codex')
    expect(t.tookOver).toMatchObject({ to: 'codex', step: 1 })
  })

  test('cleared too when the backup does not start', async () => {
    const w = fresh()
    const { t, key } = await running(w, 'handover-fail')
    const ensure = w.agents.ensure
    w.agents.ensure = (async (s: { key: string; kind: string }) => {
      if (s.key === key && s.kind === 'codex') throw new Error('herdr is not answering')
      return ensure(s as never)
    }) as never
    await w.engine.cantGoOn(t.id, 'Out of allowance', true)
    expect(t.handover).toBeUndefined()
    expect(t.tookOver).toBeUndefined()
    expect(t.trouble).toContain('herdr is not answering')
  })
})

describe('a restart that cut a takeover short takes it again', () => {
  test('from where it stood before it, with the same reason: the backup goes in', async () => {
    const w = fresh()
    const { t, key } = await running(w, 'resume-take')
    // as a restart leaves it: the takeover marked, its handover kept, the agent still the one cut off
    t.tookOver = { from: 'pi', to: 'codex', why: 'out of allowance', at: Date.now(), step: 1 }
    t.handover = { why: 'Out of allowance', lasting: true, at: Date.now() }
    w.engine.resumeTakeovers()
    await until(() => kindOf(w, key) === 'codex')
    await until(() => t.handover === undefined && t.tookOver?.step === 1)
    expect(t.tookOver).toMatchObject({ from: 'pi', to: 'codex', step: 1 })
  })

  test('a task stopped meanwhile gets its takeover before back, and nothing starts', async () => {
    const w = fresh()
    const { t, key } = await running(w, 'resume-stopped')
    const before = { from: 'claude', to: 'pi', why: 'rate limited', at: 1, step: 1 }
    t.tookOver = { from: 'pi', to: 'codex', why: 'out of allowance', at: Date.now(), step: 2 }
    t.handover = { why: 'Out of allowance', lasting: true, prior: before, at: Date.now() }
    t.stopped = true
    const starts = w.started.filter((s) => s.key === key).length
    w.engine.resumeTakeovers()
    await Bun.sleep(50)
    expect(t.handover).toBeUndefined()
    expect(t.tookOver).toEqual(before)
    expect(w.started.filter((s) => s.key === key)).toHaveLength(starts)
  })
})

// herdr closes a space with its last pane: a task agent's only pane carried its worktree's space away with it, and the
// backup taking over had nowhere to start (SHE-166). The pane its new run goes in is opened before the old run ends
// (agents.ts restart), a space that closed anyway is opened again from the worktree (worktrees.ts agentPane and
// engine.ts cantGoOn), and a backup that still cannot start leaves the task as it was rather than as nothing.
const CLIS = ['claude', 'codex', 'pi', 'opencode', 'agy']

/** the herdr space a task's worktree has: its id in the fake herdr */
const spaceOf = (w: ReturnType<typeof world>, path: string) => w.herdr.spaces.find((s) => s.worktree?.checkout_path === path)?.workspace_id

describe('the space a takeover goes in', () => {
  for (const [i, from] of CLIS.entries()) {
    for (const same of [true, false]) {
      const to = same ? from : CLIS[(i + 1) % CLIS.length]
      test(`${from} → ${to} (${same ? 'its own session resumed' : 'another CLI'}): the task's space stays open`, async () => {
        const w = fresh()
        const { t, key } = await running(w, `handover-${from}-${same ? 'same' : 'cross'}`, from)
        w.settings.set('task.fallback', to)
        try {
          const before = spaceOf(w, t.worktree!)
          expect(before).toBeDefined()
          await w.engine.cantGoOn(t.id, 'Out of allowance')
          const s = w.started.filter((x) => x.key === key)
          expect(s).toHaveLength(2)
          expect(s[1]).toMatchObject({ kind: to })
          // never closed in between: the same space, the run in a tab of its own in it
          expect(spaceOf(w, t.worktree!)).toBe(before)
          expect(w.herdr.spaces.filter((x) => x.worktree?.checkout_path === t.worktree)).toHaveLength(1)
          expect(t.tookOver).toMatchObject({ from, to })
          expect(t.trouble).toBeUndefined()
        } finally {
          w.settings.set('task.fallback', null)
        }
      })
    }
  }

  test('a task restarted by hand keeps it open too: the new run is a tab in the space it has', async () => {
    const w = fresh()
    const { t, key } = await running(w, 'restart-space')
    const before = spaceOf(w, t.worktree!)
    await w.engine.restart(t.id, { kind: 'codex' })
    expect(kindOf(w, key)).toBe('codex')
    expect(spaceOf(w, t.worktree!)).toBe(before)
    // its turn was stopped before its session was resumed
    expect(w.stopped).toContain(key)
  })
})

describe('a space herdr closes while a backup starts', () => {
  test('the first tab refused there: the space is opened again from its worktree and the backup starts in it', async () => {
    const w = fresh()
    const { t, key } = await running(w, 'handover-reopen')
    w.settings.set('task.fallback', 'codex')
    // herdr no longer has the space, and says so: the pane the hand-over opens ahead fails, and the tab agentPane
    // opens once more from the worktree finds it gone as well. Nothing is tried again by herdr's own retries
    const createTab = w.herdr.h.createTab
    let n = 0
    w.herdr.h.createTab = async (...args: Parameters<typeof createTab>) => {
      if (n++ < 2) throw new HerdrError('workspace_not_found', 'workspace w9 not found')
      return createTab(...args)
    }
    // the failed try's mark on the agent's record is given back before the retry: it starts from what the agent was
    const restore = w.agents.restore
    let given: Record<string, unknown> | undefined
    w.agents.restore = ((k: string, r: Record<string, unknown> | undefined) => {
      given = r
      return restore(k, r)
    }) as never
    try {
      await w.engine.cantGoOn(t.id, 'Out of allowance')
    } finally {
      w.herdr.h.createTab = createTab
      w.settings.set('task.fallback', null)
    }
    expect(given).toMatchObject({ kind: 'pi' })
    // the backup went in all the same, in a space opened again from its worktree, with no failure left on the task
    expect(kindOf(w, key)).toBe('codex')
    expect(t.tookOver).toMatchObject({ from: 'pi', to: 'codex', step: 1 })
    expect(t.handover).toBeUndefined()
    expect(t.trouble).toBeUndefined()
    expect(spaceOf(w, t.worktree!)).toBeDefined()
  })

  test('a space that cannot be opened at all: the task waits for you with the chain as it was, and says so', async () => {
    const w = fresh()
    const { t, key } = await running(w, 'handover-stuck')
    w.settings.set('task.fallback', 'codex')
    const createTab = w.herdr.h.createTab
    w.herdr.h.createTab = async () => {
      throw new HerdrError('workspace_not_found', 'workspace w9 not found')
    }
    try {
      await w.engine.cantGoOn(t.id, 'Out of allowance', true)
    } finally {
      w.herdr.h.createTab = createTab
      w.settings.set('task.fallback', null)
    }
    // nothing started, and the task says why rather than looking as it did
    expect(kindOf(w, key)).toBe('pi')
    expect(t.trouble).toContain('not found')
    expect(w.engine.view(t)).toMatchObject({ status: 'need' })
    // the chain is as it was: no takeover counted, no hand-over left for a restart to take again, and its agent's
    // record is the one the run that was cut off had
    expect(w.records[key]).toMatchObject({ kind: 'pi' })
    expect(t.tookOver).toBeUndefined()
    expect(t.handover).toBeUndefined()
    expect(w.posted.some((p) => p.key === key && p.card?.text.includes('No backup agent took over'))).toBe(true)
    const starts = w.started.length
    w.engine.resumeTakeovers()
    await Bun.sleep(50)
    expect(w.started).toHaveLength(starts)
  })
})
