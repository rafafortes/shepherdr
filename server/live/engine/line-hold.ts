// The merge line's hold (shepherdr line hold, docs/tasks.md): one repo's line kept from starting its next turn, so a commit
// made by hand can be gated and landed with the base guaranteed not to move under it. The line itself (one merge at a time per
// repo, in the order merges asked) is merge.ts's; this holds the state a hold needs and nothing of the merge's own work.
//
// A hold is in one of two states. WAITING: asked for while a merge or gate of that repo is in flight. It does not stop
// that merge, but it already keeps the next turn from starting (every turn passes `gate` first), so nothing slips in ahead
// of it, and it takes effect the moment the merge in flight ends. IN EFFECT: stored with its expiry (tasks.json, so it
// survives a restart), no turn starts until it is released or expires. Whoever holds is never a task's agent (the command
// checks that), and the expiry is the safety: a holder that crashed cannot block the line for more than an hour.

/** a hold in effect: who holds, why, since when and until when (ms) */
export interface Hold {
  by: string
  why: string
  at: number
  until: number
}

/** how long a hold lasts when `--for` is not given, and the longest it may be asked for */
export const HOLD_DEFAULT = 20 * 60_000
export const HOLD_MAX = 60 * 60_000

/** what asking for a hold ends in: it is in effect, or why it is not (and nothing is left behind) */
export type Held = { ok: true; hold: Hold } | { ok: false; error: string }

/** what the hold needs of its owner (merge.ts, the engine) */
export interface HoldHost {
  /** the holds in effect, by repo path: the engine's own record, kept in tasks.json */
  stored(): Record<string, Hold>
  /** the record changed: write it */
  save(): void
  /** one line of the server's log */
  log(line: string): void
  /** the repo's line changed (a hold began, ended or was asked for): rows that read it are said again */
  changed(repo: string): void
  /** the repo's space, for words */
  name(repo: string): string
  /** the clock, in ms (a test's own) */
  now(): number
}

/** a time of day, as the hold's words say it ("14:42"), in the machine's zone */
export const clockOf = (ms: number, zone?: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone }).format(ms)

