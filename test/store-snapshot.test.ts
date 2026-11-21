// Nightly snapshots of the stores (SHE-142, audit 2026-11-18 OPS-04). What a snapshot takes and what it must never take
// (no secret, no chat, no attachment, no other machine's payload), the retention of 14 days and 4 weeks, the size it
// prints, and the restore that refuses while a server runs in the home it would write over. Every home here is a folder
// in /tmp: no test touches the Shepherdr of the machine it runs on.
import { describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DAILY, dated, dayOf, FOLDER, linked, main, pidAlive, prune, restore, same, size, snapshot, stores, WEEKLY, weekOf } from '../scripts/snapshot.ts'
import { tmp } from './tmp.ts'

/** a file in `dir`, made with its folders: `put(home, 'inbox/a.png')` is an attachment, never a store */
function put(dir: string, name: string, text = `${name}\n`): string {
  const f = join(dir, name)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, text)
  return f
}

/** a folder for a snapshot day, as a run of that day would leave it (without the 20 MB of stores: only its name counts) */
function fabricate(dir: string, day: string, name = 'tasks.json'): string {
  const d = join(dir, FOLDER, day)
  mkdirSync(d, { recursive: true })
  put(d, name, '{"tasks":[]}')
  return d
}

/** what a run printed on one stream */
const said = (page: ReturnType<typeof spyOn>) => page.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')

/** a child that has already ended, and its pid: a server.json that names a server which is no longer there */
async function gonePid(): Promise<number> {
  const child = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' })
  const pid = child.pid
  await child.exited
  return pid
}

/** everything a fake home holds, as the live stores of a working Shepherdr and the things a snapshot must not bring */
function working(dir: string) {
  for (const name of ['tasks.json', 'spaces.json', 'settings.json', 'automations.json', 'agents.json', 'usage.json', 'returns.json']) put(dir, name, `{"store":"${name}"}`)
  // the text of messages, waiting or typed: chat content, so never in a snapshot
  for (const name of ['outbox.json', 'typed.json']) put(dir, name, `{"text":"${name}"}`)
  put(dir, 'task-ids.sqlite', 'db')
  put(dir, 'task-ids.sqlite-wal', 'wal')
  put(dir, 'task-ids.sqlite-shm', 'shm')
  // the secrets, and a file whose name says it is one even though the list has never heard of it
  for (const name of ['secrets.json', 'vapid.json', 'push.json', 'vault.json', 'push-subscriptions.json']) put(dir, name, `{"secret":"${name}"}`)
  // a runtime file, and the copies an earlier run or the operator left beside a store
  put(dir, 'server.json', '{"port":7787,"pid":1}')
  put(dir, 'settings.json.bak-20261104-everywhere', '{"old":true}')
  put(dir, 'tasks.json.corrupt-2026-11-18T10-00-00.000Z', '{"broken":')
  // nothing outside the home's own folder, however it is named
  put(dir, 'inbox/screenshot.png')
  put(dir, 'chatlog/p:m:space.json')
  put(dir, 'machines/box/server.json')
  put(dir, 'artifacts/wk3n/board.html')
}

