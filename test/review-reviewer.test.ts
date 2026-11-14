// `shepherdr review <id>` decides the reviewer of each round: the round is counted and its reviewer chosen by the caps from
// the task's reviewer chain (its own, then its backups in turn), leased until `shepherdr review <id> --done`, and a round
// that finds every reviewer full or out waits up to 90 s (a parameter here), then is counted and named once one frees.
// The lease ends with the round's `--done`, the task's report, stop or end, or an agent's turn that ended long ago.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('review-reviewer')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { REVIEW_DEADLINE, REVIEW_TIMEOUT } = await import('../server/live/engine/engine.ts')
const { settingsBlock } = await import('../server/live/prompts.ts')
const { ASK, CODEX_WORDS, reviewerLineFor } = await import('./reviewer-line.ts')

const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'
const PI = 'pi (default)'
const CODEX = 'Codex (default)'

let src: InstanceType<typeof LiveSource>
let sent: { key: string; text: string }[] = []
let space: { name: string; place: string }
let n = 0

beforeEach(async () => {
  // a fresh source per test, on a home of its own: the tasks of the tests before are not read (a restart test keeps its own)
  sent = []
  if (src) src.stop()
  process.env.SHEPHERDR_HOME = tmp(`review-reviewer-${++n}`)
  src = new LiveSource()
  src.engine.installed = () => true
  src.settings.set('machine.startEvery', '0', 'machine')
  src.settings.set('models.maxAtOnce', null, 'machine')
  // a command's own wait is long enough for the test's steps (a command takes time to get to the engine); the waits that
  // are timed set their own
  src.engine.reviewDeadline = 1500
  src.engine.reviewPoll = 10
  src.agents.send = (async (key: string, text: string) => {
    sent.push({ key, text })
    return { waiting: false, item: {} }
  }) as never
  const dir = tmp('review-repo')
  execSync(REPO, { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, `review-${n}`)
  space = { name: p.name, place: placeId.space(p.name) }
})
afterAll(() => src?.stop())

/** a task of this space, with its agent on claude and a brief that names its reviewers as its Settings do */
function task(set?: Record<string, string>) {
  const id = `RV-${++n}`
  const now = Date.now()
  const t = { id, n, project: space.place, base: 'main', title: 'Reviewed change', desc: 'Add b.txt.', by: 'test', created: now, updated: now, told: 'work', agent: { kind: 'claude' }, ...(set ? { set } : {}) }
  src.engine.tasks.push(t as never)
  return src.engine.task(id)!
}

/** a headless run on a model key of this space holds a slot of the machine's cap (as an advisor's run does) */
const hold = (id: string, key: string) => src.engine.lease(id, 'advisor', key, space.name)
const reviewLeases = () => src.engine.runs().filter((r) => r.role === 'reviewer')
/** a command as the task's agent runs it, its answer as one line (the command line's trailing newline is not the answer) */
const said = async (args: string[], chat: string) => {
  const r = await src.cli(args, { chat })
  return { ...r, out: r.out.trim() }
}
const review = (t: { id: string }) => said(['review', t.id], `${t.id}/Agent`)
const toBe = (t: { id: string }) => `${t.id}/Agent`

describe('shepherdr review: the caps choose the reviewer of each round', () => {
  test('the primary has room: the round is counted, the primary named with the words to pass, and its reviewer leased', async () => {
    const t = task()
    const r = await review(t)
    expect(r.code).toBe(0)
    expect(r.out).toBe(`Round 1 of 3 counted for ${t.id}. Review with a headless Codex or a Codex subagent (its default model and effort) this round. Run \`shepherdr review ${t.id} --done\` when the round's review has finished.`)
    expect(t.reviews).toBe(1)
    // the lease counts toward the caps: the reviewer's run is on its model, of this space
    expect(reviewLeases()).toEqual([expect.objectContaining({ key: 'codex/unknown', space: space.name, id: `review:${t.id}` })])
  })

  test('the primary is at its limit: the first backup with room runs the round, and the answer says why', async () => {
    const t = task({ 'reviewer.fallback': 'pi' })
    expect(src.settings.set('models.maxAtOnce', 'codex=1', 'machine').ok).toBe(true)
    hold('advisor:busy', 'codex/gpt-5.5')
    const r = await review(t)
    expect(r.out).toBe(
      `Round 1 of 3 counted for ${t.id}. Review with a headless pi or a pi subagent (its default model and effort) this round (${CODEX} is at its limit, 1 of 1 at once). Run \`shepherdr review ${t.id} --done\` when the round's review has finished.`,
    )
    expect(t.reviews).toBe(1)
    expect(reviewLeases()).toEqual([expect.objectContaining({ key: 'pi/unknown' })])
  })

  test('the primary out: the backup runs the round, and the answer says the primary is out until when', async () => {
    const t = task({ 'reviewer.fallback': 'pi' })
    src.engine.outNow = (key) => (key.startsWith('codex/') ? { until: '17:00' } : undefined)
    const r = await review(t)
    expect(r.out).toContain(`(${CODEX} is out until 17:00). Run`)
    expect(t.reviews).toBe(1)
  })

  test('a primary out with no day given says only that it is out', async () => {
    const t = task({ 'reviewer.fallback': 'pi' })
    src.engine.outNow = (key) => (key.startsWith('codex/') ? {} : undefined)
    expect((await review(t)).out).toContain(`(${CODEX} is out). Run`)
  })

  test('every reviewer full or out: the command waits up to its deadline, then says to end the turn, and the round is not counted yet', async () => {
    src.engine.reviewDeadline = 60
    const t = task({ 'reviewer.fallback': 'pi' })
    expect(src.settings.set('models.maxAtOnce', 'codex=1, pi/unknown=1', 'machine').ok).toBe(true)
    hold('advisor:a', 'codex/gpt-5.5')
    hold('advisor:b', 'pi/unknown')
    const started = Date.now()
    const r = await review(t)
    expect(r.out).toBe(`Every reviewer ${t.id} may use is full or out: ${CODEX} (1 of 1 at once), ${PI} (1 of 1 at once). End your turn now; Shepherdr wakes you here when one is free, with the reviewer to use.`)
    // it waited for the slot (its deadline), and only then answered
    expect(Date.now() - started).toBeGreaterThanOrEqual(src.engine.reviewDeadline - 5)
    // nothing is counted or leased while every reviewer is full
    expect(t.reviews).toBeUndefined()
    expect(t.reviewWait).toBeDefined()
    expect(reviewLeases()).toEqual([])
  })

  test('the wait is over at once when a slot frees while it waits: the command counts the round itself', async () => {
    const t = task({ 'reviewer.fallback': 'pi' })
    expect(src.settings.set('models.maxAtOnce', 'codex=1, pi/unknown=1', 'machine').ok).toBe(true)
    hold('advisor:a', 'codex/gpt-5.5')
    hold('advisor:b', 'pi/unknown')
    const pending = review(t)
    await Bun.sleep(25)
    src.engine.unlease('advisor:b')
    const r = await pending
    expect(r.out).toBe(`Round 1 of 3 counted for ${t.id}. Review with a headless pi or a pi subagent (its default model and effort) this round (${CODEX} is at its limit, 1 of 1 at once). Run \`shepherdr review ${t.id} --done\` when the round's review has finished.`)
    expect(t.reviews).toBe(1)
    expect(t.reviewWait).toBeUndefined()
  })

  test('later, when a slot frees, the waiting agent is woken with the round and its reviewer: counted and leased then', async () => {
    src.engine.reviewDeadline = 60
    const t = task({ 'reviewer.fallback': 'pi' })
    expect(src.settings.set('models.maxAtOnce', 'codex=1, pi/unknown=1', 'machine').ok).toBe(true)
    hold('advisor:a', 'codex/gpt-5.5')
    hold('advisor:b', 'pi/unknown')
    await review(t)
    expect(sent).toEqual([])
    // still full: nothing wakes it
    src.engine.retryReviews()
    expect(sent).toEqual([])
    // the pi run ends: its slot is free, and the health look wakes the agent with the reviewer to use
    src.engine.unlease('advisor:b')
    src.engine.retryReviews()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ key: toBe(t) })
    expect(sent[0]!.text).toContain('A reviewer is free now. Round 1 of 3 counted for ' + t.id + '. Review with a headless pi or a pi subagent (its default model and effort) this round')
    expect(sent[0]!.text).toContain(`Run \`shepherdr review ${t.id} --done\``)
    expect(t.reviews).toBe(1)
    expect(t.reviewWait).toBeUndefined()
    expect(reviewLeases()).toEqual([expect.objectContaining({ key: 'pi/unknown' })])
    // a second look does not count it again
    src.engine.retryReviews()
    expect(sent).toHaveLength(1)
    expect(t.reviews).toBe(1)
  })

  test('the health look wakes a waiting round too (healthTick runs the same retry)', async () => {
    src.engine.reviewDeadline = 60
    const t = task({ 'reviewer.fallback': 'pi' })
    expect(src.settings.set('models.maxAtOnce', 'codex=1, pi/unknown=1', 'machine').ok).toBe(true)
    hold('advisor:a', 'codex/gpt-5.5')
    hold('advisor:b', 'pi/unknown')
    await review(t)
    src.engine.unlease('advisor:a')
    src.healthTick(Date.now())
    await Bun.sleep(5)
    expect(sent.map((s) => s.text).join('\n')).toContain(`Review with a headless Codex or a Codex subagent (its default model and effort) this round`)
    expect(t.reviews).toBe(1)
  })

  test('a round that is still being asked for is left to its command: the retry does not count it twice', async () => {
    const t = task({ 'reviewer.fallback': 'pi' })
    expect(src.settings.set('models.maxAtOnce', 'codex=1, pi/unknown=1', 'machine').ok).toBe(true)
    hold('advisor:a', 'codex/gpt-5.5')
    hold('advisor:b', 'pi/unknown')
    const pending = review(t)
    await Bun.sleep(15)
    src.engine.unlease('advisor:a')
    // the slot is free, and the retry runs while the command is still waiting: it is the command that counts it
    src.engine.retryReviews()
    expect(sent).toEqual([])
    const r = await pending
    expect(r.out).toContain('Round 1 of 3 counted')
    expect(t.reviews).toBe(1)
    expect(sent).toEqual([])
  })

  test('shepherdr review X --done releases the lease and counts no round; a second one says there is none', async () => {
    const t = task()
    await review(t)
    expect(t.reviews).toBe(1)
    const done = await said(['review', t.id, '--done'], toBe(t))
    expect(done.out).toBe(`Review of ${t.id} is done: its reviewer is free again.`)
    expect(reviewLeases()).toEqual([])
    expect(t.reviews).toBe(1)
    expect((await said(['review', t.id, '--done'], toBe(t))).out).toBe(`No review of ${t.id} is running: nothing to release.`)
    // the next round counts, and leases again
    expect((await review(t)).out).toContain('Round 2 of 3 counted')
    expect(reviewLeases()).toHaveLength(1)
  })

  test('a round that starts while the last one is not released replaces its lease: one reviewer at a time per task', async () => {
    const t = task()
    await review(t)
    await review(t)
    expect(t.reviews).toBe(2)
    expect(reviewLeases()).toHaveLength(1)
  })

  test('the task reports ready: its review ends and its reviewer is free', async () => {
    const t = task()
    await review(t)
    expect(reviewLeases()).toHaveLength(1)
    await src.engine.done(t.id, 'Added b.txt.', '')
    expect(reviewLeases()).toEqual([])
  })

  test('the task is stopped: its review ends, and a waiting round is not woken', async () => {
    const t = task({ 'reviewer.fallback': 'pi' })
    expect(src.settings.set('models.maxAtOnce', 'codex=1, pi/unknown=1', 'machine').ok).toBe(true)
    hold('advisor:a', 'codex/gpt-5.5')
    hold('advisor:b', 'pi/unknown')
    await review(t)
    expect(t.reviewWait).toBeDefined()
    await src.engine.stopTask(t.id)
    expect(t.reviewWait).toBeUndefined()
    src.engine.unlease('advisor:a')
    src.engine.retryReviews()
    expect(sent).toEqual([])
    expect(t.reviews).toBeUndefined()
  })

  test('a waiting round whose rounds are all used meanwhile is dropped, not counted, and a task that ended loses its wait at the next look', async () => {
    src.engine.reviewDeadline = 60
    const t = task({ 'reviewer.fallback': 'pi' })
    expect(src.settings.set('models.maxAtOnce', 'codex=1, pi/unknown=1', 'machine').ok).toBe(true)
    hold('advisor:a', 'codex/gpt-5.5')
    hold('advisor:b', 'pi/unknown')
    await review(t)
    expect(t.reviewWait).toBeDefined()
    // its rounds are used up by other means: nothing is counted for the wait
    t.reviews = 3
    src.engine.unlease('advisor:a')
    src.engine.retryReviews()
    expect(t.reviewWait).toBeUndefined()
    expect(sent).toEqual([])
    expect(t.reviews).toBe(3)
    // a task that waits and then ends (merged) loses its wait at the release look, as its review ends
    const u = task({ 'reviewer.fallback': 'pi' })
    hold('advisor:c', 'codex/gpt-5.5')
    hold('advisor:d', 'pi/unknown')
    await review(u)
    expect(u.reviewWait).toBeDefined()
    u.merged = true
    src.engine.release()
    expect(u.reviewWait).toBeUndefined()
    src.engine.unlease('advisor:c')
    src.engine.retryReviews()
    expect(sent).toEqual([])
  })

  test('the task ends (merged, or closed): its review ends at once', async () => {
    const t = task()
    await review(t)
    t.merged = true
    src.engine.release()
    expect(reviewLeases()).toEqual([])
  })

  test('a task that reported ready is never woken for a round it no longer runs', async () => {
    const t = task({ 'reviewer.fallback': 'pi' })
    expect(src.settings.set('models.maxAtOnce', 'codex=1, pi/unknown=1', 'machine').ok).toBe(true)
    hold('advisor:a', 'codex/gpt-5.5')
    hold('advisor:b', 'pi/unknown')
    await review(t)
    t.reported = true
    src.engine.unlease('advisor:a')
    src.engine.retryReviews()
    expect(sent).toEqual([])
    expect(t.reviewWait).toBeUndefined()
  })

  test('an agent whose turn ended without --done gives its reviewer up REVIEW_TIMEOUT after its turn ended, not before', async () => {
    const t = task()
    const before = Date.now()
    await review(t)
    // its turn is over: the time counts from the first look that sees it so (the round was counted before, so the look is
    // not the round's own timeout yet)
    src.agents.status = ((k: string) => (k === toBe(t) ? 'idle' : 'gone')) as never
    src.engine.release(before)
    src.engine.release(before + REVIEW_TIMEOUT - 1000)
    expect(reviewLeases()).toHaveLength(1)
    src.engine.release(before + REVIEW_TIMEOUT)
    expect(reviewLeases()).toEqual([])
  })

  test("an agent that works on keeps its reviewer until REVIEW_TIMEOUT from the round's count, then gives it up", async () => {
    const t = task()
    src.agents.status = ((k: string) => (k === toBe(t) ? 'working' : 'gone')) as never
    const before = Date.now()
    await review(t)
    const after = Date.now()
    src.engine.release(before + REVIEW_TIMEOUT - 1000)
    expect(reviewLeases()).toHaveLength(1)
    src.engine.release(after + REVIEW_TIMEOUT)
    expect(reviewLeases()).toEqual([])
  })

  test('a restart keeps no lease, but a round that waited is still counted and woken when a reviewer frees', async () => {
    src.engine.reviewDeadline = 60
    const t = task({ 'reviewer.fallback': 'pi' })
    expect(src.settings.set('models.maxAtOnce', 'codex=1, pi/unknown=1', 'machine').ok).toBe(true)
    hold('advisor:a', 'codex/gpt-5.5')
    hold('advisor:b', 'pi/unknown')
    await review(t)
    expect(t.reviewWait).toBeDefined()
    // a lease held before the restart is gone with it: its round is over
    src.stop()
    src = new LiveSource()
    src.engine.installed = () => true
    src.settings.set('machine.startEvery', '0', 'machine')
    src.agents.send = (async (key: string, text: string) => {
      sent.push({ key, text })
      return { waiting: false, item: {} }
    }) as never
    src.engine.reviewPoll = 10
    src.engine.reviewDeadline = 60
    const again = src.engine.task(t.id)!
    expect(again.reviewWait).toBeDefined()
    expect(reviewLeases()).toEqual([])
    // the runs that held the slots are gone with the restart as well: the reviewer is full again until they are back
    hold('advisor:a', 'codex/gpt-5.5')
    hold('advisor:b', 'pi/unknown')
    src.engine.retryReviews()
    expect(sent).toEqual([])
    src.engine.unlease('advisor:a')
    src.engine.retryReviews()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain(`Round 1 of 3 counted for ${t.id}`)
  })

  test('a lease counts toward the caps: a model another run needs is full while the reviewer holds it', async () => {
    const t = task()
    expect(src.settings.set('models.maxAtOnce', 'codex=1', 'machine').ok).toBe(true)
    await review(t)
    // the reviewer of this round is on Codex's model, so a Codex run of another task has to wait for it
    const c = src.engine.decide(space.name, src.engine.chainOptions([{ n: 0, h: { kind: 'codex' } }]))
    expect(c).toMatchObject({ wait: [{ why: 'full', name: 'codex' }] })
    await said(['review', t.id, '--done'], toBe(t))
    expect(src.engine.decide(space.name, src.engine.chainOptions([{ n: 0, h: { kind: 'codex' } }]))).toMatchObject({ harness: { n: 0 } })
  })

  test('a task with no rounds left is refused as before, and nothing is leased for it', async () => {
    const t = task()
    t.reviews = 3
    expect((await review(t)).code).toBe(1)
    expect(reviewLeases()).toEqual([])
  })

  test('only the task agent counts its rounds: a coordinator or another task is refused', async () => {
    const t = task()
    const r = await said(['review', t.id], space.place)
    expect(r.code).toBe(1)
    expect(r.out).toContain(`${t.id}'s own agent counts its review rounds`)
    expect(t.reviews).toBeUndefined()
  })
})

