// A merge train (engine-world.ts): the merges that wait for one gate run go in together, and what a rider that
// cannot ride it out does, through a restart, a stop and a deadline.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sh, repo, world, until, started } from './engine-world.ts'
import { tmp } from './tmp.ts'
import { killGroup } from '../server/procs.ts'

// each test runs git dozens of times and gh (a bun process of its own) up to fifty: a few seconds alone, past 20 on a
// machine as busy as a CI runner can get
setDefaultTimeout(60_000)

/** a waiting gate command that ends by itself: when its folder goes, when the test process that started it goes (even
 *  one killed without cleanup), or after 1200 turns (about a minute), rather than forking sleep for days (LEAD-01).
 *  `dir` holds `go`; `after` is what it says when it ends. A production gate has no test pid: its own hard limit stops it. */
const waitFor = (go: string, dir: string, after = 'echo ok') =>
  `i=0; while [ ! -f ${go} ] && [ -d ${dir} ] && kill -0 ${process.pid} 2>/dev/null && [ \$i -lt 1200 ]; do sleep 0.05; i=\$((i+1)); done; ${after}`

/** every gate this file starts by hand, so a failing or interrupted test cannot leave one behind */
const gatesStarted: number[] = []
async function gate(cmd: string, wt: string, env: Record<string, string>, dir: string, id: string, at: { head: string; tip: string }, limitMs?: number, hasTimeout?: boolean) {
  const { startGate } = await import('../server/live/engine/engine.ts')
  const run = startGate(cmd, wt, env, dir, id, at, limitMs, hasTimeout)
  gatesStarted.push(run.pid)
  return run
}
afterEach(() => {
  for (const pid of gatesStarted.splice(0)) killGroup(pid)
})

