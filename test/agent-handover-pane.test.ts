// A hand-over (restart to another CLI, backup takeover, a stop and relaunch) must not leave the old agent's pane as the
// task's agent: herdr can list two agents under one name, and a CLI that exited leaves its pane as a plain shell. Status,
// menus and starts are read from the pane the record says this chat last launched, and the older pane is retired when it
// holds nothing the person typed (SHE-185/184/182). The same path runs for every CLI; each gets its own cases here.
import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('agent-handover-pane')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'herdr.sock')
// a failed launch fails here and now, rather than after the start loop's minutes of backoff
process.env.SHEPHERDR_START_RETRY_MS = ''
const { Agents } = await import('../server/live/agents.ts')
const { herdr, HerdrError } = await import('../server/live/herdr.ts')
const { writeJson } = await import('../server/store.ts')
const { barePrompt } = await import('../server/live/agent-process.ts')
const { Engine } = await import('../server/live/engine/engine.ts')
const { Places } = await import('../server/live/places.ts')
const { Settings } = await import('../server/live/settings.ts')
const { fakeHerdr } = await import('./fake-herdr.ts')
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

const KEY = 'T-186/Agent'
const NAME = 'shep-t-186'
const WS = 'T-186: keep'
const OLD = 'w1:p1'
const NEW = 'w1:p2'
const cwd = tmp('agent-handover-cwd')
const CLIS = ['claude', 'codex', 'pi', 'opencode', 'agy']

type Pane = { id: string; ws: string; text: string; idle: boolean }
let panes: Map<string, Pane>
let listed: AgentInfo[]
let events: string[]
let started: { name: string; kind: string; pane: string; args: string[] }[]
let seq: number
let failStart = false
let spies: Record<string, { mockRestore(): void }> = {}

afterEach(() => {
  for (const spy of Object.values(spies)) spy.mockRestore()
  spies = {}
})

const info = (pane: string, kind: string, status: AgentInfo['agent_status'], name = NAME): AgentInfo =>
  ({ agent: kind, agent_status: status, name, pane_id: pane, tab_id: 't1', workspace_id: 'w1', cwd, launch_pending: false }) as AgentInfo

/** herdr standing in: the old pane is a shell after its CLI exited, the new tab holds the run coming in */
function fake() {
  panes = new Map([[OLD, { id: OLD, ws: 'w1', text: '$ ', idle: true }]])
  listed = []
  events = []
  started = []
  seq = 1
  failStart = false
  spies = {
    agents: spyOn(herdr, 'agents').mockImplementation(async () => listed.map((a) => ({ ...a }))),
    start: spyOn(herdr, 'start').mockImplementation(async (name: string, kind: string, pane: string, args: string[] = []) => {
      events.push(`start ${pane}`)
      if (failStart) throw new HerdrError('closed', 'OpenCode is down')
      started.push({ name, kind, pane, args })
      const a = info(pane, kind, 'working')
      const at = listed.findIndex((x) => x.name === name && x.pane_id === pane)
      if (at >= 0) listed[at] = a
      else listed.push(a)
      return { agent: a } as never
    }),
    processInfo: spyOn(herdr, 'processInfo').mockResolvedValue({} as never),
    paneIdle: spyOn(herdr, 'paneIdle').mockImplementation(async (p: string) => panes.get(p)?.idle ?? false),
    closePane: spyOn(herdr, 'closePane').mockImplementation(async (p: string) => {
      events.push(`close ${p}`)
      panes.delete(p)
      listed = listed.filter((a) => a.pane_id !== p)
    }),
    createTab: spyOn(herdr, 'createTab').mockImplementation(async (ws: string) => {
      const id = `w1:p${++seq}`
      panes.set(id, { id, ws, text: '$ ', idle: true })
      events.push(`tab ${ws}`)
      return { tab: { tab_id: 't2' }, root_pane: { pane_id: id } } as never
    }),
    workspaces: spyOn(herdr, 'workspaces').mockResolvedValue([{ workspace_id: 'w1', label: WS }] as never),
    createWorkspace: spyOn(herdr, 'createWorkspace').mockImplementation(async (label: string) => {
      events.push(`workspace ${label}`)
      const id = `w1:p${++seq}`
      panes.set(id, { id, ws: 'w1', text: '$ ', idle: true })
      return { workspace: { workspace_id: 'w1', label }, root_pane: { pane_id: id } } as never
    }),
    visible: spyOn(herdr, 'visible').mockImplementation(async (p: string) => panes.get(p)?.text ?? ''),
  }
  return spies
}

