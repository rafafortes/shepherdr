// Shepherdr's own folder (server/store.ts): what a store that cannot be read keeps, what a write never erases, and how a
// write of a store of record survives a power loss. A store of record (tasks, spaces, settings, automations) keeps its
// bytes and takes no write that run, and the two big caches (agents, usage) are guarded the same way when a write would
// empty them; every other store is a cache that starts from the fallback and fills again.
import { describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { COPIES, copyName, home, pruneCopies, readJson, writeJson } from '../server/store.ts'
import { migrateToSpaces } from '../server/live/migrate.ts'
import { TaskIds } from '../server/live/task-ids.ts'
import type { Space } from '../server/live/places.ts'
import { tmp } from './tmp.ts'
import { world } from './engine-world.ts'

const space = (name: string, key: string): Space => ({ name, key, path: `/repos/${name}`, github: null, base: 'main', added: 1 })
const id = (name: string) => `p:machine:${name}`

/** the copies of a store beside it, oldest first */
const copies = (dir: string, kind: 'corrupt' | 'before-empty') =>
  fs
    .readdirSync(dir)
    .filter((n) => n.includes(`.${kind}-`))
    .sort()

/** what a copy of a file that cannot be read says: its file, the bytes it was, and where the copy is */
const said = (page: ReturnType<typeof spyOn>, i = 0) => String(page.mock.calls[i]?.[0])

describe('a clean store', () => {
  test('reads as it was written, leaves no copy and says nothing', () => {
    const dir = tmp('store-clean')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(readJson('agents.json', { missing: true }, dir)).toEqual({ missing: true })
      writeJson('agents.json', { a: { id: 'a' } }, dir)
      expect(readJson('agents.json', {}, dir)).toEqual({ a: { id: 'a' } })
      writeJson('tasks.json', { next: { A: 1 }, tasks: [] }, dir)
      expect(readJson<unknown>('tasks.json', null, dir)).toEqual({ next: { A: 1 }, tasks: [] })
      expect(fs.readdirSync(dir).sort()).toEqual(['agents.json', 'tasks.json'])
      expect(page).not.toHaveBeenCalled()
    } finally {
      page.mockRestore()
    }
  })
})

