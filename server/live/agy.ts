// Antigravity CLI (agy) as an agent kind: its conversations live in its own store, one SQLite database per conversation
// (<agy home>/conversations/<id>.db) and a summaries database beside them. Shepherdr only reads that store (read only,
// nothing is written under it): the newest conversation of a folder is found in the summaries, and its final steps are
// copied into a JSONL file that the chat reads like any other CLI log. The steps' payloads are protobuf blobs with no
// schema, so this file also holds a small wire-format decoder (ported from the reference decoder of the study).
import { Database } from 'bun:sqlite'
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { home, readJson, writeJson } from '../store.ts'
import { AGY_EFFORTS, agyBaseId, agyIds } from './models.ts'

const env = (k: string) => process.env[k] || undefined

/** a chunk of a file read backwards to find its last line */
const CHUNK = 64 << 10

/** the headless runs of Shepherdr itself kept out of the chat's finder (the last 200 of them) */
const HEADLESS_KEPT = 200

/** agy's store: SHEPHERDR_AGY_HOME says another (tests point it at a folder that does not exist) */
export const agyHome = () => env('SHEPHERDR_AGY_HOME') ?? join(homedir(), '.gemini', 'antigravity-cli')

/** one conversation's database */
export const agyDb = (id: string) => join(agyHome(), 'conversations', `${id}.db`)

/** the summaries database: one row per conversation */
export const agySummaries = () => join(agyHome(), 'conversation_summaries.db')

/** where a conversation's mirrored log is: <shepherdr home>/agy/<conversation id>.jsonl */
export const agyLogPath = (dir: string, id: string) => join(dir, 'agy', `${id}.jsonl`)

/* ---------- protobuf wire format (no schema) ---------- */

/** one field of a message: its number, its wire type and its value (a number for a varint, bytes otherwise) */
export interface Field {
  field: number
  wire: number
  value: number | Uint8Array
}

/** a varint at pos: its value and the position after it; undefined when it runs past the end or is too long */
function varint(buf: Uint8Array, pos: number): [number, number] | undefined {
  let value = 0
  let scale = 1
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) return undefined
    const b = buf[pos++]
    value += (b & 0x7f) * scale
    if (!(b & 0x80)) return [value, pos]
    scale *= 128
  }
  return undefined
}

/** the bytes of a length-delimited or fixed field at pos: its value and the position after it */
function bytesAt(buf: Uint8Array, pos: number, wire: number): [Uint8Array, number] | undefined {
  const size = wire === 1 ? 8 : wire === 5 ? 4 : undefined
  if (size !== undefined) return pos + size <= buf.length ? [buf.subarray(pos, pos + size), pos + size] : undefined
  const len = varint(buf, pos)
  if (!len || len[1] + len[0] > buf.length) return undefined
  return [buf.subarray(len[1], len[1] + len[0]), len[1] + len[0]]
}

/** a message's fields in order; undefined when the bytes are no message (a truncated field, an unknown wire type) */
export function fields(buf: Uint8Array): Field[] | undefined {
  const out: Field[] = []
  let pos = 0
  while (pos < buf.length) {
    const key = varint(buf, pos)
    if (!key || key[0] < 8) return undefined
    const [k, next] = key
    const field = Math.floor(k / 8)
    const wt = k % 8
    pos = next
    if (wt === 0) {
      const v = varint(buf, pos)
      if (!v) return undefined
      out.push({ field, wire: 0, value: v[0] })
      pos = v[1]
    } else if (wt === 1 || wt === 2 || wt === 5) {
      const got = bytesAt(buf, pos, wt)
      if (!got) return undefined
      out.push({ field, wire: wt, value: got[0] })
      pos = got[1]
    } else return undefined
  }
  return out
}

/** the value at a dotted field path (5.1.1 is field 1 of field 1 of field 5), the first one found; undefined when none */
export function field(buf: Uint8Array, path: string): number | Uint8Array | undefined {
  const [head, ...rest] = path.split('.').map(Number)
  for (const f of fields(buf) ?? []) {
    if (f.field !== head) continue
    if (rest.length === 0) return f.value
    if (f.wire === 2) {
      const v = field(f.value as Uint8Array, rest.join('.'))
      if (v !== undefined) return v
    }
  }
  return undefined
}