describe('what a snapshot takes', () => {
  test('the home stores and the ID store with its log and index, and none of the secrets, chats or copies', () => {
    const dir = tmp('snapshot-take')
    working(dir)
    expect(stores(dir)).toEqual([
      'agents.json',
      'automations.json',
      'returns.json',
      'settings.json',
      'spaces.json',
      'task-ids.sqlite',
      'task-ids.sqlite-shm',
      'task-ids.sqlite-wal',
      'tasks.json',
      'usage.json',
    ])
    const made = snapshot(dir, new Date(2026, 10, 18))
    expect(made.day).toBe('2026-11-18')
    expect([...made.files].sort()).toEqual(stores(dir))
    // the whole point: no secret file, no message text, no chat, no attachment, no other machine's payload, not even
    // under its own name
    for (const name of made.files) expect(name).not.toMatch(/secret|vapid|push|vault|outbox|typed|chatlog|inbox|machines|artifacts/)
    expect(made.files).not.toContain('outbox.json')
    expect(made.files).not.toContain('typed.json')
    // the ID store is copied last: a number reserved before its task is never older than tasks.json beside it
    expect(made.files.slice(-3)).toEqual(['task-ids.sqlite', 'task-ids.sqlite-shm', 'task-ids.sqlite-wal'])
    expect(readdirSync(made.dir).sort()).toEqual([...made.files].sort())
    expect(readFileSync(join(made.dir, 'tasks.json'), 'utf8')).toBe('{"store":"tasks.json"}')
    // the three files of the ID store are copied together: a database restored without its log means nothing
    for (const name of ['task-ids.sqlite', 'task-ids.sqlite-wal', 'task-ids.sqlite-shm']) expect(existsSync(join(made.dir, name))).toBe(true)
    expect(made.bytes).toBeGreaterThan(0)
    expect(made.shared).toBe(0)
  })

  test('a folder the home does not have is not a store, and a file it cannot read is named instead of lost in silence', () => {
    const dir = tmp('snapshot-broken')
    put(dir, 'tasks.json', '{"tasks":[]}')
    const bad = put(dir, 'usage.json', '{"usage":{}}')
    chmodSync(bad, 0o000)
    const page = spyOn(console, 'error').mockImplementation(() => {})
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const made = snapshot(dir, new Date(2026, 10, 18))
      expect(made.files).toEqual(['tasks.json'])
      expect(made.skipped).toEqual(['usage.json'])
      // a folder missing a store is not a backup: the day is not saved at all
      expect(made.saved).toBe(false)
      expect(made.dir).toBe('')
      expect(existsSync(join(dir, FOLDER, '2026-11-18'))).toBe(false)
      expect(readdirSync(join(dir, FOLDER))).toEqual([])
      // a snapshot missing a store is a failed run, never a quiet one
      expect(main([], dir, new Date(2026, 10, 18))).toBe(1)
      expect(said(log)).not.toContain('snapshot 2026-11-18')
      expect(said(page)).toContain('nothing was saved for 2026-11-18')
      expect(said(page)).toContain('could not copy usage.json')
    } finally {
      chmodSync(bad, 0o644)
      page.mockRestore()
      log.mockRestore()
    }
  })

  test('an unchanged store is a hard link to the last snapshot, not a second copy of it', () => {
    const dir = tmp('snapshot-link')
    put(dir, 'settings.json', '{"settings":{}}')
    put(dir, 'tasks.json', '{"tasks":["one"]}')
    const first = snapshot(dir, new Date(2026, 10, 17))
    put(dir, 'tasks.json', '{"tasks":["one","two"]}')
    const second = snapshot(dir, new Date(2026, 10, 18))
    const file = (day: string, name: string) => join(dir, FOLDER, day, name)
    expect(second.shared).toBe(1)
    expect(statSync(file('2026-11-18', 'settings.json')).ino).toBe(statSync(file('2026-11-17', 'settings.json')).ino)
    expect(statSync(file('2026-11-18', 'tasks.json')).ino).not.toBe(statSync(file('2026-11-17', 'tasks.json')).ino)
    // tonight's folder holds what tonight's store holds; last night's keeps its own bytes
    expect(readFileSync(file('2026-11-18', 'tasks.json'), 'utf8')).toBe('{"tasks":["one","two"]}')
    expect(readFileSync(file('2026-11-17', 'tasks.json'), 'utf8')).toBe('{"tasks":["one"]}')
    expect(first.shared).toBe(0)
    // a filesystem that will not link, and two files it cannot compare, only cost space or a copy
    expect(linked(file('2026-11-18', 'settings.json'), file('2026-11-18', 'settings.json'))).toBe(false)
    expect(same(file('2026-11-18', 'settings.json'), join(dir, 'not-there.json'))).toBe(false)
    expect(same(file('2026-11-17', 'tasks.json'), file('2026-11-18', 'tasks.json'))).toBe(false)
    expect(same(file('2026-11-18', 'settings.json'), file('2026-11-17', 'settings.json'))).toBe(true)
  })

  test('a run killed halfway leaves a half folder, and the next run clears it', async () => {
    const dir = tmp('snapshot-stale')
    put(dir, 'tasks.json', '{"tasks":[]}')
    const dead = await gonePid()
    const half = join(dir, FOLDER, `.new-${dead}`)
    const aside = join(dir, FOLDER, `.old-${dead}`)
    mkdirSync(half, { recursive: true })
    mkdirSync(aside, { recursive: true })
    snapshot(dir, new Date(2026, 10, 18))
    expect(existsSync(half)).toBe(false)
    expect(existsSync(aside)).toBe(false)
    expect(dated(join(dir, FOLDER))).toEqual(['2026-11-18'])
  })
})