describe('a store that cannot be read', () => {
  test('a cache keeps its bytes in a copy named in one line and starts from the fallback', () => {
    const dir = tmp('store-corrupt-cache')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const bytes = '{"a": {"id": "a"}, "b"'
      fs.writeFileSync(join(dir, 'agents.json'), bytes)
      expect(readJson('agents.json', {}, dir)).toEqual({})
      expect(page).toHaveBeenCalledTimes(1)
      const [copy] = copies(dir, 'corrupt')
      expect(copy).toBeDefined()
      expect(said(page)).toContain(join(dir, 'agents.json'))
      expect(said(page)).toContain(`${bytes.length} bytes`)
      expect(said(page)).toContain(join(dir, copy))
      expect(fs.readFileSync(join(dir, copy), 'utf8')).toBe(bytes)
      // a cache takes writes again: the run goes on from what herdr and the agents say
      writeJson('agents.json', { b: 1 }, dir)
      expect(readJson<unknown>('agents.json', null, dir)).toEqual({ b: 1 })
    } finally {
      page.mockRestore()
    }
  })

  test(`the newest ${COPIES} copies of a store stay beside it, an older one goes`, () => {
    const dir = tmp('store-copies')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (let i = 0; i < COPIES + 1; i++) {
        fs.writeFileSync(join(dir, 'agents.json'), `{"broken": ${i}`)
        readJson('agents.json', {}, dir)
        Bun.sleepSync(2) // a stamp of the same millisecond would be the same file, not another copy
      }
      const kept = copies(dir, 'corrupt')
      expect(kept).toHaveLength(COPIES)
      expect(kept.map((n) => fs.readFileSync(join(dir, n), 'utf8'))).toEqual(['{"broken": 1', '{"broken": 2', '{"broken": 3'])
      expect(said(page)).toContain(`newest ${COPIES}`)
    } finally {
      page.mockRestore()
    }
  })

  test('one unreadable file read twice in a run makes one copy and says one line', () => {
    const dir = tmp('store-read-twice')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      fs.writeFileSync(join(dir, 'spaces.json'), '[{"name": "a"},')
      expect(readJson('spaces.json', null, dir)).toBeNull()
      expect(readJson('spaces.json', [], dir)).toEqual([])
      expect(page).toHaveBeenCalledTimes(1)
      expect(copies(dir, 'corrupt')).toHaveLength(1)
    } finally {
      page.mockRestore()
    }
  })

  test('a store of record keeps its file through every save of that run, and writes again once it is gone', () => {
    const dir = tmp('store-record')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const bytes = '{"next": {"A": 3}, "tasks": [{"id": "A-1"}, '
      fs.writeFileSync(join(dir, 'tasks.json'), bytes)
      const tasks = readJson('tasks.json', { next: {}, tasks: [] }, dir)
      expect(tasks).toEqual({ next: {}, tasks: [] })
      expect(said(page)).toContain('read-only')
      writeJson('tasks.json', tasks, dir)
      writeJson('tasks.json', { next: { A: 1 }, tasks: [{ id: 'A-1' }] }, dir)
      expect(fs.readFileSync(join(dir, 'tasks.json'), 'utf8')).toBe(bytes)
      expect(copies(dir, 'corrupt')).toHaveLength(1)
      expect(page).toHaveBeenCalledTimes(2) // the read, then one line for every save it kept
      // only that store is read-only: the run's other stores are written as usual
      writeJson('settings.json', { x: 1 }, dir)
      expect(readJson('settings.json', {}, dir)).toEqual({ x: 1 })
      // the person moves the unreadable file away (or restores one): the store takes writes again
      fs.rmSync(join(dir, 'tasks.json'))
      writeJson('tasks.json', { next: {}, tasks: [] }, dir)
      expect(readJson<unknown>('tasks.json', null, dir)).toEqual({ next: {}, tasks: [] })
      expect(page).toHaveBeenCalledTimes(2)
    } finally {
      page.mockRestore()
    }
  })

  test('a store that cannot even be read is named with what failed, and the read still answers the fallback', () => {
    const dir = tmp('store-unreadable')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      fs.mkdirSync(join(dir, 'agents.json'))
      expect(readJson('agents.json', { fallback: true }, dir)).toEqual({ fallback: true })
      expect(page).toHaveBeenCalledTimes(1)
      expect(said(page)).toContain(join(dir, 'agents.json'))
      expect(said(page)).toContain('cannot be read')
      expect(said(page)).toContain('could not be copied')
    } finally {
      page.mockRestore()
    }
  })
})

describe('the copies beside a store', () => {
  test('a copy carries a stamp, and the newest three of its kind are the ones kept', () => {
    const dir = tmp('store-prune')
    expect(copyName(join(dir, 'agents.json'), 'corrupt')).toContain('agents.json.corrupt-')
    pruneCopies(join(dir, 'gone', 'agents.json'), 'corrupt') // a folder that is not there has nothing to go through
    for (const t of ['01', '02', '03', '04']) fs.writeFileSync(join(dir, `agents.json.corrupt-1970-01-${t}T00-00-00.000Z`), t)
    pruneCopies(join(dir, 'agents.json'), 'corrupt')
    expect(copies(dir, 'corrupt')).toEqual(['1970-01-02', '1970-01-03', '1970-01-04'].map((t) => `agents.json.corrupt-${t}T00-00-00.000Z`))
  })

  test('an old copy that will not go stays, and the read goes on', () => {
    const dir = tmp('store-stubborn-copy')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    const stuck = join(dir, 'agents.json.corrupt-1970-01-01T00-00-00.000Z')
    fs.mkdirSync(join(stuck, 'inside'), { recursive: true })
    fs.writeFileSync(join(stuck, 'inside', 'a file'), 'kept')
    fs.writeFileSync(join(dir, 'agents.json.corrupt-1970-01-02T00-00-00.000Z'), 'old')
    fs.writeFileSync(join(dir, 'agents.json.corrupt-1970-01-03T00-00-00.000Z'), 'old')
    fs.writeFileSync(join(dir, 'agents.json'), '{"a":')
    fs.chmodSync(join(stuck, 'inside'), 0o500) // it cannot be removed, and that is not a reason to fail the read
    try {
      expect(readJson('agents.json', {}, dir)).toEqual({})
      expect(copies(dir, 'corrupt').filter((n) => !n.includes('1970-'))).toHaveLength(1)
      expect(copies(dir, 'corrupt')).toHaveLength(4) // the oldest could not go, so the three it kept are still four
    } finally {
      fs.chmodSync(join(stuck, 'inside'), 0o700)
      page.mockRestore()
    }
  })
})

