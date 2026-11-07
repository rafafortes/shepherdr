// The temporary folders the tests make in /tmp: `tmp(name)` instead of a plain mkdtempSync.
//
// Each one is named after the run and the process that made it (`shep-<name>-<run>-<pid>-<random>`), so a run can see
// after itself, and it is removed when that process ends, a test of it failing or not. A folder its process never got
// to remove (a run killed out of time, or by a stop) goes two hours later, when any test process starts: /tmp sits on
// the root disk, not on a tmpfs, and systemd-tmpfiles keeps what it finds there for 30 days (one day of runs left
// 43,339 of them behind, SHE-32).
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** first in every name here: what the sweep looks for, and what only the tests make */
const PREFIX = 'shep-'

/** the run these folders belong to. scripts/test.ts names one for every test process it starts, so a run can tell its
 *  own leftovers from another worktree's suite running at the same time; a test file run by hand is a run of its own */
export const run = process.env.SHEPHERDR_TEST_RUN || String(process.pid)

const made = new Set<string>()

/** a folder of this process's own in /tmp, removed when the process ends; `name` says which one it is */
export function tmp(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `${PREFIX}${name}-${run}-${process.pid}-`))
  made.add(dir)
  return dir
}

/** removes every folder this process made, and is what preload.ts's afterAll runs for each test file */
export function cleanup() {
  // one that will not go (a child of the test still writing into it) must not strand the others
  for (const dir of made)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* the run's own check names it */
    }
  made.clear()
}

process.on('exit', cleanup)

const entries = () => {
  try {
    return readdirSync(tmpdir())
  } catch {
    return []
  }
}

/** the run and the process a name in /tmp was made for, or null for anything the tests didn't make */
export function ownerOf(name: string): { run: string; pid: number } | null {
  if (!name.startsWith(PREFIX)) return null
  const parts = name.split('-')
  if (parts.length < 5) return null
  const [runID, pid] = parts.slice(-3, -1)
  return /^\d+$/.test(runID) && /^\d+$/.test(pid) ? { run: runID, pid: Number(pid) } : null
}

/** whether that process is still there: one that is may still be using its folder */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** how old a folder has to be to go: a suite in flight is younger (every test writes into its own), and one older is a
 *  run that was killed before it could remove what it made (scripts/test.ts sweeps at the start of every run) */
export const STALE = 2 * 3600_000

/** what a killed run left: every folder of ours older than that, whose process is gone, goes now. Only a folder named as
 *  the tests name them is ours to remove, and a folder of an older run (43,339 of them by 2026-11-07, before the name
 *  carried its run) goes with them; another program's folder in /tmp, and a file, are left alone */
export function sweep(age = STALE) {
  const me = process.getuid?.() ?? null
  const now = Date.now()
  for (const name of entries()) {
    if (!name.startsWith(PREFIX)) continue
    const path = join(tmpdir(), name)
    try {
      const stat = lstatSync(path)
      if (!stat.isDirectory()) continue
      if (me !== null && stat.uid !== me) continue
      if (now - stat.mtimeMs < age) continue
      const owner = ownerOf(name)
      if (owner && alive(owner.pid)) continue
      rmSync(path, { recursive: true, force: true })
    } catch {
      /* gone already, or not ours to read */
    }
  }
}

/** what one run left behind: its folders whose process is gone (one whose process still runs belongs to another suite,
 *  or to a test's own child) */
export function leftBy(runID: string): string[] {
  return entries().filter((name) => {
    const owner = ownerOf(name)
    return owner?.run === runID && !alive(owner.pid)
  })
}
