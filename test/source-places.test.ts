// Places from the command and the screen: adding, removing, ordering and renaming a space, the space its repo moved
// with, and a renamed space's name in every reply.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('source')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
// no OpenCode database of this machine: its mirror copies rows from one that isn't there (an OpenCode log reads as a
// copy of its session)
process.env.SHEPHERDR_OPENCODE_DB = join(process.env.SHEPHERDR_HOME, 'no-opencode.db')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { HOST, NAME, placeId, Places } = await import('../server/live/places.ts')
const { herdr } = await import('../server/live/herdr.ts')
const { Worktrees } = await import('../server/live/engine/worktrees.ts')
const { fakeHerdr } = await import('./fake-herdr.ts')

const src = new LiveSource()
// this file is not about the spacing between starts: with machine.startEvery's 2 minutes, the shared machine of these
// tests would start one task every two minutes (every start Shepherdr makes by itself follows it now, engine.startGate)
src.settings.set('machine.startEvery', '0', 'machine')
// herdr makes task worktrees: a stand-in on real git; no terminal opens for their agents (no herdr is there)
const fake = fakeHerdr()
fake.h.createTab = async () => {
  throw new Error('herdr is not here')
}
Object.assign(src.engine, { wt: new Worktrees(fake.h as never) })
afterAll(() => src.stop())

/** what a test waits for has come true, however slow the machine (a timer, another process) */
const until = async (f: () => boolean, ms = 8000, said = 'it') => {
  for (const t0 = Date.now(); !f(); await Bun.sleep(20)) if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${said}`)
}

/**
 * Something that only has to settle before the tests after this one (an agent herdr can't start): waited for at
 * most 8 s — the 20 s these tests run in is the other bound — and the test goes on either way, however slow the
 * machine. The fixed 5 s these had failed a slow runner; a longer wait would only spend a test's own time.
 */
const settle = (f: () => boolean, said: string) => until(f, 8000, said).catch(() => undefined)

/** a repo a test made, with its first commit (never the folder the tests run from) */
const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'

/**
 * The test's own git, bounded: 30 s, and a stalled one says which command it was, instead of bun taking the whole test
 * away with no word on the step (SHE-9 bounded the engine worlds' and herdr's stand-in after run 42020185856, but a
 * timeout there reads just "ETIMEDOUT", which names nothing either).
 */
const run = (cmd: string, cwd: string): string => {
  try {
    return execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8', timeout: 30_000 }).trim()
  } catch (e) {
    throw new Error(`\`${cmd}\` in ${cwd}: ${(e as Error).message.trim()}`, { cause: e })
  }
}

/** a project with a task whose agent has committed work on its branch (herdr isn't there: its agent can't start) */
async function workedTask(name: string) {
  const dir = tmp('src-repo')
  run(REPO, dir)
  const p = await src.places.add(dir, name)
  return { t: await worked(p), dir, place: placeId.space(p.name) }
}

/**
 * The worktree herdr's stand-in makes for a task, waited for until it is there or the start has said why it can't be —
 * so a start that never gets one fails with the app's own words, inside the 20 s a test has unless it says otherwise.
 */
async function worktree(t: { id: string; worktree?: string; trouble?: string }, ms = 15_000) {
  await until(() => !!t.worktree || !!t.trouble, ms, `${t.id}'s worktree`)
  if (!t.worktree) throw new Error(`${t.id} got no worktree: ${t.trouble}`)
}

/**
 * A task in a place already there, its agent's work committed on its branch (herdr isn't there: its agent can't
 * start). It waits for the worktree herdr's stand-in makes, so the commit never lands in a folder not there yet.
 */
async function worked(p: { name: string }, file = 'x.txt') {
  const t = src.engine.add({ project: p.name, title: 'Worked', by: 'test' })
  await worktree(t)
  run(`echo x > ${file} && git add -A && git commit -qm work`, t.worktree!)
  return t
}

