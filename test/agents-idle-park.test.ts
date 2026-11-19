// Idle agents past Settings (agents.idleClose) are parked (SHE-72): their pane and CLI close, what they left running
// is reaped with them (the close reap), their chat says a message starts them again, and the record keeps that they
// were parked. Never one at work, blocked, asking (a card or its CLI's own question), with background work left
// running, with a message waiting to go in, whose task's review round or way into main holds it, or one with no
// session to come back to; coordinators only when Settings say so (off by default). The sweep reads a LiveSource on a
// home of its own, with herdr a socket that isn't there; what herdr is asked of is caught where it goes, and no CLI
// runs. The park-and-resume round trip is the real Agents class per kind: parked, then started again on its session,
// with its model and effort, by the args each CLI is handed.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { closeSync, mkdirSync, openSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import type { TaskRec } from '../server/live/engine/engine.ts'

const H = 3_600_000
const KINDS = ['claude', 'codex', 'pi', 'opencode', 'agy'] as const

let n = 0
let src: import('../server/live/source.ts').LiveSource
let home = ''
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { herdr, HerdrError } = await import('../server/live/herdr.ts')
const { Agents } = await import('../server/live/agents.ts')

let closeSpy: ReturnType<typeof spyOn> | undefined

beforeEach(() => {
  home = tmp(`agents-idle-park-${++n}`)
  process.env.SHEPHERDR_HOME = home
  process.env.HERDR_SOCKET_PATH = join(home, 'no-herdr.sock')
  delete process.env.SHEPHERDR_MAIN
  src = new LiveSource()
  // herdr is out of reach all through: a look at it answers nothing, so what the sweep decides comes from the records
  // alone, and the close is caught where it goes
  spyOn(src.agents, 'refresh').mockResolvedValue(undefined as never)
  src.agents.reachable = true
  const panes: string[] = []
  closeSpy = spyOn(herdr, 'closePane').mockImplementation((async (pane: string) => {
    panes.push(pane)
  }) as never)
  ;(src as unknown as { closedPanes?: string[] }).closedPanes = panes
})

afterEach(() => {
  closeSpy?.mockRestore()
  closeSpy = undefined
})

afterAll(() => src?.stop())

/** a log file whose last write was this long ago: the agent's last sign of life */
const logAgo = (file: string, ago: number) => {
  const f = join(home, 'logs', file)
  mkdirSync(join(home, 'logs'), { recursive: true })
  closeSync(openSync(f, 'a'))
  utimesSync(f, new Date(Date.now() - ago), new Date(Date.now() - ago))
  return f
}

/** a record of one agent, live in herdr's view at a status, idle since its log's last write */
function agent(key: string, kind: string, o: { status?: string; idleAgo?: number; sessionId?: string | null; log?: string; name?: string } = {}) {
  const idle = o.idleAgo ?? 4 * H
  const sessionId = o.sessionId === undefined ? `${key.replace(/[^a-z0-9-]/gi, '')}-sess` : o.sessionId
  const name = o.name ?? Agents.nameFor(key)
  const logs = o.log ? [logAgo(o.log, idle)] : []
  src.agents.records[key] = {
    key,
    name,
    kind,
    cwd: home,
    workspace: 'idle-park',
    started: Date.now() - idle - H,
    logs,
    ...(sessionId ? { sessionId } : {}),
  } as never
  if (o.status !== 'gone') src.agents.live.set(name, { pane_id: `${name}-pane`, name, agent_status: o.status ?? 'idle' } as never)
  return src.agents.records[key] as import('../server/live/agents.ts').AgentRecord
}

const closedPanes = () => (src as unknown as { closedPanes?: string[] }).closedPanes ?? []

/** a task of this machine, so the sweep can read it (its project is no space: its settings are the machine's) */
let m = 0
const aTask = (id: string, set: Partial<TaskRec> = {}) => {
  const t = { id, n: ++m, project: 'nowhere', title: 'Idle', desc: '', by: 'test', created: Date.now(), updated: Date.now(), ...set } as TaskRec
  src.engine.tasks.push(t)
  return t
}

