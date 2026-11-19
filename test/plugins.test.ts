// The human's own plugins (~/.shepherdr/plugins): added, replacing a base one of the same name, turned off, and one that
// fails skipped without taking the rest down.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginCatalog, readStaged, stageUserPlugins, writeRegistries } from '../scripts/build-plugins.ts'
import { pluginsPage, setPluginOn } from '../server/plugins.ts'
import { HOME } from '../server/store.ts'
import { CRASH_RELOADS, guardFn, nextCrash, setupGuarded } from '../src/guard.tsx'
import { tmp } from './tmp.ts'

function file(path: string, text = '') {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** a build with base plugins a and b, and a home with the human's own: b (in b's place) and c */
function fixture() {
  const dir = tmp('plugins')
  const home = tmp('plugins-home')
  file(join(dir, 'plugins.json'), JSON.stringify({ plugins: ['a', 'b'] }))
  file(join(dir, 'plugins', 'a', 'client.tsx'))
  file(join(dir, 'plugins', 'b', 'client.tsx'))
  file(join(dir, 'plugins', 'b', 'server.ts'))
  file(join(home, 'plugins', 'b', 'client.tsx'))
  file(join(home, 'plugins', 'c', 'client.tsx'))
  file(join(home, 'plugins', 'c', 'server.ts'))
  // not plugins: a folder with neither part, a name that isn't one, a loose file
  file(join(home, 'plugins', 'notes', 'README.md'))
  file(join(home, 'plugins', 'Bad Name', 'client.tsx'))
  file(join(home, 'plugins', 'loose.ts'))
  return { dir, home }
}

describe('a build with the human’s own plugins', () => {
  test('one is added after the base ones; one with a base name replaces it, in its place', () => {
    const { dir, home } = fixture()
    stageUserPlugins(dir, home)
    expect(pluginCatalog(dir)).toEqual([
      { name: 'a', from: 'base', on: true },
      { name: 'b', from: 'user', overrides: true, on: true },
      { name: 'c', from: 'user', on: true },
    ])
    writeRegistries(dir)
    const client = readFileSync(join(dir, 'generated', 'client-plugins.ts'), 'utf8')
    expect(client).toContain("import a from '../plugins/a/client.tsx'")
    expect(client).toContain(`{ name: "b", load: () => import('../user-plugins/b/client.tsx') }`)
    expect(client).not.toContain('../plugins/b/')
    expect(client).toContain('export const user = ["b","c"]')
    const server = readFileSync(join(dir, 'generated', 'server-plugins.ts'), 'utf8')
    // the base b's server part goes with it; c's loads on its own, so one that throws is only skipped
    expect(server).not.toContain('plugins/b/server.ts')
    expect(server).toContain(`["c", () => import('../user-plugins/c/server.ts')]`)
  })

  test('their list turns any plugin off, base or their own', () => {
    const { dir, home } = fixture()
    file(join(home, 'plugins.json'), JSON.stringify({ off: ['a', 'c'] }))
    stageUserPlugins(dir, home)
    expect(pluginCatalog(dir).filter((p) => p.on).map((p) => p.name)).toEqual(['b'])
    expect(writeRegistries(dir)).toEqual(['b'])
  })

  test("one that didn't build: a new one is off, one replacing a base one leaves the base one on", () => {
    const { dir, home } = fixture()
    stageUserPlugins(dir, home)
    file(join(dir, 'user-plugins.json'), JSON.stringify({ off: [], broken: { b: { error: 'b: no' }, d: { error: 'd: no' } } }))
    rmSync(join(dir, 'user-plugins', 'b'), { recursive: true })
    expect(readStaged(dir).broken.d.error).toBe('d: no')
    expect(pluginCatalog(dir)).toEqual([
      { name: 'a', from: 'base', on: true },
      { name: 'b', from: 'base', on: true, broken: 'b: no' },
      { name: 'c', from: 'user', on: true },
      { name: 'd', from: 'user', on: false, broken: 'd: no' },
    ])
  })
})

