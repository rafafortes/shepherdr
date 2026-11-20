// tasks.json is a whole 6.7 MB store rewritten on the event loop. Like agents-save.test.ts for agents.json, these tests
// count its writes: a burst of status changes is one write, a durable transition writes before it returns, stop()/drain()
// flush what a timer held, a save-less change still reaches disk, and the compact write is measured against the old
// indented one on a synthetic store of that size.
import { describe, expect, spyOn, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmp } from './tmp.ts'

const store = await import('../server/store.ts')
const realWriteJson = store.writeJson
const { world, writeJson, repo, Places } = await import('./engine-world.ts')

const onDisk = () => JSON.parse(readFileSync(`${process.env.SHEPHERDR_HOME}/tasks.json`, 'utf8'))
const writes = (spy: ReturnType<typeof spyOn>, file = 'tasks.json') => spy.mock.calls.filter((c: unknown[]) => c[0] === file).length
const task = (w: ReturnType<typeof world>, id: string) => {
  const t = w.engine.task(id)
  if (!t) throw new Error(`${id} is not in the store`)
  return t
}

/** a home of ~6 MB whose size is the briefs, as the operator's store is: 1000 done tasks with ~6 KB descriptions, plus
 *  one live task to change. Every task has a base and a told status, so the constructor writes nothing at start. */
async function bigHome(n = 1000) {
  const p = await new Places().add(repo(), 'save-proj')
  const pad = 'x'.repeat(6000)
  const tasks: Record<string, unknown>[] = Array.from({ length: n }, (_, i) => ({
    id: `T-${i + 1}`,
    n: i + 1,
    project: p.name,
    title: `Task ${i + 1}`,
    desc: pad,
    by: 'test',
    created: 1,
    updated: 1,
    base: 'main',
    told: 'work',
    archived: 2,
    merged: true,
  }))
  tasks.push({ id: 'T-LIVE', n: n + 1, project: p.name, title: 'Live', desc: 'Do it', by: 'test', created: 1, updated: 1, base: 'main', told: 'work' })
  writeJson('tasks.json', { next: { [p.name]: n + 2 }, tasks })
  return p.name
}

