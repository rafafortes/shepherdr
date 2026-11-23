// The shepherdr command: who may merge, closing, deleting, base branches, To do and tell, the queue, a task's CLI,
// model and effort, its review rounds, Task IDs and pinned models.
import { afterAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { CODEX_WORDS, PI_WORDS, reviewerLineFor } from './reviewer-line.ts'

process.env.SHEPHERDR_HOME = tmp('source')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
// no OpenCode database of this machine: its mirror copies rows from one that isn't there (an OpenCode log reads as a
// copy of its session)
process.env.SHEPHERDR_OPENCODE_DB = join(process.env.SHEPHERDR_HOME, 'no-opencode.db')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { herdr } = await import('../server/live/herdr.ts')
const { hidden } = await import('../server/live/agents.ts')
const { WorkerHealth } = await import('../server/live/recovery.ts')
const { Worktrees } = await import('../server/live/engine/worktrees.ts')
const { fakeHerdr } = await import('./fake-herdr.ts')
const { setPicks } = await import('../server/live/model-picks.ts')
const { NO_PICKS } = await import('../shared/picks.ts')
const { agentEnv } = await import('../server/live/box.ts')
const { taskTmpDir } = await import('../server/live/task-tmp.ts')
const { ROOT: APP_ROOT } = await import('../server/root.ts')
const { ADVISOR_AT_ONCE } = await import('../shared/apply-waiting.ts')
const { HELP } = await import('../server/live/args.ts')

const src = new LiveSource()
// this file is not about the spacing between starts: with machine.startEvery's 2 minutes, the shared machine of these
// tests would start one task every two minutes (every start Shepherdr makes by itself follows it now, engine.startGate)
src.settings.set('machine.startEvery', '0', 'machine')
// herdr makes task worktrees: a stand-in on real git; no terminal opens for their agents (no herdr is there)
const fake = fakeHerdr()
fake.h.createTab = async () => {
  throw new Error('herdr is not here')
}
Object.assign(src.engine, { wt: new Worktrees(fake.h as never) })
afterAll(() => src.stop())

/** what a test waits for has come true, however slow the machine (a timer, another process) */
const until = async (f: () => boolean, ms = 8000, said = 'it') => {
  for (const t0 = Date.now(); !f(); await Bun.sleep(20)) if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${said}`)
}

/**
 * Something that only has to settle before the tests after this one (an agent herdr can't start): waited for at
 * most 8 s — the 20 s these tests run in is the other bound — and the test goes on either way, however slow the
 * machine. The fixed 5 s these had failed a slow runner; a longer wait would only spend a test's own time.
 */
const settle = (f: () => boolean, said: string) => until(f, 8000, said).catch(() => undefined)

/** a repo a test made, with its first commit (never the folder the tests run from) */
const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'

/**
 * The test's own git, bounded: 30 s, and a stalled one says which command it was, instead of bun taking the whole test
 * away with no word on the step (SHE-9 bounded the engine worlds' and herdr's stand-in after run 42020185856, but a
 * timeout there reads just "ETIMEDOUT", which names nothing either).
 */
const run = (cmd: string, cwd: string): string => {
  try {
    return execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8', timeout: 30_000 }).trim()
  } catch (e) {
    throw new Error(`\`${cmd}\` in ${cwd}: ${(e as Error).message.trim()}`, { cause: e })
  }
}

/** how many tasks a place holds: what a refused add must leave exactly as it was, whatever else the home holds */
const tasksIn = (place: string) => src.engine.tasks.filter((t) => t.project === place).length

/** a project with a task whose agent has committed work on its branch (herdr isn't there: its agent can't start) */
async function workedTask(name: string) {
  const dir = tmp('src-repo')
  run(REPO, dir)
  const p = await src.places.add(dir, name)
  return { t: await worked(p), dir, place: placeId.space(p.name) }
}

/**
 * The worktree herdr's stand-in makes for a task, waited for until it is there or the start has said why it can't be —
 * so a start that never gets one fails with the app's own words, inside the 20 s a test has unless it says otherwise.
 */
async function worktree(t: { id: string; worktree?: string; trouble?: string }, ms = 15_000) {
  await until(() => !!t.worktree || !!t.trouble, ms, `${t.id}'s worktree`)
  if (!t.worktree) throw new Error(`${t.id} got no worktree: ${t.trouble}`)
}

/**
 * A task in a place already there, its agent's work committed on its branch (herdr isn't there: its agent can't
 * start). It waits for the worktree herdr's stand-in makes, so the commit never lands in a folder not there yet.
 */
async function worked(p: { name: string }, file = 'x.txt') {
  const t = src.engine.add({ project: p.name, title: 'Worked', by: 'test' })
  await worktree(t)
  run(`echo x > ${file} && git add -A && git commit -qm work`, t.worktree!)
  return t
}

describe('private instruction CLI', () => {
  test('an explicit empty value suppresses inherited instructions without restarting agents', async () => {
    try {
      expect((await src.cli(['set', 'task.instructions', 'Everywhere rule.'], {})).code).toBe(0)
      const blank = await src.cli(['set', 'task.instructions', '', '--machine'], {})
      expect(blank.code).toBe(0)
      expect(blank.out).toContain('running agents are unchanged')
      expect(src.settings.get('task.instructions')).toBe('')
      expect(src.settings.pick('task.instructions').from).toBe('machine')
      expect((await src.cli(['unset', 'task.instructions', '--machine'], {})).code).toBe(0)
      expect(src.settings.get('task.instructions')).toBe('Everywhere rule.')
    } finally {
      src.settings.set('task.instructions', null, 'machine')
      src.settings.set('task.instructions', null)
    }
  })
})

