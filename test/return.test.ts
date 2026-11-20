// When a model's provider runs out for good (out of allowance, signed out, a model that is not there) a backup takes
// that role's agent over. Shepherdr remembers the takeover per role and space and asks the primary now and then whether
// it answers again. Going back (the default), each agent still on the backup starts again on what Settings name once it
// is idle; told (tell me), one card in each of those chats names the way back, and nothing switches. A real LiveSource,
// its agents' starts stubbed at the one place they start (no herdr here), a herdr socket that isn't there, and the probe
// stubbed at the one place it asks: no CLI is run, and no model is asked anything.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('return')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { FIRST_LOOK, LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { canProbe, FIRST_WAIT, FRESH, LONGEST_WAIT, MAX_RETURNS, QUIET, oneShot, probeHarness, wait } = await import('../server/live/return.ts')
const { resetOf, Retries } = await import('../server/live/retry.ts')
type Retry = import('../server/live/retry.ts').Retry

const src = new LiveSource()
// the way back as many at once as there are slots: starts spaced out (machine.startEvery) have a test of their own
src.settings.set('machine.startEvery', '0', 'machine')
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
const cards = (key: string) =>
  src.chats
    .chat(key)
    .messages.filter((m) => m.card)
    .map((m) => m.card!.text)
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
  // what the human is told is what most of these look at; going back by itself has its own describe below
  src.settings.set('backup.watchReturn', 'tell me')
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
  src.engine.tasks.push({
    id,
    n,
    project: placeId.space(project),
    base: 'main',
    title: `Say hello ${n}`,
    desc: 'Add hello.txt.',
    by: 'test',
    created: Date.now(),
    updated: Date.now(),
    told: 'work',
    ...(tookOver ? { tookOver: { from: tookOver.from, to: on, why: tookOver.why ?? 'out of allowance until 5pm', at: Date.now() } } : {}),
  } as never)
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
const cut = (key: string, reason: string, lasting: boolean) =>
  sides.coordinatorCantGoOn(key, { cut: `e-${reason}`, tries: 1, reason, words: `${reason} (the provider's words)`, over: true, ...(lasting ? { lasting: true } : {}) })