/** one agent of each kind, idle far past the setting, each in its own task chat; codex's session is its log's name */
const fiveIdle = () =>
  KINDS.map((kind, i) => {
    const id = `IDLE-K${i}`
    const sessionId = kind === 'codex' ? 'c0de0000-0000-4000-8000-000000000004' : `${kind}-sess`
    return agent(`${id}/Agent`, kind, { sessionId, log: kind === 'codex' ? `${sessionId}.jsonl` : `${id}.jsonl` })
  })

describe('the idle sweep parks', () => {
  test('each CLI: an idle agent past the setting is parked, closed, and its chat says a message starts it again', async () => {
    expect(src.settings.set('agents.idleClose', '120', 'machine').ok).toBe(true)
    const recs = fiveIdle()
    const parked = await src.parkIdleAgents()
    expect(parked.sort()).toEqual(recs.map((r) => r.key).sort())
    for (const r of recs) {
      expect(r.finished).toBe(true)
      expect(typeof r.parked).toBe('number')
      // its pane closed (what it left running is reaped with it), and its chat says the way back in, as a card of
      // Shepherdr's own, never as a word in the agent's voice
      expect(closedPanes()).toContain(`${r.name}-pane`)
      const line = src.chats.log(r.key).posted.find((p) => p.id.startsWith('parked:'))
      expect(line?.card?.text).toContain('starts it again on the same session')
      expect(line?.text).toBeUndefined()
      // herdr has it no more: gone, and the message that starts it again is the way back in
      src.agents.live.delete(r.name)
      expect(src.agents.status(r.key)).toBe('gone')
    }
    // shepherdr status counts them
    expect(src.parkedCount()).toBe(KINDS.length)
    const out = await src.cli(['status'], {})
    expect(out.out).toContain(`${KINDS.length} agents parked`)
  })

  // one test per CLI (the fork's rule): a parked agent of that kind starts again on its session, with its model and
  // effort, by the args that CLI is handed
  for (const [i, kind] of KINDS.entries())
    test(`a parked ${kind} agent starts again on its session, with its model and effort`, async () => {
      const a = new Agents()
      spyOn(a, 'refresh').mockResolvedValue(undefined as never)
      const key = `RES-${i}/Agent`
      const name = Agents.nameFor(key)
      const sessionId = kind === 'codex' ? 'c0de0000-0000-4000-8000-000000000004' : `${kind}-sess`
      a.records[key] = {
        key,
        name,
        kind,
        cwd: home,
        workspace: 'res',
        started: 0,
        logs: [logAgo(kind === 'codex' ? `${sessionId}.jsonl` : `${key.replace(/[^a-z0-9-]/gi, '')}.jsonl`, 5 * H)],
        sessionId,
        model: 'm1',
        effort: 'high',
      } as never
      a.live.set(name, { pane_id: `${name}-pane`, name, agent_status: 'idle' } as never)
      const closed: string[] = []
      const close = spyOn(herdr, 'closePane').mockImplementation((async (pane: string) => {
        closed.push(pane)
      }) as never)
      // parked: the same end a finish gives it, marked as a park
      await a.park(key)
      expect(a.records[key].finished).toBe(true)
      expect(typeof a.records[key].parked).toBe('number')
      expect(closed).toEqual([`${name}-pane`])
      // no longer live: herdr has it no more, so the next message starts it
      a.live.delete(name)
      // herdr is stood in for at the workspace and the start, and the start refuses, so no CLI is opened; the args
      // are what the test reads
      const started: string[][] = []
      const ws = spyOn(herdr, 'workspaces').mockResolvedValue([{ workspace_id: 'w9', label: 'res', tab_count: 1 }] as never)
      const tab = spyOn(herdr, 'createTab').mockResolvedValue({ root_pane: { pane_id: 'p9' } } as never)
      const start = spyOn(herdr, 'start').mockImplementation((async (_name: string, _kind: string, _pane: string, args: string[]) => {
        started.push([...args])
        throw new HerdrError('dropped', 'the test refuses every start')
      }) as never)
      try {
        await expect(a.ensure({ key, name, kind, cwd: home, workspace: 'res', model: 'm1', effort: 'high' })).rejects.toThrow('the test refuses every start')
        // the record is not a parked one any more: it is starting again
        expect(a.records[key].parked).toBeUndefined()
        const args = started[0]!
        if (kind === 'claude') {
          expect(args[0]).toBe('--resume')
          expect(args[1]).toBe(sessionId)
          expect(args[args.indexOf('--model') + 1]).toBe('m1')
          expect(args[args.indexOf('--effort') + 1]).toBe('high')
        } else if (kind === 'pi') {
          expect(args[args.indexOf('--session-id') + 1]).toBe(sessionId)
          expect(args[args.indexOf('--model') + 1]).toBe('m1')
          expect(args[args.indexOf('--thinking') + 1]).toBe('high')
        } else if (kind === 'codex') {
          expect(args[0]).toBe('resume')
          expect(args[1]).toBe(sessionId)
          expect(args[args.indexOf('-m') + 1]).toBe('m1')
          expect(args).toContain('model_reasoning_effort="high"')
        } else if (kind === 'opencode') {
          expect(args[args.indexOf('--session') + 1]).toBe(sessionId)
        } else {
          expect(args[args.indexOf('--conversation') + 1]).toBe(sessionId)
          expect(args[args.indexOf('--model') + 1]).toBe('m1')
        }
      } finally {
        for (const s of [close, ws, tab, start]) s.mockRestore()
      }
    })

  test('one still working, blocked, asking, with background work, or with a message waiting is never parked', async () => {
    expect(src.settings.set('agents.idleClose', '1', 'machine').ok).toBe(true)
    const working = agent('IDLE-W/Agent', 'claude', { status: 'working' })
    const blocked = agent('IDLE-B/Agent', 'pi', { status: 'blocked' })
    const asking = agent('IDLE-A/Agent', 'codex', { log: 'IDLE-A.jsonl' })
    src.chats.post(asking.key, { id: 'ask:idle-a', question: { id: 'ask:idle-a', kind: 'Choice', title: 'Which way?', items: [] } as never })
    const backgrounded = agent('IDLE-G/Agent', 'opencode', { log: 'IDLE-G.jsonl' })
    src.agents.background = () => 'shells'
    const queued = agent('IDLE-Q/Agent', 'agy', { log: 'IDLE-Q.jsonl' })
    src.agents.outbox.push({ id: 'o1', key: queued.key, text: 'carry on', at: Date.now() })
    // something went in to it five minutes ago: its answer may be on its way
    const nudged = agent('IDLE-U/Agent', 'claude', { log: 'IDLE-U.jsonl' })
    ;(src.agents as unknown as { typed: { id: string; key: string; text: string; at: number }[] }).typed.push({ id: 't1', key: nudged.key, text: 'carry on', at: Date.now() - 5 * 60_000 })
    try {
      expect(await src.parkIdleAgents()).toEqual([])
      for (const r of [working, blocked, asking, backgrounded, queued, nudged]) {
        expect(r.finished).toBeUndefined()
        expect(r.parked).toBeUndefined()
      }
    } finally {
      src.agents.background = undefined as never
      src.agents.outbox = src.agents.outbox.filter((o) => o.key !== queued.key)
      ;(src.agents as unknown as { typed: { id: string; key: string; text: string; at: number }[] }).typed = (src.agents as unknown as { typed: { id: string; key: string; text: string; at: number }[] }).typed.filter((o) => o.key !== nudged.key)
    }
  })

  test('a task its review round or its way into main holds is never parked', async () => {
    expect(src.settings.set('agents.idleClose', '1', 'machine').ok).toBe(true)
    const reviewed = agent('IDLE-R/Agent', 'claude', { log: 'IDLE-R.jsonl' })
    const review = aTask('IDLE-R')
    review.reviewWait = { since: Date.now() }
    const merging = agent('IDLE-M/Agent', 'pi', { log: 'IDLE-M.jsonl' })
    const merge = aTask('IDLE-M')
    merge.landing = { step: 'checks', at: Date.now() }
    expect(src.engine.machineryHoldsAgent(review)).toBe(true)
    expect(src.engine.machineryHoldsAgent(merge)).toBe(true)
    expect(await src.parkIdleAgents()).toEqual([])
    expect(reviewed.finished).toBeUndefined()
    expect(merging.finished).toBeUndefined()
  })

  test('not idle long enough, or a session it cannot come back to: left as it is', async () => {
    expect(src.settings.set('agents.idleClose', '120', 'machine').ok).toBe(true)
    const fresh = agent('IDLE-F/Agent', 'claude', { idleAgo: H, log: 'IDLE-F.jsonl' })
    // each CLI resumes by its own id: a record with none to resume by is left, whatever its logs say
    const noSessionPi = agent('IDLE-N/Agent', 'pi', { sessionId: null })
    const noSessionOpencode = agent('IDLE-O/Agent', 'opencode', { sessionId: null, log: 'IDLE-O.jsonl' })
    const noSessionAgy = agent('IDLE-Y/Agent', 'agy', { sessionId: null, log: 'IDLE-Y.jsonl' })
    const codexNoUuid = agent('IDLE-C/Agent', 'codex', { sessionId: 'not-a-uuid', log: 'plain-name.jsonl' })
    const freshStart = agent('IDLE-S/Agent', 'codex', { log: 'c0de0000-0000-4000-8000-000000000004.jsonl' })
    ;(freshStart as { fresh?: boolean }).fresh = true
    expect(await src.parkIdleAgents()).toEqual([])
    for (const r of [fresh, noSessionPi, noSessionOpencode, noSessionAgy, codexNoUuid, freshStart]) expect(r.finished).toBeUndefined()
  })

  test('off: nothing is parked', async () => {
    expect(src.settings.set('agents.idleClose', 'off', 'machine').ok).toBe(true)
    fiveIdle()
    expect(await src.parkIdleAgents()).toEqual([])
    expect(src.parkedCount()).toBe(0)
  })

  test('a log gone between the looks: its life is its start; a chat that is neither task nor coordinator is left', async () => {
    expect(src.settings.set('agents.idleClose', '120', 'machine').ok).toBe(true)
    // its log vanished (a mirror rewritten away): when it started is the last life it has, and that is long ago
    const gone = agent('IDLE-V/Agent', 'pi', { log: 'IDLE-V.jsonl' })
    rmSync(join(home, 'logs', 'IDLE-V.jsonl'))
    // a record left by a chat that is no task's and no place's: nothing here decides for it
    const stray = agent('stray-chat', 'claude', { log: 'stray.jsonl' })
    expect(await src.parkIdleAgents()).toEqual([gone.key])
    expect(gone.finished).toBe(true)
    expect(stray.finished).toBeUndefined()
  })
})