describe('shepherdr merge', () => {
  describe("the space's merge gate", () => {
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

    describe('a merge train', () => {
      // the server's log (console.error) while these run: its lines about a train's decisions are what the tests assert.
      // A world a test leaves running (the restart tests' second one) logs into the same console: only the lines whose
      // head is one of this test's tasks count
      let log: string[] = []
      let mine: string[] = []
      const stderr = console.error
      beforeEach(() => {
        log = []
        mine = []
        console.error = (m: unknown) => void log.push(String(m))
      })
      afterEach(() => {
        console.error = stderr
      })
      const decisions = () => log.filter((l) => /merge (train|goes alone)/.test(l) && mine.some((id) => l.startsWith(`shepherdr: ${id}'s `)))
      /** a commit's short id (7 characters), as the train's lines name it */
      const short = (dir: string, ref: string | undefined) => sh(`git rev-parse --short=7 ${ref}`, dir)

      /** a line of `n` with its gate logging each run (`runs`), waiting for go-<the task it gates for>, then green */
      async function train(name: string, n: number, k: string, gate = '') {
        const l = await line(name, n)
        const runs = join(l.gates, 'runs')
        const space = l.w.engine.view(l.ts[0]).place.split(':').pop()!
        const waiting = waitFor(`${l.gates}/go-$SHEPHERDR_TASK`, l.gates, 'echo "Gate: green on $(git rev-parse --short HEAD^{tree})"')
        expect(l.w.settings.set('merge.gate', `echo "$SHEPHERDR_TASK $(git rev-parse --short=7 HEAD)" >> ${runs}; ${gate}${waiting}`, { space }).ok).toBe(true)
        expect(l.w.settings.set('merge.train', k, { space }).ok).toBe(true)
        // their agents at rest, as told while their merges wait
        for (const t of l.ts) l.w.agentIs(`${t.id}/Agent`, 'idle')
        mine = l.ts.map((t) => t.id)
        const logged = () =>
          existsSync(runs)
            ? readFileSync(runs, 'utf8')
                .trim()
                .split('\n')
                .map((x) => x.split(' '))
            : []
        // the task each run gated, in order, and the commit it gated (short): a train's run gates its stack's top
        const ran = () => logged().map(([task]) => task)
        const heads = () => logged().map(([, head]) => head)
        return { ...l, ran, heads }
      }

      test('the first in line take the next ones along on one gate run, each going in as its own commit with its line', async () => {
        const { w, dir, ts, go, ran, heads } = await train('train-go', 4, '3')
        const [x, a, b, c] = ts
        // a worktree a train's gate left at the top of its stack (a restart while it ran) is back on its branch first
        sh('git checkout -q --detach', x.worktree!)
        const runs = [w.engine.merge(x.id, { self: true })]
        await until(() => x.landing?.step === 'gate')
        for (const t of [a, b, c]) runs.push(w.engine.merge(t.id, { self: true }))
        expect(w.engine.subOf(c)).toBe(`Waiting for the merge gate (${x.id}'s runs)`)
        go(x)
        // a's turn: b and c go in with it, on one run
        await until(() => a.landing?.cars === 3)
        expect(w.engine.subOf(a)).toBe('Running the merge gate (a train of 3)')
        expect(w.engine.subOf(b)).toBe(`Going in with ${a.id}'s merge train`)
        expect(w.engine.subOf(c)).toBe(`Going in with ${a.id}'s merge train`)
        // a's worktree is at the top of the stack while the gate runs: all three changes there
        expect(['2.txt', '3.txt', '4.txt'].every((f) => existsSync(join(a.worktree!, f)))).toBe(true)
        go(a)
        const said = await Promise.all(runs)
        expect(said.map((r) => r.ok)).toEqual([true, true, true, true])
        expect(said[2].note).toBe(`it went in with ${a.id}'s merge train`)
        expect(ran()).toEqual([x.id, a.id])
        expect(sh('git log --format=%s -n 5', dir).split('\n')).toEqual([`${c.id}: Task 4`, `${b.id}: Task 3`, `${a.id}: Task 2`, `${x.id}: Task 1`, 'init'])
        for (const t of [a, b, c]) {
          const body = sh(`git log -1 --format=%b ${t.squash}`, dir)
          expect(body).toContain(`Added ${ts.indexOf(t) + 1}.txt.`)
          expect(body).toContain('Gate: green on ')
          expect(body).toContain(`Merge train: ${a.id}, ${b.id}, ${c.id} (one merge gate run)`)
          expect(w.engine.statusOf(t)).toBe('done')
        }
        expect(b.train).toBe(a.id)
        expect(decisions()).toEqual([
          `shepherdr: ${a.id}'s merge train: ${a.id}, ${b.id}, ${c.id} (one gate run on ${heads()[1]}, main at ${short(dir, x.squash)})`,
          `shepherdr: ${a.id}'s merge train went in: ${a.id} ${short(dir, a.squash)}, ${b.id} ${short(dir, b.squash)}, ${c.id} ${short(dir, c.squash)}`,
        ])
      })

      test('a rider whose commit a round was not recorded on stays out, and its own turn refuses it', async () => {
        const { w, dir, ts, go, ran } = await train('train-review', 3, '3')
        const [x, a, b] = ts
        // b recorded a round on its first commit, then committed again: that head is not reviewed, so it cannot ride
        expect(await w.engine.reviewRound(b.id)).toMatchObject({ round: 1 })
        expect(w.engine.reviewDone(b.id)).toBe(true)
        const wt = b.worktree
        if (!wt) throw new Error(`${b.id} got no worktree`)
        writeFileSync(join(wt, 'late.txt'), 'late\n')
        sh('git add -A && git commit -qm late', wt)
        const runs = [w.engine.merge(x.id, { self: true })]
        await until(() => x.landing?.step === 'gate')
        runs.push(w.engine.merge(a.id, { self: true }), w.engine.merge(b.id, { self: true }))
        for (const t of [x, a]) go(t)
        const [rx, ra, rb] = await Promise.all(runs)
        expect([rx.ok, ra.ok]).toEqual([true, true])
        // it went in with nobody: on its own turn the gate refuses it, naming what it must review
        expect(rb.ok).toBe(false)
        expect(rb.error).toContain('is not reviewed')
        expect(sh('git log --format=%s -n 4', dir).split('\n')).not.toContain(`${b.id}: Task 3`)
        expect(ran()).toEqual([x.id, a.id])
      })

      test('one that conflicts stays out for its own turn; a refusal goes back to one at a time', async () => {
        // the gate refuses whenever 4.txt (the last task's) is in the tree it checks
        const { w, dir, ts, go, ran, heads } = await train('train-red', 4, '4', 'test -f 4.txt && { echo "4.txt is not wanted"; exit 1; }; ')
        const [x, a, b, c] = ts
        // b adds 2.txt too, as a does, with other words: it can't stack on a
        writeFileSync(join(b.worktree!, '2.txt'), 'b too\n')
        sh('git add -A && git commit -qm "b adds 2.txt"', b.worktree!)
        const runs = [w.engine.merge(x.id, { self: true })]
        await until(() => x.landing?.step === 'gate')
        for (const t of [a, b, c]) runs.push(w.engine.merge(t.id, { self: true }))
        for (const t of [x, a, c]) go(t)
        const [rx, ra, rb, rc] = await Promise.all(runs)
        expect([rx.ok, ra.ok]).toEqual([true, true])
        // the train (a and c) was refused, so a went alone; b then conflicted with a on its own turn; c was refused alone
        expect(ran()).toEqual([x.id, a.id, a.id, c.id])
        expect(rb.error).toContain('Conflict with main')
        expect(rc.error).toContain(`${c.id}'s merge gate`)
        expect(rc.error).toContain('4.txt is not wanted')
        expect(c.landing?.train).toBeUndefined()
        // b's conflict is named, with the file; the train of a and c is refused, and c's own turn alone comes last
        expect(decisions()).toEqual([
          `shepherdr: ${a.id}'s merge train: ${a.id}, ${c.id} (one gate run on ${heads()[1]}, main at ${short(dir, x.squash)}). Left out: ${b.id} conflicts with those before it (2.txt)`,
          `shepherdr: ${a.id}'s merge train refused (exit 1): each goes alone once`,
          `shepherdr: ${c.id}'s merge goes alone (its turn alone after a refused train)`,
        ])
      })

      /** the gate refuses while bad.txt is in the tree (a task's commit of its own) */
      const REFUSE_BAD = 'test -f bad.txt && { echo "bad.txt is not wanted"; exit 1; }; '

      test('a refused train: each member goes alone once, only the one whose change fails is told, and it rides again after its turn alone', async () => {
        const { w, dir, ts, go, ran, heads } = await train('train-refused', 4, '3', REFUSE_BAD)
        const [x, a, b, c] = ts
        const space = w.engine.view(x).place.split(':').pop()!
        writeFileSync(join(c.worktree!, 'bad.txt'), 'bad\n')
        sh('git add -A && git commit -qm "c adds bad.txt"', c.worktree!)
        const runs = [w.engine.merge(x.id, { self: true })]
        await until(() => x.landing?.step === 'gate')
        for (const t of [a, b, c]) runs.push(w.engine.merge(t.id, { self: true }))
        go(x)
        go(a)
        go(b)
        const [rx, ra, rb, rc] = await Promise.all(runs)
        expect([rx.ok, ra.ok, rb.ok]).toEqual([true, true, true])
        // the train of a, b and c is refused by c's change: a goes alone and goes in, then b, then c alone is refused
        expect(ran()).toEqual([x.id, a.id, a.id, b.id, c.id])
        expect(rc.error).toContain(`${c.id}'s merge gate`)
        expect(rc.error).toContain('bad.txt is not wanted')
        expect(rb.error).toBeUndefined()
        // nobody but c heard about a refused train: none of the three was sent a word on it
        expect(w.sent.filter((m) => m.text.includes('train'))).toEqual([])
        expect([a, b, c].map((t) => t.alone)).toEqual([undefined, undefined, undefined])
        expect(c.landing).toBeUndefined()
        // c fixes its change: it rides again, behind d (its train's head, queued first) while e's gate runs
        sh('git rm -q bad.txt && git commit -qm "c drops bad.txt"', c.worktree!)
        const more = async (title: string, file: string) => {
          const t = w.engine.add({ project: space, title, desc: `Add ${file}.`, by: 'test' })
          mine.push(t.id)
          await until(() => !!t.worktree)
          writeFileSync(join(t.worktree!, file), `${file}\n`)
          sh(`git add -A && git commit -qm "add ${file}"`, t.worktree!)
          await w.engine.done(t.id, `Added ${file}.`)
          w.agentIs(`${t.id}/Agent`, 'idle')
          return t
        }
        const e = await more('Task 5', '5.txt')
        const d = await more('Task 6', '6.txt')
        go(d)
        const runE = w.engine.merge(e.id, { self: true })
        await until(() => e.landing?.step === 'gate')
        const runD = w.engine.merge(d.id, { self: true })
        const runC = w.engine.merge(c.id, { self: true })
        go(e)
        const [re, rd, rc2] = await Promise.all([runE, runD, runC])
        expect([re.ok, rd.ok, rc2.ok]).toEqual([true, true, true])
        expect(rc2.note).toBe(`it went in with ${d.id}'s merge train`)
        expect(c.train).toBe(d.id)
        expect(ran()).toEqual([x.id, a.id, a.id, b.id, c.id, e.id, d.id])
        expect(sh(`git log -1 --format=%b ${c.squash}`, dir)).toContain(`Merge train: ${d.id}, ${c.id} (one merge gate run)`)
        expect(decisions()).toEqual([
          `shepherdr: ${a.id}'s merge train: ${a.id}, ${b.id}, ${c.id} (one gate run on ${heads()[1]}, main at ${short(dir, x.squash)})`,
          `shepherdr: ${a.id}'s merge train refused (exit 1): each goes alone once`,
          `shepherdr: ${b.id}'s merge goes alone (its turn alone after a refused train)`,
          `shepherdr: ${c.id}'s merge goes alone (its turn alone after a refused train)`,
          `shepherdr: ${d.id}'s merge train: ${d.id}, ${c.id} (one gate run on ${heads()[6]}, main at ${short(dir, e.squash)})`,
          `shepherdr: ${d.id}'s merge train went in: ${d.id} ${short(dir, d.squash)}, ${c.id} ${short(dir, c.squash)}`,
        ])
      })

      test("a refused train's members keep their turn alone across a restart: the Shepherdr that comes back reads the marks", async () => {
        const { w, ts, go, ran } = await train('train-mark', 4, '3', REFUSE_BAD)
        const [x, a, b, c] = ts
        writeFileSync(join(c.worktree!, 'bad.txt'), 'bad\n')
        sh('git add -A && git commit -qm "c adds bad.txt"', c.worktree!)
        const runs = [w.engine.merge(x.id, { self: true })]
        await until(() => x.landing?.step === 'gate')
        for (const t of [a, b, c]) runs.push(w.engine.merge(t.id, { self: true }))
        go(x)
        // a's turn alone waits for its go: until then the three are marked, a in its turn and b and c in line
        await until(() => ran().length === 3 && !!b.alone && !!c.alone)
        const second = world()
        expect([a, b, c].map((t) => second.engine.task(t.id)!.alone)).toEqual([true, true, true])
        go(a)
        go(b)
        expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true, false])
        expect(ran()).toEqual([x.id, a.id, a.id, b.id, c.id])
        expect([a, b, c].map((t) => t.alone)).toEqual([undefined, undefined, undefined])
      })

      test("main moves while the train's gate runs: nothing lands as a train, the head goes alone, its riders wait in line with no mark", async () => {
        const { w, dir, ts, go, ran, heads } = await train('train-moved', 4, '3')
        const [g, x, a, b] = ts
        const runs = [w.engine.merge(g.id, { self: true })]
        await until(() => g.landing?.step === 'gate')
        runs.push(w.engine.merge(x.id, { self: true }), w.engine.merge(a.id, { self: true }), w.engine.merge(b.id, { self: true }))
        go(g)
        // x heads a train with a and b on its gate run; main moves on while that run goes on
        await until(() => x.landing?.cars === 3)
        const at = short(dir, 'main')
        sh('git commit -q --allow-empty -m "main moves on"', dir)
        go(x)
        // the stack is no longer main's next commit: x goes alone, and a and b wait in line, plain
        await until(() => x.landing?.cars === undefined && x.landing?.step === 'gate')
        expect(a.landing?.train).toBeUndefined()
        expect(b.landing?.train).toBeUndefined()
        expect([a, b, x].map((t) => t.alone)).toEqual([undefined, undefined, undefined])
        go(a)
        expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true, true])
        // g, then x's train run and its own alone run, then a's train with b
        expect(ran()).toEqual([g.id, x.id, x.id, a.id])
        expect(sh(`git log -1 --format=%b ${x.squash}`, dir)).not.toContain('Merge train:')
        expect(sh(`git log -1 --format=%b ${a.squash}`, dir)).toContain(`Merge train: ${a.id}, ${b.id} (one merge gate run)`)
        expect(b.train).toBe(a.id)
        expect(decisions()).toEqual([
          `shepherdr: ${x.id}'s merge train: ${x.id}, ${a.id}, ${b.id} (one gate run on ${heads()[1]}, main at ${at})`,
          `shepherdr: ${x.id}'s merge train: main moved while its gate ran: ${x.id} goes alone`,
          `shepherdr: ${a.id}'s merge train: ${a.id}, ${b.id} (one gate run on ${heads()[3]}, main at ${short(dir, x.squash)})`,
          `shepherdr: ${a.id}'s merge train went in: ${a.id} ${short(dir, a.squash)}, ${b.id} ${short(dir, b.squash)}`,
        ])
      })

      test('a marked task whose turn a restart cut short keeps the mark: its next merge goes alone, behind the train it could ride', async () => {
        const { w, dir, ts, go, ran, heads } = await train('train-cut', 4, '3')
        const [g, x, a, b] = ts
        const runs = [w.engine.merge(g.id, { self: true })]
        await until(() => g.landing?.step === 'gate')
        // x was marked by a refused train; a restart cut its turn alone short (its gate never ended, nothing left running)
        x.alone = true
        x.landing = { step: 'gate', at: Date.now() }
        x.gateRun = { pid: 999_999_999, log: '/nonexistent/log', exit: '/nonexistent/exit', at: Date.now(), head: 'x', tip: 'y' }
        w.engine.resumeMerges()
        expect(x.landing).toBeUndefined()
        expect(x.alone).toBe(true)
        // a and b wait behind g, x last in line: a rides with b, while x, marked, waits for its own turn alone
        runs.push(w.engine.merge(a.id, { self: true }), w.engine.merge(b.id, { self: true }), w.engine.merge(x.id, { self: true }))
        expect(w.engine.subOf(x)).toBe(`Waiting for the merge gate (${g.id}'s runs)`)
        go(g)
        await until(() => a.landing?.cars === 2)
        expect(w.engine.subOf(b)).toBe(`Going in with ${a.id}'s merge train`)
        expect(w.engine.subOf(x)).toBe(`Waiting for the merge gate (${a.id}'s runs)`)
        go(a)
        // x's turn: a gate of its own, no train
        await until(() => x.landing?.step === 'gate')
        expect(x.landing!.cars).toBeUndefined()
        go(x)
        expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true, true])
        expect(ran()).toEqual([g.id, a.id, x.id])
        expect(x.alone).toBeUndefined()
        expect(b.train).toBe(a.id)
        expect(x.train).toBeUndefined()
        expect(decisions()).toEqual([
          `shepherdr: ${a.id}'s merge train: ${a.id}, ${b.id} (one gate run on ${heads()[1]}, main at ${short(dir, g.squash)}). Left out: ${x.id} is marked alone (its turn after a refused train)`,
          `shepherdr: ${a.id}'s merge train went in: ${a.id} ${short(dir, a.squash)}, ${b.id} ${short(dir, b.squash)}`,
          `shepherdr: ${x.id}'s merge goes alone (its turn alone after a refused train)`,
        ])
      })

      test("a rider whose merge passes its deadline while it rides hears it goes in with the train's gate", async () => {
        const { w, ts, go, ran } = await train('train-late', 4, '3')
        const [x, a, b, c] = ts
        const runs = [w.engine.merge(x.id, { self: true })]
        await until(() => x.landing?.step === 'gate')
        runs.push(w.engine.merge(a.id, { self: true }), w.engine.merge(b.id, { self: true }), w.engine.merge(c.id, { self: true }))
        go(x)
        // a's train takes b and c along: their mark is on, and a's gate runs
        await until(() => b.landing?.train === a.id && a.landing?.cars === 3)
        expect(w.engine.subOf(b)).toBe(`Going in with ${a.id}'s merge train`)
        // b asked again, its deadline short: by then it rides, and says so (its first merge still waits for the same one)
        w.engine.mergeDeadline = 100
        const late = await w.engine.merge(b.id, { self: true })
        w.engine.mergeDeadline = 30_000
        expect(late.ok).toBe(false)
        expect(late.error).toContain(`${b.id}'s merge goes in with ${a.id}'s merge train (its gate runs)`)
        expect(late.error).not.toContain('waits in line')
        go(a)
        expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true, true])
        expect(ran()).toEqual([x.id, a.id])
      })

      test("a restart while the train's gate runs: the head re-attaches to its run, the riders resume in line, and the train lands", async () => {
        const { w, dir, ts, go, ran } = await train('train-restart', 3, '3')
        const [a, b, c] = ts
        const space = w.engine.view(a).place.split(':').pop()!
        // the train's stack, built as the engine builds it: each rider's squash commit on the one before, dated as main's tip
        const at = sh('git rev-parse main', dir)
        const date = sh('git log -1 --format=%cI main', dir)
        let top = at
        for (const x of [a, b, c]) {
          const tree = sh(`git merge-tree --write-tree ${top} ${x.branch}`, dir).split('\n')[0]
          top = sh(`GIT_AUTHOR_DATE='${date}' GIT_COMMITTER_DATE='${date}' git commit-tree ${tree} -p ${top} -m '${x.id}: ${x.title}'`, dir)
        }
        // as a restart leaves it: a's worktree at the top of the stack, its gate going on by itself, and b and c in line
        // with the mark of the train they ride
        sh(`git checkout -q --detach ${top}`, a.worktree!)
        a.landing = { step: 'gate', at: 1, cars: 3 }
        a.gateRun = await gate(w.settings.get('merge.gate', space), a.worktree!, { SHEPHERDR_TASK: a.id, SHEPHERDR_BASE: 'main' }, join(process.env.SHEPHERDR_HOME!, 'gates'), a.id, {
          head: top,
          tip: at,
        })
        b.landing = { step: 'queue', at: 2, behind: a.id, gate: true, train: a.id }
        c.landing = { step: 'queue', at: 3, behind: a.id, gate: true, train: a.id }
        await until(() => ran().length === 1, 20_000)
        // a while later, the stack is built again on the same tip: the same commits, so the same run is found again
        await Bun.sleep(1100)
        w.engine.resumeMerges()
        // a's merge is back: it has rebuilt the stack and its row says the train's gate runs
        await until(() => a.landing?.step === 'gate' && a.landing.at > 1, 20_000)
        expect(w.engine.subOf(a)).toBe('Running the merge gate (a train of 3)')
        expect(w.engine.subOf(b)).toBe(`Going in with ${a.id}'s merge train`)
        expect(b.landing?.train).toBe(a.id)
        expect(c.landing?.train).toBe(a.id)
        expect(ran()).toEqual([a.id])
        go(a)
        await until(() => ts.every((t) => w.sent.some((x) => x.key === `${t.id}/Agent` && x.text.includes('Your merge went in'))))
        // one gate run in all: the one a restart left, found again; the three go in on it, in line order
        expect(ran()).toEqual([a.id])
        expect(sh('git log --format=%s -n 4', dir).split('\n')).toEqual([`${c.id}: Task 3`, `${b.id}: Task 2`, `${a.id}: Task 1`, 'init'])
        for (const t of [a, b, c]) {
          expect(sh(`git log -1 --format=%b ${t.squash}`, dir)).toContain(`Merge train: ${a.id}, ${b.id}, ${c.id} (one merge gate run)`)
          expect(w.engine.statusOf(t)).toBe('done')
        }
        expect([b.train, c.train]).toEqual([a.id, a.id])
        expect(w.sent.filter((x) => x.key === `${b.id}/Agent`).at(-1)!.text).toContain(`it went in with ${a.id}'s merge train`)
      })

      test('a rider left out says why, each one: another gate, marked alone, its agent at work; the head then goes alone', async () => {
        const { w, ts, go } = await train('train-reasons', 5, '3')
        const [g, x, a, b, c] = ts
        a.set = { 'merge.gate': 'off' }
        b.alone = true
        w.agentIs(`${c.id}/Agent`, 'working')
        const runs = [w.engine.merge(g.id, { self: true })]
        await until(() => g.landing?.step === 'gate')
        runs.push(w.engine.merge(x.id, { self: true }), w.engine.merge(a.id, { self: true }), w.engine.merge(b.id, { self: true }), w.engine.merge(c.id, { self: true }))
        go(g)
        // x's turn: none of the three rides, so it goes alone, on its own gate
        await until(() => x.landing?.step === 'gate')
        expect(decisions()).toEqual([`shepherdr: ${x.id}'s merge goes alone: ${a.id} has a different merge gate; ${b.id} is marked alone (its turn after a refused train); ${c.id}'s agent is working`])
        go(x)
        // a has no gate of its own; b goes alone on its turn, c is at work and goes last
        await until(() => b.landing?.step === 'gate')
        go(b)
        await until(() => c.landing?.step === 'gate')
        go(c)
        expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true, true, true])
        expect(decisions().slice(1)).toEqual([`shepherdr: ${b.id}'s merge goes alone (its turn alone after a refused train)`])
      })

      test('a rider whose change conflicts on more than three files names three of them and how many more', async () => {
        const { w, ts, go } = await train('train-files', 3, '3')
        const [x, a, b] = ts
        for (const t of [a, b]) {
          for (const f of ['2.txt', '3.txt', '4.txt', '5.txt']) writeFileSync(join(t.worktree!, f), `${t.id}\n`)
          sh('git add -A && git commit -qm "four files"', t.worktree!)
        }
        const runs = [w.engine.merge(x.id, { self: true })]
        await until(() => x.landing?.step === 'gate')
        runs.push(w.engine.merge(a.id, { self: true }), w.engine.merge(b.id, { self: true }))
        go(x)
        // a's turn: b conflicts with it on four files, so a's train is a train of one: it goes alone
        await until(() => a.landing?.step === 'gate')
        go(a)
        const said = await Promise.all(runs)
        expect(said.map((r) => r.ok)).toEqual([true, true, false])
        expect(said[2].error).toContain('Conflict with main')
        expect(decisions()).toEqual([`shepherdr: ${a.id}'s merge goes alone: ${b.id} conflicts with those before it (2.txt, 3.txt, 4.txt and 1 more)`])
      })

      test('a rider whose change is already in the stack adds nothing to those before it, and is left out', async () => {
        const { w, dir, ts, go, heads } = await train('train-nothing', 4, '4')
        const [g, x, a, b] = ts
        // b makes x's change (2.txt, as x wrote it) and drops its own 4.txt: its change adds nothing on top of x's
        sh('git rm -q 4.txt && echo 2 > 2.txt && git add -A && git commit -qm "b takes 2.txt, drops 4.txt"', b.worktree!)
        const runs = [w.engine.merge(g.id, { self: true })]
        await until(() => g.landing?.step === 'gate')
        runs.push(w.engine.merge(x.id, { self: true }), w.engine.merge(a.id, { self: true }), w.engine.merge(b.id, { self: true }))
        go(g)
        await until(() => x.landing?.cars === 2)
        go(x)
        expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true, true])
        expect(decisions()).toEqual([
          `shepherdr: ${x.id}'s merge train: ${x.id}, ${a.id} (one gate run on ${heads()[1]}, main at ${short(dir, g.squash)}). Left out: ${b.id} adds nothing to those before it`,
          `shepherdr: ${x.id}'s merge train went in: ${x.id} ${short(dir, x.squash)}, ${a.id} ${short(dir, a.squash)}`,
        ])
      })

      test('a train takes as many as merge.train and says who waits for the next one', async () => {
        const { w, dir, ts, go, heads } = await train('train-full', 5, '3')
        const [g, x, a, b, c] = ts
        const runs = [w.engine.merge(g.id, { self: true })]
        await until(() => g.landing?.step === 'gate')
        runs.push(w.engine.merge(x.id, { self: true }), w.engine.merge(a.id, { self: true }), w.engine.merge(b.id, { self: true }), w.engine.merge(c.id, { self: true }))
        go(g)
        // x heads a train of three; c is in line behind it and goes alone, on its own turn
        await until(() => x.landing?.cars === 3)
        go(x)
        await until(() => c.landing?.step === 'gate')
        go(c)
        expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true, true, true])
        expect(decisions()).toEqual([
          `shepherdr: ${x.id}'s merge train: ${x.id}, ${a.id}, ${b.id} (one gate run on ${heads()[1]}, main at ${short(dir, g.squash)}). Left out: ${c.id} waits (the train is full at 3)`,
          `shepherdr: ${x.id}'s merge train went in: ${x.id} ${short(dir, x.squash)}, ${a.id} ${short(dir, a.squash)}, ${b.id} ${short(dir, b.squash)}`,
        ])
      })

      test('a turn with nobody else in line says nothing about the train', async () => {
        const { w, ts, go } = await train('train-quiet', 1, '3')
        go(ts[0])
        expect((await w.engine.merge(ts[0].id, { self: true })).ok).toBe(true)
        expect(decisions()).toEqual([])
      })

      test('a train whose gate is stopped before it ends says so: nothing went in, and its head goes alone', async () => {
        const { w, dir, ts, go, ran, heads } = await train('train-killed', 4, '3')
        const [g, x, a, b] = ts
        const runs = [w.engine.merge(g.id, { self: true })]
        await until(() => g.landing?.step === 'gate')
        runs.push(w.engine.merge(x.id, { self: true }), w.engine.merge(a.id, { self: true }), w.engine.merge(b.id, { self: true }))
        go(g)
        await until(() => !!x.gateRun?.pid)
        // the train's gate has logged the commit it runs on before it is killed: a kill that won the race left no line,
        // and every run after it moved up one in heads()
        await until(() => ran().length === 2)
        killGroup(x.gateRun!.pid)
        // its head goes on alone, on a gate of its own waiting for its go like any
        await until(() => x.landing?.step === 'gate' && x.landing.cars === undefined)
        go(x)
        await until(() => a.landing?.cars === 2)
        go(a)
        expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true, true])
        expect(decisions()).toEqual([
          `shepherdr: ${x.id}'s merge train: ${x.id}, ${a.id}, ${b.id} (one gate run on ${heads()[1]}, main at ${short(dir, g.squash)})`,
          `shepherdr: ${x.id}'s merge train stopped before its gate ended (a restart, or a kill): nothing went in`,
          `shepherdr: ${a.id}'s merge train: ${a.id}, ${b.id} (one gate run on ${heads()[3]}, main at ${short(dir, x.squash)})`,
          `shepherdr: ${a.id}'s merge train went in: ${a.id} ${short(dir, a.squash)}, ${b.id} ${short(dir, b.squash)}`,
        ])
      })
    })
  })
})
