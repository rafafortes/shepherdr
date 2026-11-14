// First in line: a task the human starts now (task start, the ⋯ menu's Start now and Start now with…) or a coordinator
// marks (task priority, task add --priority, for a fix of a red main) goes ahead of the other held tasks and past the
// machine's load, pressure and spacing, never past its slots. Started now, it no longer waits for the tasks it was queued
// after, and may run on a worker picked for it alone. On a real git repo (engine-world.ts).
import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { repo, started, until, world } from './engine-world.ts'

/** a world with its machine's limits as given; `busy` stands for its load or pressure past their start limit */
function fresh(limits: Record<string, string> = {}) {
  const w = world()
  w.engine.tasks.splice(0)
  for (const k of ['machine.maxTasks', 'machine.startLoad', 'machine.startMemory', 'machine.startEvery', 'machine.startPressure']) w.settings.set(k, null)
  for (const [k, v] of Object.entries(limits)) expect(w.settings.set(k, v).ok).toBe(true)
  let m: { busy?: 'cpu' | 'memory'; herdr: boolean } = { herdr: true }
  w.engine.machine = () => m
  const machine = (x: typeof m) => (m = x)
  const startedOf = (id: string) => w.started.some((s) => s.key === `${id}/Agent`)
  return { w, machine, startedOf }
}

describe('first in line', () => {
  test("a coordinator's mark goes past the machine's load and ahead of older held tasks; never past herdr not answering", async () => {
    const { w, machine, startedOf } = fresh()
    const p = await w.places.add(repo(), 'prio-load')
    machine({ busy: 'cpu', herdr: true })
    const a = w.engine.add({ project: p.name, title: 'Older', desc: 'Add a.txt.', by: 'test' })
    expect(w.engine.subOf(a)).toBe('Waiting for the machine')
    // the fix of a red main: it starts at once, load or not
    const fix = w.engine.add({ project: p.name, title: 'Fix main', desc: 'Fix the red test.', by: 'test', priority: true })
    await until(() => startedOf(fix.id))
    expect(startedOf(a.id)).toBe(false)
    // herdr not answering holds even one first in line
    machine({ herdr: false })
    const next = w.engine.add({ project: p.name, title: 'Fix more', desc: 'Fix another.', by: 'test', priority: true })
    expect(next.held?.why).toBe('machine')
    expect(w.engine.subOf(next)).toBe('First in line · Waiting for the machine')
    // the held ones in line: the marked first, then by age
    expect(w.engine.heldTasks().map((t) => t.id)).toEqual([next.id, a.id])
  })

  test('within the slots: one first in line waits for the next free one, and takes it ahead of the older ones and the spacing', async () => {
    const { w, startedOf } = fresh({ 'machine.maxTasks': '1', 'machine.startEvery': '10 min' })
    const p = await w.places.add(repo(), 'prio-slots')
    const busy = w.engine.add({ project: p.name, title: 'At work', desc: 'Add a.txt.', by: 'test' })
    await until(() => startedOf(busy.id))
    w.brief(`${busy.id}/Agent`)
    const old = w.engine.add({ project: p.name, title: 'Older', desc: 'Add b.txt.', by: 'test' })
    const fix = w.engine.add({ project: p.name, title: 'Fix main', desc: 'Fix it.', by: 'test' })
    expect(w.engine.setPriority(fix.id, true).priority).toBe(true)
    expect([old.held?.why, fix.held?.why]).toEqual(['slots', 'slots'])
    expect(w.engine.subOf(fix)).toBe('First in line · Waiting for a free slot')
    // a start a moment ago would hold the next one for ten minutes: not one first in line
    w.engine.noteStart(Date.now())
    await w.engine.done(busy.id, 'Nothing to change.')
    w.agentIs(`${busy.id}/Agent`, 'idle')
    await until(() => startedOf(fix.id))
    expect(startedOf(old.id)).toBe(false)
    // and off again: back in line by its age
    expect(w.engine.setPriority(old.id, false).priority).toBeUndefined()
  })

  test("past the cut-off tasks' way back, not past every model of its space out", async () => {
    const { w, startedOf } = fresh()
    const p = await w.places.add(repo(), 'prio-resume')
    let wait: 'resume' | 'models' = 'resume'
    w.engine.startsWait = () => wait
    const plain = w.engine.add({ project: p.name, title: 'New', desc: 'Add a.txt.', by: 'test' })
    expect(plain.held?.why).toBe('resume')
    const fix = w.engine.add({ project: p.name, title: 'Fix main', desc: 'Fix it.', by: 'test', priority: true })
    await until(() => startedOf(fix.id))
    wait = 'models'
    const again = w.engine.add({ project: p.name, title: 'Fix more', desc: 'Fix it.', by: 'test', priority: true })
    expect(again.held?.why).toBe('models')
  })
})