/** a value as text: printable UTF-8 bytes (at least 95% printable characters), else undefined */
export function text(v: unknown): string | undefined {
  if (!(v instanceof Uint8Array)) return undefined
  let s: string
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(v)
  } catch {
    return undefined
  }
  const chars = [...s]
  if (!chars.length) return undefined
  const good = chars.filter((c) => /[\n\r\t]/.test(c) || !/[\p{C}\p{Zl}\p{Zp}]/u.test(c)).length
  return good / chars.length > 0.95 ? s : undefined
}

/** a step's time in ms (field 5.1: seconds and nanoseconds, UTC); 0 when it has none */
export function stepTime(payload: Uint8Array): number {
  const s = field(payload, '5.1.1')
  const n = field(payload, '5.1.2')
  return typeof s === 'number' ? Math.round(s * 1000 + (typeof n === 'number' ? n / 1e6 : 0)) : 0
}

/* ---------- conversations ---------- */

/** the summaries' time as ms: '2026-11-13 19:55:57.91895555+00:00' (nanoseconds cut to ms); 0 when it is none */
export function summaryTime(s: unknown): number {
  const ms = Date.parse(
    String(s ?? '')
      .replace(' ', 'T')
      .replace(/(\.\d{3})\d+/, '$1'),
  )
  return Number.isNaN(ms) ? 0 : ms
}

/** the ids of Shepherdr's own headless runs (agy -p made for a probe or an advisor): never a chat's conversation */
function headlessIds(dir: string): Set<string> {
  const ids = readJson<unknown>(join('agy', 'headless.json'), [], dir)
  return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [])
}

/** the summaries' rows, read only; a database that is missing or unreadable is an error the caller catches */
function summaries(db: string): Record<string, unknown>[] {
  const handle = new Database(db, { readonly: true })
  try {
    return handle.query<Record<string, unknown>, []>('SELECT conversation_id, last_modified_time, workspace_uris, nesting_depth, killed FROM conversation_summaries').all()
  } finally {
    handle.close()
  }
}

/** whether a conversation's workspace list names the folder, in its plain or its URI-encoded form */
function inFolder(uris: unknown, cwd: string): boolean {
  let list: unknown
  try {
    list = JSON.parse(String(uris ?? '[]'))
  } catch {
    return false
  }
  const want = [`file://${cwd}`, `file://${encodeURI(cwd)}`]
  return Array.isArray(list) && list.some((u) => want.includes(String(u)))
}

/**
 * The newest top-level conversation of a folder (subagents' and killed ones left out), last changed at or after sinceMs.
 * Nothing when the summaries are missing or unreadable: the look goes on, never a throw.
 */
export function newestConversation(cwd: string, sinceMs = 0, dir = home()): string | undefined {
  const folder = cwd.trim().replace(/\/+$/, '') || '/'
  const db = agySummaries()
  if (!existsSync(db)) return undefined
  let rows: Record<string, unknown>[]
  try {
    rows = summaries(db)
  } catch {
    return undefined
  }
  const skip = headlessIds(dir)
  const hits = rows
    .filter((r) => Number(r.nesting_depth ?? 0) === 0 && !r.killed && !skip.has(String(r.conversation_id)) && inFolder(r.workspace_uris, folder))
    .map((r) => ({ id: String(r.conversation_id), at: summaryTime(r.last_modified_time) }))
    .filter((r) => r.at >= sinceMs)
  return hits.sort((a, b) => b.at - a.at)[0]?.id
}

/**
 * The session-only settings for agy's read-only roles (reviewer and advisor). `--mode plan` only prepends `/plan` to the
 * prompt: it is not a tool-level write block (official docs, antigravity.google/docs/cli/modes.md; checked live on
 * 2026-11-26, where a `write_file` call created a file under `--mode plan --dangerously-skip-permissions`). The bypass
 * is still needed for read-only commands whose permission check fails outside the sandbox (SHE-202:
 * `permission check failed for unsandboxed "git -C … status --short && …"`), so the prompts forbid changes and these
 * deny rules hold agy's own write and URL tools and MCP even with the bypass (Deny > Ask > Allow in agy's permission
 * engine, antigravity.google/docs/permissions.md). `write_file(.)` is scoped to the workspace: a global `write_file(*)`
 * also refused agy's own plan artifact (its brain folder outside the worktree), so the round ended with that refusal
 * instead of findings. A mutating shell command is still only held by the prompt — the same residual risk as a pi
 * reviewer, whose bash is allowed with changes forbidden by its prompt.
 *
 * One helper for the three launch sites (headless reviewer, reviewer pane, advisor) so they cannot drift.
 */
