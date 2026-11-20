// Work a Done task kept: a weekly reminder per space (RES-07), and tasks.keptExpiry removing it with the forced path.
import { describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repo, sh, started, until, world } from './engine-world.ts'

const DAY = 86_400_000
const branches = (dir: string) => sh('git branch --list "work/*" --format="%(refname:short)"', dir)
const kept = (id: string, project: string, at: number, more: Record<string, unknown> = {}) => ({
  id,
  n: 1,
  project,
  title: id,
  desc: '',
  by: 't',
  created: at - 40 * DAY,
  updated: at,
  merged: true,
  cleaned: true,
  doneAt: at,
  kept: [`~/work/${id} (uncommitted changes)`],
  keptAt: at,
  keptNotifiedAt: at,
  ...more,
})
const put = (w: ReturnType<typeof world>, ...tasks: ReturnType<typeof kept>[]) => (w.engine.tasks as unknown as unknown[]).splice(0, w.engine.tasks.length, ...tasks)

/** a real worktree whose file was never committed, left behind by a Done task */
async function withKeptWork(name: string) {
  const w = world()
  const dir = repo()
  const { p, t, key } = await started(w, dir, name)
  const wt = t.worktree
  const branch = t.branch
  if (!wt || !branch) throw new Error('the task has no worktree or branch')
  writeFileSync(join(wt, 'late.txt'), 'late\n')
  t.closed = true
  w.agentIs(key, 'idle')
  await until(() => !!t.cleaned)
  expect(t.kept?.length).toBe(1)
  return { w, dir, p, t, key, wt, branch }
}

const reminder = (w: ReturnType<typeof world>) => w.news.filter((n) => n.includes('still keep work from when they were done'))