describe('what ran out is remembered', () => {
  test('retry.ts decides what is lasting: an error that passes by itself never is', () => {
    const seen: Retry[] = []
    // no waits: a passing error gives up at once, a lasting one the same, and the flag is what differs
    const retries = new Retries({ nudge: () => undefined, over: (_k: string, r: Retry) => seen.push(r), changed: () => undefined }, [])
    retries.seen('a', { id: 'e1', at: Date.now(), text: 'You have hit your usage limit: resets 5pm' })
    expect(seen[0]).toMatchObject({ over: true, lasting: true, reason: 'Out of allowance until 5pm' })
    retries.seen('b', { id: 'e2', at: Date.now(), text: 'Provider overloaded, please try again later' })
    expect(seen[1]).toMatchObject({ over: true })
    expect(seen[1].lasting).toBeUndefined()
    retries.seen('c', { id: 'e3', at: Date.now(), text: 'API error 401 Unauthorized: please run /login' })
    expect(seen[2]).toMatchObject({ lasting: true, reason: 'Signed out' })
    retries.stop()
  })

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

describe('what a takeover of its own is not', () => {
  test('a task on its own agent is no primary coming back, and is never recorded', async () => {
    const s = await space('own-agent')
    try {
      expect(s.src.settings.set('task.fallback', 'codex', { space: s.p.name }).ok).toBe(true)
      // the task runs pi of its own (task add --agent), where Settings name Claude Code for tasks
      const { t } = task(s.p.name, 'pi')
      ;(t as { agent?: { kind: string } }).agent = { kind: 'pi' }
      t.worktree = tmp('return-wt')
      await s.src.engine.cantGoOn(t.id, 'Signed out', true)
      expect(t.tookOver).toMatchObject({ to: 'codex' })
      // what would come back is Settings' Claude Code, which this task never ran: a restart takes it there, and that is
      // the chat's restart hint, not a notice
      expect(s.src.returns.list()).toEqual([])
    } finally {
      s.src.settings.set('task.fallback', null, { space: s.p.name })
      s.done()
    }
  })
})

describe('when the primary answers again', () => {
  test('one card per chat still on the backup, each naming its own way back, and none the second time', async () => {
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
      // the primary was asked once, and answered for the task and the coordinator alike: a model is this machine's, not a
      // space's or a role's
      expect(asked).toEqual(['claude'])
      expect(cards(a.key)).toEqual([
        `The primary model answers again: Claude Code. ${a.id} still runs on its backup (Codex): restart it to go back — shepherdr restart ${a.id}, or ⋯ → Restart agent in its chat. Nothing was switched.`,
      ])
      expect(cards(b.key)).toEqual([
        `The primary model answers again: Claude Code. ${b.id} still runs on its backup (Codex): restart it to go back — shepherdr restart ${b.id}, or ⋯ → Restart agent in its chat. Nothing was switched.`,
      ])
      expect(cards(s.key)).toEqual([
        `The primary model answers again: Claude Code. ${s.p.name}'s coordinator still runs on its backup (Codex): restart it to go back — shepherdr restart ${s.p.name}, or ⋯ → Restart agent in its chat. Nothing was switched.`,
      ])
      // the one that went back already hears nothing
      expect(cards(c.key)).toEqual([])
      expect(alerts.map((a) => a.title)).toEqual(['The primary model answers again', 'The primary model answers again'])
      // a primary that keeps answering posts nothing more, and is not asked again
      await s.src.watchReturns(later() + 3_600_000)
      expect(asked).toEqual(['claude'])
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
      // the backup reviewer is what it knows of one; the primary is asked about half an hour later, like any other
      await s.src.watchReturns(later())
      expect(asked).toEqual([])
      await s.src.watchReturns(later() + FIRST_WAIT * 2)
      expect(asked).toEqual(['codex gpt-6-sol'])
      const [text] = cards(s.key)
      expect(text).toContain('The primary model answers again: Codex (GPT-6-Sol).')
      expect(text).toContain('Reviews still fall back to pi (the backup reviewer: reviewer.fallback on reviewer.fallbackModel)')
      // the space's own, never Everywhere's: a plain set would change every space's reviewer
      expect(text).toContain(`shepherdr set reviewer.model gpt-6-sol --space ${s.p.name}`)
      // nothing was started, and no setting was written: a reviewer is never Shepherdr's to start
      expect(s.src.settings.get('reviewer.fallback', s.p.name)).toBe('pi')
      await s.src.watchReturns(later() + 3_600_000)
      expect(cards(s.key)).toHaveLength(1)
    } finally {
      for (const k of ['reviewer.fallback', 'reviewer.model']) s.src.settings.set(k, null, { space: s.p.name })
      s.done()
    }
  })

  test('a reviewer whose backup was set differently since gets a card of its own', async () => {
    const s = await space('back-again')
    try {
      expect(s.src.settings.set('reviewer.model', 'GPT-6-Sol', { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('reviewer.fallback', 'pi', { space: s.p.name }).ok).toBe(true)
      coordinator(s.key, 'claude')
      await s.src.watchReturns(later())
      expect(asked).toEqual([])
      await s.src.watchReturns(later() + FIRST_WAIT * 2)
      expect(cards(s.key)).toHaveLength(1)
      // the human went to another backup reviewer: the primary is asked again, and its recovery is a card of its own
      expect(s.src.settings.set('reviewer.fallback', 'claude', { space: s.p.name }).ok).toBe(true)
      await s.src.watchReturns(later() + 3_600_000)
      expect(asked).toEqual(['codex gpt-6-sol'])
      await s.src.watchReturns(later() + 3_600_000 + FIRST_WAIT * 2)
      expect(asked).toEqual(['codex gpt-6-sol', 'codex gpt-6-sol'])
      expect(cards(s.key)).toHaveLength(2)
      expect(cards(s.key)[1]).toContain('Reviews still fall back to Claude Code')
    } finally {
      for (const k of ['reviewer.fallback', 'reviewer.model']) s.src.settings.set(k, null, { space: s.p.name })
      s.done()
    }
  })

  test('a primary reviewer set again by hand is no card: only the backup it fell back to is a recovery', async () => {
    const s = await space('back-primary')
    try {
      expect(s.src.settings.set('reviewer.model', 'GPT-6-Sol', { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('reviewer.fallback', 'pi', { space: s.p.name }).ok).toBe(true)
      coordinator(s.key, 'claude')
      await s.src.watchReturns(later())
      await s.src.watchReturns(later() + FIRST_WAIT * 2)
      expect(cards(s.key)).toHaveLength(1)
      // the human tries another primary model while the backup reviewer stays: nothing failed that new model, so no card
      expect(s.src.settings.set('reviewer.model', 'GPT-6.1-Sol', { space: s.p.name }).ok).toBe(true)
      await s.src.watchReturns(later() + 3_600_000)
      await s.src.watchReturns(later() + 3_600_000 + FIRST_WAIT * 2)
      expect(cards(s.key)).toHaveLength(1)
      expect(asked).toEqual(['codex gpt-6-sol'])
    } finally {
      for (const k of ['reviewer.fallback', 'reviewer.model']) s.src.settings.set(k, null, { space: s.p.name })
      s.done()
    }
  })

  test('one backup reviewer set Everywhere is one alert, and one card in each space', async () => {
    const a = await space('back-everywhere-a')
    const b = await space('back-everywhere-b')
    try {
      for (const p of [a.p, b.p]) {
        expect(a.src.settings.set('reviewer.model', 'GPT-6-Sol', { space: p.name }).ok).toBe(true)
        expect(a.src.settings.set('reviewer.fallback', 'pi', { space: p.name }).ok).toBe(true)
      }
      coordinator(a.key, 'claude')
      coordinator(b.key, 'claude')
      await a.src.watchReturns(later())
      await a.src.watchReturns(later() + FIRST_WAIT * 2)
      expect(cards(a.key)).toHaveLength(1)
      expect(cards(b.key)).toHaveLength(1)
      // one news for the human, not one per space
      expect(alerts.map((x) => x.title)).toEqual(['The primary model answers again'])
    } finally {
      for (const p of [a.p, b.p]) for (const k of ['reviewer.fallback', 'reviewer.model']) a.src.settings.set(k, null, { space: p.name })
      b.done()
      a.done()
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

describe('going back by itself', () => {
  /** a space going back by itself, whose agents start for real as far as Shepherdr knows: each start is kept, with what
   *  its agent is told first, and every agent is idle unless a test says otherwise */
  async function goingBack(name: string) {
    const s = await space(name)
    expect(s.src.settings.set('backup.watchReturn', 'go back', { space: s.p.name }).ok).toBe(true)
    const started: { key: string; kind: string; first?: string }[] = []
    s.src.agents.restart = (async (spec: { key: string; kind: string; model?: string }, before?: () => Promise<string | void>) => {
      started.push({ key: spec.key, kind: spec.kind, first: (await before?.()) as string | undefined })
      // what a real start leaves: its agent runs on what it started on
      const r = s.src.agents.records[spec.key]
      if (r) Object.assign(r, { kind: spec.kind, model: spec.model })
      return null
    }) as never
    const status = s.src.agents.status
    const busy = new Set<string>()
    s.src.agents.status = ((k: string) => (busy.has(k) ? 'working' : 'idle')) as never
    /** a task of the space on the backup, started as a real one is: its worktree and branch are the space's own */
    const onBackup = () => {
      const x = task(s.p.name, 'codex', { from: 'claude' })
      Object.assign(x.t, { worktree: s.p.path, branch: 'main', base: 'main', agent: { kind: 'codex' } })
      return x
    }
    const done = () => {
      s.src.agents.status = status
      s.src.settings.set('backup.watchReturn', null, { space: s.p.name })
      s.done()
    }
    return { ...s, started, busy, onBackup, done }
  }

  test('each idle agent on the backup starts again on what Settings name, told why, and its backup may go in again', async () => {
    const s = await goingBack('home-again')
    try {
      const a = s.onBackup()
      coordinator(s.key, 'codex')
      s.src.agents.markTookOver(s.key, { from: 'claude', to: 'codex', why: 'out of allowance until 5pm', at: Date.now() })
      const late = Date.now() - FIRST_WAIT * 2
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'out of allowance until 5pm', at: late })
      s.src.returns.note({ role: 'coordinator', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'out of allowance until 5pm', at: late })
      await s.src.watchReturns(later())
      // one question for the model, however many roles of the machine wait on it
      expect(asked).toEqual(['claude'])
      // both started again on Settings' primary: Claude Code, which the task's brief and the coordinator's chat carry over
      expect(s.started.map((x) => [x.key, x.kind])).toEqual([
        [a.key, 'claude'],
        [s.key, 'claude'],
      ])
      expect(s.started[0].first).toContain('Shepherdr moved this task back to its primary model, which answers again: Claude Code. Codex, its backup, ran it until now')
      expect(s.started[1].first).toContain('Shepherdr moved this chat back to its primary model, which answers again: Claude Code.')
      // the card in each chat says so; nothing of "the human restarted" in it
      expect(
        s.src.chats
          .chat(a.key)
          .messages.filter((m) => m.card?.restart)
          .map((m) => m.card!.text),
      ).toEqual(['Back on the primary model, which answers again: Claude Code'])
      expect(
        s.src.chats
          .chat(s.key)
          .messages.filter((m) => m.card?.restart)
          .map((m) => m.card!.text),
      ).toEqual(['Back on the primary model, which answers again: Claude Code'])
      expect(alerts.map((x) => x.title)).toEqual(['Back to work on the primary model', 'Back to work on the primary model'])
      // the backup's one go is given back: the next time the primary runs out, it takes over again
      expect(a.t.tookOver).toBeUndefined()
      expect(a.t.agent).toEqual({ kind: 'claude' })
      expect(s.src.agents.tookOver(s.key)).toBeUndefined()
      // over: counted as one return of the day each, and nothing more is asked or started
      expect(s.src.returns.get('task', s.p.name)).toMatchObject({ back: expect.any(Number), returned: [expect.any(Number)] })
      await s.src.watchReturns(later() + 3_600_000)
      expect(asked).toHaveLength(1)
      expect(s.started).toHaveLength(2)
    } finally {
      s.done()
    }
  })

  test('one at work, paused or waiting for an answer goes back on a later pass, unasked while the answer is fresh', async () => {
    const s = await goingBack('home-later')
    try {
      const a = s.onBackup()
      const b = s.onBackup()
      const c = s.onBackup()
      s.busy.add(a.key)
      b.t.paused = 'idle'
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: Date.now() - FIRST_WAIT * 2 })
      const now = later()
      await s.src.watchReturns(now)
      // never mid-turn and never a pause of yours: only the idle one went back
      expect(s.started.map((x) => x.key)).toEqual([c.key])
      expect(b.t.paused).toBe('idle')
      expect(s.src.returns.get('task', s.p.name)!.back).toBeUndefined()
      // its turn is over a minute later: it follows, and the primary is not asked again
      s.busy.delete(a.key)
      await s.src.watchReturns(now + 60_000)
      expect(asked).toEqual(['claude'])
      expect(s.started.map((x) => x.key)).toEqual([c.key, a.key])
      // one return of the day, however many chats it took
      expect(s.src.returns.get('task', s.p.name)!.returned).toHaveLength(1)
      // the pause is over, and the answer is not fresh any more: the primary is asked again first
      b.t.paused = undefined
      await s.src.watchReturns(now + FRESH + 60_000)
      expect(asked).toEqual(['claude', 'claude'])
      expect(s.started.map((x) => x.key)).toEqual([c.key, a.key, b.key])
      expect(s.src.returns.get('task', s.p.name)!.back).toBeDefined()
      // one alert, for the first pass that took some back
      expect(alerts.map((x) => x.title)).toEqual(['Back to work on the primary model'])
    } finally {
      s.done()
    }
  })

  test('one that cannot go back for long (a pause of days) has the primary asked less and less often', async () => {
    const s = await goingBack('home-paused')
    try {
      const b = s.onBackup()
      b.t.paused = 'idle'
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: Date.now() - FIRST_WAIT * 2 })
      let now = later()
      await s.src.watchReturns(now)
      expect(asked).toHaveLength(1)
      // each time it answers, its next question waits twice as long: a quarter of an hour, half an hour, an hour...
      for (const gap of [FRESH, FRESH * 2, FRESH * 4]) {
        expect(s.src.returns.get('task', s.p.name)!.due).toBe(now + gap)
        await s.src.watchReturns(now + gap - 60_000)
        const before = asked.length
        now += gap
        await s.src.watchReturns(now)
        expect(asked).toHaveLength(before + 1)
      }
      expect(s.started).toEqual([])
    } finally {
      s.done()
    }
  })

  test('one pass at a time: a pass while another takes agents back starts none of them twice', async () => {
    const s = await goingBack('home-twice')
    try {
      // a coordinator: nothing else keeps a second start of it out while the first is under way
      coordinator(s.key, 'codex')
      s.src.returns.note({ role: 'coordinator', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: Date.now() - FIRST_WAIT * 2 })
      // a start that ends only when this test says so
      let release: () => void = () => undefined
      const gate = new Promise<void>((r) => (release = r))
      const stub = s.src.agents.restart
      s.src.agents.restart = (async (spec: never, before?: never) => {
        await gate
        return (stub as (a: never, b?: never) => Promise<null>)(spec, before)
      }) as never
      const first = s.src.watchReturns(later())
      await Bun.sleep(20)
      await s.src.watchReturns(later() + 60_000)
      release()
      await first
      expect(s.started.map((x) => x.key)).toEqual([s.key])
      expect(asked).toEqual(['claude'])
    } finally {
      s.done()
    }
  })

  test('a primary that keeps running out after going back: past a few returns a day, it only tells', async () => {
    const s = await goingBack('home-often')
    try {
      const a = s.onBackup()
      let at = Date.now() - 6 * 3_600_000
      /** it ran out again: its backup took it over once more */
      const ranOut = (when: number) => {
        Object.assign(s.src.agents.records[a.key], { kind: 'codex', model: undefined })
        s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'out of allowance', at: when })
      }
      for (let i = 0; i < MAX_RETURNS; i++) {
        ranOut(at)
        await s.src.watchReturns(at + FIRST_WAIT * 2)
        at += 3_600_000
      }
      expect(s.started).toHaveLength(MAX_RETURNS)
      // one more takeover the same day: the human hears instead, and nothing starts
      ranOut(at)
      await s.src.watchReturns(at + FIRST_WAIT * 2)
      expect(s.started).toHaveLength(MAX_RETURNS)
      expect(cards(a.key).at(-1)).toContain(`It went back by itself ${MAX_RETURNS} times today and ran out again each time, so this time it waits for you.`)
      expect(cards(a.key).at(-1)).toContain(`restart it to go back — shepherdr restart ${a.id}`)
      // a day later the count is gone: it goes back by itself again
      const day = at + 25 * 3_600_000
      ranOut(day)
      await s.src.watchReturns(day + FIRST_WAIT * 2)
      expect(s.started).toHaveLength(MAX_RETURNS + 1)
    } finally {
      s.done()
    }
  })

  test('going back, a reviewer is never asked: every review asks the primary reviewer first', async () => {
    const s = await goingBack('home-reviewer')
    try {
      expect(s.src.settings.set('reviewer.model', 'GPT-6-Sol', { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('reviewer.fallback', 'pi', { space: s.p.name }).ok).toBe(true)
      coordinator(s.key, 'claude')
      await s.src.watchReturns(later())
      await s.src.watchReturns(later() + FIRST_WAIT * 2)
      expect(asked).toEqual([])
      expect(s.src.returns.get('reviewer', s.p.name)).toBeUndefined()
      expect(cards(s.key)).toEqual([])
    } finally {
      for (const k of ['reviewer.fallback', 'reviewer.model']) s.src.settings.set(k, null, { space: s.p.name })
      s.done()
    }
  })
})

/** a space whose backup is Codex, its agents' starts stubbed and kept, every agent idle, and `max` slots */
async function nightWorld(name: string, max = 4) {
  const s = await space(name)
  expect(s.src.settings.set('task.fallback', 'codex', { space: s.p.name }).ok).toBe(true)
  expect(s.src.settings.set('backup.watchReturn', 'go back', { space: s.p.name }).ok).toBe(true)
  expect(s.src.settings.set('machine.maxTasks', String(max), 'machine').ok).toBe(true)
  const started: { key: string; kind: string; first?: string }[] = []
  s.src.agents.restart = (async (spec: { key: string; kind: string; model?: string }, before?: () => Promise<string | void>) => {
    started.push({ key: spec.key, kind: spec.kind, first: (await before?.()) as string | undefined })
    const r = s.src.agents.records[spec.key]
    if (r) Object.assign(r, { kind: spec.kind, model: spec.model })
    return null
  }) as never
  const status = s.src.agents.status
  /** the agents whose pane is gone (a start that failed, or herdr closed it): the others are idle */
  const gone = new Set<string>()
  s.src.agents.status = ((k: string) => (gone.has(k) ? 'gone' : 'idle')) as never
  // herdr answers, whatever the source's own looks at the missing socket say meanwhile (a loaded machine runs one mid-test)
  const reachable = s.src.agents.reachable
  Object.defineProperty(s.src.agents, 'reachable', { get: () => true, set: () => undefined, configurable: true })
  const retries = s.src.retries as unknown as { data: Record<string, Retry> }
  /** a task of the space started as a real one is, its agent on `on` and its last turn cut off for good */
  const cutOff = (on: string, extra: object = {}) => {
    const x = task(s.p.name, on, on === 'codex' ? { from: 'claude' } : undefined)
    Object.assign(x.t, { worktree: s.p.path, branch: 'main', base: 'main', agent: { kind: on } }, extra)
    retries.data[x.key] = { cut: `c-${x.id}`, tries: 1, reason: 'Out of allowance until tomorrow', words: 'out', over: true, lasting: true }
    return x
  }
  const done = () => {
    s.src.agents.status = status
    Object.defineProperty(s.src.agents, 'reachable', { value: reachable, writable: true, configurable: true, enumerable: true })
    for (const k of ['task.fallback', 'backup.watchReturn']) s.src.settings.set(k, null, { space: s.p.name })
    s.src.settings.set('machine.maxTasks', null, 'machine')
    for (const k of Object.keys(retries.data)) delete retries.data[k]
    s.done()
  }
  return { ...s, started, cutOff, gone, done }
}

describe('the night every model ran out', () => {
  test('its backup cut off too: a new task waits instead of being cut off as well, until the primary answers', async () => {
    const s = await nightWorld('night-out', 4)
    try {
      const a = s.cutOff('codex')
      // the backup ran out as well: what the engine notes when it leaves a task waiting for the human
      s.src.engine.noteStuck!(a.t, { kind: 'codex' }, 'out of allowance until tomorrow')
      const next = task(s.p.name, 'claude')
      expect(s.src.engine.room(next.t)).toEqual({ why: 'models' })
      // morning: the primary answers, and what was cut off goes back first
      await s.src.watchReturns(later())
      expect(asked).toEqual(['claude'])
      expect(s.started.map((x) => x.key)).toEqual([a.key])
      expect(s.src.engine.room(next.t)).toEqual({})
    } finally {
      s.done()
    }
  })

  test("a cut-off task of a space at its own cap waits for a slot of that space: its new tasks wait too, another space's start, and it goes back when its space has a slot", async () => {
    const s = await nightWorld('night-cap', 4)
    const other = tmp('return-repo')
    execSync(REPO, { cwd: other, shell: '/bin/sh' })
    const elsewhere = await s.src.places.add(other, 'night-cap-elsewhere')
    try {
      expect(s.src.settings.set('space.maxTasks', '1', { space: s.p.name }).ok).toBe(true)
      // its one slot is taken by a task at work
      const busy = task(s.p.name, 'claude')
      const status = s.src.agents.status
      s.src.agents.status = ((k: string) => (k === busy.key ? 'working' : status(k))) as never
      const a = s.cutOff('codex')
      s.src.engine.noteStuck!(a.t, { kind: 'codex' }, 'out of allowance until tomorrow')
      const next = task(s.p.name, 'claude')
      const other2 = task(elsewhere.name, 'claude')
      await s.src.watchReturns(later())
      // the cut-off one waits for its space's slot, and no new task of that space starts before it; another space's does
      expect(s.started).toEqual([])
      expect(s.src.engine.room(next.t)).toEqual({ why: 'resume' })
      expect(s.src.engine.room(other2.t)).toEqual({})
      // the busy task is done: its space has a slot, and the cut-off task goes back to work
      s.src.agents.status = status
      await s.src.watchReturns(later() + 60_000)
      expect(s.started.map((x) => x.key)).toEqual([a.key])
    } finally {
      s.src.settings.set('space.maxTasks', null, { space: s.p.name })
      s.done()
    }
  })

  test('the morning: each one cut off, on the backup or on the primary itself, starts again a free slot at a time, before any new task', async () => {
    const s = await nightWorld('night-morning', 1)
    try {
      // the backup took it over, then ran out too
      const a = s.cutOff('codex')
      // cut off on the primary, its backup unable to start ("pane not found"): it waits on the primary, its pane gone
      const b = s.cutOff('claude', { trouble: 'pane not found' })
      s.gone.add(b.key)
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'provider refused it', at: Date.now() - FIRST_WAIT * 2 }, { allOut: true })
      const next = task(s.p.name, 'claude')
      // another space's new task: a slot is the machine's, whichever space
      const dir = tmp('return-repo')
      execSync(REPO, { cwd: dir, shell: '/bin/sh' })
      const other = task((await s.src.places.add(dir, 'night-elsewhere')).name, 'claude')
      const now = later()
      await s.src.watchReturns(now)
      // one slot: one goes back, the other waits for it, and no new task takes it first, of any space
      expect(s.started.map((x) => x.key)).toEqual([a.key])
      expect(s.started[0].first).toContain('Shepherdr moved this task back to its primary model')
      expect(s.src.engine.room(next.t)).toEqual({ why: 'resume' })
      expect(s.src.engine.room(other.t)).toEqual({ why: 'resume' })
      // the one waiting for the slot is in line, not needing the human (its start that went wrong included)
      expect(s.src.engine.statusOf(b.t)).toBe('queued')
      expect(s.src.engine.subOf(b.t)).toBe('Waiting for a free slot to go back to work')
      expect(alerts.map((x) => x.body)).toEqual([`Claude Code answers again: ${a.id} agent started again on it; 1 more as slots free up.`])
      // a minute later its slot is free: the one cut off on the primary starts again there, told so, its trouble over
      await s.src.watchReturns(now + 60_000)
      expect(asked).toEqual(['claude'])
      expect(s.started.map((x) => [x.key, x.kind])).toEqual([
        [a.key, 'claude'],
        [b.key, 'claude'],
      ])
      expect(s.started[1].first).toContain("Your model's provider cut your turn off, and it answers again: Shepherdr started you again on Claude Code, with your session as it was.")
      expect(b.t.trouble).toBeUndefined()
      expect(
        s.src.chats
          .chat(b.key)
          .messages.filter((m) => m.card?.restart)
          .map((m) => m.card!.text),
      ).toEqual(['Started again on Claude Code: its provider answers again'])
      // all of them back: over, and the queue goes on
      expect(s.src.returns.get('task', s.p.name)!.back).toBeDefined()
      expect(s.src.engine.room(next.t)).toEqual({})
      expect(s.src.engine.room(other.t)).toEqual({})
      // each one once: nothing starts again on a later pass
      await s.src.watchReturns(now + 3_600_000)
      expect(s.started).toHaveLength(2)
    } finally {
      s.done()
    }
  })

  test('a cut-off on the backup says nothing of the primary: an agent at work on it is still its answer', async () => {
    const s = await nightWorld('night-backup-cut', 4)
    const status = s.src.agents.status
    try {
      const a = s.cutOff('codex')
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'provider refused it', at: Date.now() - FIRST_WAIT * 2 })
      const lastCut = s.src.returns.get('task', s.p.name)!.lastCut
      // the backup cuts one off again (news it was sent, say): the primary's quiet goes on
      s.src.engine.noteStuck!(a.t, { kind: 'codex' }, 'out of allowance until tomorrow')
      expect(s.src.returns.get('task', s.p.name)!.lastCut).toBe(lastCut)
      // one on the primary does put it off
      const b = s.cutOff('claude')
      s.src.engine.noteStuck!(b.t, { kind: 'claude' }, 'provider refused it')
      expect(s.src.returns.get('task', s.p.name)!.lastCut).not.toBe(lastCut)
    } finally {
      s.src.agents.status = status
      s.done()
    }
  })

  test('cut off for good and going back by itself: in line, not needing the human; told me, it needs them', async () => {
    const s = await nightWorld('night-queued', 4)
    try {
      const a = s.cutOff('codex')
      // one at work on its backup, never cut off: it shows as it is
      const fine = task(s.p.name, 'codex', { from: 'claude' })
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'provider refused it', at: Date.now() - FIRST_WAIT * 2 }, { allOut: true })
      // the primary doesn't answer yet: it waits for its model
      answers = false
      await s.src.watchReturns(later())
      expect(s.src.engine.statusOf(a.t)).toBe('queued')
      expect(s.src.engine.subOf(a.t)).toBe('Waiting for its model to answer again')
      expect(s.src.snapshot().needs.some((n) => n.task === a.id)).toBe(false)
      expect(s.src.engine.statusOf(fine.t)).not.toBe('queued')
      // told me instead: the human is the way back, so it needs them
      expect(s.src.settings.set('backup.watchReturn', 'tell me', { space: s.p.name }).ok).toBe(true)
      await s.src.watchReturns(later())
      expect(s.src.engine.statusOf(a.t)).toBe('need')
    } finally {
      s.done()
    }
  })

  test('a night of cut-offs never puts the question off: one more keeps the schedule of the first', async () => {
    const s = await nightWorld('night-schedule', 4)
    try {
      const at = Date.now() - 3 * 3_600_000
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'provider refused it', at })
      const due = s.src.returns.get('task', s.p.name)!.due
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'provider refused it', at: at + 3_600_000 })
      expect(s.src.returns.get('task', s.p.name)).toMatchObject({ due, lastCut: at + 3_600_000 })
    } finally {
      s.done()
    }
  })
})

