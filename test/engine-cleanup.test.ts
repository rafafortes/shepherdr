// A Done task whose agent never ended its turn: the sweep and the status handler end it past the grace (RES-01).
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import type { TaskRec } from '../server/live/engine/engine.ts'
import { repo, started, until, world } from './engine-world.ts'

const STALE = 16 * 60_000 // past DONE_WORKING_MS (15 minutes)

describe("a Done task's stuck agent", () => {
  test('the sweep interrupts and ends one still working past the grace, then cleans the task', async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'stuck')
    // Done a while ago, but its CLI never ended its turn (status stays 'working')
    t.merged = true
    t.doneAt = Date.now() - STALE
    w.records[key].started = Date.now() - STALE // a stuck agent started before the task ended and never settled
    const wt = t.worktree ?? ''

    await w.engine.sweep()

    expect(w.stopped).toContain(key) // stopTurn interrupted it
    expect(w.records[key].finished).toBe(true) // still working after the interrupt: finish closed its pane
    expect(t.cleaned).toBe(true)
    expect(existsSync(wt)).toBe(false)
  })

  test('the status handler does the same, cheaper, on the status event', async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'stuck-status')
    t.closed = true
    t.doneAt = Date.now() - STALE
    w.records[key].started = Date.now() - STALE // a stuck agent started before the task ended and never settled

    w.engine.agentStatus(key)
    await until(() => !!t.cleaned)

    expect(w.stopped).toContain(key)
    expect(w.records[key].finished).toBe(true)
    expect(t.cleaned).toBe(true)
  })

  test("one that settles inside the grace goes today's path and is never force-closed", async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'settles')
    t.merged = true
    t.doneAt = Date.now() // inside the grace

    w.agentIs(key, 'idle') // its turn ends: the usual path cleans it up
    await until(() => !!t.cleaned)
    expect(w.stopped).toEqual([])
    expect(w.records[key].finished).toBe(true)
    expect(t.cleaned).toBe(true)

    // a late status event that again reads working does not force-close it a second time
    w.status[key] = 'working'
    w.engine.agentStatus(key)
    await Bun.sleep(20)
    expect(w.stopped).toEqual([])
  })

  test('a working agent inside the grace is left alone by the sweep', async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'ingrace')
    t.merged = true
    t.doneAt = Date.now() // inside the grace

    await w.engine.sweep()
    expect(w.stopped).toEqual([])
    expect(w.records[key].finished).toBeFalsy()
    expect(t.cleaned).toBeFalsy()
    expect(existsSync(t.worktree ?? '')).toBe(true)
  })

  test('a working task that is not ended is never touched', async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'live')
    // still a live task: no merged, no closed, no doneAt

    await w.engine.sweep()
    w.engine.agentStatus(key)
    await Bun.sleep(20)
    expect(w.stopped).toEqual([])
    expect(w.records[key].finished).toBeFalsy()
    expect(t.cleaned).toBeFalsy()
    expect(existsSync(t.worktree ?? '')).toBe(true)
  })

  test('a turn that will not stop after the interrupt is still ended', async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'throws')
    const real = w.agents.stopTurn
    // the real stopTurn throws after 15 s when the turn will not settle; the catch must still reach finish
    w.agents.stopTurn = async (k: string) => {
      await real(k)
      throw new Error('It is still working after an interrupt: try again in a moment.')
    }
    t.closed = true
    t.doneAt = Date.now() - STALE
    w.records[key].started = Date.now() - STALE // a stuck agent started before the task ended and never settled

    await w.engine.sweep()

    expect(w.stopped).toContain(key)
    expect(w.records[key].finished).toBe(true)
    expect(t.cleaned).toBe(true)
  })

  test("a message to a Done task's agent starts a new grace, even long after it was launched", async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'resume')
    t.merged = true
    t.doneAt = Date.now() - STALE
    w.records[key].started = Date.now() - STALE // a stuck agent started before the task ended and never settled
    await w.engine.sweep()
    expect(t.cleaned).toBe(true)
    w.stopped.length = 0

    // the human resumed the agent a while ago, then writes again: both the done time and the launch are stale,
    // but this turn is new — its status event must not interrupt it
    await w.agents.ensure({ key, cwd: t.worktree ?? '', kind: 'claude' })
    w.records[key].started = Date.now() - STALE
    w.status[key] = 'working'
    w.engine.youWrote(key)
    w.engine.agentStatus(key)
    await Bun.sleep(20)

    expect(w.stopped).toEqual([])
    expect(w.records[key].finished).toBeFalsy()
  })

  test('a message just before a restart keeps holding the grace after it', async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'restarted')
    t.merged = true
    t.doneAt = Date.now() - STALE
    w.records[key].started = Date.now() - STALE
    w.engine.saveAfter = 0
    w.engine.youWrote(key)
    await Bun.sleep(30)

    // a fresh engine over the same home: the in-memory wrote map is gone, only the task's spokenAt survives
    const w2 = world()
    const t2 = w2.engine.task(t.id)!
    expect(t2.spokenAt).toBeTruthy()
    w2.status[key] = 'working'
    w2.records[key] = { kind: 'claude', started: Date.now() - STALE, sessionId: `${key}-session`, logs: [] }
    w2.engine.agentStatus(key)
    await Bun.sleep(20)

    expect(w2.stopped).toEqual([])
    expect(w2.records[key].finished).toBeFalsy()
  })

  test('a status event racing the sweep cannot force-close the same agent twice', async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'race')
    t.merged = true
    t.doneAt = Date.now() - STALE
    w.records[key].started = Date.now() - STALE // a stuck agent started before the task ended and never settled
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = w.agents.stopTurn
    let calls = 0
    w.agents.stopTurn = async (k: string) => {
      calls++
      await gate
      await real(k)
    }

    const sweeping = w.engine.sweep()
    await until(() => calls === 1) // the sweep is inside stopTurn, holding endingDone
    w.engine.agentStatus(key) // a status event arrives now
    release()
    await sweeping
    await until(() => !!t.cleaned)

    expect(calls).toBe(1)
    expect(w.records[key].finished).toBe(true)
  })

  test("every CLI's stuck agent is ended the same way", async () => {
    // The force-close is on herdr's side: one Esc through agents.stopTurn, then agents.finish closes the pane. No
    // CLI's reader or status wiring differs here, so each kind is started in this fixture and its stuck 'working'
    // status driven through the same engine path; what is checked is that every kind is interrupted and ended.
    const w = world()
    const dir = repo()
    const p = await w.places.add(dir, 'kinds')
    const kinds = ['claude', 'codex', 'pi', 'opencode', 'agy']
    const made: { key: string; t: TaskRec }[] = []
    for (const kind of kinds) {
      const t = w.engine.add({ project: p.name, title: `Stuck ${kind}`, desc: 'Add hello.txt', by: 'test', agent: { kind } })
      await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
      const key = `${t.id}/Agent`
      expect(w.records[key].kind).toBe(kind)
      t.merged = true
      t.doneAt = Date.now() - STALE
      w.records[key].started = Date.now() - STALE // a stuck agent started before the task ended and never settled
      made.push({ key, t })
    }

    await w.engine.sweep()

    for (const { key, t } of made) {
      expect(w.stopped).toContain(key)
      expect(w.records[key].finished).toBe(true)
      expect(t.cleaned).toBe(true)
    }
  })
})
