// Fixtures for agy's store, built by the tests themselves (never the real ~/.gemini): a protobuf encoder that takes
// dotted field paths ({'19.2': 'hi'} is field 2 of field 19), a conversation database with the steps and generation
// rows the mirror reads, and the summaries database the finder reads.
import { Database } from 'bun:sqlite'

type Node = Map<number, Node | Leaf>
export type Leaf = string | number | Uint8Array

/** a varint's bytes, appended to out */
function varint(n: number, out: number[]) {
  let v = n
  while (v >= 128) {
    out.push((v % 128) | 128)
    v = Math.floor(v / 128)
  }
  out.push(v)
}

/** sets a leaf at a path of field numbers, making the messages on the way */
function put(node: Node, path: number[], v: Leaf) {
  const [head, ...rest] = path
  if (!rest.length) return void node.set(head, v)
  let child = node.get(head)
  if (!(child instanceof Map)) {
    child = new Map() as Node
    node.set(head, child)
  }
  put(child, rest, v)
}

/** a message's bytes: numbers as varints, strings and bytes length-delimited, nested messages length-delimited */
function encode(node: Node, out: number[] = []): number[] {
  for (const [f, v] of node) {
    if (typeof v === 'number') {
      varint(f * 8, out)
      varint(v, out)
      continue
    }
    const body = v instanceof Map ? encode(v) : typeof v === 'string' ? [...new TextEncoder().encode(v)] : [...v]
    varint(f * 8 + 2, out)
    varint(body.length, out)
    out.push(...body)
  }
  return out
}

/** a protobuf message from dotted field paths: { '5.1.1': 1700000000, '19.2': 'hello' } */
export function pb(paths: Record<string, Leaf>): Uint8Array {
  const root: Node = new Map()
  for (const [p, v] of Object.entries(paths)) put(root, p.split('.').map(Number), v)
  return Uint8Array.from(encode(root))
}

/** a step's time as its payload says it (seconds, nanoseconds: field 5.1), UTC */
export const stepAt = (sec: number, nanos = 0) => ({ '5.1.1': sec, '5.1.2': nanos })

/** a user step's payload: the human's text */
export const userPayload = (text: string | undefined, sec = 1700000000) => pb({ ...stepAt(sec), ...(text === undefined ? {} : { '19.2': text }) })

/** a model response's payload: its reply text (absent on a tool decision) and its own usage */
export const agentPayload = (o: { text?: string; sec?: number; tokensIn?: number; tokensOut?: number }) =>
  pb({
    ...stepAt(o.sec ?? 1700000001),
    ...(o.text === undefined ? {} : { '20.1': o.text }),
    ...(o.tokensIn === undefined ? {} : { '5.9.2': o.tokensIn }),
    ...(o.tokensOut === undefined ? {} : { '5.9.3': o.tokensOut }),
  })

/** a tool call's payload: its name, its arguments as JSON, its output */
export const toolPayload = (o: { tool: string; args: string; output?: string; sec?: number }) =>
  pb({ ...stepAt(o.sec ?? 1700000002), '5.4.2': o.tool, '5.4.3': o.args, ...(o.output === undefined ? {} : { '140.2.1': o.output }) })

/** a system notice's payload */
export const noticePayload = (text: string, sec = 1700000003) => pb({ ...stepAt(sec), '114.4.4': text })

/** a generation row: its model label and id (where it keeps one) and its usage */
export const genRow = (o: { label?: string; id?: string; tokensIn?: number; tokensOut?: number }) =>
  pb({
    ...(o.label === undefined ? {} : { '1.21': o.label }),
    ...(o.id === undefined ? {} : { '3.28': o.id }),
    ...(o.tokensIn === undefined ? {} : { '1.4.2': o.tokensIn }),
    ...(o.tokensOut === undefined ? {} : { '1.4.3': o.tokensOut }),
  })

export interface StepRow {
  idx: number
  step_type: number
  status?: number
  payload?: Uint8Array
  error?: Uint8Array
}

/** a conversation database as agy keeps it: its steps and generation rows (the k-th model response has the k-th row) */
export function makeConversation(path: string, steps: StepRow[], gens: Uint8Array[] = []) {
  const d = new Database(path, { create: true })
  d.run('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, has_subtrajectory NUMERIC NOT NULL DEFAULT false, metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB, step_payload BLOB, step_format INTEGER NOT NULL DEFAULT 0)')
  d.run('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0)')
  const insert = d.prepare('INSERT INTO steps (idx, step_type, status, error_details, step_payload) VALUES (?, ?, ?, ?, ?)')
  for (const s of steps) insert.run(s.idx, s.step_type, s.status ?? 3, s.error ?? null, s.payload ?? null)
  gens.forEach((data, i) => d.run('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)', [i, data, data.length]))
  d.close()
}

export interface SummaryRow {
  id: string
  /** the workspace list as agy writes it (JSON); the default is the folder given */
  uris?: string | null
  last?: string | null
  depth?: number | null
  killed?: number
}

/** agy's summaries database with one row per conversation */
export function makeSummaries(path: string, rows: SummaryRow[]) {
  const d = new Database(path, { create: true })
  d.run('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT, workspace_uris TEXT, status TEXT, source INTEGER, parent_conversation_id TEXT, nesting_depth INTEGER, killed INTEGER)')
  const insert = d.prepare('INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, source, parent_conversation_id, nesting_depth, killed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (const r of rows) insert.run(r.id, 'title', 'preview', 1, r.last === undefined ? '2026-11-13 19:55:57.91895555+00:00' : r.last, r.uris === undefined ? '[]' : r.uris, 'CASCADE_RUN_STATUS_IDLE', 1, null, r.depth === undefined ? 0 : r.depth, r.killed ?? 0)
  d.close()
}
