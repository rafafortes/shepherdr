// A renamed repo leaves a link at its old name: the space still remembers the link, but the CLI writes its log under
// the real path and herdr reports that real cwd. The chat must read that log, never the old folder, and say so calmly
// when it cannot read one at all. Covers discovery (Agents), the chat (Chats) and the doctor line.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.CLAUDE_CONFIG_DIR = tmp('symlink-claude')

const { Agents } = await import('../server/live/agents.ts')
const { Chats } = await import('../server/live/chats.ts')
const { claudeProjectDir, claudeLogPath } = await import('../server/live/readers/find.ts')
type AgentInfo = import('../server/live/herdr.ts').AgentInfo

const KEY = 'p:usuario-X570S-AORUS-ELITE-AX:polylog'
const NAME = 'shep-polylog'
const S = '52b0d94e-130f-4675-86e4-7d5d0c89c92e'
const OLD = '7c8f7a4b-0000-4000-8000-000000000000'

/** the link Shepherdr remembers and the folder the CLI really runs in */
function place(tag: string) {
  const real = join(tmp(`symlink-real-${tag}`), 'lyvora-app')
  const link = join(tmp(`symlink-link-${tag}`), 'polylog')
  mkdirSync(real, { recursive: true })
  symlinkSync(real, link)
  return { real, link }
}

/** a Claude Code transcript: one message of yours and the coordinator's reply */
function logLines(cwd: string) {
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: S, version: '2.1.283' }
  const user = { parentUuid: null, ...base, promptId: 'p-1', type: 'user', message: { role: 'user', content: 'Desligamos o reasoning?' }, uuid: 'u1', timestamp: '2026-11-18T17:47:00.000Z' }
  const agent = { parentUuid: 'u1', ...base, message: { model: 'claude-opus-5-5', id: 'msg_r', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Sim, desligamos.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, type: 'assistant', uuid: 'a1', timestamp: '2026-11-18T17:47:38.000Z' }
  return [user, agent].map((o) => JSON.stringify(o)).join('\n') + '\n'
}

/** write a session file straight into a project folder, with a time of our choosing */
function session(folder: string, id: string, text: string, at: number) {
  mkdirSync(folder, { recursive: true })
  const f = join(folder, `${id}.jsonl`)
  writeFileSync(f, text)
  utimesSync(f, at / 1000, at / 1000)
  return f
}

/** an Agents with our chat's record and herdr reporting the live agent at the given cwd */
function agentsWith(key: string, cwd: string, liveCwd: string | null, started = Date.now()) {
  const a = new Agents()
  a.records[key] = { key, name: NAME, kind: 'claude', cwd, workspace: 'lyvora', logs: [], started }
  ;(a as unknown as { byName: Map<string, string> }).byName.set(NAME, key)
  const info: AgentInfo = { name: NAME, agent: 'claude', agent_status: 'working', cwd: liveCwd, pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }
  ;(a as unknown as { live: Map<string, AgentInfo> }).live = new Map([[NAME, info]])
  return a
}