/** the chat as it was before the hand-over: its last run was in the old pane, which herdr no longer lists */
function record(kind: string, lastPane = OLD) {
  writeJson('agents.json', { [KEY]: { key: KEY, name: NAME, kind, cwd, workspace: WS, tab: 'Agent', logs: [], started: Date.now() - 60_000, lastPane } })
  writeJson('outbox.json', [])
}

const spec = (kind: string) => ({ key: KEY, name: NAME, kind, cwd, workspace: WS, tab: 'Agent', env: {} })

describe('a shell screen with nothing typed at its prompt', () => {
  test('is told by its last line, not by words after it', () => {
    expect(barePrompt('last command\nmaybe@example:~$ ')).toBe(true)
    expect(barePrompt('~/work ❯ ')).toBe(true)
    expect(barePrompt('root@host#')).toBe(true)
    expect(barePrompt('$ ')).toBe(true)
    expect(barePrompt('user@host:~$ echo hi >')).toBe(false)
    expect(barePrompt('echo hi >')).toBe(false)
    expect(barePrompt('user@host:~$ echo $')).toBe(false)
    expect(barePrompt('user@host:~$ ls #')).toBe(false)
    expect(barePrompt('user@host:~$ git status')).toBe(false)
    expect(barePrompt('Do you want to continue? [y/n]')).toBe(false)
    expect(barePrompt('')).toBe(false)
  })
})

describe('a restart to another CLI', () => {
  for (const [i, from] of CLIS.entries()) {
    const next = CLIS[(i + 1) % CLIS.length] ?? from
    for (const to of [next, from]) {
      const same = to === from
      test(`${from} → ${to} (${same ? 'its own session' : 'a takeover'}): the old pane goes, status comes from the new one`, async () => {
        const s = fake()
        record(from)
        const a = new Agents()
        try {
          await a.refresh()
          expect(a.status(KEY)).toBe('gone')
          await a.restart(spec(to), async () => 'carry on')
          expect(a.info(KEY)?.pane_id).toBe(NEW)
          expect(a.record(KEY)?.lastPane).toBe(NEW)
          expect(a.status(KEY)).toBe('working')
          expect(started).toHaveLength(1)
          expect(started[0]).toMatchObject({ kind: to, pane: NEW })
          // the old pane was retired once the new run was up, and never read as the task's agent
          expect(events).toEqual(['tab w1', `start ${NEW}`, `close ${OLD}`])
          expect(panes.has(OLD)).toBe(false)
          expect(a.outbox.some((o) => o.key === KEY && o.text.includes('carry on'))).toBe(true)
        } finally {
          a.stop()
          for (const spy of Object.values(s)) spy.mockRestore()
        }
      })
    }
  }
})

