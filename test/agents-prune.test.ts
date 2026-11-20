// PERFS-12: agents.json kept every record ever made. These tests build a fixture home (never the operator's) to
// measure what the 3.6 MB is, prove a prune drops exactly the orphans in one write, and prove an archived task's chat
// still reads its history after the prune. They also bound the per-record session list.
import { describe, expect, spyOn, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('agents-prune')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
const store = await import('../server/store.ts')
const realWriteJson = store.writeJson
const { Agents, MAX_LOGS, uniqueLogs } = await import('../server/live/agents.ts')
const { Chats } = await import('../server/live/chats.ts')

const home = process.env.SHEPHERDR_HOME
const onDisk = (file: string) => JSON.parse(readFileSync(join(home, file), 'utf8'))
const bytes = (o: unknown) => Buffer.byteLength(JSON.stringify(o))
const logPath = (key: string, i: number) => `/logs/${key}/session-${i}-abcdef0123456789.jsonl`

/** a record of the shape the lead measured: the prompt and the session paths dominate the store */
const record = (key: string, logs: number) => ({
  key,
  name: key.includes('/') ? `shep-${key.split('/')[0].toLowerCase()}` : key,
  kind: 'pi',
  cwd: '/work/app',
  workspace: 'app',
  system: `You are the ${key} agent. `.repeat(30),
  env: { SHEPHERDR_CHAT: key },
  logs: Array.from({ length: logs }, (_, i) => logPath(key, i)),
  started: 1,
  finished: true,
})

/** 64 live agents, an archived task kept with its chat, three live coordinators — and the orphans that outlived them */
function fixture() {
  const records: Record<string, ReturnType<typeof record>> = {}
  const keep = new Set<string>()
  const held = (key: string, logs: number) => {
    records[key] = record(key, logs)
    keep.add(key)
  }
  const orphan = (key: string, logs: number) => {
    records[key] = record(key, logs)
  }
  for (let i = 1; i <= 64; i++) held(`T-${i}/Agent`, 3)
  held('T-ARCH/Agent', 3) // archived, still in the engine: its chat must keep reading
  held('T-ARCH/Reviewer', 2)
  for (const c of ['p:box:~', 'p:box:shepherdr', 'p:box:lyvora-app']) held(c, 6)
  // removing a space keeps its coordinator chat for a later add, so that record is kept too
  held('p:box:old-space', 5)
  // deleted tasks whose cleanup did not run, and old reviewer attempts. The counts give the same shape as the lead's
  // 3.6 MB home: a few dozen live agents, thousands of orphans.
  for (let i = 100; i < 2300; i++) orphan(`T-${i}/Agent`, i % 50 === 0 ? 200 : 4)
  for (let i = 100; i < 500; i++) orphan(`T-${i}/Reviewer`, 2)
  return { records, keep }
}

const put = (records: Record<string, ReturnType<typeof record>>) => {
  realWriteJson('agents.json', records)
  realWriteJson('outbox.json', [])
}

describe('agents.json keeps only the records a screen can reach', () => {
  test('a proof-home prune drops exactly the orphans and the file shrinks accordingly', () => {
    const { records, keep } = fixture()
    const before = bytes(records)
    put(records)
    const a = new Agents()
    try {
      const dropped = a.prune((key) => keep.has(key))
      expect(dropped).toBe(Object.keys(records).length - keep.size)
      expect(dropped).toBe(2600)
      expect(Object.keys(a.records).sort()).toEqual([...keep].sort())
      const after = bytes(a.records)
      expect(after).toBeLessThan(before / 8)
      expect(onDisk('agents.json')[Object.keys(a.records)[0]]).toBeDefined()
      console.log(
        `SHE-100 measure: fixture ${Object.keys(records).length} records, ${(before / 1024 / 1024).toFixed(2)} MB -> ${Object.keys(a.records).length} records, ${(after / 1024).toFixed(0)} KB; by field: system ${(Object.values(records).reduce((n, r) => n + bytes(r.system), 0) / 1024 / 1024).toFixed(2)} MB, logs ${(Object.values(records).reduce((n, r) => n + bytes(r.logs), 0) / 1024 / 1024).toFixed(2)} MB`,
      )
    } finally {
      a.stop()
    }
  })

  test('the whole pass is one batched agents.json write', () => {
    const { records, keep } = fixture()
    put(records)
    const spy = spyOn(store, 'writeJson').mockImplementation((...args: Parameters<typeof store.writeJson>) => realWriteJson(...args))
    try {
      const a = new Agents()
      expect(a.prune((key) => keep.has(key))).toBe(2600)
      expect(spy.mock.calls.filter((c: unknown[]) => c[0] === 'agents.json').length).toBe(1)
      expect(spy.mock.calls.filter((c: unknown[]) => c[0] === 'outbox.json').length).toBe(1)
      a.stop()
    } finally {
      spy.mockRestore()
    }
  })

  test("an archived task's chat still shows its history after the prune", () => {
    const key = 'T-ARCH/Agent'
    const dir = tmp('agents-prune-log')
    const log = join(dir, 'session-old.jsonl')
    writeFileSync(
      log,
      `${[
        JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-10-13T20:52:53.359Z', cwd: '/w' }),
        JSON.stringify({ type: 'message', id: 'm1', timestamp: '2026-10-13T20:52:54.359Z', message: { role: 'user', content: [{ type: 'text', text: 'What was the outcome?' }] } }),
        JSON.stringify({
          type: 'message',
          id: 'm2',
          timestamp: '2026-10-13T20:52:55.359Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'The archived outcome.' }], stopReason: 'stop' },
        }),
      ].join('\n')}\n`,
    )
    put({
      [key]: { ...record(key, 1), logs: [log] },
      'T-GONE/Agent': record('T-GONE/Agent', 2),
    })
    const a = new Agents()
    const chats = new Chats(
      a,
      (k) => k,
      () => 'You',
    )
    try {
      expect(a.prune((k) => k === key)).toBe(1)
      expect(a.record(key)?.logs).toEqual([log]) // its log paths survive: the chat reads them
      expect(a.record('T-GONE/Agent')).toBeUndefined()
      const messages = chats.chat(key).messages
      expect(messages.some((m) => m.text?.includes('The archived outcome.'))).toBe(true)
    } finally {
      a.stop()
    }
  })

  test('a dead task record leaves nothing behind in the outbox, failures or routes', () => {
    const key = 'T-GONE/Agent'
    const kept = 'T-KEEP/Agent'
    put({ [key]: record(key, 1), [kept]: record(kept, 1) })
    const a = new Agents()
    const private_ = a as unknown as {
      failures: { key: string; cid: string; error: string; at: number }[]
      byName: Map<string, string>
    }
    try {
      ;(a as unknown as { queue: (key: string, texts: string[]) => void }).queue(key, ['a last word'])
      private_.failures.push({ key, cid: 'c', error: 'no', at: 1 })
      a.prune((k) => k === kept)
      expect(a.outbox.some((o) => o.key === key)).toBe(false)
      expect(private_.failures.some((f) => f.key === key)).toBe(false)
      expect(private_.byName.has(record(key, 1).name)).toBe(false)
      expect(private_.byName.size).toBe(1) // the kept record's name stays
    } finally {
      a.stop()
    }
  })
})

describe('a record keeps at most the last few sessions', () => {
  test('uniqueLogs dedupes by session and drops the oldest past the cap', () => {
    const logs = Array.from({ length: MAX_LOGS + 8 }, (_, i) => logPath('T-1/Agent', i))
    expect(uniqueLogs([...logs, logs[2], logs[logs.length - 1]])).toEqual(logs.slice(-MAX_LOGS))
  })

  test('load caps a long log list, but leaves a short chat with all its history', () => {
    const long = record('T-LONG/Agent', MAX_LOGS + 10)
    const short = record('T-SHORT/Agent', 3)
    put({ [long.key]: long, [short.key]: short })
    const a = new Agents()
    try {
      expect(a.record(long.key)?.logs).toEqual(long.logs.slice(-MAX_LOGS))
      expect(a.record(short.key)?.logs).toEqual(short.logs) // every session of an open chat is kept
    } finally {
      a.stop()
    }
  })

  test('a new session learned while running is capped too', () => {
    const key = 'T-NEW/Agent'
    put({ [key]: record(key, MAX_LOGS) })
    const a = new Agents()
    try {
      const r = a.record(key)
      if (!r) throw new Error('the record to cap is missing')
      const newest = logPath(key, MAX_LOGS + 1)
      ;(a as unknown as { learnSession: (key: string, a: unknown) => void }).learnSession(key, { agent_session: { kind: 'path', value: newest } })
      expect(r.logs).toHaveLength(MAX_LOGS)
      expect(r.logs.at(-1)).toContain('session-33-') // the newest session came in, so the oldest went out
    } finally {
      a.stop()
    }
  })
})