describe('adding a space from the sidebar', () => {
  const home = tmp('home')
  const realHome = process.env.HOME
  // git's identity sits in the operator's ~/.gitconfig, which this HOME hides: the commits made here get one of their own
  const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test' }
  beforeAll(() => {
    process.env.HOME = home
    Object.assign(process.env, identity)
  })
  afterAll(() => {
    process.env.HOME = realHome
    for (const k of Object.keys(identity)) delete process.env[k]
  })

  test('on this machine: a new folder becomes a repo and a space, like shepherdr space add', async () => {
    const r = await src.addSpace({ machine: HOST, path: '~/dev/fresh', name: 'fresh-app', create: true })
    expect(r.place).toBe(placeId.space('fresh-app'))
    expect(src.places.byName('fresh-app')?.path).toEndWith('/dev/fresh')
    expect(src.snapshot().places.some((p) => p.id === r.place)).toBe(true)
    const f = await src.folders(HOST, '~/dev')
    expect(f.entries).toEqual([{ name: 'fresh', path: '~/dev/fresh', repo: true, added: true }])
  })
  test('a folder that is not a repo is not added without create; nothing outside home either', async () => {
    mkdirSync(join(home, 'plain'))
    await expect(src.addSpace({ machine: HOST, path: '~/plain' })).rejects.toThrow('not a git repository')
    await expect(src.addSpace({ machine: HOST, path: '/etc', create: true })).rejects.toThrow('Only folders in your home')
    await expect(src.addSpace({ machine: HOST, path: '~/plain', name: 'a/b', create: true })).rejects.toThrow()
  })
  test('another machine: folders and adding pass through to its copy; one unknown or out of reach says so', async () => {
    const got: { path: string; body?: unknown }[] = []
    const far = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const u = new URL(req.url)
        got.push({ path: u.pathname + u.search, body: req.method === 'POST' ? await req.json() : undefined })
        if (u.pathname === '/api/snapshot') return Response.json({ name: 'S', host: 'far', places: [{ id: 'p:far:~', name: 'home', machine: 'far', home: true, level: 1, status: 'idle', mode: 'manual', chat: 'p:far:~' }], machines: [{ id: 'm:far', machine: 'far', name: 'far', status: 'idle' }], tasks: [], automations: {}, asks: {}, settings: [], overrides: {}, user: 'u' })
        if (u.pathname === '/api/folders') return Response.json({ path: u.searchParams.get('path'), exists: true, dir: true, repo: null, entries: [] })
        if (u.pathname === '/api/spaces') return Response.json({ error: 'Another space on far has that name.' }, { status: 500 })
        return new Response('no', { status: 404 })
      },
    })
    try {
      src.peers!.adopt('far', `http://127.0.0.1:${far.port}`)
      await until(() => !!src.peers!.list().find((l) => l.rec.machine === 'far')?.reachable, 8000, "the far peer to be reachable")
      // an older helper there still says Manual: read as regular
      expect(src.snapshot().places.find((p) => p.id === 'p:far:~')?.mode).toBe('regular')
      expect(src.snapshot().machines.find((m) => m.id === 'm:far')?.status).toBe('idle')
      expect((await src.folders('far', '~/dev')).path).toBe('~/dev')
      expect(got.some((g) => g.path === `/api/folders?machine=far&path=${encodeURIComponent('~/dev')}`)).toBe(true)
      await expect(src.addSpace({ machine: 'far', path: '~/x', name: 'x' })).rejects.toThrow('Another space on far has that name.')
      expect(got.find((g) => g.path === '/api/spaces')?.body).toEqual({ machine: 'far', path: '~/x', name: 'x' })
      await expect(src.folders('nowhere', '~')).rejects.toThrow('No machine called nowhere')
    } finally {
      far.stop(true)
    }
  })
})