const READ_ONLY_DENY = ['write_file(.)', 'read_url(*)', 'execute_url(*)', 'download_url(*)', 'mcp(*)']

export function agyReviewSettings(o: { cwd?: string } = {}): string {
  return JSON.stringify({
    ...(o.cwd ? { trustedWorkspaces: [o.cwd] } : {}),
    permissions: { deny: READ_ONLY_DENY },
  })
}

/** the id agy takes for a model and its effort: the model with the effort appended when that id exists (gemini-3.8-flash
 *  and low: gemini-3.8-flash-low). With no effort given, the model's medium variant, else its lowest one; a full id as
 *  it is; a model with no variants as it is */
export function agyModelId(model: string, effort: string | undefined, ids: string[]): string {
  const base = agyBaseId(model)
  if (effort && ids.includes(`${base}-${effort}`)) return `${base}-${effort}`
  if (ids.includes(model)) return model
  const variants = AGY_EFFORTS.map((e) => `${base}-${e}`).filter((id) => ids.includes(id))
  return variants.find((id) => id.endsWith('-medium')) ?? variants[0] ?? model
}

/** the folder Shepherdr's headless runs of agy start in (their conversations land there, never in a chat's folder) */
export function agyHeadlessDir(dir = home()): string {
  const d = join(dir, 'agy', 'headless')
  mkdirSync(d, { recursive: true })
  return d
}

/** keeps a headless run's conversation out of the chat finder: its id joins headless.json (the last HEADLESS_KEPT) */
export function keepHeadless(id: string, dir = home()) {
  writeJson(join('agy', 'headless.json'), [...new Set([...headlessIds(dir), id])].slice(-HEADLESS_KEPT), dir)
}

/** what a headless run (`agy -p … --output-format json`) said: ok when it exited 0 and its answer is SUCCESS, else its
 *  error; its words are said when it ends well. An answer that is no JSON says so. The run's conversation is kept out */
export function headlessOutcome(out: string, code: number): { ok: boolean; said: string } {
  const j = parseLine(out.trim())
  if (!j) return { ok: false, said: `not an agy answer: ${out.replace(/\s+/g, ' ').trim().slice(0, 200)}` }
  if (typeof j.conversation_id === 'string') keepHeadless(j.conversation_id)
  if (j.status === 'SUCCESS') return { ok: code === 0, said: String(j.response ?? '') }
  return { ok: false, said: String(j.error ?? j.status ?? 'the run failed') }
}

/* ---------- mirror ---------- */

/** the mirror's format, its first line: a mirror without it, or of another number, was written by an older Shepherdr,
 *  which read some steps otherwise (a provider's cut-off, step 17, as nothing; a model response agy had not committed yet as
 *  an empty line), and is rebuilt once, whole (mirrorConversation). 3: a model response's line waits until agy has committed
 *  it, and its model and tokens come from the generation row that answers its step, not from where it falls among them */
export const MIRROR_HEAD = JSON.stringify({ mirror: 3 })

/** whether a mirror is of the current format: its first line is MIRROR_HEAD */
function current(file: string): boolean {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(MIRROR_HEAD.length + 1)
    const got = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, got).toString('utf8') === `${MIRROR_HEAD}\n`
  } finally {
    closeSync(fd)
  }
}

/** the idx of a JSONL file's last line, read backwards from its end; undefined when it has no line (or only its head) */
function lastIdx(file: string): number | undefined {
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
      const body = tail.toString('utf8').replace(/\n+$/, '')
      const nl = body.lastIndexOf('\n')
      if (nl !== -1 || start === 0) {
        const last = body.slice(nl + 1)
        if (!last || last === MIRROR_HEAD) return undefined
        const idx = Number(parseLine(last)?.idx)
        if (!Number.isInteger(idx)) throw new Error(`${file} ends in a line that is no mirrored step: ${last.slice(0, 200)}`)
        return idx
      }
    }
  } finally {
    closeSync(fd)
  }
}

