// Superseded herdr plugin installs (RES-09): the sibling folders under github-installations/<plugin>/ never went away.
// The check, the retention and the keep-newest rules are pure (InstallIO is injected), so a fake layout and one fake
// process table stand in for home and ps; the real reads are tested against folders of this test's own. Report-only
// until the operator answers: doctor lists what a prune would remove, and the supervisor removes only when the
// installs.prune setting is on.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  installFamily,
  installLines,
  installPruneAllowed,
  INSTALL_AGE_MS,
  INSTALL_KEEP,
  INSTALL_PRUNE_KEY,
  runningInstall,
  runsFrom,
  staleInstalls,
  Supervisor,
  systemInstallIO,
  type InstallIO,
  type InstallProc,
} from '../scripts/supervisor.ts'
import { tmp } from './tmp.ts'

const NOW = 1_000_000_000_000
const DAY = 86_400_000
const fakeIO = (dirs: { name: string; mtime: number }[], procs: InstallProc[] = [], removed: string[] = []): InstallIO => ({
  now: () => NOW,
  dirs: () => dirs,
  processes: () => procs,
  remove: (p) => void removed.push(p),
})
/** an install's mtime is how long ago it was installed */
const dir = (name: string, daysAgo: number) => ({ name, mtime: NOW - daysAgo * DAY })

describe('superseded installs', () => {
  const family = '/home/u/.config/herdr/plugins/github-installations/herdr-projects-abc'
  const running = join(family, '100-0', 'checkout')
  const table = [dir('100-0', 5), dir('90-0', 6), dir('80-0', 20), dir('70-0', 30), dir('60-0', 10)]

  test('the family and running install come from this checkout path', () => {
    expect(installFamily(running)).toBe(family)
    expect(runningInstall(running)).toBe(join(family, '100-0'))
    expect(INSTALL_AGE_MS).toBe(14 * DAY)
  })

  test('the two newest (running and previous) are kept, the rest past the retention are reported newest first', () => {
    const found = staleInstalls(running, fakeIO(table))
    // 60-0 is only 10 days old: inside the 14-day retention. 80-0 and 70-0 are older and not among the two newest.
    expect(found.map((x) => x.name)).toEqual(['80-0', '70-0'])
    expect(found.map((x) => x.days)).toEqual([20, 30])
    expect(found.map((x) => x.path)).toEqual([join(family, '80-0'), join(family, '70-0')])
  })

  test('the running install is never a candidate, even when it is the only one and old', () => {
    const found = staleInstalls(join(family, '1-0', 'checkout'), fakeIO([dir('1-0', 100)], [], []), 0, DAY)
    expect(found).toEqual([])
  })

  test("retention N is the caller's: a longer window holds more, a shorter one lets more go", () => {
    const names = (age: number) => staleInstalls(running, fakeIO(table), INSTALL_KEEP, age).map((x) => x.name)
    expect(names(9 * DAY)).toEqual(['60-0', '80-0', '70-0'])
    expect(names(25 * DAY)).toEqual(['70-0'])
    expect(names(40 * DAY)).toEqual([])
  })

  test('a folder a live process runs from is skipped, supervisor and server paths included', () => {
    const procs: InstallProc[] = [
      { pid: 1, cmd: `bun ${join(family, '80-0', 'checkout', 'scripts', 'supervise.ts')}` },
      { pid: 2, cmd: 'bun', cwd: join(family, '70-0', 'checkout', '.releases', 'abc') },
      { pid: 3, cmd: 'ps -axo pid=,command=' },
    ]
    expect(staleInstalls(running, fakeIO(table, procs)).map((x) => x.name)).toEqual([])
    // a partial numeric prefix is not the same install
    expect(runsFrom({ pid: 4, cmd: `bun ${family}/800-0/checkout/scripts/supervise.ts` }, join(family, '80-0'))).toBe(false)
  })

  test('doctor reports what would go, capped and worded for report-only until the setting is on', () => {
    const found = staleInstalls(running, fakeIO(table))
    expect(installLines([], false, 14)).toEqual([])
    const lines = installLines(found, false, 14)
    expect(lines[0]).toContain('Stale plugin installs (RES-09): 2 older than 14 days, kept 2 newest.')
    expect(lines[0]).toContain('Report only: removal is off until the operator answers')
    expect(lines[1]).toContain(join(family, '80-0'))
    expect(lines[2]).toContain('30 days old')
    expect(installLines(found, true, 14)[0]).toContain('Removal is on.')
    const many = staleInstalls(running, fakeIO(Array.from({ length: 12 }, (_, i) => dir(`${200 - i}-0`, 30))))
    const capped = installLines(many, false, 14)
    expect(capped).toHaveLength(10)
    expect(capped.at(-1)).toContain('and 2 more')
  })
})

