// Shepherdr's own small files: what herdr can't tell it (projects, modes, update cards, drafts, push devices).
// One folder, ~/.shepherdr unless SHEPHERDR_HOME says otherwise; each file is plain JSON, written whole.
import * as fs from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const HOME = process.env.SHEPHERDR_HOME || (process.env.NODE_ENV === 'test' ? testHome() : join(homedir(), '.shepherdr'))

/** where Shepherdr's own files are now. HOME is where it started and stays for what is set up once at start; whoever
 *  keeps files while it runs takes this once, when it is made, and passes it as `dir`: a test gives each of its tests a
 *  folder of its own that way, since a test that times out goes on running and must not reach into the next one's. */
export const home = () => process.env.SHEPHERDR_HOME || HOME

/** under bun test, never the real ~/.shepherdr (however the tests were started): an empty folder of their own, named
 *  after the run and the process that made it as every test folder is (test/tmp.ts), so a run that was killed leaves
 *  one the next one can tell is stale and take */
function testHome() {
  const run = process.env.SHEPHERDR_TEST_RUN || String(process.pid)
  const dir = fs.mkdtempSync(join(tmpdir(), `shep-test-home-${run}-${process.pid}-`))
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * The stores a person's work lives in, which nothing re-derives: the tasks with their briefs, status, reports and
 * places, the spaces, the settings, the automations. A file of theirs that cannot be read is never written over (see
 * readJson and writeJson): on such a start Shepherdr keeps its bytes and runs read-only for that one store, instead of
 * silently replacing hours of an agent's work with an empty state. Every other file here is a cache (what herdr and the
 * agents say, kept for speed), which may start empty and fill again.
 */
const RECORD = new Set(['tasks.json', 'spaces.json', 'settings.json', 'automations.json'])

/** the copies kept beside one store for each kind: the newest, the rest removed, so a store that fails at every start
 *  cannot fill the disk with them */
export const COPIES = 3

/** what a copy of a store is: of a file that could not be read, or of the file a write is about to replace with an
 *  empty one */
export type CopyKind = 'corrupt' | 'before-empty'

/** where a copy of a store goes, `<file>.<kind>-<ISO stamp>`: the older copies of that kind go first, so that the store
 *  has the newest COPIES of it beside it and no more. The caller copies (or moves) the bytes there. */
export function beside(file: string, kind: CopyKind): string {
  const dir = dirname(file)
  const head = `${basename(file)}.${kind}-`
  let older: string[] = []
  try {
    older = fs.readdirSync(dir).filter((n) => n.startsWith(head)).sort()
  } catch {
    /* the folder is gone: the copy itself reports that */
  }
  for (const n of older.slice(0, Math.max(0, older.length - (COPIES - 1))))
    try {
      fs.rmSync(join(dir, n), { force: true })
    } catch {
      /* an old copy that will not go is not worth failing over */
    }
  return `${file}.${kind}-${new Date().toISOString().replace(/:/g, '-')}`
}

/** the stores whose file could not be read in this run: kept as they are on disk, written no more */
const frozen = new Set<string>()
/** the frozen stores whose writer has already said so once: a save() every second must not fill the log */
const told = new Set<string>()

const words = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function readJson<T>(name: string, fallback: T, dir = home()): T {
  const f = join(dir, name)
  let text: string
  try {
    if (!fs.existsSync(f)) return fallback
    text = fs.readFileSync(f, 'utf8')
  } catch (e) {
    return unreadable(f, fallback, `cannot be read (${words(e)})`)
  }
  try {
    return JSON.parse(text) as T
  } catch (e) {
    return unreadable(f, fallback, `is not JSON (${words(e)})`)
  }
}

/** a store that could not be read: its bytes are copied beside it before the caller's fallback is returned, and a store
 *  of record takes no write for the rest of the run, so the file keeps exactly what the copy holds until the person
 *  puts one back. One line says which file, its size and where its copy is (the newest COPIES of each are kept). */
