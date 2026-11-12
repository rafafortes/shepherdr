// Settings' task agent changed (task.agent, task.model, task.effort): the tasks that wait take what Settings now name
// for their space, as Start with… gives each one; running, asking, ready, merging, done and archived tasks keep what
// they run on, a task already on it is counted as the same, and a scheduled task with no flags of its own follows
// Settings when it starts. A space with its own setting keeps it when the change is Everywhere or this machine's.
import { describe, expect, test } from 'bun:test'
import { repo, started, until, world } from './engine-world.ts'
import { retuneLine, type Retune } from '../server/live/engine/engine.ts'

/** a world where one task at a time runs on this machine: the rest wait for a slot */
function fresh() {
  const w = world()
  expect(w.settings.set('machine.maxTasks', '1').ok).toBe(true)
  const startedOf = (id: string) => w.started.some((s) => s.key === `${id}/Agent`)
  return { w, startedOf }
}

describe('Settings changed: the waiting tasks take it', () => {
  test('a space: its waiting tasks change and count apart, running ones keep their agent, and a second run finds them the same', async () => {
    const { w, startedOf } = fresh()
    const p = await w.places.add(repo(), 'retune-space')
    const first = w.engine.add({ project: p.name, title: 'At work', desc: 'Add a.txt.', by: 'test' })
    await until(() => startedOf(first.id))
    w.brief(`${first.id}/Agent`)
    const q1 = w.engine.add({ project: p.name, title: 'Waits', desc: 'Add b.txt.', by: 'test' })
    const q2 = w.engine.add({ project: p.name, title: 'Waits too', desc: 'Add c.txt.', by: 'test' })
    const after = w.engine.add({ project: p.name, title: 'After', desc: 'Add d.txt.', by: 'test', after: [first.id] })
    const pinned = w.engine.add({ project: p.name, title: 'Chosen', desc: 'Add e.txt.', by: 'test', agent: { kind: 'codex' } })
    const later = w.engine.add({ project: p.name, title: 'Tomorrow', desc: 'Add f.txt.', by: 'test', at: Date.now() + 86_400_000 })
    const gone = w.engine.add({ project: p.name, title: 'Archived', desc: 'Add g.txt.', by: 'test' })
    gone.archived = Date.now()
    expect([q1, q2, after, pinned].map((t) => w.engine.statusOf(t))).toEqual(['queued', 'queued', 'queued', 'queued'])
    expect(q1.agent).toMatchObject({ kind: 'claude' })
    expect(w.engine.statusOf(first)).toBe('work')

    // Settings: this space runs its tasks on pi
    expect(w.settings.set('task.agent', 'pi', { space: p.name }).ok).toBe(true)
    const dry = w.engine.retuneWaiting({ space: p.name }, true)
    expect(dry).toEqual({
      changed: 4,
      same: 0,
      follow: 1,
      pinned: 1,
      running: 1,
      kept: [],
      spaces: [{ name: p.name, on: { kind: 'pi' }, changed: 4 }],
    })
    // a dry run changes nothing
    expect([q1.agent?.kind, pinned.agent?.kind, later.scheduled?.agent]).toEqual(['claude', 'codex', undefined])

    const applied = w.engine.retuneWaiting({ space: p.name })
    expect(applied).toEqual(dry)
    expect(q1.agent).toMatchObject({ kind: 'pi' })
    expect(q2.agent).toMatchObject({ kind: 'pi' })
    expect(after.agent).toMatchObject({ kind: 'pi' })
    // the flags task add gave are Settings' now: no longer counted as chosen
    expect(pinned.agent).toMatchObject({ kind: 'pi' })
    expect(pinned.chosen).toBeUndefined()
    // a scheduled task takes Settings when it starts: nothing is set on it
    expect(later.scheduled?.agent).toBeUndefined()
    // what runs keeps its agent, and so does what is archived
    expect(first.agent).toMatchObject({ kind: 'claude' })
    expect(gone.agent).toMatchObject({ kind: 'claude' })
    // the card in each chat says where it starts now
    expect(w.posted.some((x) => x.key === `${q1.id}/Agent` && x.card?.text === 'Starts on pi when its turn comes')).toBe(true)

    // nothing left to change: all on pi already
    expect(w.engine.retuneWaiting({ space: p.name })).toMatchObject({ changed: 0, same: 4, follow: 1, running: 1 })
  })

  test('Everywhere or this machine: a space with its own setting keeps it; the others take the new one', async () => {
    const { w } = fresh()
    const own = await w.places.add(repo(), 'retune-own')
    const plain = await w.places.add(repo(), 'retune-plain')
    // this space set its own agent before its tasks were added
    expect(w.settings.set('task.agent', 'codex', { space: own.name }).ok).toBe(true)
    const kept = w.engine.add({ project: own.name, title: 'Kept', desc: 'Add a.txt.', by: 'test' })
    const other = w.engine.add({ project: plain.name, title: 'Moves', desc: 'Add b.txt.', by: 'test' })
    expect(kept.agent).toMatchObject({ kind: 'codex' })
    expect(other.agent).toMatchObject({ kind: 'claude' })
    // Everywhere: pi
    expect(w.settings.set('task.agent', 'pi', 'all').ok).toBe(true)
    const r = w.engine.retuneWaiting({ key: 'task.agent' }, true)
    expect(r.kept).toEqual([own.name])
    expect(r.changed).toBe(1)
    expect(r.spaces).toEqual([{ name: plain.name, on: { kind: 'pi' }, changed: 1 }])
    w.engine.retuneWaiting({ key: 'task.agent' })
    expect(other.agent).toMatchObject({ kind: 'pi' })
    expect(kept.agent).toMatchObject({ kind: 'codex' })
  })

  test("a model changed at this machine reaches a space that sets only its own agent, with the space's model", async () => {
    const { w } = fresh()
    const own = await w.places.add(repo(), 'retune-model')
    expect(w.settings.set('task.agent', 'claude', { space: own.name }).ok).toBe(true)
    const t = w.engine.add({ project: own.name, title: 'Model', desc: 'Add a.txt.', by: 'test' })
    expect(t.agent).toMatchObject({ kind: 'claude' })
    expect(w.settings.set('task.model', 'claude-sonnet-5-5', 'machine').ok).toBe(true)
    // the space's own agent is its own, but its model is this machine's: the one a task of it takes now
    expect(w.engine.retuneWaiting({ key: 'task.model' }, true)).toMatchObject({ changed: 1, kept: [], spaces: [{ name: own.name, changed: 1 }] })
    expect(w.engine.retuneWaiting({ key: 'task.model' })).toMatchObject({ changed: 1 })
    expect(t.agent?.model).toBe('claude-sonnet-5-5')
  })

  test('nothing waits: nothing counted, nothing changed', async () => {
    const { w, startedOf } = fresh()
    const a = await started(w, repo(), 'retune-none', 'At work', 'Add a.txt.')
    w.brief(a.key)
    expect(w.engine.retuneWaiting({ space: a.p.name }, true)).toEqual({ changed: 0, same: 0, follow: 0, pinned: 0, running: 1, kept: [], spaces: [] })
    expect(startedOf(a.t.id)).toBe(true)
  })
})

