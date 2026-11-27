// The merge line's hold (server/live/engine/line-hold.ts): its two states, the gate every turn passes, its expiry, and what a
// restart finds. The engine's line, its rows and the command are in engine-line-hold*.test.ts and line-hold-cli.test.ts.
import { describe, expect, test } from 'bun:test'
import { clockOf, type Hold, type HoldHost, HOLD_DEFAULT, HOLD_MAX, LineHolds, spanOf, whyLine } from '../server/live/engine/line-hold.ts'

/** a hold's owner, as a test stands it: a record that is the engine's, a log, and a clock that moves when told */
function host(stored: Record<string, Hold> = {}) {
  const log: string[] = []
  const saved: string[] = []
  const changed: string[] = []
  let clock = 1_700_000_000_000
  const h: HoldHost & { advance(ms: number): void } = {
    stored: () => stored,
    save: () => void saved.push(JSON.stringify(stored)),
    log: (line) => void log.push(line),
    changed: (repo) => void changed.push(repo),
    name: (repo) => repo.split('/').at(-1) ?? repo,
    now: () => clock,
    advance: (ms) => {
      clock += ms
    },
  }
  return { h, stored, log, saved, changed }
}
const who = { by: 'you (terminal)', why: 'land the hotfix' }
const REPO = '/repos/lyvora-app'

describe('the limits of a hold', () => {
  test('twenty minutes unless it says, and never more than an hour', () => {
    expect([HOLD_DEFAULT, HOLD_MAX]).toEqual([20 * 60_000, 60 * 60_000])
  })

  test("a reason is one line, whatever it was written as, and never more than 200 characters; a time is the clock's hours and minutes", () => {
    expect(whyLine('land\n  the   hotfix \n')).toBe('land the hotfix')
    expect(whyLine('x'.repeat(300))).toHaveLength(200)
    expect(clockOf(Date.UTC(2026, 10, 26, 17, 42), 'UTC')).toBe('17:42')
    expect([spanOf(50), spanOf(30_000), spanOf(45 * 60_000)]).toEqual(['1 s', '30 s', '45 min'])
  })
})

describe('asking for a hold', () => {
  test('with nothing in flight it is in effect at once, stored with its expiry, and the log and the rows say so', async () => {
    const { h, stored, log, saved, changed } = host()
    const holds = new LineHolds(h)
    const r = await holds.ask(REPO, who, 600_000, false, 60_000)
    expect(r).toEqual({ ok: true, hold: { ...who, at: h.now(), until: h.now() + 600_000 } })
    expect(stored[REPO]).toMatchObject({ by: who.by, why: who.why, until: h.now() + 600_000 })
    expect(saved).toHaveLength(1)
    // asked for, then in effect: the rows are told each time
    expect(changed).toEqual([REPO, REPO])
    expect(log).toEqual([`line hold on lyvora-app: you (terminal) holds the merge line until ${clockOf(h.now() + 600_000)} (land the hotfix)`])
    expect(holds.on(REPO)).toBe(true)
    expect(holds.active(REPO)).toBe(stored[REPO])
    expect(holds.pending(REPO)).toBeUndefined()
  })

  test('a second hold says who holds, until when and why, and a third while one waits says who waits', async () => {
    const { h } = host()
    const holds = new LineHolds(h)
    await holds.ask(REPO, who, 600_000, false, 60_000)
    const again = await holds.ask(REPO, { by: 'Atena', why: 'also land one' }, 600_000, false, 60_000)
    expect(again).toMatchObject({ ok: false })
    expect(!again.ok && again.error).toBe(`lyvora-app's merge line is already held by you (terminal) until ${clockOf(h.now() + 600_000)}: land the hotfix. Release it first, or wait for it to end.`)
    // another line, another hold; and a wait for a merge in flight is a hold asked for
    expect((await holds.ask('/repos/site', who, 600_000, false, 60_000)).ok).toBe(true)
    holds.release(REPO, 'you')
    const waits = holds.ask(REPO, who, 600_000, true, 60_000)
    const third = await holds.ask(REPO, { by: 'Atena', why: 'me too' }, 600_000, true, 60_000)
    expect(!third.ok && third.error).toBe("you (terminal) is already waiting to hold lyvora-app's merge line: land the hotfix.")
    holds.idle(REPO)
    expect((await waits).ok).toBe(true)
  })
})

