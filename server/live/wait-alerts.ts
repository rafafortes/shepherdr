// What waits on you, told by a command of yours too (Settings → Alert command, alerts.command): your own notifier, a
// Telegram bot or a desktop notification. Each wait of Needs you (a question, a plan, a choice, a permission, a start's
// screen, a task that waits on you) that is still open alerts.after after it was first seen runs the command once, as
// `<command> <title> <message> <key>`; one answered sooner runs nothing, and one that opens again is a new wait. What
// waits and what was told are kept in wait-alerts.json, so a restart of Shepherdr tells nothing twice. While the command
// is off every wait counts as told: turning it on tells what comes next, never a backlog.
import { spawn } from 'node:child_process'
import { readJson, writeJson } from '../store.ts'

/** one wait: its key (its chat and request, the same for as long as it waits), and its words, read only when it is told */
export interface Wait {
  key: string
  words: () => { title: string; body: string }
}

interface State {
  /** each wait open at the last look: when it was first seen, and whether it was told */
  waits: Record<string, { seen: number; told?: true }>
}

const FILE = 'wait-alerts.json'

/** a key a command can use as a name: letters, digits, dots, dashes and underscores, once each wait */
export const keyWords = (key: string, seen: number) => `shepherdr-${key}-${seen}`.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200)

export class WaitAlerts {
  private state: State | undefined
  constructor(private run: (command: string, args: string[]) => void = runCommand) {}

  /**
   * One look at what waits now: a wait seen for the first time is noted; one that waited `after` and was not told is told;
   * one no longer open is forgotten. `command`: none while it is off (every wait counts as told then)
   */
  look(waits: Wait[], o: { command?: string; after: number }, now = Date.now()) {
    const s = (this.state ??= readJson<State>(FILE, { waits: {} }))
    const before = JSON.stringify(s)
    const open = new Set(waits.map((w) => w.key))
    for (const k of Object.keys(s.waits)) if (!open.has(k)) delete s.waits[k]
    for (const w of waits) {
      const x = (s.waits[w.key] ??= { seen: now, ...(o.command ? {} : { told: true as const }) })
      if (!o.command) x.told = true
      if (x.told || now - x.seen < o.after) continue
      x.told = true
      const { title, body } = w.words()
      this.run(o.command!, [title, body, keyWords(w.key, x.seen)])
    }
    if (JSON.stringify(s) !== before) writeJson(FILE, s)
  }
}

/** the command through sh, so ~ and words of its own work; what is told goes in as its arguments, never as words of the
 *  shell. It runs on its own: Shepherdr never waits for it, and only says when it could not run or failed */
export function runCommand(command: string, args: string[]) {
  const p = spawn('sh', ['-c', `${command} "$@"`, 'shepherdr-alert', ...args], { stdio: 'ignore', detached: true })
  p.on('error', (e) => console.error(`shepherdr: the alert command did not run: ${e.message}`))
  p.on('exit', (code) => {
    if (code) console.error(`shepherdr: the alert command ended with ${code}`)
  })
  p.unref()
}