describe('Settings → Plugins', () => {
  test('base ones, then yours, each with a switch; what replaces or failed says so', () => {
    const page = pluginsPage(
      [
        { name: 'chat', from: 'base', on: true },
        { name: 'voice', from: 'user', overrides: true, on: true },
        { name: 'hello', from: 'user', on: true, broken: 'hello: no', kept: true },
        { name: 'bad', from: 'user', on: false, broken: 'bad: no' },
        { name: 'boom', from: 'user', on: true },
      ],
      ['chat'],
      { boom: 'boom!' },
    )
    expect(page.rows.map((r) => [r.label, r.group, r.value])).toEqual([
      ['chat', 'Built in', 'off'],
      ['voice', 'Yours', 'on'],
      ['hello', 'Yours', 'on'],
      ['bad', 'Yours', 'on'],
      ['boom', 'Yours', 'on'],
    ])
    expect(page.rows.every((r) => r.key === `plugin.${r.label}` && r.options?.join() === 'on,off')).toBe(true)
    const row = (n: string) => page.rows.find((r) => r.label === n)!
    expect(row('chat').hint).toBe('Turning off: restarting')
    expect(row('voice').hint).toBe('Replaces the built-in one')
    expect(row('hello').warn).toBe("Your latest change doesn't build, so its last good version runs:\nhello: no")
    expect(row('bad').warn).toBe("Skipped: it doesn't build:\nbad: no")
    expect(row('boom').warn).toContain('boom!')
  })

  test('a switch writes the human’s own list, never the repo’s', () => {
    expect(setPluginOn('voice', false)).toEqual({ ok: true })
    expect(setPluginOn('chat', false)).toEqual({ ok: true })
    expect(setPluginOn('voice', true)).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(join(HOME, 'plugins.json'), 'utf8'))).toEqual({ off: ['chat'] })
    expect(setPluginOn('nothing-here', false).ok).toBe(false)
  })
})

describe('on the screen', () => {
  test('a setup that throws leaves the slots as they were', () => {
    const View = () => null
    const reg = { overlays: [View], views: { chat: View } as Record<string, unknown>, composerIdle: null as unknown }
    setupGuarded('boom', reg, (r) => {
      r.overlays.push(() => null)
      r.views.tasks = () => null
      r.composerIdle = () => null
      throw new Error('nope')
    })
    expect(reg.overlays).toEqual([View])
    expect(reg.views).toEqual({ chat: View })
    expect(reg.composerIdle).toBeNull()
  })

  test('installPlugins wires every plugin through the guard, not only yours', () => {
    const kernel = readFileSync(join(import.meta.dir, '..', 'src', 'kernel.ts'), 'utf8')
    const body = kernel.match(/export function installPlugins[\s\S]*?\n}\n/)?.[0] ?? ''
    expect(body).toContain('setupGuarded(p.name, registry, (r) => p.setup(r))')
    expect(body).not.toContain('user.includes')
    expect(body).not.toContain('else p.setup(registry)')
  })

  test('a built-in name is guarded the same way: its setup throw leaves the slots as they were', () => {
    const View = () => null
    const reg = { messageEdge: [] as { View: typeof View }[], topBars: [View] }
    setupGuarded('reactions', reg, (r) => {
      r.messageEdge.push({ View: () => null })
      r.topBars.push(() => null)
      throw new Error('bad snapshot shape')
    })
    expect(reg.messageEdge).toEqual([])
    expect(reg.topBars).toEqual([View])
  })

  test('a view added by a built-in is wrapped: it says the name when it throws', () => {
    const reg = { messageEdge: [] as { View: () => never }[] }
    setupGuarded('reactions', reg, (r) => {
      r.messageEdge.push({ View: () => { throw new Error('bad reaction') } })
    })
    expect((reg.messageEdge[0].View as unknown as { displayName?: string }).displayName).toMatch(/^reactions\(/)
  })

  test('what it adds is wrapped: its functions give a safe answer once they throw', async () => {
    const reg = { keys: [] as { order: number; handle: () => boolean }[], settingActions: {} as Record<string, () => Promise<string>> }
    setupGuarded('keys', reg, (r) => {
      r.keys.push({ order: 1, handle: () => { throw new Error('nope') } })
      r.settingActions.go = async () => { throw new Error('nope') }
    })
    expect(reg.keys[0].order).toBe(1)
    expect(reg.keys[0].handle()).toBe(false)
    expect(await reg.settingActions.go()).toBe('That failed.')
    expect(guardFn('x', () => 2, 0)()).toBe(2)
  })
})

describe('the screen fallback', () => {
  const at = 1_700_000_000_000
  test('a first break starts at one; a different break starts over', () => {
    const first = nextCrash(null, 'boom', at)
    expect(first).toEqual({ message: 'boom', count: 1, reloaded: false, at })
    expect(nextCrash(first, 'another', at + 1)).toEqual({ message: 'another', count: 1, reloaded: false, at: at + 1 })
  })
  test('the same break after a Reload counts up, and stops counting once the card says to restart', () => {
    let crash = nextCrash(null, 'boom', at)
    for (let n = 2; n <= CRASH_RELOADS + 1; n++) {
      crash = nextCrash({ ...crash, reloaded: true }, 'boom', at + n)
      expect(crash.count).toBe(n)
    }
    expect(crash.count).toBeGreaterThanOrEqual(CRASH_RELOADS)
    // a repeat without a Reload keeps the count: React can call the error lifecycle twice for one break
    expect(nextCrash(crash, 'boom', at + 99).count).toBe(crash.count)
    // a break much later in the same tab starts over, even with a reload still remembered
    expect(nextCrash({ ...crash, reloaded: true }, 'boom', at + 120_000).count).toBe(1)
  })
})
