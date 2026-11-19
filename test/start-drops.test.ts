// A start that meets herdr dropping its calls (server/live/herdr.ts PASSING) starts once and shows no failure, for every
// CLI Shepherdr starts: Claude Code, Codex, pi, OpenCode and Antigravity share one launch (agents.ts), and each is run
// through it here against a herdr on a real socket that fails like a loaded one (test/socket-herdr.ts). A herdr that is
// gone still fails as "herdr isn't answering", and one that keeps dropping fails with its error once the tries run out.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { socketHerdr } from './socket-herdr.ts'
import { tmp } from './tmp.ts'

const dir = tmp('start-drops')
process.env.SHEPHERDR_HOME = join(dir, 'home')
// every CLI's home is a folder of this file's: logs are looked for there, never in the human's
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
process.env.PI_CODING_AGENT_DIR = join(dir, 'pi')
// OpenCode's session is made by its CLI before the TUI starts: a fake that counts its calls
const bin = join(dir, 'fake-opencode')
const calls = join(dir, 'opencode-calls')
const saved = process.env.SHEPHERDR_OPENCODE_BIN
beforeAll(() => {
  writeFileSync(
    bin,
    `#!${process.execPath}\nimport { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n')\nprocess.stdout.write(JSON.stringify({ data: { id: 'ses_fake1' } }))\n`,
  )
  chmodSync(bin, 0o755)
  process.env.SHEPHERDR_OPENCODE_BIN = bin
})
afterAll(() => {
  if (saved === undefined) delete process.env.SHEPHERDR_OPENCODE_BIN
  else process.env.SHEPHERDR_OPENCODE_BIN = saved
})

const { Agents } = await import('../server/live/agents.ts')
const { isPassing } = await import('../server/live/herdr.ts')
type Agents = InstanceType<typeof Agents>

let h: ReturnType<typeof socketHerdr>
let a: Agents
let logged: ReturnType<typeof spyOn>
beforeEach(async () => {
  // what the start says in the log when it meets a drop is not what these tests are about
  logged = spyOn(console, 'error').mockImplementation(() => undefined)
  h = socketHerdr()
  process.env.HERDR_SOCKET_PATH = h.path
  await h.listen()
  a = new Agents()
})
afterEach(() => {
  logged.mockRestore()
  a.stop()
  h.stop()
})

const KINDS = ['claude', 'codex', 'pi', 'opencode', 'agy']

const spec = (kind: string, n: number) => {
  const key = `DR-${n}/Agent`
  return { key, name: Agents.nameFor(key), kind, cwd: tmp(`start-drops-${kind}`), workspace: `shep-dr-${kind}` }
}

const opencodeSessions = () =>
  existsSync(calls)
    ? readFileSync(calls, 'utf8')
        .split('\n')
        .filter((l) => l.includes('session.create')).length
    : 0

describe.each(KINDS)('a start of %s that meets drops', (kind) => {
  test('makes one workspace, one agent and no failure: the work herdr did is found, not done twice', async () => {
    const s = spec(kind, KINDS.indexOf(kind))
    h.fail('workspace.create', 'drop-after')
    h.fail('agent.start', 'drop-after')
    await a.ensure(s)
    expect(h.spaces.filter((w) => w.label === s.workspace)).toHaveLength(1)
    expect(h.agents.filter((x) => x.name === s.name)).toHaveLength(1)
    expect(h.count('workspace.create')).toBe(1)
    expect(h.count('agent.start')).toBe(1)
    expect(a.record(s.key).startError).toBeUndefined()
  })

  test('that herdr keeps dropping for longer than one call tries is tried again by the start itself, and starts once', async () => {
    const s = spec(kind, 10 + KINDS.indexOf(kind))
    const before = opencodeSessions()
    // four tries inside the call (the first and three more), then the start waits and begins its start again
    h.fail('agent.start', ...Array<'drop'>(5).fill('drop'))
    await a.ensure(s)
    expect(h.agents.filter((x) => x.name === s.name)).toHaveLength(1)
    expect(h.count('agent.start')).toBe(6)
    expect(a.record(s.key).startError).toBeUndefined()
    // OpenCode's session is made once, however many times its start is asked again
    if (kind === 'opencode') expect(opencodeSessions() - before).toBe(1)
  })

  test('with a workspace and a tab dropped before they were made: made once, reused by the tries after', async () => {
    const s = spec(kind, 20 + KINDS.indexOf(kind))
    // its workspace exists: the start makes a tab in it
    const ws = h.space(s.workspace, s.cwd)
    h.fail('tab.create', 'drop', 'drop-after')
    await a.ensure(s)
    expect(h.panes.filter((p) => p.workspace_id === ws.workspace.workspace_id && p.pane_id !== ws.root_pane.pane_id)).toHaveLength(1)
    expect(h.agents.filter((x) => x.name === s.name)).toHaveLength(1)
    expect(a.record(s.key).startError).toBeUndefined()
  })

  test('with herdr gone fails as "herdr isn\'t answering", at once, and keeps that as the reason', async () => {
    const s = spec(kind, 30 + KINDS.indexOf(kind))
    h.stop()
    await expect(a.ensure(s)).rejects.toThrow("herdr isn't answering")
    expect(a.record(s.key).startError).toBe("herdr isn't answering")
  })

  test('with herdr dropping every call fails once the tries run out, with the error, not as herdr down', async () => {
    const s = spec(kind, 40 + KINDS.indexOf(kind))
    h.fail('agent.start', ...Array<'drop'>(100).fill('drop'))
    const e = await a.ensure(s).catch((x: Error) => x)
    expect(e).toBeInstanceOf(Error)
    expect(isPassing(e)).toBe(true)
    expect((e as Error).message).toContain('herdr closed the connection during agent.start')
    expect(a.record(s.key).startError).toBe((e as Error).message)
    // the call's tries (four) in each of the start's (the first and three more, SHEPHERDR_START_RETRY_MS in test/preload.ts)
    expect(h.count('agent.start')).toBe(16)
    expect(h.agents.filter((x) => x.name === s.name)).toHaveLength(0)
  })
})

describe('a restart or a resume', () => {
  test('goes through the same start: a drop on its start is no failure, for each CLI', async () => {
    for (const kind of KINDS) {
      const s = spec(kind, 50 + KINDS.indexOf(kind))
      await a.ensure(s)
      expect(h.agents.filter((x) => x.name === s.name)).toHaveLength(1)
      // its agent goes away (its CLI exited), and it is started again on the same session
      h.agents.splice(0, h.agents.length, ...h.agents.filter((x) => x.name !== s.name))
      await a.refresh()
      h.fail('agent.start', 'drop-after')
      await a.restart(s as never)
      expect(h.agents.filter((x) => x.name === s.name)).toHaveLength(1)
      expect(a.record(s.key).startError).toBeUndefined()
    }
  })
})
