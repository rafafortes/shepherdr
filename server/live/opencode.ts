// OpenCode as an agent kind: its local API (`opencode api --standalone <operationId>`: a private server for each call,
// not OpenCode's background service; it prints {"data": ...}), its SQLite database (read only, to copy a session's final rows into a JSONL file that the
// chat reads like any other CLI log), and the model list. Commands run with an argv array, never through a shell.
import { Database, type Statement } from 'bun:sqlite'
import { appendFileSync, existsSync, fstatSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ownShellRules } from './readers/own-commands.ts'

const API_TIMEOUT = 60_000
/** a chunk of a file read backwards to find its last line */
const CHUNK = 64 << 10

const env = (k: string) => process.env[k] || undefined

/** the OpenCode binary: SHEPHERDR_OPENCODE_BIN says another (tests point it at a fake script) */
const opencodeBin = () => env('SHEPHERDR_OPENCODE_BIN') ?? 'opencode'

/** OpenCode's config folder (opencode.json, opencode.jsonc) */
export const opencodeConfigDir = () => join(env('XDG_CONFIG_HOME') ?? join(homedir(), '.config'), 'opencode')

/** OpenCode's data folder (its database, its logins in auth.json) */
export const opencodeDataDir = () => join(env('XDG_DATA_HOME') ?? join(homedir(), '.local', 'share'), 'opencode')

/** OpenCode's database: SHEPHERDR_OPENCODE_DB says another (tests point it at a fixture) */
export function opencodeDb(): string {
  return env('SHEPHERDR_OPENCODE_DB') ?? join(opencodeDataDir(), 'opencode.db')
}

/** a model id's provider: the part before its first slash */
const providerOf = (id: string) => id.slice(0, id.indexOf('/'))

/** a Shepherdr model id, providerID/modelID, split at the first '/': nvidia/z-ai/glm-5.3-flash is nvidia + z-ai/glm-5.3-flash */
export function parseModel(id: string): { providerID: string; id: string } {
  const m = /^([^/]+)\/(.+)$/.exec(id)
  if (!m) throw new Error(`not an OpenCode model id (providerID/modelID): ${id}`)
  return { providerID: m[1], id: m[2] }
}

/** runs `opencode api <args>` in cwd and returns the data of its JSON answer; undefined when it exits 0 with no output */
export async function api(args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? API_TIMEOUT
  const name = `opencode api ${args[0]}`
  let p: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    p = Bun.spawn([opencodeBin(), 'api', '--standalone', ...args], { cwd: opts.cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  } catch (e) {
    throw new Error(`${name} could not start: ${(e as Error).message}`)
  }
  const done = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).then(([out, err, code]) => ({ out, err, code }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const cut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const r = await Promise.race([done, cut]).finally(() => clearTimeout(timer))
  if (r === 'timeout') {
    p.kill(9)
    // the pipes close with the process, unless a child of it still holds them: the stderr it has is enough
    const late = await Promise.race([done, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_000))])
    throw new Error(`${name} did not answer in ${timeoutMs / 1000} s${late?.err.trim() ? `: ${late.err.trim()}` : ''}`)
  }
  if (r.code !== 0) throw new Error(`${name} exited with ${r.code}: ${r.err.trim() || r.out.trim()}`)
  // some operations (session.switchModel, the instructions entry put, session.remove) succeed with no body at all
  if (r.out.trim() === '') return undefined
  let body: any
  try {
    body = JSON.parse(r.out)
  } catch {
    throw new Error(`${name} printed no JSON: ${(r.err.trim() || r.out.trim()).slice(0, 500)}`)
  }
  return body?.data
}

/** the permissions a session asks about before it edits, runs a shell, fetches or goes outside its folder */
const ASK = ['edit', 'shell', 'webfetch', 'external_directory', 'subagent'].map((action) => ({ action, resource: '*', effect: 'ask' }))

/** a new session in cwd, with OpenCode's own id (never ours: its free models refuse a session with a custom id) */
export async function createSession(o: { cwd: string; title: string; model?: string; effort?: string; ask?: boolean; command?: string; chat?: string }): Promise<string> {
  const body: Record<string, unknown> = { title: o.title, location: { directory: o.cwd } }
  if (o.model) body.model = { ...parseModel(o.model), ...(o.effort ? { variant: o.effort } : {}) }
  // The allow rules come after the broad ask rules: OpenCode uses the last match. Without a command and chat (an older
  // call) the session only asks, as it always did; a full-access session has no rules at all.
  if (o.ask) body.permissions = [...ASK, ...(o.command && o.chat ? ownShellRules(o.command, o.chat) : [])]
  const data = await api(['session.create', '--data', JSON.stringify(body)], { cwd: o.cwd })
  const id = data?.id
  if (typeof id !== 'string' || !id.startsWith('ses')) throw new Error(`opencode session.create gave no session id: ${JSON.stringify(data)?.slice(0, 200)}`)
  return id
}