describe('the way back, starts spaced out', () => {
  test('one cut-off task goes back per pass while machine.startEvery holds the next, then the next one', async () => {
    const s = await nightWorld('night-paced', 4)
    try {
      expect(s.src.settings.set('machine.startEvery', '2 min', 'machine').ok).toBe(true)
      // no start of an earlier test's clock to wait for
      s.src.engine.noteStart(0)
      const a = s.cutOff('codex')
      const b = s.cutOff('codex')
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'provider refused it', at: Date.now() - FIRST_WAIT * 2 }, { allOut: true })
      const now = later()
      await s.src.watchReturns(now)
      expect(s.started).toHaveLength(1)
      // still within its two minutes: the other waits, in line
      await s.src.watchReturns(now + 60_000)
      expect(s.started).toHaveLength(1)
      await s.src.watchReturns(now + 121_000)
      expect(s.started.map((x) => x.key).sort()).toEqual([a.key, b.key].sort())
    } finally {
      s.src.settings.set('machine.startEvery', '0', 'machine')
      s.done()
    }
  })
})

describe('cut off before outages were kept', () => {
  test('a task cut off on its backup, with no outage kept, is taken in: its primary is asked at once, and it goes back', async () => {
    const s = await nightWorld('adopt-task')
    try {
      const a = s.cutOff('codex')
      expect(s.src.returns.get('task', s.p.name)).toBeUndefined()
      await s.src.watchReturns(Date.now())
      expect(asked).toEqual(['claude'])
      expect(s.started.map((x) => [x.key, x.kind])).toEqual([[a.key, 'claude']])
    } finally {
      s.done()
    }
  })

  test('a coordinator still on the backup that took it over, nothing cut off, is taken in and goes back', async () => {
    const s = await nightWorld('adopt-coord')
    try {
      expect(s.src.settings.set('coordinator.fallback', 'codex', { space: s.p.name }).ok).toBe(true)
      coordinator(s.key, 'codex')
      s.src.agents.markTookOver(s.key, { from: 'claude', to: 'codex', why: 'out of allowance', at: Date.now() - 6 * 3_600_000 })
      await s.src.watchReturns(Date.now())
      expect(asked).toEqual(['claude'])
      expect(s.started.map((x) => [x.key, x.kind])).toEqual([[s.key, 'claude']])
    } finally {
      s.src.settings.set('coordinator.fallback', null, { space: s.p.name })
      s.done()
    }
  })

  test('each cut-off is taken in once per run: one that cannot start again is not asked about again and again', async () => {
    const s = await nightWorld('adopt-once')
    try {
      s.cutOff('codex')
      s.src.agents.restart = (async () => {
        throw new Error('pane not found')
      }) as never
      await s.src.watchReturns(Date.now())
      expect(asked).toEqual(['claude'])
      for (const later of [60_000, 3_600_000, 6 * 3_600_000]) await s.src.watchReturns(Date.now() + later)
      expect(asked).toEqual(['claude'])
    } finally {
      s.done()
    }
  })

  test("one on its own harness (neither the primary nor the backup) is not the primary's to bring back", async () => {
    const s = await nightWorld('adopt-own')
    try {
      s.cutOff('opencode')
      await s.src.watchReturns(Date.now())
      expect(asked).toEqual([])
      expect(s.src.returns.get('task', s.p.name)).toBeUndefined()
    } finally {
      s.done()
    }
  })
})

