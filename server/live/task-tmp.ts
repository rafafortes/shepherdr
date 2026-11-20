// One temporary folder per task, made when its agent first starts and named so short that a unix socket still fits in
// it: <system temp>/shepherdr-task/<TASK-ID>/. It is the TMPDIR and SHEPHERDR_TMP of the task's agent, its reviewer and
// its headless runs, so mktemp, Node, Bun, Python, Playwright and puppeteer profiles land there without anyone having to
// remember. Coordinators keep the machine's default. Never under the worktree (git status, the 'holds uncommitted work'
// test) or ~/.shepherdr (the human's Shepherdr). When a task is put away what still runs from its folder is stopped and
// the folder goes, except when it keeps work; at start, folders of tasks that are gone or archived are swept. The
// process reader and the ending are the RES-03 helpers in orphans.ts (SHE-70), so a later reaper can reuse them.
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { end, endDeps, type Row, readRows, type Source, systemSource } from './orphans.ts'

/** the folder under the system temp that holds one folder per task; nothing outside it is ever touched */
export const ROOT = 'shepherdr-task'

/** where task folders live; a test moves it so it owns every folder it makes */
let baseOf = () => join(tmpdir(), ROOT)
export const taskTmpBase = () => baseOf()
export const setTaskTmpBase = (f: () => string) => {
  baseOf = f
}

export const taskTmpDir = (id: string) => join(taskTmpBase(), id)

/** the task a chat belongs to (SHE-4/Agent, SHE-4/Reviewer), or nothing for a coordinator or a space */
export const taskOfChat = (chat: string) => /^([A-Z][A-Z0-9]{0,15}-\d+)\/(?:Agent|Reviewer)$/.exec(chat)?.[1]

/** make the task's folder, owner-only as Claude Code wants its temporary folder; idempotent on a restart or a bind */
export function ensureTaskTmp(id: string) {
  const dir = taskTmpDir(id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** remove one task's folder and everything under it, whatever it holds */
export function removeTaskTmp(id: string) {
  rmSync(taskTmpDir(id), { recursive: true, force: true })
}

/** is a path the folder itself, or inside it? */
export const inside = (dir: string, path: string | undefined) => !!path && (path === dir || path.startsWith(`${dir}/`))

/** processes running from a task's folder: its cwd, its SHEPHERDR_HOME or its TMPDIR lies inside it. On a platform
 *  without /proc the reader has no cwd or environment, so none are named (the same limit as RES-03's hourly sweep). */
export function pidsInTmp(rows: Row[], id: string): number[] {
  const dir = taskTmpDir(id)
  return rows.filter((r) => inside(dir, r.cwd.replace(/ \(deleted\)$/, '')) || inside(dir, r.home) || inside(dir, r.tmp)).map((r) => r.pid)
}

/** stop what still runs from a task's folder, then remove it; returns the pids that were running there */
export async function clearTaskTmp(id: string, s: Source = systemSource): Promise<number[]> {
  const pids = pidsInTmp(readRows(s), id)
  if (pids.length) await end(pids, endDeps)
  removeTaskTmp(id)
  return pids
}

/** at start, remove folders whose task is gone or archived. Only directories directly under the root, never a file,
 *  a link or anything outside it (RES-03's reaper gets its reliable marker from the same folder). */
export function sweepTaskTmp(keep: Set<string>): number {
  const base = taskTmpBase()
  if (!existsSync(base)) return 0
  let removed = 0
  for (const name of readdirSync(base)) {
    if (keep.has(name)) continue
    const path = join(base, name)
    try {
      if (!lstatSync(path).isDirectory()) continue
      rmSync(path, { recursive: true, force: true })
      removed++
    } catch {
      /* gone already, or not ours to remove */
    }
  }
  return removed
}
