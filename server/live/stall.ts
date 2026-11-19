// Shepherdr's own event loop, watched: it is one thread, so a pass that takes seconds (a snapshot of many agents, a pile of
// log reads) holds up everything else, herdr's connections among it (herdr closes one whose request comes late). A tick
// every `every` ms that arrives `over` ms late says the loop stalled, and the slow passes that ran since the last tick say
// what held it. Those are the passes `run` timed: the loops and what the screen asks for, by name.

export interface Stall {
  /** when the late tick came */
  at: number
  /** how long it was late, ms */
  late: number
  /** the slow passes since the tick before it, the slowest first, their times added by name */
  ran: { label: string; ms: number }[]
}

interface Options {
  /** the tick, ms */
  every?: number
  /** a tick this much later than it should have been is a stall, ms */
  over?: number
  /** a pass this long is kept to be named, ms */
  slow?: number
  now?: () => number
  log?: (line: string) => void
}

const KEEP = 20

export class StallWatch {
  /** the latest stalls, oldest first */
  readonly stalls: Stall[] = []
  /** how many there were since this started */
  count = 0
  private passes: { label: string; ms: number; at: number }[] = []
  private last: number
  private timer?: ReturnType<typeof setInterval>
  private every: number
  private over: number
  private slow: number
  private now: () => number
  private log: (line: string) => void

  constructor(o: Options = {}) {
    this.every = o.every ?? 250
    this.over = o.over ?? 1000
    this.slow = o.slow ?? 100
    this.now = o.now ?? Date.now
    this.log = o.log ?? ((line) => console.error(line))
    this.last = this.now()
  }

  start() {
    this.last = this.now()
    this.timer = setInterval(() => this.tick(), this.every)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** `f`, timed: a pass that holds the loop for `slow` ms or more is kept, to be named by the stall it may cause. Only what
   *  runs before it returns counts (an async function's first stretch), since that is what holds the loop */
  run<T>(label: string, f: () => T): T {
    const began = this.now()
    try {
      return f()
    } finally {
      const ms = this.now() - began
      if (ms >= this.slow) {
        this.passes.push({ label, ms, at: began + ms })
        if (this.passes.length > 200) this.passes.splice(0, this.passes.length - 100)
      }
    }
  }

  /** the tick: late by `over` ms or more makes a stall. Public for a test that holds the clock */
  tick(): Stall | undefined {
    const now = this.now()
    const late = now - this.last - this.every
    const since = this.last
    this.last = now
    const done = this.passes.filter((p) => p.at > since)
    this.passes = this.passes.filter((p) => p.at >= now - 60_000)
    if (late < this.over) return undefined
    const by = new Map<string, number>()
    for (const p of done) by.set(p.label, (by.get(p.label) ?? 0) + p.ms)
    const ran = [...by].map(([label, ms]) => ({ label, ms })).sort((a, b) => b.ms - a.ms)
    const stall: Stall = { at: now, late, ran }
    this.count++
    this.stalls.push(stall)
    if (this.stalls.length > KEEP) this.stalls.shift()
    this.log(`shepherdr: the event loop stalled for ${seconds(late)} s, until ${new Date(now).toTimeString().slice(0, 8)}; ${words(ran)}`)
    return stall
  }

  /** what `shepherdr doctor` says: nothing while there were none, else how many and the latest with what ran */
  report(clock: (t: number) => string = (t) => new Date(t).toTimeString().slice(0, 8)): string[] {
    if (!this.stalls.length) return []
    const worst = this.stalls.reduce((a, b) => (b.late > a.late ? b : a))
    return [
      `Event loop: ${this.count} stall${this.count === 1 ? '' : 's'} of ${seconds(this.over)} s or more since this server started (worst ${seconds(worst.late)} s at ${clock(worst.at)}); a stall makes herdr drop the calls Shepherdr sends late`,
      ...this.stalls.slice(-5).map((s) => `  ${clock(s.at)}: ${seconds(s.late)} s late; ${words(s.ran)}`),
    ]
  }
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

const words = (ran: Stall['ran']) =>
  ran.length
    ? `slowest passes: ${ran
        .slice(0, 3)
        .map((r) => `${r.label} ${Math.round(r.ms)} ms`)
        .join(', ')}`
    : 'no pass it times was slow (something else held it: garbage collection, a blocking read or write, the host)'