describe('a chain of backups, and the way back', () => {
  test('cut off for good on the last of its backups, every model ran out; on one with another after it, not yet', async () => {
    const s = await nightWorld('chain-out', 4)
    try {
      expect(s.src.settings.set('task.fallback2', 'pi', { space: s.p.name }).ok).toBe(true)
      const next = task(s.p.name, 'claude')
      const a = s.cutOff('codex')
      s.src.engine.noteStuck!(a.t, { kind: 'codex' }, 'out of allowance until tomorrow')
      // Backup 2 is still there: a new task may start
      expect(s.src.returns.get('task', s.p.name)!.allOut).toBeFalsy()
      expect(s.src.engine.room(next.t)).toEqual({})
      const b = s.cutOff('pi')
      s.src.engine.noteStuck!(b.t, { kind: 'pi' }, 'out of allowance until tomorrow')
      expect(s.src.returns.get('task', s.p.name)!.allOut).toBe(true)
      expect(s.src.engine.room(next.t)).toEqual({ why: 'models' })
    } finally {
      s.src.settings.set('task.fallback2', null, { space: s.p.name })
      s.done()
    }
  })

  test('the morning: each one on its 2nd backup, cut off or at work, goes back to the primary; waiting, it is in line', async () => {
    const s = await nightWorld('chain-morning', 4)
    try {
      expect(s.src.settings.set('task.fallback2', 'pi', { space: s.p.name }).ok).toBe(true)
      const a = s.cutOff('pi', { tookOver: { from: 'codex', to: 'pi', why: 'signed out', at: Date.now(), step: 2 } })
      // one at work on Backup 2, never cut off itself
      const fine = task(s.p.name, 'pi', { from: 'codex' })
      Object.assign(fine.t, { worktree: s.p.path, branch: 'main', base: 'main', agent: { kind: 'pi' } })
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'provider refused it', at: Date.now() - FIRST_WAIT * 2 }, { allOut: true })
      answers = false
      await s.src.watchReturns(later())
      expect(s.src.engine.statusOf(a.t)).toBe('queued')
      expect(s.src.engine.subOf(a.t)).toBe('Waiting for its model to answer again')
      answers = true
      await s.src.watchReturns(Date.now() + 48 * 3_600_000)
      // each one goes back on its own: the second may still be starting when the pass returns
      for (const t0 = Date.now(); s.started.length < 2 && Date.now() - t0 < 5000; ) await Bun.sleep(20)
      expect(s.started.map((x) => [x.key, x.kind]).sort()).toEqual(
        [
          [a.key, 'claude'],
          [fine.key, 'claude'],
        ].sort(),
      )
      // back on the primary, its chain is whole again for the next time
      expect(a.t.tookOver).toBeUndefined()
    } finally {
      s.src.settings.set('task.fallback2', null, { space: s.p.name })
      s.done()
    }
  })

  test('a task cut off on its 2nd backup before outages were kept is taken in and goes back', async () => {
    const s = await nightWorld('chain-adopt-task')
    try {
      expect(s.src.settings.set('task.fallback2', 'pi', { space: s.p.name }).ok).toBe(true)
      const a = s.cutOff('pi')
      await s.src.watchReturns(Date.now())
      expect(asked).toEqual(['claude'])
      expect(s.started.map((x) => [x.key, x.kind])).toEqual([[a.key, 'claude']])
    } finally {
      s.src.settings.set('task.fallback2', null, { space: s.p.name })
      s.done()
    }
  })

  test('a coordinator still on its 2nd backup, nothing cut off, is taken in and goes back', async () => {
    const s = await nightWorld('chain-adopt-coord')
    try {
      for (const [k, v] of [
        ['coordinator.fallback', 'codex'],
        ['coordinator.fallback2', 'pi'],
      ])
        expect(s.src.settings.set(k, v, { space: s.p.name }).ok).toBe(true)
      coordinator(s.key, 'pi')
      s.src.agents.markTookOver(s.key, { from: 'codex', to: 'pi', why: 'signed out', at: Date.now() - 6 * 3_600_000, step: 2 })
      await s.src.watchReturns(Date.now())
      expect(asked).toEqual(['claude'])
      expect(s.started.map((x) => [x.key, x.kind])).toEqual([[s.key, 'claude']])
    } finally {
      for (const k of ['coordinator.fallback', 'coordinator.fallback2']) s.src.settings.set(k, null, { space: s.p.name })
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
    // a fifth either side, so two roles rarely fall due together
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
    // the shortest call each CLI has that proves its provider answers: no tools, no MCP servers, nothing written
    expect(oneShot({ kind: 'claude' })).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--restricted', '--no-session-persistence']))
    expect(oneShot({ kind: 'pi' })).toEqual(expect.arrayContaining(['-p', '--no-tools', '--no-mcp', '--no-session']))
    // OpenCode: its plan agent, the question alone (`opencode run` has no flag for a system prompt), model#effort when set
    expect(oneShot({ kind: 'opencode' })).toEqual(['opencode', 'run', '--standalone', '--agent', 'plan', '--title', 'shepherdr-probe', 'Reply with only the two letters: ok'])
    expect(oneShot({ kind: 'opencode', model: 'nvidia/z-ai/glm-5.3-flash', effort: 'thinking' })).toEqual(expect.arrayContaining(['-m', 'nvidia/z-ai/glm-5.3-flash#thinking']))
    expect(oneShot({ kind: 'gemini' })).toBeUndefined()
  })

  test('an agent at work on the primary, none cut off for a while, is its answer: nothing is asked', async () => {
    const s = await space('back-busy')
    const status = s.src.agents.status
    try {
      const a = task(s.p.name, 'codex', { from: 'claude' })
      // its coordinator runs the primary, and works
      coordinator(s.key, 'claude')
      s.src.agents.status = ((k: string) => (k === s.key ? 'working' : status.call(s.src.agents, k))) as never
      // a cut-off a minute ago: a turn under way when the provider began refusing may still be working, no answer yet
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: Date.now() - 60_000 })
      await s.src.watchReturns(Date.now())
      expect(asked).toEqual([])
      expect(cards(a.key)).toEqual([])
      // none for a while since: the primary answers, and nothing needs asking
      await s.src.watchReturns(Date.now() + QUIET)
      expect(asked).toEqual([])
      expect(cards(a.key)).toHaveLength(1)
    } finally {
      s.src.agents.status = status
      s.done()
    }
  })

  test('an agent at work on the backup tells nothing of the primary: it is asked, whoever works', async () => {
    const s = await space('back-beside')
    const status = s.src.agents.status
    try {
      const a = task(s.p.name, 'codex', { from: 'claude' })
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: Date.now() - FIRST_WAIT * 2 })
      s.src.agents.status = ((k: string) => (k === a.key ? 'working' : status.call(s.src.agents, k))) as never
      await s.src.watchReturns(later())
      expect(asked).toEqual(['claude'])
    } finally {
      s.src.agents.status = status
      s.done()
    }
  })

  test('one probe at a time: a pass that comes while one runs asks nothing, and two models are asked one after another', async () => {
    const s = await space('back-once')
    try {
      const a = task(s.p.name, 'codex', { from: 'claude' })
      coordinator(s.key, 'codex')
      // the coordinator's own primary, another model: its question is a second one, asked after the task's
      expect(s.src.settings.set('coordinator.agent', 'pi', { space: s.p.name }).ok).toBe(true)
      const late = Date.now() - FIRST_WAIT * 2
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: late })
      s.src.returns.note({ role: 'coordinator', space: s.p.name, primary: { kind: 'pi' }, to: { kind: 'codex' }, why: 'signed out', at: late })
      // a probe that answers only when this test says so
      let release: () => void = () => undefined
      const gate = new Promise<void>((r) => (release = r))
      s.src.returns.probe = async (h: { kind: string }) => {
        asked.push(h.kind)
        await gate
        return { ok: true, said: 'ok' }
      }
      const first = s.src.watchReturns(later())
      await Bun.sleep(20)
      expect(asked).toEqual(['claude'])
      // a second pass while that one is in flight: nothing is asked, nothing posted yet
      await s.src.watchReturns(later())
      expect(asked).toEqual(['claude'])
      expect(cards(a.key)).toEqual([])
      release()
      await first
      // the first pass went on to the other model, one probe at a time, and both chats heard
      expect(asked).toEqual(['claude', 'pi'])
      expect(cards(a.key)).toHaveLength(1)
      expect(cards(s.key)).toHaveLength(1)
    } finally {
      s.src.settings.set('coordinator.agent', null, { space: s.p.name })
      s.done()
    }
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

