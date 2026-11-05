// A launch herdr leaves pending (issue #491, herdr 0.9.5): `agent.start` returns at once with launch_pending, and herdr
// finishes the launch only when a client asks for that agent by name. Claude Code reports its own readiness through its
// hooks, but pi does not, so a pi task agent sat at its start screen for ever and its brief stayed in the outbox until
// an outside nudge asked for it. Shepherdr asks now, on every look at herdr, and finishes the launch itself.
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.SHEPHERDR_HOME = mkdtempSync(join(tmpdir(), 'shep-launch-pending-'))
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'herdr.sock')
const { Agents } = await import('../server/live/agents.ts')
const { herdr, HerdrError } = await import('../server/live/herdr.ts')
const { writeJson } = await import('../server/store.ts')
type AgentInfo = import('../server/live/herdr.ts').AgentInfo

/** what herdr lists: the same array, changed in place by each test */
const listing: AgentInfo[] = []
/** how herdr answers `agent.get`, which is what finishes a launch */
let answer = async (target: string): Promise<AgentInfo> => {
  const a = listing.find((x) => x.name === target)
  if (!a) throw new HerdrError('agent_not_found', `agent target ${target} not found`)
  return { ...a }
}
const asked: string[] = []
const prompted: string[] = []
const started: { name: string; pane: string }[] = []
const closed: string[] = []

// herdr's socket, standing in: the subscription a look at herdr opens is answered, so it stays open
const server = createServer((c) => {
  c.on('data', (d) => {
    for (const line of String(d).split('\n').filter(Boolean)) {
      const { id } = JSON.parse(line)
      c.write(`${JSON.stringify({ id, result: { type: 'subscription_started' } })}\n`)
    }
  })
}).listen(process.env.HERDR_SOCKET_PATH)
afterAll(() => server.close())

/** every herdr call Shepherdr makes on a look, standing in for the machine's herdr */
function spies() {
  return {
    agents: spyOn(herdr, 'agents').mockImplementation(async () => listing.map((a) => ({ ...a }))),
    agent: spyOn(herdr, 'agent').mockImplementation(async (target: string) => {
      asked.push(target)
      return answer(target)
    }),
    // herdr refuses input to an agent it is still launching, as it does on the machine we run
    prompt: spyOn(herdr, 'prompt').mockImplementation(async (target: string, text: string) => {
      if (listing.find((x) => x.name === target)?.launch_pending) throw new HerdrError('agent_not_ready', `agent ${target} is not an active named agent yet`)
      prompted.push(text)
      return {}
    }),
    start: spyOn(herdr, 'start').mockImplementation(async (name: string, _kind: string, pane: string) => {
      started.push({ name, pane })
      return { agent: null } as never
    }),
    processInfo: spyOn(herdr, 'processInfo').mockResolvedValue({ shell_pid: 1, foreground_process_group_id: 1 }),
    paneIdle: spyOn(herdr, 'paneIdle').mockResolvedValue(true),
    closePane: spyOn(herdr, 'closePane').mockImplementation(async (pane: string) => closed.push(pane)),
    createTab: spyOn(herdr, 'createTab').mockImplementation(async () => ({ tab: { tab_id: 't' }, root_pane: { pane_id: `p${started.length + 1}` } }) as never),
    workspaces: spyOn(herdr, 'workspaces').mockResolvedValue([{ workspace_id: 'w1', label: 'w' }]),
  }
}

const until = async (f: () => boolean, ms = 5000) => {
  for (const t0 = Date.now(); !f(); await Bun.sleep(20)) if (Date.now() - t0 > ms) throw new Error('timed out')
}

const KEY = 'T-1/Agent'
const name = 'shep-t-1'
const cwd = mkdtempSync(join(tmpdir(), 'shep-launch-cwd-'))

/** a pi task agent Shepherdr started once, its brief waiting in the outbox for it */
function chat(o: { pending?: boolean; ready?: boolean } = {}) {
  listing.splice(0, listing.length, {
    agent: 'pi',
    agent_status: o.ready ? 'idle' : 'unknown',
    name,
    pane_id: 'p1',
    tab_id: 't1',
    workspace_id: 'w1',
    cwd,
    ...(o.pending ? { launch_pending: true } : {}),
    ...(o.ready ? { interactive_ready: true } : {}),
  })
  writeJson('agents.json', { [KEY]: { key: KEY, name, kind: 'pi', cwd, workspace: 'w', logs: [], started: Date.now() } })
  writeJson('outbox.json', [{ id: 'o1', key: KEY, text: 'the brief', at: Date.now() }])
}