describe('merging from the command', () => {
  test("a task's agent merges its own task, and only its own", async () => {
    const { t, dir } = await workedTask('own')
    const other = await workedTask('other')
    const no = await src.cli(['merge', other.t.id], { chat: `${t.id}/Agent` })
    expect(no.code).toBe(1)
    expect(no.out).toContain('only its own task')
    expect(other.t.merged).toBeFalsy()
    const r = await src.cli(['merge', t.id], { chat: `${t.id}/Agent` })
    expect(r.out).toContain(`Merged ${t.id} into main`)
    expect(r.out).toContain('do nothing more in them')
    expect(existsSync(join(dir, 'x.txt'))).toBe(true)
    expect(src.engine.statusOf(t)).toBe('done')
  })
  test("shepherdr pr and checks: a task's agent works on its own only, and a repo with no GitHub says so", async () => {
    const { t } = await workedTask('prs')
    const other = await workedTask('prs2')
    const no = await src.cli(['pr', other.t.id], { chat: `${t.id}/Agent` })
    expect(no.code).toBe(1)
    expect(no.out).toContain('its own task')
    const r = await src.cli(['pr', t.id], { chat: `${t.id}/Agent` })
    expect(r.code).toBe(0)
    expect(r.out).toContain('No pull request')
    expect((await src.cli(['checks', t.id], { chat: `${t.id}/Agent` })).out).toContain('No GitHub checks')
  })
  test('doctor and checks pass their interim words out through the command step channel', async () => {
    const { t } = await workedTask('steps')
    const peers = src.peers
    if (!peers) throw new Error('no machines in this world')
    const doctor = peers.doctor
    const checks = src.engine.checks
    const steps: string[] = []
    try {
      peers.doctor = (async (step?: (words: string) => void) => {
        step?.('one (one.test): helper put there again, worker started again')
        return ['one (one.test): helper put there again, worker started again']
      }) as never
      src.engine.checks = (async (_id: string, _wait: number | undefined, step?: (words: string) => void) => {
        step?.('checks: 1 passed, still running')
        step?.('checks: 2 passed')
        return { ok: true, text: "GitHub's checks passed on PR #1 (2)." }
      }) as never
      expect((await src.cli(['doctor'], {}, (w) => steps.push(w))).out).toContain('one (one.test)')
      expect((await src.cli(['checks', t.id], { chat: `${t.id}/Agent` }, (w) => steps.push(w))).out).toContain('checks passed on PR #1')
      expect(steps).toEqual(['one (one.test): helper put there again, worker started again', 'checks: 1 passed, still running', 'checks: 2 passed'])
    } finally {
      peers.doctor = doctor
      src.engine.checks = checks
    }
  })
  test("a Done card links the task's pull request", async () => {
    const { t, place } = await workedTask('prcard')
    const pr = { number: 7, url: 'https://github.com/acme/app/pull/7' }
    ;(src as unknown as { onCard(t: unknown, s: string, sub: string): void }).onCard({ ...t, pr, posted: 'done|x' }, 'done', 'x')
    expect(src.chats.chat(place).messages.find((m) => m.card?.status === 'done')?.card?.pr).toEqual(pr)
  })
  test("a merged task gets a Done card in its project's chat, which takes reactions like a message", async () => {
    const { t, place } = await workedTask('carded')
    await src.engine.done(t.id, 'Added x.txt.')
    expect((await src.cli(['merge', t.id], {})).out).toContain('Merged')
    // (herdr isn't here, so its start went wrong: that card comes first)
    const cards = () => src.chats.chat(place).messages.filter((m) => m.card?.status === 'done')
    // one line of a few words: its summary is in the task
    expect(cards().map((m) => [m.card!.status, m.card!.text, m.text])).toEqual([['done', 'is merged', `${t.id} is merged`]])
    // a tap on it sends the reaction as a chat line quoting the card
    const sent: string[] = []
    const send = src.agents.send
    src.agents.send = (async (_k: string, text: string) => (sent.push(text), { waiting: false })) as typeof send
    try {
      expect(await src.act({ type: 'react', chat: place, message: cards()[0].id, emoji: '🎉' })).toEqual({})
    } finally {
      src.agents.send = send
    }
    expect(sent).toEqual([`<reaction from="${src.user}" emoji="🎉" to="${t.id} is merged"/>`])
    // read back from the log, it lands on the card
    const ev = (src.chats as unknown as { events: Map<string, unknown[]> }).events
    ev.set(place, [...(ev.get(place) ?? []), { kind: 'user', id: 'r1', at: Date.now() + 10, text: sent[0] }])
    expect(cards()[0].reactions).toEqual([{ emoji: '🎉', by: 'me' }])
  })
  test("a coordinator's <no-reply> after the news shows nothing in the chat; its words do", async () => {
    const { t, place } = await workedTask('noted')
    expect((await src.cli(['merge', t.id], {})).out).toContain('Merged')
    const ev = (src.chats as unknown as { events: Map<string, unknown[]> }).events
    const at = Date.now() + 10
    ev.set(place, [
      ...(ev.get(place) ?? []),
      { kind: 'user', id: 'n1', at, text: hidden(`${t.id} was merged.`, 'news', { task: t.id, event: 'merged' }) },
      { kind: 'agent', id: 'a1', at: at + 1, text: '<no-reply>merged, nothing next</no-reply>' },
    ])
    const agentSaid = () => src.chats.chat(place).messages.filter((m) => m.who === 'agent' && !m.card)
    expect(agentSaid()).toEqual([])
    expect(src.chats.lastReply(place)).toBe('')
    ev.set(place, [...(ev.get(place) ?? []), { kind: 'agent', id: 'a2', at: at + 2, text: '<no-reply>merged</no-reply>\nNext: start SHE-9.' }])
    expect(agentSaid().map((m) => m.text)).toEqual(['<no-reply>merged</no-reply>\nNext: start SHE-9.'])
  })
  test('a coordinator merges when the human asks, and you from a terminal', async () => {
    const a = await workedTask('coord')
    expect((await src.cli(['task', 'merge', a.t.id], { chat: a.place })).out).toContain('Merged')
    const b = await workedTask('term')
    expect((await src.cli(['merge', b.t.id], {})).out).toContain('Merged')
    expect(existsSync(join(b.dir, 'x.txt'))).toBe(true)
  })
  test('task list shows Done tasks newest finished first, after the rest', async () => {
    // Three tasks in one place: the list is the whole home's, and every place of its own is another real repo with
    // its worktrees and its merge's git calls, on a runner that runs the browser tests beside this one (SHE-9 met a
    // shard six times slower than its rerun). This test made three before.
    const dir = tmp('src-repo')
    run(REPO, dir)
    const p = await src.places.add(dir, 'listed')
    const a = await worked(p, 'first.txt')
    const b = await worked(p, 'second.txt')
    const open = src.engine.add({ project: p.name, title: 'Open', by: 'test' })
    // it is never merged, so it gets no work; its place is made all the same, and nothing here races that
    await worktree(open)
    /**
     * Merged, and Done on record before the next one starts — what the list's order is made of. The merge answers
     * only once it is Done (markMerged sets its finish time before it answers), so there is nothing left to wait for.
     */
    const merged = async (t: { id: string }) => {
      expect((await src.cli(['merge', t.id], {})).out).toContain('Merged')
      expect(typeof src.engine.view(src.engine.task(t.id)!).doneAt).toBe('number')
    }
    await merged(a)
    await merged(b)
    const ids = [a.id, b.id, open.id]
    const listed = (JSON.parse((await src.cli(['task', 'list', '--json'], {})).out) as { id: string }[]).map((t) => t.id).filter((id) => ids.includes(id))
    expect(listed).toEqual([open.id, b.id, a.id])
    expect(b.doneAt!).toBeGreaterThan(a.doneAt!)
    expect(src.engine.view(b).doneAt).toBe(b.doneAt!)
    expect(src.engine.view(open).doneAt).toBeUndefined()
    // Real git: three worktrees, two commits in them, a rebase and two merges into one repo. It takes under 2 s on a
    // quiet runner, and it was its 20 s it ran out of in run 42083009810, shard 3, whose log says only "timed out": which
    // step stalled is unknown (a sibling test in the same shard was then at its usual 330 ms, and the shard ran the
    // browser tests' 3 to 10 s swipes beside it). What this test asks of git itself is bounded and named — 30 s, in
    // run() and herdr's stand-in — and the engine's own merge steps are not: a stall in one of those still ends as
    // bun's timeout here. 60 s leaves a slow runner the room the 20 s it had did not.
  }, 60_000)
  test('the old task settings and their flags are gone', async () => {
    expect((await src.cli(['set', 'merge.by', 'by itself'], {})).code).toBe(1)
    expect((await src.cli(['review', 'X-1', '--verdict', 'pass'], {})).code).toBe(1)
    expect((await src.cli(['task', 'pick', 'X-1', 'A'], {})).code).toBe(1)
  })
})

describe('closing from the command', () => {
  /** a project with a task whose agent made no changes */
  async function emptyTask(name: string) {
    const dir = tmp('src-repo')
    run(REPO, dir)
    const p = await src.places.add(dir, name)
    const t = src.engine.add({ project: p.name, title: 'Answer', by: 'test' })
    await worktree(t)
    return { t, dir, place: placeId.space(p.name) }
  }

  test('a coordinator closes a task with nothing to merge: Done, and its card says so', async () => {
    const { t, place } = await emptyTask('closed')
    const other = await emptyTask('notyours')
    const no = await src.cli(['task', 'close', t.id], { chat: `${other.t.id}/Agent` })
    expect(no.code).toBe(1)
    expect(no.out).toContain('Coordinators close tasks')
    const r = await src.cli(['task', 'close', t.id, '--summary', 'Answered in chat.'], { chat: place })
    expect(r.code).toBe(0)
    expect(r.out).toContain(`Closed ${t.id}: it is Done`)
    expect(r.out).toContain('its working folder and branch are gone')
    expect(src.engine.statusOf(t)).toBe('done')
    expect(src.engine.view(t).sub).toBe('Nothing to merge')
    const cards = src.chats.chat(place).messages.filter((m) => m.card?.status === 'done')
    expect(cards.map((m) => m.text)).toEqual([`${t.id} is done, nothing to merge`])
    expect((await src.cli(['task', 'close', t.id], { chat: place })).out).toContain('Done already (nothing to merge)')
    expect((await src.cli(['merge', t.id], { chat: place })).out).toContain('nothing to merge')
  })

  test('a task whose work is in main already reports ready as Done (merged): no pull request, nothing to merge', async () => {
    const { t, dir } = await workedTask('inmain')
    // the person squashed its branch into main by hand, no pull request at all
    run(`git merge -q --squash ${t.branch} && git commit -qm "the work, by hand"`, dir)
    const r = await src.cli(['ready', t.id, '--summary', 'Added x.txt.'], { chat: `${t.id}/Agent` })
    expect(r.out).toContain(`its work was in main already, so ${t.id} is Done (merged)`)
    expect(r.out).toContain('do nothing more in them')
    expect(src.engine.statusOf(t)).toBe('done')
  })

  test("a task agent's ready on a branch with no changes is Done at once; done, its old name, still works", async () => {
    const { t, place } = await emptyTask('research')
    const r = await src.cli(['ready', t.id, '--summary', 'The answer is 42.'], { chat: `${t.id}/Agent` })
    expect(r.out).toContain('nothing to merge')
    expect(r.out).toContain('do nothing more in them')
    expect(src.engine.statusOf(t)).toBe('done')
    const cards = src.chats.chat(place).messages.filter((m) => m.card?.status === 'done')
    expect(cards.map((m) => m.card!.text)).toEqual(['is done, nothing to merge'])
    expect((await src.cli(['done', t.id], { chat: `${t.id}/Agent` })).out).toContain('Done already (nothing to merge)')
  })

  test('a summary past 160 characters is refused, for the agent to rewrite; the facts go apart, kept off the card', async () => {
    const { t, place } = await emptyTask('short')
    const long = await src.cli(['ready', t.id, '--summary', 'x'.repeat(161)], { chat: `${t.id}/Agent` })
    expect(long.code).toBe(1)
    expect(long.out).toContain('That summary is 161 characters: write a shorter one, 160 at most')
    expect(src.engine.statusOf(t)).not.toBe('done')
    // a facts line written at the summary's end comes apart, and doesn't count
    const r = await src.cli(['ready', t.id, '--summary', `Cards are short. Facts: branch work/1-x · ${'checks passed · '.repeat(12)}`], { chat: `${t.id}/Agent` })
    expect(r.code).toBe(0)
    expect(src.engine.view(t).said).toBe('Cards are short.')
    expect(src.engine.view(t).facts).toStartWith('branch work/1-x · checks passed')
    const card = src.chats.chat(place).messages.find((m) => m.card?.status === 'done')!.card!
    expect(JSON.stringify(card)).not.toContain('Cards are short')
    expect(JSON.stringify(card)).not.toContain('checks passed')
  })
})