describe('started now by you', () => {
  test('one queued after others starts now on its brief, first in line, and no longer waits for them', async () => {
    const { w, machine, startedOf } = fresh()
    const a = await started(w, repo(), 'now-after', 'First', 'Add a.txt.')
    machine({ busy: 'cpu', herdr: true })
    const b = w.engine.add({ project: a.p.name, title: 'Second', desc: 'Add b.txt.', by: 'test', after: [a.t.id] })
    expect(await w.engine.startNow(b.id)).toEqual({})
    await until(() => startedOf(b.id))
    expect([b.after, b.priority]).toEqual([undefined, true])
    expect(w.posted.find((x) => x.key === `${b.id}/Agent` && x.id.startsWith('go:'))?.card?.text).toBe(`started: you started it now; it no longer waits for ${a.t.id}`)
  })

  test('on a worker picked for it alone: its agent starts on that CLI, model and effort; Settings are untouched', async () => {
    const { w, startedOf } = fresh()
    const p = await w.places.add(repo(), 'now-worker')
    w.engine.machine = () => ({ busy: 'cpu', herdr: true })
    const t = w.engine.add({ project: p.name, title: 'Use the Spark', desc: 'Add s.txt.', by: 'test' })
    const on = { kind: 'pi', model: 'spark/qwen', effort: 'low' }
    await w.engine.startNow(t.id, on)
    await until(() => startedOf(t.id))
    expect(w.started.find((s) => s.key === `${t.id}/Agent`)).toMatchObject({ kind: 'pi' })
    expect(t.agent).toEqual(on)
    expect(w.settings.harness('task', p.name).kind).not.toBe('pi')
    expect(w.posted.find((x) => x.id.startsWith(`go:${t.id}`))?.card?.text).toContain('you started it now on')
  })

  test('no slot free: it is first in line and starts at the next free one; a time it waited for is gone', async () => {
    const { w, startedOf } = fresh({ 'machine.maxTasks': '1' })
    const a = await started(w, repo(), 'now-full', 'At work', 'Add a.txt.')
    w.brief(a.key)
    const t = w.engine.add({ project: a.p.name, title: 'Tomorrow', desc: 'Add t.txt.', by: 'test', at: Date.now() + 86_400_000 })
    expect(await w.engine.startNow(t.id)).toEqual({ held: 'slots' })
    expect([t.scheduled, t.priority]).toEqual([undefined, true])
    expect(w.engine.subOf(t)).toBe('First in line · Waiting for a free slot')
    await w.engine.done(a.t.id, 'Nothing to change.')
    w.agentIs(a.key, 'idle')
    await until(() => startedOf(t.id))
  })

  test('one whose agent waits in its worktree gets its go, on the worker picked first where it is another', async () => {
    const { w, startedOf } = fresh()
    w.engine.installed = () => true
    const a = await started(w, repo(), 'now-live', 'First', 'Add a.txt.')
    const b = w.engine.add({ project: a.p.name, title: 'Second', desc: 'Add b.txt.', by: 'test', after: [a.t.id] })
    const bkey = `${b.id}/Agent`
    // as an older Shepherdr left it: its agent at the brief, in its worktree, waiting for the go
    await w.engine.tell(b.id, 'Read the brief.')
    await until(() => startedOf(b.id) && !!b.worktree)
    w.agentIs(bkey, 'idle')
    const starts = w.started.filter((s) => s.key === bkey).length
    await w.engine.startNow(b.id, { kind: 'codex' })
    await until(() => w.sent.some((s) => s.key === bkey && s.text.includes('<go>')))
    expect(w.started.filter((s) => s.key === bkey).length).toBe(starts + 1)
    expect(w.started.filter((s) => s.key === bkey).at(-1)).toMatchObject({ kind: 'codex' })
    expect(w.sent.find((s) => s.key === bkey && s.text.includes('<go>'))!.text).toContain(`Go: you no longer wait for ${a.t.id}, start now.`)
    // on what it runs already: the go alone
    const c = w.engine.add({ project: a.p.name, title: 'Third', desc: 'Add c.txt.', by: 'test' })
    await until(() => startedOf(c.id))
    w.engine.todo(c.id)
    w.agentIs(`${c.id}/Agent`, 'idle')
    const was = w.started.filter((s) => s.key === `${c.id}/Agent`).length
    await w.engine.startNow(c.id)
    await until(() => w.sent.some((s) => s.key === `${c.id}/Agent` && s.text.includes('Go: you were started now')))
    expect(w.started.filter((s) => s.key === `${c.id}/Agent`).length).toBe(was)
  })

  test('refused for one at work, waiting on you, done, or not there', async () => {
    const { w } = fresh()
    const a = await started(w, repo(), 'now-refused', 'At work', 'Add a.txt.')
    w.brief(a.key)
    await expect(w.engine.startNow(a.t.id)).rejects.toThrow(`${a.t.id} isn't waiting to start`)
    await expect(w.engine.startNow(a.t.id, { kind: 'pi' })).rejects.toThrow('Restart agent… changes what it runs on')
    await w.engine.done(a.t.id, 'Nothing to change.')
    w.agentIs(a.key, 'idle')
    await until(() => w.engine.statusOf(a.t) === 'done')
    await expect(w.engine.startNow(a.t.id)).rejects.toThrow('is Done already')
    expect(() => w.engine.setPriority(a.t.id, true)).toThrow('is Done already')
    await expect(w.engine.startNow('NOPE-1')).rejects.toThrow('No task NOPE-1')
  })
})

