// Settings → Models → profiles, the live source's side: the actions the screen sends, and every shepherdr profile verb,
// on a real space of this machine, with waiting tasks held (herdr is not there) for --apply-waiting.
import { afterAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { tmp } from './tmp.ts'

const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { fakeHerdr } = await import('./fake-herdr.ts')
const { Worktrees } = await import('../server/live/engine/worktrees.ts')
const { ProfileStore, MODEL_KEYS } = await import('../server/live/profiles.ts')

const src = new LiveSource()
// herdr makes task worktrees: a stand-in on real git, and no terminal for their agents (no herdr is there)
const fake = fakeHerdr()
fake.h.createTab = async () => {
  throw new Error('herdr is not here')
}
Object.assign(src.engine, { wt: new Worktrees(fake.h as never) })
afterAll(() => src.stop())

/** a repo a test made, with its first commit */
const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'
const run = (cmd: string, cwd: string) => execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8', timeout: 30_000 }).trim()
const idOf = (out: string) => out.match(/([A-Z]+-\d+)/)![1]
/** the profiles the source holds, as its store keeps them (the test can break one on purpose) */
const stored = () => (src as unknown as { profiles: { store: ProfileStore } }).profiles.store

describe('Settings → Models → profiles: the actions the screen sends', () => {
  test('save, read, preview, apply, undo, rename and delete through the actions', async () => {
    const dir = tmp('profiles-src')
    run(REPO, dir)
    const p = await src.places.add(dir, 'profiles-act')
    const place = placeId.space(p.name)
    expect(await src.act({ type: 'profiles' })).toMatchObject({ active: 'Custom' })
    expect(await src.act({ type: 'profile-save', name: 'act-night', limits: true })).toMatchObject({ ok: true, profile: { name: 'act-night', limits: true } })
    expect(await src.act({ type: 'profile-save', name: 'act-night' })).toMatchObject({ ok: false, exists: true })
    expect(await src.act({ type: 'profile-save', name: 'act-night', force: true })).toMatchObject({ ok: true })
    expect(await src.act({ type: 'setting', key: 'task.agent', value: 'pi', place })).toEqual({ ok: true })
    const preview = (await src.act({ type: 'profile-preview', name: 'act-night' })) as { ok: boolean; changes: { key: string; where: string }[] }
    expect(preview.ok).toBe(true)
    expect(preview.changes.map((c) => `${c.where}:${c.key}`)).toEqual([`${p.name}:task.agent`])
    const applied = (await src.act({ type: 'profile-apply', name: 'act-night' })) as { ok: boolean; changes: { place: string; key: string }[] }
    expect(applied).toMatchObject({ ok: true, name: 'act-night' })
    expect(applied.changes.map((c) => [c.place, c.key])).toEqual([[place, 'task.agent']])
    // the profile saved the space with nothing of its own: applying it unsets the agent the space had set
    expect(src.settings.pick('task.agent', { space: p.name }).from).not.toBe('space')
    expect(((await src.act({ type: 'profiles' })) as { active: string; undo?: { label: string } }).active).toBe('act-night')
    expect(await src.act({ type: 'profile-undo' })).toMatchObject({ ok: true, name: 'act-night', changes: [{ key: 'task.agent' }] })
    expect(await src.act({ type: 'profile-undo' })).toMatchObject({ ok: false, error: 'Nothing to undo: no profile has been applied.' })
    expect(await src.act({ type: 'profile-rename', name: 'act-night', to: 'act-day' })).toEqual({ ok: true })
    expect(await src.act({ type: 'profile-delete', name: 'act-day' })).toEqual({ ok: true })
    expect(await src.act({ type: 'profile-delete', name: 'act-day' })).toEqual({ ok: false, error: 'No profile called act-day.' })
    expect(await src.act({ type: 'profile-preview', name: 'act-day' })).toMatchObject({ ok: false })
    expect(await src.act({ type: 'profile-apply', name: 'act-day' })).toMatchObject({ ok: false, error: 'No profile called act-day.' })
  })

  test('a profile a refused setting breaks is not applied from the screen either, and the preview says why', async () => {
    const dir = tmp('profiles-refuse')
    run(REPO, dir)
    const p = await src.places.add(dir, 'profiles-refuse')
    void p
    expect(await src.act({ type: 'profile-save', name: 'broken' })).toMatchObject({ ok: true })
    stored().f.profiles.find((x) => x.name === 'broken')!.values.all['task.model'] = 'bad!'
    expect(await src.act({ type: 'setting', key: 'task.agent', value: 'pi' })).toEqual({ ok: true })
    const pre = (await src.act({ type: 'profile-preview', name: 'broken' })) as { refused: { key: string; error: string }[] }
    expect(pre.refused.map((x) => x.key)).toEqual(['task.model'])
    expect(await src.act({ type: 'profile-apply', name: 'broken' })).toMatchObject({ ok: false, error: 'Nothing was applied: 1 setting would be refused.' })
    expect(await src.act({ type: 'setting', key: 'task.agent', value: null })).toEqual({ ok: true })
  })
})

describe('shepherdr profile: the command, verb by verb', () => {
  test('list, save, show, preview, apply, undo, rename and delete say what they did; a mistake says what to type', async () => {
    const dir = tmp('profiles-cli')
    run(REPO, dir)
    const p = await src.places.add(dir, 'profiles-cli')
    const place = placeId.space(p.name)
    const cli = (args: string[]) => src.cli(args, { chat: place })
    expect(await cli(['profile'])).toMatchObject({ code: 0, out: expect.stringContaining('In force: ') })
    // save: a name, the limits, and a saved name only with --force
    expect(await cli(['profile', 'save'])).toMatchObject({ code: 1, out: expect.stringContaining('shepherdr profile list | save <name>') })
    const saved = await cli(['profile', 'save', 'cli', 'night', '--limits'])
    expect(saved).toEqual({ out: `Saved cli night: the models and the limits of Everywhere, this machine and ${src.places.spaces.length + 1} spaces (home included).\n`, code: 0 })
    expect(await cli(['profile', 'save', 'cli', 'night'])).toEqual({ out: 'cli night is a profile already. Add --force to replace it.\n', code: 1 })
    expect(await cli(['profile', 'save', 'cli', 'night', '--force'])).toMatchObject({ code: 0, out: expect.stringContaining('(home included).') })
    // show: what it sets, at each level
    const shown = await cli(['profile', 'show', 'cli', 'night'])
    expect(shown.code).toBe(0)
    expect(shown.out).toMatch(/^cli night: Models, saved just now/)
    expect(shown.out).toContain('Everywhere\n  nothing set here')
    expect((await cli(['profile', 'show'])).code).toBe(1)
    expect((await cli(['profile', 'show', 'nope'])).out).toBe('No profile called nope.\n')
    // a change, then the preview and the apply of it
    expect(await src.act({ type: 'setting', key: 'task.agent', value: 'pi', place })).toEqual({ ok: true })
    const pre = await cli(['profile', 'preview', 'cli', 'night'])
    expect(pre.code).toBe(0)
    expect(pre.out).toContain('cli night would change 1 setting:')
    expect(pre.out).toContain(`${p.name}\n  Tasks · Primary · Agent: pi → not set`)
    expect((await cli(['profile', 'preview'])).code).toBe(1)
    expect((await cli(['profile', 'preview', 'nope'])).out).toBe('No profile called nope.\n')
    const applied = await cli(['profile', 'apply', 'cli', 'night'])
    expect(applied.code).toBe(0)
    expect(applied.out).toContain('Applied cli night: 1 setting changed.')
    expect(applied.out).toContain('shepherdr profile undo puts back what this changed.')
    expect(src.settings.pick('task.agent', { space: p.name }).from).not.toBe('space')
    expect((await cli(['profile', 'apply'])).code).toBe(1)
    expect((await cli(['profile', 'apply', 'nope'])).out).toBe('No profile called nope.\n')
    // in force now, nothing to change
    expect(await cli(['profile', 'apply', 'cli', 'night'])).toMatchObject({ code: 0, out: expect.stringContaining('cli night is in force already') })
    expect(await cli(['profile', 'list'])).toMatchObject({ code: 0, out: expect.stringContaining('In force: cli night. Undo: Before cli night, ') })
    // undo puts back the one change; a second undo has nothing
    expect(await src.act({ type: 'setting', key: 'task.agent', value: 'pi', place })).toEqual({ ok: true })
    expect(await cli(['profile', 'apply', 'cli', 'night'])).toMatchObject({ code: 0 })
    const undone = await cli(['profile', 'undo'])
    expect(undone.code).toBe(0)
    expect(undone.out).toContain("Undone: cli night's apply put back 1 setting.")
    // every apply keeps a point, even one that changed nothing: the undo steps back through them, the newest first
    let steps = 0
    while ((await cli(['profile', 'undo'])).code === 0) steps++
    expect(steps).toBeLessThanOrEqual(5)
    expect(await cli(['profile', 'undo'])).toEqual({ out: 'Nothing to undo: no profile has been applied.\n', code: 1 })
    // rename and delete
    expect((await cli(['profile', 'rename', 'cli night'])).code).toBe(1)
    expect(await cli(['profile', 'rename', 'nope', 'x'])).toEqual({ out: 'No profile called nope.\n', code: 1 })
    expect(await cli(['profile', 'rename', 'cli night', 'late night'])).toEqual({ out: 'cli night is called late night now.\n', code: 0 })
    expect((await cli(['profile', 'delete'])).code).toBe(1)
    expect(await cli(['profile', 'delete', 'late night'])).toEqual({ out: 'Deleted late night. Its undo points stay until they are used.\n', code: 0 })
    expect(await cli(['profile', 'delete', 'late night'])).toEqual({ out: 'No profile called late night.\n', code: 1 })
    expect(await cli(['profile', 'nope'])).toMatchObject({ code: 1, out: expect.stringContaining('shepherdr profile list | save') })
  })

  test('a refused apply says which settings and why, and changes none of them', async () => {
    const dir = tmp('profiles-cli-refuse')
    run(REPO, dir)
    const p = await src.places.add(dir, 'profiles-cli-refuse')
    const place = placeId.space(p.name)
    expect((await src.cli(['profile', 'save', 'cli-bad'], { chat: place })).code).toBe(0)
    stored().f.profiles.find((x) => x.name === 'cli-bad')!.values.machine['task.model'] = 'bad!'
    expect(await src.act({ type: 'setting', key: 'task.agent', value: 'pi', place })).toEqual({ ok: true })
    const r = await src.cli(['profile', 'apply', 'cli-bad'], { chat: place })
    expect(r.code).toBe(1)
    expect(r.out).toContain('Nothing was applied: 1 setting would be refused.')
    expect(r.out).toMatch(/\n {2}\S.* · Tasks · Primary · Model: /)
    expect(src.settings.pick('task.agent', { space: p.name })).toEqual({ value: 'pi', from: 'space' })
    expect(await src.act({ type: 'setting', key: 'task.agent', value: null, place })).toEqual({ ok: true })
  })

  test('--apply-waiting moves the waiting tasks the profile reaches, as set --apply-waiting does; without it they are only counted', async () => {
    const dir = tmp('profiles-cli-wait')
    run(REPO, dir)
    const p = await src.places.add(dir, 'profiles-cli-wait')
    const place = placeId.space(p.name)
    const engine = src.engine as unknown as { machine?: () => { busy?: string; herdr: boolean } }
    const was = engine.machine
    // herdr not answering holds every task: both wait
    engine.machine = () => ({ herdr: false })
    try {
      const a = idOf((await src.cli(['task', 'add', 'Waits', '--desc', 'x'], { chat: place })).out)
      const b = idOf((await src.cli(['task', 'add', 'Waits too', '--desc', 'y'], { chat: place })).out)
      expect(src.engine.task(a)!.held?.why).toBe('machine')
      // the space's own pi, saved; then changed by hand (Claude Code), so the apply moves it back
      expect(await src.act({ type: 'setting', key: 'task.agent', value: 'pi', place })).toEqual({ ok: true })
      expect((await src.cli(['profile', 'save', 'wait-pi'], { chat: place })).code).toBe(0)
      expect(await src.act({ type: 'setting', key: 'task.agent', value: 'Claude Code', place })).toEqual({ ok: true })
      const counted = await src.cli(['profile', 'apply', 'wait-pi'], { chat: place })
      expect(counted.code).toBe(0)
      expect(counted.out).toContain('2 waiting tasks would change with it: add --apply-waiting to move them too.')
      expect(src.engine.task(a)!.agent).toMatchObject({ kind: 'claude' })
      // again, and moved: the waiting tasks start on pi
      expect(await src.act({ type: 'setting', key: 'task.agent', value: 'Claude Code', place })).toEqual({ ok: true })
      const moved = await src.cli(['profile', 'apply', 'wait-pi', '--apply-waiting'], { chat: place })
      expect(moved.code).toBe(0)
      expect(moved.out).toMatch(new RegExp(`2 waiting tasks in ${p.name} will start on pi`))
      expect([src.engine.task(a)!.agent, src.engine.task(b)!.agent]).toEqual([{ kind: 'pi' }, { kind: 'pi' }])
      // undo moves them back the same way, with the flag
      const undone = await src.cli(['profile', 'undo', '--apply-waiting'], { chat: place })
      expect(undone.code).toBe(0)
      expect(undone.out).toContain("Undone: wait-pi's apply put back 1 setting.")
      expect(undone.out).toContain(`2 waiting tasks in ${p.name} will start on Claude Code when their turn comes.`)
      expect(src.engine.task(a)!.agent).toMatchObject({ kind: 'claude' })
      expect(await src.act({ type: 'setting', key: 'task.agent', value: null, place })).toEqual({ ok: true })
    } finally {
      engine.machine = was
    }
  })

  test('a reviewer change of a profile reaches the waiting tasks as the reviewer does, with the flag', async () => {
    const dir = tmp('profiles-cli-rev')
    run(REPO, dir)
    const p = await src.places.add(dir, 'profiles-cli-rev')
    const place = placeId.space(p.name)
    const engine = src.engine as unknown as { machine?: () => { busy?: string; herdr: boolean } }
    const was = engine.machine
    engine.machine = () => ({ herdr: false })
    try {
      await src.cli(['task', 'add', 'Reviewed', '--desc', 'z'], { chat: place })
      expect(await src.act({ type: 'setting', key: 'reviewer.agent', value: 'Codex', place })).toEqual({ ok: true })
      expect((await src.cli(['profile', 'save', 'rev-codex'], { chat: place })).code).toBe(0)
      expect(await src.act({ type: 'setting', key: 'reviewer.agent', value: 'pi', place })).toEqual({ ok: true })
      const out = await src.cli(['profile', 'apply', 'rev-codex', '--apply-waiting'], { chat: place })
      expect(out.code).toBe(0)
      expect(out.out).toMatch(/waiting task/)
      expect(out.out).not.toContain('Tasks · Primary · Agent:')
      expect(await src.act({ type: 'setting', key: 'reviewer.agent', value: null, place })).toEqual({ ok: true })
    } finally {
      engine.machine = was
    }
  })

  test('the keys a profile holds are the models of the four roles, backups included', () => {
    expect(MODEL_KEYS).toContain('reviewer.fallback5Effort')
    expect(MODEL_KEYS).toContain('advisor.fallback5Model')
    expect(MODEL_KEYS).toContain('task.fallback2Model')
    expect(MODEL_KEYS).not.toContain('space.maxTasks')
  })
})