describe('deleting a task from the command', () => {
  test('only a coordinator deletes; work main lacks is refused unless --force; then it is gone from every list', async () => {
    const { t, dir, place } = await workedTask('deleting')
    const key = `${t.id}/Agent`
    const no = await src.cli(['task', 'delete', t.id], { chat: key })
    expect(no.code).toBe(1)
    expect(no.out).toContain('only a coordinator')
    const held = await src.cli(['task', 'delete', t.id], { chat: place })
    expect(held.code).toBe(1)
    expect(held.out).toContain(`Not deleted: ${t.id} holds`)
    expect(held.out).toContain('--force')
    expect(src.engine.task(t.id)).toBe(t)
    // its chat had a log and a file
    src.chats.post(key, { id: 'x', text: 'A card' })
    const file = await src.upload(key, 'a.txt', new TextEncoder().encode('a'))
    const r = await src.cli(['task', 'delete', '--force', t.id], { chat: place })
    expect(r.out).toContain(`Deleted ${t.id}`)
    expect(src.engine.task(t.id)).toBeUndefined()
    expect(existsSync(t.worktree!)).toBe(false)
    expect(run('git branch --list "work/*"', dir)).toBe('')
    expect(existsSync(join(process.env.SHEPHERDR_HOME!, 'chatlog', `${key.replace('/', '_')}.json`))).toBe(false)
    expect(existsSync(file)).toBe(false)
    expect(src.agents.record(key)).toBeUndefined()
    expect((await src.cli(['task', 'list'], {})).out).not.toContain(t.id)
  })

  test('a merged task can be deleted; its commits stay on main', async () => {
    const { t, dir } = await workedTask('delmerged')
    expect((await src.cli(['merge', t.id], {})).out).toContain('Merged')
    const r = await src.cli(['task', 'delete', t.id], {})
    expect(r.out).toContain(`Its commits stay on main`)
    expect(src.engine.task(t.id)).toBeUndefined()
    expect(existsSync(join(dir, 'x.txt'))).toBe(true)
  })
})

describe('base branch choices', () => {
  test('CLI and Settings keep task snapshots, validate before adding, and show the target', async () => {
    const dir = tmp('base-cli')
    run('git init -q -b main && git config user.email t@t && git config user.name T && touch README && git add . && git commit -qm init && git branch develop && git branch feature/topic', dir)
    const p = await src.places.add(dir, 'base-cli')
    const place = placeId.space(p.name)
    expect((await src.cli(['set', 'space.base', 'develop', '--space', p.name], {})).code).toBe(0)
    expect((await src.cli(['show', '--space', p.name], {})).out).toContain('Base branch: develop')
    const add = await src.cli(['task', 'add', 'Use feature', '--base', 'feature/topic', '--space', p.name], {})
    expect(add.code).toBe(0)
    const t = src.engine.tasks.at(-1)!
    expect(t.base).toBe('feature/topic')
    expect((await src.cli(['task', 'show', t.id], {})).out).toContain('Merges into: feature/topic')
    const count = tasksIn(place)
    expect((await src.cli(['task', 'add', 'Bad base', '--base', 'missing', '--space', p.name], {})).code).toBe(1)
    expect(tasksIn(place)).toBe(count)
    expect((await src.cli(['space', 'set', 'base', 'main', '--space', p.name], {})).code).toBe(0)
    expect(t.base).toBe('feature/topic')
    expect(await src.act({ type: 'setting', place, key: 'space.base', value: 'develop' })).toMatchObject({ ok: true })
    expect(await src.act({ type: 'setting', place, key: 'space.base', value: 'missing' })).toMatchObject({ ok: false })
    expect(p.base).toBe('develop')
    expect(src.snapshot().settings.find((s) => s.level === place && s.name === 'Repository')!.rows[0].value).toBe('develop')
    expect((await src.cli(['set', 'space.base', 'main'], {})).code).toBe(1)
    expect((await src.cli(['set', 'space.base', 'main', '--space', 'home'], {})).code).toBe(1)
    await until(() => !!t.trouble)
  })
})

describe('To do from the command', () => {
  test('task add starts its agent; shepherdr todo shows it as To do, and a message to its agent is the go', async () => {
    const dir = tmp('src-repo')
    run(REPO, dir)
    const p = await src.places.add(dir, 'later')
    const place = placeId.space(p.name)
    // a title too long for one line on a phone is refused, and nothing is added
    const before = tasksIn(place)
    const long = await src.cli(['task', 'add', 'Reply to any message, plus what the best chats do', '--desc', 'x'], { chat: place })
    expect(long.code).toBe(1)
    expect(long.out).toContain('49 characters')
    expect(long.out).toContain('write a shorter one, at most 30 characters')
    expect(long.out).toContain('32 are still accepted')
    expect(tasksIn(place)).toBe(before)
    expect((await src.cli(['automation', 'add', 'Nightly', '--task', 'x'.repeat(33), '--when', 'FREQ=DAILY'], { chat: place })).code).toBe(1)
    const add = await src.cli(['task', 'add', 'Noted', '--desc', 'For later.', '--later'], { chat: place })
    expect(add.out).toContain('Its agent (Claude Code) reads the brief now and waits for a go')
    const id = add.out.match(/([A-Z]+-\d+)/)![1]
    const other = await src.cli(['task', 'add', 'Next', '--desc', 'x'], { chat: place })
    expect(src.engine.task(add.out.match(/([A-Z]+-\d+)/)![1])!.desc).toStartWith("For later.\n\nDon't start yet: wait for a go.")
    // the old ways are gone
    expect((await src.cli(['task', 'start', id], { chat: place })).code).toBe(1)
    expect((await src.cli(['task', 'edit', id, '--desc', 'x'], { chat: place })).code).toBe(1)
    // herdr isn't here: its agents can't start. Let that settle before the tests after this one
    const t = src.engine.task(id)!
    const next = src.engine.task(other.out.match(/([A-Z]+-\d+)/)![1])!
    await settle(() => !!(t.trouble && next.trouble), 'their agents to fail to start')
    expect((await src.cli(['todo', id], { chat: `${next.id}/Agent` })).code).toBe(1)
    expect((await src.cli(['todo', id], { chat: `${id}/Agent` })).out).toContain('To do until it gets a go')
    expect(t.todo).toBe(true)
    // the go is a message to its agent: it waits for the agent, and the task is no longer To do. Its own space's
    // coordinator told it, so its agent reads who sent it, in the envelope every agent's message arrives in
    await src.cli(['task', 'tell', id, 'Go.'], { chat: place })
    expect(src.agents.waiting(`${id}/Agent`).map((o) => o.text)).toEqual([`<agent-message from="${p.name} coordinator" to="${id} agent" space="${p.name}">Go.</agent-message>`])
    expect(t.todo).toBeUndefined()
    src.agents.outbox = src.agents.outbox.filter((o) => o.key !== `${id}/Agent`)
  })
})

describe('A tell with no chat of its own', () => {
  test('a plain terminal sends no envelope: its words are the human’s, as typed, and the command says Told or that it is held', async () => {
    const dir = tmp('src-repo')
    run(REPO, dir)
    const p = await src.places.add(dir, 'plain')
    const place = placeId.space(p.name)
    const add = await src.cli(['task', 'add', 'Noted', '--desc', 'For later.', '--later'], { chat: place })
    const id = add.out.match(/([A-Z]+-\d+)/)![1]
    const t = src.engine.task(id)!
    // herdr isn't here: its agent can't start. Let that settle before the tests after this one
    await settle(() => !!t.trouble, 'its agent to fail to start')
    // no chat and no pane: like the systemd timer that runs `shepherdr task tell <id> <text>`, and the words go in
    // exactly as typed, because a plain terminal is no agent talking
    expect((await src.cli(['task', 'tell', id, 'Go.'], {})).out).toBe(`Told ${id}.\n`)
    expect(src.agents.waiting(`${id}/Agent`).map((o) => o.text)).toEqual(['Go.'])
    src.agents.outbox = src.agents.outbox.filter((o) => o.key !== `${id}/Agent`)
    // no room on the machine: it is held, says so, and the words wait with it, still plain. (herdr can't start an agent
    // here, so its start failed and it would show as needing you: as if it had said it waits, it is To do)
    t.trouble = undefined
    src.engine.todo(id)
    const machine = src.engine.machine
    src.engine.machine = () => ({ busy: 'cpu' as const, herdr: true })
    try {
      expect((await src.cli(['task', 'tell', id, 'Not yet.'], {})).out).toContain(`${id} is held`)
    } finally {
      src.engine.machine = machine
    }
    expect(t.held?.go).toBe('Not yet.')
    // nothing left behind for the tests after this one: not held, and nothing queued for its agent
    t.held = undefined
    src.agents.outbox = src.agents.outbox.filter((o) => o.key !== `${id}/Agent`)
  })
})

