// Each task gets one temporary folder, made when its agent starts and carried in TMPDIR and SHEPHERDR_TMP, and put
// away with the task (stopping what still runs from it). A kept worktree keeps its folder; the server sweeps folders
// of tasks that are gone or archived at start and never touches anything outside the root.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentEnv } from '../server/live/box.ts'
import { ensureTaskTmp, inside, pidsInTmp, ROOT, setTaskTmpBase, sweepTaskTmp, taskOfChat, taskTmpBase, taskTmpDir } from '../server/live/task-tmp.ts'
import { ROOT as APP_ROOT } from '../server/root.ts'
import { repo, started, world } from './engine-world.ts'
import { tmp } from './tmp.ts'

const owned = tmp('task-tmp-test')
afterAll(() => rmSync(owned, { recursive: true, force: true }))

describe('a task temporary folder', () => {
  test('the launch environment of an agent and its reviewer carries both variables, and a second task gets another', () => {
    const a = agentEnv('TMP-1/Agent', APP_ROOT)
    const r = agentEnv('TMP-1/Reviewer', APP_ROOT)
    const b = agentEnv('TMP-2/Agent', APP_ROOT)
    const one = taskTmpDir('TMP-1')
    expect(one).toBe(join(taskTmpBase(), 'TMP-1'))
    expect(a.SHEPHERDR_TMP).toBe(one)
    expect(a.TMPDIR).toBe(one)
    expect(r.SHEPHERDR_TMP).toBe(one)
    expect(r.TMPDIR).toBe(one)
    expect(b.SHEPHERDR_TMP).toBe(taskTmpDir('TMP-2'))
    expect(b.TMPDIR).toBe(taskTmpDir('TMP-2'))
    expect(b.TMPDIR).not.toBe(one)
    expect(existsSync(one)).toBe(true)
    expect(existsSync(taskTmpDir('TMP-2'))).toBe(true)
  })

  test('the name is short and unmistakable: <system temp>/shepherdr-task/<TASK-ID>', () => {
    const saved = taskTmpBase()
    setTaskTmpBase(() => join(tmpdir(), ROOT))
    try {
      expect(taskTmpDir('SHE-104')).toBe(join(tmpdir(), ROOT, 'SHE-104'))
      expect(taskTmpDir('SHE-104').length).toBeLessThan(100)
    } finally {
      setTaskTmpBase(() => saved)
    }
  })

  test('a coordinator keeps the machine default; only a task chat names a folder', () => {
    expect(taskOfChat('TMP-3/Agent')).toBe('TMP-3')
    expect(taskOfChat('TMP-3/Reviewer')).toBe('TMP-3')
    expect(taskOfChat('p:box:home')).toBeUndefined()
    const env = agentEnv('p:box:home', APP_ROOT)
    expect(env.SHEPHERDR_TMP).toBeUndefined()
    expect(env.TMPDIR).toBeUndefined()
  })

  test('a sweep before the root exists does nothing', () => {
    const saved = taskTmpBase()
    setTaskTmpBase(() => join(owned, 'no-root-here'))
    try {
      expect(sweepTaskTmp(new Set())).toBe(0)
    } finally {
      setTaskTmpBase(() => saved)
    }
  })

  test('every CLI reads the same two variables in its launch environment', () => {
    for (const [kind, key] of [
      ['claude', 'TMP-4/Agent'],
      ['codex', 'TMP-5/Reviewer'],
      ['pi', 'TMP-6/Agent'],
      ['opencode', 'TMP-7/Agent'],
      ['agy', 'TMP-8/Agent'],
    ]) {
      const env = agentEnv(key, APP_ROOT)
      expect([kind, env.SHEPHERDR_TMP, env.TMPDIR]).toEqual([kind, taskTmpDir(key.split('/')[0]), taskTmpDir(key.split('/')[0])])
    }
  })

  test('a process whose cwd, SHEPHERDR_HOME or TMPDIR lies in the folder is named by that marker', () => {
    const dir = taskTmpDir('TMP-9')
    const rows = [
      { pid: 1, ppid: 0, cmd: 'sleep', cwd: dir },
      { pid: 2, ppid: 0, cmd: 'node', cwd: '/elsewhere', home: join(dir, 'home') },
      { pid: 3, ppid: 0, cmd: 'bun', cwd: '/elsewhere', tmp: join(dir, 'nested') },
      { pid: 4, ppid: 0, cmd: 'sh', cwd: `${dir}-outside` },
    ]
    expect(inside(dir, `${dir}-outside`)).toBe(false)
    expect(pidsInTmp(rows, 'TMP-9')).toEqual([1, 2, 3])
  })

  test('putting a task away stops a sleeper left in its folder and removes the folder', async () => {
    const w = world()
    const { t } = await started(w, repo(), 'clear')
    const dir = taskTmpDir(t.id)
    const sleeper = Bun.spawn(['sleep', '60'], {
      cwd: dir,
      env: { ...process.env, TMPDIR: dir, SHEPHERDR_HOME: join(dir, 'home') },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const pid = sleeper.pid
    expect(existsSync(dir)).toBe(true)
    expect(pidsInTmp([{ pid, ppid: process.pid, cmd: 'sleep 60', cwd: dir, tmp: dir, home: join(dir, 'home') }], t.id)).toEqual([pid])

    // the engine's own put-away, not a direct call: a Done task whose agent never settled is forced, then cleaned
    t.closed = true
    t.doneAt = Date.now() - 16 * 60_000
    w.records[`${t.id}/Agent`].started = Date.now() - 16 * 60_000
    await w.engine.sweep()

    expect(t.cleaned).toBe(true)
    expect(existsSync(dir)).toBe(false)
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  })

  test('deleting a task removes its folder', async () => {
    const w = world()
    const { t } = await started(w, repo(), 'deleted')
    const dir = taskTmpDir(t.id)
    expect(existsSync(dir)).toBe(true)
    await w.engine.deleteTask(t.id, { force: true })
    expect(existsSync(dir)).toBe(false)
  })

  test('a task that keeps work keeps its folder, and status names it beside the kept worktree', async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'kept')
    const dir = taskTmpDir(t.id)
    writeFileSync(join(t.worktree ?? '', 'scratch.txt'), 'uncommitted')
    t.closed = true
    t.doneAt = Date.now() - 16 * 60_000
    w.records[key].started = Date.now() - 16 * 60_000

    await w.engine.sweep()

    expect(t.kept?.length).toBeGreaterThan(0)
    expect(t.cleaned).toBe(true)
    expect(existsSync(dir)).toBe(true)
    expect(w.engine.keptLeftovers()[0]).toContain(`temp folder ${dir}`)
  })

  test('a second server that may start no agent leaves the shared root alone', () => {
    const dir = ensureTaskTmp('FOREIGN-1')
    const saved = process.env.SHEPHERDR_LAUNCH_AGENTS
    try {
      delete process.env.SHEPHERDR_LAUNCH_AGENTS
      // a proof server (or another worktree's dev server) has no tasks here: it must not sweep another home's folders
      world()
      expect(existsSync(dir)).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.SHEPHERDR_LAUNCH_AGENTS
      else process.env.SHEPHERDR_LAUNCH_AGENTS = saved
    }
  })

  test('a home without a readable tasks.json leaves the folders alone', () => {
    const dir = ensureTaskTmp('UNREAD-1')
    // this test's home is fresh: no tasks.json yet is not an empty task list (PERFS-12's guard, the same here)
    world()
    expect(existsSync(dir)).toBe(true)
  })

  test('at start folders of gone or archived tasks are swept; nothing outside the root is touched', async () => {
    const w = world()
    const p = await w.places.add(repo(), 'sweep')
    const t = w.engine.add({ project: p.name, title: 'Live', desc: 'hello', by: 'test' })
    const live = ensureTaskTmp(t.id)
    writeFileSync(join(live, 'keep.txt'), 'yes')
    const gone = ensureTaskTmp('GONE-9')
    const archived = ensureTaskTmp('ARCH-9')
    const file = join(taskTmpBase(), 'not-a-folder')
    writeFileSync(file, 'mine')
    const outside = join(owned, 'shepherdr-task-outside')
    mkdirSync(outside, { recursive: true })

    // a fresh engine over the same home sweeps at start: the live task is known, the other two are not
    world()

    expect(existsSync(live)).toBe(true)
    expect(existsSync(join(live, 'keep.txt'))).toBe(true)
    expect(existsSync(gone)).toBe(false)
    expect(existsSync(archived)).toBe(false)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(outside)).toBe(true)
    expect(await sweepTaskTmp(new Set([t.id]))).toBe(0)
  })
})
