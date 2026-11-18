// What waits on you, told by a command of yours too (Settings → Notifications → Alert command, alerts.command): your own notifier, a
// Telegram bot or a desktop notification. Each wait of Needs you (a question, a plan, a choice, a permission, a start's
// screen, a task that waits on you) that is still open alerts.after after it was first seen runs the command once, as
// `<command> <title> <message> <key>`; one answered sooner runs nothing, and one that opens again is a new wait. A wait
// the human was told about that then ends (answered, by a relay, by the advisor, or the task moved on) runs the
// optional done command once as `<doneCommand> <key> <how>`, with the same key the alert got, so a notifier can mark the
// message it sent (alerts.doneCommand; off by default). What waits and what was told are kept in wait-alerts.json, so a
// restart of Shepherdr tells nothing twice. While the command is off every wait counts as told: turning it on tells what
// comes next, never a backlog.
import { spawn } from 'node:child_process'
import { readJson, writeJson } from '../store.ts'

/** one wait: its key (its chat and request, the same for as long as it waits), and its words, read only when it is told */
export interface Wait {
  key: string
  words: () => { title: string; body: string }
  /** a delay of its own instead of the one for every wait: the advisor gets first refusal on a question it will take
   *  by itself (source.ts), so the normal alert waits until it has had its turn */
  after?: number
  /** how this wait ended, in words for the done command; read only when it ends, never while it is still open */
  ended?: () => string
  /** is what it waits on still open, even though it left the look for another reason (a typed message holding its
   *  task in Working)? Such a wait is kept as it was: no done command and no second alert if it comes back */
  stillOpen?: () => boolean
}

interface State {
  /** each wait open at the last look: when it was first seen, whether it was told, and whether the alert really ran
   *  (a wait counted as told while the command was off was never sent, so ending it marks nothing) */
  waits: Record<string, { seen: number; told?: true; sent?: true }>
}

/** how to name a wait that ended with no ending words of its own */
const ENDED = 'No longer waiting'

const FILE = 'wait-alerts.json'

/** a key a command can use as a name: letters, digits, dots, dashes and underscores, once each wait */
export const keyWords = (key: string, seen: number) => `shepherdr-${key}-${seen}`.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200)

export class WaitAlerts {
  private state: State | undefined
  /** the waits as they were last seen, kept in memory only: a wait no longer in the next look has its ending words here */
  private last = new Map<string, Wait>()
  constructor(private run: (command: string, args: string[]) => void = runCommand) {}

  /**
   * One look at what waits now: a wait seen for the first time is noted; one that waited `after` and was not told is told;
   * one no longer open is forgotten, and one that was really told runs the done command with how it ended. `command`:
   * none while it is off (every wait counts as told then).
   */
  look(waits: Wait[], o: { command?: string; after: number; doneCommand?: string; skipDone?: string[] }, now = Date.now()) {
    const s = (this.state ??= readJson<State>(FILE, { waits: {} }))
    const before = JSON.stringify(s)
    const open = new Set(waits.map((w) => w.key))
    // left out for a policy reason (a coordinator whose space's Notify is Off), not because it ended: it is forgotten
    // as before so turning Notify back on is a new wait, but no done command marks a wait that is still open
    const skipped = new Set(o.skipDone ?? [])
    // a told wait that no longer waits is marked once, with the ending words from the last look; a command that fails
    // only says so in its log (runCommand), the wait is forgotten either way, and one still open is never marked
    for (const [k, x] of Object.entries(s.waits)) {
      if (open.has(k)) continue
      // the card may still be open even though its task stopped reading Needs you (a typed message, a grace period):
      // keep the wait untouched, so nothing marks it answered and the same card cannot alert again under a new key
      if (this.last.get(k)?.stillOpen?.()) continue
      delete s.waits[k]
      if (x.sent && o.doneCommand && !skipped.has(k)) {
        // the wait is already marked: a command that throws or fails must not bring it back or stop the others
        try {
          this.run(o.doneCommand, [keyWords(k, x.seen), this.last.get(k)?.ended?.() ?? ENDED])
        } catch (e) {
          console.error(`shepherdr: the done command did not run: ${(e as Error).message}`)
        }
      }
    }
    for (const w of waits) {
      const x = (s.waits[w.key] ??= { seen: now, ...(o.command ? {} : { told: true as const }) })
      if (!o.command) x.told = true
      if (x.told || now - x.seen < (w.after ?? o.after)) continue
      x.told = true
      x.sent = true
      const { title, body } = w.words()
      this.run(o.command!, [title, body, keyWords(w.key, x.seen)])
    }
    this.last = new Map(waits.map((w) => [w.key, w]))
    if (JSON.stringify(s) !== before) writeJson(FILE, s)
  }
}

/** the command through sh, so ~ and words of its own work; what is told goes in as its arguments, never as words of the
 *  shell. It runs on its own: Shepherdr never waits for it, and only says when it could not run or failed */
export function runCommand(command: string, args: string[]) {
  const p = spawn('sh', ['-c', `${command} "$@"`, 'shepherdr-alert', ...args], { stdio: 'ignore', detached: true })
  p.on('error', (e) => console.error(`shepherdr: the command did not run: ${e.message}`))
  p.on('exit', (code) => {
    if (code) console.error(`shepherdr: the command ended with ${code}`)
  })
  p.unref()
}