describe('removing a space', () => {
  test('the command and the sidebar forget it, its folder stays; not while one of its tasks works; added again, its tasks come back', async () => {
    const { t, dir, place } = await workedTask('forgotten')
    const statusOf = src.engine.statusOf.bind(src.engine)
    src.engine.statusOf = (x) => (x.id === t.id ? 'work' : statusOf(x))
    try {
      const busy = await src.cli(['space', 'remove', 'forgotten'], {})
      expect(busy.code).toBe(1)
      expect(busy.out).toContain(`${t.id} is still working: pause or finish it first.`)
      expect(await src.act({ type: 'space-remove', place })).toEqual({ ok: false, error: `${t.id} is still working: pause or finish it first.` })
    } finally {
      src.engine.statusOf = statusOf
    }
    expect(src.places.byName('forgotten')).toBeDefined()
    expect(await src.act({ type: 'space-remove', place })).toEqual({ ok: true })
    expect(src.places.byName('forgotten')).toBeUndefined()
    expect(existsSync(join(dir, 'README.md'))).toBe(true)
    expect(src.snapshot().places.some((p) => p.id === place)).toBe(false)
    expect(src.snapshot().tasks.some((x) => x.id === t.id)).toBe(false)
    expect(await src.act({ type: 'space-remove', place })).toEqual({ ok: false, error: 'That space is gone already.' })
    expect((await src.cli(['space', 'remove', 'forgotten'], {})).out).toContain('No space called forgotten')
    expect((await src.cli(['space', 'remove'], {})).out).toContain('shepherdr space remove <name>')
    // added again (project, from before spaces, still works): its task is back
    await src.cli(['project', 'add', dir, '--name', 'forgotten'], {})
    expect(src.snapshot().tasks.some((x) => x.id === t.id)).toBe(true)
    const r = await src.cli(['space', 'remove', 'forgotten'], {})
    expect(r.code).toBe(0)
    expect(r.out.trim()).toBe(`Removed forgotten from Shepherdr; ${dir} and its code stay on disk. shepherdr space add ${dir} --name forgotten brings it back with its open tasks and chat.`)
  })
  test("the home space can be renamed, never removed: by the sidebar or the command", async () => {
    const home = placeId.home()
    const says = `home is ${NAME}'s home space: it can be renamed, not removed.`
    expect(await src.act({ type: 'space-remove', place: home })).toEqual({ ok: false, error: says })
    const r = await src.cli(['space', 'remove', 'home'], {})
    expect(r.code).toBe(1)
    expect(r.out).toContain(says)
    expect(src.snapshot().places.find((p) => p.id === home)).toMatchObject({ home: true, name: 'home' })
  })
  test('shepherdr space add refuses a name another space has, or one that breaks the rules', async () => {
    const repo = () => {
      const dir = tmp('src-taken')
      run('git init -q -b main', dir)
      return dir
    }
    await src.places.add(repo(), 'taken')
    const before = src.places.spaces.length
    for (const name of ['taken', 'home']) {
      const r = await src.cli(['space', 'add', repo(), '--name', name], {})
      expect(r.code).toBe(1)
      expect(r.out).toContain('Another space on this machine has that name.')
    }
    const bad = await src.cli(['space', 'add', repo(), '--name', 'My App'], {})
    expect(bad.code).toBe(1)
    expect(bad.out).toContain('Lowercase only.')
    expect(src.places.spaces.length).toBe(before)
  })
})