describe('tasks.json writes are coalesced, and durability is kept where it matters', () => {
  test('a burst of 50 progress reports on a 6 MB home writes once; changed still goes out on every one', async () => {
    const project = await bigHome()
    expect(project).toBe('save-proj')
    const w = world()
    await Bun.sleep(0) // let the constructor's microtasks settle before the spy goes on
    const spy = spyOn(store, 'writeJson').mockImplementation(() => {})
    w.engine.saveAfter = 50
    let changed = 0
    w.engine.on('changed', () => changed++)
    try {
      for (let i = 0; i < 50; i++) w.engine.report('T-LIVE', `progress ${i}`, i * 2)
      expect(changed).toBe(50)
      expect(writes(spy)).toBe(0)
      await Bun.sleep(110)
      expect(writes(spy)).toBe(1)
      await Bun.sleep(110)
      expect(writes(spy)).toBe(1)
    } finally {
      w.engine.stop()
      spy.mockRestore()
    }
  })

  test('drain (SIGTERM) and stop flush what a timer held; a clean flush writes nothing', async () => {
    await bigHome()
    const w = world()
    await Bun.sleep(0)
    const spy = spyOn(store, 'writeJson').mockImplementation((...args: Parameters<typeof store.writeJson>) => realWriteJson(...args))
    w.engine.saveAfter = 60_000
    try {
      w.engine.flush()
      expect(writes(spy)).toBe(0)
      w.engine.report('T-LIVE', 'one', 10)
      expect(writes(spy)).toBe(0)
      expect(onDisk().tasks.find((t: { id: string }) => t.id === 'T-LIVE').report).toBeUndefined()
      await w.engine.drain()
      expect(writes(spy)).toBe(1)
      expect(onDisk().tasks.find((t: { id: string }) => t.id === 'T-LIVE').report.msg).toBe('one')
      w.engine.report('T-LIVE', 'two', 20)
      w.engine.stop()
      expect(writes(spy)).toBe(2)
      expect(onDisk().tasks.find((t: { id: string }) => t.id === 'T-LIVE').report.msg).toBe('two')
    } finally {
      spy.mockRestore()
    }
  })

  test('checkStalls on 10 stalled tasks writes at most once per interval', async () => {
    const p = await new Places().add(repo(), 'stall-proj')
    const old = Date.now() - 3 * 60 * 60_000
    const tasks: Record<string, unknown>[] = Array.from({ length: 10 }, (_, i) => ({
      id: `S-${i + 1}`,
      n: i + 1,
      project: p.name,
      title: `Stalled ${i + 1}`,
      desc: 'd',
      by: 'test',
      created: 1,
      updated: 1,
      base: 'main',
      told: 'work',
      report: { msg: 'going', progress: 10, left: 1, at: old },
    }))
    writeJson('tasks.json', { next: { [p.name]: 11 }, tasks })
    const w = world()
    await Bun.sleep(0)
    for (const t of tasks) w.status[`${t.id}/Agent`] = 'working'
    const spy = spyOn(store, 'writeJson').mockImplementation(() => {})
    w.engine.saveAfter = 50
    try {
      w.engine.checkStalls()
      expect(w.news).toHaveLength(10)
      expect(writes(spy)).toBe(0)
      await Bun.sleep(110)
      expect(writes(spy)).toBe(1)
    } finally {
      w.engine.stop()
      spy.mockRestore()
    }
  })

  test('a change made with no save call still reaches disk at the next flush', async () => {
    await bigHome()
    const w = world()
    await Bun.sleep(0)
    const spy = spyOn(store, 'writeJson').mockImplementation((...args: Parameters<typeof store.writeJson>) => realWriteJson(...args))
    w.engine.saveAfter = 60_000
    try {
      w.engine.report('T-LIVE', 'trigger', 5)
      task(w, 'T-LIVE').title = 'Changed without a save call'
      w.engine.flush()
      expect(onDisk().tasks.find((t: { id: string }) => t.id === 'T-LIVE').title).toBe('Changed without a save call')
    } finally {
      w.engine.stop()
      spy.mockRestore()
    }
  })

  test('a durable transition writes before it returns; a turn change waits for the end of the turn', async () => {
    const project = await bigHome()
    const w = world()
    await Bun.sleep(0)
    const spy = spyOn(store, 'writeJson').mockImplementation((...args: Parameters<typeof store.writeJson>) => realWriteJson(...args))
    try {
      // add() reserves an id and the brief: both are on disk when it returns
      const t = w.engine.add({ project, title: 'New', desc: 'd', by: 'test', at: Date.now() + 60_000 })
      expect(writes(spy)).toBe(1)
      expect(onDisk().tasks.some((x: { id: string }) => x.id === t.id)).toBe(true)
      // the hourly sweep's auto-archive is a per-turn write: nothing yet on this turn, one at its end
      w.settings.set('tasks.archiveAfter', '1 day')
      Object.assign(task(w, 'T-LIVE'), { merged: true, doneAt: Date.now() - 2 * 86_400_000 })
      expect(w.engine.autoArchive()).toBe(1)
      expect(writes(spy)).toBe(1)
      await Bun.sleep(0)
      expect(writes(spy)).toBe(2)
      expect(onDisk().tasks.find((x: { id: string }) => x.id === 'T-LIVE').archived).toBeGreaterThan(0)
    } finally {
      w.engine.stop()
      spy.mockRestore()
    }
  })

  test('a task added while held, and words written to one while held, are durable before the call returns', async () => {
    const project = await bigHome()
    const w = world()
    await Bun.sleep(0)
    w.settings.set('machine.maxTasks', '0') // no room: add() and tell() both go through hold()
    const spy = spyOn(store, 'writeJson').mockImplementation((...args: Parameters<typeof store.writeJson>) => realWriteJson(...args))
    w.engine.saveAfter = 60_000
    try {
      const t = w.engine.add({ project, title: 'Held', desc: 'the brief', by: 'test' })
      expect(writes(spy)).toBe(1)
      const held = onDisk().tasks.find((x: { id: string }) => x.id === t.id)
      expect(held.desc).toContain('the brief')
      expect(held.held.why).toBe('zero')
      task(w, 'T-LIVE').todo = true // a task waiting for a go: tell() holds its words instead of starting it
      await w.engine.tell('T-LIVE', 'words from the coordinator', { gate: true })
      expect(writes(spy)).toBe(2)
      expect(onDisk().tasks.find((x: { id: string }) => x.id === 'T-LIVE').desc).toContain('words from the coordinator')
    } finally {
      w.engine.stop()
      spy.mockRestore()
    }
  })

  test('a failed write is said once per path and leaves the state dirty for a later flush', async () => {
    await bigHome()
    const w = world()
    await Bun.sleep(0)
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const spy = spyOn(store, 'writeJson').mockImplementation((...args: Parameters<typeof store.writeJson>) => {
      if (args[0] === 'tasks.json') throw new Error('disk full')
      return realWriteJson(...args)
    })
    w.engine.saveAfter = 40
    try {
      w.engine.report('T-LIVE', 'held', 1) // saveSoon's timer
      await Bun.sleep(110) // the timer fires on its own: its failed write is caught here
      w.settings.set('tasks.archiveAfter', '1 day')
      Object.assign(task(w, 'T-LIVE'), { merged: true, doneAt: Date.now() - 2 * 86_400_000 })
      w.engine.autoArchive() // save's microtask
      await Bun.sleep(0) // its failed write is caught here
      w.engine.stop() // both flush paths catch a failed write so the rest of the stop still runs
      await w.engine.drain()
      expect(errors.mock.calls.filter((c: unknown[]) => String(c[0]).includes('could not write tasks.json')).length).toBeGreaterThanOrEqual(2)
    } finally {
      spy.mockRestore()
      errors.mockRestore()
    }
  })
})

