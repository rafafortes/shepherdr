// A launch herdr leaves pending (issue #491, herdr 0.9.5): `agent.start` returns at once with launch_pending, and herdr
// finishes such a launch only when a client asks for that agent by name — a name nobody asks for is dropped about a
// minute later, with its pane. Claude Code reports its own readiness through its hooks, pi does not, so a pi task agent
// sat at its start screen for ever and its brief stayed in the outbox until an outside nudge asked for it. Shepherdr
// asks now, on every look at herdr, and finishes the launch itself.
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('launch-pending')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'herdr.sock')
const { Agents } = await import('../server/live/agents.ts')
const { herdr, HerdrError } = await import('../server/live/herdr.ts')
const { writeJson } = await import('../server/store.ts')
type AgentInfo = import('../server/live/herdr.ts').AgentInfo

/** what herdr lists, changed in place by each test: its answer to a look */
const listing: AgentInfo[] = []
/** how many asks for an agent herdr takes to finish its launch: the second, at most, on a real one */
let finishesAfter = Number.POSITIVE_INFINITY
const asks = new Map<string, number>()
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

/** herdr, standing in: a pending launch is finished by asking for the agent by name, as the real one does */
function spies() {
  return {
    agents: spyOn(herdr, 'agents').mockImplementation(async () => listing.map((a) => ({ ...a }))),
    agent: spyOn(herdr, 'agent').mockImplementation(async (target: string) => {
      asked.push(target)
      const a = listing.find((x) => x.name === target)
      if (!a) throw new HerdrError('agent_not_found', `agent target ${target} not found`)
      const n = (asks.get(target) ?? 0) + 1
      asks.set(target, n)
      if (a.launch_pending && n >= finishesAfter) Object.assign(a, { launch_pending: undefined, interactive_ready: true, agent_status: 'idle' })
      return { ...a }
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
const cwd = tmp('launch-cwd')

/** a pi task agent Shepherdr started once, its brief waiting in the outbox for it */
function chat(o: { pending?: boolean; ready?: boolean; pane?: string } = {}) {
  listing.splice(0, listing.length, {
    agent: 'pi',
    agent_status: o.ready ? 'idle' : 'unknown',
    name,
    pane_id: o.pane ?? 'p1',
    tab_id: 't1',
    workspace_id: 'w1',
    cwd,
    ...(o.pending ? { launch_pending: true } : {}),
    ...(o.ready ? { interactive_ready: true } : {}),
  })
  writeJson('agents.json', { [KEY]: { key: KEY, name, kind: 'pi', cwd, workspace: 'w', logs: [], started: Date.now() } })
  writeJson('outbox.json', [{ id: 'o1', key: KEY, text: 'the brief', at: Date.now() }])
}

function reset() {
  asked.length = 0
  prompted.length = 0
  started.length = 0
  closed.length = 0
  asks.clear()
  finishesAfter = Number.POSITIVE_INFINITY
}

describe('a launch herdr left pending', () => {
  test('asking for the agent by name finishes it, and its brief goes in as for any other agent', async () => {
    const s = spies()
    try {
      reset()
      finishesAfter = 2
      chat({ pending: true })
      const a = new Agents()
      try {
        await a.refresh()
        // asked by name, and the brief waits: herdr is not taking input for it yet
        expect(asked).toContain(name)
        expect(prompted).toEqual([])
        expect(a.status(KEY)).toBe('unknown')
        // asked again, herdr finishes the launch, and the brief goes in
        for (let i = 0; i < 3; i++) await a.refresh()
        expect(asked.length).toBeGreaterThanOrEqual(2)
        await until(() => prompted.length === 1)
        expect(prompted).toEqual(['the brief'])
        await until(() => a.waiting(KEY).length === 0)
        expect(a.status(KEY)).toBe('idle')
        // the launch is over: nothing is asked any more
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

  test('a pending agent Shepherdr did not start is never asked for, and only the asking finishes one', async () => {
    const s = spies()
    try {
      reset()
      finishesAfter = 2
      chat({ pending: true })
      // herdr's own manual agent, or one of another Shepherdr: no record of ours
      listing.push({ agent: 'pi', agent_status: 'unknown', name: 'shep-other', pane_id: 'p9', tab_id: 't9', workspace_id: 'w9', cwd, launch_pending: true })
      const a = new Agents()
      try {
        for (let i = 0; i < 3; i++) await a.refresh()
        expect(asked).not.toContain('shep-other')
        // ours is ready, and the one nobody asked for is still pending, as herdr leaves it
        await until(() => prompted.length === 1)
        expect(listing.find((x) => x.name === 'shep-other')?.launch_pending).toBe(true)
        expect(listing.find((x) => x.name === name)?.launch_pending).toBeUndefined()
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
        expect(asked).toContain(name)
        expect(a.status(KEY)).toBe('unknown')
      } finally {
        release()
        a.stop()
      }
    } finally {
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })

  test('a launch that never goes ready is asked for only so long, then left alone', async () => {
    const s = spies()
    const errors: string[] = []
    const log = spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')))
    try {
      reset()
      chat({ pending: true })
      const a = new Agents()
      try {
        // a launch that stays pending: herdr's own timeout, and the relaunch loop, end it
        a.pendingFor = 300
        await a.refresh()
        expect(asked).toContain(name)
        expect(errors).toEqual([])
        // past the patience, and past any look the subscription itself starts
        await Bun.sleep(400)
        const before = asked.length
        await a.refresh()
        await a.refresh()
        // said once, and no longer asked: a stuck launch is not kept alive by the asking itself
        expect(asked.length).toBe(before)
        expect(errors.length).toBe(1)
        expect(errors[0]).toContain(name)
        expect(errors[0]).toContain("hasn't become ready")
      } finally {
        a.stop()
      }
    } finally {
      log.mockRestore()
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
        expect(asked).toContain(name)
        // herdr answers not found while it still lists the name: nothing is started beside it
        s.agent.mockImplementation(async (target: string) => {
          asked.push(target)
          throw new HerdrError('agent_not_found', `agent target ${target} not found`)
        })
        await a.refresh()
        // still listed as pending: not to be started again, whatever herdr says about its pane
        expect(await a.wrong(KEY)).toBeUndefined()
        expect(started).toEqual([])
        expect(a.status(KEY)).toBe('unknown')
        // herdr dropped the name, and the pane with it: gone, which the relaunch loop brings back
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
        // a herdr that leaves the pane of a launch it dropped behind: nothing guarantees every version closes it
        await a.ensure({ ...spec, pane: async () => 'p1' })
        expect(started).toEqual([{ name, pane: 'p1' }])
        expect(a.record(KEY)?.pendingLaunch).toBe(true)
        // herdr dropped the pending name: the agent is gone, its pane still at its prompt
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

  test('an agent that stopped for any other reason leaves no pane of its own to close', async () => {
    const s = spies()
    try {
      reset()
      chat({ ready: true })
      const a = new Agents()
      try {
        const spec = { key: KEY, name, kind: 'pi', cwd, workspace: 'w' }
        await a.ensure({ ...spec, pane: async () => 'p1' })
        expect(a.record(KEY)?.pendingLaunch).toBeFalsy()
        // its CLI exited and herdr let the name go: nothing pending was dropped, so no pane is Shepherdr's to close
        listing.splice(0, listing.length)
        await a.refresh()
        await a.ensure({ ...spec, pane: async () => 'p2' })
        expect(closed).toEqual([])
      } finally {
        a.stop()
      }
    } finally {
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })
})