describe('a write that would leave a store with nothing in it', () => {
  test('keeps the file it replaces when that file has entries, and copies nothing that has none', () => {
    const dir = tmp('store-empty')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      // a cache nothing could read, written empty on its first save: the unreadable bytes are kept a second time
      const bytes = '{"a": {"id": "a"'
      fs.writeFileSync(join(dir, 'agents.json'), bytes)
      const agents = readJson('agents.json', {}, dir)
      writeJson('agents.json', agents, dir)
      const [copy] = copies(dir, 'before-empty')
      expect(copy).toBeDefined()
      expect(fs.readFileSync(join(dir, copy), 'utf8')).toBe(bytes)
      expect(readJson<unknown>('agents.json', null, dir)).toEqual({})
      expect(copies(dir, 'corrupt')).toHaveLength(1)
      // a file already holding nothing, or nothing at all, is replaced as before: no copy of it
      writeJson('agents.json', {}, dir)
      fs.writeFileSync(join(dir, 'agents.json'), '')
      writeJson('agents.json', {}, dir)
      expect(copies(dir, 'before-empty')).toHaveLength(1)
      // nor is a file whose entries are replaced by other entries
      fs.writeFileSync(join(dir, 'usage.json'), '{"a": 1}')
      writeJson('usage.json', { b: 2 }, dir)
      expect(readJson<unknown>('usage.json', null, dir)).toEqual({ b: 2 })
      expect(copies(dir, 'before-empty')).toHaveLength(1)
      expect(page.mock.calls.map((c) => String(c[0])).join('\n')).toContain('written empty')
    } finally {
      page.mockRestore()
    }
  })

  test('the empty state of tasks.json ({ next: {}, tasks: [] }) is kept off a file that has tasks in it', () => {
    const dir = tmp('store-tasks-empty')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      writeJson('tasks.json', { next: { A: 1 }, tasks: [{ id: 'A-1', n: 1 }] }, dir)
      writeJson('tasks.json', { next: {}, tasks: [] }, dir)
      const [copy] = copies(dir, 'before-empty')
      expect(copy).toBeDefined()
      expect(readJson<unknown>(copy, null, dir)).toMatchObject({ tasks: [{ id: 'A-1', n: 1 }] })
      expect(said(page)).toContain('written empty')
    } finally {
      page.mockRestore()
    }
  })

  test('the empty state of the usage ledger ({ version: 2, usage: {}, … }) is kept off a file with rows in it', () => {
    const dir = tmp('store-usage-empty')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    const fresh = { version: 2, usage: {}, seen: {}, runOuts: [], quotas: {}, alerts: {}, files: {} }
    try {
      writeJson('usage.json', { ...fresh, usage: { 'claude|week': { at: 1 } }, files: { '/a.jsonl': { ino: 1, offset: 2 } } }, dir)
      writeJson('usage.json', fresh, dir)
      expect(copies(dir, 'before-empty')).toHaveLength(1)
      expect(said(page)).toContain('written empty')
    } finally {
      page.mockRestore()
    }
  })

  test('a file whose bytes cannot be copied later is said again, not masked by the copy it had', () => {
    const dir = tmp('store-said-again')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      fs.writeFileSync(join(dir, 'agents.json'), '{"a":')
      readJson('agents.json', {}, dir) // a copy of it, and its line
      fs.writeFileSync(join(dir, 'agents.json'), '{"broken": true,')
      Bun.sleepSync(2) // a stamp of the same millisecond would name the copy that is already there, and writing over a
      // file the folder already holds is allowed: this one has to be a copy that is not there yet
      fs.chmodSync(dir, 0o500) // nothing inside can be copied out, and nothing can be copied in
      try {
        expect(readJson('agents.json', {}, dir)).toEqual({})
      } finally {
        fs.chmodSync(dir, 0o700)
      }
      expect(page).toHaveBeenCalledTimes(2)
      expect(said(page, 1)).toContain('could not be copied')
    } finally {
      page.mockRestore()
    }
  })

  test('a small cache that drains as it should is written over as before, with no copy of it', () => {
    const dir = tmp('store-drain')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      writeJson('outbox.json', ['a'], dir)
      writeJson('outbox.json', [], dir)
      expect(readJson<unknown>('outbox.json', null, dir)).toEqual([])
      expect(copies(dir, 'before-empty')).toHaveLength(0)
      expect(page).not.toHaveBeenCalled()
    } finally {
      page.mockRestore()
    }
  })

  test('a guarded file it cannot read is copied nowhere before an empty write, and the write goes in', () => {
    const dir = tmp('store-unreadable-empty')
    fs.writeFileSync(join(dir, 'agents.json'), '{"a": 1}')
    fs.chmodSync(join(dir, 'agents.json'), 0o000)
    writeJson('agents.json', {}, dir)
    expect(copies(dir, 'before-empty')).toHaveLength(0)
    expect(readJson<unknown>('agents.json', null, dir)).toEqual({})
  })

  test('a copy that cannot be made is said, and the write goes on without it', () => {
    const dir = tmp('store-copy-refused')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    const stamp = spyOn(Date.prototype, 'toISOString').mockReturnValue('1999-01-01T00-00-00.000Z')
    try {
      writeJson('agents.json', { a: 1 }, dir)
      // what a copy of it would be named is a folder that cannot be copied onto
      fs.mkdirSync(join(dir, 'agents.json.before-empty-1999-01-01T00-00-00.000Z', 'inside'), { recursive: true })
      writeJson('agents.json', {}, dir)
      expect(said(page)).toContain('could not be made')
      expect(readJson<unknown>('agents.json', null, dir)).toEqual({})
    } finally {
      stamp.mockRestore()
      page.mockRestore()
    }
  })
})