/** a model's id from its label as the generation row keeps it: "Gemini 3.8 Flash (Low)" is gemini-3.8-flash-low when the
 *  models list has that id, else the label itself */
function modelOf(label: string, ids: string[]): string {
  const id = label.toLowerCase().replace(/[()]/g, '').split(/\s+/).join('-')
  return ids.includes(id) ? id : label
}

/** the model a generation row names: its id where it has one, else its label as the models list knows it */
function genModel(gen: Uint8Array | undefined, ids: string[]): string | undefined {
  if (!gen) return undefined
  const id = text(field(gen, '3.28'))
  if (id) return id
  const label = text(field(gen, '1.21'))
  return label ? modelOf(label, ids) : undefined
}

/** the error of a step: its readable strings, joined; a step with none of them still says it failed */
function errorText(err: Uint8Array): string {
  const parts = (fields(err) ?? []).map((f) => text(f.value)).filter((s): s is string => !!s)
  return parts.join(' | ') || 'the step failed'
}

export interface AgyLine {
  idx: number
  /** the step's time, ms (0 when it has none) */
  at: number
  kind: 'user' | 'agent' | 'tool' | 'notice' | 'error' | 'other'
  text?: string
  tool?: string
  args?: string
  output?: string
  model?: string
  tokensIn?: number
  tokensOut?: number
  /** a provider's HTTP status for an error (429 for a quota), where the step has one */
  status?: number
}

/** a provider's error step (type 17): its full text, else its short one, and its HTTP status where it has one */
function providerErrorOf(p: Uint8Array): { text: string; status?: number } {
  const status = field(p, '24.3.7')
  return { text: text(field(p, '24.3.2')) ?? text(field(p, '24.3.1')) ?? 'the step failed', ...(typeof status === 'number' ? { status } : {}) }
}

/** a step's mirror line: what the chat reads of it (see AgyLine); gen is the generation row of a model response */
function lineOf(s: { idx: number; step_type: number; step_payload: Uint8Array | null; error_details: Uint8Array | null }, gen: Uint8Array | undefined, ids: string[]): AgyLine {
  const p = s.step_payload ?? new Uint8Array(0)
  const base = { idx: s.idx, at: stepTime(p) }
  if (s.error_details?.length) return { ...base, kind: 'error', text: errorText(s.error_details) }
  switch (s.step_type) {
    case 14:
      return { ...base, kind: 'user', text: text(field(p, '19.2')) }
    case 15: {
      const tin = field(p, '5.9.2') ?? (gen ? field(gen, '1.4.2') : undefined)
      const tout = field(p, '5.9.3') ?? (gen ? field(gen, '1.4.3') : undefined)
      return {
        ...base,
        kind: 'agent',
        text: text(field(p, '20.1')),
        model: genModel(gen, ids),
        tokensIn: typeof tin === 'number' ? tin : undefined,
        tokensOut: typeof tout === 'number' ? tout : undefined,
      }
    }
    case 132:
      return { ...base, kind: 'tool', tool: text(field(p, '5.4.2')), args: text(field(p, '5.4.3')), output: text(field(p, '140.2.1')) }
    case 101:
      return { ...base, kind: 'notice', text: text(field(p, '114.4.4')) }
    case 17:
      return { ...base, kind: 'error', ...providerErrorOf(p) }
    default:
      return { ...base, kind: 'other' }
  }
}

/** the steps still running: a step with one of these statuses is not final, and the mirror stops before it */
const NOT_FINAL = new Set([0, 1, 2])

const EMPTY = new Uint8Array(0)

/** how long a step may run with steps after it before the mirror copies it as it stands: agy runs tool calls side by side, so
 *  one can still run while a later step's row is there, and the longest a real one has taken is 15 minutes; a call agy never
 *  came back from keeps its status at 2 for good, and waiting for it would hide the rest of the conversation */
const STEP_WAIT_MS = 30 * 60_000

/** one row of the steps table, as the mirror reads it */
interface Step {
  idx: number
  step_type: number
  status: number
  step_payload: Uint8Array | null
  error_details: Uint8Array | null
}

