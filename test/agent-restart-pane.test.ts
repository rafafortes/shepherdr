// A restart opens the pane its new run goes in before it ends the run it takes over from (agents.ts restart). herdr
// closes a space with its last pane, so a task agent's only pane took its worktree's space with it and the backup
// taking over had nowhere to start (SHE-166, POL-452). The ordering is one for every CLI Shepherdr runs: the same CLI
// resuming its own session, and one taking the chat over from another, both stop the old run before the new pane runs.
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { createServer } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('agent-restart-pane')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'herdr.sock')
const { Agents } = await import('../server/live/agents.ts')
const { herdr, HerdrError } = await import('../server/live/herdr.ts')
const { writeJson } = await import('../server/store.ts')
type AgentInfo = import('../server/live/herdr.ts').AgentInfo

// herdr's socket, standing in: the subscription every look at herdr opens is answered, so it stays open
const server = createServer((c) => {
  c.on('data', (d) => {
    for (const line of String(d).split('\n').filter(Boolean)) {
      const { id } = JSON.parse(line)
      c.write(`${JSON.stringify({ id, result: { type: 'subscription_started' } })}\n`)
    }
  })
}).listen(process.env.HERDR_SOCKET_PATH)
afterAll(() => server.close())

const KEY = 'T-166/Agent'
const NAME = 'shep-t-166'
const OLD = 'w1:p1'
const NEW = 'w1:p2'
const cwd = tmp('agent-restart-cwd')

/** what herdr has running: the agent the restart takes over from, as each test leaves it */
const listing: AgentInfo[] = []

const events: string[] = []
const started: { name: string; kind: string; pane: string; args: string[] }[] = []
const tabDirs: string[] = []

/** herdr, standing in: the old pane is the agent's, the new tab holds the pane the run goes in */
function spies() {
  return {
    agents: spyOn(herdr, 'agents').mockImplementation(async () => listing.map((a) => ({ ...a }))),
    start: spyOn(herdr, 'start').mockImplementation(async (name: string, kind: string, pane: string, args: string[] = []) => {
      events.push(`start ${pane}`)
      started.push({ name, kind, pane, args })
      return { agent: null } as never
    }),
    processInfo: spyOn(herdr, 'processInfo').mockResolvedValue({} as never),
    paneIdle: spyOn(herdr, 'paneIdle').mockResolvedValue(true),
    closePane: spyOn(herdr, 'closePane').mockImplementation(async (pane: string) => {
      events.push(`close ${pane}`)
      // herdr has no agent in a pane it closed
      const at = listing.findIndex((a) => a.pane_id === pane)
      if (at >= 0) listing.splice(at, 1)
    }),
    createTab: spyOn(herdr, 'createTab').mockImplementation(async (id: string, _label: string, dir: string) => {
      events.push(`tab ${id}`)
      tabDirs.push(dir)
      return { tab: { tab_id: 't2' }, root_pane: { pane_id: NEW } } as never
    }),
    workspaces: spyOn(herdr, 'workspaces').mockResolvedValue([
      { workspace_id: 'w1', label: 'T-166: keep the space' },
      { workspace_id: 'w0', label: 'a project' },
    ] as never),
    createWorkspace: spyOn(herdr, 'createWorkspace').mockImplementation(async (label: string, dir: string) => {
      events.push(`workspace ${label}`)
      tabDirs.push(dir)
      return { workspace: { workspace_id: 'w2', label }, root_pane: { pane_id: NEW } } as never
    }),
  }
}

const CODEX_LOG = '/tmp/logs/1a2b3c4d-1111-2222-3333-444455556666.jsonl'

/** the five CLIs Shepherdr runs, each resumed from its own conversation, and the flag that resumes it */
const CASES = [
  { kind: 'claude', logs: [`/tmp/logs/sess-1.jsonl`], resume: ['--resume', 'sess-1'] },
  { kind: 'codex', logs: [CODEX_LOG], resume: ['resume', '1a2b3c4d-1111-2222-3333-444455556666'] },
  { kind: 'pi', logs: [`/tmp/logs/sess-1.jsonl`], resume: ['--session-id', 'sess-1'] },
  { kind: 'opencode', logs: [`/tmp/logs/sess-1.jsonl`], resume: ['--session', 'sess-1'] },
  { kind: 'agy', logs: [`/tmp/logs/sess-1.jsonl`], resume: ['--conversation', 'sess-1'] },
]

