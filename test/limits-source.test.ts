// Settings → Limits, the live source's side: the action reads the view over the engine's held tasks and the settings, and
// a cell's write is the setting action at its place (the same keys Settings writes), read back by the next look.
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
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
    expect(src.settings.set('models.maxAtOnce', 'openai=1', 'machine').ok).toBe(true)
    src.engine.lease('busy-review', 'reviewer', 'openai/gpt-6-sol', '~')
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
    const refused = (await src.act({ type: 'setting', key: 'machine.maxTasks', value: '0', place: here })) as { ok: boolean; error?: string }
    expect(refused.ok).toBe(false)
    expect(refused.error).toBeTruthy()
    // a space's own sub-limit is written at the space, and its line shows in the Spaces table
    expect(await src.act({ type: 'setting', key: 'models.maxAtOnce', value: 'spark=3', place: here })).toMatchObject({ ok: true })
    const capped = (await src.act({ type: 'limits-view' })) as View
    expect(capped.spaces.patterns).toContain('spark')
    expect(capped.caps.machine).toBe('spark=3')
    expect(capped.spaces.totals.spark).toEqual({ pattern: 'spark', max: 3 })
    expect(await src.act({ type: 'setting', key: 'models.maxAtOnce', value: null, place: here })).toMatchObject({ ok: true })
    expect(((await src.act({ type: 'limits-view' })) as View).spaces.patterns).not.toContain('spark')
    await src.act({ type: 'setting', key: 'machine.maxTasks', value: null, place: here })
  })
})