describe('the order of places', () => {
  test('A to Z until dragged; the order is kept on disk, and a new space slots in A to Z', async () => {
    const add = async (name: string) => {
      const dir = tmp('src-order')
      run('git init -q -b main', dir)
      await src.places.add(dir, name)
    }
    await add('order-zed')
    await add('order-alpha')
    const mine = () => src.snapshot().places.filter((p) => p.name.startsWith('order-')).map((p) => p.name)
    expect(mine()).toEqual(['order-alpha', 'order-zed'])
    const machine = placeId.machine()
    const ids = src.snapshot().places.filter((p) => !p.home && p.machine === HOST).map((p) => p.id)
    const dragged = [placeId.space('order-zed'), ...ids.filter((id) => id !== placeId.space('order-zed'))]
    expect(await src.act({ type: 'order', under: machine, ids: dragged })).toEqual({ ok: true })
    expect(mine()).toEqual(['order-zed', 'order-alpha'])
    // the machine's home space is always first, then its spaces in their order
    const places = src.snapshot().places
    expect(places.find((p) => p.machine === HOST)?.id).toBe(placeId.home())
    expect(places.findIndex((p) => p.name === 'order-zed')).toBe(places.findIndex((p) => p.id === placeId.home()) + 1)
    expect(new Places().order[machine]).toEqual(dragged)
    await add('order-beta')
    expect(mine()).toEqual(['order-zed', 'order-alpha', 'order-beta'])
    expect(await src.act({ type: 'order', under: machine, ids: 'nope' } as never)).toEqual({ ok: false, error: 'No order to keep.' })
  })
})

describe('renaming places', () => {
  test("only the name that shows changes, kept on disk; its id, folder and task key stay; a space's name follows the rules", async () => {
    const dir = tmp('src-rename')
    run('git init -q -b main', dir)
    const p = await src.places.add(dir, 'rename-me')
    const id = placeId.space('rename-me')
    const home = placeId.home()
    const machine = placeId.machine()
    const named = (x: string) => src.snapshot().places.find((y) => y.id === x)?.name
    // a space's name, as Slack's channels: lowercase, no spaces
    expect(await src.act({ type: 'rename', id, name: '  My   App ' })).toEqual({ ok: false, error: 'Lowercase only.' })
    expect(await src.act({ type: 'rename', id, name: 'my app' })).toEqual({ ok: false, error: 'No spaces: use - or _.' })
    expect(await src.act({ type: 'rename', id, name: 'my-app' })).toEqual({ ok: true })
    expect(named(id)).toBe('my-app')
    expect(src.chatName(id)).toBe('my-app')
    expect([p.name, p.path, src.places.space(id)?.key]).toEqual(['rename-me', dir, p.key])
    expect(new Places().names[id]).toBe('my-app')
    // the command too
    expect((await src.cli(['space', 'rename', 'my-app', 'Bad Name'], {})).code).toBe(1)
    expect((await src.cli(['space', 'rename', 'my-app', 'good_name'], {})).out).toContain('my-app is called good_name now.')
    expect(named(id)).toBe('good_name')
    // a machine's name is free text
    expect(await src.act({ type: 'rename', id: machine, name: 'Home box' })).toEqual({ ok: true })
    expect(src.snapshot().machines.find((m) => m.id === machine)).toMatchObject({ name: 'Home box', machine: HOST })
    // and its emoji, as a Slack section's: one emoji, kept on disk; '' takes it away, none leaves it; a space takes none
    expect(await src.act({ type: 'rename', id: machine, name: 'Home box', emoji: '🏠' })).toEqual({ ok: true })
    expect(src.snapshot().machines.find((m) => m.id === machine)?.emoji).toBe('🏠')
    expect(new Places().emojis[machine]).toBe('🏠')
    expect(await src.act({ type: 'rename', id: machine, name: 'Home box' })).toEqual({ ok: true })
    expect(src.snapshot().machines.find((m) => m.id === machine)?.emoji).toBe('🏠')
    for (const bad of ['hi', '🏠🚀', 'x🏠'])
      expect(await src.act({ type: 'rename', id: machine, name: 'Home box', emoji: bad })).toEqual({ ok: false, error: 'Only a machine takes an emoji, one at a time.' })
    expect(await src.act({ type: 'rename', id, name: 'my-app', emoji: '🚀' })).toEqual({ ok: false, error: 'Only a machine takes an emoji, one at a time.' })
    expect(await src.act({ type: 'rename', id: machine, name: 'Home box', emoji: '👍🏽' })).toEqual({ ok: true })
    expect(await src.act({ type: 'rename', id: machine, name: 'Home box', emoji: '' })).toEqual({ ok: true })
    expect(src.snapshot().machines.find((m) => m.id === machine)?.emoji).toBeUndefined()
    expect(new Places().emojis).toEqual({})
    // the home space can be renamed; another space on the machine can't take its name
    expect(await src.act({ type: 'rename', id, name: 'home' })).toEqual({ ok: false, error: 'Another space on this machine has that name.' })
    expect(await src.act({ type: 'rename', id: home, name: 'base' })).toEqual({ ok: true })
    expect(named(home)).toBe('base')
    expect(await src.act({ type: 'rename', id: 'all', name: 'Everything' })).toEqual({ ok: false, error: 'Nothing to rename.' })
    expect(await src.act({ type: 'rename', id, name: 'x'.repeat(81) })).toEqual({ ok: false, error: 'A name fits 80 characters.' })
    // empty: its own name again
    expect(await src.act({ type: 'rename', id, name: '' })).toEqual({ ok: true })
    expect(await src.act({ type: 'rename', id: home, name: '' })).toEqual({ ok: true })
    expect(await src.act({ type: 'rename', id: machine, name: '' })).toEqual({ ok: true })
    expect(named(id)).toBe('rename-me')
    expect(named(home)).toBe('home')
    expect(new Places().names).toEqual({})
  })
})