describe('first in line, from the command and the screen', () => {
  test('task add --priority and task priority mark one first in line; task start is yours, task priority anyone but its agent', async () => {
    const dir = tmp('src-repo')
    run(REPO, dir)
    const p = await src.places.add(dir, 'prio')
    const place = placeId.space(p.name)
    const idOf = (out: string) => out.match(/([A-Z]+-\d+)/)![1]
    const engine = src.engine as unknown as { machine?: () => { busy?: string; herdr: boolean } }
    const was = engine.machine
    // herdr not answering holds even one first in line: they all wait, marked or not
    engine.machine = () => ({ herdr: false })
    try {
      const plain = idOf((await src.cli(['task', 'add', 'Later on', '--desc', 'x'], { chat: place })).out)
      expect(src.engine.task(plain)!.held?.why).toBe('machine')
      const fix = idOf((await src.cli(['task', 'add', 'Fix main', '--desc', 'y', '--priority'], { chat: place })).out)
      expect(src.engine.task(fix)!.priority).toBe(true)
      expect((await src.cli(['task', 'priority', plain], { chat: place })).out).toContain(`${plain} is first in line: it starts at the next free slot, past the machine's load`)
      expect((await src.cli(['task', 'priority', plain, 'off'], { chat: place })).out.trim()).toBe(`${plain} is back in line by its age.`)
      expect((await src.cli(['task', 'priority', plain], { chat: `${fix}/Agent` })).out).toContain("A task's agent doesn't set priorities")
      // start now is the human's: a coordinator is pointed at task priority
      expect((await src.cli(['task', 'start', plain], { chat: place })).out).toContain(`Only the human starts a task now. To put ${plain} first in line, run shepherdr task priority ${plain}.`)
      // still no herdr: first in line, at the next chance
      const held = (await src.cli(['task', 'start', plain], {})).out
      expect(held).toStartWith(`${plain} is first in line: the machine is busy (`)
      expect(held).toContain("It starts as soon as there's room, ahead of the others.")
      // herdr back, the machine still loaded: started at once, past the load
      engine.machine = () => ({ busy: 'cpu', herdr: true })
      expect((await src.cli(['task', 'start', plain], {})).out.trim()).toBe(`Started ${plain} now.`)
      expect((await src.cli(['task', 'start', plain], {})).out).toContain(`${plain} isn't waiting to start`)
      // the screen's Start now with…: a CLI there is none of, a model its CLI lacks, or the worker picked
      const third = idOf((await src.cli(['task', 'add', 'Third', '--desc', 'z'], { chat: place })).out)
      expect(await src.act({ type: 'start-now', chat: 'NOPE-9/Agent' })).toEqual({ ok: false, error: 'No such task.' })
      expect(await src.act({ type: 'start-now', chat: `${third}/Agent`, kind: 'nope' })).toEqual({ ok: false, error: 'No CLI called nope.' })
      expect(((await src.act({ type: 'start-now', chat: `${third}/Agent`, kind: 'claude', model: 'no-such-model' })) as { ok: boolean }).ok).toBe(false)
      expect(await src.act({ type: 'start-now', chat: `${third}/Agent`, kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })).toEqual({ ok: true })
      expect(src.engine.task(third)!.agent).toEqual({ kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })
      expect(((await src.act({ type: 'start-now', chat: `${third}/Agent` })) as { ok: boolean }).ok).toBe(false)
      // Start with…: its worker only, in line as it is
      const fourth = idOf((await src.cli(['task', 'add', 'Fourth', '--desc', 'w'], { chat: place })).out)
      expect(await src.act({ type: 'start-with', chat: 'NOPE-9/Agent', kind: 'pi' })).toEqual({ ok: false, error: 'No such task.' })
      expect(await src.act({ type: 'start-with', chat: `${fourth}/Agent`, kind: 'nope' })).toEqual({ ok: false, error: 'No CLI called nope.' })
      expect(((await src.act({ type: 'start-with', chat: `${fourth}/Agent`, kind: 'claude', model: 'no-such-model' })) as { ok: boolean }).ok).toBe(false)
      expect(await src.act({ type: 'start-with', chat: `${fourth}/Agent`, kind: 'claude', model: 'claude-sonnet-5-5' })).toEqual({ ok: true })
      expect(src.engine.task(fourth)!.agent).toEqual({ kind: 'claude', model: 'claude-sonnet-5-5' })
      // one that is no longer waiting to start is Restart agent…'s
      src.engine.task(fourth)!.closed = true
      expect(await src.act({ type: 'start-with', chat: `${fourth}/Agent`, kind: 'pi' })).toEqual({ ok: false, error: `${fourth} isn't waiting to start: Restart agent… changes what it runs on` })
    } finally {
      engine.machine = was
    }
  })
})

describe('Settings changed: the waiting tasks take it, from the screen and the command', () => {
  test('the screen asks first (dry) and applies on yes; the command says what it applied with --apply-waiting; other keys are refused', async () => {
    const dir = tmp('src-repo')
    run(REPO, dir)
    const p = await src.places.add(dir, 'retune-src')
    const place = placeId.space(p.name)
    const idOf = (out: string) => out.match(/([A-Z]+-\d+)/)![1]
    const engine = src.engine as unknown as { machine?: () => { busy?: string; herdr: boolean } }
    const was = engine.machine
    // herdr not answering holds every task: they all wait
    engine.machine = () => ({ herdr: false })
    try {
      const a = idOf((await src.cli(['task', 'add', 'Waits', '--desc', 'x'], { chat: place })).out)
      const b = idOf((await src.cli(['task', 'add', 'Waits too', '--desc', 'y'], { chat: place })).out)
      expect(src.engine.task(a)!.held?.why).toBe('machine')
      expect(await src.act({ type: 'apply-to-waiting', key: 'space.base', place, dry: true })).toEqual({ ok: false, error: 'space.base is not a task agent or reviewer setting.' })
      expect(await src.act({ type: 'setting', key: 'task.agent', value: 'pi', place })).toEqual({ ok: true })
      // the question first: what would change, and nothing does
      expect(await src.act({ type: 'apply-to-waiting', key: 'task.agent', place, dry: true })).toMatchObject({ ok: true, changed: 2, same: 0, running: 0, kept: [] })
      expect(src.engine.task(a)!.agent).toMatchObject({ kind: 'claude' })
      // yes
      const yes = await src.act({ type: 'apply-to-waiting', key: 'task.agent', place })
      expect(yes).toMatchObject({ ok: true, changed: 2, spaces: [{ name: p.name, words: 'pi', changed: 2 }] })
      expect([src.engine.task(a)!.agent, src.engine.task(b)!.agent]).toEqual([{ kind: 'pi' }, { kind: 'pi' }])
      expect(await src.act({ type: 'apply-to-waiting', key: 'task.agent', place, dry: true })).toMatchObject({ changed: 0, same: 2 })
      // the command twin: a line says what it did; the flag goes with a task agent key only
      expect((await src.cli(['set', 'space.maxTasks', '3', '--space', p.name, '--apply-waiting'], { chat: place })).out).toContain(
        '--apply-waiting goes with shepherdr set task.agent, task.model, task.effort or a reviewer.* key',
      )
      const cli = await src.cli(['set', 'task.agent', 'Claude Code', '--space', p.name, '--apply-waiting'], { chat: place })
      expect(cli.code).toBe(0)
      expect(cli.out).toContain('2 waiting tasks in ' + p.name + ' will start on Claude Code when their turn comes.')
      expect(src.engine.task(a)!.agent).toMatchObject({ kind: 'claude' })
      // a space that is not there is refused
      expect(await src.act({ type: 'apply-to-waiting', key: 'task.agent', place: 'p:nowhere:nothing', dry: true })).toEqual({ ok: false, error: 'No such space.' })
    } finally {
      engine.machine = was
    }
  })
})

describe("Settings reviewer changed: the waiting tasks' reviewer, from the screen and the command", () => {
  test('a reviewer key asks and applies like the task agent; an advisor key is refused: it applies at once already', async () => {
    const dir = tmp('src-repo')
    run(REPO, dir)
    const p = await src.places.add(dir, 'retune-rev')
    const place = placeId.space(p.name)
    const idOf = (out: string) => out.match(/([A-Z]+-\d+)/)![1]
    const engine = src.engine as unknown as { machine?: () => { busy?: string; herdr: boolean } }
    const was = engine.machine
    // herdr not answering holds every task: they all wait, with no worktree
    engine.machine = () => ({ herdr: false })
    try {
      const a = idOf((await src.cli(['task', 'add', 'Waits', '--desc', 'x'], { chat: place })).out)
      const b = idOf((await src.cli(['task', 'add', 'Waits too', '--desc', 'y'], { chat: place })).out)
      const codex = src.engine.task(a)!.desc
      expect(codex).toContain(reviewerLineFor(CODEX_WORDS, a))
      expect(await src.act({ type: 'setting', key: 'reviewer.agent', value: 'pi', place })).toEqual({ ok: true })
      // the question first: what would change, and nothing does
      expect(await src.act({ type: 'apply-to-waiting', key: 'reviewer.agent', place, dry: true })).toMatchObject({
        ok: true,
        changed: 2,
        same: 0,
        running: 0,
        kept: [],
        spaces: [{ name: p.name, words: 'pi', changed: 2 }],
      })
      expect(src.engine.task(a)!.desc).toBe(codex)
      // yes: the Reviewer line of each brief says pi, and nothing else of it moves
      expect(await src.act({ type: 'apply-to-waiting', key: 'reviewer.agent', place })).toMatchObject({ ok: true, changed: 2 })
      expect(src.engine.task(a)!.desc).toBe(codex.replace(reviewerLineFor(CODEX_WORDS, a), reviewerLineFor(PI_WORDS, a, '', "(this space's setting)")))
      expect([src.engine.task(a)!.reviewer?.kind, src.engine.task(b)!.reviewer?.kind]).toEqual(['pi', 'pi'])
      expect(await src.act({ type: 'apply-to-waiting', key: 'reviewer.agent', place, dry: true })).toMatchObject({ changed: 0, same: 2 })
      // a backup reviewer's key goes through the same action, and the chain's keys too
      expect(await src.act({ type: 'apply-to-waiting', key: 'reviewer.fallback3Model', place, dry: true })).toMatchObject({ ok: true, changed: 0, same: 2 })
      // the command twin: a line says what it did, in the reviewer's words
      const cli = await src.cli(['set', 'reviewer.agent', 'Codex', '--space', p.name, '--apply-waiting'], { chat: place })
      expect(cli.code).toBe(0)
      expect(cli.out).toContain('2 waiting tasks in ' + p.name + ' are reviewed by Codex when their turn comes.')
      expect(src.engine.task(a)!.reviewer?.kind).toBe('codex')
      // an advisor's key is refused by the action and by the command, which changes nothing
      const advisor = await src.act({ type: 'apply-to-waiting', key: 'advisor.agent', place, dry: true })
      expect(advisor).toEqual({ ok: false, error: ADVISOR_AT_ONCE })
      const advisorBefore = src.settings.get('advisor.agent', p.name)
      const refused = await src.cli(['set', 'advisor.agent', 'pi', '--space', p.name, '--apply-waiting'], { chat: place })
      expect(refused.out).toContain('advisor.* applies at once')
      expect(refused.out).toContain('Set it without --apply-waiting.')
      expect(src.settings.get('advisor.agent', p.name)).toBe(advisorBefore)
      // a key that is neither: refused, as before
      expect(await src.act({ type: 'apply-to-waiting', key: 'reviewer.instructions', place, dry: true })).toEqual({
        ok: false,
        error: 'reviewer.instructions is not a task agent or reviewer setting.',
      })
    } finally {
      engine.machine = was
    }
  })

  test('every key the waiting tasks read is a real Settings row', async () => {
    const { REVIEWER_KEYS, TASK_AGENT_KEYS, waitingKind } = await import('../shared/apply-waiting.ts')
    const { CATALOG } = await import('../server/live/settings.ts')
    const rows = new Set(CATALOG.flatMap((s) => s.rows.map((r) => r.key)))
    for (const key of [...REVIEWER_KEYS, ...TASK_AGENT_KEYS]) expect([key, rows.has(key)]).toEqual([key, true])
    expect(REVIEWER_KEYS).toHaveLength(18)
    expect([waitingKind('reviewer.fallback4Effort'), waitingKind('task.model'), waitingKind('advisor.agent'), waitingKind('reviewer.instructions')]).toEqual([
      'reviewer',
      'agent',
      undefined,
      undefined,
    ])
  })
})