describe('a symlinked space reads the agent where it runs', () => {
  test('discovery prefers herdr\'s live cwd and finds the log under the real path', () => {
    const { real, link } = place('discover')
    const now = Date.now()
    const live = session(claudeProjectDir(real), S, logLines(real), now - 1000)
    // the stale session from before the rename still sits in the folder named after the link
    session(claudeProjectDir(link), OLD, logLines(link), now - 60_000)
    const a = agentsWith(KEY, link, real)
    try {
      a.discoverLog(KEY)
      expect(a.record(KEY)!.logs).toEqual([live])
      // herdr naming the same session, or another look, never adds it twice
      ;(a as unknown as { learnSession(k: string, info: { agent_session: unknown }): void }).learnSession(KEY, { agent_session: { source: 'herdr', agent: NAME, kind: 'id', value: S } })
      a.discoverLog(KEY)
      expect(a.record(KEY)!.logs).toEqual([live])
      // the path is checked in both folders and lands on the one that holds the session
      expect(claudeLogPath(a.logCwds(KEY), S)).toBe(live)
    } finally {
      a.stop()
    }
  })

  test('the chat shows the human and the reply from the real-path log, not the old folder', () => {
    const { real, link } = place('chat')
    const now = Date.now()
    const live = session(claudeProjectDir(real), S, logLines(real), now - 1000)
    session(claudeProjectDir(link), OLD, logLines(link), now - 60_000)
    const a = agentsWith(KEY, link, real)
    try {
      a.discoverLog(KEY)
      const chats = new Chats(a, () => 'coordinator', () => 'Elias')
      const chat = chats.chat(KEY)
      const said = chat.messages.filter((m) => m.text).map((m) => m.text)
      expect(said).toContain('Desligamos o reasoning?')
      expect(said).toContain('Sim, desligamos.')
      // only the live session's two rows: the stale session in the link folder is never added (count, not text)
      expect(chat.messages).toHaveLength(2)
      expect(a.record(KEY)!.logs).toEqual([live])
      expect(chat.unreadable).toBeUndefined()
    } finally {
      a.stop()
    }
  })

  test('a stale log path learned before the fix is replaced by the readable one', () => {
    const { real, link } = place('stale')
    const now = Date.now()
    const live = session(claudeProjectDir(real), S, logLines(real), now - 1000)
    const a = agentsWith(KEY, link, real)
    try {
      // the record Shepherdr saved under the old code: the current session named in the link's folder, where no file
      // was ever written. Its id is already there, so a plain "have we got this log" check keeps it for ever.
      a.record(KEY)!.logs = [join(claudeProjectDir(link), `${S}.jsonl`)]
      a.record(KEY)!.sessionId = S
      a.discoverLog(KEY)
      ;(a as unknown as { learnSession(k: string, info: { agent_session: unknown }): void }).learnSession(KEY, { agent_session: { source: 'herdr', agent: NAME, kind: 'id', value: S } })
      expect(a.record(KEY)!.logs).toEqual([live])
      const chat = new Chats(a, () => 'coordinator', () => 'Elias').chat(KEY)
      expect(chat.messages.map((m) => m.text).filter(Boolean)).toEqual(['Desligamos o reasoning?', 'Sim, desligamos.'])
      expect(chat.unreadable).toBeUndefined()
    } finally {
      a.stop()
    }
  })

  test('a running agent with no readable log says so in one calm line, in the chat and in doctor', () => {
    const { real, link } = place('none')
    const a = agentsWith(KEY, link, real, Date.now() - 60_000)
    try {
      // both candidate folders exist, but neither holds a log
      expect(a.unreadable(KEY)).toMatch(/can't be read right now/)
      expect(a.unreadableLogs()).toEqual([`${KEY}: ${a.unreadable(KEY)}`])
      const chats = new Chats(a, () => 'coordinator', () => 'Elias')
      const chat = chats.chat(KEY)
      expect(chat.messages).toHaveLength(0)
      expect(chat.unreadable).toBe(a.unreadable(KEY))
      // a just-launched agent gets a few seconds to write its first log first
      const fresh = agentsWith(KEY, link, real)
      try {
        expect(fresh.unreadable(KEY)).toBeUndefined()
      } finally {
        fresh.stop()
      }
    } finally {
      a.stop()
    }
  })

  test('when both folders hold the session, the newer copy wins and the chat keeps one log', () => {
    const { real, link } = place('both')
    const now = Date.now()
    const live = session(claudeProjectDir(real), S, logLines(real), now - 1000)
    const frozen = session(claudeProjectDir(link), S, logLines(link), now - 600_000)
    const a = agentsWith(KEY, link, real)
    try {
      a.record(KEY)!.logs = [frozen]
      a.record(KEY)!.sessionId = S
      ;(a as unknown as { learnSession(k: string, info: { agent_session: unknown }): void }).learnSession(KEY, { agent_session: { source: 'herdr', agent: NAME, kind: 'id', value: S } })
      expect(a.record(KEY)!.logs).toEqual([live])
      // if the copy in the remembered folder were the newer one, it would stay: no duplicate either way
      const b = agentsWith(KEY, link, real)
      try {
        b.record(KEY)!.logs = [frozen]
        b.record(KEY)!.sessionId = S
        utimesSync(live, (now - 900_000) / 1000, (now - 900_000) / 1000)
        ;(b as unknown as { learnSession(k: string, info: { agent_session: unknown }): void }).learnSession(KEY, { agent_session: { source: 'herdr', agent: NAME, kind: 'id', value: S } })
        expect(b.record(KEY)!.logs).toEqual([frozen])
      } finally {
        b.stop()
      }
    } finally {
      a.stop()
    }
  })

  test('every CLI\'s own session file name is recognised as readable', () => {
    const dir = tmp('unreadable-names')
    mkdirSync(dir, { recursive: true })
    // pi prefixes its log with a timestamp; the others name it after the session id
    const names: Record<string, string> = {
      claude: `${S}.jsonl`,
      pi: `2026-11-18T12-00-00-000Z_${S}.jsonl`,
      codex: `rollout-2026-11-18T12-00-00-${S}.jsonl`,
      opencode: `${S}.jsonl`,
      agy: `${S}.jsonl`,
    }
    for (const [kind, name] of Object.entries(names)) {
      const key = `p:test:${kind}`
      const a = agentsWith(key, dir, dir, Date.now() - 60_000)
      try {
        a.record(key)!.kind = kind
        a.record(key)!.sessionId = kind === 'codex' ? undefined : S
        const log = join(dir, name)
        writeFileSync(log, '')
        a.record(key)!.logs = [log]
        expect(a.unreadable(key), kind).toBeUndefined()
        rmSync(log)
        expect(a.unreadable(key), kind).toMatch(/can't be read right now/)
      } finally {
        a.stop()
      }
    }
  })

  test('the calm line is about the current session, not an older log that still exists', () => {
    const { real, link } = place('current')
    const now = Date.now()
    const old = session(claudeProjectDir(real), OLD, logLines(real), now - 600_000)
    const current = join(claudeProjectDir(real), `${S}.jsonl`)
    const a = agentsWith(KEY, link, real, now - 60_000)
    try {
      a.record(KEY)!.logs = [old, current]
      a.record(KEY)!.sessionId = S
      // an older session's file on disk must never say the live one is readable
      expect(existsSync(old)).toBe(true)
      expect(existsSync(current)).toBe(false)
      expect(a.unreadable(KEY)).toMatch(/can't be read right now/)
      expect(a.unreadableLogs()).toHaveLength(1)
      session(claudeProjectDir(real), S, logLines(real), now - 1000)
      expect(a.unreadable(KEY)).toBeUndefined()
      expect(a.unreadableLogs()).toEqual([])
    } finally {
      a.stop()
    }
  })
})