describe('waiting for the merge in flight', () => {
  test('a hold asked for while a merge runs reserves the next turn at once, and is in effect the moment that merge ends', async () => {
    const { h, stored, log, changed } = host()
    const holds = new LineHolds(h)
    const asked = holds.ask(REPO, who, 600_000, true, 60_000)
    // the next turn cannot start: the line is held already, though nothing is stored yet
    expect(holds.on(REPO)).toBe(true)
    expect(holds.active(REPO)).toBeUndefined()
    expect(holds.pending(REPO)).toMatchObject({ by: who.by, why: who.why })
    expect(stored).toEqual({})
    let turn = false
    const gate = holds.gate(REPO).then(() => {
      turn = true
    })
    await Bun.sleep(20)
    expect(turn).toBe(false)
    expect(log).toEqual(['line hold on lyvora-app: you (terminal) waits for the merge in flight to end, and keeps the next turn from starting (land the hotfix)'])
    // the merge in flight ends: the hold is in effect, and the turn is still held back
    holds.idle(REPO)
    const r = await asked
    expect(r.ok && r.hold.by).toBe(who.by)
    expect(stored[REPO]).toBeDefined()
    await Bun.sleep(20)
    expect(turn).toBe(false)
    expect(changed.length).toBeGreaterThanOrEqual(2)
    // released: the turn goes on
    expect(holds.release(REPO, 'you (terminal)')).toMatchObject({ state: 'held', by: who.by, why: who.why })
    await gate
    expect(turn).toBe(true)
    expect(holds.on(REPO)).toBe(false)
  })

  test('a merge that ends with no hold waiting leaves the line alone', () => {
    const { h, stored } = host()
    const holds = new LineHolds(h)
    holds.idle(REPO)
    expect(stored).toEqual({})
  })

  test('a wait that is not over by its limit ends the command with no hold left behind, and the turns go on', async () => {
    const { h, stored, log } = host()
    const holds = new LineHolds(h)
    let turn = false
    const asked = holds.ask(REPO, who, 600_000, true, 50)
    const gate = holds.gate(REPO).then(() => {
      turn = true
    })
    const r = await asked
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toBe('The merge in flight in lyvora-app did not end in 1 s: nothing is held, and the line goes on as it was. Try again when it has ended.')
    expect(stored).toEqual({})
    expect(holds.on(REPO)).toBe(false)
    await gate
    expect(turn).toBe(true)
    expect(log.at(-1)).toBe('line hold on lyvora-app: you (terminal) gave up waiting for the merge in flight to end (1 s): nothing is held')
    // a late end of that merge holds nothing
    holds.idle(REPO)
    expect(stored).toEqual({})
  })

  test('a wait released by someone else is no hold: the command is told, and the turns go on', async () => {
    const { h, stored, log } = host()
    const holds = new LineHolds(h)
    const asked = holds.ask(REPO, who, 600_000, true, 60_000)
    expect(holds.release(REPO, 'Atena')).toEqual({ state: 'waiting', by: who.by, why: who.why })
    const r = await asked
    expect(!r.ok && r.error).toBe("Atena released the wait for lyvora-app's merge line: nothing is held.")
    expect(stored).toEqual({})
    expect(holds.on(REPO)).toBe(false)
    expect(log.at(-1)).toBe("line hold on lyvora-app: you (terminal)'s wait released by Atena: nothing is held")
  })
})

