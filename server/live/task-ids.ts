// Each machine owns its ID namespace. SQLite commits reservations before a task starts, so concurrent requests,
// restarts and deleted tasks cannot reuse an ID. Remote settings and creation are routed to that machine.
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { SettingSection } from '../../shared/types.ts'
import { COPIES, copyName, home, pruneCopies, readOnly } from '../store.ts'
import type { Space } from './places.ts'

export const MAX_TASK_NUMBER = Number.MAX_SAFE_INTEGER - 1
export function prefixProblem(value: string) {
  return /^[A-Z][A-Z0-9]{0,15}$/.test(value) ? undefined : 'Use 1–16 capital letters or digits, starting with a letter.'
}

export function taskIdsSection(level: string, machine: string, prefix: string, next: number): SettingSection {
  return {
    name: 'Task IDs', level, machine,
    about: 'For new tasks in this space. Existing IDs stay the same.',
    rows: [
      { label: 'Prefix', key: 'taskIds.prefix', value: prefix, text: true, hint: 'Capital letters and digits, starting with a letter. Unique on this machine.' },
      { label: 'Next number', key: 'taskIds.next', value: String(next), text: true, hint: `Next task: ${prefix}-${next}. Numbers can only move forward.` },
    ],
  }
}

const SCHEMA = 'CREATE TABLE IF NOT EXISTS prefixes (prefix TEXT PRIMARY KEY, space TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sequences (space TEXT PRIMARY KEY, prefix TEXT NOT NULL, last INTEGER NOT NULL);'

/** the ID store, opened and ready. A file SQLite cannot read (a crash or a full disk leaves one) is moved aside once and
 *  made again, so that it costs the sequence table its rebuild from tasks.json's data — the constructor imports it —
 *  instead of costing the server every start, for ever, as a crash on the constructor did. */
function opened(dir: string, retry = true): Database {
  const file = join(dir, 'task-ids.sqlite')
  try {
    const db = new Database(file, { create: true })
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      db.exec(SCHEMA)
    } catch (e) {
      db.close()
      throw e
    }
    return db
  } catch (e) {
    const words = e instanceof Error ? e.message : String(e)
    const code = (e as { code?: string }).code
    // only a file SQLite cannot read is moved aside, and only once: a lock, a full disk or a folder in its place says
    // what it is, and is nothing to rebuild the numbers over
    if (!retry || (code !== 'SQLITE_NOTADB' && code !== 'SQLITE_CORRUPT')) throw e
    // the numbers are rebuilt from tasks.json's data: a store that could not be read has none to give, and a number
    // handed out again would collide with the branch and worktree an earlier task of that number made
    if (readOnly(join(dir, 'tasks.json')))
      throw new Error(
        `shepherdr: ${file} could not be opened (${words}) and tasks.json could not be read either, so no task number can be ` +
          `re-derived from it without being reused: restore tasks.json and start again`,
      )
    let moved = ''
    try {
      // one repair is one entry beside the store, holding the three files SQLite keeps (the database, its write-ahead log
      // and its index): the newest COPIES repairs stay beside it, as they do for a JSON store
      const to = copyName(file, 'corrupt')
      mkdirSync(to)
      renameSync(file, join(to, basename(file)))
      moved = to
      // its log and its index belong to the database that just went: one left behind would be read against the new one
      for (const ext of ['-wal', '-shm']) if (existsSync(file + ext)) renameSync(file + ext, join(to, basename(file) + ext))
      pruneCopies(file, 'corrupt')
    } catch {
      /* it cannot be moved: the new file's own failure says why below */
    }
    console.error(
      moved
        ? `shepherdr: ${file} could not be opened (${words}): moved it to ${moved}, the newest ${COPIES} of each copy stay beside it, ` +
            'and made it again from tasks.json, so no task number is reused'
        : `shepherdr: ${file} could not be opened (${words}) and could not be moved aside: it stays where it is`,
    )
    return opened(dir, false)
  }
}