describe("the home space's herdr space", () => {
  test('is home: the one the coordinators shared, still called Coordinators, is renamed in place, never a repo\'s, and no second one opens', async () => {
    const saved = { ...herdr }
    let spaces = [
      { workspace_id: 'w1', label: 'Coordinators', worktree: { checkout_path: '/r/Coordinators', is_linked_worktree: false, repo_key: '/r/Coordinators/.git', repo_name: 'Coordinators', repo_root: '/r/Coordinators' } },
      { workspace_id: 'w2', label: 'Coordinators' },
    ]
    const opened: string[] = []
    Object.assign(herdr, {
      workspaces: async () => spaces,
      renameWorkspace: async (id: string, label: string) => void (spaces = spaces.map((w) => (w.workspace_id === id ? { ...w, label } : w))),
      createWorkspace: async (label: string) => (opened.push(`new ${label}`), Promise.reject(new Error('herdr is not here'))),
      createTab: async (id: string) => (opened.push(id), Promise.reject(new Error('herdr is not here'))),
    })
    try {
      // its coordinator opens in the old space, renamed; next time it is found by its new name
      await (src as unknown as { coordinator(id: string): Promise<unknown> }).coordinator(placeId.home()).catch(() => undefined)
      expect(spaces.map((w) => w.label)).toEqual(['Coordinators', 'home'])
      expect((await src.agents.space('home', 'Coordinators'))?.workspace_id).toBe('w2')
      expect(opened).toEqual(['w2'])
      // with none left of either name, it is made under the new one
      spaces = []
      await (src as unknown as { coordinator(id: string): Promise<unknown> }).coordinator(placeId.home()).catch(() => undefined)
      expect(opened).toEqual(['w2', 'new home'])
    } finally {
      Object.assign(herdr, saved)
    }
  })
})

describe('a space whose repo moved', () => {
  test('is found again by its repo’s id: adding it at its new folder is that space, said plainly, with its own folder line', async () => {
    const base = tmp('src-moved')
    const dir = join(base, 'shop')
    mkdirSync(dir)
    run(REPO, dir)
    const p = await src.places.add(dir, 'shop')
    expect(p.repoId).toBeTruthy()
    const to = join(base, 'shop-renamed')
    renameSync(dir, to)
    const added = await src.cli(['space', 'add', to], {})
    expect(added.code).toBe(0)
    expect(added.out).toContain(`Found shop again at ${to} (its folder was ${dir}), by its repo: its name, tasks, chat and mode are as they were.`)
    // and its coordinator was restarted in the folder the repo is in now (herdr isn't here, so the start itself fails)
    expect(src.agents.record(placeId.space('shop'))?.cwd).toBe(to)
    expect(src.places.byName('shop')!.path).toBe(to)
    expect(src.places.spaces.filter((x) => x.name === 'shop').length).toBe(1)
    // the space's own view says where it is, and where it was
    const listed = await src.cli(['space', 'list'], {})
    expect(listed.out).toContain(`${to}  (its repo moved here: it was ${dir})`)
    const shown = await src.cli(['show', '--space', 'shop'], {})
    expect(shown.out).toContain(`Folder: ${to}`)
    expect(shown.out).toContain(`its repo moved here: it was ${dir}`)
    // a name asked for is not taken: the space found again keeps the name it has, and the command says so
    const again = await src.cli(['space', 'add', to, '--name', 'other'], {})
    expect(again.out).toContain('shop is a space already')
    renameSync(to, to + '-2')
    const moved = await src.cli(['space', 'add', to + '-2', '--name', 'other'], {})
    expect(moved.out).toContain('It keeps its name shop.')
  })
})

