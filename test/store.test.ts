// Shepherdr's own folder (server/store.ts): what a store that cannot be read keeps, what a write never erases, and how a
// write of a store of record survives a power loss. A store of record (tasks, spaces, settings, automations) keeps its
// bytes and takes no write that run; a cache starts from the fallback and fills again.
import { describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { beside, COPIES, home, readJson, writeJson } from '../server/store.ts'
import { TaskIds } from '../server/live/task-ids.ts'
import type { Space } from '../server/live/places.ts'
import { tmp } from './tmp.ts'
import { world } from './engine-world.ts'

const space = (name: string, key: string): Space => ({ name, key, path: `/repos/${name}`, github: null, base: 'main', added: 1 })
const id = (name: string) => `p:machine:${name}`

/** the copies of a store beside it, oldest first */
const copies = (dir: string, kind: 'corrupt' | 'before-empty') => fs.readdirSync(dir).filter((n) => n.includes(`.${kind}-`)).sort()

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
      const said = String(page.mock.calls[0]?.[0])
      const [copy] = copies(dir, 'corrupt')
      expect(copy).toBeDefined()
      expect(said).toContain(join(dir, 'agents.json'))
      expect(said).toContain(String(bytes.length))
      expect(said).toContain(join(dir, copy))
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
      expect(String(page.mock.calls[0]?.[0])).toContain(`newest ${COPIES}`)
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
      expect(String(page.mock.calls[0]?.[0])).toContain('read-only')
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
      const said = String(page.mock.calls[0]?.[0])
      expect(said).toContain(join(dir, 'agents.json'))
      expect(said).toContain('cannot be read')
      expect(said).toContain('could not be copied')
    } finally {
      page.mockRestore()
    }
  })
})

describe('a write that would empty a store', () => {
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
      // a file already holding an empty collection, or nothing at all, is replaced as before: no copy of it
      writeJson('agents.json', {}, dir)
      fs.writeFileSync(join(dir, 'health.json'), '')
      writeJson('health.json', {}, dir)
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
})

describe('the file that keeps task numbers', () => {
  test('one SQLite cannot read is moved aside and made again from tasks.json, so no number is reused', () => {
    const dir = tmp('store-task-ids')
    const page = spyOn(console, 'error').mockImplementation(() => {})
    const legacy = { next: { WEB: 250 }, tasks: [{ id: 'WEB-250', n: 250, project: id('web') }] }
    try {
      fs.writeFileSync(join(dir, 'task-ids.sqlite'), 'not a database at all')
      const ids = new TaskIds([space('web', 'WEB')], legacy, id, dir)
      try {
        expect(page).toHaveBeenCalledTimes(1)
        const said = String(page.mock.calls[0]?.[0])
        const [copy] = fs.readdirSync(dir).filter((n) => n.startsWith('task-ids.sqlite.corrupt-'))
        expect(copy).toBeDefined()
        expect(said).toContain(join(dir, copy))
        expect(fs.readFileSync(join(dir, copy), 'utf8')).toBe('not a database at all')
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
      fs.chmodSync(dir, 0o500) // its file can be read and written, the folder cannot take the rename
      try {
        expect(() => new TaskIds([space('web', 'WEB')], { next: {}, tasks: [] }, id, dir)).toThrow()
        expect(String(page.mock.calls[0]?.[0])).toContain('could not be moved aside')
      } finally {
        fs.chmodSync(dir, 0o700)
      }
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
      expect(String(page.mock.calls[0]?.[0])).toContain('read-only')
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

describe('the copies beside a store', () => {
  test('a folder that is not there, or an old copy that will not go, costs the copy and not the run', () => {
    const page = spyOn(console, 'error').mockImplementation(() => {})
    try {
      // a folder that is not there has nothing to prune: the name the copy would take is still given
      expect(beside(join(tmp('store-gone'), 'kept', 'agents.json'), 'corrupt')).toContain('agents.json.corrupt-')
      // an old copy that cannot be removed (a folder named like one) stays, and the read still copies and answers
      const dir = tmp('store-odd-copy')
      const odd = 'agents.json.corrupt-1970-01-01T00-00-00.000Z'
      fs.mkdirSync(join(dir, odd, 'inside'), { recursive: true })
      fs.writeFileSync(join(dir, 'agents.json.corrupt-1970-01-02T00-00-00.000Z'), 'old')
      fs.writeFileSync(join(dir, 'agents.json.corrupt-1970-01-03T00-00-00.000Z'), 'old')
      fs.writeFileSync(join(dir, 'agents.json'), '{"a":')
      expect(readJson('agents.json', {}, dir)).toEqual({})
      const fresh = copies(dir, 'corrupt').filter((n) => !n.includes('1970-'))
      expect(fresh).toHaveLength(1)
      expect(fs.readFileSync(join(dir, fresh[0]), 'utf8')).toBe('{"a":')
    } finally {
      page.mockRestore()
    }
  })

  test('a file it cannot read is copied nowhere before an empty write, and the write goes in', () => {
    const dir = tmp('store-unreadable-empty')
    fs.writeFileSync(join(dir, 'agents.json'), '{"a": 1}')
    fs.chmodSync(join(dir, 'agents.json'), 0o000)
    writeJson('agents.json', {}, dir)
    expect(copies(dir, 'before-empty')).toHaveLength(0)
    expect(readJson<unknown>('agents.json', null, dir)).toEqual({})
  })
})