function unreadable<T>(f: string, fallback: T, why: string): T {
  const size = fs.statSync(f, { throwIfNoEntry: false })?.size ?? 0
  let copy = ''
  let failed = ''
  try {
    const to = beside(f, 'corrupt')
    fs.copyFileSync(f, to)
    copy = to
  } catch (e) {
    failed = words(e)
  }
  const record = RECORD.has(basename(f))
  if (record) frozen.add(f)
  console.error(
    `shepherdr: ${f} ${why} (${size} bytes): ` +
      (copy ? `its bytes are kept in ${copy}, the newest ${COPIES} of each copy stay beside it; ` : `it could not be copied (${failed}); `) +
      (record ? 'running read-only for it in this run so no save overwrites them (restart once it is restored)' : 'starting from the fallback'),
  )
  return fallback
}

/** secrets (keys, push subscriptions) are readable by you only */
const PRIVATE = new Set(['secrets.json', 'vapid.json', 'push.json'])

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** how many entries a value written as JSON has: an array's items, an object's keys, anything else none */
const entries = (v: unknown) => (Array.isArray(v) ? v.length : isObject(v) ? Object.keys(v).length : 0)

/** an empty array or object, and only that: a store written empty starts its next run from nothing, whatever was there */
const isEmptyCollection = (v: unknown) => (Array.isArray(v) || isObject(v)) && !entries(v)

/** an empty collection written over a file that has entries: the file is copied to `.before-empty-<ts>` first, so a state
 *  that starts empty (a store nothing could read, or one whose load failed) never erases in one write what a crash left.
 *  A file with nothing in it, or one that already holds an empty collection, is written over as it always was. */
function beforeEmpty(f: string, value: unknown) {
  if (!isEmptyCollection(value) || !fs.existsSync(f)) return
  let text = ''
  try {
    text = fs.readFileSync(f, 'utf8')
  } catch {
    return // unreadable: readJson already copied it, and a file it cannot read it cannot copy either
  }
  if (!text.trim()) return
  try {
    if (!entries(JSON.parse(text))) return
  } catch {
    /* not JSON: it holds bytes worth keeping */
  }
  const copy = beside(f, 'before-empty')
  fs.copyFileSync(f, copy)
  console.error(`shepherdr: ${f} is being written empty: its bytes are kept in ${copy}, the newest ${COPIES} of each copy stay beside it`)
}

/** a folder's own entry (the rename) made durable. Best effort: a filesystem without it costs the last write, not the run. */
function syncDir(dir: string) {
  try {
    const fd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch { // coverage-exempt: no filesystem this runs on refuses to sync a folder it just opened (ext4 here, APFS on a Mac)
  }
}

/** `compact` skips the indentation for a whole store rewritten often (agents.json): the bytes, and the time spent
 *  stringifying them on the event loop, are several times smaller; the JSON and its shape are unchanged.
 *  A store of record is fsynced before the rename (and its folder after): a rename without that can leave an empty file
 *  after a power loss. A cache is not, since the saves to them get rarer (REL-02) and a lost last write fills again. */
export function writeJson(name: string, value: unknown, dir = home(), compact = false) {
  const f = join(dir, name)
  if (frozen.has(f) && fs.existsSync(f)) {
    if (!told.has(f)) {
      told.add(f)
      console.error(`shepherdr: not writing ${f}: it could not be read in this run and keeps its bytes; restart Shepherdr once it is restored`)
    }
    return
  }
  frozen.delete(f)
  fs.mkdirSync(dirname(f), { recursive: true, mode: 0o700 })
  beforeEmpty(f, value)
  const tmp = `${f}.tmp`
  const fd = fs.openSync(tmp, 'w', PRIVATE.has(name) ? 0o600 : 0o644)
  try {
    fs.writeFileSync(fd, compact ? JSON.stringify(value) : JSON.stringify(value, null, 2))
    if (RECORD.has(basename(f))) fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, f)
  if (RECORD.has(basename(f))) syncDir(dirname(f))
}
