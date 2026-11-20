// PERFS-12 at the engine level: the live-key set comes from the tasks and spaces the engine actually holds, and a
// prune runs at startup and again when a task archives. An archived task's record is kept; an orphan's is not.
import { describe, expect, test } from 'bun:test'
import { placeId, repo, started, world } from './engine-world.ts'

describe('orphan agent records are pruned by the engine', () => {
  test('startup runs the prune with the tasks the engine holds', () => {
    const w = world()
    // no records at boot: the pass still runs (it is where an earlier cleanup's leftovers would go)
    expect(w.pruned).toEqual([0])
  })

  test('an orphan record is dropped on archive and an archived task keeps both of its chat records', async () => {
    const w = world()
    const { p, t, key } = await started(w, repo(), 'keep-archived')
    const orphanTask = 'OLD-9/Agent'
    const noSpaceCoord = placeId.space('never-a-space')
    const reviewer = `${t.id}/Reviewer`
    w.records[orphanTask] = { kind: 'pi', started: 1, logs: [] }
    w.records[noSpaceCoord] = { kind: 'claude', started: 1, logs: [] }
    w.records[reviewer] = { kind: 'claude', started: 1, logs: [] }
    const coordinator = placeId.space(p.name)
    w.records[coordinator] = { kind: 'claude', started: 1, logs: [] }
    w.records[placeId.home()] = { kind: 'claude', started: 1, logs: [] }

    await w.engine.archive(t.id)

    expect(t.archived).toBeGreaterThan(0)
    expect(w.records[orphanTask]).toBeUndefined()
    // every coordinator record is kept: a removed space's chat comes back on re-add, and there is no way to tell
    // that from a key that never was a space. Keeping the latter costs one small record.
    expect(w.records[noSpaceCoord]).toBeDefined()
    // the task left every list, but its chat is still open in Archived and search: its records and logs stay
    expect(w.records[key]).toBeDefined()
    expect(w.records[reviewer]).toBeDefined()
    // both live coordinators stay as well
    expect(w.records[coordinator]).toBeDefined()
    expect(w.records[placeId.home()]).toBeDefined()
    expect(w.pruned.at(-1)).toBe(1)
  })
})
