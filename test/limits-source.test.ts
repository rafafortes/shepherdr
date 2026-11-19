// Settings → Limits, the live source's side: the action reads the view over the engine's held tasks and the settings, and
// a cell's write is the setting action at its place (the same keys Settings writes), read back by the next look.
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { placeId } from '../server/live/places.ts'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('limits-source')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')

const src = new LiveSource()
afterAll(() => src.stop())

type View = import('../shared/types.ts').LimitsView

describe('the Limits action', () => {
  test('reads every table, and a held task shows in its group with the reason the machine gives', async () => {
    // a task held for a slot of this machine, as the engine holds one (its own record, no project folder of its own)
    src.engine.tasks.push({ id: 'LIM-1', n: 1, project: 'nowhere', title: 'Held', desc: '', by: 'test', created: Date.now(), updated: Date.now(), held: { why: 'slots', since: Date.now() } } as never)
    const v = (await src.act({ type: 'limits-view' })) as View
    expect(v.machine.name).toBeTruthy()
    expect(v.machineTable.rows.map((r) => r.id)).toEqual(['all', v.machine.id])
    expect(v.waiting.held).toBe(1)
    expect(v.waiting.groups.map((g) => g.id)).toEqual(['slots'])
    expect(v.waiting.groups[0]!.tasks.map((t) => t.id)).toEqual(['LIM-1'])
    expect(v.waiting.groups[0]!.limit).toMatch(/working$/)
    expect(v.known.length).toBeGreaterThan(5)
    src.engine.tasks.splice(src.engine.tasks.findIndex((t) => t.id === 'LIM-1'), 1)
  })

  test('a review round that waits for a reviewer is listed with the reviewers that are full, and its task opens from there', async () => {
    // the default reviewer is Codex: its one slot is taken by another run, so the round of this task waits for it
    expect(src.settings.set('models.maxAtOnce', 'codex=1', 'machine').ok).toBe(true)
    src.engine.lease('busy-review', 'reviewer', 'codex/gpt-6-sol', '~')
    src.engine.tasks.push({ id: 'LIM-2', n: 2, project: 'nowhere', title: 'Reviewed', desc: '', by: 'test', created: Date.now(), updated: Date.now(), reviewWait: { since: Date.now() } } as never)
    try {
      const v = (await src.act({ type: 'limits-view' })) as View
      expect(v.waiting.reviews).toEqual([{ task: 'LIM-2', space: expect.any(String), words: expect.stringContaining('Waits for a reviewer: Codex') }])
    } finally {
      src.engine.unlease('busy-review')
      src.engine.tasks.splice(src.engine.tasks.findIndex((t) => t.id === 'LIM-2'), 1)
      expect(src.settings.set('models.maxAtOnce', null, 'machine').ok).toBe(true)
    }
  })

  test("a cell's write goes to its place with the setting's own key, and the next look reads it back, from where it is set", async () => {
    const before = (await src.act({ type: 'limits-view' })) as View
    const here = before.machine.id
    expect(await src.act({ type: 'setting', key: 'machine.maxTasks', value: '6', place: here })).toMatchObject({ ok: true })
    const after = (await src.act({ type: 'limits-view' })) as View
    expect(after.machineTable.rows[1]!.cells['machine.maxTasks']).toMatchObject({ from: 'machine', set: true, row: { value: '6' } })
    expect(after.machineTable.rows[0]!.cells['machine.maxTasks']).toMatchObject({ from: 'default', set: false })
    // and a refused value is refused in words, with nothing written
    const refused = (await src.act({ type: 'setting', key: 'machine.maxTasks', value: '201', place: here })) as { ok: boolean; error?: string }
    expect(refused.ok).toBe(false)
    expect(refused.error).toBeTruthy()
    // a space's own sub-limit is written at the space, and its line shows in the Spaces table
    expect(await src.act({ type: 'setting', key: 'models.maxAtOnce', value: 'pi.spark=3', place: here })).toMatchObject({ ok: true })
    const capped = (await src.act({ type: 'limits-view' })) as View
    expect(capped.spaces.patterns).toContain('pi.spark')
    expect(capped.caps.machine).toBe('pi.spark=3')
    expect(capped.spaces.totals['pi.spark']).toEqual({ pattern: 'pi.spark', max: 3 })
    expect(await src.act({ type: 'setting', key: 'models.maxAtOnce', value: null, place: here })).toMatchObject({ ok: true })
    expect(((await src.act({ type: 'limits-view' })) as View).spaces.patterns).not.toContain('pi.spark')
    await src.act({ type: 'setting', key: 'machine.maxTasks', value: null, place: here })
  })
})

