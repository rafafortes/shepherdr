// Antigravity CLI (agy) as an agent kind: its conversations live in its own store, one SQLite database per conversation
// (<agy home>/conversations/<id>.db) and a summaries database beside them. Shepherdr only reads that store (read only,
// nothing is written under it): the newest conversation of a folder is found in the summaries, and its final steps are
// copied into a JSONL file that the chat reads like any other CLI log. The steps' payloads are protobuf blobs with no
// schema, so this file also holds a small wire-format decoder (ported from the reference decoder of the study).
import { Database } from 'bun:sqlite'
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs'
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
  const ms = Date.parse(String(s ?? '').replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'))
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

/** the idx of a JSONL file's last line, read backwards from its end; undefined when it has no line */
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
        if (!last) return undefined
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
      return { ...base, kind: 'agent', text: text(field(p, '20.1')), model: genModel(gen, ids), tokensIn: typeof tin === 'number' ? tin : undefined, tokensOut: typeof tout === 'number' ? tout : undefined }
    }
    case 132:
      return { ...base, kind: 'tool', tool: text(field(p, '5.4.2')), args: text(field(p, '5.4.3')), output: text(field(p, '140.2.1')) }
    case 101:
      return { ...base, kind: 'notice', text: text(field(p, '114.4.4')) }
    default:
      return { ...base, kind: 'other' }
  }
}

/** the steps still running: a step with one of these statuses is not final, and the mirror stops before it */
const NOT_FINAL = new Set([0, 1, 2])

/** the generation rows of `count` model responses, from the one after the `from` responses before them: the k-th model
 *  response of the store has the k-th generation row */
function genRows(handle: Database, from: number, count: number): Uint8Array[] {
  return handle.query<{ data: Uint8Array }, [number, number]>('SELECT data FROM gen_metadata ORDER BY idx LIMIT ? OFFSET ?').all(count, from).map((r) => r.data)
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
 * idx order, stopping at the first step still running. Returns the number of lines appended; 0 and nothing created when
 * there is no database.
 */
export function mirrorConversation(id: string, outFile: string): number {
  const db = agyDb(id)
  if (!existsSync(db)) return 0
  const after = lastIdx(outFile) ?? -1
  const handle = new Database(db, { readonly: true })
  let lines: string[]
  try {
    const steps = handle
      .query<{ idx: number; step_type: number; status: number; step_payload: Uint8Array | null; error_details: Uint8Array | null }, [number]>(
        'SELECT idx, step_type, status, step_payload, error_details FROM steps WHERE idx > ? ORDER BY idx',
      )
      .all(after)
    const before = handle.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM steps WHERE step_type = 15 AND idx <= ?').get(after)?.n ?? 0
    const ids = agyIds()
    const final = steps.findIndex((s) => NOT_FINAL.has(s.status))
    const done = final === -1 ? steps : steps.slice(0, final)
    const gens = genRows(handle, before, done.filter((s) => s.step_type === 15).length)
    let k = 0
    lines = done.map((s) => JSON.stringify(lineOf(s, s.step_type === 15 ? gens[k++] : undefined, ids)))
  } finally {
    handle.close()
  }
  if (lines.length) {
    mkdirSync(dirname(outFile), { recursive: true })
    appendFileSync(outFile, lines.join('\n') + '\n')
  }
  return lines.length
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
