// A line of merges for the merge train's tests that search a refused train by halves (engine-merge-train-bisect*.test.ts):
// real git, real gate commands, the engine's own world (engine-world.ts). The first task of a line only holds it (its gate
// waits for its go); the members behind it are the train, and the gate refuses every stack that holds a member's bad file.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sh, repo, world, until, started } from './engine-world.ts'
import { tmp } from './tmp.ts'

/** a waiting gate command that ends by itself: when its folder goes, when the test process that started it goes (even
 *  one killed without cleanup), or after 1200 turns (about a minute), rather than forking sleep for days (LEAD-01) */
const waitFor = (go: string, dir: string, after = 'echo ok') =>
  `i=0; while [ ! -f ${go} ] && [ -d ${dir} ] && kill -0 ${process.pid} 2>/dev/null && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done; ${after}`

/**
 * The server's log (console.error) while each test of the file runs, kept out of the test output: the lines about a train's
 * decisions are what the tests read, those of the tasks named (`decisions`), in the order they were logged.
 */
export function trainLog() {
  let log: string[] = []
  const stderr = console.error
  beforeEach(() => {
    log = []
    console.error = (m: unknown) => void log.push(String(m))
  })
  afterEach(() => {
    console.error = stderr
  })
  // a refused train names the log of its run, which has a random name: `log <file>` stands for it
  return {
    /** every line the server logged, as it was */
    lines: () => log,
    decisions: (ids: string[]) =>
      log.filter((l) => /merge (train|goes alone)/.test(l) && ids.some((id) => l.startsWith(`shepherdr: ${id}'s `))).map((l) => l.replace(/; log \S+\.log\)/, '; log <file>)')),
  }
}

/** a task's worktree, which every task of these lines has once its folder is made */
export const wtOf = (t: { id: string; worktree?: string }) => {
  if (!t.worktree) throw new Error(`${t.id} got no worktree`)
  return t.worktree
}

/** the gate refuses (exit 1, saying which file) while a member's bad file is in the tree it checks */
const REFUSE_BAD = 'for f in bad-*.txt; do [ -e "$f" ] && { echo "$f is not wanted"; exit 1; }; done; '

/** the gate refuses while the stack adds more than `n` files to main: a fault that only a long stack has */
export const REFUSE_OVER = (n: number) => `[ "$(git diff --name-only main HEAD | wc -l)" -gt ${n} ] && { echo "too many files for one run"; exit 1; }; `

/**
 * A repo's merge line: a blocker (its gate waits for go-<its id>), then `members` tasks, each with a file of its own
 * (`<i>.txt`) committed and reported done, its agent at rest. The space's gate logs each run (`ran()`: the head task of
 * each run, in order, and the commit it ran on), runs `gate` (a refusal), then waits for go-<the run's head> and is green;
 * `merge.train` is `k`. `bad` are the members (1-based) whose change carries a bad file. With `pre`, the space's pre-flight
 * (merge.preflight) logs each run (`pre()`: its task, the ref it ran on, the commit) and then runs `pre`.
 */