type Sequence = { space: string; prefix: string; last: number }
export class TaskIds {
  private db: Database
  constructor(spaces: Space[], legacy: { next: Record<string, number>; tasks: { id: string; n: number; project: string }[] }, idOf: (name: string) => string, dir = home()) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.db = opened(dir)
    this.db.transaction(() => {
      // Import tombstones too: tasks.json.next remembers numbers even after tasks were deleted. Unknown owners
      // stay reserved. Never change an existing reservation when another engine has an older JSON snapshot.
      for (const prefix of new Set([...Object.keys(legacy.next), ...spaces.map((s) => s.key), ...legacy.tasks.map((t) => t.id.replace(/-\d+$/, ''))])) {
        const owners = new Set([...spaces.filter((s) => s.key === prefix).map((s) => idOf(s.name)), ...legacy.tasks.filter((t) => t.id.startsWith(`${prefix}-`)).map((t) => t.project)])
        const owner = owners.size === 1 ? [...owners][0] : ''
        this.db.query('INSERT OR IGNORE INTO prefixes VALUES (?, ?)').run(prefix, owner)
      }
      for (const s of spaces) {
        const space = idOf(s.name)
        const last = Math.max(legacy.next[s.key] ?? 0, ...legacy.tasks.filter((t) => t.project === space).map((t) => t.n), 0)
        this.db.query('INSERT OR IGNORE INTO sequences VALUES (?, ?, ?)').run(space, s.key, last)
        // SQLite is authoritative after migration, including a crash before spaces.json was mirrored.
        s.key = this.get(space).prefix
      }
    }).immediate()
  }

  keys() { return (this.db.query('SELECT prefix FROM prefixes').all() as { prefix: string }[]).map((x) => x.prefix) }
  get(space: string): Sequence {
    const row = this.db.query('SELECT * FROM sequences WHERE space = ?').get(space) as Sequence | null
    if (!row) throw new Error('Select a repository space in Settings.')
    return row
  }
  /** New spaces appear after construction. Their automatic prefix avoids all historical reservations. */
  ensure(space: string, prefix: string) {
    this.db.transaction(() => {
      if (this.db.query('SELECT 1 FROM sequences WHERE space = ?').get(space)) return
      const owner = this.db.query('SELECT space FROM prefixes WHERE prefix = ?').get(prefix) as { space: string } | null
      if (owner && owner.space !== space) throw new Error('That prefix is reserved on this machine.')
      this.db.query('INSERT OR IGNORE INTO prefixes VALUES (?, ?)').run(prefix, space)
      this.db.query('INSERT INTO sequences VALUES (?, ?, 0)').run(space, prefix)
    }).immediate()
  }
  set(space: string, key: string, value: string | null) {
    this.db.transaction(() => {
      const row = this.get(space)
      if (key === 'taskIds.prefix') {
        const prefix = value ?? ''
        const bad = prefixProblem(prefix)
        if (bad) throw new Error(bad)
        const owner = this.db.query('SELECT space FROM prefixes WHERE prefix = ?').get(prefix) as { space: string } | null
        if (owner && owner.space !== space) throw new Error('That prefix is already used or reserved on this machine.')
        this.db.query('INSERT OR IGNORE INTO prefixes VALUES (?, ?)').run(prefix, space)
        this.db.query('UPDATE sequences SET prefix = ? WHERE space = ?').run(prefix, space)
      } else if (key === 'taskIds.next') {
        const next = Number(value)
        if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(next) || next > MAX_TASK_NUMBER) throw new Error(`Use a whole number from 1 to ${MAX_TASK_NUMBER}.`)
        if (next <= row.last) throw new Error(`Use ${row.last + 1} or higher. Earlier numbers are reserved.`)
        this.db.query('UPDATE sequences SET last = ? WHERE space = ?').run(next - 1, space)
      } else throw new Error('No such task ID setting.')
    }).immediate()
    return this.get(space)
  }
  allocate(space: string) {
    return this.db.transaction(() => {
      const row = this.get(space)
      const n = row.last + 1
      if (!Number.isSafeInteger(n) || n > MAX_TASK_NUMBER) throw new Error('Task numbers are exhausted for this space.')
      const owner = this.db.query('SELECT space FROM prefixes WHERE prefix = ?').get(row.prefix) as { space: string } | null
      if (owner?.space !== space) throw new Error('This prefix has conflicting history. Choose another in Settings → Task IDs.')
      this.db.query('UPDATE sequences SET last = ? WHERE space = ?').run(n, space)
      return { id: `${row.prefix}-${n}`, n, prefix: row.prefix }
    }).immediate()
  }
  close() { this.db.close() }
}
