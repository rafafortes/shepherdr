// Nightly snapshots of the stores a person's work lives in (SHE-142, audit 2026-11-18 OPS-04), and putting one back.
//
//   bun scripts/snapshot.ts                     tonight's snapshot into the home's `backups/<YYYY-MM-DD>/`
//   bun scripts/snapshot.ts list                the snapshots kept, newest first, with each one's size
//   bun scripts/snapshot.ts restore <YYYY-MM-DD>  copy one back over the live stores (Shepherdr stopped)
//
// Tasks, spaces, settings, automations, the agents' records and the usage read from their logs are whole-file JSON
// stores: atomic writes keep a torn file out of a crash, and REL-01 copies one aside when it cannot be read, but nothing
// keeps a bad write that reads back fine (a `shepherdr set` typo, a delete confirmed in a hurry, a release that writes
// wrong state for days) from replacing hours of work. This is that net: a copy per day, kept for a fortnight and four
// weeks, and a way to put one back.
//
// What it copies: the JSON files in the home's own folder — the stores of record (tasks, spaces, settings, automations)
// and the caches that are hours of work too (the agents' records, usage, the returns…) — and the task-id store with its
// write-ahead log and its index, copied together because a database means nothing without them, and copied last (see
// order() below).
//
// What it never copies: the secrets files (secrets.json, vapid.json, push.json, the vault the keys are kept in), the two
// that are the text of messages rather than a record of anything (the outbox and the typed drafts), a runtime file, or a
// copy an earlier run or the operator left beside a store — and nothing outside the home's own folder at all: no inbox
// attachment, no chat log, no artifact, no other machine's payload. A snapshot must never duplicate a secret or a chat,
// and none of those is a store that nothing re-derives.
//
// No schedule is installed by this script (the operator picks it, docs/backups.md): it does one snapshot and says what
// it cost, so a timer, a cron line or a Shepherdr automation can run it.
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { home } from '../server/store.ts'

/** the folder the snapshots live in, inside the home they are of */
export const FOLDER = 'backups'
/** the newest days kept as they are */
export const DAILY = 14
/** and one snapshot for each of this many weeks before them */
export const WEEKLY = 4

/** the files a snapshot never holds: the three secrets files (server/store.ts's PRIVATE) and the vault they are kept in
 *  (server/live/secrets.ts) */
export const NEVER = new Set(['secrets.json', 'vault.json', 'vapid.json', 'push.json'])

/** a store whose name says it is a secret stays out even when it is new, so a later release's auth, cookie or session
 *  file does not need this list changed to be left out of a backup: what a name says it holds, it is not copied */
const SECRET_WORDS = /(^|[-_.])(secrets?|vault|credentials?|passwords?|passwd|tokens?|keys?|apikeys?|auth|logins?|cookies?|sessions?|oauth\d?|otp|totp|push|vapid)([-_.]|$)/i

/** and the two that are the text of messages, not a record of anything: what waits in the outbox to go in to an agent,
 *  and what was typed and not sent yet. A snapshot never duplicates a chat, and neither of them means anything after a
 *  restore — the agent it was meant for went with the day */
const TEXT = new Set(['outbox.json', 'typed.json'])

/** what is not a store to take: the server's own address of the moment (its folder is stopped for a restore anyway),
 *  and a copy kept beside a store (store.ts's `.corrupt-…` and `.before-empty-…`, an operator's `.bak-…`), which is a
 *  copy already */
const RUNTIME = new Set(['server.json'])
const COPY = /\.(bak|corrupt|before-empty)-/

/** the task-id store: the database and the two files SQLite keeps beside it, which are copied together or not at all */
const IDS = /^task-ids\.sqlite(?:-(?:wal|shm))?$/

/** the day a snapshot is of, in this machine's own time: its folder's name */
export function dayOf(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
}

export const DAY = /^\d{4}-\d{2}-\d{2}$/

/** the ISO week a day belongs to, as `2026-W47`: the weekly retention keeps one snapshot of each, so two days of the
 *  same week never cost two folders. The ISO year comes from that week's Thursday, which is what decides a year's
 *  first week. */
export function weekOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3)
  const year = t.getUTCFullYear()
  const week = Math.floor((t.getTime() - Date.UTC(year, 0, 1)) / 604800000) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** whether a file stays out of a snapshot, whatever its size or age: a secret, a runtime file or a copy of a store */
function keptOut(name: string): boolean {
  return NEVER.has(name) || TEXT.has(name) || SECRET_WORDS.test(name) || RUNTIME.has(name) || COPY.test(name)
}

/** the files a snapshot takes from `dir`, in a stable order: the home's own JSON stores and the ID store with the two
 *  files SQLite keeps beside it. Folders are never entered: a chat log, an attachment or an artifact is neither a store
 *  nor a secret this script has any business copying. */
export function stores(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => (n.endsWith('.json') || IDS.test(n)) && !keptOut(n))
    .sort()
}

/** the snapshot folders in `root`, newest first: the day folders, never a run's half-made one */
export function dated(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && DAY.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse()
  } catch {
    return [] // a home with no backups folder yet
  }
}