describe('the way back honours a model’s cap (models.maxAtOnce)', () => {
  test('cut-off tasks go back to a model one slot at a time: the second waits for its slot, and a new task on that provider waits behind it', async () => {
    const s = await nightWorld('night-model-cap', 4)
    try {
      // the primary is Claude Code: one of its models at once on this machine
      expect(s.src.settings.set('models.maxAtOnce', 'anthropic=1', 'all').ok).toBe(true)
      const a = s.cutOff('codex')
      const b = s.cutOff('codex')
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'provider refused it', at: Date.now() - FIRST_WAIT * 2 }, { allOut: true })
      await s.src.watchReturns(later())
      // the first goes back; the second waits for the slot the first takes
      expect(s.started.map((x) => x.key)).toEqual([a.key])
      // a new task on the same provider waits behind the cut-off one, as a space's new tasks do
      const next = task(s.p.name, 'claude')
      expect(s.src.engine.room(next.t)).toEqual({ why: 'resume' })
      // a's turn is at work on Claude Code now: the provider is full, b keeps waiting
      const status = s.src.agents.status
      s.src.agents.status = ((k: string) => (k === a.key ? 'working' : status(k))) as never
      await s.src.watchReturns(later() + 60_000)
      expect(s.started.map((x) => x.key)).toEqual([a.key])
      // a's turn is over: its slot is free, and b goes back
      s.src.agents.status = status
      await s.src.watchReturns(later() + 120_000)
      expect(s.started.map((x) => x.key)).toEqual([a.key, b.key])
    } finally {
      s.src.settings.set('models.maxAtOnce', null, 'all')
      s.done()
    }
  })
})