describe('started with a worker of your choosing, in its turn', () => {
  test('Start with…: the worker is set for it alone and it stays in line; its turn starts it on that one', async () => {
    const { w, startedOf } = fresh({ 'machine.maxTasks': '1' })
    const a = await started(w, repo(), 'with-later', 'At work', 'Add a.txt.')
    w.brief(a.key)
    const t = w.engine.add({ project: a.p.name, title: 'On the Spark', desc: 'Add s.txt.', by: 'test' })
    expect(t.held?.why).toBe('slots')
    w.engine.setWorker(t.id, { kind: 'pi', model: 'spark/qwen' })
    expect([t.agent, t.held?.why, t.priority]).toEqual([{ kind: 'pi', model: 'spark/qwen' }, 'slots', undefined])
    expect(w.posted.some((x) => x.card?.text === 'Starts on pi (spark/qwen) when its turn comes')).toBe(true)
    await w.engine.done(a.t.id, 'Nothing to change.')
    w.agentIs(a.key, 'idle')
    await until(() => startedOf(t.id))
    expect(w.started.find((s) => s.key === `${t.id}/Agent`)).toMatchObject({ kind: 'pi' })
    // a scheduled one keeps it for its time; one at work is refused
    const later = w.engine.add({ project: a.p.name, title: 'Tomorrow', desc: 'Add t.txt.', by: 'test', at: Date.now() + 86_400_000 })
    w.engine.setWorker(later.id, { kind: 'codex' })
    expect(later.scheduled?.agent).toEqual({ kind: 'codex' })
    w.brief(`${t.id}/Agent`)
    expect(() => w.engine.setWorker(t.id, { kind: 'codex' })).toThrow(`${t.id} isn't waiting to start`)
  })
})


