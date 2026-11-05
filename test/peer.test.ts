// A message another agent sent: its own row in the chat, naming the sender it declared. Never the human's words, and
// never vouched for: the sender is only what the other side wrote.
import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromAgent, fromAgentLine, fromAgents } from '../server/live/chatlines.ts'

process.env.SHEPHERDR_HOME ??= mkdtempSync(join(tmpdir(), 'shep-peer-'))
const { Chats } = await import('../server/live/chats.ts')

const sender = { name: 'SHE-17 agent', pane: 'w7R:p2', space: 'shepherdr', task: 'SHE-17' }

describe('the envelope a message from another agent arrives in', () => {
  test("our own task tell writes it, and it reads back: who, the pane, the space and the task it works in", () => {
    const line = fromAgentLine({ ...sender, to: 'SHE-18 agent' }, 'Merge it when the checks pass.')
    expect(line).toBe('<agent-message from="SHE-17 agent" to="SHE-18 agent" pane="w7R:p2" space="shepherdr" task="SHE-17">Merge it when the checks pass.</agent-message>')
    expect(fromAgent(line)).toEqual({ ...sender, text: 'Merge it when the checks pass.' })
    // a report over several lines keeps its words whole
    expect(fromAgent(fromAgentLine({ ...sender }, 'first\n\n- one\n- two'))?.text).toBe('first\n\n- one\n- two')
  })

  test("herdr's own wrapper and Claude Code's cross-session line read back too, by the name each declares", () => {
    expect(fromAgent('<agent-message from="herdr/explore" to="orchestrator">\nNothing in src/ yet.\n</agent-message>')).toEqual({ name: 'herdr/explore', text: 'Nothing in src/ yet.' })
    const cross = 'Another Claude session sent a message:\n<cross-session-message from="uds:/run/user/1000/cc-socks/1.sock" from-name="proton-vpn" from-mode="prompting">The proxy is up.</cross-session-message>'
    expect(fromAgent(cross)).toEqual({ name: 'proton-vpn', text: 'The proxy is up.' })
    // a wrapper with nothing said about itself still names something: never an empty sender
    expect(fromAgent('<agent-message from="">hello</agent-message>')?.name).toBe('Another agent')
  })

  test('two messages joined are two rows, each with its own sender: a task told twice while it was held', () => {
    const a = fromAgentLine({ name: 'SHE-17 agent', pane: 'w7R:p2' }, 'First.')
    const b = fromAgentLine({ name: 'polylog coordinator', pane: 'w74:p1' }, 'Second.')
    const both = fromAgents(`${a}\n\n${b}`)
    expect(both).toEqual([
      { name: 'SHE-17 agent', pane: 'w7R:p2', text: 'First.' },
      { name: 'polylog coordinator', pane: 'w74:p1', text: 'Second.' },
    ])
    // words after the envelopes are no envelope at all: that text is what it looks like, not a message from an agent
    expect(fromAgents(`${a}\n\nand a note after it`)).toEqual([])
  })

  test('the human’s words, a quoted wrapper inside them, and an unfinished envelope are not one', () => {
    // what the human types is plain text, even when it talks about a message
    expect(fromAgent('Relayed from the operator by pane w25:p1: merge it')).toBeNull()
    expect(fromAgent('Look at this: <agent-message from="x">hello</agent-message>')).toBeNull()
    // a reply line our agents write, an attachment: their own tags, not this one
    expect(fromAgent('<reply to="Merge it?"/>')).toBeNull()
    expect(fromAgent('<agent-message from="x">still coming')).toBeNull()
  })
})

/* ---------- the chat: one row, naming the sender ---------- */

const S = 'b1f0c2d4-0000-4000-8000-000000000002'
const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: '/work/app', sessionId: S, version: '2.1.283' }
const cuser = (uuid: string, content: unknown, extra: object = {}) => ({
  parentUuid: null,
  ...base,
  type: 'user',
  message: { role: 'user', content },
  uuid,
  timestamp: '2026-11-06T10:00:00.000Z',
  ...extra,
})

/** a chat read from one log file, in that CLI's own format, with this machine's names for the senders */
function chatWith(kind: 'claude' | 'pi', lines: object[]) {
  const dir = mkdtempSync(join(tmpdir(), 'shep-peer-log-'))
  const log = join(dir, `${S}.jsonl`)
  writeFileSync(log, lines.map((o) => `${JSON.stringify(o)}\n`).join(''))
  const agents = {
    record: () => ({ kind, logs: [log], sessionId: S, cwd: '/work/app' }),
    status: () => 'idle',
    stillRuns: () => undefined,
    background: () => undefined,
    reviewers: { list: () => [] },
    sentLately: () => [],
    waiting: () => [],
    typedSince: () => [],
    failedLately: () => [],
    holdOf: () => undefined,
    info: () => undefined,
    runtime: () => undefined,
    runtimeHook: () => undefined,
  }
  const chats = new Chats(
    agents as never,
    (k) => (k === 'SHE-17/Agent' ? 'SHE-17 agent' : k),
    () => 'Elias',
    // as live/source.ts does: what the sending side said about itself, and our own name for a herdr name we know
    (p) =>
      p.pane || p.space || p.task
        ? { name: p.name, ...(p.pane ? { pane: p.pane } : {}), ...(p.space ? { space: p.space } : {}), ...(p.task ? { task: p.task } : {}) }
        : p.name === 'shep-she-17'
          ? { name: 'SHE-17 agent', pane: 'w7R:p2', space: 'shepherdr', task: 'SHE-17' }
          : { name: p.name },
  )
  return chats.chat('SHE-18/Agent')
}