describe('OpenCode as the primary: asked and gone back to like the others', () => {
  test('its provider is asked with its own one-shot, and its task goes back on its model and variant once it answers', async () => {
    const GO = 'opencode-go/deepseek-v4.1-flash'
    const { setModels, opencodeList } = await import('../server/live/models.ts')
    setModels('opencode', opencodeList([{ id: GO, label: GO, efforts: ['high', 'thinking'] }], GO))
    const s = await nightWorld('opencode-back', 4)
    try {
      expect(s.src.settings.set('task.agent', 'OpenCode', { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('task.model', GO, { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('task.effort', 'thinking', { space: s.p.name }).ok).toBe(true)
      // the takeover: OpenCode's provider ran out for good, and its task went in on the backup (Codex)
      s.src.returns.note({
        role: 'task',
        space: s.p.name,
        primary: { kind: 'opencode', model: GO, effort: 'thinking' },
        to: { kind: 'codex' },
        why: 'Out of allowance until tomorrow',
        at: Date.now() - FIRST_WAIT * 2,
      })
      const a = s.cutOff('codex')
      await s.src.watchReturns(later())
      // asked with its own one-shot (opencode run --agent plan), on its model
      expect(asked).toEqual([`opencode ${GO}`])
      // it answered: the task that is on the backup starts again on OpenCode, on the model and variant Settings name
      expect(s.started.map((x) => [x.key, x.kind])).toEqual([[a.key, 'opencode']])
      expect(s.src.agents.records[a.key]).toMatchObject({ kind: 'opencode', model: GO })
    } finally {
      setModels('opencode', undefined)
      s.done()
    }
  })

  test('a primary on OpenCode with no room under its cap is not started: the task waits for the slot, and goes back once one frees', async () => {
    const GO = 'opencode-go/deepseek-v4.1-flash'
    const { setModels, opencodeList } = await import('../server/live/models.ts')
    setModels('opencode', opencodeList([{ id: GO, label: GO, efforts: [] }], GO))
    const s = await nightWorld('opencode-cap', 4)
    try {
      expect(s.src.settings.set('task.agent', 'OpenCode', { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('task.model', GO, { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('models.maxAtOnce', `${GO}=1`, 'machine').ok).toBe(true)
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'opencode', model: GO }, to: { kind: 'codex' }, why: 'Out of allowance until tomorrow', at: Date.now() - FIRST_WAIT * 2 })
      const waiting = s.cutOff('codex')
      // one OpenCode agent of the machine runs on that model already: the cap of 1 is full
      const running = task(s.p.name, 'opencode')
      Object.assign(running.t, { worktree: s.p.path, branch: 'main', base: 'main', agent: { kind: 'opencode', model: GO } })
      s.src.agents.status = ((k: string) => (k === running.key ? 'working' : 'idle')) as never
      await s.src.watchReturns(later())
      expect(s.started.map((x) => x.key)).toEqual([])
      // the run ends (its task is done with its slot): the slot is free, and the task goes back on OpenCode
      running.t.archived = Date.now()
      s.src.agents.status = (() => 'idle') as never
      await s.src.watchReturns(later() + 60_000)
      expect(s.started.map((x) => [x.key, x.kind])).toEqual([[waiting.key, 'opencode']])
    } finally {
      s.src.settings.set('models.maxAtOnce', null, 'machine')
      setModels('opencode', undefined)
      s.done()
    }
  })
})

describe('a filter refusal and a probe answer do not keep new starts off the primary', () => {
  const MODEL = 'hy4-flash-free'
  const KEY = `opencode/${MODEL}`
  /** the source's own outNow, which chainOptions reads for every new start */
  const out = (key: string) => (src as unknown as { outNow(k: string): { until?: string } | undefined }).outNow(key)
  /** which harness a new task of that space starts on, under the caps as they are now */
  const startsOn = (space: string) => {
    const c = src.engine.decide(space, src.engine.chainOptions([{ h: { kind: 'opencode', model: MODEL } }, { h: { kind: 'codex' } }]))
    return 'harness' in c ? c.harness.h.kind : 'wait'
  }
  /** Settings name OpenCode on hy4 for tasks of the space, with a Codex backup */
  const primary = (name: string) => {
    expect(src.settings.set('task.agent', 'OpenCode', { space: name }).ok).toBe(true)
    expect(src.settings.set('task.model', MODEL, { space: name }).ok).toBe(true)
    expect(src.settings.set('task.fallback', 'codex', { space: name }).ok).toBe(true)
  }
  const forget = (name: string) => {
    for (const k of ['task.agent', 'task.model', 'task.fallback']) src.settings.set(k, null, { space: name })
  }

  test('a content-filter cut on the primary leaves no outage: new tasks in two spaces start on the primary', async () => {
    const { setModels, opencodeList } = await import('../server/live/models.ts')
    setModels('opencode', opencodeList([{ id: MODEL, label: MODEL, efforts: [] }], MODEL))
    const a = await space('filter-a')
    const b = await space('filter-b')
    try {
      primary(a.p.name)
      primary(b.p.name)
      // POL-437 at 11:19: one response of the primary was blocked by the provider's filter
      const t = task(a.p.name, 'opencode')
      Object.assign(t.t, { worktree: a.p.path, branch: 'main', base: 'main', agent: { kind: 'opencode', model: MODEL } })
      src.retries.seen(t.key, { id: 'filter-cut-1', at: Date.now(), text: 'Provider blocked the response', code: 'provider.content-filter' })
      // only this chat handed over to its backup, in its own words: no return entry, no run-out, no provider out
      expect(t.t.tookOver).toMatchObject({ to: 'codex', why: "response blocked by the provider's filter", blocked: true })
      expect(src.returns.list()).toEqual([])
      expect(out(KEY)).toBeUndefined()
      // the backup is up: the next return pass must not adopt a one-response takeover as an outage (and feed itself)
      Object.assign(src.agents.records[t.key], { kind: 'codex' })
      await src.watchReturns(later())
      expect(src.returns.list()).toEqual([])
      expect(out(KEY)).toBeUndefined()
      // a new task in the same space, and one in another space on the same provider, both start on the primary
      expect(startsOn(a.p.name)).toBe('opencode')
      expect(startsOn(b.p.name)).toBe('opencode')
    } finally {
      forget(a.p.name)
      forget(b.p.name)
      setModels('opencode', undefined)
      b.done()
      a.done()
    }
  })

  test('a probe answer lets new tasks start on the primary while a chat is still on the backup', async () => {
    const { setModels, opencodeList } = await import('../server/live/models.ts')
    setModels('opencode', opencodeList([{ id: MODEL, label: MODEL, efforts: [] }], MODEL))
    const s = await space('filter-probe')
    try {
      primary(s.p.name)
      const onBackup = task(s.p.name, 'codex', { from: 'opencode' })
      src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'opencode', model: MODEL }, to: { kind: 'codex' }, why: 'signed out', at: Date.now() - FIRST_WAIT * 2 })
      // unanswered: its provider is out, and a new task goes to the backup
      expect(out(KEY)).toEqual({})
      expect(startsOn(s.p.name)).toBe('codex')
      // the primary answered a probe: no cut on it since, so new starts go back to it while the chat stays on its backup
      src.returns.ok('task', s.p.name)
      expect(src.returns.get('task', s.p.name)).toMatchObject({ ok: expect.any(Number), oks: 1 })
      expect(src.returns.get('task', s.p.name)!.back).toBeUndefined()
      expect(out(KEY)).toBeUndefined()
      expect(startsOn(s.p.name)).toBe('opencode')
      expect(src.agents.records[onBackup.key]).toMatchObject({ kind: 'codex' })
      // a cut on the backup says nothing of the primary
      src.returns.cut('task', s.p.name, Date.now(), { key: onBackup.key, onPrimary: false })
      expect(out(KEY)).toBeUndefined()
      expect(startsOn(s.p.name)).toBe('opencode')
      // a cut on the primary clears the answer: its provider is out for new starts again
      src.returns.cut('task', s.p.name, Date.now(), { key: 'other/Agent', onPrimary: true })
      expect(src.returns.get('task', s.p.name)!.ok).toBeUndefined()
      expect(out(KEY)).toEqual({})
      expect(startsOn(s.p.name)).toBe('codex')
    } finally {
      forget(s.p.name)
      setModels('opencode', undefined)
      s.done()
    }
  })

  test('the reset an outage kept ends its mark, however late the takeover was noted', async () => {
    const { setModels, opencodeList } = await import('../server/live/models.ts')
    setModels('opencode', opencodeList([{ id: MODEL, label: MODEL, efforts: [] }], MODEL))
    const s = await space('reset-came')
    try {
      primary(s.p.name)
      const now = Date.now()
      // POL-461/464: a 5-hour limit cut the chat off six hours ago, its reset came, and the watch's next question is
      // hours away (its wait grows to four): the ledger's mark is over, so a new task starts on the primary again.
      // The takeover was noted four minutes after the cut, as a launch and the machine's own room take their time:
      // the reset is the outage's own, never worked out from how close those two moments are
      const resetAt = now - 3_600_000
      src.usage.runOut(
        {
          at: now - 6 * 3_600_000,
          key: KEY,
          chat: `${s.p.name}/Agent`,
          role: 'task',
          reason: 'Out of allowance until 2:10am',
          words: "You've hit your 5-hour limit · resets 2:10am",
          reset: '2:10am',
          resetAt,
        },
        now,
      )
      src.returns.note(
        { role: 'task', space: s.p.name, primary: { kind: 'opencode', model: MODEL }, to: { kind: 'codex' }, why: 'out of allowance until 2:10am', at: now - 6 * 3_600_000 + 4 * 60_000 },
        { resetAt },
      )
      src.returns.failed('task', s.p.name, now - 5 * 3_600_000)
      expect(out(KEY)).toBeUndefined()
      expect(startsOn(s.p.name)).toBe('opencode')
      // a refusal on the primary after that reset is another outage, and its own reset is what the mark ends at now
      const later = now + 30 * 60_000
      src.returns.cut('task', s.p.name, now, { key: 'another/Agent', onPrimary: true, resetAt: later })
      expect(src.returns.get('task', s.p.name)?.resetAt).toBe(later)
      // a takeover of another kind keeps none: the allowance that reset named is not what this one waits for
      src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'opencode', model: MODEL }, to: { kind: 'codex' }, why: 'signed out', at: now }, { resetAt: undefined })
      expect(src.returns.get('task', s.p.name)?.why).toBe('signed out')
      expect(src.returns.get('task', s.p.name)?.resetAt).toBeUndefined()
    } finally {
      forget(s.p.name)
      setModels('opencode', undefined)
      s.done()
    }
  })

  test('a probe answer frees starts even when the run-out promised a reset', async () => {
    const { setModels, opencodeList } = await import('../server/live/models.ts')
    setModels('opencode', opencodeList([{ id: MODEL, label: MODEL, efforts: [] }], MODEL))
    const s = await space('filter-reset')
    try {
      primary(s.p.name)
      const now = Date.now()
      // an allowance that ran out with "resets 5pm": until the primary speaks, that reset keeps new starts off it
      src.usage.runOut({ at: now - 3_600_000, key: KEY, chat: `${s.p.name}/Agent`, role: 'task', reason: 'Out of allowance', words: 'resets 5pm', resetAt: now + 4 * 3_600_000 }, now)
      src.returns.note(
        { role: 'task', space: s.p.name, primary: { kind: 'opencode', model: MODEL }, to: { kind: 'codex' }, why: 'out of allowance until 5pm', at: now - 3_600_000 },
        { resetAt: now + 4 * 3_600_000 },
      )
      expect(out(KEY)).toBeDefined()
      expect(startsOn(s.p.name)).toBe('codex')
      // it answered: the promised reset no longer holds, even though the chats are still on the backup
      src.returns.ok('task', s.p.name, now)
      expect(out(KEY)).toBeUndefined()
      expect(startsOn(s.p.name)).toBe('opencode')
    } finally {
      forget(s.p.name)
      setModels('opencode', undefined)
      s.done()
    }
  })

  test('the watch’s own probe frees starts at once, and an answered outage keeps them free, though a reset is far ahead', async () => {
    const { setModels, opencodeList } = await import('../server/live/models.ts')
    setModels('opencode', opencodeList([{ id: MODEL, label: MODEL, efforts: [] }], MODEL))
    const s = await space('reset-watch')
    try {
      primary(s.p.name)
      const now = Date.now()
      // an allowance that ran out hours ago with "resets 5pm": until the primary speaks, that reset keeps starts off it
      src.usage.runOut({ at: now - 3 * 3_600_000, key: KEY, chat: `${s.p.name}/Agent`, role: 'task', reason: 'Out of allowance', words: 'resets 5pm', resetAt: now + 4 * 3_600_000 }, now)
      const onBackup = task(s.p.name, 'codex', { from: 'opencode' })
      src.returns.note(
        { role: 'task', space: s.p.name, primary: { kind: 'opencode', model: MODEL }, to: { kind: 'codex' }, why: 'out of allowance until 5pm', at: now - FIRST_WAIT * 2 },
        { resetAt: now + 4 * 3_600_000 },
      )
      expect(out(KEY)).toEqual({ until: expect.any(String) })
      expect(startsOn(s.p.name)).toBe('codex')
      await src.watchReturns(now)
      // its probe answered after the cut-off: the outage is answered, and the promised reset no longer holds a start off
      expect(src.returns.get('task', s.p.name)!.back).toBeGreaterThan(now - FIRST_WAIT * 2)
      expect(src.returns.get('task', s.p.name)!.back).toBeGreaterThanOrEqual(now)
      expect(out(KEY)).toBeUndefined()
      expect(startsOn(s.p.name)).toBe('opencode')
      // and the chat stays on its backup until the human restarts it: tell me switches nothing
      expect(src.agents.records[onBackup.key]).toMatchObject({ kind: 'codex' })
    } finally {
      forget(s.p.name)
      setModels('opencode', undefined)
      s.done()
    }
  })

  test('a passing error that ran out of tries is still adopted: the watch brings its chat back', async () => {
    const s = await nightWorld('passing-then-adopt')
    try {
      const a = task(s.p.name, 'claude')
      Object.assign(a.t, { worktree: s.p.path, branch: 'main', base: 'main', agent: { kind: 'claude' } })
      // "Provider overloaded, still after 5 tries": no note of its own, but the takeover is real
      await s.src.engine.cantGoOn(a.t.id, 'Provider overloaded, still after 5 tries')
      expect(a.t.tookOver).toMatchObject({ to: 'codex' })
      expect(a.t.tookOver!.blocked).toBeUndefined()
      Object.assign(s.src.agents.records[a.key], { kind: 'codex' })
      await s.src.watchReturns(later())
      // the next pass takes it in, asks the primary, and starts the chat back on it — after the backup the takeover
      // started in the worktree
      expect(asked).toEqual(['claude'])
      expect(s.started.map((x) => [x.key, x.kind])).toEqual([
        [a.key, 'codex'],
        [a.key, 'claude'],
      ])
    } finally {
      s.done()
    }
  })
})