/** the session's instructions (its system prompt): one entry under the key shepherdr, replaced when put again */
export async function putInstructions(sessionId: string, text: string, cwd: string): Promise<void> {
  await api(['experimental.session.instructions.entry.put', '--param', `sessionID=${sessionId}`, '--param', 'key=shepherdr', '--data', JSON.stringify({ value: text })], { cwd })
}

/** the session's model and effort (its variant) from now on */
export async function switchModel(sessionId: string, model: string, effort: string | undefined, cwd: string): Promise<void> {
  const m = { ...parseModel(model), ...(effort ? { variant: effort } : {}) }
  await api(['session.switchModel', '--param', `sessionID=${sessionId}`, '--data', JSON.stringify({ model: m })], { cwd })
}

export interface OpencodeModel {
  /** providerID/modelID, as Shepherdr keeps it and `opencode run -m` takes it */
  id: string
  /** what the screen says: the same id (pi names its models with their provider in front too) */
  label: string
  /** the variants OpenCode offers, as efforts (may be empty, or not ordinal) */
  efforts: string[]
}

/** the models OpenCode has enabled, grouped by provider (a stable sort: each provider keeps OpenCode's order) */
export async function listModels(cwd: string = tmpdir()): Promise<OpencodeModel[]> {
  const data = await api(['model.list'], { cwd })
  if (!Array.isArray(data)) throw new Error('opencode model.list gave no model list')
  return data
    .filter((m) => m?.enabled !== false && typeof m?.providerID === 'string' && typeof m?.id === 'string')
    .map((m) => ({
      id: `${m.providerID}/${m.id}`,
      label: `${m.providerID}/${m.id}`,
      efforts: Array.isArray(m.variants) ? m.variants.map((v: { id: string }) => v.id) : [],
    }))
    .map((m, i) => ({ m, i, provider: providerOf(m.id) }))
    .sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.i - b.i))
    .map(({ m }) => m)
}

/** OpenCode's default model (its config's, or its first it finds), as providerID/modelID; nothing when it has none */
export async function defaultModel(cwd: string = tmpdir()): Promise<string | undefined> {
  const m = await api(['model.default'], { cwd }).catch(() => undefined)
  return typeof m?.providerID === 'string' && typeof m?.id === 'string' ? `${m.providerID}/${m.id}` : undefined
}

/** the last line's seq of a JSONL file, read backwards from its end; undefined when it has no line */
function lastSeq(file: string): number | undefined {
  if (!existsSync(file)) return undefined
  const fd = openSync(file, 'r')
  try {
    let end = fstatSync(fd).size
    let tail = Buffer.alloc(0)
    for (;;) {
      const start = Math.max(0, end - CHUNK)
      const buf = Buffer.alloc(end - start)
      readSync(fd, buf, 0, buf.length, start)
      tail = Buffer.concat([buf, tail])
      end = start
      let stop = tail.length
      while (stop > 0 && tail[stop - 1] === 10) stop--
      const nl = stop > 0 ? tail.lastIndexOf(10, stop - 1) : -1
      if (nl !== -1 || start === 0) {
        const text = tail.subarray(nl + 1, stop).toString('utf8')
        if (!text) return undefined
        try {
          return Number(JSON.parse(text).seq)
        } catch {
          throw new Error(`${file} ends in a line that is not JSON: ${text.slice(0, 200)}`)
        }
      }
    }
  } finally {
    closeSync(fd)
  }
}

/** OpenCode's database, kept open read only: opening it (and preparing a query on it) costs far more than a lookup, and
 *  a mirror runs for every chat on every pass. One handle per file; a file replaced (a new inode) gets a new one */
interface Open {
  db: Database
  ino: number
  version: Statement<{ data_version: number }, []>
  /** prepared on first use: an old database without time_busy has no such query, and must not break the mirror */
  subagent?: Statement<{ id: string }, [string]>
}
const opened = new Map<string, Open>()

function handleOf(file: string): Open {
  const ino = statSync(file).ino
  const had = opened.get(file)
  if (had?.ino === ino) return had
  had?.db.close()
  const db = new Database(file, { readonly: true })
  const o: Open = { db, ino, version: db.query<{ data_version: number }, []>('PRAGMA data_version') }
  opened.set(file, o)
  return o
}

/** closes the databases kept open (a test that removes its fixture, a stop) */
export function closeOpencodeDbs() {
  for (const o of opened.values()) o.db.close()
  opened.clear()
}

/** the child sessions of `parent_id` that are busy now: time_busy is when it started, time_idle when it stopped, and a
 *  busy child with no idle (not archived) is a subagent that will report back and wake its parent (OpenCode 2.3) */
