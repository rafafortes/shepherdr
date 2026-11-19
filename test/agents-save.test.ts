// agents.json is a whole 3.6 MB store. Before this change every record change wrote it (pretty-printed) on the event
// loop, and settleLaunches flipped pendingLaunch once per agent per refresh (a burst during a start). These tests count
// the writes: the flips coalesce into one, outbox.json stays immediate, a stop/finish/forget is durable, and the
// compact write is measured against the old indented one on a synthetic store.
import { describe, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('agents-save')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
const store = await import('../server/store.ts')
const realWriteJson = store.writeJson
const { Agents } = await import('../server/live/agents.ts')
type AgentInfo = import('../server/live/herdr.ts').AgentInfo

const home = process.env.SHEPHERDR_HOME
const KEY = 'T-66/Agent'
const name = 'shep-t-66'
const cwd = tmp('agents-save-cwd')

/** a fresh store of `n` pi task agents, each with one record */
function put(n = 1) {
  const records = Object.fromEntries(
    Array.from({ length: n }, (_, i) => {
      const key = i === 0 ? KEY : `T-66-${i}/Agent`
      return [key, { key, name: i === 0 ? name : `shep-t-66-${i}`, kind: 'pi', cwd, workspace: 'w', logs: [], started: 1 }]
    }),
  )
  realWriteJson('agents.json', records)
  realWriteJson('outbox.json', [])
}

const onDisk = (file: string) => JSON.parse(readFileSync(join(home, file), 'utf8'))

/** how many writes to one file a store spy saw */
const writes = (spy: ReturnType<typeof spyOn>, file: string) => spy.mock.calls.filter((c: unknown[]) => c[0] === file).length

describe('agents.json writes are debounced, outbox.json is not', () => {
  test('a burst of pendingLaunch flips in one window writes agents.json exactly once', async () => {
    put(4)
    const spy = spyOn(store, 'writeJson').mockImplementation(() => {})
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const a = new Agents()
    a.recordsSaveAfter = 50
    a.pendingFor = 0 // no herdr ask: a flip past the patience is said once and left alone
    try {
      const names = Object.values(a.records).map((r) => r.name)
      // settleLaunches flips each record true, then false, over several event-loop turns inside one window
      for (let i = 0; i < 7; i++) {
        const pending = i % 2 === 0
        a.live = new Map(names.map((n) => [n, { name: n, launch_pending: pending } as unknown as AgentInfo]))
        ;(a as unknown as { settleLaunches: () => void }).settleLaunches()
        await Bun.sleep(4)
      }
      // no write yet: the one timer is still pending, even though the flips happened across several turns
      expect(writes(spy, 'agents.json')).toBe(0)
      expect(Object.values(a.records).some((r) => r.pendingLaunch)).toBe(true)
      await Bun.sleep(70)
      // all the flips, one write, and no outbox write from them
      expect(writes(spy, 'agents.json')).toBe(1)
      expect(writes(spy, 'outbox.json')).toBe(0)
      await Bun.sleep(70)
      expect(writes(spy, 'agents.json')).toBe(1)
      expect(errors.mock.calls.length).toBeGreaterThan(0)
    } finally {
      a.stop()
      errors.mockRestore()
      spy.mockRestore()
    }
  })

  test('outbox.json is written synchronously on an outbox change, agents.json is held back', async () => {
    put()
    const spy = spyOn(store, 'writeJson').mockImplementation((...args: Parameters<typeof store.writeJson>) => realWriteJson(...args))
    const a = new Agents()
    try {
      // queue() changes only the outbox: its write must be on disk before the call returns
      ;(a as unknown as { queue: (key: string, texts: string[]) => void }).queue(KEY, ['the brief'])
      expect(writes(spy, 'outbox.json')).toBe(1)
      expect(writes(spy, 'agents.json')).toBe(0)
      expect(onDisk('outbox.json')[0].text).toBe('the brief')
    } finally {
      a.stop()
      spy.mockRestore()
    }
  })

  test('a clean stop flushes a dirty records state, and a clean one writes nothing', async () => {
    put()
    const spy = spyOn(store, 'writeJson').mockImplementation((...args: Parameters<typeof store.writeJson>) => realWriteJson(...args))
    const a = new Agents()
    try {
      a.record(KEY)!.model = 'a-new-model'
      a.save()
      // save() only queues a microtask: nothing on disk yet in this turn
      expect(writes(spy, 'agents.json')).toBe(0)
      a.stop()
      expect(writes(spy, 'agents.json')).toBe(1)
      expect(onDisk('agents.json')[KEY].model).toBe('a-new-model')
    } finally {
      spy.mockRestore()
    }
    // a second stop, with nothing dirty, is a no-op
    const spy2 = spyOn(store, 'writeJson').mockImplementation(() => {})
    try {
      a.stop()
      expect(writes(spy2, 'agents.json')).toBe(0)
    } finally {
      spy2.mockRestore()
    }
  })

  test('finish and forget are durable when they return', async () => {
    put()
    const spy = spyOn(store, 'writeJson').mockImplementation((...args: Parameters<typeof store.writeJson>) => realWriteJson(...args))
    const a = new Agents()
    try {
      await a.finish(KEY)
      expect(writes(spy, 'agents.json')).toBe(1)
      expect(onDisk('agents.json')[KEY].finished).toBe(true)
      a.forget(KEY)
      expect(writes(spy, 'agents.json')).toBe(2)
      expect(onDisk('agents.json')[KEY]).toBeUndefined()
    } finally {
      a.stop()
      spy.mockRestore()
    }
  })

  test('coalesces every save() in one event-loop turn into one write', async () => {
    put()
    const spy = spyOn(store, 'writeJson').mockImplementation(() => {})
    const a = new Agents()
    try {
      const r = a.record(KEY)!
      r.model = 'one'
      a.save()
      r.model = 'two'
      a.save()
      r.model = 'three'
      a.save()
      expect(writes(spy, 'agents.json')).toBe(0)
      await Promise.resolve() // end of the turn: the one microtask runs
      expect(writes(spy, 'agents.json')).toBe(1)
    } finally {
      a.stop()
      spy.mockRestore()
    }
  })

  test('flushRecords writes compact JSON that parses to the same records', () => {
    put()
    const spy = spyOn(store, 'writeJson').mockImplementation((...args: Parameters<typeof store.writeJson>) => realWriteJson(...args))
    const a = new Agents()
    try {
      a.record(KEY)!.model = 'compact'
      a.save()
      a.flushRecords()
      const text = readFileSync(join(home, 'agents.json'), 'utf8')
      expect(text).not.toContain('\n  ')
      expect(JSON.parse(text)).toEqual(a.records)
      const call = spy.mock.calls.find((c: unknown[]) => c[0] === 'agents.json')
      expect(call?.[3]).toBe(true)
    } finally {
      a.stop()
      spy.mockRestore()
    }
  })

  test('a failed record write stays dirty and is said, not thrown, on the event loop', async () => {
    put()
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    let fail = true
    const spy = spyOn(store, 'writeJson').mockImplementation((...args: Parameters<typeof store.writeJson>) => {
      if (fail && args[0] === 'agents.json') throw new Error('disk full')
      return realWriteJson(...args)
    })
    const a = new Agents()
    a.recordsSaveAfter = 5
    a.pendingFor = 0
    try {
      // the microtask path: caught, and the records stay dirty
      a.record(KEY)!.model = 'retry-me'
      a.save()
      await Promise.resolve()
      expect(errors.mock.calls.some((c: unknown[]) => String(c[0]).includes('could not write agents.json'))).toBe(true)
      // the timer path: also caught, no uncaught exception on the event loop
      a.live = new Map([[name, { name, launch_pending: true } as unknown as AgentInfo]])
      ;(a as unknown as { settleLaunches: () => void }).settleLaunches()
      await Bun.sleep(30)
      expect(errors.mock.calls.filter((c: unknown[]) => String(c[0]).includes('could not write agents.json')).length).toBeGreaterThan(1)
      // the next good flush writes the same records
      fail = false
      a.flushRecords()
      expect(onDisk('agents.json')[KEY].model).toBe('retry-me')
      // a failed write at shutdown is caught too, so the rest of stop() still runs
      fail = true
      a.record(KEY)!.model = 'at-stop'
      a.save()
      await Promise.resolve()
      expect(() => a.stop()).not.toThrow()
    } finally {
      a.stop()
      spy.mockRestore()
      errors.mockRestore()
    }
  })

  test('a stop while a flip timer is pending flushes the flip once and cancels the timer', async () => {
    put()
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const spy = spyOn(store, 'writeJson').mockImplementation((...args: Parameters<typeof store.writeJson>) => realWriteJson(...args))
    const a = new Agents()
    a.recordsSaveAfter = 5000 // far off: only stop can write in this test
    a.pendingFor = 0
    try {
      a.live = new Map([[name, { name, launch_pending: true } as unknown as AgentInfo]])
      ;(a as unknown as { settleLaunches: () => void }).settleLaunches()
      expect(writes(spy, 'agents.json')).toBe(0)
      a.stop()
      expect(writes(spy, 'agents.json')).toBe(1)
      expect(onDisk('agents.json')[KEY].pendingLaunch).toBe(true)
      await Bun.sleep(20)
      expect(writes(spy, 'agents.json')).toBe(1) // the cancelled timer never writes a second time
    } finally {
      spy.mockRestore()
      errors.mockRestore()
    }
  })

  test('a save() in the flip turn flushes once and cancels the timer', async () => {
    put()
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const spy = spyOn(store, 'writeJson').mockImplementation((...args: Parameters<typeof store.writeJson>) => realWriteJson(...args))
    const a = new Agents()
    a.recordsSaveAfter = 5000
    a.pendingFor = 0
    try {
      a.live = new Map([[name, { name, launch_pending: true } as unknown as AgentInfo]])
      ;(a as unknown as { settleLaunches: () => void }).settleLaunches()
      a.record(KEY)!.model = 'same-turn'
      a.save() // its microtask flushes the flip too, clearing the timer
      await Promise.resolve()
      expect(writes(spy, 'agents.json')).toBe(1)
      expect(onDisk('agents.json')[KEY].pendingLaunch).toBe(true)
      await Bun.sleep(20)
      expect(writes(spy, 'agents.json')).toBe(1)
    } finally {
      a.stop()
      spy.mockRestore()
      errors.mockRestore()
    }
  })

  test('compact write of a ~3.6 MB store: stringify + write, before and after (ms)', () => {
    // a synthetic store with many small fields, so indentation really costs (a real coordinator record is like this)
    const line = { path: '/w/a-long-project-folder/sessions/2026-11-18/session.jsonl', id: 'a-session-id', kind: 'claude' }
    const one = (i: number) => {
      const key = `S-${i}/Agent`
      return [
        key,
        {
          key,
          name: `shep-s-${i}`,
          kind: 'claude',
          cwd: '/w/project',
          workspace: 'w',
          logs: Array.from({ length: 40 }, () => ({ ...line })),
          started: i,
          env: { SHEPHERDR_CHAT: key, SHEPHERDR_COMMAND: '/bin/shepherdr' },
        },
      ] as const
    }
    const per = JSON.stringify({ [one(0)[0]]: one(0)[1] }, null, 2).length
    const count = Math.ceil(3_600_000 / per)
    const records = Object.fromEntries(Array.from({ length: count }, (_, i) => one(i)))
    const bytes = JSON.stringify(records, null, 2).length
    // the production writer, both ways: its default indentation (before) and compact (after)
    const measure = (compact: boolean) => {
      const file = 'bench.json' // one inode for both, so the comparison is stringify + write, not file creation
      store.writeJson(file, records, home, compact) // warm up the file
      const times: number[] = []
      for (let n = 0; n < 9; n++) {
        const t0 = performance.now()
        store.writeJson(file, records, home, compact)
        times.push(performance.now() - t0)
      }
      times.sort((a, b) => a - b)
      return times[4] // median, this machine is shared and busy
    }
    const pretty = measure(false)
    const compact = measure(true)
    console.log(`agents-save: ${count} records, ${bytes} bytes; stringify+write indented ${pretty.toFixed(1)} ms, compact ${compact.toFixed(1)} ms`)
    expect(bytes).toBeGreaterThan(3_600_000)
  })
})