describe('the retention', () => {
  test('20 dated folders leave 14 days and 4 weeks', () => {
    const dir = tmp('snapshot-keep')
    const days = [
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-10-25',
      '2026-10-18',
      '2026-10-11',
      '2026-10-04',
      '2026-09-27',
    ]
    for (const day of days) fabricate(dir, day)
    // tonight's run is the twentieth folder: until the day is done, a re-run replaces it rather than adding one
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      put(dir, 'tasks.json', '{"tasks":[]}')
      const at = new Date(2026, 10, 20)
      expect(main([], dir, at)).toBe(0)
      // and again the same day: still one folder for it
      expect(main([], dir, at)).toBe(0)
    } finally {
      log.mockRestore()
    }
    const kept = dated(join(dir, FOLDER))
    expect(kept).toHaveLength(DAILY + WEEKLY)
    // the newest 14 days are kept as they are, tonight first
    expect(kept.slice(0, DAILY)).toEqual([
      '2026-11-20',
      '2026-11-14',
      '2026-11-13',
      '2026-11-12',
      '2026-11-11',
      '2026-11-10',
      '2026-11-09',
      '2026-11-08',
      '2026-11-07',
      '2026-11-06',
      '2026-11-05',
      '2026-11-04',
      '2026-11-03',
      '2026-11-02',
    ])
    // one day for each of the four weeks before them, and no more
    const weekly = kept.slice(DAILY)
    expect(weekly).toEqual(['2026-11-01', '2026-10-25', '2026-10-18', '2026-10-11'])
    expect(new Set(weekly.map(weekOf)).size).toBe(WEEKLY)
    expect(kept).not.toContain('2026-10-04')
    expect(kept).not.toContain('2026-09-27')
    // a second prune finds nothing left to remove
    expect(prune(join(dir, FOLDER))).toEqual([])
  })

  test('the weeks are the ISO ones, so a new year does not cost a snapshot', () => {
    expect(weekOf('2026-01-01')).toBe('2026-W01')
    expect(weekOf('2025-12-29')).toBe('2026-W01')
    expect(weekOf('2025-12-28')).toBe('2025-W52')
    expect(weekOf('2024-12-30')).toBe('2025-W01')
    expect(weekOf('2021-01-03')).toBe('2020-W53')
    expect(weekOf('2026-11-16')).toBe(weekOf('2026-11-22'))
    expect(dayOf(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('a restore', () => {
  test('refuses while a server runs in that home, and copies back once it does not', async () => {
    const dir = tmp('snapshot-restore')
    put(dir, 'tasks.json', '{"tasks":["nightly"]}')
    put(dir, 'settings.json', '{"settings":{"review":"on"}}')
    snapshot(dir, new Date(2026, 10, 18))
    // what the operator's mistake did after the snapshot was taken
    put(dir, 'tasks.json', '{"tasks":[]}')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      put(dir, 'server.json', JSON.stringify({ port: 7787, pid: process.pid }))
      expect(() => restore(dir, '2026-11-18')).toThrow(/Shepherdr is running in this home \(pid \d+\)/)
      expect(main(['restore', '2026-11-18'], dir)).toBe(1)
      expect(said(page)).toContain('herdr plugin action invoke herdr-projects.stop')
      // nothing was written over while it was refused
      expect(readFileSync(join(dir, 'tasks.json'), 'utf8')).toBe('{"tasks":[]}')
      // a server.json naming a server that ended long ago stops nothing, and neither does one a crash left unreadable
      put(dir, 'server.json', JSON.stringify({ port: 7787, pid: await gonePid() }))
      expect(restore(dir, '2026-11-18').files).toContain('tasks.json')
      expect(readFileSync(join(dir, 'tasks.json'), 'utf8')).toBe('{"tasks":["nightly"]}')
      put(dir, 'tasks.json', '{"tasks":[]}')
      // a server.json that is there and unreadable could be a server's: a restore must not guess, and changes nothing
      put(dir, 'server.json', 'not json at all')
      expect(() => restore(dir, '2026-11-18')).toThrow(/cannot be read .*, so a server could be running in this home/)
      expect(main(['restore', '2026-11-18'], dir)).toBe(1)
      expect(readFileSync(join(dir, 'tasks.json'), 'utf8')).toBe('{"tasks":[]}')
      expect(pidAlive(0)).toBe(false)
      expect(pidAlive(process.pid)).toBe(true)
      // no server.json at all: nothing serves this home, and the day comes back whole, one store at a time
      rmSync(join(dir, 'server.json'))
      expect(main(['restore', '2026-11-18'], dir)).toBe(0)
      expect(readFileSync(join(dir, 'tasks.json'), 'utf8')).toBe('{"tasks":["nightly"]}')
      expect(existsSync(join(dir, 'tasks.json.restore-tmp'))).toBe(false)
      // a day that is not there is refused, and says how to find the one that is
      expect(main(['restore', '2020-01-01'], dir)).toBe(1)
      expect(said(page)).toContain('no snapshot 2020-01-01')
      expect(main(['restore'], dir)).toBe(2)
      expect(said(page)).toContain('restore needs the day')
    } finally {
      page.mockRestore()
      log.mockRestore()
    }
  })

  test('the ID store comes back with the log and index it was copied with, or without any', () => {
    const dir = tmp('snapshot-ids')
    const day = join(dir, FOLDER, '2026-11-18')
    mkdirSync(day, { recursive: true })
    put(day, 'task-ids.sqlite', 'db-of-then')
    put(dir, 'task-ids.sqlite', 'db-now')
    put(dir, 'task-ids.sqlite-wal', 'wal-now')
    put(dir, 'task-ids.sqlite-shm', 'shm-now')
    // the snapshot was taken without a log: one left beside the restored database would be replayed against it
    expect(restore(dir, '2026-11-18').files).toEqual(['task-ids.sqlite'])
    expect(readFileSync(join(dir, 'task-ids.sqlite'), 'utf8')).toBe('db-of-then')
    expect(existsSync(join(dir, 'task-ids.sqlite-wal'))).toBe(false)
    expect(existsSync(join(dir, 'task-ids.sqlite-shm'))).toBe(false)
    // with the log and the index in the folder, all three come back together
    put(day, 'task-ids.sqlite-wal', 'wal-of-then')
    put(day, 'task-ids.sqlite-shm', 'shm-of-then')
    restore(dir, '2026-11-18')
    expect(readFileSync(join(dir, 'task-ids.sqlite-wal'), 'utf8')).toBe('wal-of-then')
    expect(readFileSync(join(dir, 'task-ids.sqlite-shm'), 'utf8')).toBe('shm-of-then')
  })
})

describe('the command', () => {
  test('lists what is kept and its size, and refuses words that are not a command', () => {
    const dir = tmp('snapshot-list')
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(main(['list'], dir)).toBe(0)
      expect(said(log)).toContain('none in')
      put(dir, 'tasks.json', '{"tasks":[]}')
      expect(main([], dir, new Date(2026, 10, 18))).toBe(0)
      expect(said(log)).toMatch(/snapshot 2026-11-18: \d+ B in 1 file, 1 snapshot kept in/)
      expect(main(['list'], dir)).toBe(0)
      expect(said(log)).toMatch(/\d{4}-\d{2}-\d{2} {2}\d+ B {2}1 file/)
      expect(main(['nonsense'], dir)).toBe(2)
      expect(said(page)).toContain('snapshot: no nonsense')
      // a home that is not there is said, not a stack trace in a nightly log
      expect(main([], join(dir, 'not-a-home'))).toBe(1)
      expect(said(page)).toContain('no Shepherdr home in')
    } finally {
      log.mockRestore()
      page.mockRestore()
    }
  })

  test('says its size in the words a person reads', () => {
    expect(size(512)).toBe('512 B')
    expect(size(2048)).toBe('2 KB')
    expect(size(3 * (1 << 20) + (1 << 19))).toBe('3.5 MB')
    expect(size(2 * (1 << 30))).toBe('2.0 GB')
  })
})