describe('the brief and the skill say how a round asks its reviewer', () => {
  test("the brief's Reviewer line asks shepherdr review <id> for each round, and --done after it", () => {
    const block = settingsBlock('RV-9', { ways: { review: true, mustFix: 'major', rounds: 3, merge: 'on its own', waitChecks: false }, reviewer: { kind: 'codex' }, fallback: [{ kind: 'pi' }] })
    expect(block).toContain(reviewerLineFor(CODEX_WORDS, 'RV-9', 'If that reviewer cannot run at all (out of allowance, signed out, its model is gone), review with a headless pi or a pi subagent (its default model and effort) instead for that round only, and say in your summary that you did.'))
    expect(ASK('RV-9')).toContain('`shepherdr review RV-9` first')
    expect(ASK('RV-9')).toContain('`shepherdr review RV-9 --done`')
  })

  test("the task agent's skill tells it to ask the command for each round and to --done it", async () => {
    const skill = await Bun.file(join(import.meta.dir, '..', 'skill', 'shepherdr-agent', 'SKILL.md')).text()
    expect(skill).toContain('shepherdr review <id> --done')
    expect(skill).toContain('which reviewer')
    expect(skill).not.toContain('reviewer not counted')
  })
})

describe('the timeouts the review keeps', () => {
  test('the wait is 90 seconds, as the merge waits; a round holds its reviewer 45 minutes at most', () => {
    expect(REVIEW_DEADLINE).toBe(90_000)
    expect(REVIEW_TIMEOUT).toBe(45 * 60_000)
  })
})