describe('Queued from the command', () => {
  test('task add --after queues it; task queue changes or clears it; what is not there, or a circle, is refused', async () => {
    const dir = tmp('src-repo')
    run(REPO, dir)
    const p = await src.places.add(dir, 'queue')
    const place = placeId.space(p.name)
    const idOf = (out: string) => out.match(/([A-Z]+-\d+)/)![1]
    const first = idOf((await src.cli(['task', 'add', 'First', '--desc', 'x'], { chat: place })).out)
    const add = await src.cli(['task', 'add', 'Then', '--desc', 'y', '--after', first], { chat: place })
    expect(add.out).toContain(`queued after ${first}`)
    expect(add.out).toContain('It has no agent, worktree or herdr space while it waits')
    const then = idOf(add.out)
    expect(src.engine.task(then)!.after).toEqual([first])
    expect(src.engine.task(then)!.worktree).toBeUndefined()
    // nothing of it to park: it holds none; a task's agent never parks
    expect((await src.cli(['task', 'park'], { chat: place })).out).toContain('nothing to park')
    expect((await src.cli(['task', 'park', '--yes'], { chat: place })).out).toContain('Parked 0.')
    expect((await src.cli(['task', 'park'], { chat: `${first}/Agent` })).out).toContain("A task's agent doesn't park tasks")
    expect((await src.cli(['task', 'add', 'Bad', '--desc', 'y', '--after', 'NOPE-1'], { chat: place })).out).toContain('No task NOPE-1')
    expect((await src.cli(['task', 'add', 'Bad', '--desc', 'y', '--after'], { chat: place })).out).toContain('--after needs the tasks')
    expect((await src.cli(['task', 'add', 'Bad', '--desc', 'y', '--after', 'vm-x:ELA-1'], { chat: place })).out).toContain('no machine called vm-x')
    const loop = await src.cli(['task', 'queue', first, '--after', then], { chat: place })
    expect(loop.code).toBe(1)
    expect(loop.out).toContain(`circle: ${first} → ${then} → ${first}`)
    expect((await src.cli(['task', 'queue', then], { chat: place })).code).toBe(1)
    expect((await src.cli(['task', 'queue', then, '--after', 'none'], { chat: place })).out).toContain('waits for nothing more')
    expect(src.engine.task(then)!.after).toBeUndefined()
    expect((await src.cli(['help'], {})).out).toContain('shepherdr task queue <id> --after')
    // another machine's task, as that machine last showed it: refused while it can't be reached
    const links = (src.peers as unknown as { links: Map<string, unknown> }).links
    const theirs = { id: 'ELA-3', name: 'Their API', status: 'work', place: 'p:vm-x:api', age: '1m', state: 'Working', on: 'Claude Code', created: '' }
    // a whole link: the machine poller reads the one it finds every 5 s, and one missing saved/health threw inside it
    // (a TypeError bun then hung on whichever test was running: run 42087512769, attempt 4)
    links.set('vm-x', {
      rec: { machine: 'vm-x', url: 'http://127.0.0.1:9', lastSeen: 0 },
      saved: { id: 'vm-x', label: 'vm-x', target: 'vm-x', session: 's', enabled: true },
      snap: { places: [], tasks: [theirs] },
      chats: new Map(),
      watching: { chats: [], term: null },
      waiting: [],
      reachable: false,
      state: 'Ready',
      lacks: [],
      connecting: false,
      health: new WorkerHealth(),
    })
    expect((await src.cli(['task', 'add', 'Use it', '--desc', 'y', '--after', 'vm-x:ELA-3'], { chat: place })).out).toContain("can't reach vm-x")
    // from here the link answers as reachable whatever the poller says: its URL answers nothing, so one poll in five
    // seconds marks it away again, and one that landed between this line and a slow add (git, under load) made the add
    // say "can't reach". The test takes the link away at its end.
    Object.defineProperty(links.get('vm-x') as object, 'reachable', { get: () => true, set: () => {} })
    expect((await src.cli(['task', 'add', 'Use it', '--desc', 'y', '--after', 'vm-x:ELA-9'], { chat: place })).out).toContain('vm-x has no task ELA-9')
    const used = await src.cli(['task', 'add', 'Use it', '--desc', 'y', '--after', 'Vm-X:ela-3'], { chat: place })
    expect(used.out).toContain('queued after vm-x:ELA-3')
    const use = src.engine.task(idOf(used.out))!
    theirs.status = 'done'
    src.engine.recheck()
    expect(use.after).toBeUndefined()
    links.delete('vm-x')
    // herdr isn't here: its agents can't start. Let that settle before the tests after this one
    const ts = [first, then, use.id].map((id) => src.engine.task(id)!)
    await settle(() => ts.every((t) => t.trouble), 'their agents to fail to start')
    // its go (the task it waited for is done) either goes to an agent that never starts or waits for room: either way it
    // can be sent later, into whatever test runs then (run 42096468692, shard 3, typed in as a CLI command's answer).
    // Waited for, then stopped at the source: nothing sends it once the task holds no go and no place in the queue.
    await until(() => src.agents.outbox.some((o) => o.text.includes('vm-x:ELA-3 is done')) || !!use.held, 8000, `${use.id}'s go`)
    // and so that nothing of theirs keeps a go to send later: resumeQueue() would type it into whatever runs then
    for (const t of ts) {
      t.going = undefined
      t.held = undefined
    }
    src.agents.outbox = src.agents.outbox.filter((o) => !o.text.includes('vm-x:ELA-3 is done') && !ts.some((t) => o.key === `${t.id}/Agent`))
  })
})

