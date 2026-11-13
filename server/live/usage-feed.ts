// The usage feed: reads the model calls out of the logs of Shepherdr's own agents (agents.json's records, each log file
// they name, and nothing else: never another session folder) into the usage ledger (usage-ledger.ts). Each log is read
// from where the ledger left it, so a restart reads on, and the first run reads every log from its start: that is the
// backfill, done once. A pass reads about `budget` bytes and goes on in the next turn of the event loop, so a long log
// never holds the server up; once every log is read to its end, the rest is a read of what was written since, each
// minute.
import { existsSync } from 'node:fs'
import type { AgentRecord } from './agents.ts'
import { logKind } from './readers/find.ts'
import { LogTail, readerFor } from './readers/index.ts'
import { modelKey, type UsageLedger } from './usage-ledger.ts'

/** bytes one pass reads before it lets the server answer */
const BUDGET = 2 << 20
/** how often the logs are read for what was written since, once the backfill is done */
const EVERY = 60_000

export class UsageFeed {
  private tails = new Map<string, LogTail>()
  private timer?: ReturnType<typeof setInterval>
  private running = false

  constructor(
    private ledger: UsageLedger,
    private records: () => Record<string, AgentRecord>,
  ) {}

  /** one pass: each log of each record read on from the ledger's position, up to `budget` bytes. true when some log is
   *  still behind (the next pass goes on where this one stopped) */
  pass(now = Date.now(), budget = BUDGET): boolean {
    let left = budget
    let behind = false
    const files = new Set<string>()
    for (const [chat, r] of Object.entries(this.records())) {
      for (const f of r.logs) {
        files.add(f)
        if (left <= 0) {
          behind = true
          continue
        }
        // OpenCode's log is a copy its reader makes of the session (LogTail.refresh): a copy that does not exist yet is made by the read
        if (!existsSync(f) && logKind(f) !== 'opencode') continue
        let t = this.tails.get(f)
        if (!t) {
          // each by its own CLI's reader: a backup agent's logs follow the first one's (as Chats reads them)
          const reader = readerFor(logKind(f) ?? r.kind)
          if (!reader) continue
          t = new LogTail(f, reader)
          const at = this.ledger.position(f)
          if (at) t.seek(at)
          this.tails.set(f, t)
        }
        const was = t.done
        const events = t.read(left)
        left -= Math.max(0, t.done - was)
        for (const e of events) {
          if (e.kind === 'usage') this.ledger.count(chat, modelKey(t.reader.cli, e.model), e, now)
        }
        if (t.done !== was || events.length) this.ledger.setPosition(f, t.position)
        if (t.behind) behind = true
      }
    }
    // a log no record names any more is no longer read (its chat was removed); what it counted stays
    this.ledger.keepFiles(files)
    for (const f of this.tails.keys()) if (!files.has(f)) this.tails.delete(f)
    return behind
  }

  /** starts the reads: now, then each minute; the backfill goes on in turns until every log is read to its end */
  start() {
    this.timer = setInterval(() => this.run(), EVERY)
    this.timer.unref?.()
    this.run()
  }

  stop() {
    clearInterval(this.timer)
    this.ledger.flush()
  }

  private run() {
    if (this.running) return
    this.running = true
    const step = () => {
      const behind = this.pass()
      if (behind) return void setTimeout(step, 0)
      this.running = false
      this.ledger.markBackfilled()
    }
    step()
  }
}