/** a span of time in words, for a wait: seconds under a minute, else minutes */
export const spanOf = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`)

/** a hold's reason on one line, as the log and the rows keep it */
export const whyLine = (why: string) => why.replace(/\s+/g, ' ').trim().slice(0, 200)

export class LineHolds {
  /** a hold asked for while a merge runs: who, why, how long it will last once in effect, and how it ends */
  private waiting = new Map<string, { by: string; why: string; at: number; ms: number; end: (r: Held) => void }>()
  /** each hold in effect's expiry */
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** the turns waiting at the gate, per repo */
  private gates = new Map<string, (() => void)[]>()

  constructor(private host: HoldHost) {
    // holds a restart found: each goes on to its time. (One already past its time ends at the first look, `start` or any
    // question about the line, and is logged then.)
    for (const [repo, hold] of Object.entries(this.host.stored())) if (hold.until > this.host.now()) this.arm(repo, hold)
  }

  /** the holds a restart found are looked at: one past its time ends now, logged, and the line goes on */
  start() {
    for (const repo of Object.keys(this.host.stored())) this.active(repo)
  }

  /** the hold in effect in `repo`, if any, without changing anything (what a row says) */
  peek(repo: string): Hold | undefined {
    const hold = this.host.stored()[repo]
    return hold && hold.until > this.host.now() ? hold : undefined
  }

  /** the hold in effect in `repo`, if any (one past its time is over: ended here, logged) */
  active(repo: string): Hold | undefined {
    const hold = this.peek(repo)
    if (!hold && this.host.stored()[repo]) this.expire(repo)
    return hold
  }

  /** who waits to hold `repo`, if anyone */
  pending(repo: string): { by: string; why: string; at: number } | undefined {
    const w = this.waiting.get(repo)
    return w && { by: w.by, why: w.why, at: w.at }
  }

  /** whether the line of `repo` is held, in effect or asked for: no turn starts */
  on(repo: string) {
    return !!this.active(repo) || this.waiting.has(repo)
  }

  /** a turn of `repo`'s line waits here until it is neither held nor asked to be held; each turn then goes on in its order */
  async gate(repo: string) {
    while (this.on(repo)) await new Promise<void>((go) => this.gates.set(repo, [...(this.gates.get(repo) ?? []), go]))
  }

  /**
   * Hold `repo`'s line for `ms`, in one go: with no merge in flight (`flying` false) it is in effect at once; with one, it
   * waits for it (see `reserve`). Asking for a line that is held, or already asked for, says who holds it.
   */
  ask(repo: string, who: { by: string; why: string }, ms: number, flying: boolean, waitMs: number): Promise<Held> {
    const r = this.reserve(repo, who, ms, flying, waitMs)
    if (!r.ok) return Promise.resolve(r)
    if (!flying) this.idle(repo)
    return r.done
  }

  /**
   * The first half of a hold: the request reserves the line's next turn, synchronously, before anything is awaited. From this
   * moment no turn of `repo` starts, though the merge in flight, if any, goes on; the hold is in effect once `idle` says
   * nothing is in flight (at once, if nothing was), for at most `waitMs` of waiting: then it ends with no hold left behind.
   * `done` is how it ends. The caller checks what else it must (the space's kind of merge) and ends the reservation with
   * `cancel`, or lets it take effect.
   */
  reserve(repo: string, who: { by: string; why: string }, ms: number, flying: boolean, waitMs: number): { ok: false; error: string } | { ok: true; done: Promise<Held> } {
    const held = this.active(repo)
    const name = this.host.name(repo)
    if (held) return { ok: false, error: `${name}'s merge line is already held by ${held.by} until ${clockOf(held.until)}: ${held.why}. Release it first, or wait for it to end.` }
    const waits = this.waiting.get(repo)
    if (waits) return { ok: false, error: `${waits.by} is already waiting to hold ${name}'s merge line: ${waits.why}.` }
    const why = whyLine(who.why)
    const done = new Promise<Held>((resolve) => {
      const give = setTimeout(
        () => {
          this.waiting.delete(repo)
          this.open(repo)
          this.host.changed(repo)
          this.host.log(`line hold on ${name}: ${who.by} gave up waiting for the merge in flight to end (${spanOf(waitMs)}): nothing is held`)
          resolve({
            ok: false,
            error: `The merge in flight in ${name} did not end in ${spanOf(waitMs)}: nothing is held, and the line goes on as it was. Try again when it has ended.`,
          })
        },
        Math.max(1, waitMs),
      )
      this.waiting.set(repo, {
        by: who.by,
        why,
        at: this.host.now(),
        ms,
        end: (r) => {
          clearTimeout(give)
          resolve(r)
        },
      })
    })
    if (flying) this.host.log(`line hold on ${name}: ${who.by} waits for the merge in flight to end, and keeps the next turn from starting (${why})`)
    this.host.changed(repo)
    return { ok: true, done }
  }

  /** a reservation is given up without a word in the log (the caller had a reason of its own, and says it): nothing is held,
   *  whether the hold had taken effect meanwhile or still waited */
  cancel(repo: string, error: string) {
    const w = this.waiting.get(repo)
    this.waiting.delete(repo)
    w?.end({ ok: false, error })
    if (this.host.stored()[repo]) {
      delete this.host.stored()[repo]
      clearTimeout(this.timers.get(repo))
      this.timers.delete(repo)
      this.host.save()
    }
    this.open(repo)
    this.host.changed(repo)
  }

  /** the merge in flight in `repo` has ended and nothing else is: a hold that waited for it is in effect now */
  idle(repo: string) {
    const w = this.waiting.get(repo)
    if (!w) return
    this.waiting.delete(repo)
    w.end({ ok: true, hold: this.take(repo, w.by, w.why, w.ms) })
  }

  /** end the hold of `repo` now, or the wait for one: who held (or waited), or nothing when the line was not held */
  release(repo: string, by: string): { state: 'held' | 'waiting'; by: string; why: string } | undefined {
    const name = this.host.name(repo)
    const held = this.active(repo)
    if (held) {
      delete this.host.stored()[repo]
      clearTimeout(this.timers.get(repo))
      this.timers.delete(repo)
      this.host.save()
      this.host.log(`line hold on ${name} released by ${by} (held by ${held.by} since ${clockOf(held.at)}: ${held.why})`)
      this.open(repo)
      this.host.changed(repo)
      return { state: 'held', by: held.by, why: held.why }
    }
    const w = this.waiting.get(repo)
    if (!w) return undefined
    this.waiting.delete(repo)
    w.end({ ok: false, error: `${by} released the wait for ${name}'s merge line: nothing is held.` })
    this.host.log(`line hold on ${name}: ${w.by}'s wait released by ${by}: nothing is held`)
    this.open(repo)
    this.host.changed(repo)
    return { state: 'waiting', by: w.by, why: w.why }
  }

  /** the hold takes effect: stored with its expiry, the line's turns wait, the hold ends by itself at its time */
  private take(repo: string, by: string, why: string, ms: number): Hold {
    const at = this.host.now()
    const hold = { by, why, at, until: at + ms }
    this.host.stored()[repo] = hold
    this.host.save()
    this.arm(repo, hold)
    this.host.log(`line hold on ${this.host.name(repo)}: ${by} holds the merge line until ${clockOf(hold.until)} (${why})`)
    this.host.changed(repo)
    return hold
  }

  /** the timer that ends a hold at its time */
  private arm(repo: string, hold: Hold) {
    clearTimeout(this.timers.get(repo))
    this.timers.set(repo, setTimeout(() => this.expire(repo), Math.max(0, hold.until - this.host.now())).unref())
  }

  /** a hold reached its time: the line goes on, and the server's log says so */
  private expire(repo: string) {
    const hold = this.host.stored()[repo]
    if (!hold) return
    delete this.host.stored()[repo]
    clearTimeout(this.timers.get(repo))
    this.timers.delete(repo)
    this.host.save()
    this.host.log(`line hold on ${this.host.name(repo)} expired at ${clockOf(hold.until)} (held by ${hold.by} since ${clockOf(hold.at)}: ${hold.why}): the line goes on`)
    this.open(repo)
    this.host.changed(repo)
  }

  /** the turns waiting at the gate go on, each to see whether the line is still held */
  private open(repo: string) {
    const going = this.gates.get(repo) ?? []
    this.gates.delete(repo)
    for (const go of going) go()
  }
}