describe('the answer in words', () => {
  const base: Retune = { changed: 0, same: 0, follow: 0, pinned: 0, running: 0, kept: [], spaces: [] }

  test('one space, with what stays as it is', () => {
    expect(
      retuneLine({ ...base, changed: 2, same: 1, pinned: 1, running: 1, follow: 1, kept: ['lyvora-app'], spaces: [{ name: 'lyvora-site', on: { kind: 'pi', model: 'spark/qwen' }, changed: 2 }] }),
    ).toBe('2 waiting tasks in lyvora-site will start on pi (spark/qwen) when their turn comes; 1 of them had a worker of its own from task add, and changes too; 1 already on it; 1 start on Settings at their turn anyway; 1 running task keeps its agent; lyvora-app keeps its own setting.')
  })

  test('several spaces, and nothing to change', () => {
    expect(retuneLine({ ...base, changed: 3, spaces: [{ name: 'a', on: { kind: 'pi' }, changed: 1 }, { name: 'b', on: { kind: 'codex' }, changed: 2 }] })).toBe(
      '3 waiting tasks in 2 spaces will start on what Settings name for each (a on pi; b on Codex).',
    )
    expect(retuneLine({ ...base, same: 2 })).toBe('no waiting task changes; 2 already on it.')
    expect(retuneLine({ ...base, changed: 1, spaces: [{ name: 'a', on: { kind: 'pi' }, changed: 1 }] })).toBe('1 waiting task in a will start on pi when its turn comes.')
  })
})