describe('the view kept between asks (SHE-165)', () => {
  /** the view as the page asks for it, and how many builds it took */
  const look = async () => {
    const before = src.limitsBuilds
    const v = (await src.act({ type: 'limits-view' })) as View
    return { v, builds: src.limitsBuilds - before }
  }
  const here = async () => ((await src.act({ type: 'limits-view' })) as View).machine.id

  test('one build serves every screen that asks within its interval; a setting change, a held task or the interval drops it', async () => {
    // this write drops whatever an earlier test left kept, so the count below starts from nothing
    expect(await src.act({ type: 'setting', key: 'machine.maxTasks', value: '7', place: await here() })).toMatchObject({ ok: true })
    const first = await look()
    expect(first.builds).toBe(1)
    // a second screen asking at once is answered with that same build, not another
    const second = await look()
    expect(second.builds).toBe(0)
    expect(second.v).toBe(first.v)
    // a setting written here drops it at once
    expect(await src.act({ type: 'setting', key: 'machine.maxTasks', value: '8', place: await here() })).toMatchObject({ ok: true })
    expect((await look()).builds).toBe(1)
    // so does the held line: a task held, and the same one let go
    const held = { id: 'LIM-KEEP', n: 9, project: 'nowhere', title: 'Held', desc: '', by: 'test', created: Date.now(), updated: Date.now(), held: { why: 'slots', since: Date.now() } }
    src.engine.tasks.push(held as never)
    try {
      const withHeld = await look()
      expect(withHeld.builds).toBe(1)
      expect(withHeld.v.waiting.held).toBe(1)
    } finally {
      src.engine.tasks.splice(src.engine.tasks.findIndex((t) => t.id === 'LIM-KEEP'), 1)
    }
    expect((await look()).builds).toBe(1)
    // and nothing held it past its interval
    await Bun.sleep(1_100)
    expect((await look()).builds).toBe(1)
    expect((await look()).builds).toBe(0)
    await src.act({ type: 'setting', key: 'machine.maxTasks', value: null, place: await here() })
  })

  test('the build for 300 waiting tasks is timed, and a slow one is named by the stall watch', async () => {
    // the walk's worst shape: a chain of 300 queued tasks, each after the one before, ending at a task at work
    const now = Date.now()
    const project = placeId.home()
    const base = (id: string) => ({ id, n: 1, project, title: id, by: 't', created: now, updated: now })
    src.engine.tasks.push({ ...base('LIM-WORK') } as never)
    const statusOf = src.engine.statusOf.bind(src.engine)
    src.engine.statusOf = ((t: never) => ((t as { id: string }).id === 'LIM-WORK' ? 'work' : statusOf(t))) as never
    for (let i = 0; i < 300; i++) src.engine.tasks.push({ ...base(`LIM-W-${i}`), after: [i === 0 ? 'LIM-WORK' : `LIM-W-${i - 1}`] } as never)
    try {
      expect(src.engine.statusOf(src.engine.task('LIM-WORK')!)).toBe('work')
      const ms: number[] = []
      for (let i = 0; i < 3; i++) {
        // a setting between the runs drops the kept view, so each is a build of its own
        await src.act({ type: 'setting', key: 'machine.maxTasks', value: String(6 + i), place: await here() })
        const t0 = performance.now()
        const v = (await src.act({ type: 'limits-view' })) as View
        ms.push(performance.now() - t0)
        expect(v.waiting.queued.reduce((n, g) => n + g.tasks.length, 0)).toBe(300)
      }
      console.log(`SHE-165 synthetic engine: the view built for 300 waiting tasks in ${ms.map((n) => n.toFixed(1)).join(' / ')} ms`)
      expect(Math.max(...ms)).toBeLessThan(2_000)
      // a slow build is one of the passes the stall watch times, so a stall names it
      const queueWaiters = src.engine.queueWaiters.bind(src.engine)
      src.engine.queueWaiters = ((at?: number) => {
        const end = Date.now() + 150
        while (Date.now() < end);
        return queueWaiters(at)
      }) as never
      src.stall.tick()
      await src.act({ type: 'setting', key: 'machine.maxTasks', value: '5', place: await here() })
      await src.act({ type: 'limits-view' })
      src.engine.queueWaiters = queueWaiters
      await Bun.sleep(1_300)
      expect(src.stall.tick()?.ran.map((p) => p.label)).toContain('limits-view')
    } finally {
      src.engine.statusOf = statusOf
      for (const id of ['LIM-WORK', ...Array.from({ length: 300 }, (_, i) => `LIM-W-${i}`)]) src.engine.tasks.splice(src.engine.tasks.findIndex((t) => t.id === id), 1)
      await src.act({ type: 'setting', key: 'machine.maxTasks', value: null, place: await here() })
    }
  })
})
