// Doctor's resource lines (RES-11): what Shepherdr itself keeps that grows without bound — idle and done agents,
// done tasks' kept work, Chrome processes of Shepherdr's own profiles, and the sizes of the folders it fills. The
// removed-worktree and /tmp proof-home processes (RES-03) and stale plugin installs (RES-09) already have their own
// lines in doctor. Nothing here starts, kills or removes anything: every line names the verb or setting that does.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** a Chrome process in a task's profile, with how long it has run (ms) */
export interface ChromeRow {
  pid: number
  task: string
  age: number
}

/** the box folders doctor measures, in the order it prints them */
export const FOLDERS = ['inbox', 'artifacts', 'browser'] as const

/** the counts and sizes doctor prints, gathered from each source by the LiveSource */
export interface Resources {
  /** agent records whose status is idle, by CLI kind */
  idle: Record<string, number>
  /** agent records whose status is done, by CLI kind */
  done: Record<string, number>
  /** done tasks that kept a worktree or branch, from engine.keptLeftovers() */
  kept: string[]
  /** Chrome processes of Shepherdr's own profiles whose task is gone, stopped or done */
  chromes: ChromeRow[]
  /** measured sizes in bytes; undefined when the folder is not there */
  folders: { name: string; bytes: number | undefined }[]
}

/** the file reads behind a folder's size; a test injects a stand-in tree, never this machine's disk */
export interface SizeIO {
  exists(p: string): boolean
  entries(p: string): { name: string; dir: boolean; link: boolean }[]
  size(p: string): number
}

export const systemSizeIO: SizeIO = {
  exists: (p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  },
  entries: (p) => readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory(), link: e.isSymbolicLink() })),
  size: (p) => statSync(p).size,
}

/** idle and done counts by CLI kind, from agent records and the status of each chat */
export function agentCounts(records: Record<string, { key: string; kind: string }>, status: (key: string) => string): { idle: Record<string, number>; done: Record<string, number> } {
  const idle: Record<string, number> = {}
  const done: Record<string, number> = {}
  for (const r of Object.values(records)) {
    const st = status(r.key)
    if (st === 'idle') idle[r.kind] = (idle[r.kind] ?? 0) + 1
    if (st === 'done') done[r.kind] = (done[r.kind] ?? 0) + 1
  }
  return { idle, done }
}

/** Chrome processes of Shepherdr's own profiles whose task is not live any more */
export function orphanChromes(chromes: ChromeRow[], live: ReadonlySet<string>): ChromeRow[] {
  return chromes.filter((c) => !live.has(c.task))
}

/** the bytes under a folder, following no links; undefined when it is not there */
export function folderSize(dir: string, io: SizeIO = systemSizeIO): number | undefined {
  if (!io.exists(dir)) return undefined
  let total = 0
  for (const e of io.entries(dir)) {
    if (e.link) continue
    const p = join(dir, e.name)
    total += e.dir ? (folderSize(p, io) ?? 0) : io.size(p)
  }
  return total
}

/** a size in one decimal and the biggest unit that fits */
export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

const pairs = (m: Record<string, number>) =>
  Object.entries(m)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${n} ${k}`)
    .join(', ')

/** the verb or setting that deals with each folder, named beside its size */
const VERBS: Record<string, string> = {
  inbox: 'Settings → Tasks → Remove chat files after (tasks.inboxKeep)',
  artifacts: 'shepherdr artifact rm <id>',
  browser: 'Settings → Browser → Close idle browser after (browser.idleClose)',
  'check logs': 'pruned after a successful check (SHEPHERDR_CHECK_KEEP)',
}

/** doctor's lines, one per thing that grew; an empty machine produces none. Read only. */
export function lines(f: Resources): string[] {
  const out: string[] = []
  const idle = pairs(f.idle)
  if (idle) out.push(`Idle agents: ${idle}. To free the memory, set Settings → Idle agents → Park idle agents after (agents.idleClose); a message to a parked chat starts it again.`)
  const done = pairs(f.done)
  if (done) out.push(`Done agents still running: ${done}. Settings → Idle agents → Park idle agents after (agents.idleClose) closes their panes; a message to a chat starts its agent again.`)
  if (f.kept.length) {
    out.push(
      `Done tasks keeping work (${f.kept.length}): ${f.kept.slice(0, 8).join('; ')}${f.kept.length > 8 ? ` and ${f.kept.length - 8} more` : ''}. Remove it with Settings → Tasks → Remove kept work after (tasks.keptExpiry), or by hand once you are sure.`,
    )
  }
  if (f.chromes.length) {
    const byTask = new Map<string, number>()
    for (const c of f.chromes) byTask.set(c.task, (byTask.get(c.task) ?? 0) + 1)
    const shown = [...byTask]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 8)
      .map(([t, n]) => `${t} (${n})`)
      .join(', ')
    out.push(
      `Shared-browser processes of done or gone tasks (${f.chromes.length}): ${shown}${byTask.size > 8 ? ` and ${byTask.size - 8} more tasks` : ''}. Settings → Browser → Close idle browser after (browser.idleClose) closes idle ones; the hourly sweep closes a done task's browser.`,
    )
  }
  for (const folder of f.folders) {
    if (folder.bytes === undefined || folder.bytes <= 0) continue
    out.push(`Shepherdr ${folder.name}: ${bytes(folder.bytes)}. To trim: ${VERBS[folder.name] ?? 'remove what you no longer need'}.`)
  }
  return out
}
