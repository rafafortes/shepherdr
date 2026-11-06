// Autopilot's heartbeat, as OpenClaw's: on its trigger's time rule (Settings → Autopilot: every 30 minutes, all day), a
// coordinator on Autopilot gets one fixed prompt in its own session: go through its HEARTBEAT.md, its standing
// checklist in plain words, and act on what needs it, or else reply with only <no-reply> (the chat shows none of it, and
// a quiet line says it woke and had nothing to do, so a quiet night is not mistaken for a broken heartbeat). Only
// while it is idle: a busy one gets it once its turn is over. None while its HEARTBEAT.md is empty and no news waits.
// News its trigger's event rules name (all news by default) wakes the coordinator at once; other news waits here and
// comes with the next heartbeat. Run now (Settings → Autopilot, the chat's pill, shepherdr heartbeat run) asks for one
// wake at once, one per tap.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HOME, readJson, writeJson } from '../store.ts'
import { nextRun } from './trigger.ts'

/** a place's HEARTBEAT.md, in Shepherdr's own folder (a worker's for another machine's places, on the main machine):
 *  never a path for the coordinator, whose machine may not have it. It reads the checklist in its heartbeat and with
 *  shepherdr heartbeat, and edits it with shepherdr heartbeat set, or the human in Settings */
export const heartbeatFile = (place: string) => join(HOME, 'heartbeat', `${place.replace(/[^\w.-]+/g, '-')}.md`)

/** the checklist a coordinator starts with, by what it does: a space's work; a home space's its machine's too; the
 *  main machine's home space's every machine's overview too */
export function firstChecklist(role: 'space' | 'home' | 'main') {
  const machine = ['Disk, memory and load: clean up only what is safely finished, pause tasks only when it struggles.', 'Spaces whose tasks are stuck, or that have queued work and room to start it.']
  const items =
    role === 'space'
      ? [
          'Tasks stuck or stalled: look at their chat, then nudge them, stop them or tell the human.',
          'Main red on GitHub: one small fix-forward task, unless one is at work.',
          'Queued or To do tasks that may start now: start them.',
          'Ready tasks whose brief says they merge themselves but haven’t: see them through.',
          'Live links the human uses still answer.',
        ]
      : role === 'home'
        ? machine
        : [...machine, 'Anything waiting on the human across machines: alert only what can’t wait.', 'A machine whose herdr stopped answering, or whose home space went quiet.']
  return ['# Heartbeat', '', 'What to check each heartbeat. Edit it in Settings → Autopilot, or ask your coordinator to.', '', ...items.map((x) => `- ${x}`), '', '## Goals', '', '- (this place’s goals, for the coordinator to keep in mind)', ''].join('\n')
}

interface Beat {
  /** the last heartbeat, or when it went on Autopilot: the next is the time rule's first after it */
  last?: number
  /** news its event rules let wait for the next heartbeat, oldest first */
  held?: string[]
}

/** news kept for the next heartbeat, at most */
const HELD = 30

export class Heartbeats {
  private s: Record<string, Beat> = readJson('heartbeats.json', {})

  private save() {
    writeJson('heartbeats.json', this.s)
  }

  private of(place: string) {
    return (this.s[place] ??= {})
  }

  /** its HEARTBEAT.md: the first checklist for its role until there is one (written: `keep`) */
  read(place: string, role: 'space' | 'home' | 'main', keep = false) {
    const f = heartbeatFile(place)
    if (existsSync(f)) return readFileSync(f, 'utf8')
    const first = firstChecklist(role)
    if (keep) this.write(place, first)
    return first
  }

  write(place: string, text: string) {
    const f = heartbeatFile(place)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, text.endsWith('\n') || !text ? text : `${text}\n`)
  }

  last(place: string) {
    return this.s[place]?.last
  }

  /** Autopilot went on: the first heartbeat is the time rule's first from now. Off: forgotten */
  switched(place: string, on: boolean, now = Date.now()) {
    if (on) this.of(place).last = now
    else delete this.s[place]
    this.save()
  }

  /** the next heartbeat by its time rule (in a zone), or nothing (no time rule, or it is over) */
  next(place: string, rule: string, zone: string, now = Date.now()) {
    return nextRun(rule, zone, this.s[place]?.last ?? now)
  }

  /** is a heartbeat due: its time rule's first run after the last has come. One first seen starts counting now. Whether the coordinator is idle is the caller's to say. */
  due(place: string, rule: string, zone: string, now = Date.now()) {
    const b = this.of(place)
    if (!b.last) {
      b.last = now
      this.save()
      return false
    }
    const at = nextRun(rule, zone, b.last)
    return at !== undefined && at <= now
  }

  /** news that waits for the next heartbeat */
  hold(place: string, line: string) {
    const b = this.of(place)
    b.held = [...(b.held ?? []), line].slice(-HELD)
    this.save()
  }

  held(place: string) {
    return this.s[place]?.held ?? []
  }

  /** the heartbeat prompt, with the news that waited; it counts as given. None when its checklist is empty and no news
   *  waits: the rule starts again. */
  beat(place: string, role: 'space' | 'home' | 'main', now = Date.now()): string | undefined {
    // on disk from now on, as the human and the coordinator see and edit it
    const list = this.read(place, role, true).trim()
    const b = this.of(place)
    const held = b.held ?? []
    b.last = now
    delete b.held
    this.save()
    return list || held.length ? heartbeatPrompt(list, held) : undefined
  }
}

/** the fixed heartbeat prompt, with the checklist itself in it: the coordinator may run on another machine than the
 *  file */