describe('how soon the primary is asked', () => {
  test('the first question comes in about three minutes, and each failure doubles it up to four hours', () => {
    // a burst — a free-usage 429, a provider's hiccup — often clears in minutes: no half hour of waiting for it
    expect(FIRST_WAIT).toBeGreaterThanOrEqual(2 * 60_000)
    expect(FIRST_WAIT).toBeLessThanOrEqual(3 * 60_000)
    // a fifth of the wait either way, so two roles rarely fall due together
    expect(wait(0, 0)).toBe(FIRST_WAIT * 0.8)
    expect(wait(0, 1)).toBe(FIRST_WAIT * 1.2)
    // a provider that is out for good is asked less and less, never hammered, up to the longest wait
    expect(wait(1, 0.5)).toBe(FIRST_WAIT * 2)
    expect(wait(2, 0.5)).toBe(FIRST_WAIT * 4)
    expect(wait(3, 0.5)).toBe(FIRST_WAIT * 8)
    expect(wait(20, 0.5)).toBe(LONGEST_WAIT)
  })

  test('a takeover is asked on the first pass after its few minutes, and nothing is asked before', async () => {
    const s = await space('soon-minute')
    try {
      const a = task(s.p.name, 'codex', { from: 'claude' })
      const at = Date.now()
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'out of allowance until 5pm', at })
      // a minute on: its question is not due yet, and nothing is posted
      await s.src.watchReturns(at + 60_000)
      expect(asked).toEqual([])
      expect(cards(a.key)).toEqual([])
      // four minutes on (three, a fifth either way): it is asked, and its chat hears
      await s.src.watchReturns(at + FIRST_WAIT * 1.2 + 1)
      expect(asked).toEqual(['claude'])
      expect(cards(a.key)).toHaveLength(1)
    } finally {
      s.done()
    }
  })

  test('the reset a provider named is asked at, never after a wait that grew to hours, in each of the five', async () => {
    const s = await space('ask-at-reset')
    /** each CLI's own words for an allowance that ran out, which retry.ts reads its reset from */
    const words: Record<string, string> = {
      claude: "You've hit your 5-hour limit · resets 2:10am",
      codex: "You've hit your usage limit. Upgrade to Pro or try again at 5:00 PM.",
      pi: '429 usage limit reached for this plan, resets 3pm',
      opencode: 'Go usage limit exceeded',
      agy: 'RESOURCE_EXHAUSTED: Individual quota reached. Resets in 158h59m47s.',
    }
    const status = s.src.agents.status
    try {
      // going back, but its chat is busy, so the outage stays open with the answer it got: the reset is asked once, not
      // on every pass after it
      s.src.settings.set('backup.watchReturn', 'go back')
      s.src.agents.status = (() => 'working') as never
      const now = Date.now()
      for (const kind of ['claude', 'codex', 'pi', 'opencode', 'agy']) {
        // each round starts with nothing kept from the one before, and its provider is out with a reset that has come
        for (const o of s.src.returns.list()) s.src.returns.forget(o.role, o.space)
        s.src.engine.tasks.length = 0
        for (const k of Object.keys(s.src.agents.records)) delete s.src.agents.records[k]
        asked.length = 0
        const backup = kind === 'codex' ? 'claude' : 'codex'
        expect(s.src.settings.set('task.agent', kind, { space: s.p.name }).ok).toBe(true)
        const a = task(s.p.name, backup, { from: kind })
        // when it came back, from that CLI's own words where they name one: OpenCode's say only "usage limit exceeded"
        // (its CLI reports how long to wait instead), so its round takes its moment from the ledger's own reset. The cut is
        // a second ago, so this round's run-out is the newest of that provider however many the tests before it left
        const cut = now - 1_000
        const reset = resetOf(words[kind] ?? '', cut, 'UTC')?.at ?? now - 60_000
        s.src.usage.runOut({ at: cut, key: `${kind}/test-model`, chat: `${s.p.name}/${kind}/Agent`, role: 'task', reason: 'Out of allowance', words: words[kind] ?? '', resetAt: reset }, now)
        s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind }, to: { kind: backup }, why: 'out of allowance', at: cut }, { resetAt: reset })
        // the watch has failed a few times since: its next question is hours away
        const failAt = Math.min(reset, now) - 60_000
        for (let i = 0; i < 6; i++) s.src.returns.failed('task', s.p.name, failAt)
        // before its reset came, nothing is asked: its own wait is still hours away
        await s.src.watchReturns(failAt)
        expect([kind, asked]).toEqual([kind, []])
        expect([kind, cards(a.key)]).toEqual([kind, []])
        // its reset came: the primary is asked at once, and its chat hears
        const after = Math.max(reset + 1_000, now)
        await s.src.watchReturns(after)
        expect([kind, asked]).toEqual([kind, [kind]])
        expect([kind, s.src.returns.get('task', s.p.name)?.ok]).toEqual([kind, expect.any(Number)])
        // it answered, and its chat is busy so it stays where it is: the wait after an answer is its own (fifteen minutes,
        // then twice as long each time), so the reset
        // is not asked again once that answer stands, though the reset is long past
        await s.src.watchReturns(after + 16 * 60_000)
        expect([kind, asked.length]).toEqual([kind, 2])
        await s.src.watchReturns(after + 32 * 60_000)
        expect([kind, asked.length]).toEqual([kind, 2])
      }
    } finally {
      s.src.agents.status = status
      s.src.settings.set('task.agent', null, { space: s.p.name })
      s.done()
    }
  })

  test('the first look after a restart is a minute: an outage kept from before is not left for ten', () => {
    expect(FIRST_LOOK).toBeGreaterThan(0)
    expect(FIRST_LOOK).toBeLessThanOrEqual(2 * 60_000)
  })
})

describe('the machine’s own work on the primary is its answer', () => {
  test('two clean minutes on it free the space waiting on it, without asking the provider', async () => {
    const s = await space('quiet-two')
    const status = s.src.agents.status
    try {
      const a = task(s.p.name, 'codex', { from: 'claude' })
      coordinator(s.key, 'claude')
      s.src.agents.status = ((k: string) => (k === s.key ? 'working' : status.call(s.src.agents, k))) as never
      const at = Date.now()
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at })
      // a second short of the quiet, the work is not the answer yet, and its own question is not due: nothing either way
      await s.src.watchReturns(at + QUIET - 1_000)
      expect(asked).toEqual([])
      expect(cards(a.key)).toEqual([])
      // its own question is not due yet, and the work answers for it: nothing is asked
      await s.src.watchReturns(at + QUIET)
      expect(asked).toEqual([])
      expect(cards(a.key)).toHaveLength(1)
      // the answer is the work's, not a probe's: no count of probes puts its next question off
      expect(s.src.returns.get('task', s.p.name)).toMatchObject({ back: expect.any(Number) })
      expect(s.src.returns.get('task', s.p.name)!.oks).toBeUndefined()
    } finally {
      s.src.agents.status = status
      s.done()
    }
  })

  test('a question due while a turn still runs on it waits for the quiet, never asked beside that work', async () => {
    const s = await space('quiet-beside-work')
    const status = s.src.agents.status
    try {
      const a = task(s.p.name, 'codex', { from: 'claude' })
      coordinator(s.key, 'claude')
      s.src.agents.status = ((k: string) => (k === s.key ? 'working' : status.call(s.src.agents, k))) as never
      const at = Date.now()
      s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at })
      // the primary cut another chat off a moment ago: the question is due, its quiet is not over, and the work goes on
      const cutAt = at + FIRST_WAIT * 2
      s.src.returns.cut('task', s.p.name, cutAt, { key: `${a.id}-other/Agent`, onPrimary: true })
      await s.src.watchReturns(cutAt)
      expect(asked).toEqual([])
      expect(cards(a.key)).toEqual([])
      // the quiet over: the work is the answer, and the probe still never runs beside it
      await s.src.watchReturns(cutAt + QUIET)
      expect(asked).toEqual([])
      expect(cards(a.key)).toHaveLength(1)
    } finally {
      s.src.agents.status = status
      s.done()
    }
  })
})

