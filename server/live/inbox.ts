// A chat's own folder of attachments, and the retention that trims it when a task archives. The chat's key names the
// folder, never a path a chat line names: what a tile may read is gated separately (source.ts's inboxFile).
import { join } from 'node:path'
import { boxDir, existsSync, lstatSync, readdirSync, rmSync } from './mfs.ts'

/** a chat's own folder in the inbox: never "." or "..", so it can't lead out of it */
export function chatDir(chat: string) {
  return chat.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^\.+/, '_')
}

/** a chat's attachments folder on the machine that holds it */
export const inboxDir = (chat: string) => join(boxDir(), 'inbox', chatDir(chat))

/**
 * Remove a chat's attachments older than `keepMs` as of `now`, when its task archives and tasks.inboxKeep is on.
 * A picture's thumb and a video's still are made when a tile asks for them, long after the file, so they go with it
 * even when their own time is recent. Returns how many files went.
 */
export function pruneInbox(chat: string, keepMs: number, now: number) {
  const dir = inboxDir(chat)
  if (!existsSync(dir)) return 0
  const before = now - keepMs
  let removed = 0
  try {
    for (const name of readdirSync(dir)) {
      const at = join(dir, name)
      // a small copy is deleted with its own file below; one an earlier run left behind goes when that file goes
      if (/\.(thumb|poster)\.jpg$/.test(name)) continue
      const st = lstatSync(at)
      // a folder or a link is never followed: only a file the chat itself wrote is trimmed
      if (!st.isFile() || st.mtimeMs >= before) continue
      rmSync(at, { force: true })
      for (const small of ['.thumb.jpg', '.poster.jpg']) rmSync(`${at}${small}`, { force: true })
      removed++
    }
  } catch {
    // cleanup is best effort: a file that went between the listing and the stat, or a folder that was replaced while
    // archiving, must never leave the task half-archived. What is left here can go the next time one archives.
    return removed
  }
  return removed
}