describe("a task's CLI, model and effort", () => {
  test('task add takes --agent, --model and --effort for one task; what makes no sense is refused', async () => {
    const dir = tmp('src-repo')
    run(REPO, dir)
    const p = await src.places.add(dir, 'harness-source')
    const place = placeId.space(p.name)
    const before = tasksIn(place)
    for (const [args, says] of <[string[], string][]>[
      [['--agent', 'nope'], 'No CLI called nope'],
      [['--effort', 'extreme'], '--effort takes default, low, medium, high, xhigh, max on Claude Code'],
      [['--effort', 'ultra', '--model', 'sonnet'], '--effort takes default, low, medium, high, xhigh, max on Sonnet 5.5'],
      [['--model', 'opus 9'], '--model opus 9: Claude Code has no such model. It takes claude-fable-5-1, claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, or default'],
      [['--model', 'opus;rm'], 'Write a model id'],
      [['--prio', 'high'], 'Task add takes no --prio'],
      [['--pr', '42'], 'has no GitHub remote'],
      [['--effort'], '--effort needs a value'],
      [['--agent', 'gemini', '--model', 'x'], 'does not support Shepherdr chat'],
    ]) {
      const r = await src.cli(['task', 'add', 'Odd', '--desc', 'x', ...args], { chat: place })
      expect(r.code).toBe(1)
      expect(r.out).toContain(says)
    }
    expect(tasksIn(place)).toBe(before)
    const r = await src.cli(['task', 'add', 'On Codex', '--desc', 'x', '--agent', 'codex', '--model', 'GPT-6-Sol', '--effort', 'Ultra'], { chat: place })
    expect(r.out).toContain('Its agent (Codex, gpt-6-sol, ultra effort) starts on the brief now')
    const t = src.engine.task(r.out.match(/([A-Z]+-\d+)/)![1])!
    expect(t.agent).toEqual({ kind: 'codex', model: 'gpt-6-sol', effort: 'ultra' })
    // default: the CLI's own, whatever Settings say
    src.settings.set('task.model', 'opus')
    const d = await src.cli(['task', 'add', 'Plain', '--desc', 'x', '--model', 'default'], { chat: place })
    expect(src.engine.task(d.out.match(/([A-Z]+-\d+)/)![1])!.agent).toEqual({ kind: 'claude', model: '', effort: undefined })
    src.settings.set('task.model', null)
    await settle(() => !!t.trouble, `${t.id}'s agent to fail to start`)
  })
  test("its brief's Reviewer line names the reviewer: Settings', or task add's --reviewer flags for one task", async () => {
    const dir = tmp('src-repo')
    run(REPO, dir)
    const place = placeId.space((await src.places.add(dir, 'reviewer-source')).name)
    for (const [args, says] of <[string[], string][]>[
      [['--reviewer', 'gemini'], '--reviewer gemini: Pick one of: Codex · Claude Code · pi · OpenCode · Antigravity.'],
      [['--reviewer-effort', 'extreme'], '--reviewer-effort takes default, low, medium, high, xhigh, max, ultra on Codex'],
      [['--reviewer-model', 'opus'], 'Codex has no such model'],
    ]) {
      const r = await src.cli(['task', 'add', 'Odd', '--desc', 'x', ...args], { chat: place })
      expect(r.code).toBe(1)
      expect(r.out).toContain(says)
    }
    const id = (out: string) => out.match(/([A-Z]+-\d+)/)![1]
    const plain = src.engine.task(id((await src.cli(['task', 'add', 'Plain review', '--desc', 'x'], { chat: place })).out))!
    expect(plain.reviewer).toEqual({ kind: 'codex', model: undefined, effort: undefined })
    expect(plain.desc).toContain(`${reviewerLineFor(CODEX_WORDS, plain.id)}\n`)
    src.settings.set('reviewer.model', 'gpt-6-sol')
    const own = src.engine.task(id((await src.cli(['task', 'add', 'Claude review', '--desc', 'x', '--reviewer', 'claude', '--reviewer-effort', 'High'], { chat: place })).out))!
    // another CLI drops Settings' model, which names one of Codex's
    expect(own.reviewer).toEqual({ kind: 'claude', model: undefined, effort: 'high' })
    expect(own.desc).toContain(reviewerLineFor('a headless Claude Code or a Claude Code subagent (its default model, high effort).', own.id, '', '(set by coordinator for this task)'))
    const codex = src.engine.task(id((await src.cli(['task', 'add', 'Codex review', '--desc', 'x', '--reviewer-effort', 'low'], { chat: place })).out))!
    expect(codex.desc).toContain(reviewerLineFor('a headless Codex or a Codex subagent (model gpt-6-sol, low effort).', codex.id, '', '(set by coordinator for this task)'))
    src.settings.set('reviewer.model', null)
  })
  test('task add --set changes a line of its Settings block for that task alone, marked as set by its coordinator', async () => {
    const dir = tmp('src-repo')
    run(REPO, dir)
    const place = placeId.space((await src.places.add(dir, 'set-source')).name)
    const bad = await src.cli(['task', 'add', 'Odd', '--desc', 'x', '--set', 'merge=whenever'], { chat: place })
    expect(bad.code).toBe(1)
    expect(bad.out).toContain('--set merge: Pick one of')
    const id = (out: string) => out.match(/([A-Z]+-\d+)/)![1]
    const t = src.engine.task(
      id((await src.cli(['task', 'add', 'One round', '--desc', 'x', '--set', 'review.rounds=1', '--set', 'merge=after GitHub checks', '--set', 'reviewer=claude'], { chat: place })).out),
    )!
    // shepherdr merge waits for GitHub's checks, as the brief says, whatever Settings say later
    expect(t.waitChecks).toBe(true)
    expect(t.reviewer?.kind).toBe('claude')
    expect(t.desc).toContain('- Review rounds: 1. One round, no review again. (set by coordinator for this task)')
    expect(t.desc).toContain("- Merge: after GitHub checks. Merge it yourself once it works and all of GitHub's checks pass (shepherdr checks " + t.id)
    expect(t.desc).toContain(reviewerLineFor('a headless Claude Code or a Claude Code subagent (its default model and effort).', t.id, '', '(set by coordinator for this task)'))
    // the rest stays Settings', unmarked
    expect(t.desc).toContain('- Must fix: major. Findings are tagged critical/major/minor/trivial; fix critical and major.\n')
  })
  test('shepherdr models lists what each CLI and model take', async () => {
    const out = (await src.cli(['models'], {})).out
    expect(out).toContain('Claude Code (--agent claude), effort levels low, medium, high, xhigh, max:\n  claude-fable-5-1')
    expect(out).toContain('claude-haiku-5-5             Haiku 5.5: low, medium, high, xhigh, max')
    expect(out).toContain('gpt-6-luna                   GPT-6-Luna: low, medium, high, xhigh, max\n')
    expect(out).toContain('pi (--agent pi), effort levels off, minimal, low, medium, high, xhigh, max:\n  any model id it knows')
    // OpenCode is listed by default, and asked for its own models (none until it is asked)
    expect(out).toContain('OpenCode (--agent opencode)')
    expect((await src.cli(['models', 'gemini'], {})).out).toContain('Shepherdr passes it no model or effort')
  })
  test('shepherdr show prints the settings and the lines every brief ends with', async () => {
    const out = (await src.cli(['show'], {})).out
    expect(out).toContain('brief.review               on')
    expect(out).toContain('review.mustFix             major')
    expect(out).toContain('review.rounds              3 rounds')
    expect(out).not.toContain('brief.plan')
    expect(out).toContain('reviewer.agent             Codex')
    expect(out).toContain('reviewer.model             default')
    expect(out).toContain('reviewer.effort            default')
    // the backup reviewer is off until the human sets one, and its own three keys say so
    expect(out).toContain('reviewer.fallback          off')
    expect(out).toContain('reviewer.fallbackModel     default')
    expect(out).toContain('reviewer.fallbackEffort    default')
    // each backup has its own pair, on its own line with its level; the coordinators' says where it reads it while default
    expect(out).toMatch(/^backup\.model\s+default\s+\(default\)$/m)
    expect(out).toMatch(/^backup\.effort\s+default\s+\(default\)$/m)
    expect(out).toMatch(/^coordinator\.fallback\s+off\s+\(default\)$/m)
    expect(out).toMatch(/^coordinator\.fallbackModel\s+default\s+\(default\)$/m)
    expect(out).toMatch(/^coordinator\.fallbackEffort\s+default\s+\(default\)$/m)
    expect(out).toContain(reviewerLineFor(CODEX_WORDS, '<id>'))
    expect(out).not.toContain('cannot run at all')
    expect(out).toContain('What agents are told (')
    expect(out).toContain('How Shepherdr runs:')
    expect(out).toContain('--set review.rounds=1')
    // a coordinator hears how to set the backup reviewer for one task too
    expect(out).toContain('reviewer.fallback, reviewer.fallbackModel, reviewer.fallbackEffort')
    expect(out).toContain('coordinator.agent          Claude Code')
    expect(out).toContain("Every new task's brief ends with:\nSettings:")
  })
  test("a coordinator first starts on Settings' CLI, model and effort for coordinators", async () => {
    // one that ran before keeps what it runs on until it is restarted (SHE-249): a new space's has never run
    const seen: { kind: string; model?: string; effort?: string }[] = []
    const ensure = src.agents.ensure
    src.agents.ensure = (async (spec: { kind: string; model?: string; effort?: string }) => (seen.push(spec), null)) as never
    try {
      const dir = tmp('src-repo')
      run(REPO, dir)
      const place = placeId.space((await src.places.add(dir, 'coord-settings')).name)
      expect(src.agents.record(place)).toBeUndefined()
      src.settings.set('coordinator.agent', 'Codex')
      src.settings.set('coordinator.effort', 'high')
      await (src as unknown as { coordinator(id: string): Promise<unknown> }).coordinator(place)
      expect(seen.at(-1)).toMatchObject({ kind: 'codex', model: '', effort: 'high' })
    } finally {
      src.agents.ensure = ensure
      src.settings.set('coordinator.agent', null)
      src.settings.set('coordinator.effort', null)
    }
  })
  test('each CLI is started with its own flags for model and effort', () => {
    const rec = (kind: string, model?: string, effort?: string, key = 'k') => ({ key, name: 'n', kind, cwd: '/', workspace: 'w', logs: [], started: 0, model, effort, access: 'full' as const })
    // Claude Code also gets its own hooks' settings file (readers/hooks.ts)
    const hooks = ['--settings', join(process.env.SHEPHERDR_HOME!, 'hooks', 'n.settings.json')]
    expect(src.agents.args(rec('claude', 'claude-opus-5-5', 'xhigh'), false)).toEqual([...hooks, '--model', 'claude-opus-5-5', '--effort', 'xhigh'])
    // picked in its chat's menu by name
    expect(src.agents.args(rec('claude', 'Sonnet 5.5', 'lowest'), false)).toEqual([...hooks, '--model', 'claude-sonnet-5-5', '--effort', 'low'])
    expect(src.agents.args(rec('claude', 'default', 'default'), false)).toEqual(hooks)
    // a level its model lacks goes in as the nearest it has
    expect(src.agents.args(rec('claude', 'Haiku 5.5', 'ultra'), false)).toEqual([...hooks, '--model', 'claude-haiku-5-5', '--effort', 'max'])
    expect(src.agents.args(rec('codex', 'gpt-6-luna', 'ultra'), false).slice(2)).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="max"'])
    for (const key of ['space-key', 'SHE-9/Agent', 'SHE-9/Reviewer']) {
      for (const resume of [false, true]) {
        const args = src.agents.args({ ...rec('codex', '', ''), key, env: { SHEPHERDR_CHAT: 'ST-1/Reviewer', SHEPHERDR_URL: 'http://127.0.0.1:7787' } }, resume)
        const policy = args.find((a) => a.startsWith('shell_environment_policy.set='))!
        expect(policy).toContain(`"SHEPHERDR_CHAT"="${key}"`)
        expect(policy).toContain('"SHEPHERDR_COMMAND"=')
        expect(policy).toContain('"PATH"=')
      }
    }
    expect(src.agents.args(rec('pi', 'openai/gpt-5.5', 'lowest'), false)).toEqual(['--model', 'openai/gpt-5.5', '--thinking', 'minimal'])
    // pi pre-trusts a worktree Shepherdr made with its own one-shot flag, task agent and reviewer alike; a coordinator
    // on a space the human picked keeps pi's own trust prompt (no flag). Nothing is written to pi's own settings.
    expect(src.agents.args(rec('pi', 'openai/gpt-5.5', 'lowest', 'SHE-9/Agent'), false)).toEqual(['--approve', '--model', 'openai/gpt-5.5', '--thinking', 'minimal'])
    expect(src.agents.args(rec('pi', '', '', 'SHE-9/Reviewer'), false)).toContain('--approve')
    expect(src.agents.args({ ...rec('pi', '', '', 'SHE-9/Agent'), sessionId: 'sid' }, false)).toEqual(['--approve', '--session-id', 'sid'])
    for (const key of ['p:desktop-shepherdr:shepherdr', 'k']) expect(src.agents.args(rec('pi', '', '', key), false)).not.toContain('--approve')
    expect(src.agents.args(rec('gemini', 'x', 'high'), false)).toEqual([])
  })

  test('claude, codex and pi carry the task temp folder: codex writes it into its shell environment policy', () => {
    const one = taskTmpDir('CLI-1')
    for (const key of ['CLI-1/Agent', 'CLI-1/Reviewer']) {
      const env = agentEnv(key, APP_ROOT)
      expect(env.SHEPHERDR_TMP).toBe(one)
      expect(env.TMPDIR).toBe(one)
    }
    // Claude Code and pi inherit the pane's environment, so both variables reach their Bash and terminal tools
    // unchanged. Codex builds its tools' environment from a policy of its own: check the two are written into it.
    const rec = { key: 'CLI-1/Agent', name: 'n', kind: 'codex', cwd: '/', workspace: 'w', logs: [], started: 0, env: agentEnv('CLI-1/Agent', APP_ROOT), access: 'full' as const }
    const policy = src.agents.args(rec as never, false).find((a) => a.startsWith('shell_environment_policy.set=')) ?? ''
    expect(policy).toContain(`"TMPDIR"="${one}"`)
    expect(policy).toContain(`"SHEPHERDR_TMP"="${one}"`)
  })
})

