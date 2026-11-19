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
 * silently replacing hours of an agent's work with an empty state.
 *
 * Every other file here is a cache: agents.json (the agents and their chats), usage.json (the plan limits read from
 * their logs), outbox.json and returns.json (what waits to go in to an agent, and back), models, profiles, layout and
 * the rest — what herdr and the agents say, kept for speed, so one of them may start from the fallback and fill again.
 */
const RECORD = new Set(['tasks.json', 'spaces.json', 'settings.json', 'automations.json'])

/** the two caches whose whole content is hours of work too (the agents, the usage read from their logs): a write of
 *  nothing over one of them keeps the file first, as it does for a store of record. A small store that drains as it
 *  should (an empty outbox, no returns) is replaced as it always was. */
const KEEPS = new Set(['agents.json', 'usage.json'])

/** the copies kept beside one store for each kind: the newest, the rest removed, so a store that fails at every start
 *  cannot fill the disk with them */
export const COPIES = 3

/** what a copy of a store is: of a file that could not be read, or of the file a write is about to replace with
 *  nothing */
export type CopyKind = 'corrupt' | 'before-empty'

/** the name a copy of a store takes beside it: `<file>.<kind>-<ISO stamp>` */
export function copyName(file: string, kind: CopyKind): string {
  return `${file}.${kind}-${new Date().toISOString().replace(/:/g, '-')}`
}

/** only the newest COPIES of that kind stay beside a store once the new one is safely there: the other ones go, and an
 *  old copy that will not go is left rather than failed over */
export function pruneCopies(file: string, kind: CopyKind) {
  const dir = dirname(file)
  const head = `${basename(file)}.${kind}-`
  let found: string[] = []
  try {
    found = fs.readdirSync(dir).filter((n) => n.startsWith(head)).sort()
  } catch {
    /* the folder went with the store: nothing to go through */
  }
  for (const n of found.slice(0, Math.max(0, found.length - COPIES)))
    try {
      fs.rmSync(join(dir, n), { recursive: true, force: true })
    } catch {
      /* an old copy that will not go is not worth failing over */
    }
}

/** the stores whose file could not be read in this run: kept as they are on disk, written no more */
const frozen = new Set<string>()
/** the frozen stores whose writer has already said so once: a save() every second must not fill the log */
const told = new Set<string>()
/** the stores whose line has been said while its bytes could not be copied either: a look every second (server.json)
 *  must not fill the log */
const said = new Set<string>()
/** the copy last made for a store in this run, and the file it was of: two readers of one unreadable file (the places
 *  and their migration) make one copy and say one line between them */
const copied = new Map<string, { size: number; mtimeMs: number; to: string }>()

/** whether this run may write a store: false for a store of record whose file could not be read (writeJson says why
 *  once). What re-derives from a store of record asks this before trusting it. */
export const readOnly = (file: string) => frozen.has(file)

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
  // an empty file holds nothing worth keeping: a store that was never written, or one whose write was torn off whole.
  // It is not a store that could not be read, so it is neither copied nor kept from being written again.
  if (!text.trim()) return fallback
  try {
    return JSON.parse(text) as T
  } catch (e) {
    return unreadable(f, fallback, `is not JSON (${words(e)})`, Buffer.byteLength(text))
  }
}

/** a store that could not be read: its bytes are copied beside it before the caller's fallback is returned, and a store
 *  of record takes no write for the rest of the run, so the file keeps exactly what the copy holds until the person
 *  puts one back. One line says which file, its size and where its copy is (the newest COPIES of each are kept). */
function unreadable<T>(f: string, fallback: T, why: string, bytes?: number): T {
  const record = RECORD.has(basename(f))
  if (record) frozen.add(f)
  const known = copied.get(f)
  let copy = ''
  let failed = ''
  let made = false
  try {
    const st = fs.statSync(f)
    if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) copy = known.to
    else {
      const to = copyName(f, 'corrupt')
      fs.copyFileSync(f, to)
      copy = to
      copied.set(f, { size: st.size, mtimeMs: st.mtimeMs, to })
      pruneCopies(f, 'corrupt')
      made = true
    }
    bytes ??= st.size
  } catch (e) {
    failed = words(e)
  }
  // a copy of this same file made earlier in this run has said its line already, and so has one whose bytes could not
  // be copied at all: a file read again and again says it once
  if (made || (!copy && !said.has(f))) {
    if (!copy) said.add(f)
    console.error(
      `shepherdr: ${f} ${why} (${bytes === undefined ? 'size unknown' : `${bytes} bytes`}): ` +
        (copy ? `its bytes are kept in ${copy}, the newest ${COPIES} of each copy stay beside it; ` : `it could not be copied (${failed}); `) +
        (record ? 'running read-only for it in this run, every save to it dropped rather than written over it (restart once it is restored)' : 'starting from the fallback'),
    )
  }
  return fallback
}

/** secrets (keys, push subscriptions) are readable by you only */
const PRIVATE = new Set(['secrets.json', 'vapid.json', 'push.json'])

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** the keys of a store that say how it is kept, not what is kept: a store written empty holds its version and nothing else */
const FORMAT = new Set(['version'])

/** whether a value has nothing in it at any depth: an empty collection, or one whose entries are all like that (the
 *  empty state of tasks.json is `{ next: {}, tasks: [] }`, the usage ledger's is `{ version: 2, usage: {}, … }`). A
 *  number, a string or a flag under a key of its own is something. */
function nothingIn(v: unknown): boolean {
  if (Array.isArray(v)) return v.every(nothingIn)
  if (isObject(v)) return Object.entries(v).every(([k, x]) => FORMAT.has(k) || nothingIn(x))
  return false
}

/** nothing written over a file that has something in it: the file is copied to `.before-empty-<ts>` first, so a state
 *  that starts empty (a store nothing could read, or one whose load failed) never erases in one write what a crash
 *  left. A file with nothing in it, or one that already holds nothing, is written over as it always was. */
function beforeEmpty(f: string, value: unknown) {
  if (!(RECORD.has(basename(f)) || KEEPS.has(basename(f))) || !nothingIn(value) || !fs.existsSync(f)) return
  let text = ''
  try {
    text = fs.readFileSync(f, 'utf8')
  } catch {
    return // unreadable: readJson already copied it, and a file it cannot read it cannot copy either
  }
  if (!text.trim()) return
  try {
    if (nothingIn(JSON.parse(text))) return
  } catch {
    /* not JSON: it holds bytes worth keeping */
  }
  const copy = copyName(f, 'before-empty')
  try {
    fs.copyFileSync(f, copy)
    pruneCopies(f, 'before-empty')
  } catch (e) {
    console.error(`shepherdr: ${f} is being written empty and a copy of it could not be made (${words(e)}): what it held is lost`)
    return
  }
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
  } catch {
    /* a folder that refuses to be synced: the last write is what is at risk, not the run */
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
  told.delete(f)
  fs.mkdirSync(dirname(f), { recursive: true, mode: 0o700 })
  beforeEmpty(f, value)
  const tmp = `${f}.tmp`
  const data = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)
  const fd = fs.openSync(tmp, 'w', PRIVATE.has(name) ? 0o600 : 0o644)
  try {
    fs.writeFileSync(fd, data)
    if (RECORD.has(basename(f))) fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, f)
  if (RECORD.has(basename(f))) syncDir(dirname(f))
}