describe('a renamed space: the replies name it as it shows, and its settings, cap and apply-to-waiting find it by either name', () => {
  test('set, apply-to-waiting and --space: the shown name in each answer, the place id and the shown name both find it', async () => {
    const dir = tmp('src-repo')
    run(REPO, dir)
    const p = await src.places.add(dir, 'site-added')
    src.places.rename(placeId.space(p.name), 'lyvora-site')
    const place = placeId.space(p.name)
    const idOf = (out: string) => out.match(/([A-Z]+-\d+)/)![1]
    const engine = src.engine as unknown as { machine?: () => { busy?: string; herdr: boolean } }
    const was = engine.machine
    // herdr not answering holds every task: they all wait
    engine.machine = () => ({ herdr: false })
    try {
      const a = idOf((await src.cli(['task', 'add', 'Waits', '--desc', 'x'], { chat: place })).out)
      const b = idOf((await src.cli(['task', 'add', 'Waits too', '--desc', 'y'], { chat: place })).out)
      expect(src.engine.task(a)!.agent).toMatchObject({ kind: 'claude' })
      // the cap is set by the shown name: its answer names the space as it shows, and the cap is kept under the name it was added with
      expect((await src.cli(['set', 'space.maxTasks', '2', '--space', 'lyvora-site'], { chat: place })).out).toContain("space.maxTasks = 2 (lyvora-site's)")
      expect(src.settings.get('space.maxTasks', p.name)).toBe('2')
      expect(src.settings.get('space.maxTasks', 'lyvora-site')).toBe('off')
      expect((await src.cli(['set', 'space.maxTasks', 'off', '--space', 'lyvora-site'], { chat: place })).out).toContain("(lyvora-site's)")
      // the question by the place id: the answer names the space as it shows
      expect(await src.act({ type: 'setting', key: 'task.agent', value: 'pi', place })).toEqual({ ok: true })
      expect(await src.act({ type: 'apply-to-waiting', key: 'task.agent', place, dry: true })).toMatchObject({ ok: true, changed: 2, spaces: [{ name: 'lyvora-site', words: 'pi', changed: 2 }] })
      expect(src.engine.task(a)!.agent).toMatchObject({ kind: 'claude' })
      // yes, by the shown name: the command's line names it as it shows
      const byName = await src.cli(['set', 'task.agent', 'pi', '--space', 'lyvora-site', '--apply-waiting'], { chat: place })
      expect(byName.out).toContain('2 waiting tasks in lyvora-site will start on pi when their turn comes.')
      expect([src.engine.task(a)!.agent, src.engine.task(b)!.agent]).toEqual([{ kind: 'pi' }, { kind: 'pi' }])
      // the same by the place id, back to Claude Code: the one scope, whichever name it is given by
      const byPlace = await src.cli(['set', 'task.agent', 'Claude Code', '--space', place, '--apply-waiting'], { chat: place })
      expect(byPlace.out).toContain('2 waiting tasks in lyvora-site will start on Claude Code when their turn comes.')
      expect(src.engine.task(a)!.agent).toMatchObject({ kind: 'claude' })
      // its own agent: Everywhere's change keeps it, and the answer says so under the shown name
      expect((await src.cli(['set', 'task.agent', 'Codex', '--space', 'lyvora-site'], { chat: place })).code).toBe(0)
      const kept = await src.cli(['set', 'task.agent', 'pi', '--machine', '--apply-waiting'], { chat: place })
      expect(kept.code).toBe(0)
      // among the other spaces this file's world holds: the list names it as it shows (one or several, keep or keeps)
      expect(kept.out).toMatch(/lyvora-site keeps? its own setting/)
      expect(kept.out).not.toContain(`${p.name} keep`)
      expect(src.engine.task(a)!.agent).toMatchObject({ kind: 'claude' })
    } finally {
      engine.machine = was
    }
  })
})