describe("started with a worker of your choosing while its agent's record, gone from its worktree, is on another", () => {
  // every CLI, from one to the next: the record's model is blocked under the limits (as WEB-126's Qwen was full), and the
  // pick is another CLI or another model of the same one
  const PAIRS: { from: { kind: string; model: string }; block: string; to: { kind: string; model?: string } }[] = [
    { from: { kind: 'pi', model: 'amd-tokenlab/Qwen3.8-27B' }, block: 'pi.amd-tokenlab', to: { kind: 'pi', model: 'openrouter/thinkingmachines/inkling-2-small:free' } },
    { from: { kind: 'claude', model: 'claude-opus-5-5' }, block: 'claude', to: { kind: 'codex' } },
    { from: { kind: 'codex', model: 'gpt-6-sol' }, block: 'codex', to: { kind: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' } },
    { from: { kind: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' }, block: 'opencode.opencode-go', to: { kind: 'agy', model: 'gemini-4-argon' } },
    { from: { kind: 'agy', model: 'gemini-4-argon' }, block: 'agy', to: { kind: 'claude', model: 'claude-sonnet-5-5' } },
  ]
  for (const x of PAIRS)
    for (const away of [false, true])
    test(`Start now with ${x.to.kind}${x.to.model ? ` (${x.to.model})` : ''} over a gone ${x.from.kind} agent${away ? ', its worktree put away' : ''}: it starts on the pick, never waits for the record's model`, async () => {
      const { w } = fresh()
      w.engine.installed = () => true
      const dir = repo()
      const a = await started(w, dir, `gone-${x.from.kind}-${away}`, 'Gone', 'Add g.txt.')
      w.brief(a.key)
      // its agent ran on the record's model, then went: the task waits for its go, the record kept
      w.records[a.key] = { ...w.records[a.key]!, kind: x.from.kind, model: x.from.model }
      w.engine.todo(a.t.id)
      await w.agents.finish(a.key)
      // as WEB-126's: a stop with no work put its worktree away, with its branch; the restart makes both again from its base
      const path = a.t.worktree!
      if (away) execSync(`git worktree remove --force ${path} && git branch -D ${a.t.branch}`, { cwd: dir })
      expect(existsSync(path)).toBe(!away)
      expect(w.settings.set('models.maxAtOnce', `${x.block}=0`).ok).toBe(true)
      const starts = w.started.filter((s) => s.key === a.key).length
      expect(await w.engine.startNow(a.t.id, x.to)).toEqual({})
      await until(() => w.started.filter((s) => s.key === a.key).length > starts)
      expect(w.started.filter((s) => s.key === a.key).at(-1)).toMatchObject({ kind: x.to.kind })
      expect(w.records[a.key]).toMatchObject({ kind: x.to.kind, ...(x.to.model ? { model: x.to.model } : {}) })
      expect(a.t.held).toBeUndefined()
      await until(() => w.sent.some((s) => s.key === a.key && s.text.includes('Go: you were started now')))
      // the switch is spent, the caps no longer put it on a backup, and its worktree is there again
      expect([a.t.switchTo, a.t.onBackup]).toEqual([undefined, undefined])
      expect(existsSync(path)).toBe(true)
      expect(execSync(`git branch --list ${a.t.branch}`, { cwd: dir }).toString()).toContain(a.t.branch!)
    })

  test('Start with… over a gone agent on another worker: its turn starts it on the pick', async () => {
    const { w, startedOf } = fresh({ 'machine.maxTasks': '1' })
    w.engine.installed = () => true
    const a = await started(w, repo(), 'gone-later', 'Gone', 'Add g.txt.')
    w.brief(a.key)
    w.engine.todo(a.t.id)
    w.records[a.key] = { ...w.records[a.key]!, kind: 'pi', model: 'amd-tokenlab/Qwen3.8-27B' }
    await w.agents.finish(a.key)
    const b = await started(w, repo(), 'gone-later-busy', 'At work', 'Add b.txt.')
    w.brief(b.key)
    w.engine.setWorker(a.t.id, { kind: 'codex' })
    expect(a.t.switchTo).toEqual({ kind: 'codex' })
    const starts = w.started.filter((s) => s.key === a.key).length
    await w.engine.startNow(a.t.id)
    await w.engine.done(b.t.id, 'Nothing to change.')
    w.agentIs(b.key, 'idle')
    await until(() => w.started.filter((s) => s.key === a.key).length > starts)
    expect(w.started.filter((s) => s.key === a.key).at(-1)).toMatchObject({ kind: 'codex' })
    expect(startedOf(a.t.id)).toBe(true)
  })

  test('a pick the same as its record: no switch, it resumes there', async () => {
    const { w } = fresh()
    const a = await started(w, repo(), 'gone-same', 'Gone', 'Add g.txt.')
    w.brief(a.key)
    w.engine.todo(a.t.id)
    const rec = w.records[a.key]!
    await w.agents.finish(a.key)
    w.engine.setWorker(a.t.id, { kind: rec.kind, ...(rec.model ? { model: rec.model } : {}) })
    expect(a.t.switchTo).toBeUndefined()
  })
})
