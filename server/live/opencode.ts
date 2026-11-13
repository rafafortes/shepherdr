// OpenCode as an agent kind: its local API (`opencode api --standalone <operationId>`: a private server for each call,
// not OpenCode's background service; it prints {"data": ...}), its SQLite database (read only, to copy a session's final rows into a JSONL file that the
// chat reads like any other CLI log), and the model list. Commands run with an argv array, never through a shell.
import { Database } from 'bun:sqlite'
import { appendFileSync, existsSync, fstatSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const API_TIMEOUT = 60_000
/** a chunk of a file read backwards to find its last line */
const CHUNK = 64 << 10

const env = (k: string) => process.env[k] || undefined

/** the OpenCode binary: SHEPHERDR_OPENCODE_BIN says another (tests point it at a fake script) */
const opencodeBin = () => env('SHEPHERDR_OPENCODE_BIN') ?? 'opencode'

/** OpenCode's database: SHEPHERDR_OPENCODE_DB says another (tests point it at a fixture) */
export function opencodeDb(): string {
  return env('SHEPHERDR_OPENCODE_DB') ?? join(env('XDG_DATA_HOME') ?? join(homedir(), '.local', 'share'), 'opencode', 'opencode.db')
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
export async function createSession(o: { cwd: string; title: string; model?: string; effort?: string; ask?: boolean }): Promise<string> {
  const body: Record<string, unknown> = { title: o.title, location: { directory: o.cwd } }
  if (o.model) body.model = { ...parseModel(o.model), ...(o.effort ? { variant: o.effort } : {}) }
  if (o.ask) body.permissions = ASK
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

/**
 * Copies the session's final rows that outFile does not have yet (seq above its last line's) as JSONL lines, in seq
 * order. A row is final unless it is an assistant row still streaming (no time.completed): the copy stops there, so
 * lines never change once written. Returns the number of lines appended; 0 and nothing created when there is no db.
 */
export function mirrorSession(sessionId: string, outFile: string, db: string = opencodeDb()): number {
  if (!existsSync(db)) return 0
  const after = lastSeq(outFile) ?? -1
  const rows = readRows(db, sessionId, after)
  const lines: string[] = []
  for (const row of rows) {
    const data = JSON.parse(row.data)
    if (row.type === 'assistant' && !data?.time?.completed) break
    lines.push(JSON.stringify({ id: row.id, type: row.type, seq: row.seq, time: row.time_created, data }))
  }
  if (lines.length) {
    mkdirSync(dirname(outFile), { recursive: true })
    appendFileSync(outFile, lines.join('\n') + '\n')
  }
  return lines.length
}

interface Row {
  id: string
  type: string
  seq: number
  time_created: number
  data: string
}

/** the session's rows after seq `after`, in seq order; the database is opened read only and closed at once */
function readRows(db: string, sessionId: string, after: number): Row[] {
  const handle = new Database(db, { readonly: true })
  try {
    return handle
      .query<Row, [string, number]>('SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq')
      .all(sessionId, after)
  } finally {
    handle.close()
  }
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