const SUBAGENT_SQL = 'SELECT id FROM session_v2 WHERE parent_id = ? AND time_busy IS NOT NULL AND time_idle IS NULL AND time_archived IS NULL LIMIT 1'

/**
 * Is a subagent of this OpenCode session still running? Read from the same read-only handle the mirror uses, so a pass
 * that asks every idle agent costs one stat and one indexed lookup. `undefined` means the database cannot tell (no file,
 * an OpenCode old enough not to write time_busy/time_idle, or any read error): the caller can fall back to the footer.
 */
export function opencodeSubagentRunning(sessionId: string, db: string = opencodeDb()): boolean | undefined {
  if (!existsSync(db)) return undefined
  try {
    const o = handleOf(db)
    o.subagent ??= o.db.query<{ id: string }, [string]>(SUBAGENT_SQL)
    return !!o.subagent.get(sessionId)
  } catch {
    return undefined
  }
}

/** what a mirror last did for one log file: where it left off (the seq of its last line, the size and inode that file
 *  had then) and what the database said then (its inode and data_version: it changes when another connection commits).
 *  Nothing has changed since when all of them are as they were, so there is nothing to ask */
interface Mirrored {
  seq: number | undefined
  size: number
  ino: number
  db: number
  version: number
}
const mirrored = new Map<string, Mirrored>()

/** how many mirrors asked the database and how many found nothing changed and asked nothing (what a test reads) */
export const mirrorCount = { asked: 0, unchanged: 0 }

/**
 * Copies the session's final rows that outFile does not have yet (seq above its last line's) as JSONL lines, in seq
 * order. A row is final unless it is an assistant row still streaming (no time.completed): the copy stops there, so
 * lines never change once written. Returns the number of lines appended; 0 and nothing created when there is no db.
 * Called for every chat on every pass, so a pass that finds nothing new is a stat and a pragma: the database stays open,
 * and the log's last seq is remembered while the log is as this mirror left it.
 */
export function mirrorSession(sessionId: string, outFile: string, db: string = opencodeDb()): number {
  if (!existsSync(db)) return 0
  const o = handleOf(db)
  const version = o.version.get()!.data_version
  const out = statOf(outFile)
  const was = mirrored.get(outFile)
  const mine = was && out && was.size === out.size && was.ino === out.ino ? was : undefined
  if (mine && mine.db === o.ino && mine.version === version) {
    mirrorCount.unchanged++
    return 0
  }
  mirrorCount.asked++
  const after = (mine ? mine.seq : lastSeq(outFile)) ?? -1
  const rows = readRows(o.db, sessionId, after)
  const lines: string[] = []
  let seq = after < 0 ? undefined : after
  for (const row of rows) {
    const data = JSON.parse(row.data)
    if (row.type === 'assistant' && !data?.time?.completed) break
    lines.push(JSON.stringify({ id: row.id, type: row.type, seq: row.seq, time: row.time_created, data }))
    seq = row.seq
  }
  if (lines.length) {
    mkdirSync(dirname(outFile), { recursive: true })
    appendFileSync(outFile, lines.join('\n') + '\n')
  }
  const now = statOf(outFile)
  if (now) mirrored.set(outFile, { seq, size: now.size, ino: now.ino, db: o.ino, version })
  else mirrored.delete(outFile)
  return lines.length
}

const statOf = (f: string) => {
  try {
    const st = statSync(f)
    return { size: st.size, ino: st.ino }
  } catch {
    return undefined
  }
}

interface Row {
  id: string
  type: string
  seq: number
  time_created: number
  data: string
}

/** the session's rows after seq `after`, in seq order */
function readRows(handle: Database, sessionId: string, after: number): Row[] {
  return handle.query<Row, [string, number]>('SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq').all(sessionId, after)
}

/**
 * The newest top-level session of a folder (subagents' sessions and archived ones left out), last changed at or after
 * sinceMs when given. Nothing when there is no database or no such session.
 */
export function newestSession(cwd: string, sinceMs?: number, db: string = opencodeDb()): string | undefined {
  if (!existsSync(db)) return undefined
  const handle = new Database(db, { readonly: true })
  const since = sinceMs ?? null
  try {
    return handle
      .query<{ id: string }, [string, number | null, number | null]>(
        'SELECT id FROM session_v2 WHERE directory = ? AND parent_id IS NULL AND time_archived IS NULL AND (? IS NULL OR time_updated >= ?) ORDER BY time_updated DESC LIMIT 1',
      )
      .get(cwd, since, since)?.id
  } finally {
    handle.close()
  }
}

/** where a session's mirrored log is: <shepherdr home>/opencode/<session id>.jsonl */
export const opencodeLogPath = (home: string, sessionId: string) => join(home, 'opencode', `${sessionId}.jsonl`)
