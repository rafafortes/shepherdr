// The space's merge gate (engine-world.ts): a command run in the worktree after the rebase, what its exit code means
// for the merge, and a Shepherdr that restarts or is stopped under it.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sh, repo, world, until, started } from './engine-world.ts'
import { tmp } from './tmp.ts'
import { killGroup, processes } from '../server/procs.ts'

// each test runs git dozens of times and gh (a bun process of its own) up to fifty: a few seconds alone, past 20 on a
// machine as busy as a CI runner can get
setDefaultTimeout(60_000)

/** a waiting gate command that ends by itself: when its folder goes, when the test process that started it goes (even
 *  one killed without cleanup), or after 1200 turns (about a minute), rather than forking sleep for days (LEAD-01).
 *  `dir` holds `go`; `after` is what it says when it ends. A production gate has no test pid: its own hard limit stops it. */
const waitFor = (go: string, dir: string, after = 'echo ok') =>
  `i=0; while [ ! -f ${go} ] && [ -d ${dir} ] && kill -0 ${process.pid} 2>/dev/null && [ \$i -lt 1200 ]; do sleep 0.05; i=\$((i+1)); done; ${after}`

/** the gate folder of this test's home, and its ledger's lines */
const gatesDir = () => join(process.env.SHEPHERDR_HOME ?? '', 'gates')
const ledger = (): { space: string; task: string; end: string; code: number | null; log: string; last: string; head: string; base: string; seconds: number; members?: string[] }[] =>
  readFileSync(join(gatesDir(), 'ledger.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
/** the files a run that is going on, or was stopped halfway, leaves besides its log */
const exitFiles = () => readdirSync(gatesDir()).filter((f) => f.endsWith('.exit') || f.endsWith('.exit.tmp'))

/** every gate this file starts by hand, so a failing or interrupted test cannot leave one behind */
const gatesStarted: number[] = []
async function gate(cmd: string, wt: string, env: Record<string, string>, dir: string, id: string, at: { head: string; tip: string }, limitMs?: number, hasTimeout?: boolean) {
  const { startGate } = await import('../server/live/engine/engine.ts')
  const run = startGate(cmd, wt, env, dir, id, at, limitMs, hasTimeout)
  gatesStarted.push(run.pid)
  return run
}
const groupAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** a gate is gone only when no process still runs its command: `timeout` may lead a group of its own, so the leader's
 *  pid alone cannot tell (LEAD-01). Its log path is unique to this run and survives in the command line. */
const gateGone = (run: { log: string; exit: string }) => !processes().some((p) => p.cmd.includes(run.log) || p.cmd.includes(run.exit))
afterEach(() => {
  for (const pid of gatesStarted.splice(0)) killGroup(pid)
})

describe('shepherdr merge', () => {
  describe("the space's merge gate", () => {
    /** a task with a commit of its own, reported done, and its space's gate set to `cmd` */
    async function gated(name: string, cmd: string) {
      const w = world()
      const dir = repo()
      const s = await started(w, dir, name)
      writeFileSync(join(s.t.worktree!, 'hello.txt'), 'hello\n')
      sh('git add -A && git commit -qm "add hello"', s.t.worktree!)
      expect(w.settings.set('merge.gate', cmd, { space: s.p.name }).ok).toBe(true)
      await w.engine.done(s.t.id, 'Added hello.txt.')
      return { w, dir, ...s }
    }

    test('it runs in the worktree after the rebase: exit 0 lets it in, and its last line goes into the merge commit', async () => {
      const { w, dir, p, t } = await gated('gate-ok', 'test -f hello.txt && echo checking && echo "Merge gate: green for $SHEPHERDR_TASK on $SHEPHERDR_BASE"')
      const base = sh('git rev-parse main', dir)
      expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
      expect(sh('git log -1 --format=%b', dir)).toBe(`Added hello.txt.\n\nMerge gate: green for ${t.id} on main`)
      // a run's exit files go once its outcome is read; its log stays, named by its one line in the ledger
      const [line, ...more] = ledger()
      expect(more).toEqual([])
      expect(exitFiles()).toEqual([])
      expect(readdirSync(gatesDir()).sort()).toEqual([line.log, 'ledger.jsonl'].sort())
      expect(readFileSync(join(gatesDir(), line.log), 'utf8')).toBe(`checking\nMerge gate: green for ${t.id} on main\n`)
      expect(line).toMatchObject({ space: p.name, task: t.id, end: 'passed', code: 0, last: `Merge gate: green for ${t.id} on main`, base })
      expect(line.head).toMatch(/^[0-9a-f]{40}$/)
      expect(line.members).toBeUndefined()
      expect(line.log).toMatch(new RegExp(`^${p.name}\\.${t.id}-\\d{13}-[0-9a-f]{8}\\.log$`))
      expect(w.engine.statusOf(t)).toBe('done')
    })

    test('anything but exit 0 refuses the merge with the end of its output; main is as it was, and the task is Ready again', async () => {
      const { w, dir, t } = await gated('gate-red', 'echo building; echo "2 tests failed" >&2; exit 3')
      const main = sh('git rev-parse main', dir)
      const r = await w.engine.merge(t.id, { self: true })
      expect(r.ok).toBe(false)
      // the refusal says where the run's whole log is kept, and the ledger has the run: refused, its code and its last line
      const [line] = ledger()
      expect(line).toMatchObject({ task: t.id, end: 'refused', code: 3, last: '2 tests failed' })
      expect(readFileSync(join(gatesDir(), line.log), 'utf8')).toBe('building\n2 tests failed\n')
      expect(r.error).toBe(
        `${t.id}'s merge gate (echo building; echo "2 tests failed" >&2; exit 3) failed (exit 3): nothing was merged, and main is as it was. Its output ends:\nbuilding\n2 tests failed\nIts full log is kept at ${join(gatesDir(), line.log)}\nThe merge gate is the merge's full check: fix what its lines name, prove the fix with targeted tests, then run shepherdr merge again; no full check of your own first.`,
      )
      expect(sh('git rev-parse main', dir)).toBe(main)
      expect(sh('git status --porcelain', dir)).toBe('')
      expect(t.merged).toBeFalsy()
      expect(t.landing).toBeUndefined()
      // its row says why until its next merge starts: the last line the gate printed
      expect(w.engine.statusOf(t)).not.toBe('merging')
      // the last line it wrote, its errors included
      expect(w.engine.subOf(t)).toBe('Refused by the gate: 2 tests failed')
      w.settings.set('merge.gate', 'echo fine', { space: w.engine.view(t).place.split(':').pop()! })
      expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
      expect(t.mergeStop).toBeUndefined()
    })

    test('two merges into one repo: the one gating says so, the next waits for its runs; a conflict is no merging', async () => {
      const goDir = tmp('gate-go')
      const go = join(goDir, 'go')
      const w = world()
      const dir = repo()
      const a = await started(w, dir, 'gate-line', 'First', 'Add a.txt.')
      writeFileSync(join(a.t.worktree!, 'a.txt'), 'a\n')
      sh('git add -A && git commit -qm "add a"', a.t.worktree!)
      expect(w.settings.set('merge.gate', waitFor(go, goDir), { space: a.p.name }).ok).toBe(true)
      const b = w.engine.add({ project: a.p.name, title: 'Second', desc: 'Add b.txt.', by: 'test' })
      await until(() => !!b.worktree)
      writeFileSync(join(b.worktree!, 'b.txt'), 'b\n')
      sh('git add -A && git commit -qm "add b"', b.worktree!)
      await w.engine.done(a.t.id, 'Added a.txt.')
      await w.engine.done(b.id, 'Added b.txt.')
      const first = w.engine.merge(a.t.id, { self: true })
      await until(() => a.t.landing?.step === 'gate')
      expect(w.engine.subOf(a.t)).toBe('Running the merge gate')
      const second = w.engine.merge(b.id, { self: true })
      expect(w.engine.statusOf(b)).toBe('merging')
      expect(w.engine.subOf(b)).toBe(`Waiting for the merge gate (${a.t.id}'s runs)`)
      writeFileSync(go, 'go\n')
      expect((await first).ok).toBe(true)
      expect((await second).ok).toBe(true)
      // without a gate, the words say whose merge it waits for
      expect((await import('../server/live/engine/engine.ts')).landingLine({ step: 'queue', at: 0, behind: 'X-1' })).toBe("Waiting for X-1's merge")
      // a conflict hands the rebase to its agent: its own status, and the row says why
      const c = w.engine.add({ project: a.p.name, title: 'Third', desc: 'Change README.md.', by: 'test' })
      await until(() => !!c.worktree)
      writeFileSync(join(c.worktree!, 'README.md'), 'theirs\n')
      sh('git commit -qam theirs', c.worktree!)
      writeFileSync(join(dir, 'README.md'), 'mine\n')
      sh('git commit -qam mine', dir)
      await w.engine.done(c.id, 'Changed README.md.')
      expect((await w.engine.merge(c.id, { self: true })).error).toContain('Conflict with main')
      expect(c.landing?.step).toBe('rebase')
      expect(w.engine.statusOf(c)).not.toBe('merging')
      expect(w.engine.subOf(c)).toBe('Merge stopped on a conflict with main: rebasing by hand')
    })

    test('one that runs too long is stopped and refuses the merge; while it runs, merge says so and goes on', async () => {
      const { w, t } = await gated('gate-slow', 'sleep 5')
      w.engine.gateTimeout = 1500
      const first = w.engine.merge(t.id, { self: true })
      await until(() => t.landing?.step === 'gate')
      // asked again while the gate runs: it waits for the same one, and by its deadline says the gate still runs
      w.engine.mergeDeadline = 100
      expect((await w.engine.merge(t.id, { self: true })).error).toContain('its merge gate still runs')
      w.engine.mergeDeadline = 30_000
      expect((await first).error).toContain(`${t.id}'s merge gate (sleep 5) didn't finish in 2 s: nothing was merged`)
    })

    test('main moved while it ran: the branch is rebased on it and the gate runs again; a conflict then stops it', async () => {
      const mark = join(tmp('gate-mark'), 'ran')
      const { w, dir, t } = await gated(
        'gate-moved',
        `echo run >> ${mark}; if [ $(wc -l < ${mark}) = 1 ]; then (cd ${'$'}MAIN && echo other > other.txt && git add -A && git commit -qm "moved meanwhile"); fi; echo "gate ok"`,
      )
      process.env.MAIN = dir
      expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
      expect(readFileSync(mark, 'utf8').trim().split('\n')).toHaveLength(2)
      expect(sh('git log --format=%s -n 3', dir).split('\n')).toEqual([`${t.id}: Say hello`, 'moved meanwhile', 'init'])
      // a conflicting change on main meanwhile: nothing goes in, and the agent rebases by hand
      const c = await gated('gate-conflict', `cd ${'$'}MAIN2 && test -f moved || (touch moved && echo theirs > hello.txt && git add hello.txt && git commit -qm "theirs too")`)
      process.env.MAIN2 = c.dir
      const r = await c.w.engine.merge(c.t.id, { self: true })
      expect(r.error).toStartWith('Conflict with main, which moved while the merge gate ran')
      expect(c.t.landing?.step).toBe('rebase')
      delete process.env.MAIN
      delete process.env.MAIN2
    })

    test('main that keeps moving while it runs: after a few rounds the merge gives up for now', async () => {
      const { w, dir, t } = await gated('gate-busy', `(cd ${'$'}MAIN3 && date +%s%N > busy.txt && git add -A && git commit -qm busy)`)
      process.env.MAIN3 = dir
      const r = await w.engine.merge(t.id, { self: true })
      expect(r.error).toBe(`main kept moving while ${t.id}'s merge gate ran (3 times): nothing was merged. Run shepherdr merge ${t.id} again.`)
      delete process.env.MAIN3
    })

    test('a merge that runs past its deadline tells its agent to end its turn, then wakes it with how it went', async () => {
      const goDir = tmp('gate-late')
      const go = join(goDir, 'go')
      const { w, t, key } = await gated('gate-late', waitFor(go, goDir, 'echo "Gate: green"'))
      const run = w.engine.merge(t.id, { self: true })
      // in its gate (a loaded machine takes a while to get there): asked now, its deadline says so
      await until(() => t.landing?.step === 'gate', 20_000)
      w.engine.mergeDeadline = 100
      const first = await w.engine.merge(t.id, { self: true })
      expect(first.error).toContain(`${t.id}'s merge is in its gate: its merge gate still runs`)
      expect(first.error).toContain('end your turn now, without polling or sleeping')
      // waiting in its gate, it holds none of the machine's slots
      expect(w.engine.working()).toBe(0)
      writeFileSync(go, 'go\n')
      await until(() => w.sent.some((x) => x.key === key && x.text.includes('Your merge went in')), 20_000)
      expect(w.engine.statusOf(t)).toBe('done')
      expect((await run).ok).toBe(true)
    })

    test('a restart leaves its gate running: the Shepherdr that comes back goes on from it, and its agent hears how it went', async () => {
      const goDir = tmp('gate-resume')
      const go = join(goDir, 'go')
      const cmd = waitFor(go, goDir, 'echo "Gate: green after the restart"')
      const { w, dir, t, key } = await gated('gate-resume', cmd)
      // as a restart leaves it: its merge in its gate, its gate's process going on by itself
      sh(`git rebase -q main`, t.worktree!)
      const head = sh('git rev-parse HEAD', t.worktree!)
      const tip = sh('git rev-parse main', dir)
      t.landing = { step: 'gate', at: Date.now() }
      const run = await gate(cmd, t.worktree!, {}, tmp('gate-files'), t.id, { head, tip })
      t.gateRun = run
      w.engine.resumeMerges()
      await until(() => t.landing?.step === 'gate')
      // young, and of a task that still wants it: the restart leaves it running and finds it again
      expect(groupAlive(run.pid)).toBe(true)
      writeFileSync(go, 'go\n')
      await until(() => w.sent.some((x) => x.key === key && x.text.includes('Your merge went in')))
      expect(sh('git log -1 --format=%b', dir)).toContain('Gate: green after the restart')
    })

    test('a merge a restart cut short with nothing left of it is back at its turn: its row and its agent say to merge again', async () => {
      const { w, t, key } = await gated('gate-lost', 'echo fine')
      t.landing = { step: 'gate', at: Date.now() }
      t.gateRun = { pid: 999_999_999, log: '/nonexistent/log', exit: '/nonexistent/exit', at: Date.now(), head: 'x', tip: 'y' }
      w.engine.resumeMerges()
      expect(t.landing).toBeUndefined()
      expect(t.gateRun).toBeUndefined()
      expect(w.engine.subOf(t)).toBe('Merge gate interrupted by a restart: run shepherdr merge again')
      expect(w.sent.filter((x) => x.key === key).at(-1)!.text).toContain(`Shepherdr restarted while your merge ran (its gate was stopped): nothing was merged. Run shepherdr merge ${t.id} again.`)
      t.landing = { step: 'merge', at: Date.now() }
      w.engine.resumeMerges()
      expect(w.engine.subOf(t)).toBe('Merge interrupted by a restart: run shepherdr merge again')
    })

    test('a run the merge drops is stopped with its files, and a late exit of its own never overwrites the newer run', async () => {
      const goDir = tmp('gate-stale-merge')
      const go = join(goDir, 'go')
      const { w, t } = await gated('gate-stale-merge', 'echo green')
      const gates = join(process.env.SHEPHERDR_HOME!, 'gates')
      // a run a restart left going at another head: the merge starts its own, and drops that one
      const stale = await gate(waitFor(go, goDir, 'echo stale'), t.worktree!, {}, gates, t.id, { head: 'old-head', tip: 'old-tip' })
      t.gateRun = stale
      expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
      expect(exitFiles()).toEqual([])
      // both runs have their line: the dropped one stopped (no exit code), the new one passed; both logs are kept
      const lines = ledger()
      expect(lines.map((l) => [l.end, l.code])).toEqual([
        ['stopped', null],
        ['passed', 0],
      ])
      expect(readdirSync(gates).filter((f) => f.endsWith('.log'))).toHaveLength(2)
      // the dropped run's whole process group is gone, not left to end: it can no longer fork sleep
      await until(() => gateGone(stale), 20_000)
      // even an exit code written as the kill landed goes to its own files, and the late cleanup removes it
      writeFileSync(stale.exit, '0\n')
      expect(existsSync(stale.exit)).toBe(true)
      await until(() => exitFiles().length === 0, 20_000)
    })

    test('a restart that finds a gate run dead with no exit code drops it with its files', async () => {
      const { w, t } = await gated('gate-dead', 'echo fine')
      const gates = join(process.env.SHEPHERDR_HOME!, 'gates')
      mkdirSync(gates, { recursive: true })
      // what a run left when it died before its exit code: its log, and a half-written exit file
      const log = join(gates, 'dead.log')
      writeFileSync(log, 'partial\n')
      writeFileSync(join(gates, 'dead.exit.tmp'), '')
      t.landing = { step: 'gate', at: Date.now() }
      t.gateRun = { pid: 999_999_999, log, exit: join(gates, 'dead.exit'), at: Date.now(), head: 'x', tip: 'y' }
      w.engine.resumeMerges()
      expect(t.gateRun).toBeUndefined()
      // its half-written exit file goes; its log stays, and the ledger says it was stopped with no exit code
      expect(exitFiles()).toEqual([])
      expect(readdirSync(gates).sort()).toEqual(['dead.log', 'ledger.jsonl'])
      expect(ledger()).toMatchObject([{ task: '', end: 'stopped', code: null, log: 'dead.log', head: 'x', base: 'y' }])
      expect(w.engine.subOf(t)).toBe('Merge gate interrupted by a restart: run shepherdr merge again')
    })

    test("a stale run of the same task, still going after a newer one began, never writes over the newer run's exit code", async () => {
      const { waitGate } = await import('../server/live/engine/engine.ts')
      const dir = tmp('gate-stale')
      const goOld = join(dir, 'go-old')
      const goNew = join(dir, 'go-new')
      // the run a restart left going (its head is no longer the one a merge asks for), and the one that replaced it
      const old = await gate(waitFor(goOld, dir, 'echo old; exit 0'), dir, {}, dir, 'STALE-1', { head: 'h1', tip: 't' })
      const fresh = await gate(waitFor(goNew, dir, 'echo new; exit 3'), dir, {}, dir, 'STALE-1', { head: 'h2', tip: 't' })
      expect(fresh.exit).not.toBe(old.exit)
      writeFileSync(goOld, 'go\n')
      await until(() => existsSync(old.exit))
      writeFileSync(goNew, 'go\n')
      expect(await waitGate(fresh, 10_000)).toEqual({ code: 3, out: 'new' })
      expect(readFileSync(old.exit, 'utf8').trim()).toBe('0')
    })

    test('a gate has its own hard limit, so it ends at 124 even when nobody is waiting for it', async () => {
      const { waitGate } = await import('../server/live/engine/engine.ts')
      const dir = tmp('gate-limit')
      // no go file and no waiter: only the limit inside the command can stop it
      const run = await gate('sleep 30', dir, {}, dir, 'LIMIT-1', { head: 'h', tip: 't' }, 500)
      expect(await waitGate(run, 5000)).toMatchObject({ code: 124 })
    })

    test('a gate that leaves a child running is stopped with it at its hard limit', async () => {
      const { waitGate } = await import('../server/live/engine/engine.ts')
      const dir = tmp('gate-child')
      const childFile = join(dir, 'child')
      const run = await gate(`sleep 1234 & echo \$! > ${childFile}; wait`, dir, {}, dir, 'CHILD-1', { head: 'h', tip: 't' }, 700)
      expect((await waitGate(run, 6000)).code).toBe(124)
      const child = Number(readFileSync(childFile, 'utf8').trim())
      await until(() => child > 0 && !processes().some((p) => p.pid === child), 20_000)
    })

    test('deleting a task while its merge waits in a gate stops the gate instead of hanging', async () => {
      const goDir = tmp('gate-delete-active')
      const { w, t } = await gated('gate-delete-active', waitFor(join(goDir, 'go'), goDir, 'echo ok'))
      const merging = w.engine.merge(t.id, { self: true })
      await until(() => !!t.gateRun?.pid, 20_000)
      const run = t.gateRun!
      await w.engine.deleteTask(t.id, { force: true })
      await until(() => gateGone(run), 20_000)
      expect((await merging).ok).toBe(false)
    })

    test('the plain line is the fallback where there is no timeout binary, and still writes its exit code', async () => {
      const { gateCommand, waitGate } = await import('../server/live/engine/engine.ts')
      const dir = tmp('gate-no-timeout')
      const log = join(dir, 'plain.log')
      const exit = join(dir, 'plain.exit')
      expect(gateCommand('echo x', log, exit, 30)).toContain('timeout -s KILL 30')
      // hide the binary from PATH: the default seam then picks the plain line
      const path = process.env.PATH
      process.env.PATH = join(dir, 'empty')
      try {
        expect(gateCommand('echo x', log, exit, 30)).not.toContain('timeout -s KILL')
      } finally {
        process.env.PATH = path
      }
      const run = await gate('echo fallback', dir, {}, dir, 'PLAIN-1', { head: 'h', tip: 't' }, 5000, false)
      expect(await waitGate(run, 5000)).toEqual({ code: 0, out: 'fallback' })
    })

    test('a gate is stopped when its task is closed, stopped, archived or deleted', async () => {
      for (const how of ['close', 'stop', 'archive', 'delete'] as const) {
        const goDir = tmp(`gate-${how}`)
        const cmd = waitFor(join(goDir, 'go'), goDir, 'echo ok')
        const { w, t } = await gated(`gate-${how}`, cmd)
        const run = await gate(cmd, t.worktree!, {}, goDir, t.id, { head: 'h', tip: 't' })
        t.gateRun = run
        expect(groupAlive(run.pid)).toBe(true)
        if (how === 'close') await w.engine.close(t.id)
        else if (how === 'stop') await w.engine.stopTask(t.id)
        else if (how === 'archive') await w.engine.archive(t.id)
        else await w.engine.deleteTask(t.id, { force: true })
        await until(() => gateGone(run), 20_000)
        expect(t.gateRun).toBeUndefined()
      }
    })

    test('a restart stops a gate past its limit or of a task that is gone', async () => {
      const gates = join(process.env.SHEPHERDR_HOME!, 'gates')
      const { w, t } = await gated('gate-old', 'echo fine')
      // long-lived gates: only the sweep can stop them here, not the limit inside the command
      const old = await gate('sleep 300', t.worktree!, {}, gates, t.id, { head: 'h', tip: 't' })
      old.at = Date.now() - 46 * 60_000
      t.landing = { step: 'gate', at: Date.now() }
      t.gateRun = old
      // a run whose task is gone from the record: its command still names a gate file in this home
      const orphan = await gate('sleep 300', t.worktree!, {}, gates, 'GONE-99', { head: 'h', tip: 't' })
      expect(gateGone(old)).toBe(false)
      expect(gateGone(orphan)).toBe(false)
      w.engine.resumeMerges()
      await until(() => gateGone(old) && gateGone(orphan), 20_000)
      expect(t.gateRun).toBeUndefined()
      expect(w.engine.subOf(t)).toBe('Merge gate interrupted by a restart: run shepherdr merge again')
    })

    /** `n` tasks of one repo, each with a file of its own committed and reported done; its gate waits for `go-<id>` */
    async function line(name: string, n: number) {
      const w = world()
      const dir = repo()
      const gates = tmp(`${name}-go`)
      const a = await started(w, dir, name, 'Task 1', 'Add 1.txt.')
      expect(w.settings.set('merge.gate', waitFor(`${gates}/go-$SHEPHERDR_TASK`, gates, 'echo "Gate: green for $SHEPHERDR_TASK"'), { space: a.p.name }).ok).toBe(true)
      const ts = [a.t]
      for (let i = 2; i <= n; i++) ts.push(w.engine.add({ project: a.p.name, title: `Task ${i}`, desc: `Add ${i}.txt.`, by: 'test' }))
      await until(() => ts.every((t) => !!t.worktree))
      for (const [i, t] of ts.entries()) {
        writeFileSync(join(t.worktree!, `${i + 1}.txt`), `${i + 1}\n`)
        sh(`git add -A && git commit -qm "add ${i + 1}"`, t.worktree!)
        await w.engine.done(t.id, `Added ${i + 1}.txt.`)
      }
      const go = (t: { id: string }) => writeFileSync(join(gates, `go-${t.id}`), 'go\n')
      return { w, dir, ts, go, gates }
    }

    test('in line, its row names the merge that runs now, and moves on to the next as each one ends', async () => {
      const { w, ts, go } = await line('gate-now', 3)
      const [a, b, c] = ts
      const runs = [w.engine.merge(a.id, { self: true })]
      await until(() => a.landing?.step === 'gate')
      runs.push(w.engine.merge(b.id, { self: true }), w.engine.merge(c.id, { self: true }))
      expect(w.engine.subOf(b)).toBe(`Waiting for the merge gate (${a.id}'s runs)`)
      expect(w.engine.subOf(c)).toBe(`Waiting for the merge gate (${a.id}'s runs)`)
      go(a)
      await until(() => b.landing?.step === 'gate')
      // the one ahead is through: the last in line now waits on the one gating, not on the one it first stood behind
      expect(w.engine.subOf(c)).toBe(`Waiting for the merge gate (${b.id}'s runs)`)
      go(b)
      go(c)
      expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true])
    })

    test('written to after it reported, its own merge still puts it on its way into main: never Needs you while it waits', async () => {
      // a coordinator's "rebase on main and run shepherdr merge" makes it work again, not done; its agent then merges
      const { w, ts, go } = await line('gate-asked', 3)
      const [a, b, c] = ts
      const first = w.engine.merge(a.id, { self: true })
      await until(() => a.landing?.step === 'gate')
      w.engine.youWrote(`${b.id}/Agent`)
      expect(b.reported).toBe(false)
      const second = w.engine.merge(b.id, { self: true })
      expect(b.reported).toBe(true)
      expect(w.engine.statusOf(b)).toBe('merging')
      expect(w.engine.subOf(b)).toBe(`Waiting for the merge gate (${a.id}'s runs)`)
      // a restart finds it in line, as any other
      expect(b.landing?.step).toBe('queue')
      // asked by you or a coordinator, with its agent at rest: once it goes in, it is merging too
      w.engine.youWrote(`${c.id}/Agent`)
      w.agentIs(`${c.id}/Agent`, 'idle')
      const third = w.engine.merge(c.id)
      expect(c.reported).toBe(false)
      for (const t of [a, b]) go(t)
      await until(() => c.landing?.step === 'gate')
      expect(c.reported).toBe(true)
      expect(w.engine.statusOf(c)).toBe('merging')
      go(c)
      expect((await Promise.all([first, second, third])).map((r) => r.ok)).toEqual([true, true, true])
    })

    test('a merge that only waited in line goes on by itself after a restart, behind the gate that went on, as it stood', async () => {
      const { w, dir, ts, go, gates } = await line('gate-requeue', 3)
      const [g, q1, q2] = ts
      // as a restart leaves them: g in its gate, its process going on by itself; q1 and q2 in line (q2 first), though
      // their places come after g's
      sh('git rebase -q main', g.worktree!)
      const head = sh('git rev-parse HEAD', g.worktree!)
      g.landing = { step: 'gate', at: 3 }
      g.gateRun = await gate(waitFor(`${gates}/go-${g.id}`, gates, `echo "Gate: green for ${g.id}"`), g.worktree!, {}, tmp('gate-requeue-files'), g.id, { head, tip: sh('git rev-parse main', dir) })
      q1.landing = { step: 'queue', at: 2, behind: 'GONE-1', gate: true }
      q2.landing = { step: 'queue', at: 1, behind: 'GONE-1', gate: true }
      w.engine.resumeMerges()
      await until(() => w.engine.subOf(q1) === `Waiting for the merge gate (${g.id}'s runs)`)
      expect(w.engine.subOf(q2)).toBe(`Waiting for the merge gate (${g.id}'s runs)`)
      for (const t of ts) go(t)
      await until(() => ts.every((t) => w.engine.statusOf(t) === 'done'))
      // g first, then the two in the order they stood in line
      expect(sh('git log --format=%s -n 4', dir).split('\n')).toEqual([`${q1.id}: Task 2`, `${q2.id}: Task 3`, `${g.id}: Task 1`, 'init'])
      for (const t of ts) {
        const said = w.sent.filter((x) => x.key === `${t.id}/Agent`).map((x) => x.text)
        await until(() => w.sent.some((x) => x.key === `${t.id}/Agent` && x.text.includes('Your merge went in')))
        // nobody was asked to merge again
        expect(said.some((x) => x.includes('Run shepherdr merge'))).toBe(false)
      }
    })

    test('a gate killed from outside is no answer: the merge says it was stopped, and nothing went in', async () => {
      const { w, dir, t } = await gated('gate-killed', 'sleep 30')
      const main = sh('git rev-parse main', dir)
      // a marked task's lone turn: a gate that never ended keeps the mark
      t.alone = true
      const said: string[] = []
      const stderr = console.error
      console.error = (m: unknown) => void said.push(String(m))
      try {
        const run = w.engine.merge(t.id, { self: true })
        await until(() => !!t.gateRun?.pid)
        killGroup(t.gateRun!.pid)
        expect((await run).error).toContain(`${t.id}'s merge gate (sleep 30) was stopped before it ended`)
      } finally {
        console.error = stderr
      }
      expect(sh('git rev-parse main', dir)).toBe(main)
      expect(t.alone).toBe(true)
      // a run judged gone says how its shell ended, in the server's log and as the last line the ledger keeps
      expect(said.filter((l) => l.includes('gate run '))).toEqual([
        expect.stringMatching(
          new RegExp(`^shepherdr: gate run gate-killed\\.${t.id}-\\d{13}-[0-9a-f]{8}\\.log \\(${t.id}\\): its shell was killed by SIGKILL with no exit code, \\d+ ms after it started$`),
        ),
      ])
      expect(ledger().at(-1)).toMatchObject({ end: 'stopped', code: null, last: expect.stringMatching(/^its shell was killed by SIGKILL with no exit code, \d+ ms after it started$/) })
    })

    test('off, or none set: no gate', async () => {
      const { w, t } = await gated('gate-off', 'off')
      expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    })
  })
})