/** a chat that ran once: its record, and the agent herdr still has in the pane it ran in */
function chat(c: { kind: string; logs: string[] }) {
  listing.splice(0, listing.length, { agent: c.kind, agent_status: 'idle', name: NAME, pane_id: OLD, tab_id: 't1', workspace_id: 'w1', cwd } as AgentInfo)
  writeJson('agents.json', { [KEY]: { key: KEY, name: NAME, kind: c.kind, cwd, workspace: 'T-166: keep the space', tab: 'Agent', logs: c.logs, sessionId: 'sess-1', started: Date.now() - 60_000 } })
  writeJson('outbox.json', [])
  events.length = 0
  started.length = 0
  tabDirs.length = 0
}

describe('a chat whose space closed anyway (a coordinator, whose spec has no pane of its own)', () => {
  test('is given a space again, and the run starts in it', async () => {
    const s = spies()
    try {
      chat(CASES[2])
      const a = new Agents()
      try {
        await a.refresh()
        // herdr lists the space and closes it before the tab: after that it has none for the chat
        s.workspaces.mockResolvedValueOnce([{ workspace_id: 'w1', label: 'T-166: keep the space' }] as never).mockResolvedValue([] as never)
        s.createTab.mockRejectedValueOnce(new HerdrError('workspace_not_found', 'workspace w1 not found') as never)
        await a.restart({ key: KEY, name: NAME, kind: 'pi', cwd, workspace: 'T-166: keep the space', tab: 'Agent', env: {} })
        // the space it is given is opened where it runs, before the old pane closes
        expect(events).toEqual(['workspace T-166: keep the space', `close ${OLD}`, `start ${NEW}`])
        expect(started[0].pane).toBe(NEW)
      } finally {
        a.stop()
      }
    } finally {
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })

  test('a space herdr still has, and a tab it refused for its own reason, fails the start as it did', async () => {
    const s = spies()
    try {
      chat(CASES[2])
      const a = new Agents()
      try {
        await a.refresh()
        s.createTab.mockRejectedValue(new HerdrError('invalid_request', 'tab.create: no such folder') as never)
        await expect(a.restart({ key: KEY, name: NAME, kind: 'pi', cwd, workspace: 'T-166: keep the space', tab: 'Agent', env: {} })).rejects.toThrow('no such folder')
        // no second space was opened for it
        expect(events).toEqual([`close ${OLD}`])
      } finally {
        a.stop()
      }
    } finally {
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })
})

describe("a start that failed puts the chat's record back", () => {
  for (const c of CASES) {
    test(`${c.kind}: the same CLI starts again on its own session, not on the one the failed start wrote`, async () => {
      const s = spies()
      try {
        chat(c)
        const a = new Agents()
        try {
          await a.refresh()
          const before = { ...a.record(KEY)! }
          // the backup's CLI never came up (no pane for it): its kind, and a session it never ran, went over the record
          await expect(
            a.restart({
              key: KEY,
              name: NAME,
              kind: c.kind === 'codex' ? 'pi' : 'codex',
              cwd,
              workspace: 'T-166: keep the space',
              tab: 'Agent',
              env: {},
              pane: async () => Promise.reject(new Error('no pane for it')),
            }),
          ).rejects.toThrow('no pane')
          expect(a.record(KEY)?.kind).not.toBe(c.kind)
          expect(a.record(KEY)?.startError).toContain('no pane')
          a.restore(KEY, before)
          // back to what it was, with why the start failed kept for the screen and no stale hooks
          expect(a.record(KEY)).toMatchObject({ kind: c.kind, startError: expect.stringContaining('no pane'), sessionId: before.sessionId })
          expect('hooks' in a.record(KEY)!).toBe(false)
          // and the run that comes after is the chat's own CLI on its own session
          started.length = 0
          events.length = 0
          await a.restart({ key: KEY, name: NAME, kind: c.kind, cwd, workspace: 'T-166: keep the space', tab: 'Agent', env: {}, pane: async () => NEW })
          expect(started[0].args.join(' ')).toContain(c.resume.join(' '))
        } finally {
          a.stop()
        }
      } finally {
        for (const spy of Object.values(s)) spy.mockRestore()
      }
    })
  }
})

describe('a restart opens the new pane before it ends the run it takes over from', () => {
  for (const c of CASES) {
    test(`${c.kind}: the tab is opened first, and the resumed run starts in it`, async () => {
      const s = spies()
      try {
        chat(c)
        const a = new Agents()
        try {
          await a.refresh()
          await a.restart({ key: KEY, name: NAME, kind: c.kind, cwd, workspace: 'T-166: keep the space', tab: 'Agent', env: {}, pane: async () => (events.push('pane'), NEW) }, async () => 'carry on')
          // the pane its new run goes in was opened while the old one was still open: nothing closed in between, and
          // herdr never saw the space empty, so the space with the worktree in it stayed
          expect(events).toEqual(['pane', `close ${OLD}`, `start ${NEW}`])
          // the same CLI resumes its own conversation there: the old run ended before --resume ran
          expect(started).toHaveLength(1)
          expect(started[0]).toMatchObject({ name: NAME, kind: c.kind, pane: NEW })
          expect(started[0].args.join(' ')).toContain(c.resume.join(' '))
        } finally {
          a.stop()
        }
      } finally {
        for (const spy of Object.values(s)) spy.mockRestore()
      }
    })
  }

  test('a chat with no pane of its own (a coordinator): its tab is opened in its space before the old pane closes', async () => {
    const s = spies()
    try {
      chat(CASES[2])
      const a = new Agents()
      try {
        await a.refresh()
        await a.restart({ key: KEY, name: NAME, kind: 'pi', cwd, workspace: 'T-166: keep the space', tab: 'Agent', env: {} })
        expect(events).toEqual(['tab w1', `close ${OLD}`, `start ${NEW}`])
        expect(started[0].pane).toBe(NEW)
      } finally {
        a.stop()
      }
    } finally {
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })

  test('a pane that cannot be opened ahead is opened by the start itself, as it always was', async () => {
    const s = spies()
    try {
      chat(CASES[2])
      const errors = spyOn(console, 'error').mockImplementation(() => undefined)
      const a = new Agents()
      let n = 0
      const pane = async () => {
        events.push('pane')
        if (!n++) throw new HerdrError('invalid_request', 'tab.create: no such folder')
        return NEW
      }
      try {
        await a.refresh()
        await a.restart({ key: KEY, name: NAME, kind: 'pi', cwd, workspace: 'T-166: keep the space', tab: 'Agent', env: {}, pane })
        // the run went in all the same, in the tab the start opened after the one ahead of it failed
        expect(events).toEqual(['pane', `close ${OLD}`, 'pane', `start ${NEW}`])
        expect(started[0].pane).toBe(NEW)
        expect(errors.mock.calls.flat().join(' ')).toContain('ahead of its restart')
      } finally {
        errors.mockRestore()
        a.stop()
      }
    } finally {
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })

  test('a chat whose folder moved (a coordinator, its repo elsewhere now): its tab is opened in the new folder', async () => {
    const s = spies()
    const moved = tmp('agent-restart-moved')
    try {
      chat(CASES[2])
      const a = new Agents()
      try {
        await a.refresh()
        // its record is where it ran before; the restart puts it in the folder the repo is in now
        await a.restart({ key: KEY, name: NAME, kind: 'pi', cwd: moved, workspace: 'T-166: keep the space', tab: 'Agent', env: {} })
        expect(tabDirs).toEqual([moved])
        expect(events).toEqual(['tab w1', `close ${OLD}`, `start ${NEW}`])
      } finally {
        a.stop()
      }
    } finally {
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })

  test('a start that never gets to its pane closes the tab it opened and never used', async () => {
    const s = spies()
    const file = join(tmp('agent-restart-file'), 'not-a-folder')
    writeFileSync(file, 'x')
    try {
      chat(CASES[2])
      const a = new Agents()
      try {
        await a.refresh()
        // a folder that cannot be made (a file is in the way) fails the start before it takes the pane it opened
        await expect(a.restart({ key: KEY, name: NAME, kind: 'pi', cwd: join(file, 'work'), workspace: 'T-166: keep the space', tab: 'Agent', env: {} })).rejects.toThrow()
        // the tab opened for it is closed again, rather than left empty in the space for good
        expect(events).toEqual(['tab w1', `close ${OLD}`, `close ${NEW}`])
      } finally {
        a.stop()
      }
    } finally {
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })
})