describe("a renamed space's own cap: the held replies name it as it shows", () => {
  test("a space added as cap-added and shown as lyvora-cap: its cap holds, and task add, tell and start say lyvora-cap, never the added name", async () => {
    const dir = tmp('src-repo')
    run(REPO, dir)
    const p = await src.places.add(dir, 'cap-added')
    src.places.rename(placeId.space(p.name), 'lyvora-cap')
    const place = placeId.space(p.name)
    const idOf = (out: string) => out.match(/([A-Z]+-\d+)/)![1]
    const engine = src.engine as unknown as { machine?: () => { busy?: string; herdr: boolean } }
    const was = engine.machine
    // herdr here: a task starts (its agent is stubbed at work below), so the space's cap is what holds the next one
    engine.machine = () => ({ herdr: true })
    try {
      expect((await src.cli(['set', 'space.maxTasks', '1', '--space', 'lyvora-cap'], { chat: place })).out).toContain("space.maxTasks = 1 (lyvora-cap's)")
      const busy = idOf((await src.cli(['task', 'add', 'Busy', '--desc', 'x'], { chat: place })).out)
      await settle(() => src.engine.working() >= 1, 'the first task to take the space slot')
      const held = idOf((await src.cli(['task', 'add', 'Second', '--desc', 'y'], { chat: place })).out)
      expect(src.engine.task(held)!.held?.why).toBe('space')
      expect(src.engine.subOf(src.engine.task(held)!)).toBe('Waiting for a free slot of lyvora-cap')
      const added = (await src.cli(['task', 'add', 'Third', '--desc', 'z'], { chat: place })).out
      expect(added).toContain("held: lyvora-cap's own limit of 1 tasks is taken")
      expect((await src.cli(['task', 'tell', held, 'Go.'], {})).out).toContain("is held: lyvora-cap's own limit of 1 tasks is taken")
      expect((await src.cli(['task', 'start', held], {})).out).toContain("is first in line: lyvora-cap's own limit of 1 tasks is taken")
      expect(JSON.stringify([added, src.engine.subOf(src.engine.task(held)!)])).not.toContain('cap-added')
      // the cap is still the space's: the one that works is counted, and its settings answer under the added name
      expect(src.engine.spaceCap(src.engine.task(busy)!)).toMatchObject({ space: p.name, shown: 'lyvora-cap', max: 1 })
    } finally {
      engine.machine = was
      src.settings.set('space.maxTasks', null, { space: p.name })
    }
  })
})

