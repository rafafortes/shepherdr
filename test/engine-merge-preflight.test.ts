// The space's merge pre-flight (merge.preflight, engine-world.ts): the cheap command a merge request runs at the door of the
// line, before the merge takes its place in it. What its exit code means, that it never holds the line or runs twice for one
// request, what it keeps (log, ledger line), and what a restart finds.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { sh, repo, world, until, started } from './engine-world.ts'
import { tmp } from './tmp.ts'
import { wtOf } from './train-world.ts'
import { processes } from '../server/procs.ts'

setDefaultTimeout(60_000)

/** a waiting command that ends by itself: when its folder goes, when the test process goes, or after 1200 turns (about a
 *  minute), rather than forking sleep for days. `go` is the file it waits for; `after` is what it does when it ends */
const waitFor = (go: string, dir: string, after = 'echo ok') =>
  `i=0; while [ ! -f ${go} ] && [ -d ${dir} ] && kill -0 ${process.pid} 2>/dev/null && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done; ${after}`

const gatesDir = () => join(process.env.SHEPHERDR_HOME ?? '', 'gates')
type Line = { kind: string; space: string; task: string; end: string; code: number | null; log: string; last: string; head: string; base: string; members?: string[] }
const ledger = (): Line[] =>
  existsSync(join(gatesDir(), 'ledger.jsonl'))
    ? readFileSync(join(gatesDir(), 'ledger.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : []

/** a task with a commit of its own, reported done, its space's gate set to `gate` and its pre-flight to `pre` */
async function gated(name: string, pre: string, gate = 'echo "Gate: green"') {
  const w = world()
  const dir = repo()
  const s = await started(w, dir, name)
  writeFileSync(join(wtOf(s.t), 'hello.txt'), 'hello\n')
  sh('git add -A && git commit -qm "add hello"', wtOf(s.t))
  expect(w.settings.set('merge.gate', gate, { space: s.p.name }).ok).toBe(true)
  expect(w.settings.set('merge.preflight', pre, { space: s.p.name }).ok).toBe(true)
  await w.engine.done(s.t.id, 'Added hello.txt.')
  return { w, dir, ...s }
}

describe('the merge pre-flight', () => {
  test('a failing one refuses the merge at once, told like a gate refusal: nothing merged, no place in line, its log and ledger line kept', async () => {
    const { PREFLIGHT_AGAIN } = await import('../server/live/engine/engine.ts')
    const marker = join(tmp('pre-refuse'), 'gate-ran')
    const pre = 'echo linting; echo "src/a.ts:1:1 unused import"; exit 3'
    const { w, dir, p, t } = await gated('pre-refuse', pre, `touch ${marker}; echo ok`)
    const main = sh('git rev-parse main', dir)
    const r = await w.engine.merge(t.id, { self: true })
    expect(r.ok).toBe(false)
    // the run is kept: its log in the gates folder (named as a pre-flight's), one ledger line saying it was one
    const [line, ...more] = ledger()
    expect(more).toEqual([])
    expect(line).toMatchObject({ kind: 'preflight', space: p.name, task: t.id, end: 'refused', code: 3, last: 'src/a.ts:1:1 unused import', base: main })
    expect(line.log).toMatch(new RegExp(`^${p.name}\\.${t.id}-\\d{13}-[0-9a-f]{8}\\.pre\\.log$`))
    expect(line.members).toBeUndefined()
    expect(readFileSync(join(gatesDir(), line.log), 'utf8')).toBe('linting\nsrc/a.ts:1:1 unused import\n')
    expect(r.error).toBe(
      `${t.id}'s merge pre-flight (${pre}) failed (exit 3): nothing was merged, and ${t.id} keeps no place in the merge line. Its output ends:\nlinting\nsrc/a.ts:1:1 unused import\nIts full log is kept at ${join(gatesDir(), line.log)}\n${PREFLIGHT_AGAIN}`,
    )
    // no gate ran, main is as it was, and the task is Ready again with its row saying why
    expect(existsSync(marker)).toBe(false)
    expect(sh('git rev-parse main', dir)).toBe(main)
    expect(t.merged).toBeFalsy()
    expect(t.landing).toBeUndefined()
    expect(w.engine.statusOf(t)).not.toBe('merging')
    expect(w.engine.subOf(t)).toBe('Refused by the pre-flight: src/a.ts:1:1 unused import')
    // fixed, it asks again: the pre-flight looks again, and the gate runs after it
    expect(w.settings.set('merge.preflight', 'echo fine', { space: p.name }).ok).toBe(true)
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    expect(t.mergeStop).toBeUndefined()
    expect(ledger().map((l) => [l.kind, l.end])).toEqual([
      ['preflight', 'refused'],
      ['preflight', 'passed'],
      ['gate', 'passed'],
    ])
    expect(existsSync(marker)).toBe(true)
  })

  test('a pass lets it queue as today: the gate runs after it, with the environment a gate gets and no SHEPHERDR_PREFLIGHT', async () => {
    const seen = join(tmp('pre-pass'), 'env')
    const pre = `echo "pre $SHEPHERDR_TASK $SHEPHERDR_BASE $SHEPHERDR_PREFLIGHT $(basename "$(pwd)")" >> ${seen}`
    const { w, dir, p, t } = await gated('pre-pass', pre, `echo "gate $SHEPHERDR_TASK $SHEPHERDR_BASE [\${SHEPHERDR_PREFLIGHT:-none}]" >> ${seen}; echo "Gate: green"`)
    const folder = basename(wtOf(t))
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    expect(readFileSync(seen, 'utf8').trim().split('\n')).toEqual([`pre ${t.id} main 1 ${folder}`, `gate ${t.id} main [none]`])
    expect(sh('git log -1 --format=%b', dir)).toBe('Added hello.txt.\n\nGate: green')
    // the pre-flight's log and the gate's are both in the gates folder, each with its own ledger line, the pre-flight first
    const lines = ledger()
    expect(lines.map((l) => [l.kind, l.space, l.task, l.end, l.code])).toEqual([
      ['preflight', p.name, t.id, 'passed', 0],
      ['gate', p.name, t.id, 'passed', 0],
    ])
    expect(readdirSync(gatesDir()).sort()).toEqual([...lines.map((l) => l.log), 'ledger.jsonl'].sort())
    expect(lines[0].log).toMatch(/\.pre\.log$/)
    expect(lines[1].log).not.toMatch(/\.pre\.log$/)
  })

  test('off, or no merge gate: it never runs, and the merge is as it was', async () => {
    const marker = join(tmp('pre-off'), 'ran')
    const { w, p, t } = await gated('pre-off', `touch ${marker}; exit 1`)
    // off
    expect(w.settings.set('merge.preflight', 'off', { space: p.name }).ok).toBe(true)
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    expect(ledger().map((l) => l.kind)).toEqual(['gate'])
    // no gate: it only ever looks ahead of one
    const w2 = world()
    const dir2 = repo()
    const s2 = await started(w2, dir2, 'pre-nogate')
    writeFileSync(join(wtOf(s2.t), 'hello.txt'), 'hello\n')
    sh('git add -A && git commit -qm "add hello"', wtOf(s2.t))
    expect(w2.settings.set('merge.preflight', `touch ${marker}; exit 1`, { space: s2.p.name }).ok).toBe(true)
    await w2.engine.done(s2.t.id, 'Added hello.txt.')
    expect((await w2.engine.merge(s2.t.id, { self: true })).ok).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  test("a task's own --set merge.preflight wins over its space's", async () => {
    const { w, t } = await gated('pre-own', 'echo fine')
    t.set = { 'merge.preflight': 'echo "own check says no"; exit 1' }
    const r = await w.engine.merge(t.id, { self: true })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('merge pre-flight (echo "own check says no"; exit 1) failed (exit 1)')
    t.set = { 'merge.preflight': 'off' }
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
  })

  test('it never holds the line: a merge asked for later and through its pre-flight lands first, and asked twice it runs once', async () => {
    const goDir = tmp('pre-line')
    const runs = join(goDir, 'runs')
    const pre = `echo "$SHEPHERDR_TASK" >> ${runs}; ${waitFor(`${goDir}/go-$SHEPHERDR_TASK`, goDir, 'echo ok')}`
    const { w, dir, p, t: a } = await gated('pre-line', pre)
    const b = w.engine.add({ project: p.name, title: 'Second', desc: 'Add b.txt.', by: 'test' })
    await until(() => !!b.worktree)
    writeFileSync(join(wtOf(b), 'b.txt'), 'b\n')
    sh('git add -A && git commit -qm "add b"', wtOf(b))
    await w.engine.done(b.id, 'Added b.txt.')
    const first = w.engine.merge(a.id, { self: true })
    await until(() => a.landing?.pre === true)
    expect(w.engine.statusOf(a)).toBe('merging')
    expect(w.engine.subOf(a)).toBe('Running the merge pre-flight')
    // asked again while it runs: the same request, never a second run beside it
    const again = w.engine.merge(a.id, { self: true })
    // b asks later, its pre-flight is through first, and a's, still running, holds nobody up: b lands, then a
    const second = w.engine.merge(b.id, { self: true })
    writeFileSync(join(goDir, `go-${b.id}`), 'go\n')
    expect((await second).ok).toBe(true)
    expect(a.landing?.pre).toBe(true)
    expect(sh('git log --format=%s -n 2', dir).split('\n')).toEqual([`${b.id}: Second`, 'init'])
    writeFileSync(join(goDir, `go-${a.id}`), 'go\n')
    expect((await first).ok).toBe(true)
    expect((await again).ok).toBe(true)
    expect(sh('git log --format=%s -n 3', dir).split('\n')).toEqual([`${a.id}: Say hello`, `${b.id}: Second`, 'init'])
    expect(readFileSync(runs, 'utf8').trim().split('\n').sort()).toEqual([a.id, b.id].sort())
    // a's row had no landing left over from it
    expect(a.landing).toBeUndefined()
  })

  test('one that runs too long is stopped and counts as a failure that says so', async () => {
    const { w, t } = await gated('pre-slow', 'sleep 5')
    w.engine.preflightTimeout = 1500
    const r = await w.engine.merge(t.id, { self: true })
    expect(r.ok).toBe(false)
    expect(r.error).toContain(`${t.id}'s merge pre-flight (sleep 5) didn't finish in 2 s: nothing was merged, and ${t.id} keeps no place in the merge line.`)
    expect(ledger()).toMatchObject([{ kind: 'preflight', end: 'refused', code: 124 }])
    expect(w.engine.subOf(t)).toBe('Refused by the pre-flight: it ran out of time')
  })

  test('a merge whose caller gave up waiting is told how it went, and while it runs it says what it is in', async () => {
    const goDir = tmp('pre-late')
    const { w, t, key } = await gated('pre-late', `${waitFor(join(goDir, 'go'), goDir, 'echo "lint: broken"; exit 1')}`)
    w.engine.mergeDeadline = 200
    const r = await w.engine.merge(t.id, { self: true })
    expect(r.error).toContain('is in its merge pre-flight, the cheap check before it takes its place in line (it queues once that passes)')
    writeFileSync(join(goDir, 'go'), 'go\n')
    await until(() => w.sent.some((x) => x.key === key && x.text.includes("Your merge didn't go in") && x.text.includes('merge pre-flight')))
    expect(t.landing).toBeUndefined()
  })

  test('a task closed while its pre-flight runs stops it: the merge says it was stopped, and its ledger line says so', async () => {
    const goDir = tmp('pre-close')
    const { w, t } = await gated('pre-close', waitFor(join(goDir, 'go'), goDir, 'echo ok'))
    const run = w.engine.merge(t.id, { self: true })
    // its log is made as it starts (the shell opens it first)
    await until(() => existsSync(gatesDir()) && readdirSync(gatesDir()).some((f) => f.endsWith('.pre.log')), 30_000)
    await w.engine.close(t.id)
    const r = await run
    expect(r.ok).toBe(false)
    expect(r.error).toContain('was stopped before it ended (a restart, or a kill): nothing was merged')
    expect(ledger()).toMatchObject([{ kind: 'preflight', end: 'stopped', code: null }])
    await until(() => !processes().some((p) => p.cmd.includes('.pre.exit')), 30_000)
  })

  test("the sweep a start makes for orphans never ends a pre-flight of this Shepherdr's own, only one a restart left behind", async () => {
    const goDir = tmp('pre-sweep')
    const { w, t } = await gated('pre-sweep', waitFor(join(goDir, 'go'), goDir, 'echo ok'))
    const run = w.engine.merge(t.id, { self: true })
    await until(() => t.landing?.pre === true && existsSync(gatesDir()) && readdirSync(gatesDir()).some((f) => f.endsWith('.pre.log')), 30_000)
    // a restart's sweep, here, while it runs
    w.engine.sweepGates()
    await Bun.sleep(300)
    writeFileSync(join(goDir, 'go'), 'go\n')
    expect((await run).ok).toBe(true)
    expect(ledger().map((l) => [l.kind, l.end])).toEqual([
      ['preflight', 'passed'],
      ['gate', 'passed'],
    ])
  })

  test('one that cannot even start never keeps a merge out of the line: it is logged, and the gate, which needs the same, speaks', async () => {
    const log: string[] = []
    const stderr = console.error
    console.error = (m: unknown) => void log.push(String(m))
    try {
      const { w, t } = await gated('pre-broken', 'echo fine')
      // no folder for the run's files: a file stands where the gates folder would be
      writeFileSync(gatesDir(), 'in the way\n')
      const r = await w.engine.merge(t.id, { self: true })
      expect(r.ok).toBe(false)
      expect(r.error).toContain(`Can't merge ${t.id}`)
      expect(log.filter((l) => l.startsWith(`shepherdr: ${t.id}'s merge pre-flight could not run`))).toHaveLength(1)
      expect(t.landing).toBeUndefined()
    } finally {
      console.error = stderr
    }
  })

  describe('after a restart', () => {
    test('a merge that waited in line goes on without it: it passed before it took its place', async () => {
      const marker = join(tmp('pre-resume'), 'ran')
      const { w, dir, t } = await gated('pre-resume', `touch ${marker}; exit 1`)
      t.landing = { step: 'queue', at: Date.now(), behind: 'GONE-1', gate: true }
      w.engine.resumeMerges()
      await until(() => w.engine.statusOf(t) === 'done')
      expect(existsSync(marker)).toBe(false)
      expect(sh('git log -1 --format=%s', dir)).toBe(`${t.id}: Say hello`)
      expect(ledger().map((l) => l.kind)).toEqual(['gate'])
    })

    test('a pre-flight the restart cut short left no place in line and no mark: its agent is told to merge again, which runs it again', async () => {
      const count = join(tmp('pre-cut'), 'runs')
      const { w, dir, t, key } = await gated('pre-cut', `echo run >> ${count}`)
      // as a restart leaves it: its pre-flight was running, nothing waits for it any more
      t.landing = { step: 'merge', at: Date.now(), pre: true }
      w.engine.resumeMerges()
      expect(t.landing).toBeUndefined()
      expect([t.alone, t.bisect, t.gateRun]).toEqual([undefined, undefined, undefined])
      expect(w.engine.subOf(t)).toBe('Merge interrupted by a restart: run shepherdr merge again')
      expect(w.sent.filter((x) => x.key === key).at(-1)?.text ?? '').toContain(`Shepherdr restarted while your merge ran: nothing was merged. Run shepherdr merge ${t.id} again.`)
      expect(existsSync(count)).toBe(false)
      // the merge it is told to ask again looks again, once, and goes in
      expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
      expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1)
      expect(sh('git log -1 --format=%s', dir)).toBe(`${t.id}: Say hello`)
    })
  })
})