describe('a store of record that is empty', () => {
  test('holds nothing to keep: it starts from the fallback, takes no copy, and writes again', () => {
    const dir = tmp('store-empty-file')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      fs.writeFileSync(join(dir, 'tasks.json'), '')
      expect(readJson('tasks.json', { next: {}, tasks: [] }, dir)).toEqual({ next: {}, tasks: [] })
      expect(page).not.toHaveBeenCalled()
      expect(copies(dir, 'corrupt')).toHaveLength(0)
      writeJson('tasks.json', { next: { A: 1 }, tasks: [] }, dir)
      expect(readJson<unknown>('tasks.json', null, dir)).toEqual({ next: { A: 1 }, tasks: [] })
    } finally {
      page.mockRestore()
    }
  })
})

describe('a store of record the migration reads', () => {
  test('a corrupt spaces.json does not run the legacy migration over the rest of the home', () => {
    const dir = home()
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      fs.writeFileSync(join(dir, 'spaces.json'), '[{"name": "a"},')
      fs.writeFileSync(join(dir, 'projects.json'), '[]')
      migrateToSpaces((m) => `p:${m ?? 'here'}:home`, 'p:here:home')
      expect(page).toHaveBeenCalledTimes(1) // the read's line, and no migration writing over the rest
      expect(fs.existsSync(join(dir, 'projects.json'))).toBe(true)
      expect(fs.existsSync(join(dir, 'modes.json'))).toBe(false)
    } finally {
      page.mockRestore()
    }
  })
})

describe('a write of a store of record', () => {
  test('fsyncs the tmp file before the rename and its folder after it; a cache takes no fsync', () => {
    const dir = tmp('store-fsync')
    const target = join(dir, 'tasks.json')
    const tmpFile = `${target}.tmp`
    const seen: { target: boolean; tmp: boolean }[] = []
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(() => {
      seen.push({ target: fs.existsSync(target), tmp: fs.existsSync(tmpFile) })
      return 0
    })
    try {
      writeJson('tasks.json', { next: {}, tasks: [] }, dir)
      // the store's file first, still under its temporary name, then the folder once the rename has happened
      expect(seen).toEqual([
        { target: false, tmp: true },
        { target: true, tmp: false },
      ])
      writeJson('agents.json', { a: 1 }, dir)
      expect(seen).toHaveLength(2)
    } finally {
      sync.mockRestore()
    }
  })

  test('a folder that refuses to be synced costs the last write, not the run', () => {
    const dir = tmp('store-fsync-folder')
    let calls = 0
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(() => {
      if (++calls === 2) throw new Error('EIO: the folder refused')
      return 0
    })
    try {
      writeJson('tasks.json', { next: {}, tasks: [{}] }, dir)
      expect(calls).toBe(2)
      expect(readJson<unknown>('tasks.json', null, dir)).toEqual({ next: {}, tasks: [{}] })
    } finally {
      sync.mockRestore()
    }
  })
})