describe('a backup taking over, or a stop followed by a relaunch', () => {
  for (const kind of CLIS) {
    test(`${kind}: a launch that took over the chat retires the old pane and keeps one agent`, async () => {
      const s = fake()
      record(kind)
      const a = new Agents()
      try {
        await a.refresh()
        // cantGoOn/start: a launch with no prior stop, as a backup taking over (engine.ts launch)
        await a.ensure({ ...spec(kind), first: 'handed over' })
        expect(a.info(KEY)?.pane_id).toBe(NEW)
        expect(a.record(KEY)?.lastPane).toBe(NEW)
        expect(a.status(KEY)).toBe('working')
        expect(events).toEqual(['tab w1', `start ${NEW}`, `close ${OLD}`])
        expect(listed).toHaveLength(1)
        expect(a.outbox.some((o) => o.key === KEY && o.text.includes('handed over'))).toBe(true)
      } finally {
        a.stop()
        for (const spy of Object.values(s)) spy.mockRestore()
      }
    })

    test(`${kind}: a failed launch closes its pane, so the retry leaves one agent`, async () => {
      const s = fake()
      record(kind)
      const a = new Agents()
      const errors = spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        await a.refresh()
        // a call herdr dropped is not retried by the start loop, so this is one failed launch rather than a slow one
        failStart = true
        await expect(a.ensure(spec(kind))).rejects.toThrow('OpenCode is down')
        failStart = false
        // its pane is gone and the record no longer points at a run that never came up
        expect(events).toContain(`close ${NEW}`)
        expect(a.record(KEY)?.lastPane).toBeUndefined()
        expect(panes.has(NEW)).toBe(false)
        // the retry opens one fresh pane; the dead first launch is not beside it
        events.length = 0
        await a.ensure(spec(kind))
        const pane = a.info(KEY)?.pane_id
        expect(a.record(KEY)?.lastPane).toBe(pane)
        expect(listed).toHaveLength(1)
        expect(a.status(KEY)).toBe('working')
        expect(events).toContain(`close ${OLD}`)
        if (!pane) throw new Error('the retry never got a pane')
        expect([...panes.keys()]).toEqual([pane])
      } finally {
        errors.mockRestore()
        a.stop()
        for (const spy of Object.values(s)) spy.mockRestore()
      }
    })
  }
})