describe('a message another agent sent, in the chat', () => {
  test('a task tell from another agent is a row of its own, with the sender it declared: never your words', () => {
    const said = fromAgentLine({ ...sender, to: 'SHE-18 agent' }, 'Relayed from the operator: merge it once the checks pass.')
    const chat = chatWith('claude', [cuser('u1', said)])
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]).toMatchObject({
      who: 'peer',
      text: 'Relayed from the operator: merge it once the checks pass.',
      peer: { name: 'SHE-17 agent', pane: 'w7R:p2', space: 'shepherdr', task: 'SHE-17' },
    })
  })

  test("a pi agent's own wrapper (herdr's messaging) reads as the agent it names on this machine", () => {
    const chat = chatWith('pi', [
      { type: 'session', id: S, timestamp: '2026-11-06T10:00:00.000Z' },
      { type: 'message', id: 'p1', timestamp: '2026-11-06T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: '<agent-message from="shep-she-17" to="shep-she-18">\nThe migration is done.\n</agent-message>' }] } },
    ])
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]).toMatchObject({ who: 'peer', text: 'The migration is done.', peer: { name: 'SHE-17 agent', pane: 'w7R:p2', task: 'SHE-17' } })
  })

  test('two envelopes in one turn are two rows, each with its own sender', () => {
    const both = `${fromAgentLine({ name: 'SHE-17 agent', pane: 'w7R:p2' }, 'First.')}\n\n${fromAgentLine({ name: 'polylog coordinator' }, 'Second.')}`
    const chat = chatWith('claude', [cuser('u1', both)])
    expect(chat.messages.map((m) => [m.id, m.peer?.name, m.text])).toEqual([
      ['u1:peer0', 'SHE-17 agent', 'First.'],
      ['u1:peer1', 'polylog coordinator', 'Second.'],
    ])
    expect(chat.messages.every((m) => m.who === 'peer')).toBe(true)
  })

  test("Claude Code's own cross-session message is one; a subagent's hand-back stays out, as before", () => {
    const cross = 'Another Claude session sent a message:\n<cross-session-message from="uds:/run/user/1000/cc-socks/1.sock" from-name="proton-vpn" from-mode="prompting">The proxy is up.</cross-session-message>'
    const handBack = '<agent-message from="a75bac740db6f4d10">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to.\n</agent-message>'
    const chat = chatWith('claude', [cuser('u1', cross, { origin: { kind: 'peer' } }), cuser('u2', handBack, { origin: { kind: 'peer' } })])
    expect(chat.messages.map((m) => [m.who, m.peer?.name, m.text])).toEqual([['peer', 'proton-vpn', 'The proxy is up.']])
  })

  test('your own words, and a launch brief, are still yours: nothing about them changed', () => {
    const chat = chatWith('claude', [cuser('u1', 'Merge it when the checks pass.'), cuser('u2', 'SHE-18: agent messages\n\nDo the thing.\n\nSettings:')])
    expect(chat.messages.map((m) => [m.who, m.peer])).toEqual([
      ['you', undefined],
      ['you', undefined],
    ])
  })
})

/* ---------- who a task tell comes from, on the live server ---------- */

describe('shepherdr task tell says who sent it', () => {
  test("an agent's shell names its chat, pane and space; a pane herdr says runs an agent is one too; a plain terminal is not", async () => {
    const home = mkdtempSync(join(tmpdir(), 'shep-peer-tell-'))
    process.env.SHEPHERDR_HOME = home
    process.env.HERDR_SOCKET_PATH = join(home, 'no-herdr.sock')
    const [{ LiveSource }, { herdr }, { placeId }] = await Promise.all([
      import('../server/live/source.ts'),
      import('../server/live/herdr.ts'),
      import('../server/live/places.ts'),
    ])
    const src = new LiveSource()
    type Told = { name: string; pane?: string; space?: string; task?: string } | undefined
    const told = (ctx: { chat?: string; pane?: string }) => (src as unknown as { toldFrom(c: { chat?: string; pane?: string }): Promise<Told> }).toldFrom(ctx)
    /** herdr says this is what runs in the pane */
    const agentAt = (a: { agent: string | null; name?: string | null; pane_id: string }) => spyOn(herdr, 'agent').mockImplementation((async () => ({ ...a, tab_id: 't', workspace_id: 'w' })) as never)
    try {
      // one of ours: its chat says which agent it is, and where it works; herdr is not asked for it
      const mine = await told({ chat: placeId.home(), pane: 'w9:p9' })
      expect(mine).toMatchObject({ pane: 'w9:p9' })
      expect(mine?.name).toEndWith('coordinator')
      // a shell with no chat: the pane herdr says runs an agent makes it that agent's message
      const ours = agentAt({ agent: 'pi', name: 'shep-she-17', pane_id: 'w9:p1' })
      expect(await told({ pane: 'w9:p1' })).toEqual({ name: 'shep-she-17', pane: 'w9:p1' })
      ours.mockRestore()
      // an agent of the operator's that is not Shepherdr's: its CLI's name, with the pane it writes from
      const stranger = agentAt({ agent: 'claude', name: null, pane_id: 'w2E:pC' })
      expect(await told({ pane: 'w2E:pC' })).toEqual({ name: 'Claude Code', pane: 'w2E:pC' })
      stranger.mockRestore()
      // nothing runs in that pane (herdr says so), or a shell with neither chat nor pane: the words are the human's
      const empty = agentAt({ agent: null, pane_id: 'w2E:pC' })
      expect(await told({ pane: 'w2E:pC' })).toBeUndefined()
      empty.mockRestore()
      expect(await told({})).toBeUndefined()
    } finally {
      src.stop()
    }
  })
})
