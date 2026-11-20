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

  test("every CLI's stuck agent is ended the same way", async () => {
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