describe('Task IDs live only in repository space Settings', () => {
  test('edits apply to new tasks and survive a display rename; invalid scopes and collisions fail', async () => {
    const dir = tmp('id-settings')
    run('git init -q -b main', dir)
    const p = await src.places.add(dir, 'id-settings')
    const place = placeId.space(p.name)
    const set = (key: string, value: string, at = place) => src.act({ type: 'setting', place: at, key, value })
    expect(await set('taskIds.prefix', 'GAME')).toMatchObject({ ok: true })
    expect(await set('taskIds.next', '100')).toMatchObject({ ok: true })
    const t = src.engine.add({ project: p.name, title: 'Numbered', by: 'test', after: [], later: true })
    expect(t.id).toBe('GAME-100')
    src.places.rename(place, 'pretty-name')
    expect(src.places.space(place)?.key).toBe('GAME')
    expect(await set('taskIds.next', '100')).toMatchObject({ ok: false })
    expect(await set('taskIds.prefix', 'NEWKEY')).toMatchObject({ ok: true })
    expect(t.id).toBe('GAME-100')
    expect(src.engine.add({ project: 'pretty-name', title: 'Next', by: 'test', later: true }).id).toBe('NEWKEY-101')
    expect(await set('taskIds.prefix', 'invalid')).toMatchObject({ ok: false })
    for (const at of ['all', placeId.machine(), placeId.home(), 'p:other:some-space']) expect(await set('taskIds.next', '999', at)).toMatchObject({ ok: false })
    const snap = await src.snapshot()
    const pages = snap.settings.filter((s) => s.name === 'Task IDs')
    expect(pages.find((s) => s.level === place)?.rows[0].value).toBe('NEWKEY')
    expect(pages.every((s) => s.level?.startsWith('p:') && !s.level.endsWith(':~'))).toBe(true)
    const otherDir = tmp('id-other')
    run('git init -q -b main', otherDir)
    const other = await src.places.add(otherDir, 'id-other')
    expect(await set('taskIds.prefix', 'GAME', placeId.space(other.name))).toMatchObject({ ok: false })
  })
})

describe('review rounds from the command', () => {
  test("a task's own agent counts each round, and only its coordinator adds one", async () => {
    const { t, place } = await workedTask('review-rounds')
    const rounds = src.engine.roundsOf(t)
    // each round its agent starts is counted; a reviewer's chat and the terminal count nothing
    expect((await src.cli(['review', t.id], { chat: `${t.id}/Agent` })).out).toContain(`Round 1 of ${rounds} counted`)
    expect((await src.cli(['review', t.id], { chat: `${t.id}/Reviewer` })).code).toBe(1)
    expect((await src.cli(['review', t.id], {})).code).toBe(1)
    // never its own agent, and not before its rounds are used
    expect((await src.cli(['task', 'review-more', t.id], { chat: `${t.id}/Agent` })).out).toContain('never its own agent')
    expect((await src.cli(['task', 'review-more', t.id], { chat: place })).out).toContain(`has used 1 of ${rounds} review rounds`)
    // all of them used: its coordinator adds one, once, and task show records it
    for (let i = 1; i < rounds; i++) expect((await src.cli(['review', t.id], { chat: `${t.id}/Agent` })).code).toBe(0)
    expect((await src.cli(['review', t.id], { chat: `${t.id}/Agent` })).out).toContain('review rounds are used')
    const more = await src.cli(['task', 'review-more', t.id], { chat: place })
    expect(more.code).toBe(0)
    expect(more.out).toContain(`may now use ${rounds + 1} review rounds`)
    expect((await src.cli(['task', 'show', t.id], {})).out).toContain(`Review rounds: ${rounds} of ${rounds + 1} used, one added by its coordinator`)
    expect((await src.cli(['task', 'review-more', t.id], { chat: place })).out).toContain('already added its one more review round')
  })

  test('review --done records the commit it reviewed, and task show names it', async () => {
    const { t } = await workedTask('review-record')
    if (!t.worktree) throw new Error(`${t.id} got no worktree`)
    const head = run('git rev-parse HEAD', t.worktree).trim()
    expect((await src.cli(['review', t.id], { chat: `${t.id}/Agent` })).code).toBe(0)
    expect((await src.cli(['review', t.id, '--done'], { chat: `${t.id}/Agent` })).out).toContain('the round is recorded')
    expect(t.reviewed).toMatchObject([{ round: 1, commit: head }])
    expect((await src.cli(['task', 'show', t.id], {})).out).toContain(`Reviewed: round 1 on ${head.slice(0, 7)}`)
    // a lease Shepherdr dropped (a restart, its 45 minutes) loses no round: --done still records the commit it reviewed
    expect((await src.cli(['review', t.id], { chat: `${t.id}/Agent` })).code).toBe(0)
    src.engine.release(Date.now() + 60 * 60_000)
    const late = await src.cli(['review', t.id, '--done'], { chat: `${t.id}/Agent` })
    expect(late.out).toContain(`nothing was leased to release; the round is recorded on ${head.slice(0, 7)}`)
    expect(t.reviewed).toMatchObject([
      { round: 1, commit: head },
      { round: 2, commit: head },
    ])
    expect((await src.cli(['review', t.id, '--done'], { chat: `${t.id}/Agent` })).out).toContain('nothing to release')
  })
})

describe('pinned models, from the screen', () => {
  test('a pin is kept for this machine, and an id no CLI lists is refused', async () => {
    setPicks(NO_PICKS)
    try {
      expect(await src.act({ type: 'model-pin', chat: 'p:x:~', kind: 'claude', model: 'claude-haiku-5-5', on: true })).toEqual({ ok: true, pinned: ['claude-haiku-5-5'], recent: [] })
      // the state asked for, twice: a tap replayed cannot undo itself
      expect(await src.act({ type: 'model-pin', chat: 'p:x:~', kind: 'claude', model: 'claude-haiku-5-5', on: true })).toEqual({ ok: true, pinned: ['claude-haiku-5-5'], recent: [] })
      // never a model invented: only what the CLI itself reported
      expect(await src.act({ type: 'model-pin', chat: 'p:x:~', kind: 'claude', model: 'claude-nope-9-9', on: true })).toMatchObject({ ok: false, error: expect.stringContaining('has no model') })
      expect(await src.act({ type: 'model-pin', chat: 'p:x:~', kind: 'nope', model: 'x', on: true })).toMatchObject({ ok: false, error: expect.stringContaining('No CLI called') })
      // and unpinning says so
      expect(await src.act({ type: 'model-pin', chat: 'p:x:~', kind: 'claude', model: 'claude-haiku-5-5', on: false })).toEqual({ ok: true, pinned: [], recent: [] })
    } finally {
      setPicks(NO_PICKS)
    }
  })
})