/** whether a process is still there: `kill(pid, 0)` asks the kernel without sending anything */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // coverage-exempt: only a process of another user answers EPERM; this home is the one that runs Shepherdr
    return (e as { code?: string }).code === 'EPERM'
  }
}

/** whether two files hold the same bytes: the size first, so a store that changed tonight is never read whole */
export function same(a: string, b: string): boolean {
  try {
    if (statSync(a).size !== statSync(b).size) return false
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

/** the same bytes made a hard link instead of a second copy. False when the filesystem will not link (a store then costs
 *  its bytes again, which is only space): a backup that fails to save room must not fail to save the store. */
export function linked(from: string, to: string): boolean {
  try {
    linkSync(from, to)
    return true
  } catch {
    return false
  }
}

/** a run killed halfway leaves its half folder (`.new-<pid>`) or the one it moved aside (`.old-<pid>`) beside the days:
 *  one whose process is gone is cleared before a new run, so a night that keeps dying does not fill the disk */
function clear(root: string) {
  for (const name of readdirSync(root)) {
    const m = /^\.(?:new|old)-(\d+)$/.exec(name)
    if (m && Number(m[1]) !== process.pid && !pidAlive(Number(m[1]))) rmSync(join(root, name), { recursive: true, force: true })
  }
}

export type Snapshot = { day: string; dir: string; files: string[]; bytes: number; shared: number; skipped: string[]; removed: string[]; saved: boolean }

/** the order the files are copied in: the JSON stores first, the ID store's three files last. A task's number is
 *  reserved before its task is written, so a copy of the ID store older than tasks.json beside it could hand that number
 *  out again after a restore: copied last, the ID store is never older than the stores it belongs to, and at worst a
 *  number is skipped. */
function copyOrder(names: string[]): string[] {
  return [...names.filter((n) => !IDS.test(n)), ...names.filter((n) => IDS.test(n))]
}

/** tonight's snapshot of the stores in `dir`: the day's folder lands whole, so a run killed halfway leaves last night's
 *  snapshot and never a half one, and a file whose bytes are the newest snapshot's is a hard link to it rather than a
 *  second copy — a day of small writes costs a few megabytes, not twenty. The retention runs at the end. */
export function snapshot(dir: string, at = new Date()): Snapshot {
  const root = join(dir, FOLDER)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  clear(root)
  const day = dayOf(at)
  const target = join(root, day)
  const made = join(root, `.new-${process.pid}`)
  rmSync(made, { recursive: true, force: true })
  mkdirSync(made, { recursive: true, mode: 0o700 })
  // the newest snapshot before tonight's: its unchanged files are shared, not copied again
  const previous = dated(root).find((n) => n !== day)
  const files: string[] = []
  const skipped: string[] = []
  let bytes = 0
  let shared = 0
  for (const name of copyOrder(stores(dir))) {
    const from = join(dir, name)
    const to = join(made, name)
    const before = previous ? join(root, previous, name) : ''
    try {
      if (before && existsSync(before) && same(from, before) && linked(before, to)) shared++
      else copyFileSync(from, to)
      bytes += statSync(to).size
      files.push(name)
    } catch {
      // coverage-exempt: only a filesystem error reaches this (a store vanishing mid-copy, a full disk); the run says
      // which store it missed and ends non-zero rather than losing the others too
      skipped.push(name)
    }
  }
  // a store it could not copy is a night not saved at all: a folder that looks like a backup and is missing a store is
  // worse than none, and replacing a complete one an earlier run today made with it would lose that too
  if (skipped.length) {
    rmSync(made, { recursive: true, force: true })
    return { day, dir: '', files, bytes, shared, skipped, removed: [], saved: false }
  }
  // the folder takes the day's place in one rename; a folder an earlier run today made moves aside (a dot folder, so a
  // run killed between the two renames leaves one the next run's clear() takes) and goes
  const aside = join(root, `.old-${process.pid}`)
  rmSync(aside, { recursive: true, force: true })
  if (existsSync(target)) renameSync(target, aside)
  renameSync(made, target)
  rmSync(aside, { recursive: true, force: true })
  return { day, dir: target, files, bytes, shared, skipped, removed: prune(root), saved: true }
}

/** keep the newest DAILY days and one day for each of the WEEKLY weeks before them, and remove the other folders. The
 *  day a week stands for is its newest snapshot, so a week is kept by its last day. */
export function prune(root: string): string[] {
  const days = dated(root)
  const keep = new Set(days.slice(0, DAILY))
  const weeks = new Set(days.slice(0, DAILY).map(weekOf))
  let weekly = 0
  for (const day of days.slice(DAILY)) {
    const week = weekOf(day)
    if (weeks.has(week) || weekly >= WEEKLY) continue
    weeks.add(week)
    keep.add(day)
    weekly++
  }
  const removed: string[] = []
  for (const day of days)
    if (!keep.has(day)) {
      rmSync(join(root, day), { recursive: true, force: true })
      removed.push(day)
    }
  return removed
}

export type Restored = { day: string; from: string; files: string[] }

/** what the server in this home says of itself, or nothing when it left no file. A file that is there and cannot be
 *  read or parsed is never taken for a home that nothing serves: it could be a server's own, and a restore must not
 *  write over the stores under one it could not rule out, so it is refused with what to do about it. */
function serverOf(dir: string): { pid?: number } | undefined {
  const file = join(dir, 'server.json')
  if (!existsSync(file)) return undefined
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }
    return v && typeof v === 'object' ? v : {}
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    throw new Error(`${file} cannot be read (${why}), so a server could be running in this home: delete the file if none is, then run this again`)
  }
}