describe('the file that keeps task numbers', () => {
  test('one SQLite cannot read is moved aside and made again from tasks.json, so no number is reused', () => {
    const dir = tmp('store-task-ids')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    const legacy = { next: { WEB: 250 }, tasks: [{ id: 'WEB-250', n: 250, project: id('web') }] }
    try {
      fs.writeFileSync(join(dir, 'task-ids.sqlite'), 'not a database at all')
      fs.writeFileSync(join(dir, 'task-ids.sqlite-wal'), 'its log')
      const ids = new TaskIds([space('web', 'WEB')], legacy, id, dir)
      try {
        expect(page).toHaveBeenCalledTimes(1)
        // one repair is one entry beside the store, holding every file SQLite kept of it
        const [copy] = fs.readdirSync(dir).filter((n) => n.startsWith('task-ids.sqlite.corrupt-'))
        expect(copy).toBeDefined()
        expect(said(page)).toContain(join(dir, copy))
        // SQLite takes a stale write-ahead log of a file it cannot read with it; what is there is kept inside
        expect(fs.readdirSync(join(dir, copy))).toContain('task-ids.sqlite')
        expect(fs.readFileSync(join(dir, copy, 'task-ids.sqlite'), 'utf8')).toBe('not a database at all')
        expect(ids.allocate(id('web')).id).toBe('WEB-251')
      } finally {
        ids.close()
      }
      // what it rebuilt is a database: the next start reads it and goes on from where the legacy data ended
      const again = new TaskIds([space('web', 'WEB')], legacy, id, dir)
      try {
        expect(again.allocate(id('web')).id).toBe('WEB-252')
        expect(page).toHaveBeenCalledTimes(1)
      } finally {
        again.close()
      }
    } finally {
      page.mockRestore()
    }
  })

  test('a file that cannot be moved aside fails the start as it did, rather than losing the numbers', () => {
    const dir = tmp('store-task-ids-stuck')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      fs.writeFileSync(join(dir, 'task-ids.sqlite'), 'not a database at all')
      fs.chmodSync(dir, 0o500) // its file can be read and written, the folder cannot take the new entry
      try {
        expect(() => new TaskIds([space('web', 'WEB')], { next: {}, tasks: [] }, id, dir)).toThrow()
        expect(said(page)).toContain('could not be moved aside')
      } finally {
        fs.chmodSync(dir, 0o700)
      }
    } finally {
      page.mockRestore()
    }
  })

  test('a file it cannot open for any other reason is said as it is, never moved aside', () => {
    const dir = tmp('store-task-ids-folder')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      fs.mkdirSync(join(dir, 'task-ids.sqlite')) // a folder in the database's place: SQLite cannot open it
      expect(() => new TaskIds([space('web', 'WEB')], { next: {}, tasks: [] }, id, dir)).toThrow()
      expect(page).not.toHaveBeenCalled()
      expect(fs.readdirSync(dir)).toEqual(['task-ids.sqlite'])
    } finally {
      page.mockRestore()
    }
  })

  test('a corrupt file is not rebuilt over a tasks.json nothing could read either', () => {
    const dir = tmp('store-task-ids-both')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      fs.writeFileSync(join(dir, 'task-ids.sqlite'), 'not a database at all')
      fs.writeFileSync(join(dir, 'tasks.json'), '{"next": {"WEB": 2}, "tasks": [')
      expect(readJson('tasks.json', { next: {}, tasks: [] }, dir)).toEqual({ next: {}, tasks: [] })
      // its numbers are what a rebuild would derive: without them a reuse is certain, so nothing is moved or made
      expect(() => new TaskIds([space('web', 'WEB')], { next: {}, tasks: [] }, id, dir)).toThrow(/no task number/)
      expect(fs.readdirSync(dir).filter((n) => n.startsWith('task-ids.sqlite.corrupt-'))).toHaveLength(0)
      expect(fs.readFileSync(join(dir, 'task-ids.sqlite'), 'utf8')).toBe('not a database at all')
    } finally {
      page.mockRestore()
    }
  })
})

