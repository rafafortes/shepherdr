// A chat's attachments get a retention window when its task archives (RES-10): old files go, fresh ones stay, and off
// keeps today's behaviour. The clock is stubbed through autoArchive, so no test waits for days to pass.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inboxDir, pruneInbox } from '../server/live/inbox.ts'
import { repo, started, world } from './engine-world.ts'

const DAY = 86_400_000
const dirOf = (chat: string) => inboxDir(chat)

/** an attachment `age` old, as the server writes it: name, bytes and file time are all the pruning looks at */
function put(chat: string, name: string, age: number, bytes = 'file') {
  const dir = dirOf(chat)
  mkdirSync(dir, { recursive: true })
  const at = join(dir, name)
  writeFileSync(at, bytes)
  const when = new Date(Date.now() - age)
  utimesSync(at, when, when)
  return at
}

describe("a chat's attachments on archive", () => {
  test('old files go with their small copies, fresh ones stay', async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'trim')
    expect(w.settings.set('tasks.inboxKeep', '7 days', 'all').ok).toBe(true)
    const old = put(key, 'old.png', 10 * DAY)
    const thumb = put(key, 'old.png.thumb.jpg', 60_000, 'a copy made when a tile asked, long after the file')
    const fresh = put(key, 'fresh.png', 2 * DAY)

    await w.engine.archive(t.id)

    expect(existsSync(old)).toBe(false)
    expect(existsSync(thumb)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  test('autoArchive uses the same window and the clock it is given', async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'auto')
    expect(w.settings.set('tasks.inboxKeep', '3 days', 'all').ok).toBe(true)
    t.merged = true
    t.doneAt = Date.now() - 8 * DAY
    w.agentIs(key, 'idle')
    const old = put(key, 'old.png', 5 * DAY)
    const fresh = put(key, 'fresh.png', DAY)
    const now = Date.now()

    expect(w.engine.autoArchive(now)).toBe(1)
    expect(t.archived).toBe(now)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  test('off, the default, keeps every file until the task is deleted', async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'off')
    expect(w.settings.get('tasks.inboxKeep', 'off')).toBe('off')
    const old = put(key, 'old.png', 90 * DAY)

    await w.engine.archive(t.id)

    expect(existsSync(old)).toBe(true)
  })

  test("a space's own off keeps its files when the machine has a window set", async () => {
    const w = world()
    const { p, t, key } = await started(w, repo(), 'space-off')
    expect(w.settings.set('tasks.inboxKeep', '1 day', 'all').ok).toBe(true)
    expect(w.settings.set('tasks.inboxKeep', 'off', { space: p.name }).ok).toBe(true)
    const old = put(key, 'old.png', 90 * DAY)

    await w.engine.archive(t.id)

    expect(existsSync(old)).toBe(true)
  })
})

describe('the inbox prune itself', () => {
  test('a folder that went or was replaced never fails the archive', async () => {
    const w = world()
    const { t, key } = await started(w, repo(), 'notdir')
    expect(w.settings.set('tasks.inboxKeep', '1 day', 'all').ok).toBe(true)
    const dir = dirOf(key)
    mkdirSync(join(dir, '..'), { recursive: true })
    writeFileSync(dir, 'the chat folder is a file now')

    await w.engine.archive(t.id)

    expect(t.archived).toBeGreaterThan(0)
    expect(existsSync(dir)).toBe(true) // cleanup is best effort: it never took the thing that was in its way
  })

  test('a folder with no inbox is nothing to do; folders and links are left, a stale sidecar goes with its file', () => {
    const chat = 'GROUP-1/Agent'
    expect(pruneInbox(chat, DAY, Date.now())).toBe(0)
    const dir = dirOf(chat)
    mkdirSync(join(dir, 'sub'), { recursive: true })
    const other = put('OTHER/Agent', 'outside.png', 90 * DAY)
    symlinkSync(other, join(dir, 'link.png'))
    const freshSide = put(chat, 'nice.png.poster.jpg', DAY)
    const old = put(chat, 'gone.png', 90 * DAY)
    const staleSide = put(chat, 'gone.png.poster.jpg', DAY)

    expect(pruneInbox(chat, 7 * DAY, Date.now())).toBe(1)

    expect(existsSync(join(dir, 'sub'))).toBe(true)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(join(dir, 'link.png'))).toBe(true)
    expect(existsSync(freshSide)).toBe(true)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(staleSide)).toBe(false)
  })
})