/** copy one snapshot back over the live stores. Refused while a server runs in this home: its saves would write over
 *  what was put back and its next read would see half of each. It stops nothing itself — stopping Shepherdr is the
 *  operator's own step, said in the refusal and in the success line. */
export function restore(dir: string, day: string, alive: (pid: number) => boolean = pidAlive): Restored {
  const root = join(dir, FOLDER)
  const from = join(root, day)
  if (!DAY.test(day) || !existsSync(from)) throw new Error(`no snapshot ${day} in ${root}: \`bun scripts/snapshot.ts list\` names the ones kept`)
  const server = serverOf(dir)
  if (server?.pid && alive(server.pid))
    throw new Error(
      `Shepherdr is running in this home (pid ${server.pid}) and would write over what a restore puts back: stop it first \`herdr plugin action invoke herdr-projects.stop\`, then run this again`,
    )
  const files = readdirSync(from, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort()
  // the ID store's log and index belong to the database they were copied with: a live one left beside a restored
  // database would be replayed against the wrong file, so both come from the snapshot or neither stays
  if (files.includes('task-ids.sqlite')) for (const ext of ['-wal', '-shm']) if (!files.includes(`task-ids.sqlite${ext}`)) rmSync(join(dir, `task-ids.sqlite${ext}`), { force: true })
  // each file lands whole in one rename, as a store's own write does: a restore killed halfway leaves some stores of
  // the day and some of the day before, never a torn one
  for (const name of files) {
    const to = join(dir, name)
    const tmp = `${to}.restore-tmp`
    copyFileSync(join(from, name), tmp)
    renameSync(tmp, to)
  }
  return { day, from, files }
}

/** a snapshot's or a folder's size in the words a person reads */
export function size(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** what is in one snapshot folder now: its files' bytes, summed */
function bytesOf(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  for (const e of readdirSync(dir, { withFileTypes: true }))
    if (e.isFile()) {
      bytes += statSync(join(dir, e.name)).size
      files++
    }
  return { bytes, files }
}

const names = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** the command: `snapshot`, `list`, or `restore <YYYY-MM-DD>`, each saying what it did and what it cost. Exit codes: 0
 *  done, 1 something could not be copied (or a restore refused), 2 the words ask for something that is not a command */
export function main(argv: string[] = process.argv.slice(2), dir = home(), at = new Date()): number {
  const [what, arg] = argv
  const root = join(dir, FOLDER)
  if (what === 'list') {
    const days = dated(root)
    if (!days.length) console.log(`snapshot: none in ${root} yet`)
    for (const day of days) {
      const { bytes, files } = bytesOf(join(root, day))
      console.log(`${day}  ${size(bytes)}  ${names(files, 'file', 'files')}`)
    }
    return 0
  }
  if (what === 'restore') {
    if (!arg) {
      console.error('snapshot: restore needs the day: bun scripts/snapshot.ts restore <YYYY-MM-DD>')
      return 2
    }
    try {
      const r = restore(dir, arg)
      console.log(`snapshot: put ${names(r.files.length, 'file', 'files')} of ${r.day} back in ${dir}; start Shepherdr again once you have looked`)
      return 0
    } catch (e) {
      console.error(`snapshot: ${e instanceof Error ? e.message : String(e)}`)
      return 1
    }
  }
  if (what) {
    console.error(`snapshot: no ${what}: try list, or restore <YYYY-MM-DD>`)
    return 2
  }
  if (!existsSync(dir)) {
    console.error(`snapshot: no Shepherdr home in ${dir}: point SHEPHERDR_HOME at the one to copy, or start Shepherdr once`)
    return 1
  }
  const made = snapshot(dir, at)
  if (!made.saved) {
    console.error(`snapshot: nothing was saved for ${made.day}: could not copy ${made.skipped.join(', ')}`)
    return 1
  }
  console.log(
    `snapshot ${made.day}: ${size(made.bytes)} in ${names(made.files.length, 'file', 'files')}` +
      (made.shared ? `, ${made.shared} shared with the last one` : '') +
      `, ${names(dated(root).length, 'snapshot', 'snapshots')} kept in ${root}`,
  )
  if (made.removed.length) console.log(`snapshot: removed ${made.removed.join(', ')}, past the ${DAILY} days and ${WEEKLY} weeks kept`)
  return 0
}

// coverage-exempt: the command's entry point; test/store-snapshot.test.ts drives main(), snapshot() and restore()
if (import.meta.main) process.exit(main())