export function heartbeatPrompt(list: string, held: string[] = []) {
  return [
    list
      ? `Heartbeat. Go through your HEARTBEAT.md: act on what needs it, by your Autopilot rules and any limits it sets. Don't redo or repeat old work from earlier in this chat. To change it: shepherdr heartbeat set.\n\nYour HEARTBEAT.md:\n${list}`
      : 'Heartbeat. Your HEARTBEAT.md is empty: only the news below.',
    ...(held.length ? [`News since the last heartbeat, which your trigger let wait (act on it by your Autopilot rules):\n${held.map((x) => `- ${x}`).join('\n')}`] : []),
    'If nothing needs you, reply with only <no-reply>heartbeat: nothing to do</no-reply>.',
  ].join('\n\n')
}

/* ---------- Run now: one wake on the human's word ---------- */

/** the wake a chat line brought, when it is one: Shepherdr's hidden heartbeat in the agent's log, with why it came
 *  (`reason="run now"` for a tap; the time rule's own has none) */
export function wakeOf(text: string): { reason?: string } | undefined {
  const m = /<shepherdr[^>]*>\s*<heartbeat(?:\s+reason="([^"]*)")?\s*>/.exec(text)
  return m ? (m[1] ? { reason: m[1] } : {}) : undefined
}

/** an Autopilot wake as it went: why it came, the steps it took, and whether it answered with nothing */
export interface Woke {
  reason?: string
  steps: number
  /** its reply said nothing (`<no-reply>`): a quiet wake */
  quiet: boolean
  /** its reply had words of its own: they follow in the chat, and this line says no more */
  said: boolean
}

/** a wake's one quiet line in the chat: why it woke, then how it went once it answered with nothing. Says nothing more
 *  while it works, or once it said something itself: its words follow */
export function pilotLine(w: Woke): string {
  const head = `Autopilot woke · ${w.reason === 'run now' ? 'Run now' : 'on schedule'}`
  return w.quiet && !w.said ? `${head} · ${w.steps ? 'checked, nothing new' : 'nothing to do'}` : head
}

/** what a place is, for Run now: enough of it to refuse honestly, from anywhere */
export interface Wakeable {
  name: string
  /** its coordinator is on Autopilot */
  autopilot: boolean
  /** it belongs to another machine: only that machine wakes it */
  elsewhere?: boolean
  /** herdr answers on this machine */
  reachable: boolean
  /** a wake already waits or runs */
  state?: 'queued' | 'waking'
  /** its HEARTBEAT.md, as it stands */
  checklist: string
  /** news its event rules let wait, for the next heartbeat */
  held: number
}

/** why Run now is refused for this place, or undefined when it may go: one wake at a time, only on Autopilot, only on
 *  its own machine, and only with something to go through */
export function wakeProblem(w: Wakeable): string | undefined {
  if (w.elsewhere) return `${w.name} is on another machine: wake it there.`
  if (!w.autopilot) return `${w.name} is not on Autopilot: switch it on first.`
  if (!w.reachable) return `herdr does not answer: nothing can wake ${w.name}'s coordinator.`
  if (w.state) return `${w.name}'s coordinator is already waking: one wake at a time.`
  if (!w.checklist.trim() && !w.held) return `Nothing to run: ${w.name}'s HEARTBEAT.md is empty and no news waits for it.`
  return undefined
}

/** how long a wake or a tap holds its place at most: then it is taken for lost (herdr went down, its turn never ended),
 *  so one lost wake never blocks the next */
const WAKE_LOST = 10 * 60_000

/** Autopilot's Run now, as the state machine the live source drives: a tap waits for its coordinator to be idle and
 *  then goes once; while one waits or runs, another is refused. A wake ends once its turn was seen working and is over
 *  (or after WAKE_LOST), so the next tap is free again. */
export class Wakes {
  private waiting = new Map<string, number>()
  private running = new Map<string, number>()
  private worked = new Set<string>()

  /** what a place's Run now is doing now */
  state(place: string): 'queued' | 'waking' | undefined {
    return this.running.has(place) ? 'waking' : this.waiting.has(place) ? 'queued' : undefined
  }

  /** takes a tap: false while one already waits or runs (it is refused) */
  ask(place: string, now = Date.now()): boolean {
    if (this.state(place)) return false
    this.waiting.set(place, now)
    return true
  }

  /** the tap that goes now, as its coordinator is idle: the caller sends it */
  take(place: string, now = Date.now()): boolean {
    if (!this.waiting.has(place)) return false
    this.waiting.delete(place)
    this.mark(place, now)
    return true
  }

  /** a wake sent straight away (its coordinator was idle when the tap came) */
  mark(place: string, now = Date.now()) {
    this.running.set(place, now)
    this.worked.delete(place)
  }

  /** its coordinator works now, or is free again: a wake ends once it was seen working and then free, so the same tick
   *  that sends one never ends it */
  observe(place: string, working: boolean, now = Date.now()) {
    const at = this.running.get(place)
    if (at === undefined) return
    if (working) this.worked.add(place)
    else if (this.worked.has(place) || now - at > WAKE_LOST) this.forget(place)
  }

  /** Autopilot off, or its wake lost: nothing waits or runs here */
  forget(place: string) {
    this.waiting.delete(place)
    this.running.delete(place)
    this.worked.delete(place)
  }

  /** a tap or a wake older than WAKE_LOST stops holding the place: herdr went down, or its turn never ended */
  prune(now = Date.now()) {
    for (const [place, at] of this.waiting) if (now - at > WAKE_LOST) this.waiting.delete(place)
    for (const [place, at] of this.running) if (now - at > WAKE_LOST) this.forget(place)
  }
}
