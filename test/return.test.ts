// When a model's provider runs out for good (out of allowance, signed out, a model that is not there) a backup takes
// that role's agent over, and it stays there: going back was a manual restart. Shepherdr remembers the takeover per
// role and space and asks the primary now and then whether it answers again — one card in each chat still on the
// backup, naming the way back, and nothing else. Never a switch. A real LiveSource, its agents' starts stubbed at the
// one place they start (no herdr here), a herdr socket that isn't there, and the probe stubbed at the one place it
// asks: no CLI is run, and no model is asked anything.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('return')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { FIRST_WAIT, LONGEST_WAIT, oneShot, probeHarness, wait } = await import('../server/live/return.ts')
type Retry = import('../server/live/retry.ts').Retry

const src = new LiveSource()
afterAll(() => src.stop())

const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'

/** the source's own coordinator path, which its retries call once an agent can't go on */
type CoordinatorSide = { coordinatorCantGoOn(key: string, r: Retry): Promise<void> }
const sides = src as unknown as CoordinatorSide

/** a probe ran: which harness it asked (nothing is asked of a real CLI here) */
const asked: string[] = []
/** whether the primary answers */
let answers = true
/** what was posted into a chat, by key: the cards, oldest first */
const cards = (key: string) => src.chats.chat(key).messages.filter((m) => m.card).map((m) => m.card!.text)
/** the alerts this source raised */
let alerts: { title: string; body: string }[] = []

beforeEach(() => {
  asked.length = 0
  answers = true
  alerts = []
  // each test starts with nothing on a backup: what a test before it kept says nothing of this one
  for (const o of src.returns.list()) src.returns.forget(o.role, o.space)
  src.engine.tasks.length = 0
  for (const k of Object.keys(src.agents.records)) delete src.agents.records[k]
  src.engine.installed = () => true
  src.alert = ((a: { title: string; body: string }) => alerts.push(a)) as never
  src.returns.probe = async (h: { kind: string; model?: string }) => {
    asked.push(`${h.kind}${h.model ? ` ${h.model}` : ''}`)
    return { ok: answers, said: answers ? 'ok' : 'Out of allowance until 5pm' }
  }
})