describe('work a Done task kept', () => {
  test('is named once a week, one line per space and not one per task, then again a week later', async () => {
    const w = world()
    const now = Date.now()
    const old = now - 8 * DAY
    put(w, kept('A-1', 'p:one', old), kept('A-2', 'p:one', old), kept('B-1', 'p:two', old))

    await w.engine.sweep(now)

    expect(reminder(w)).toHaveLength(2) // two spaces, not three tasks
    expect(reminder(w)[0]).toContain('A-1')
    expect(reminder(w)[0]).toContain('A-2')
    expect(reminder(w)[1]).toContain('B-1')
    expect(w.newsTo).toEqual(['p:one', 'p:two'])
    // a pass soon after says nothing new
    await w.engine.sweep(now + 60_000)
    expect(reminder(w)).toHaveLength(2)
    // a week later, one line again in each space
    await w.engine.sweep(now + 8 * DAY)
    expect(reminder(w)).toHaveLength(4)
  })

  test('a keep from before the clock existed is reminded on the next pass', async () => {
    const w = world()
    const now = Date.now()
    const old = now - 30 * DAY
    const t = kept('OLD-1', 'p:one', old, { keptAt: undefined, keptNotifiedAt: undefined })
    put(w, t)

    await w.engine.sweep(now)

    expect(t.keptAt).toBe(old) // seeded from when the task ended
    expect(reminder(w)).toHaveLength(1)
    expect(reminder(w)[0]).toContain('OLD-1')
  })

  test('with tasks.keptExpiry set, work kept past it is removed by wt.remove and said in news', async () => {
    const { w, dir, t, wt, branch } = await withKeptWork('expire')
    expect(existsSync(wt)).toBe(true)
    expect(w.settings.set('tasks.keptExpiry', '1 day').ok).toBe(true)
    const now = Date.now()
    t.keptAt = now - 2 * DAY
    t.doneAt = now - 3 * DAY

    await w.engine.sweep(now)

    expect(existsSync(wt)).toBe(false)
    expect(branches(dir)).not.toContain(branch)
    expect(t.kept).toBeUndefined()
    expect(t.worktree).toBeUndefined()
    expect(t.branch).toBeUndefined()
    expect(w.news.some((n) => n.includes(`${t.id} kept `) && n.includes('(tasks.keptExpiry): removed it'))).toBe(true)
  })

  test('off, the default, keeps the work and only reminds', async () => {
    const { w, t, wt } = await withKeptWork('off')
    t.keptAt = Date.now() - 90 * DAY
    t.keptNotifiedAt = Date.now() - 8 * DAY
    t.doneAt = Date.now() - 90 * DAY

    await w.engine.sweep()

    expect(existsSync(wt)).toBe(true)
    expect(t.kept?.length).toBe(1)
    expect(reminder(w).some((n) => n.includes(t.id))).toBe(true)
  })

  test('a task written to since it was kept is never expired', async () => {
    const { w, t, key, wt } = await withKeptWork('written')
    expect(w.settings.set('tasks.keptExpiry', '1 day').ok).toBe(true)
    t.keptAt = Date.now() - 90 * DAY
    t.doneAt = Date.now() - 90 * DAY
    w.engine.youWrote(key)
    expect(t.spokenAt ?? 0).toBeGreaterThan(t.keptAt ?? 0)

    await w.engine.sweep()

    expect(existsSync(wt)).toBe(true)
    expect(t.kept?.length).toBe(1)
  })

  test('the setting is read at the task’s space, so a space can opt out of a machine-wide expiry', async () => {
    const { w, p, t, wt } = await withKeptWork('space-off')
    expect(w.settings.set('tasks.keptExpiry', '1 day', 'all').ok).toBe(true)
    expect(w.settings.set('tasks.keptExpiry', 'off', { space: p.name }).ok).toBe(true)
    t.keptAt = Date.now() - 90 * DAY

    await w.engine.sweep()

    expect(existsSync(wt)).toBe(true) // the space's off wins over the machine's 1 day
    expect(t.kept?.length).toBe(1)
  })

  test('a space can also opt in while the machine is off', async () => {
    const { w, p, t, wt } = await withKeptWork('space-on')
    expect(w.settings.set('tasks.keptExpiry', 'off', 'all').ok).toBe(true)
    expect(w.settings.set('tasks.keptExpiry', '1 day', { space: p.name }).ok).toBe(true)
    t.keptAt = Date.now() - 90 * DAY

    await w.engine.sweep()

    expect(existsSync(wt)).toBe(false)
  })

  test('a turn still running on the task, or herdr work reopened in its space, is never expired', async () => {
    const running = await withKeptWork('agent-running')
    expect(running.w.settings.set('tasks.keptExpiry', '1 day').ok).toBe(true)
    running.t.doneAt = Date.now() // inside the stuck-agent grace: the sweep leaves this turn alone
    running.t.keptAt = Date.now() - 90 * DAY
    running.w.status[running.key] = 'working'

    await running.w.engine.sweep()
    expect(existsSync(running.wt)).toBe(true)

    const opened = await withKeptWork('space-open')
    expect(opened.w.settings.set('tasks.keptExpiry', '1 day').ok).toBe(true)
    opened.t.keptAt = Date.now() - 90 * DAY
    opened.w.herdr.spaces.push({
      workspace_id: 'reopened',
      label: `${opened.t.id} ${opened.t.title}`,
      tab_count: 1,
      worktree: { checkout_path: opened.wt, is_linked_worktree: true, repo_root: opened.dir },
      panes: ['reopened:p1'],
    })
    opened.w.herdr.busy.add('reopened:p1') // putAway leaves a busy space alone

    await opened.w.engine.sweep()
    expect(existsSync(opened.wt)).toBe(true)
  })

  test('a removal that fails keeps the record, backs off, and is said in news', async () => {
    const { w, t, wt } = await withKeptWork('failed')
    expect(w.settings.set('tasks.keptExpiry', '1 day').ok).toBe(true)
    t.keptAt = Date.now() - 90 * DAY
    const before = t.keptAt
    const api = w.engine as unknown as { wt: { remove: (o: unknown) => Promise<string[]> } }
    const real = api.wt.remove
    api.wt.remove = async () => ['some/path (git could not remove it)']
    try {
      await w.engine.sweep()
    } finally {
      api.wt.remove = real
    }

    expect(existsSync(wt)).toBe(true)
    expect(t.kept?.length).toBe(1)
    expect(t.keptAt ?? 0).toBeGreaterThan(before)
    expect(w.news.some((n) => n.includes(`${t.id} could not remove its kept work`))).toBe(true)
  })

  test('a kept task whose place is gone is left alone', async () => {
    const w = world()
    const now = Date.now()
    expect(w.settings.set('tasks.keptExpiry', '1 day').ok).toBe(true)
    const t = kept('GONE-1', 'p:missing', now - 40 * DAY, { keptAt: now - 30 * DAY })
    put(w, t)

    await w.engine.sweep(now)

    expect(t.kept?.length).toBe(1)
  })
})