describe('the engine on a store it cannot read', () => {
  test('starts on a truncated tasks.json, names its copy once, and never overwrites the file', () => {
    const file = join(home(), 'tasks.json')
    const bytes = '{"next": {"A": 2}, "tasks": [{"id": "A-1", "n": 1}, '
    fs.writeFileSync(file, bytes)
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const w = world()
      expect(page).toHaveBeenCalledTimes(1)
      expect(said(page)).toContain('read-only')
      expect(w.engine.tasks).toEqual([])
      const [copy] = copies(home(), 'corrupt')
      expect(copy).toBeDefined()
      expect(fs.readFileSync(join(home(), copy), 'utf8')).toBe(bytes)
      expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
    } finally {
      page.mockRestore()
    }
  })
})

describe('the files that hold secrets stay readable by you only', () => {
  test('a write tightens a loose private file even when its tmp was made loose; a cache stays 0644', () => {
    const dir = tmp('store-private-write')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const name of ['secrets.json', 'vapid.json', 'push.json']) {
        const f = join(dir, name)
        fs.writeFileSync(f, '{"old": true}')
        fs.chmodSync(f, 0o644)
        // the mode passed to open applies only on create: a tmp an older write left loose keeps it, and the rename
        // would give that mode to the file. This is the edge the explicit chmod closes.
        fs.writeFileSync(`${f}.tmp`, 'a loose tmp from another write')
        fs.chmodSync(`${f}.tmp`, 0o644)
        writeJson(name, { key: 'value' }, dir)
        expect(fs.statSync(f).mode & 0o777).toBe(0o600)
        expect(readJson<unknown>(name, null, dir)).toEqual({ key: 'value' })
      }
      const agents = join(dir, 'agents.json')
      fs.writeFileSync(agents, '{}')
      fs.chmodSync(agents, 0o644)
      writeJson('agents.json', { a: 1 }, dir)
      expect(fs.statSync(agents).mode & 0o777).toBe(0o644)
      expect(page).not.toHaveBeenCalled()
    } finally {
      page.mockRestore()
    }
  })

  test('a loose private file we only read is tightened, says one line, and keeps its bytes', () => {
    const dir = tmp('store-private-read')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const f = join(dir, 'secrets.json')
      const bytes = '{"elevenlabs": "key-1"}'
      fs.writeFileSync(f, bytes)
      fs.chmodSync(f, 0o644)
      expect(readJson<unknown>('secrets.json', null, dir)).toEqual({ elevenlabs: 'key-1' })
      expect(fs.statSync(f).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(f, 'utf8')).toBe(bytes)
      expect(page).toHaveBeenCalledTimes(1)
      expect(said(page)).toContain(f)
      expect(said(page)).toContain('tightened')
      expect(said(page)).toContain('0600')
      // the first read's chmod makes the next one quiet
      expect(readJson<unknown>('secrets.json', null, dir)).toEqual({ elevenlabs: 'key-1' })
      expect(page).toHaveBeenCalledTimes(1)
    } finally {
      page.mockRestore()
    }
  })

  test('a private file we cannot tighten still reads, with no line about a mode we did not change', () => {
    const dir = tmp('store-private-stuck')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    const f = join(dir, 'secrets.json')
    fs.writeFileSync(f, '{"key": "kept"}')
    fs.chmodSync(f, 0o644)
    const real = fs.chmodSync
    const chmod = spyOn(fs, 'chmodSync').mockImplementation((p, m) => {
      if (p === f) throw new Error('EACCES')
      return real(p, m)
    })
    try {
      expect(readJson<unknown>('secrets.json', null, dir)).toEqual({ key: 'kept' })
      expect(fs.statSync(f).mode & 0o777).toBe(0o644)
      expect(page).not.toHaveBeenCalled()
    } finally {
      chmod.mockRestore()
      page.mockRestore()
    }
  })
})
