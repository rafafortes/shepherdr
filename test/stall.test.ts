// Shepherdr's own event loop, watched (server/live/stall.ts): a tick that comes late says the loop stalled, and the slow
// passes timed since the last tick say what held it.
import { describe, expect, test } from 'bun:test'
import { StallWatch } from '../server/live/stall.ts'

/** a watch on a clock held by hand */
function watch(o: ConstructorParameters<typeof StallWatch>[0] = {}) {
  let t = 1_000_000
  const log: string[] = []
  const w = new StallWatch({ every: 250, over: 1000, slow: 100, now: () => t, log: (l) => log.push(l), ...o })
  return { w, log, at: () => t, advance: (ms: number) => (t += ms) }
}

describe('a stall', () => {
  test('a tick on time is none', () => {
    const { w, advance, log } = watch()
    advance(250)
    expect(w.tick()).toBeUndefined()
    advance(1100)
    // a bit late, under the limit: 850 ms past its time
    expect(w.tick()).toBeUndefined()
    expect(w.stalls).toEqual([])
    expect(log).toEqual([])
  })

  test('a tick a second late or more is one, in the log with what ran: the slow passes since the tick before, by name', () => {
    const { w, advance, log } = watch()
    advance(250)
    w.tick()
    w.run('snapshot', () => advance(900))
    w.run('snapshot', () => advance(300))
    w.run('pollChats', () => advance(500))
    // a pass too quick to matter is not named
    w.run('heartbeat', () => advance(20))
    advance(100)
    const s = w.tick()!
    expect(s.late).toBe(1720 + 100 - 250)
    expect(s.ran).toEqual([
      { label: 'snapshot', ms: 1200 },
      { label: 'pollChats', ms: 500 },
    ])
    expect(w.count).toBe(1)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatch(/the event loop stalled for 1\.6 s, until \d\d:\d\d:\d\d; /)
    expect(log[0]).toContain('slowest passes: snapshot 1200 ms, pollChats 500 ms')
  })

  test('a pass from before the last tick is not named by the next stall', () => {
    const { w, advance } = watch()
    advance(250)
    w.run('old', () => advance(150))
    w.tick()
    advance(2000)
    expect(w.tick()!.ran).toEqual([])
  })

  test('a stall no timed pass explains says so', () => {
    const { w, advance, log } = watch()
    advance(3000)
    expect(w.tick()!.ran).toEqual([])
    expect(log[0]).toContain('no pass it times was slow')
  })

  test('a pass that throws is timed and the error goes on', () => {
    const { w, advance } = watch()
    expect(() =>
      w.run('bad', () => {
        advance(200)
        throw new Error('boom')
      }),
    ).toThrow('boom')
    advance(2000)
    expect(w.tick()!.ran).toEqual([{ label: 'bad', ms: 200 }])
  })

  test('only the latest are kept, and the passes list does not grow without end', () => {
    const { w, advance } = watch()
    for (let i = 0; i < 25; i++) {
      advance(2000)
      w.tick()
    }
    expect(w.stalls).toHaveLength(20)
    expect(w.count).toBe(25)
    for (let i = 0; i < 300; i++) w.run(`p${i}`, () => advance(150))
    advance(10)
    w.tick()
    expect(w.stalls.at(-1)!.ran.length).toBeLessThanOrEqual(200)
  })
})

describe('what doctor says', () => {
  test('nothing while there was no stall', () => {
    expect(watch().w.report()).toEqual([])
  })

  test('how many, the worst, and the latest five with what ran', () => {
    const { w, advance } = watch()
    for (let i = 1; i <= 7; i++) {
      // the first two are too short to be one
      w.run('snapshot', () => advance(i * 500))
      advance(100)
      w.tick()
    }
    const r = w.report((t) => `t${t - 1_000_000}`)
    expect(r[0]).toMatch(/^Event loop: 5 stalls of 1.0 s or more since this server started \(worst \d+\.\d s at t\d+\)/)
    expect(r).toHaveLength(6)
    expect(r[1]).toContain('slowest passes: snapshot')
  })

  test('one stall says "stall"', () => {
    const { w, advance } = watch()
    advance(2000)
    w.tick()
    expect(w.report()[0]).toContain('1 stall of')
  })
})

describe('the real loop', () => {
  test('a pass that holds it makes a stall the watch finds, and a stopped watch ticks no more', async () => {
    const log: string[] = []
    const w = new StallWatch({ every: 20, over: 100, slow: 50, log: (l) => log.push(l) })
    w.start()
    w.run('busy', () => {
      const end = Date.now() + 250
      while (Date.now() < end);
    })
    await Bun.sleep(80)
    expect(w.count).toBeGreaterThanOrEqual(1)
    expect(w.stalls[0].ran[0].label).toBe('busy')
    w.stop()
    const n = w.count
    const end = Date.now() + 250
    while (Date.now() < end);
    await Bun.sleep(80)
    expect(w.count).toBe(n)
  })
})