describe('an older pane is never read, and is only closed when it is provably ours and empty', () => {
  test('a blocked old pane beside a working new one cannot set Needs you', async () => {
    const s = fake()
    record('opencode', NEW)
    panes.set(NEW, { id: NEW, ws: 'w1', text: '$ ', idle: true })
    listed.push(info(OLD, 'opencode', 'blocked'), info(NEW, 'opencode', 'working'))
    const a = new Agents()
    try {
      await a.refresh()
      expect(a.info(KEY)?.pane_id).toBe(NEW)
      expect(a.status(KEY)).toBe('working')
      // herdr's list order is no guarantee: even listed last, the old pane stays out of status
      listed.reverse()
      await a.refresh()
      expect(a.info(KEY)?.pane_id).toBe(NEW)
      expect(a.status(KEY)).toBe('working')
    } finally {
      a.stop()
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })

  test('a pane herdr cannot name is no agent, even when it is the recorded pane', async () => {
    const s = fake()
    record('pi')
    listed.push(info(OLD, 'pi', 'unknown'))
    const a = new Agents()
    try {
      await a.refresh()
      expect(a.info(KEY)?.pane_id).toBe(OLD)
      expect(a.status(KEY)).toBe('gone')
    } finally {
      a.stop()
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })

  test('an ensure beside a same-name shell launches, never binding the route to the shell', async () => {
    const s = fake()
    record('pi', NEW)
    // herdr still lists the old pane under this chat's name, but the record says its run was in the new one
    listed.push(info(OLD, 'pi', 'unknown'))
    const a = new Agents()
    try {
      await a.refresh()
      expect(a.info(KEY)).toBeUndefined()
      await a.ensure(spec('pi'))
      expect(started).toHaveLength(1)
      expect(started[0].pane).toBe(NEW)
      expect(a.info(KEY)?.pane_id).toBe(NEW)
      expect(a.status(KEY)).toBe('working')
      expect(events).toContain(`close ${OLD}`)
      expect(listed).toHaveLength(1)
    } finally {
      a.stop()
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })

  test('a relaunch after a launch herdr dropped closes the recorded pane before the retry', async () => {
    const s = fake()
    record('opencode')
    const a = new Agents()
    try {
      await a.refresh()
      await a.relaunch(KEY, false, async () => a.ensure(spec('opencode')))
      expect(events).toEqual([`close ${OLD}`, 'tab w1', `start ${NEW}`])
      expect(a.info(KEY)?.pane_id).toBe(NEW)
      expect(a.record(KEY)?.lastPane).toBe(NEW)
      expect(listed).toHaveLength(1)
    } finally {
      a.stop()
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })

  test('a route that cannot be bound keeps the old pane for the next launch to retire', async () => {
    const s = fake()
    record('pi')
    const a = new Agents()
    let failBind = false
    const bind = spyOn(a as unknown as { bindRoute(): Promise<unknown> }, 'bindRoute').mockImplementation(async () => {
      if (failBind) throw new Error('routing failed')
    })
    try {
      await a.refresh()
      failBind = true
      await expect(a.ensure(spec('pi'))).rejects.toThrow('routing failed')
      failBind = false
      expect(a.record(KEY)?.lastPane).toBeUndefined()
      expect(a.record(KEY)?.superseded).toEqual([OLD])
      // its own pane was closed, and the next launch retires the one it took over from
      expect(events).toContain(`close ${NEW}`)
      events.length = 0
      await a.ensure(spec('pi'))
      expect(events).toContain(`close ${OLD}`)
      expect(a.info(KEY)?.pane_id).toBe(a.record(KEY)?.lastPane)
    } finally {
      bind.mockRestore()
      a.stop()
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })

  test('a prompt with words in it, or a pane with a program in it, is left alone', async () => {
    const s = fake()
    record('pi', NEW)
    panes.set(NEW, { id: NEW, ws: 'w1', text: '$ ', idle: true })
    const a = new Agents()
    const oldPane = panes.get(OLD)
    if (!oldPane) throw new Error('no old pane')
    try {
      await a.refresh()
      oldPane.text = '$ git status'
      await (a as unknown as { retire(key: string, panes: string[], keep: string): Promise<void> }).retire(KEY, [OLD, NEW], NEW)
      expect(panes.has(OLD)).toBe(true)
      oldPane.text = '$ '
      oldPane.idle = false
      await (a as unknown as { retire(key: string, panes: string[], keep: string): Promise<void> }).retire(KEY, [OLD], NEW)
      expect(panes.has(OLD)).toBe(true)
    } finally {
      a.stop()
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })
})

describe("a task's status during a hand-over", () => {
  test('stays Working while its new agent runs, even with an older blocked pane in the space', async () => {
    const s = fake()
    record('pi', NEW)
    panes.set(NEW, { id: NEW, ws: 'w1', text: '$ ', idle: true })
    listed.push(info(OLD, 'pi', 'blocked'), info(NEW, 'pi', 'working'))
    const agents = new Agents()
    const chats = {
      openCard: () => undefined,
      openQuestion: () => undefined,
      startMenuUp: () => false,
      lastReply: () => '',
      asksInTurn: () => false,
      menu: () => undefined,
      seen: () => [],
    }
    const repo = tmp('handover-repo')
    execSync('git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init', { cwd: repo, shell: '/bin/sh' })
    const places = new Places()
    const place = await places.add(repo, 'handover')
    const engine = new Engine(agents, chats as never, places, new Settings(), fakeHerdr().h as never)
    try {
      const t = engine.add({ project: place.name, title: 'Handover', desc: 'x', by: 'test', agent: { kind: 'pi' } })
      const key = `${t.id}/Agent`
      const rec = agents.record(KEY)
      if (!rec) throw new Error('no agent record')
      rec.key = key
      agents.records[key] = rec
      delete agents.records[KEY]
      ;(agents as unknown as { byName: Map<string, string> }).byName.set(rec.name, key)
      // this test is about status, not starting: clear the async start add() fired with the herdr stand-in
      ;(engine as unknown as { starting: Set<string> }).starting.clear()
      ;(engine as unknown as { briefing: Set<string> }).briefing.clear()
      t.worktree = cwd
      t.trouble = undefined
      t.todo = undefined
      t.told = 'work'
      await agents.refresh()
      expect(agents.status(key)).toBe('working')
      expect(engine.statusOf(t)).toBe('work')
      expect(engine.subOf(t)).not.toContain('Waits for your reply')
    } finally {
      engine.stop()
      agents.stop()
      for (const spy of Object.values(s)) spy.mockRestore()
    }
  })
})