const reset = () => (asked.length = 0, prompted.length = 0, started.length = 0, closed.length = 0)

describe('a launch herdr left pending', () => {
  test('asking for the agent by name finishes it, and its brief goes in as for any other agent', async () => {
    const s = spies()
    try {
      reset()
      chat({ pending: true })
      const a = new Agents()
      try {
        await a.refresh()
        // asked by name, and the brief waits: herdr is not taking input for it yet
        expect(asked).toEqual([name])
        expect(prompted).toEqual([])
        // herdr finished the launch
        listing.splice(0, listing.length, { ...listing[0], agent_status: 'idle', launch_pending: undefined, interactive_ready: true })
        await a.refresh()
        // nothing more to ask for, and the brief goes in
        expect(asked).toEqual([name])
        await until(() => prompted.length === 1)
        expect(prompted).toEqual(['the brief'])
        expect(a.waiting(KEY)).toEqual([])
        expect(a.status(KEY)).toBe('idle')
      } finally {
        a.stop()
      }
    } finally {
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })

  test('an agent herdr already counts ready is asked nothing', async () => {
    const s = spies()
    try {
      reset()
      chat({ ready: true })
      const a = new Agents()
      try {
        await a.refresh()
        await until(() => prompted.length === 1)
        expect(asked).toEqual([])
      } finally {
        a.stop()
      }
    } finally {
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })

  test('the look at herdr never waits on the ask', async () => {
    const s = spies()
    let release = () => {}
    try {
      reset()
      chat({ pending: true })
      const gate = new Promise<void>((r) => (release = r))
      s.agent.mockImplementation(async (target: string) => {
        asked.push(target)
        await gate
        return { ...listing[0] }
      })
      const a = new Agents()
      try {
        // it comes back with the launch still pending, not when herdr answers
        await a.refresh()
        expect(asked).toEqual([name])
        expect(a.status(KEY)).toBe('unknown')
      } finally {
        release()
        a.stop()
      }
    } finally {
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })

  test('a launch that died while pending is not started again, and asking never breaks the look', async () => {
    const s = spies()
    try {
      reset()
      chat({ pending: true })
      const a = new Agents()
      try {
        await a.refresh()
        expect(asked).toEqual([name])
        // herdr answers not found while it still lists the name: nothing is started beside it
        answer = async () => {
          throw new HerdrError('agent_not_found', `agent target ${name} not found`)
        }
        await a.refresh()
        expect(started).toEqual([])
        expect(a.status(KEY)).toBe('unknown')
        // herdr dropped the name, and the pane with it: gone, which the relaunch loop brings back
        answer = async (target: string) => {
          const x = listing.find((y) => y.name === target)
          if (!x) throw new HerdrError('agent_not_found', `agent target ${target} not found`)
          return { ...x }
        }
        listing.splice(0, listing.length)
        await a.refresh()
        expect(a.status(KEY)).toBe('gone')
        expect(await a.wrong(KEY)).toBe('gone')
        // nothing keeps asking for a name herdr no longer knows
        const before = asked.length
        await a.refresh()
        expect(asked.length).toBe(before)
      } finally {
        a.stop()
      }
    } finally {
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })

  test('a relaunch after a dropped launch closes the pane it left, never a second one beside it', async () => {
    const s = spies()
    try {
      reset()
      chat({ pending: true })
      const a = new Agents()
      try {
        const spec = { key: KEY, name, kind: 'pi', cwd, workspace: 'w' }
        await a.ensure({ ...spec, pane: async () => 'p1' })
        expect(started).toEqual([{ name, pane: 'p1' }])
        // herdr dropped the pending name and closed the pane: the agent is gone
        listing.splice(0, listing.length)
        await a.refresh()
        expect(a.status(KEY)).toBe('gone')
        // started again on a fresh pane, the one it left closed first
        await a.ensure({ ...spec, pane: async () => 'p2' })
        expect(closed).toEqual(['p1'])
        expect(started).toEqual([
          { name, pane: 'p1' },
          { name, pane: 'p2' },
        ])
      } finally {
        a.stop()
      }
    } finally {
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })
})