/**
 * A model response agy has not finished writing: it carries no output tokens yet (5.9.3). The store writes a model
 * response's row before its payload and fills the payload in as it goes — the time, then the reply's words, and the usage
 * with the last write — so a response that has words and no usage is still growing (no response in a real store has words
 * without its usage), and the usage is the mark of a response agy is done with.
 */
function pending(p: Uint8Array): boolean {
  return field(p, '5.9.3') === undefined
}

/** how well a generation row fits a conversation: its own (a cascade_id of this conversation's), one of an older store (no
 *  cascade_id at all), or another conversation's (a subagent's rows sit in the same table), which is never used */
function genRank(cascade: string | undefined, id: string): number {
  if (cascade === undefined) return 1
  return cascade === id ? 2 : 0
}

/** a generation row's own metadata: the step it answers and the conversation it belongs to (named pairs of the row: the
 *  last_step_index it was made after, and its cascade_id) */
function genMeta(data: Uint8Array): { prev?: number; cascade?: string } {
  let prev: number | undefined
  let cascade: string | undefined
  for (const f of fields(data) ?? []) {
    if (f.field !== 1 || f.wire !== 2) continue
    for (const e of fields(f.value as Uint8Array) ?? []) {
      if (e.field !== 20 || e.wire !== 2) continue
      const kv = fields(e.value as Uint8Array) ?? []
      const key = text(kv.find((x) => x.field === 1)?.value)
      if (key !== 'last_step_index' && key !== 'cascade_id') continue
      const value = text(kv.find((x) => x.field === 2)?.value)
      if (value === undefined) continue
      if (key === 'last_step_index') {
        const n = Number(value)
        if (Number.isInteger(n)) prev = n
      } else cascade = value
    }
  }
  return { prev, cascade }
}

/**
 * The generation row that answers each of these model responses: a row names the step before its response in its own
 * metadata (last_step_index), so a row is found by that name, never by its place among the rows — a subagent's rows sit in
 * the same table, and an extra or missing one shifts every count after it. Rows are read from the newest back, so a
 * conversation with many of them reads only the few it needs.
 */
function gensFor(handle: Database, id: string, prevs: Set<number>): Map<number, Uint8Array> {
  const found = new Map<number, { rank: number; data: Uint8Array }>()
  let before = Number.MAX_SAFE_INTEGER
  while (found.size < prevs.size) {
    const rows = handle.query<{ idx: number; data: Uint8Array }, [number]>('SELECT idx, data FROM gen_metadata WHERE idx < ? ORDER BY idx DESC LIMIT 32').all(before)
    if (!rows.length) break
    for (const row of rows) {
      before = row.idx
      const meta = genMeta(row.data)
      if (meta.prev === undefined || !prevs.has(meta.prev)) continue
      const rank = genRank(meta.cascade, id)
      const had = found.get(meta.prev)
      if (!rank || (had && had.rank >= rank)) continue
      found.set(meta.prev, { rank, data: row.data })
    }
  }
  return new Map([...found].map(([prev, g]) => [prev, g.data]))
}

/** a JSON line's object, or undefined when it is not one */
function parseLine(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * Copies the conversation's final steps that outFile does not have yet (idx above its last line's) as JSONL lines, in
 * idx order, after the format's head (MIRROR_HEAD) in a new file. A step agy is still writing is not copied at all: the
 * copy stops before it (a step still running, or a model response whose payload it has not committed yet), so every line is
 * written once, whole, and comes in a later pass. A mirror of an older format, or one holding a line agy has filled in since
 * it was copied, is written again whole, as a new file that replaces it (the chat then reads it from its start). Returns the
 * number of step lines written; 0 and nothing created when there is no database.
 */
export function mirrorConversation(id: string, outFile: string): number {
  const db = agyDb(id)
  if (!existsSync(db)) return 0
  // called for every chat on every pass: a conversation whose database and mirror are as the last pass left them has
  // nothing new, and is not opened
  const began = Date.now()
  const seen = stamps(db, outFile)
  if (unchanged.get(outFile) === seen.sig) {
    mirrorCount.unchanged++
    return 0
  }
  mirrorCount.opened++
  const n = mirrorAgy(id, outFile, db)
  // trusted only when the database was quiet before this pass read it (a write in the same clock tick as the one the stamp
  // shows would leave it as it was), and never while a step was held back: that one is looked at again whatever the store does
  const after = stamps(db, outFile)
  if (!behind.has(outFile) && after.newest < began - 25) unchanged.set(outFile, after.sig)
  else unchanged.delete(outFile)
  return n
}

