// A hold survives a restart with its expiry (engine.lineHold, tasks.json): the Shepherdr that comes back reads it, a merge
// asked for there waits for it, and one found past its time ends when the restart looks, with its line in the server's log.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { trainLog, trainWorld } from './train-world.ts'
import { until, world } from './engine-world.ts'

setDefaultTimeout(60_000)

const { lines } = trainLog()
const who = { by: 'Atena', why: 'land a fix by hand' }
const spaceOf = (w: ReturnType<typeof world>, name: string) => {
  const p = w.places.byName(name)
  if (!p) throw new Error(`no space ${name}`)
  return p
}

describe('a hold across a restart', () => {
  test('the Shepherdr that comes back finds it with its expiry, and holds the line as the first did', async () => {
    const { w, space, blocker, go, ran } = await trainWorld('hold-restart', 0, 'off')
    const first = await w.engine.lineHold(spaceOf(w, space), who, 600_000, 30_000)
    if (!first.ok) throw new Error(first.error)
    const file = join(process.env.SHEPHERDR_HOME ?? '', 'tasks.json')
    const kept = JSON.parse(readFileSync(file, 'utf8')).holds
    expect(Object.values(kept)).toEqual([{ by: who.by, why: who.why, at: first.hold.at, until: first.hold.until }])
    // the second one reads it from disk
    const second = world()
    const q = spaceOf(second, space)
    expect(second.engine.line(q).hold).toMatchObject({ state: 'held', by: who.by, why: who.why, at: first.hold.at, until: first.hold.until })
    // a merge asked for there waits for it, and starts when it is released
    go(blocker)
    const asked = second.engine.merge(blocker.id, { self: true })
    await until(() => second.engine.task(blocker.id)?.landing?.step === 'queue')
    await Bun.sleep(300)
    expect(ran()).toEqual([])
    expect(second.engine.lineRelease(q, 'you (terminal)')).toMatchObject({ state: 'held', by: who.by })
    expect((await asked).ok).toBe(true)
    expect(ran()).toEqual([blocker.id])
    expect(JSON.parse(readFileSync(file, 'utf8')).holds).toEqual({})
  })

  test('one found past its time ends when the restart looks, and the line goes on, with the expiry in the log', async () => {
    const { w, space } = await trainWorld('hold-restart-late', 0, 'off')
    const p = spaceOf(w, space)
    const first = await w.engine.lineHold(p, who, 600_000, 30_000)
    if (!first.ok) throw new Error(first.error)
    // the time passed while Shepherdr was off
    const file = join(process.env.SHEPHERDR_HOME ?? '', 'tasks.json')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    for (const h of Object.values(data.holds as Record<string, { until: number }>)) h.until = Date.now() - 1000
    writeFileSync(file, JSON.stringify(data))
    const second = world()
    expect(lines().filter((l) => l.includes('expired'))).toEqual([])
    second.engine.resumeMerges()
    expect(second.engine.line(spaceOf(second, space)).hold).toBeUndefined()
    expect(lines().filter((l) => l.includes('expired'))).toEqual([expect.stringContaining(`line hold on ${space} expired at`)])
    expect(JSON.parse(readFileSync(file, 'utf8')).holds).toEqual({})
  })
})
