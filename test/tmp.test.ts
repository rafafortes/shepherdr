// Every temporary folder a test makes in /tmp goes through this folder's tmp(), which names it after the run and the
// process that made it and removes it when that process ends; the sweep, and each run's look after itself
// (scripts/test.ts), keep what a killed run leaves from staying there the month systemd-tmpfiles gives it (SHE-32).
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { leftBy, ownerOf, run, STALE, sweep, tmp } from './tmp.ts'

const at = (name: string) => join(tmpdir(), name)
/** a folder written that long ago */
const ago = (path: string, ms: number) => utimesSync(path, new Date(Date.now() - ms), new Date(Date.now() - ms))
/** a process that is gone: its pid is free for nothing to be using */
const deadPid = () => Number(Bun.spawnSync(['sh', '-c', 'echo $$'], { stdout: 'pipe' }).stdout.toString().trim())

describe('a temporary folder of a test', () => {
  test('says which run and which process made it, and /tmp keeps it for no longer than that', () => {
    const dir = tmp('sample')
    expect(dir).toStartWith(at('shep-sample-'))
    expect(dir).toContain(`-${run}-${process.pid}-`)
    expect(ownerOf(dir.slice(tmpdir().length + 1))).toEqual({ run, pid: process.pid })
  })

  test('is read back to its run and process, and anything else to nothing', () => {
    expect(ownerOf('shep-herdr-1234-56789-AbCdEf')).toEqual({ run: '1234', pid: 56789 })
    expect(ownerOf('shep-test-home-base-7-8-ZyXwVu')).toEqual({ run: '7', pid: 8 })
    // what the tests made before they went through tmp(), and what another program leaves in /tmp
    expect(ownerOf('shep-herdr-AbCdEf')).toBe(null)
    expect(ownerOf('shep-12-AbCdEf')).toBe(null)
    expect(ownerOf('playwright_chromiumdev_profile-abc')).toBe(null)
  })

  test('a folder of a run gone by, two hours old, goes with the sweep; a young one and a live process’s stay', () => {
    const dead = deadPid()
    const stale = at(`shep-sweep-${run}-${dead}-AbCdEf`)
    const young = at(`shep-sweep-${run}-${dead}-GhIjKl`)
    const live = at(`shep-sweep-${run}-${process.pid}-MnOqRs`)
    mkdirSync(stale)
    mkdirSync(young)
    mkdirSync(live)
    ago(stale, STALE + 60_000)
    ago(live, STALE + 60_000)
    try {
      sweep()
      expect(existsSync(stale)).toBe(false)
      expect(existsSync(young)).toBe(true)
      expect(existsSync(live)).toBe(true)
    } finally {
      for (const p of [stale, young, live]) rmSync(p, { recursive: true, force: true })
    }
  })

  test('the sweep takes only folders the tests made: another program’s folder, or a file, is left alone', () => {
    const dead = deadPid()
    const other = at(`not-ours-${run}-${dead}-AbCdEf`)
    const file = at(`shep-file-${run}-${dead}-GhIjKl`)
    mkdirSync(other)
    writeFileSync(file, 'not a folder of a test\n')
    ago(other, STALE + 60_000)
    ago(file, STALE + 60_000)
    try {
      sweep()
      expect(existsSync(other)).toBe(true)
      expect(existsSync(file)).toBe(true)
    } finally {
      rmSync(other, { recursive: true, force: true })
      rmSync(file, { force: true })
    }
  })

  test('what one run left is its own folders whose process is gone, never another run’s or a live one’s', () => {
    const dead = deadPid()
    const ours = `shep-left-${run}-${dead}-AbCdEf`
    const alive = `shep-left-${run}-${process.pid}-GhIjKl`
    const other = `shep-left-other-run-${dead}-MnOqRs`
    for (const p of [ours, alive, other]) mkdirSync(at(p))
    try {
      expect(leftBy(run)).toContain(ours)
      expect(leftBy(run)).not.toContain(alive)
      expect(leftBy(run)).not.toContain(other)
    } finally {
      for (const p of [ours, alive, other]) rmSync(at(p), { recursive: true, force: true })
    }
  })
})

test('every test folder goes through test/tmp.ts, which is what removes it and what a run checks after itself', () => {
  // a folder made straight in /tmp is one /tmp keeps for a month: the run's check only knows the ones it can name
  const plain = readdirSync(import.meta.dir, { recursive: true })
    .map(String)
    .filter((f) => /\.[jt]sx?$/.test(f) && !['tmp.ts', 'tmp.test.ts'].includes(f))
    .filter((f) => {
      const text = readFileSync(join(import.meta.dir, f), 'utf8')
      return /\bmkdtemp\w*\s*\(/.test(text) || /mkdir\w*\(\s*join\(\s*tmpdir\(\)/.test(text)
    })
  expect(plain).toEqual([])
})