/** what a mirror last found for a log file: the stamps of its database, that database's WAL and the log */
const unchanged = new Map<string, string>()

/** the mirrors that stopped before a step agy may still write: their store is read again on every pass, quiet or not */
const behind = new Set<string>()

/** how many mirrors opened the conversation's database and how many found nothing changed and did not (what a test reads) */
export const mirrorCount = { opened: 0, unchanged: 0 }

/** the size and modification time of a conversation's database, its WAL and its mirror, and the newest of those times */
function stamps(db: string, out: string): { sig: string; newest: number } {
  let newest = 0
  const of = (f: string) => {
    try {
      const st = statSync(f)
      newest = Math.max(newest, f === out ? 0 : st.mtimeMs)
      return `${st.size}:${st.mtimeMs}:${st.ino}`
    } catch {
      return '-'
    }
  }
  return { sig: [db, `${db}-wal`, out].map(of).join('|'), newest }
}

function mirrorAgy(id: string, outFile: string, db: string): number {
  const whole = !existsSync(outFile) || !current(outFile)
  const after = whole ? -1 : (lastIdx(outFile) ?? -1)
  const handle = new Database(db, { readonly: true })
  let lines: string[]
  try {
    const steps = handle.query<Step, [number]>('SELECT idx, step_type, status, step_payload, error_details FROM steps WHERE idx > ? ORDER BY idx').all(after)
    const now = Date.now()
    const final = steps.findIndex((s, i) => unsettled(s, i === steps.length - 1, now))
    // a step held back is looked at again on the next pass, however quiet the store is: it may come back after this one
    if (final === -1) behind.delete(outFile)
    else behind.add(outFile)
    const done = final === -1 ? steps : steps.slice(0, final)
    const gens = gensFor(handle, id, new Set(done.filter((s) => s.step_type === 15).map((s) => s.idx - 1)))
    const ids = agyIds()
    lines = done.map((s) => JSON.stringify(lineOf(s, s.step_type === 15 ? gens.get(s.idx - 1) : undefined, ids)))
  } finally {
    handle.close()
  }
  mkdirSync(dirname(outFile), { recursive: true })
  if (whole) {
    // whole, under a name of its own, then in place of the old one: a reader never sees half of it
    const tmp = `${outFile}.tmp`
    writeFileSync(tmp, [MIRROR_HEAD, ...lines].join('\n') + '\n')
    renameSync(tmp, outFile)
  } else if (lines.length) appendFileSync(outFile, lines.join('\n') + '\n')
  return lines.length
}

/**
 * Whether agy is still writing this step. A step that runs is waited for while it is the conversation's last step, or while it
 * began less than STEP_WAIT_MS ago (agy runs tool calls side by side, so a later step can be there while this one still runs;
 * one agy never came back from is copied as it stands once it is old). A step whose end time is in its payload is over,
 * whatever its status says. The conversation's last step also waits while it is a model response without its usage yet: an
 * empty response an abandoned run left stays uncopied, which costs the chat nothing, and the conversation goes on the moment
 * a step follows it.
 */
function unsettled(s: Step, last: boolean, now: number): boolean {
  const p = s.step_payload ?? EMPTY
  if (NOT_FINAL.has(s.status)) return field(p, '5.8') === undefined && (last || now - stepTime(p) < STEP_WAIT_MS)
  return last && s.step_type === 15 && !s.error_details?.length && pending(p)
}

/** the newest conversation of a folder for this CLI: its mirror's path, or nothing; a failure is never thrown */
export function conversationLog(cwd: string, sinceMs?: number, dir = home()): string | undefined {
  const id = newestConversation(cwd, sinceMs, dir)
  if (!id) return undefined
  const file = agyLogPath(dir, id)
  try {
    mirrorConversation(id, file)
  } catch {}
  return file
}