describe('--json on the list and show commands', () => {
  /** the answer is parseable JSON, not prose with a 0 exit the way it was before these verbs took --json */
  const json = async (args: string[]): Promise<unknown> => {
    const r = await src.cli([...args, '--json'], {})
    expect(r.code).toBe(0)
    return JSON.parse(r.out)
  }

  test('space list --json returns the rows with their id, name, key and folder', async () => {
    const dir = tmp('src-repo')
    run(REPO, dir)
    const p = await src.places.add(dir, 'jsonprobe')
    const rows = (await json(['space', 'list'])) as { id: string; name: string; key?: string; folder: string; home?: boolean }[]
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.find((r) => r.id === placeId.home())).toMatchObject({ name: 'home', home: true })
    const repo = rows.find((r) => r.id === placeId.space(p.name))
    expect(repo).toMatchObject({ name: 'jsonprobe', key: p.key, home: false })
    expect(repo?.folder).toContain(dir)
  })

  test('automation list --json returns the automation records', async () => {
    const a = src.automations.add({ place: placeId.home(), name: 'JsonProbe', trigger: { time: 'FREQ=DAILY' }, task: { title: 'Probe task' } })
    const rows = (await json(['automation', 'list'])) as { id: string; name: string }[]
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: a.id, name: 'JsonProbe' })]))
  })

  test('artifact list --json returns the artifact records', async () => {
    const a = src.artifacts.create({ title: 'JsonProbe board', place: placeId.home(), by: 'test', html: '<html></html>' })
    const rows = (await json(['artifact', 'list'])) as { id: string; title: string }[]
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: a.id, title: 'JsonProbe board' })]))
  })

  test('profile list --json returns the saved profiles', async () => {
    const saved = src.profiles.save('JsonProbe', { limits: false, force: false })
    expect(saved.ok).toBe(true)
    const v = (await json(['profile', 'list'])) as { profiles: { name: string }[]; active: string }
    expect(Array.isArray(v.profiles)).toBe(true)
    expect(v.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'JsonProbe' })]))
    expect(typeof v.active).toBe('string')
  })

  test('models --json returns each CLI with its model ids', async () => {
    const rows = (await json(['models'])) as { agent: string; models: { id: string }[] }[]
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.map((r) => r.agent)).toContain('claude')
    const claude = rows.find((r) => r.agent === 'claude')
    expect(claude?.models[0]?.id).toBe('claude-fable-5-1')
  })

  test('status --json returns the overview as records', async () => {
    const s = (await json(['status'])) as { machine: string; spaces: number; openTasks: number; herdr: boolean; kept: string[] }
    expect(typeof s.machine).toBe('string')
    expect(typeof s.spaces).toBe('number')
    expect(typeof s.openTasks).toBe('number')
    expect(typeof s.herdr).toBe('boolean')
    expect(Array.isArray(s.kept)).toBe(true)
  })

  test('doctor --json is refused instead of answering prose', async () => {
    const r = await src.cli(['doctor', '--json'], {})
    expect(r.code).toBe(1)
    expect(r.out).toContain('takes no --json')
  })

  test('doctor prints the performance block from the samples the server kept', async () => {
    const before = src.health.samples
    const now = Date.now()
    try {
      src.health.samples = [
        { at: now - 120_000, load: 4, memUsed: 8 * 2 ** 30, rss: 200 * 2 ** 20, lag: 10, stalls: 0, working: 1 },
        { at: now - 60_000, load: 6, memUsed: 9 * 2 ** 30, rss: 320 * 2 ** 20, lag: 1500, stalls: 2, working: 4, pass: { label: 'snapshot', ms: 800 } },
      ]
      const r = await src.cli(['doctor'], {})
      expect(r.code).toBe(0)
      expect(r.out).toContain('Performance:')
      expect(r.out).toContain('worst by day today 1.5 s')
      expect(r.out).toContain('stalls in the last day: 2')
      expect(r.out).toContain('now 320 MB')
      expect(r.out).toContain('snapshot 800 ms')
    } finally {
      src.health.samples = before
    }
  })

  test('a health tick keeps what the stall watch saw and how many agents work', () => {
    const before = src.health.samples
    const last = src.health.last
    const drain = src.stall.drainPerf
    try {
      src.health.samples = []
      src.health.last = undefined
      src.stall.drainPerf = () => ({ lag: 321, stalls: 1, pass: { label: 'snapshot', ms: 400 } })
      src.healthTick(Date.now())
      const kept = src.health.samples.at(-1)
      expect(kept).toMatchObject({ lag: 321, stalls: 1, pass: { label: 'snapshot', ms: 400 } })
      expect(kept?.working).toBe(Object.values(src.agents.records).filter((r) => src.agents.status(r.key) === 'working').length)
    } finally {
      src.health.samples = before
      src.health.last = last
      src.stall.drainPerf = drain
    }
  })

  test('--json is only accepted on automation list, not the verbs that still answer prose', async () => {
    const dir = tmp('src-repo')
    run(REPO, dir)
    const p = await src.places.add(dir, 'nojson')
    const r = await src.cli(['automation', 'add', 'NoJson', '--task', 'Probe task', '--when', 'FREQ=DAILY', '--space', p.name, '--json'], {})
    expect(r.code).toBe(1)
    expect(r.out).toContain('takes no --json')
  })

  test('help documents --json exactly on the verbs that take it', () => {
    const lines = HELP.split('\n').filter((l) => l.includes('--json'))
    expect(lines.length).toBe(8)
    for (const verb of ['task list', 'task show', 'space list', 'automation list', 'artifact list', 'profile list', 'models', 'status'])
      expect(lines.some((l) => l.includes(`shepherdr ${verb}`))).toBe(true)
    expect(lines.some((l) => l.includes('doctor'))).toBe(false)
  })

  test('help documents models --check', () => {
    expect(HELP).toContain('shepherdr models [CLI] [--json] [--check]')
    expect(HELP).toContain('--check on its own warns where the hand-kept fallback table drifts')
  })

  test('models --check warns on a stale fallback id and is never a failure', async () => {
    const { TABLE } = await import('../server/live/models.ts')
    const { writeJson, home } = await import('../server/store.ts')
    const stale = TABLE.claude.models[0].id
    writeJson('cli-models.json', { claude: { models: TABLE.claude.models.slice(1), efforts: ['medium'] } }, home())
    const r = await src.cli(['models', '--check'], {})
    expect(r.code).toBe(0)
    expect(r.out).toContain(stale)
    expect(r.out).toContain('warning')
  })

  test('models --check says nothing was compared when no CLI has a stored read', async () => {
    const { rmSync } = await import('node:fs')
    const { home } = await import('../server/store.ts')
    rmSync(join(home(), 'cli-models.json'), { force: true })
    const r = await src.cli(['models', '--check'], {})
    expect(r.code).toBe(0)
    expect(r.out).toContain('nothing was compared')
  })
})

describe('pausing a space from the command', () => {
  test('space pause/resume are the setting action at that space, held tasks keep the existing wording, and status says paused', async () => {
    const dir = tmp('src-pause')
    run(REPO, dir)
    const p = await src.places.add(dir, 'pause-space')
    const place = placeId.space(p.name)
    const engine = src.engine as unknown as { machine?: () => { herdr: boolean } }
    const was = engine.machine
    engine.machine = () => ({ herdr: true })
    try {
      expect((await src.cli(['space', 'pause', p.name], {})).out).toContain('is paused: its new tasks wait, held; tasks already running keep going')
      expect(src.settings.get('space.maxTasks', p.name)).toBe('0')
      // the same write a browser switch makes, at this space's level
      expect(await src.act({ type: 'setting', key: 'space.maxTasks', value: '0', place })).toEqual({ ok: true })
      const held = (await src.cli(['task', 'add', 'Held', '--desc', 'x'], { chat: place })).out
      expect(held).toContain('held: pause-space is set to 0 tasks')
      const found = held.match(/([A-Z]+-\d+)/)
      if (!found) throw new Error('no task id in the add reply')
      const id = found[1]
      const task = () => {
        const t = src.engine.task(id)
        if (!t) throw new Error(`no task ${id}`)
        return t
      }
      expect(task().held?.why).toBe('spaceZero')
      // both forms of status name it
      expect((await src.cli(['status'], {})).out).toContain(`paused: ${p.name}`)
      const json = JSON.parse((await src.cli(['status', '--json'], {})).out)
      expect(json.paused).toContain(p.name)
      // resume unsets the space's own value, and the task is no longer held for the space
      expect((await src.cli(['space', 'resume', p.name], {})).out).toContain('is not paused: its held tasks start by themselves again')
      expect(src.settings.get('space.maxTasks', p.name)).toBe('off')
      expect(JSON.parse((await src.cli(['status', '--json'], {})).out).paused).not.toContain(p.name)
      expect(src.engine.room(task()).why).not.toBe('spaceZero')
      // no extra refusals beyond the setting action: an unknown name is refused, --space works as well
      expect((await src.cli(['space', 'pause', 'no-such-space'], {})).code).toBe(1)
      expect((await src.cli(['space', 'pause', '--space', p.name], {})).out).toContain('is paused')
      expect(src.settings.get('space.maxTasks', p.name)).toBe('0')
      expect(HELP).toContain('shepherdr space pause <name>')
      expect(HELP).toContain('shepherdr space resume <name>')
    } finally {
      engine.machine = was
      src.settings.set('space.maxTasks', null, { space: p.name })
    }
  })
})

describe('the extracted CLI verbs (SHE-160)', () => {
  // The verb switch and its helpers moved from source.ts to cli-commands.ts. These pin the exact words of one verb
  // from each moved family, so a byte or a line lost in the move fails here just as it would in the old file.
  test('profile verbs answer with the same usage, character for character', async () => {
    const usage =
      'shepherdr profile list | save <name> [--limits] [--force] | show <name> | preview <name> | apply <name> [--apply-waiting] | undo [--apply-waiting] | rename <name> <new-name> | delete <name> | schedule <name> "<rule>" [--waiting] | schedules | schedule-on|schedule-off <name> [<n>] | unschedule <name> [<n>]\n'
    expect(await src.cli(['profile', 'nope'], {})).toEqual({ code: 1, out: usage })
    expect(await src.cli(['profile', 'show'], {})).toEqual({ code: 1, out: usage })
  })

  test('task verbs answer with the same words for a title and a task that is not there', async () => {
    expect(await src.cli(['task', 'add'], {})).toEqual({ code: 1, out: 'shepherdr task add "<title>" --desc "<the whole brief>"\n' })
    expect(await src.cli(['task', 'show', 'NOPE-1'], {})).toEqual({ code: 1, out: 'No task NOPE-1\n' })
  })

  test('secret verbs answer with the same words for a missing name', async () => {
    expect(await src.cli(['secret', 'rm'], {})).toEqual({ code: 1, out: 'shepherdr secret rm NAME [--machine | --space NAME]\n' })
    expect(await src.cli(['secret', 'set', 'bad-name'], {})).toEqual({ code: 1, out: 'shepherdr secret set NAME [--machine | --space NAME] < file (the value on stdin; none: Everywhere)\n' })
  })
})