/** a space of its own, with the agents' starts stubbed: what a backup would have started, and nothing in herdr */
async function space(name: string) {
  const dir = tmp('return-repo')
  execSync(REPO, { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, name)
  const before = src.agents.ensure
  const restart = src.agents.restart
  src.agents.ensure = (async () => null) as never
  src.agents.restart = (async () => null) as never
  const done = () => {
    src.agents.ensure = before
    src.agents.restart = restart
  }
  return { src, p, key: placeId.space(p.name), done }
}

let n = 0
/** a task of that space, as its start leaves it: its agent running `on`, and — after a lasting takeover — on a backup */
function task(project: string, on: string, tookOver?: { from: string; why?: string }) {
  const id = `RTN-${++n}`
  src.engine.tasks.push({ id, n, project: placeId.space(project), base: 'main', title: `Say hello ${n}`, desc: 'Add hello.txt.', by: 'test', created: Date.now(), updated: Date.now(), told: 'work', ...(tookOver ? { tookOver: { from: tookOver.from, to: on, why: tookOver.why ?? 'out of allowance until 5pm', at: Date.now() } } : {}) } as never)
  const key = `${id}/Agent`
  src.agents.records[key] = { key, name: id, kind: on, cwd: tmp('return-wt'), workspace: project, logs: [], started: Date.now() } as never
  return { t: src.engine.tasks.find((x) => x.id === id)!, id, key }
}

/** a space's coordinator, as its start leaves it */
function coordinator(key: string, on: string) {
  src.agents.records[key] = { key, name: 'shep', kind: on, cwd: tmp('return-coord'), logs: [], started: Date.now() } as never
}

/** a time after every wait a note sets: a probe is never asked at boot */
const later = () => Date.now() + 2 * 3_600_000

/** what cut a coordinator off, as retry.ts hands it over */
const cut = (key: string, reason: string, lasting: boolean) => sides.coordinatorCantGoOn(key, { cut: `e-${reason}`, tries: 1, reason, words: `${reason} (the provider's words)`, over: true, ...(lasting ? { lasting: true } : {}) })

describe('what ran out is remembered', () => {
  test('a lasting takeover is kept, per role and space: the primary and what took over', async () => {
    const s = await space('lasting')
    try {
      expect(s.src.settings.set('task.fallback', 'codex', { space: s.p.name }).ok).toBe(true)
      const { t, key } = task(s.p.name, 'claude')
      t.worktree = tmp('return-wt')
      await s.src.engine.cantGoOn(t.id, 'Out of allowance until 5pm', true)
      // what Settings named as the primary, and the harness the backup took it over on
      expect(s.src.returns.get('task', s.p.name)).toMatchObject({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'out of allowance until 5pm' })
      // kept across a restart, like retries.json
      const again = new (await import('../server/live/return.ts')).Returns()
      expect(again.get('task', s.p.name)).toMatchObject({ role: 'task', primary: { kind: 'claude' }, to: { kind: 'codex' } })
      expect(key).toBe(`${t.id}/Agent`)
      // a coordinator's, the same way: its own role's record, apart from the tasks'
      expect(s.src.settings.set('coordinator.fallback', 'codex', { space: s.p.name }).ok).toBe(true)
      coordinator(s.key, 'claude')
      await cut(s.key, 'Signed out', true)
      expect(s.src.returns.get('coordinator', s.p.name)).toMatchObject({ role: 'coordinator', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out' })
    } finally {
      for (const k of ['task.fallback', 'coordinator.fallback']) s.src.settings.set(k, null, { space: s.p.name })
      s.done()
    }
  })

  test('a takeover an error that passes by itself led to is never kept', async () => {
    const s = await space('passing')
    try {
      expect(s.src.settings.set('task.fallback', 'codex', { space: s.p.name }).ok).toBe(true)
      const { t } = task(s.p.name, 'claude')
      t.worktree = tmp('return-wt')
      // five tries over fifteen minutes, then a backup: waiting could have fixed it, so there is nothing to watch
      await s.src.engine.cantGoOn(t.id, 'Provider overloaded, still after 5 tries')
      expect(t.tookOver).toMatchObject({ to: 'codex' })
      expect(s.src.returns.list()).toEqual([])
      // a coordinator's, the same way
      coordinator(s.key, 'claude')
      expect(s.src.settings.set('coordinator.fallback', 'claude', { space: s.p.name }).ok).toBe(true)
      await cut(s.key, 'Provider overloaded, still after 5 tries', false)
      expect(s.src.returns.list()).toEqual([])
    } finally {
      for (const k of ['task.fallback', 'coordinator.fallback']) s.src.settings.set(k, null, { space: s.p.name })
      s.done()
    }
  })
})

describe('when the primary answers again', () => {
  test("one card per chat still on the backup, each naming its own way back, and none the second time", async () => {
    const s = await space('back-tasks')
    try {
      expect(s.src.settings.set('task.fallback', 'codex', { space: s.p.name }).ok).toBe(true)
      const a = task(s.p.name, 'codex', { from: 'claude' })
      const b = task(s.p.name, 'codex', { from: 'claude' })
      // a third that went back already: it runs the primary again, so nothing is said to it
      const c = task(s.p.name, 'claude', { from: 'claude' })
      coordinator(s.key, 'codex')
      // what the two takeaways left (test above), due after their wait
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'out of allowance until 5pm', at: Date.now() - FIRST_WAIT * 2 })
      s.src.returns.note({ role: 'coordinator', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'out of allowance until 5pm', at: Date.now() - FIRST_WAIT * 2 })
      await s.src.watchReturns(later())
      // the primary was asked, one probe at a time, and answered
      expect(asked).toEqual(['claude', 'claude'])
      expect(cards(a.key)).toEqual([`The primary model answers again: Claude Code. ${a.id} still runs on its backup (Codex): restart it to go back — shepherdr restart ${a.id}, or ⋯ → Restart agent in its chat. Nothing was switched.`])
      expect(cards(b.key)).toEqual([`The primary model answers again: Claude Code. ${b.id} still runs on its backup (Codex): restart it to go back — shepherdr restart ${b.id}, or ⋯ → Restart agent in its chat. Nothing was switched.`])
      expect(cards(s.key)).toEqual([`The primary model answers again: Claude Code. ${s.p.name}'s coordinator still runs on its backup (Codex): restart it to go back — shepherdr restart ${s.p.name}, or ⋯ → Restart agent in its chat. Nothing was switched.`])
      // the one that went back already hears nothing
      expect(cards(c.key)).toEqual([])
      expect(alerts.map((a) => a.title)).toEqual(['The primary model answers again', 'The primary model answers again'])
      // a primary that keeps answering posts nothing more
      await s.src.watchReturns(later() + 3_600_000)
      expect(asked).toEqual(['claude', 'claude'])
      expect(cards(a.key)).toHaveLength(1)
      expect(cards(s.key)).toHaveLength(1)
    } finally {
      s.src.settings.set('task.fallback', null, { space: s.p.name })
      s.done()
    }
  })

  test("the reviewer's primary comes back: one card in its space, naming the reviewer and its setting", async () => {
    const s = await space('back-reviewer')
    try {
      // Codex reviews on GPT-6-Sol, pi is the backup reviewer: while one is set, the primary reviewer is what is asked
      expect(s.src.settings.set('reviewer.model', 'GPT-6-Sol', { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('reviewer.fallback', 'pi', { space: s.p.name }).ok).toBe(true)
      coordinator(s.key, 'claude')
      await s.src.watchReturns(later())
      expect(asked).toEqual(['codex gpt-6-sol'])
      const [text] = cards(s.key)
      expect(text).toContain('The primary model answers again: Codex (GPT-6-Sol).')
      expect(text).toContain('Reviews still fall back to pi (the backup reviewer, reviewer.fallbackModel)')
      expect(text).toContain('shepherdr set reviewer.model gpt-6-sol')
      // nothing was started, and no setting was written: a reviewer is never Shepherdr's to start
      expect(s.src.settings.get('reviewer.fallback', s.p.name)).toBe('pi')
      await s.src.watchReturns(later() + 3_600_000)
      expect(cards(s.key)).toHaveLength(1)
    } finally {
      for (const k of ['reviewer.fallback', 'reviewer.model']) s.src.settings.set(k, null, { space: s.p.name })
      s.done()
    }
  })

  test('a reviewer whose backup is the same harness is never asked', async () => {
    const s = await space('back-same')
    try {
      expect(s.src.settings.set('reviewer.fallback', 'codex', { space: s.p.name }).ok).toBe(true)
      coordinator(s.key, 'claude')
      await s.src.watchReturns(later())
      expect(asked).toEqual([])
      expect(cards(s.key)).toEqual([])
      expect(s.src.returns.list()).toEqual([])
    } finally {
      s.src.settings.set('reviewer.fallback', null, { space: s.p.name })
      s.done()
    }
  })
})

describe('when the primary still does not answer', () => {
  test('nothing is posted, nothing alerts, and the wait doubles up to a few hours', async () => {
    const s = await space('back-fails')
    try {
      answers = false
      const a = task(s.p.name, 'codex', { from: 'claude' })
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: Date.now() - FIRST_WAIT * 2 })
      const now = later()
      await s.src.watchReturns(now)
      expect(asked).toEqual(['claude'])
      // its own failure is silent: no card, no alert, and its words nowhere
      expect(cards(a.key)).toEqual([])
      expect(alerts).toEqual([])
      const one = s.src.returns.get('task', s.p.name)!
      expect(one.back).toBeUndefined()
      expect(one.tries).toBe(1)
      expect(one.due! - now).toBeGreaterThanOrEqual(FIRST_WAIT * 2 * 0.8)
      expect(one.due! - now).toBeLessThanOrEqual(FIRST_WAIT * 2 * 1.2)
      const first = one.due!
      // asked again only once its wait is over, and then twice as long
      await s.src.watchReturns(now + FIRST_WAIT)
      expect(asked).toEqual(['claude'])
      await s.src.watchReturns(first)
      expect(asked).toEqual(['claude', 'claude'])
      const second = s.src.returns.get('task', s.p.name)!
      expect(second.tries).toBe(2)
      expect(second.due! - first).toBeGreaterThanOrEqual(FIRST_WAIT * 4 * 0.8)
      expect(second.back).toBeUndefined()
    } finally {
      s.done()
    }
  })

  test('the wait never grows past a few hours', () => {
    expect(wait(0)).toBeGreaterThanOrEqual(FIRST_WAIT * 0.8)
    expect(wait(0)).toBeLessThanOrEqual(FIRST_WAIT * 1.2)
    expect(wait(20)).toBeGreaterThanOrEqual(LONGEST_WAIT * 0.8)
    expect(wait(20)).toBeLessThanOrEqual(LONGEST_WAIT * 1.2)
    // a fifth either side, never the same moment for two roles
    expect(wait(0, 0)).toBe(FIRST_WAIT * 0.8)
    expect(wait(0, 1)).toBe(FIRST_WAIT * 1.2)
  })
})

describe('what is never asked', () => {
  test('the setting off: no probe at all', async () => {
    const s = await space('back-off')
    try {
      expect(s.src.settings.set('backup.watchReturn', 'off', { space: s.p.name }).ok).toBe(true)
      const a = task(s.p.name, 'codex', { from: 'claude' })
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: Date.now() - FIRST_WAIT * 2 })
      await s.src.watchReturns(later())
      expect(asked).toEqual([])
      expect(cards(a.key)).toEqual([])
      expect(alerts).toEqual([])
      // on again, and it asks
      expect(s.src.settings.set('backup.watchReturn', null, { space: s.p.name }).ok).toBe(true)
      await s.src.watchReturns(later())
      expect(asked).toEqual(['claude'])
    } finally {
      s.src.settings.set('backup.watchReturn', null, { space: s.p.name })
      s.done()
    }
  })

  test("a CLI this machine doesn't have is never asked", async () => {
    const s = await space('back-missing')
    try {
      const a = task(s.p.name, 'codex', { from: 'codex' })
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: Date.now() - FIRST_WAIT * 2 })
      src.engine.installed = (kind) => kind !== 'claude'
      await s.src.watchReturns(later())
      expect(asked).toEqual([])
      expect(cards(a.key)).toEqual([])
    } finally {
      s.done()
    }
  })

  test('a chat that is not on the backup any more is forgotten, never asked about', async () => {
    const s = await space('back-gone')
    try {
      const a = task(s.p.name, 'claude', { from: 'claude' })
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: Date.now() - FIRST_WAIT * 2 })
      await s.src.watchReturns(later())
      expect(asked).toEqual([])
      expect(cards(a.key)).toEqual([])
      // nothing is on that backup any more: there is nothing to come back to
      expect(s.src.returns.get('task', s.p.name)).toBeUndefined()
    } finally {
      s.done()
    }
  })

  test('a CLI Shepherdr has no silent one-shot for is never asked', () => {
    expect(oneShot({ kind: 'claude' })).toContain('-p')
    expect(oneShot({ kind: 'pi' })).toContain('--no-tools')
    expect(oneShot({ kind: 'opencode' })).toBeUndefined()
  })

  test('the demo world never runs a real probe against a real provider', async () => {
    process.env.SHEPHERDR_SOURCE = 'demo'
    try {
      // nothing is spawned, and no CLI is asked anything: the demo's world is a fiction of its own
      expect(await probeHarness({ kind: 'claude' })).toEqual({ ok: false, said: 'the demo world never probes' })
    } finally {
      delete process.env.SHEPHERDR_SOURCE
    }
  })
})
