// SEC-03: words typed into a CLI's pane are ours to bound. A relayed message can carry ESC sequences that a TUI reads
// as keys (cancelling a prompt or picking a menu option). Every CLI shares agents.text/put, so the cleaner is applied
// there, once; the chat keeps the original words. herdr is spied on; no socket and no real CLI is involved.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('agents-text')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')

const { stripControl } = await import('../shared/keys.ts')
const { Agents } = await import('../server/live/agents.ts')
type AgentInfo = import('../server/live/herdr.ts').AgentInfo
type AgentRecord = import('../server/live/agents.ts').AgentRecord
type OutItem = import('../server/live/agents.ts').OutItem
const { herdr } = await import('../server/live/herdr.ts')
const { writeJson } = await import('../server/store.ts')
const { Chats } = await import('../server/live/chats.ts')

/** every CLI Shepherdr drives: they all go through the same two typed paths */
const KINDS = ['claude', 'codex', 'pi', 'opencode', 'agy'] as const
/** CSI, OSC (both terminators), a Cc sequence, C0 and C1, with tab and line breaks that must survive */
const hostile = 'hello \x1b[5~\x1b]0;title\x07world\x1b[31m!\x00\x1b(B\nnext\tline\r\ndone'
const cleaned = 'hello world!\nnext\tline\r\ndone'

describe('stripControl', () => {
  test('CSI sequences go with their parameters and final byte', () => {
    expect(stripControl('a\x1b[5~b')).toBe('ab')
    expect(stripControl('a\x1b[1;2Ab')).toBe('ab')
    expect(stripControl('a\x1b[?25lb')).toBe('ab')
    expect(stripControl('a\x1b[200~pasted\x1b[201~b')).toBe('apastedb')
  })

  test('OSC goes through BEL or ST, and even when it never ends', () => {
    expect(stripControl('a\x1b]0;title\x07b')).toBe('ab')
    expect(stripControl('a\x1b]0;title\x1b\\b')).toBe('ab')
    expect(stripControl('a\x1b]no terminator')).toBe('a')
  })

  test('other ESC sequences, C0, C1 and DEL go; tab, newline and carriage return stay', () => {
    expect(stripControl('a\x1b(Bb')).toBe('ab')
    expect(stripControl('a\x1bcb')).toBe('ab')
    expect(stripControl('a\x00\x07\x08\x0b\x0c\x0e\x1f\x7f\x80\x9fb')).toBe('ab')
    expect(stripControl('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })

  test('ordinary words, accents, emoji and marks keep every byte, and cleaning is idempotent', () => {
    const words = 'Olá, café 🎉 — **that** [link](https://x) — yes.'
    expect(stripControl(words)).toBe(words)
    expect(stripControl(cleaned)).toBe(cleaned)
    expect(stripControl(stripControl(hostile))).toBe(cleaned)
  })
})

let sent: { prompt: [string, string][]; paneText: [string, string][] }
let spies: { mockRestore: () => void }[]
const made: InstanceType<typeof Agents>[] = []

beforeEach(() => {
  sent = { prompt: [], paneText: [] }
  spies = [
    spyOn(herdr, 'prompt').mockImplementation(async (target: string, text: string) => {
      sent.prompt.push([target, text])
      return {} as never
    }),
    spyOn(herdr, 'paneText').mockImplementation(async (pane: string, text: string) => {
      sent.paneText.push([pane, text])
      return {} as never
    }),
  ]
})
afterEach(() => {
  for (const a of made.splice(0)) a.stop()
  for (const s of spies) s.mockRestore()
})

/** an Agents with one live record of this kind, as the server has after it looked at herdr */
function withAgent(kind: string) {
  const key = `T-${kind}/Agent`
  const record: AgentRecord = { key, name: Agents.nameFor(key), kind, cwd: '/work', workspace: 'w', logs: [], started: Date.now() }
  writeJson('agents.json', { [key]: record })
  writeJson('outbox.json', [])
  const a = new Agents()
  made.push(a)
  const info: AgentInfo = { name: record.name, agent: kind, agent_status: 'idle', pane_id: `pane-${kind}`, tab_id: 't', workspace_id: 'w', cwd: record.cwd }
  a.live.set(record.name, info)
  return { a, key, record, pane: info.pane_id }
}

describe('what is typed into a pane', () => {
  for (const kind of KINDS) {
    test(`${kind}: text() types the cleaned words, not the control bytes`, async () => {
      const { a, key, pane } = withAgent(kind)
      await a.text(key, hostile)
      expect(sent.paneText).toEqual([[pane, cleaned]])
    })

    test(`${kind}: put() types the cleaned words into the CLI's prompt`, async () => {
      const { a, key, record } = withAgent(kind)
      const item = { id: 'm1', key, text: hostile, at: Date.now() }
      await (a as unknown as { put: (key: string, item: OutItem) => Promise<void> }).put(key, item)
      expect(sent.prompt).toEqual([[record.name, cleaned]])
      expect(item.text).toBe(hostile) // the message itself keeps its words
    })
  }
})

describe('the chat log', () => {
  test('post() keeps the original words, escapes and all', () => {
    const stub = {
      outbox: [],
      delivered: [],
      record: () => undefined,
      sentLately: () => [],
      waiting: () => [],
      holdOf: () => undefined,
      status: () => 'blocked',
      failedLately: () => [],
      info: () => undefined,
      runtime: () => undefined,
      runtimeHook: () => undefined,
      background: () => false,
      unreadable: () => undefined,
      stillRuns: () => false,
      procs: { list: () => [] },
    }
    const chats = new Chats(
      stub as never,
      (k) => k,
      () => 'You',
    )
    chats.post('T-log/Agent', { id: 'm1', who: 'you', text: hostile, at: 1 })
    expect(chats.chat('T-log/Agent').messages.some((m) => m.text === hostile)).toBe(true)
  })
})