describe('a renamed space: every message that names it reads the name it shows, and its lookups keep the name it was added under', () => {
  test('pr and checks without GitHub name the space as it shows', async () => {
    const { t, place } = await workedTask('pr-added')
    src.places.rename(place, 'lyvora-pr')
    const pr = await src.cli(['pr', t.id], { chat: `${t.id}/Agent` })
    expect(pr.out).toContain('No pull request: lyvora-pr has no GitHub remote')
    expect(pr.out).not.toContain('pr-added')
    const checks = await src.cli(['checks', t.id], { chat: `${t.id}/Agent` })
    expect(checks.out).toContain('No GitHub checks: lyvora-pr has no GitHub remote')
    expect(checks.out).not.toContain('pr-added')
    // the task still finds its space by the name it was added under
    expect(src.places.space(place)!.name).toBe('pr-added')
  })

  test('space set base and set space.base name the space as it shows', async () => {
    const dir = tmp('base-shown')
    run('git init -q -b main && git config user.email t@t && git config user.name T && touch README && git add . && git commit -qm init && git branch develop', dir)
    const p = await src.places.add(dir, 'base-added')
    src.places.rename(placeId.space(p.name), 'lyvora-base')
    const byCommand = await src.cli(['space', 'set', 'base', 'develop', '--space', p.name], {})
    expect(byCommand.out).toContain('lyvora-base: new tasks start from and merge into develop. Existing tasks keep their target.')
    const bySetting = await src.cli(['set', 'space.base', 'main', '--space', p.name], {})
    expect(bySetting.out).toContain('lyvora-base: base branch main. Existing tasks keep their target.')
    expect(p.base).toBe('main')
  })

  test('an automation names the space it adds its tasks to as it shows, in its reply and its list', async () => {
    const dir = tmp('auto-shown')
    run(REPO, dir)
    const p = await src.places.add(dir, 'auto-added')
    src.places.rename(placeId.space(p.name), 'lyvora-auto')
    const place = placeId.space(p.name)
    const add = await src.cli(['automation', 'add', 'ShownNightly', '--task', 'Bump deps', '--brief', 'Bump and test.', '--when', 'FREQ=MINUTELY;INTERVAL=5'], { chat: place })
    expect(add.out).toContain('It adds the task “Bump deps” to lyvora-auto, with a fresh agent.')
    expect(add.out).not.toContain('auto-added')
    const list = await src.cli(['automation', 'list'], { chat: place })
    expect(list.out).toContain('ShownNightly · ')
    expect(list.out).toContain(' · lyvora-auto · ')
    expect(list.out).not.toContain('auto-added')
    expect(src.automations.find(place, 'ShownNightly')).toBeDefined()
  })

  test("show's defaults for a task name the space as it shows", async () => {
    const dir = tmp('show-shown')
    run(REPO, dir)
    const p = await src.places.add(dir, 'show-added')
    src.places.rename(placeId.space(p.name), 'lyvora-show')
    const out = (await src.cli(['show', '--space', p.name], {})).out
    expect(out).toContain("Every new task's brief in lyvora-show ends with:")
    expect(out).not.toContain('show-added')
  })

  test("a second Run now while a renamed space's coordinator wakes names it as it shows", async () => {
    const dir = tmp('hb-shown')
    run('git init -q -b main', dir)
    const p = await src.places.add(dir, 'hb-added')
    src.places.rename(placeId.space(p.name), 'lyvora-hb')
    const place = placeId.space(p.name)
    expect(src.settings.set('heartbeat.when', 'off', { space: p.name }).ok).toBe(true)
    const send = src.agents.send
    const status = src.agents.status
    const reachable = src.agents.reachable
    let st = 'idle'
    src.agents.send = (async () => ({ waiting: false })) as unknown as typeof send
    src.agents.status = ((k: string) => (k === place ? st : 'gone')) as typeof status
    src.agents.reachable = true
    try {
      src.places.setMode(place, 'autopilot')
      expect(await src.act({ type: 'setting', key: 'heartbeat.md', value: '- Check the tasks', place })).toEqual({ ok: true })
      expect(await src.act({ type: 'heartbeat', place, op: 'run' })).toEqual({ ok: true, queued: false })
      expect(await src.act({ type: 'heartbeat', place, op: 'run' })).toEqual({ ok: false, error: "lyvora-hb's coordinator is already waking: one wake at a time." })
    } finally {
      // the wake is over: the next turn's end clears it
      st = 'working'
      src.heartbeat(Date.now())
      st = 'idle'
      src.heartbeat(Date.now() + 60_000)
      src.places.setMode(place, 'regular')
      src.agents.send = send
      src.agents.status = status
      src.agents.reachable = reachable
    }
  })
})