test('a compact write of a 6.7 MB tasks.json is measured against the indented one', () => {
  const pad = 'x'.repeat(5200)
  const tasks = Array.from({ length: 1000 }, (_, i) => ({
    id: `B-${i}`,
    title: `b ${i}`,
    desc: pad,
    facts: 'f'.repeat(1000),
    agent: { kind: 'pi', model: 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold', effort: 'high' },
    report: { msg: 'Working on it', progress: 80, left: 10, at: 1 },
    scheduled: { at: 1, set: { 'task.fallback': 'out' } },
  }))
  const value = { next: {}, tasks }
  let t = performance.now()
  const pretty = JSON.stringify(value, null, 2)
  const prettyStringify = performance.now() - t
  t = performance.now()
  const compact = JSON.stringify(value)
  const compactStringify = performance.now() - t
  const dir = tmp('engine-save-bench')
  t = performance.now()
  writeFileSync(`${dir}/pretty.json`, pretty)
  const prettyWrite = performance.now() - t
  t = performance.now()
  writeFileSync(`${dir}/compact.json`, compact)
  const compactWrite = performance.now() - t
  // the whole writeJson path, including the fsync and rename a store of record gets, before and after the toggle
  t = performance.now()
  realWriteJson('tasks.json', value, dir, false)
  const prettyFull = performance.now() - t
  t = performance.now()
  realWriteJson('tasks.json', value, dir, true)
  const compactFull = performance.now() - t
  expect(compact.length).toBeLessThan(pretty.length)
  expect(JSON.parse(readFileSync(`${dir}/tasks.json`, 'utf8')).tasks.length).toBe(1000)
  console.log(
    `BENCH tasks.json ${(pretty.length / 1e6).toFixed(2)} MB pretty ` +
      `(stringify ${prettyStringify.toFixed(1)} ms + write ${prettyWrite.toFixed(1)} ms, writeJson ${prettyFull.toFixed(1)} ms) -> ` +
      `${(compact.length / 1e6).toFixed(2)} MB compact ` +
      `(stringify ${compactStringify.toFixed(1)} ms + write ${compactWrite.toFixed(1)} ms, writeJson ${compactFull.toFixed(1)} ms)`,
  )
})
