// A task whose start meets herdr dropping its calls starts all the same, and shows "Went wrong" only once the tries ran
// out (agents.ts launch and engine.ts startTask; the waits are a few ms here, test/preload.ts). On a real git repo with
// herdr stood in for (engine-world.ts, fake-herdr.ts, which can drop the next calls of a method).
import { describe, expect, test } from 'bun:test'
import { repo, until, world } from './engine-world.ts'

describe('a task start meeting drops', () => {
  test('a worktree made after herdr dropped its calls twice: the task starts, no trouble', async () => {
    const w = world()
    w.engine.tasks.splice(0)
    const p = await w.places.add(repo(), 'drops-ok')
    // both calls of one try (the repo's space, then its folder) and the first of the next are dropped before herdr acts
    w.herdr.drop('worktreeCreate', 'before', 'before')
    const t = w.engine.add({ project: p.name, title: 'Dropped once', desc: 'Add a.txt.', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
    expect(t.trouble).toBeUndefined()
    expect(w.herdr.spaces.filter((s) => s.worktree?.is_linked_worktree)).toHaveLength(1)
  })

  test('a worktree herdr keeps dropping fails once the tries ran out, with the error', async () => {
    const w = world()
    w.engine.tasks.splice(0)
    const p = await w.places.add(repo(), 'drops-out')
    w.herdr.drop('worktreeCreate', ...Array<'before'>(40).fill('before'))
    const t = w.engine.add({ project: p.name, title: 'Dropped always', desc: 'Add a.txt.', by: 'test' })
    await until(() => !!t.trouble)
    expect(t.trouble).toContain('Could not make a worktree: herdr closed the connection during worktreeCreate')
    expect(w.started).toHaveLength(0)
  })
})