describe('a model answers for the whole machine, not for one space', () => {
  /** the starts the way back makes: one array, since the source and its one start are the whole machine's */
  const started: { key: string; kind: string }[] = []
  beforeEach(() => {
    started.length = 0
  })

  /** a space going back by itself, whose starts are kept rather than made (as goingBack above) */
  async function goingBack(name: string) {
    const s = await space(name)
    expect(s.src.settings.set('backup.watchReturn', 'go back', { space: s.p.name }).ok).toBe(true)
    s.src.agents.restart = (async (spec: { key: string; kind: string; model?: string }) => {
      started.push({ key: spec.key, kind: spec.kind })
      // what a real start leaves: its agent runs on what it started on
      const r = s.src.agents.records[spec.key]
      if (r) Object.assign(r, { kind: spec.kind, model: spec.model })
      return null
    }) as never
    const status = s.src.agents.status
    s.src.agents.status = (() => 'idle') as never
    /** a task of the space on the backup, as a real one is: its worktree and branch are the space's own */
    const onBackup = () => {
      const x = task(s.p.name, 'codex', { from: 'claude' })
      Object.assign(x.t, { worktree: s.p.path, branch: 'main', base: 'main', agent: { kind: 'codex' } })
      return x
    }
    const done = () => {
      s.src.agents.status = status
      s.src.settings.set('backup.watchReturn', null, { space: s.p.name })
      s.done()
    }
    return { ...s, started, onBackup, done }
  }

  test('one probe answers for two spaces waiting on it, and both go back on it', async () => {
    const a = await goingBack('share-one-a')
    const b = await goingBack('share-one-b')
    try {
      const ta = a.onBackup()
      const tb = b.onBackup()
      const late = Date.now() - FIRST_WAIT * 2
      a.src.returns.note({ role: 'task', space: a.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'out of allowance until 5pm', at: late })
      b.src.returns.note({ role: 'task', space: b.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'out of allowance until 5pm', at: late })
      await a.src.watchReturns(later())
      // one question, and both chats started again on the primary it answered for
      expect(asked).toEqual(['claude'])
      expect(a.started.map((x) => [x.key, x.kind])).toEqual([
        [ta.key, 'claude'],
        [tb.key, 'claude'],
      ])
      // each over, each with its own return of the day, and neither asked again while the answer holds
      expect(a.src.returns.get('task', a.p.name)!.back).toBeDefined()
      expect(a.src.returns.get('task', b.p.name)!.back).toBeDefined()
      await b.src.watchReturns(later() + 3_600_000)
      expect(asked).toEqual(['claude'])
    } finally {
      b.done()
      a.done()
    }
  })

  test('a failure is one question too: both spaces back off, and neither asks again in that pass', async () => {
    const a = await goingBack('share-fail-a')
    const b = await goingBack('share-fail-b')
    try {
      answers = false
      a.onBackup()
      b.onBackup()
      const late = Date.now() - FIRST_WAIT * 2
      a.src.returns.note({ role: 'task', space: a.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: late })
      b.src.returns.note({ role: 'task', space: b.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: late })
      await a.src.watchReturns(later())
      expect(asked).toEqual(['claude'])
      expect(a.src.returns.get('task', a.p.name)!.tries).toBe(1)
      expect(a.src.returns.get('task', b.p.name)!.tries).toBe(1)
      expect(a.started).toEqual([])
      expect(b.started).toEqual([])
    } finally {
      b.done()
      a.done()
    }
  })

  test('a cut on the primary while a probe is out answers nothing: that answer is older than the cut', async () => {
    const a = await goingBack('share-cut-a')
    const b = await goingBack('share-cut-b')
    try {
      const ta = a.onBackup()
      const tb = b.onBackup()
      const late = Date.now() - FIRST_WAIT * 2
      a.src.returns.note({ role: 'task', space: a.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: late })
      b.src.returns.note({ role: 'task', space: b.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: late })
      const now = later()
      // while that probe is out, the primary cuts b off again: its refusal is newer than the answer on its way back
      a.src.returns.probe = async (h: { kind: string }) => {
        asked.push(h.kind)
        a.src.returns.cut('task', b.p.name, now + 60_000, { key: tb.key, onPrimary: true })
        return { ok: true, said: 'ok' }
      }
      await a.src.watchReturns(now)
      // the model refused a chat during the probe: nothing is answered by it, and neither chat is started on it
      expect(asked).toEqual(['claude'])
      expect(started).toEqual([])
      expect(a.src.returns.get('task', a.p.name)!.ok).toBeUndefined()
      expect(b.src.returns.get('task', b.p.name)!.ok).toBeUndefined()
      expect(cards(tb.key)).toEqual([])
      expect(cards(ta.key)).toEqual([])
    } finally {
      b.done()
      a.done()
    }
  })

  test('a fresh answer stops counting once another space is cut on that model again', async () => {
    const a = await goingBack('share-recut-a')
    const b = await goingBack('share-recut-b')
    const status = a.src.agents.status
    try {
      const ta = a.onBackup()
      const tb = b.onBackup()
      const late = Date.now() - FIRST_WAIT * 2
      a.src.returns.note({ role: 'task', space: a.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: late })
      b.src.returns.note({ role: 'task', space: b.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: late })
      const now = later()
      // both are freed by the same answer; a is idle and goes back, b is still at work
      a.src.agents.status = ((k: string) => (k === tb.key ? 'working' : 'idle')) as never
      await a.src.watchReturns(now)
      expect(started.map((x) => x.key)).toEqual([ta.key])
      expect(a.src.returns.get('task', b.p.name)!.ok).toBeDefined()
      // a's restarted chat is cut on the primary a minute later, and b goes idle two minutes after the answer: b is not
      // started on a model that has just refused a, though its answer is still inside the fresh quarter of an hour
      a.src.agents.status = status
      a.src.returns.note({ role: 'task', space: a.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: now + 60_000 })
      await b.src.watchReturns(now + 2 * 60_000)
      expect(started.map((x) => x.key)).toEqual([ta.key])
      // its own question comes due once the refusal is older than the fresh quarter of an hour: then it goes back
      await b.src.watchReturns(now + FRESH + 60_000)
      expect(started.map((x) => x.key)).toEqual([ta.key, tb.key])
    } finally {
      a.src.agents.status = status
      b.done()
      a.done()
    }
  })

  test('another space’s clean work does not free a chat cut on that model a moment ago', async () => {
    const b = await space('share-quiet-b')
    const a = await goingBack('share-quiet-a')
    const status = a.src.agents.status
    try {
      const tb = task(b.p.name, 'codex', { from: 'claude' })
      coordinator(a.key, 'claude')
      a.src.agents.status = ((k: string) => (k === a.key ? 'working' : 'idle')) as never
      const at = Date.now()
      b.src.returns.note({ role: 'task', space: b.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at: at - 10 * 60_000 })
      // cut on the primary ten seconds ago: its own quiet is not over, so the machine's clean work is no answer for it
      b.src.returns.cut('task', b.p.name, at - 10_000, { key: tb.key, onPrimary: true })
      await b.src.watchReturns(at)
      expect(asked).toEqual([])
      expect(cards(tb.key)).toEqual([])
      expect(b.src.returns.get('task', b.p.name)!.ok).toBeUndefined()
      // its own quiet over, the work is the answer: the card comes without a probe
      await b.src.watchReturns(at - 10_000 + QUIET)
      expect(asked).toEqual([])
      expect(cards(tb.key)).toHaveLength(1)
    } finally {
      a.src.agents.status = status
      a.done()
      b.done()
    }
  })

  test('a space whose watch is off hears nothing of it: its outage is left as it was', async () => {
    // the space whose starts are not kept first: goingBack's own start stub is the machine's one
    const b = await space('share-off-b')
    const a = await goingBack('share-off-a')
    try {
      expect(b.src.settings.set('backup.watchReturn', 'off', { space: b.p.name }).ok).toBe(true)
      const ta = a.onBackup()
      const tb = task(b.p.name, 'codex', { from: 'claude' })
      const late = Date.now() - FIRST_WAIT * 2
      a.src.returns.note({ role: 'task', space: a.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'out of allowance until 5pm', at: late })
      b.src.returns.note({ role: 'task', space: b.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'out of allowance until 5pm', at: late })
      await a.src.watchReturns(later())
      expect(asked).toEqual(['claude'])
      expect(a.started.map((x) => x.key)).toEqual([ta.key])
      // off is off: the machine's answer is never written into that space's outage, and no card goes to its chat
      expect(b.src.returns.get('task', b.p.name)!.ok).toBeUndefined()
      expect(b.src.returns.get('task', b.p.name)!.back).toBeUndefined()
      expect(cards(tb.key)).toEqual([])
    } finally {
      b.src.settings.set('backup.watchReturn', null, { space: b.p.name })
      a.done()
      b.done()
    }
  })

  test('the shared answer does not restart a space that already went back as often as it may today', async () => {
    const a = await goingBack('share-often-a')
    const b = await goingBack('share-often-b')
    try {
      const ta = a.onBackup()
      const tb = b.onBackup()
      // b went back by itself three times today and ran out again each time: its next return is the human's
      let at = Date.now() - 4 * 3_600_000
      for (let i = 0; i < MAX_RETURNS; i++) {
        b.src.returns.note({ role: 'task', space: b.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'out of allowance', at })
        b.src.returns.wentBack('task', b.p.name, at)
        b.src.returns.answered('task', b.p.name, at + 60_000)
        at += 3_600_000
      }
      const late = Date.now() - FIRST_WAIT * 2
      b.src.returns.note({ role: 'task', space: b.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'out of allowance', at: late })
      a.src.returns.note({ role: 'task', space: a.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'out of allowance', at: late })
      await a.src.watchReturns(later())
      expect(asked).toEqual(['claude'])
      // a goes back; b only hears, with the card that says why
      expect(started.map((x) => x.key)).toEqual([ta.key])
      expect(started.map((x) => x.key)).not.toContain(tb.key)
      expect(cards(tb.key).at(-1)).toContain(`It went back by itself ${MAX_RETURNS} times today and ran out again each time, so this time it waits for you.`)
    } finally {
      b.done()
      a.done()
    }
  })

  test('an agent of the machine at work on the model answers for every space waiting on it', async () => {
    const b = await space('share-work-b')
    const a = await goingBack('share-work-a')
    const status = a.src.agents.status
    try {
      const tb = task(b.p.name, 'codex', { from: 'claude' })
      coordinator(a.key, 'claude')
      a.src.agents.status = ((k: string) => (k === a.key ? 'working' : 'idle')) as never
      const at = Date.now()
      b.src.returns.note({ role: 'task', space: b.p.name, primary: { kind: 'claude' }, to: { kind: 'codex' }, why: 'signed out', at })
      // b's own question is not due yet; the work on the machine answers for it, without a probe
      await a.src.watchReturns(at + QUIET)
      expect(asked).toEqual([])
      expect(cards(tb.key)).toHaveLength(1)
    } finally {
      a.src.agents.status = status
      a.done()
      b.done()
    }
  })
})

describe('every CLI Shepherdr can ask, as the primary that comes back', () => {
  test('each of the five has its own quiet one-shot, and one it has none for is never asked', () => {
    // Claude Code, Codex, pi, OpenCode and Antigravity: no tools, no MCP servers, no session kept
    expect(oneShot({ kind: 'claude' })).toEqual(expect.arrayContaining(['-p', '--no-session-persistence', '--strict-mcp-config', '--restricted']))
    expect(oneShot({ kind: 'codex' })).toEqual(expect.arrayContaining(['exec', '--sandbox', 'read-only', '--skip-git-repo-check']))
    expect(oneShot({ kind: 'pi' })).toEqual(expect.arrayContaining(['-p', '--no-tools', '--no-session', '--no-mcp', '--no-skills']))
    expect(oneShot({ kind: 'opencode' })).toEqual(expect.arrayContaining(['run', '--standalone', '--agent', 'plan']))
    expect(oneShot({ kind: 'agy' })).toEqual(expect.arrayContaining(['-p', '--output-format', 'json', '--mode', 'plan']))
    for (const kind of ['claude', 'codex', 'pi', 'opencode', 'agy']) expect(canProbe(kind)).toBe(true)
    // one Shepherdr knows no silent call for is never asked
    expect(canProbe('gemini')).toBe(false)
    expect(oneShot({ kind: 'gemini' })).toBeUndefined()
  })

  test('each of the five, as the primary, is asked once and its chat hears that it answers', async () => {
    const s = await space('every-cli-back')
    try {
      const backupOf = (kind: string) => (kind === 'codex' ? 'claude' : 'codex')
      for (const kind of ['claude', 'codex', 'pi', 'opencode', 'agy']) {
        // each round starts with nothing kept from the one before
        for (const o of s.src.returns.list()) s.src.returns.forget(o.role, o.space)
        s.src.engine.tasks.length = 0
        for (const k of Object.keys(s.src.agents.records)) delete s.src.agents.records[k]
        asked.length = 0
        expect(s.src.settings.set('task.agent', kind, { space: s.p.name }).ok).toBe(true)
        const t = task(s.p.name, backupOf(kind), { from: kind })
        s.src.returns.note({ role: 'task', space: s.p.name, primary: { kind }, to: { kind: backupOf(kind) }, why: 'out of allowance until 5pm', at: Date.now() - FIRST_WAIT * 2 })
        await s.src.watchReturns(later())
        expect(asked).toEqual([kind])
        expect(cards(t.key)).toHaveLength(1)
      }
    } finally {
      s.src.settings.set('task.agent', null, { space: s.p.name })
      s.done()
    }
  })
})