describe('the installs.prune setting', () => {
  const home = tmp('installs-setting')
  const file = join(home, 'settings.json')
  const set = (v: unknown, level: 'everywhere' | 'machine' = 'everywhere') => writeFileSync(file, JSON.stringify({ [level]: { [INSTALL_PRUNE_KEY]: v } }))

  test('off (the default) until set on, this machine over Everywhere', () => {
    expect(installPruneAllowed(home)).toBe(false)
    set('off')
    expect(installPruneAllowed(home)).toBe(false)
    set('on')
    expect(installPruneAllowed(home)).toBe(true)
    set(true)
    expect(installPruneAllowed(home)).toBe(true)
    set('on', 'machine')
    expect(installPruneAllowed(home)).toBe(true)
    set('off', 'machine')
    expect(installPruneAllowed(home)).toBe(false)
  })
})

describe('the real reads', () => {
  test('dirs accepts only install folders, keeps their times, and tolerates a missing family', () => {
    const family = tmp('installs-real')
    const make = (name: string, daysAgo: number) => {
      const p = join(family, name)
      mkdirSync(p, { recursive: true })
      const t = new Date(NOW - daysAgo * DAY)
      utimesSync(p, t, t)
      return p
    }
    const a = make('123-0', 20)
    make('not-an-install', 20)
    writeFileSync(join(family, 'file'), 'x')
    expect(systemInstallIO.dirs(family)).toEqual([{ name: '123-0', mtime: NOW - 20 * DAY }])
    expect(() => existsSync(a)).not.toThrow()
    expect(systemInstallIO.dirs(join(family, 'no-such-folder'))).toEqual([])
  })

  test("one ps read names processes, and remove takes a folder of this test's own", () => {
    const procs = systemInstallIO.processes()
    expect(procs.length).toBeGreaterThan(0)
    expect(procs.some((p) => p.pid === process.pid)).toBe(true)
    const dir = tmp('installs-remove')
    expect(existsSync(dir)).toBe(true)
    systemInstallIO.remove(dir)
    expect(existsSync(dir)).toBe(false)
    expect(typeof systemInstallIO.now()).toBe('number')
  })
})

describe('the supervisor after a restart', () => {
  /** a git checkout at the running install, with the fake sibling layout the prune reads */
  function fixture(pruneSetting?: string) {
    const rootTmp = tmp('installs-sup')
    const family = join(rootTmp, 'herdr-projects-abc')
    const running = join(family, '100-0', 'checkout')
    mkdirSync(running, { recursive: true })
    const git = (...a: string[]) => Bun.spawnSync(['git', '-C', running, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stderr: 'pipe' })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(running, 'VERSION'), 'v1')
    mkdirSync(join(running, 'server'), { recursive: true })
    writeFileSync(join(running, 'server', 'main.ts'), "console.log('v1')\n")
    writeFileSync(join(running, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { build: 'mkdir -p dist && cp VERSION dist/index.html' } }))
    git('add', '-A')
    git('commit', '-qm', 'v1')
    const home = tmp('installs-sup-home')
    if (pruneSetting) writeFileSync(join(home, 'settings.json'), JSON.stringify({ everywhere: { [INSTALL_PRUNE_KEY]: pruneSetting } }))
    const removed: string[] = []
    const lines: string[] = []
    const io = fakeIO([dir('100-0', 1), dir('90-0', 2), dir('80-0', 30), dir('70-0', 40)], [], removed)
    const sup = new Supervisor({
      root: running,
      home,
      status: null,
      save: () => undefined,
      drain: async () => 0,
      restart: () => undefined,
      sleep: async () => undefined,
      log: (m) => void lines.push(m),
      installs: io,
    })
    return { sup, removed, lines }
  }

  test('report-only by default: an update removes nothing', async () => {
    const s = fixture()
    await s.sup.check()
    expect(s.removed).toEqual([])
    expect(s.lines.join('\n')).not.toContain('pruned')
  })

  test('with the setting on, an update removes the stale siblings but never the running or previous one', async () => {
    const s = fixture('on')
    await s.sup.check()
    expect(s.removed).toHaveLength(2)
    expect(s.lines.join('\n')).toContain('pruned 2 stale plugin installs')
    expect(s.removed.join('\n')).not.toContain('100-0')
    expect(s.removed.join('\n')).not.toContain('90-0')
  })

  test('with the setting on but nothing stale, it says nothing', async () => {
    const s = fixture('on')
    // the fake layout above holds two stale folders; swap it for one with only the two newest
    const io = (s.sup as unknown as { d: { installs: InstallIO } }).d.installs
    io.dirs = () => [dir('100-0', 1), dir('90-0', 2)]
    await s.sup.check()
    expect(s.removed).toEqual([])
    expect(s.lines.join('\n')).not.toContain('pruned')
  })
})
