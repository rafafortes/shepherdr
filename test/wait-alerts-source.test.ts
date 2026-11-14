// What your alert command is told of what waits on you (source.ts tellWaits, waitWords): a task's question with its space
// and task, and when the advisor answers for you; a plan, which the advisor never answers by itself; a coordinator's
// question, left out where its space's Notify is Off (a task's never). A real LiveSource, a herdr socket that isn't there,
// and the command caught at the one place it runs: nothing is run.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('wait-alerts-source')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { WaitAlerts } = await import('../server/live/wait-alerts.ts')
const { writeJson } = await import('../server/store.ts')
const { clockWords } = await import('../shared/when.ts')

const src = new LiveSource()
afterAll(() => src.stop())
const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'

/** what the command was run with */
let ran: { command: string; args: string[] }[] = []

beforeEach(() => {
  ran = []
  writeJson('wait-alerts.json', { waits: {} })
  src.waitAlerts = new WaitAlerts((command, args) => ran.push({ command, args }))
  src.engine.tasks.length = 0
  src.settings.set('alerts.command', '~/bin/notify', 'machine')
})

/** a space with the advisor set (answering after 2 min), and a task of it started as a real one is, its agent on a CLI */
async function world(name: string, kind = 'pi') {
  const dir = tmp('wait-alerts-repo')
  execSync(REPO, { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, name)
  for (const [k, v] of [['advisor.agent', 'pi'], ['advisor.after', '2 min']]) expect(src.settings.set(k, v, { space: p.name }).ok).toBe(true)
  const id = `WA-${Math.random().toString(36).slice(2, 6)}`
  src.engine.tasks.push({ id, n: 1, project: placeId.space(p.name), base: 'main', branch: 'main', worktree: dir, title: 'Pick a store', desc: 'Keep the outbox somewhere.', by: 'test', created: Date.now(), updated: Date.now() - 60 * 60_000, told: 'work' } as never)
  const key = `${id}/Agent`
  src.agents.records[key] = { key, name: id, kind, cwd: dir, workspace: p.name, logs: [], started: Date.now() } as never
  return { p, id, key, coord: placeId.space(p.name) }
}

/** a choice card an agent asked, or a plan it waits on, posted at a time */
function card(key: string, id: string, title: string, labels: string[], at: number, kind: 'Form' | 'Plan' = 'Form') {
  src.chats.post(key, { id, at, question: { id, title, kind, choices: labels.map((label) => ({ label })), to: key } } as never)
}

describe('what your alert command is told', () => {
  test("a task's question: its space and task, its options, and when the advisor answers for you; once, after the delay", async () => {
    const w = await world('wa-question')
    const at = Date.now()
    card(w.key, 'ask:q1', 'Which store for the outbox?', ['SQLite', 'Postgres'], at)
    src.tellWaits(at)
    expect(ran).toEqual([])
    src.tellWaits(at + 10_000)
    src.tellWaits(at + 20_000)
    expect(ran).toHaveLength(1)
    const [title, body, key] = ran[0]!.args
    expect(ran[0]!.command).toBe('~/bin/notify')
    expect(title).toBe(`Shepherdr · ${w.id} · Which store for the outbox?`)
    const lines = body!.split('\n')
    expect(lines[0]).toBe(`wa-question · ${w.id}: Pick a store`)
    expect(lines[1]).toContain('SQLite')
    expect(lines.at(-1)).toBe(`If you don't answer, the advisor answers for you at ${clockWords(at + 120_000, at + 10_000, src.settings.zone())}.`)
    expect(key).toBe(`shepherdr-${w.key}_ask_q1-${at}`.replace(/[^A-Za-z0-9._-]+/g, '_'))
  })

  test('a plan: told, with no word of the advisor (it never answers one by itself)', async () => {
    const w = await world('wa-plan')
    const at = Date.now()
    card(w.key, 'plan:p1', 'Build the outbox', ['Approve', 'Change it'], at, 'Plan')
    src.tellWaits(at)
    src.tellWaits(at + 10_000)
    expect(ran).toHaveLength(1)
    expect(ran[0]!.args[0]).toBe(`Shepherdr · ${w.id} · Plan to approve`)
    expect(ran[0]!.args[1]).not.toContain('advisor')
  })

  test("a coordinator's question is told, unless its space's Notify is Off; its tasks' are told either way", async () => {
    const w = await world('wa-coord')
    // its task is not here: a task whose agent is not running needs you too (the last test)
    src.engine.tasks.length = 0
    const at = Date.now()
    card(w.coord, 'ask:c1', 'Merge both now?', ['Yes', 'No'], at)
    src.tellWaits(at)
    src.tellWaits(at + 10_000)
    expect(ran.map((r) => r.args[0])).toEqual(["Shepherdr · wa-coord's coordinator · Merge both now?"])
    expect(ran[0]!.args[1]!.split('\n')[0]).toBe('wa-coord · its coordinator')
    const m = await world('wa-muted')
    expect(src.settings.set('notify', 'Off', { space: m.p.name }).ok).toBe(true)
    card(m.coord, 'ask:c2', 'Muted?', ['Yes', 'No'], at)
    card(m.key, 'ask:t2', 'Which name?', ['A', 'B'], at)
    src.tellWaits(at + 20_000)
    src.tellWaits(at + 30_000)
    expect(ran.slice(1).map((r) => r.args[0])).toEqual([`Shepherdr · ${m.id} · Which name?`])
    src.settings.set('notify', null, { space: m.p.name })
  })

  test('with the command off nothing is told, and what waited then is not told once it is on', async () => {
    const w = await world('wa-off')
    src.settings.set('alerts.command', null, 'machine')
    const at = Date.now()
    card(w.key, 'ask:o1', 'Which?', ['A', 'B'], at)
    src.tellWaits(at)
    src.tellWaits(at + 60_000)
    src.settings.set('alerts.command', '~/bin/notify', 'machine')
    src.tellWaits(at + 70_000)
    expect(ran).toEqual([])
  })

  test("a wait with no card (a task whose agent is not running): what it waits with, under Needs you", async () => {
    const w = await world('wa-words')
    src.tellWaits(1000)
    src.tellWaits(11_000)
    const told = ran.filter((r) => r.args[0]!.includes(w.id))
    expect(told.map((r) => r.args[0])).toEqual([`Shepherdr · ${w.id} · Needs you`])
    const lines = told[0]!.args[1]!.split('\n')
    expect(lines[0]).toBe(`wa-words · ${w.id}: Pick a store`)
    expect(lines[1]).toBe(src.engine.subOf(src.engine.task(w.id)!, 'need'))
  })
})

describe("every CLI's agent: its waits are told the same way", () => {
  for (const kind of ['claude', 'codex', 'pi', 'opencode', 'agy'])
    test(`a ${kind} agent: a question it asked, and its CLI's own permission screen`, async () => {
      const w = await world(`wa-${kind}`, kind)
      const at = Date.now()
      // a question through Shepherdr (shepherdr ask, or Claude Code's and Codex's own question tools, read as cards)
      card(w.key, `ask:${kind}`, 'Which name?', ['A', 'B'], at)
      // its CLI's own screen, read from its terminal as every CLI's is (screen.ts): a permission to grant
      src.chats.post(w.key, { id: `menu:${kind}`, at, question: { id: `menu:${kind}`, kind: 'Form', title: 'Allow: rm -rf build', terminal: true, choices: [{ label: 'Yes' }, { label: 'No' }], to: w.key } } as never)
      src.tellWaits(at)
      src.tellWaits(at + 10_000)
      src.tellWaits(at + 20_000)
      const told = ran.filter((r) => r.args[0]!.includes(w.id)).map((r) => r.args[0])
      expect(told.sort()).toEqual([`Shepherdr · ${w.id} · Allow: rm -rf build`, `Shepherdr · ${w.id} · Which name?`])
      // the advisor answers the question, never a permission: only the question's message says when
      const advice = ran.filter((r) => r.args[0]!.includes(w.id)).map((r) => r.args[1]!.includes('the advisor answers for you'))
      expect(advice.sort()).toEqual([false, true])
    })
})