describe('a reservation its caller gives up', () => {
  test('one still waiting is ended with the words the caller gave, and one that took effect meanwhile is dropped, both with nothing in the log', async () => {
    const { h, stored, log, saved } = host()
    const holds = new LineHolds(h)
    const reserved = holds.reserve(REPO, who, 600_000, true, 60_000)
    if (!reserved.ok) throw new Error(reserved.error)
    let turn = false
    const gate = holds.gate(REPO).then(() => {
      turn = true
    })
    holds.cancel(REPO, 'it merges through a pull request')
    expect(await reserved.done).toEqual({ ok: false, error: 'it merges through a pull request' })
    await gate
    expect(turn).toBe(true)
    expect(holds.on(REPO)).toBe(false)
    // the merge in flight ended while the caller was still asking: the hold took effect, and the caller drops it
    const again = holds.reserve(REPO, who, 600_000, true, 60_000)
    if (!again.ok) throw new Error(again.error)
    holds.idle(REPO)
    expect(stored[REPO]).toBeDefined()
    holds.cancel(REPO, 'it merges through a pull request')
    expect(stored).toEqual({})
    expect(holds.on(REPO)).toBe(false)
    expect(saved.length).toBe(2)
    // asking to cancel what was never asked changes nothing
    holds.cancel(REPO, 'nothing here')
    expect(log.filter((l) => l.includes('released') || l.includes('expired') || l.includes('gave up'))).toEqual([])
  })
})

describe('the end of a hold', () => {
  test('releasing a line that is not held says nothing was held', () => {
    const { h, log } = host()
    const holds = new LineHolds(h)
    expect(holds.release(REPO, 'you')).toBeUndefined()
    expect(log).toEqual([])
  })

  test('a release ends it at once: stored no more, its timer gone, the log says who released and who held', async () => {
    const { h, stored, log, saved } = host()
    const holds = new LineHolds(h)
    await holds.ask(REPO, who, 600_000, false, 60_000)
    holds.release(REPO, 'Atena')
    expect(stored).toEqual({})
    expect(saved).toHaveLength(2)
    expect(log.at(-1)).toMatch(/^line hold on lyvora-app released by Atena \(held by you \(terminal\) since \d\d:\d\d: land the hotfix\)$/)
  })

  test('it ends by itself at its time, and says so in the log, so a holder that crashed cannot block the line', async () => {
    const { h, stored, log } = host()
    const holds = new LineHolds(h)
    let turn = false
    await holds.ask(REPO, who, 40, false, 60_000)
    const gate = holds.gate(REPO).then(() => {
      turn = true
    })
    await Bun.sleep(150)
    await gate
    expect(turn).toBe(true)
    expect(stored).toEqual({})
    expect(log.at(-1)).toMatch(/^line hold on lyvora-app expired at \d\d:\d\d \(held by you \(terminal\) since \d\d:\d\d: land the hotfix\): the line goes on$/)
  })

  test('one past its time with no timer to say so (the clock moved) is over at the first look: not held, ended, logged once', async () => {
    const { h, stored, log } = host()
    const holds = new LineHolds(h)
    await holds.ask(REPO, who, 600_000, false, 60_000)
    h.advance(600_001)
    expect(holds.peek(REPO)).toBeUndefined()
    expect(stored[REPO]).toBeDefined()
    expect(holds.on(REPO)).toBe(false)
    expect(stored).toEqual({})
    expect(log.filter((l) => l.includes('expired'))).toHaveLength(1)
  })
})

describe('what a restart finds', () => {
  test('a hold in effect goes on to its time, with who held it and why', async () => {
    const at = 1_700_000_000_000
    const kept: Record<string, Hold> = { [REPO]: { by: 'Atena', why: 'land a fix', at, until: at + 150 } }
    const { h, log } = host(kept)
    h.now = () => at + 10
    const holds = new LineHolds(h)
    holds.start()
    expect(holds.active(REPO)).toMatchObject({ by: 'Atena', why: 'land a fix' })
    expect(holds.on(REPO)).toBe(true)
    // its timer was armed from what was stored: it ends on its own
    h.now = () => Date.now() + 1_000_000_000_000
    await Bun.sleep(300)
    expect(kept).toEqual({})
    expect(log.at(-1)).toContain('expired')
  })

  test('one already past its time ends when the restart looks, logged, and the line goes on', () => {
    const at = 1_700_000_000_000
    const kept: Record<string, Hold> = { [REPO]: { by: 'Atena', why: 'land a fix', at, until: at + 1000 } }
    const { h, log, changed } = host(kept)
    h.now = () => at + 60_000
    const holds = new LineHolds(h)
    expect(log).toEqual([])
    holds.start()
    expect(kept).toEqual({})
    expect(log).toHaveLength(1)
    expect(log[0]).toContain('line hold on lyvora-app expired')
    expect(changed).toEqual([REPO])
    expect(holds.on(REPO)).toBe(false)
  })
})