describe('coordinators', () => {
  test('never parked by default; parked when their setting says so, and their chat says it', async () => {
    const r = agent(placeId.home(), 'claude', { log: 'home.jsonl' })
    expect(src.places.coordinator(r.key)).toBeDefined()
    expect(await src.parkIdleAgents()).toEqual([])
    expect(r.finished).toBeUndefined()
    expect(src.settings.set('agents.idleCloseCoordinators', '120', 'machine').ok).toBe(true)
    expect(await src.parkIdleAgents()).toEqual([r.key])
    expect(r.finished).toBe(true)
    expect(src.chats.log(r.key).posted.find((p) => p.id.startsWith('parked:'))?.card?.text).toContain('starts it again')
  })
})

describe('the parked task row', () => {
  test('says it, not a wait only its next message answers', async () => {
    expect(src.settings.set('agents.idleClose', '1', 'machine').ok).toBe(true)
    const r = agent('IDLE-P/Agent', 'pi', { log: 'IDLE-P.jsonl' })
    const t = aTask('IDLE-P')
    await src.parkIdleAgents()
    expect(r.finished).toBe(true)
    // its agent at rest, the task waits on you as it did — but the row says parked, and the way back in
    expect(src.engine.statusOf(t)).toBe('need')
    expect(src.engine.subOf(t)).toContain('Parked')
    expect(src.engine.subOf(t)).toContain('a message starts it again')
  })
})