export async function trainWorld(name: string, members: number, k: string, bad: number[] = [], gate = REFUSE_BAD, pre?: string) {
  const w = world()
  const dir = repo()
  const gates = tmp(`${name}-go`)
  const a = await started(w, dir, name, 'Blocker', 'Hold the line.')
  const space = a.p.name
  const runs = join(gates, 'runs')
  const waiting = waitFor(`${gates}/go-$SHEPHERDR_TASK`, gates, 'echo "Gate: green on $(git rev-parse --short HEAD^{tree})"')
  expect(w.settings.set('merge.gate', `echo "$SHEPHERDR_TASK $(git rev-parse --short=7 HEAD)" >> ${runs}; ${gate}${waiting}`, { space }).ok).toBe(true)
  expect(w.settings.set('merge.train', k, { space }).ok).toBe(true)
  const pres = join(gates, 'pre-runs')
  if (pre) expect(w.settings.set('merge.preflight', `echo "$SHEPHERDR_TASK $(git rev-parse --abbrev-ref HEAD) $(git rev-parse --short=7 HEAD)" >> ${pres}; ${pre}`, { space }).ok).toBe(true)
  const ts = [a.t]
  for (let i = 1; i <= members; i++) ts.push(w.engine.add({ project: space, title: `Task ${i}`, desc: `Add ${i}.txt.`, by: 'test' }))
  await until(() => ts.every((t) => !!t.worktree))
  for (const [i, t] of ts.entries()) {
    writeFileSync(join(wtOf(t), i ? `${i}.txt` : 'blocker.txt'), `${i}\n`)
    if (bad.includes(i)) writeFileSync(join(wtOf(t), `bad-${i}.txt`), 'bad\n')
    sh(`git add -A && git commit -qm "add ${i}"`, wtOf(t))
    await w.engine.done(t.id, `Added ${i}.txt.`)
    w.agentIs(`${t.id}/Agent`, 'idle')
  }
  const [blocker, ...riders] = ts
  const go = (t: { id: string }) => writeFileSync(join(gates, `go-${t.id}`), 'go\n')
  const logged = () =>
    existsSync(runs)
      ? readFileSync(runs, 'utf8')
          .trim()
          .split('\n')
          .map((x) => x.split(' '))
      : []
  /** one more task of the space, with a file of its own, reported done and its agent at rest */
  const more = async (title: string, file: string) => {
    const t = w.engine.add({ project: space, title, desc: `Add ${file}.`, by: 'test' })
    await until(() => !!t.worktree)
    writeFileSync(join(wtOf(t), file), `${file}\n`)
    sh(`git add -A && git commit -qm "add ${file}"`, wtOf(t))
    await w.engine.done(t.id, `Added ${file}.`)
    w.agentIs(`${t.id}/Agent`, 'idle')
    return t
  }
  return {
    w,
    dir,
    ts,
    more,
    blocker,
    riders,
    space,
    gates,
    go,
    /** each pre-flight run so far: the task it ran for, the ref its worktree was on (HEAD when detached at a stack) and the commit */
    pre: () =>
      existsSync(pres)
        ? readFileSync(pres, 'utf8')
            .trim()
            .split('\n')
            .map((x) => x.split(' '))
        : [],
    /** the head task of each gate run so far, the blocker's included */
    ran: () => logged().map(([task]) => task),
    /** the commit each gate run was on (short) */
    heads: () => logged().map(([, head]) => head),
    /** every member asks to merge, in line order behind the blocker, and every gate may end: the answers, in order */
    async merged(more: { id: string }[] = []) {
      const asked = [w.engine.merge(blocker.id, { self: true })]
      await until(() => blocker.landing?.step === 'gate')
      for (const t of riders) asked.push(w.engine.merge(t.id, { self: true }))
      for (const t of more) asked.push(w.engine.merge(t.id, { self: true }))
      for (const t of [...ts, ...more]) go(t)
      return Promise.all(asked)
    },
  }
}

/** [members, faulty positions (1-based), gate runs for the members, gate runs the old way: one for the train, one for each] */
type Row = [number, number[], number, number]

/**
 * One test per row: a train of `n` (merge.train n) with the faulty members' changes carrying a bad file. The ones that
 * are fine go in in line order, each as its own commit, only the faulty are told (with the gate's lines), no mark is left
 * on anyone, and the gate ran as many times as the row says: before, a refused train cost n + 1.
 */
export function bisectRows(rows: Row[]) {
  for (const [n, bad, runs, before] of rows) {
    test(`${n} merges, ${bad.length > 1 ? 'faults' : 'fault'} at ${bad.join(' and ')}: ${runs} gate runs, ${before} before; the ones that are fine go in in line order and only the faulty are told`, async () => {
      const { w, dir, ts, riders, ran, merged } = await trainWorld(`bisect-${n}-${bad.join('')}`, n, String(n), bad)
      const said = await merged()
      // the blocker, then the members: the faulty ones are refused, each told with the gate's lines
      expect(said[0].ok).toBe(true)
      riders.forEach((t, i) => {
        const r = said[i + 1]
        expect(r.ok).toBe(!bad.includes(i + 1))
        if (r.ok) expect(w.engine.statusOf(t)).toBe('done')
        else {
          expect(r.error).toContain(`${t.id}'s merge gate`)
          expect(r.error).toContain(`bad-${i + 1}.txt is not wanted`)
        }
      })
      // the gate ran the blocker, then `runs` times for the members
      expect(ran().length - 1).toBe(runs)
      if (bad.length === 1) expect(runs).toBeLessThanOrEqual(before)
      // what went in is in line order, each as its own commit
      const fine = riders.filter((_, i) => !bad.includes(i + 1))
      expect(sh(`git log --format=%s -n ${fine.length + 2}`, dir).split('\n')).toEqual([...fine.map((t) => `${t.id}: ${t.title}`).reverse(), `${ts[0].id}: ${ts[0].title}`, 'init'])
      // nobody but the faulty heard of a refusal, and no mark is left on anyone
      for (const [i, t] of riders.entries()) if (!bad.includes(i + 1)) expect(w.sent.filter((m) => m.key.startsWith(`${t.id}/`) && /train|refus/i.test(m.text))).toEqual([])
      for (const t of ts) expect([t.alone, t.bisect, t.landing]).toEqual([undefined, undefined, undefined])
    })
  }
}
