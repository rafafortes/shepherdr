// The pre-flight when a merge train forms (merge.preflight, engine.train / preflightTrain): the stack is looked at once before
// its gate, and a car whose prefix fails goes to its own gate while the rest go on one gate run. Real git, real commands, the
// engine's own world (train-world.ts), here for the stack that passes, a head that fails, a probe killed and a restart. The
// faulty cars at each position, several of them, and the bound are in the other engine-merge-train-preflight*.test.ts files.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { trainLog, trainWorld, wtOf } from './train-world.ts'
import { asked, ledger, probes, WRONG_AFTER_BLOCKER } from './train-preflight-world.ts'
import { sh, until } from './engine-world.ts'
import { tmp } from './tmp.ts'
import { killGroup, processes } from '../server/procs.ts'

setDefaultTimeout(120_000)

const { decisions } = trainLog()

describe('the pre-flight when a merge train forms', () => {
  test('a stack that passes goes to its gate as it is: one pre-flight run, then one gate run', async () => {
    const world = await trainWorld('pre-train-pass', 3, '3', [], undefined, WRONG_AFTER_BLOCKER)
    const { dir, ts, riders, ran, pre } = world
    const said = await asked(world)
    expect(said.map((r) => r.ok)).toEqual([true, true, true, true])
    const [a, b, c] = riders
    expect(ran()).toEqual([ts[0].id, a.id])
    // the blocker and the three each passed at the door; the train's stack was looked at once
    expect(probes()).toEqual([[`${a.id},${b.id},${c.id}`, 'passed']])
    expect(pre().filter(([, ref]) => ref === 'HEAD')).toHaveLength(1)
    expect(sh(`git log -1 --format=%b ${c.squash}`, dir)).toContain(`Merge train: ${a.id}, ${b.id}, ${c.id} (one merge gate run)`)
    for (const t of ts) expect([t.alone, t.bisect, t.landing]).toEqual([undefined, undefined, undefined])
  })

  test('a head that fails runs its own gate on its branch, not on the stack the pre-flight left it at', async () => {
    const world = await trainWorld('pre-train-branch', 3, '3', [1], undefined, WRONG_AFTER_BLOCKER)
    const { w, riders, ts, go, ran } = world
    const [a] = riders
    const answers = [w.engine.merge(ts[0].id, { self: true })]
    await until(() => ts[0].landing?.step === 'gate')
    for (const t of riders) {
      answers.push(w.engine.merge(t.id, { self: true }))
      await until(() => t.landing?.step === 'queue')
    }
    go(ts[0])
    // a's own gate (the second run) waits for its go: its worktree is on its branch, with nothing marked on a
    await until(() => ran().length === 2)
    expect(ran()).toEqual([ts[0].id, a.id])
    expect(sh('git branch --show-current', wtOf(a))).toBe(String(a.branch))
    expect([a.alone, a.bisect]).toEqual([undefined, undefined])
    for (const t of ts) go(t)
    expect((await Promise.all(answers)).map((r) => r.ok)).toEqual([true, false, true, true])
  })

  test('a probe killed from outside is no answer: the search ends, the head goes alone, and nobody is marked', async () => {
    // the probes of a train's stack (the worktree is detached there) wait for their go; the runs at the door do not
    const flag = join(tmp('pre-train-killed-go'), 'go')
    const world = await trainWorld(
      'pre-train-killed',
      3,
      '3',
      [],
      undefined,
      `if [ "$(git rev-parse --abbrev-ref HEAD)" = HEAD ]; then i=0; while [ ! -f ${flag} ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; fi; exit 0`,
    )
    const { w, riders, ts, go, ran, pre } = world
    const [a, b, c] = riders
    const answers = [w.engine.merge(ts[0].id, { self: true })]
    await until(() => ts[0].landing?.step === 'gate')
    for (const t of riders) {
      answers.push(w.engine.merge(t.id, { self: true }))
      await until(() => t.landing?.step === 'queue')
    }
    go(ts[0])
    // a's probe of the stack is running: it dies with no exit code
    // (the run logs itself as it starts, on the stack: its worktree is detached there)
    await until(() => pre().some(([, ref]) => ref === 'HEAD'), 30_000)
    for (const p of processes().filter((p) => p.cmd.includes('.pre.exit'))) killGroup(p.pid)
    // the probes after it do not wait
    writeFileSync(flag, 'go\n')
    // a goes alone to its own gate (the second run), and b and c follow as a train of their own
    await until(() => ran().length === 2)
    expect(ran()).toEqual([ts[0].id, a.id])
    expect(sh('git branch --show-current', wtOf(a))).toBe(String(a.branch))
    for (const t of ts) go(t)
    expect((await Promise.all(answers)).map((r) => r.ok)).toEqual([true, true, true, true])
    expect(ledger().find((l) => l.kind === 'preflight' && l.members && l.end === 'stopped')).toMatchObject({ task: a.id, code: null, members: [a.id, b.id, c.id] })
    expect(decisions(ts.map((t) => t.id))).toContain(`shepherdr: ${a.id}'s merge train: its pre-flight stopped before it ended (a restart, or a kill)`)
    for (const t of ts) expect([t.alone, t.bisect]).toEqual([undefined, undefined])
  })

  test('a restart in the middle of a probe leaves nobody marked and no worktree detached: the head goes back on its branch, and its agent is told to merge again', async () => {
    const world = await trainWorld('pre-train-restart', 3, '3', [], undefined, WRONG_AFTER_BLOCKER)
    const { w, riders } = world
    const [a] = riders
    // as a restart leaves it: the head's worktree detached at a probe's stack, its turn cut short in its pre-flight
    sh('git checkout -q --detach HEAD', wtOf(a))
    expect(sh('git branch --show-current', wtOf(a))).toBe('')
    a.landing = { step: 'merge', at: Date.now(), pre: true }
    w.engine.resumeMerges()
    await until(() => existsSync(wtOf(a)) && sh('git branch --show-current', wtOf(a)) === a.branch)
    expect(a.landing).toBeUndefined()
    for (const t of riders) expect([t.alone, t.bisect]).toEqual([undefined, undefined])
    expect(w.sent.filter((x) => x.key === `${a.id}/Agent`).at(-1)?.text ?? '').toContain(`Run shepherdr merge ${a.id} again.`)
  })
})
