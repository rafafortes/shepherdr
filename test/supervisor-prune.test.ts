// Superseded herdr plugin installs (RES-09): the sibling folders under github-installations/<plugin>/ never went away.
// The report is pure (InstallIO is injected), so a fake layout and one fake process table stand in for home and ps;
// the real reads are tested against folders of this test's own. Nothing is deleted: the operator has not answered
// whether Shepherdr may remove another install's folder.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INSTALL_AGE_MS, INSTALL_KEEP, type InstallIO, type InstallProc, installFamily, installLines, runningInstall, runsFrom, staleInstalls, systemInstallIO } from '../scripts/supervisor.ts'
import { tmp } from './tmp.ts'

const NOW = 1_000_000_000_000
const DAY = 86_400_000
const fakeIO = (dirs: { name: string; mtime: number }[], procs: InstallProc[] = []): InstallIO => ({
  now: () => NOW,
  dirs: () => dirs,
  processes: () => procs,
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

  test('the running install is never reported, even when it is the only one and old', () => {
    const found = staleInstalls(join(family, '1-0', 'checkout'), fakeIO([dir('1-0', 100)]), 0, DAY)
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
      { pid: 2, cmd: 'bun', cwd: join(family, '60-0', 'checkout', '.releases', 'abc') },
      { pid: 3, cmd: 'ps -axo pid=,command=' },
    ]
    // 80-0's script is named and 60-0's cwd is inside it; 70-0 is still reported
    expect(staleInstalls(running, fakeIO(table, procs)).map((x) => x.name)).toEqual(['70-0'])
    // a partial numeric prefix is not the same install
    expect(runsFrom({ pid: 4, cmd: `bun ${family}/800-0/checkout/scripts/supervise.ts` }, join(family, '80-0'))).toBe(false)
  })

  test('a lookalike folder outside github-installations is left alone', () => {
    const wt = '/home/u/.herdr/worktrees/herdr-projects-abc'
    expect(staleInstalls(join(wt, '100-0', 'checkout'), fakeIO([dir('100-0', 100), dir('1-0', 100)]))).toEqual([])
  })

  test('doctor reports what would go, capped and worded as report-only', () => {
    const found = staleInstalls(running, fakeIO(table))
    expect(installLines([], 14)).toEqual([])
    const lines = installLines(found, 14)
    expect(lines[0]).toContain('Stale plugin installs (RES-09): 2 older than 14 days, kept 2 newest.')
    expect(lines[0]).toContain("Report only: removal awaits the operator's decision; nothing is deleted.")
    expect(lines[1]).toContain(join(family, '80-0'))
    expect(lines[2]).toContain('30 days old')
    const many = staleInstalls(running, fakeIO(Array.from({ length: 12 }, (_, i) => dir(`${200 - i}-0`, 30))))
    const capped = installLines(many, 14)
    expect(capped).toHaveLength(10)
    expect(capped.at(-1)).toContain('and 2 more')
  })
})

describe('the real reads', () => {
  test('dirs accepts only install folders, keeps their times, and tolerates a missing family', () => {
    const base = tmp('installs-real')
    const family = join(base, 'github-installations', 'herdr-projects-abc')
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
    // three old siblings: the two newest are held (running + previous), the oldest is reported
    make('456-0', 40)
    make('789-0', 60)
    expect(staleInstalls(join(family, '999-0', 'checkout'), systemInstallIO).map((x) => x.name)).toContain('789-0')
    expect(existsSync(a)).toBe(true)
    expect(systemInstallIO.dirs(join(family, 'no-such-folder'))).toEqual([])
  })

  test('one ps read names processes', () => {
    const procs = systemInstallIO.processes()
    expect(procs.length).toBeGreaterThan(0)
    expect(procs.some((p) => p.pid === process.pid)).toBe(true)
    expect(typeof systemInstallIO.now()).toBe('number')
  })
})
