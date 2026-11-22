import { chatProblem } from './readers/index.ts'
import { LinkBackoff } from './recovery.ts'
// Every agent Shepherdr talks to is an ordinary herdr agent. This keeps which herdr agent and which log files belong
// to each chat, starts and resumes agents, and sends what you write: at once, even while the agent works (Claude Code,
// Codex and pi take it mid-turn, as steering). It waits only while the CLI shows a menu or permission prompt, where typed
// text could pick an option, or is still starting; then it goes in as soon as it can.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { Emitter } from '../source.ts'
import { home, readJson, writeJson } from '../store.ts'
import type { AgentRuntime, TermScreen } from '../../shared/types.ts'
import { stripControl } from '../../shared/keys.ts'
import { dropped, herdr, isPassing, missing, retrying, startDelays, Subscription, type AgentInfo, type AgentStatus, type HerdrError, type HerdrEvent } from './herdr.ts'
import { agyScreenBackground, ClaudeSessions, opencodeScreenBackground, Procs, screenBackground, servesCommand, sessionBackground, type Background } from './readers/background.ts'
import { claudeHome, claudeLogPath, cwdCandidates, findAgyLog, findClaudeLog, findCodexLog, findLog, findOpencodeLog, findPiLog, logKind, type LogCwd } from './readers/find.ts'
import { createSession, mirrorSession, opencodeLogPath, opencodeSubagentRunning, putInstructions, switchModel } from './opencode.ts'
import { agyLogPath, agyModelId, mirrorConversation } from './agy.ts'
import { agyIds, effortFor, modelArg } from './models.ts'
import { tag } from './chatlines.ts'
import { codexPermissionHook, hookSettings, HookLogs, type Said } from './readers/hooks.ts'
import * as task from './mfs.ts'
import { boxDir, mirrored } from './mfs.ts'
import { agentEnv, BOX, helperDir, run, runSync } from './box.ts'
import { ROOT } from '../root.ts'
import { leftAtPrompt } from './commands.ts'
import { agentWrong, type Wrong } from './revive.ts'
import { readCodexRuntime } from './codex-runtime.ts'
import { SecretAccess } from './secret-access.ts'
import { barePrompt, isAgentProcess } from './agent-process.ts'
import { launchesAgents, skippedLaunch } from './launch-policy.ts'
import { capture, end as endProcesses, endDeps, readTree, systemSource, type Source } from './orphans.ts'
import { taskWorktreeKey } from './trust.ts'
import { startInPane } from './pane-agent.ts'

/** a log's name (its session id), wherever it lies: one named both by its mirrored path and by its own is one log */
const logName = (f: string) => f.slice(f.lastIndexOf('/') + 1)

/** one path per session is enough for a chat to resume, and a record that restarts over and over must not grow
 *  agents.json for ever. The last sessions are the ones the agent resumes from and a chat reads first. A chat that has
 *  been through more than this many sessions loses the transcript of the oldest ones; the bound is high enough that an
 *  ordinary task keeps all its history, and it is what keeps a long-lived record from growing the store without limit.
 *  The usage feed reads these paths too, so a trimmed session stops feeding new usage; what was counted stays. Applied
 *  on load (uniqueLogs) and as sessions are added (addLog). */
export const MAX_LOGS = 32

/** the logs with each one once, where it first came, by the path it was named by last (a session carried to another
 *  folder goes on there): the same log twice is read twice, and a big one holds up the server. Only the last MAX_LOGS
 *  sessions are kept. */
export function uniqueLogs(logs: string[]): string[] {
  const at = new Map<string, number>()
  const out: string[] = []
  for (const f of logs) {
    const i = at.get(logName(f))
    if (i === undefined) at.set(logName(f), out.length), out.push(f)
    else out[i] = f
  }
  return out.slice(-MAX_LOGS)
}

/** a log's time, or nothing when it vanished between the look and the stat (files do get pruned and mirrors rewritten) */
function mtime(f: string): number | undefined {
  try {
    return statSync(f).mtimeMs
  } catch {
    return undefined
  }
}

/** adds a log the record doesn't have yet; true when it was new or a dead path was replaced by a readable one */
function addLog(r: AgentRecord, f: string): boolean {
  const i = r.logs.findIndex((x) => logName(x) === logName(f))
  if (i < 0) {
    r.logs.push(f)
    if (r.logs.length > MAX_LOGS) r.logs.splice(0, r.logs.length - MAX_LOGS)
    return true
  }
  // a session is first named by a path guessed before its file existed (a symlink's remembered name, or the real
  // path): when a later look finds the same session under a folder that does hold it, follow it. Otherwise a chat
  // learned before the fix keeps its dead path for ever, and stays blank for the very session it is about. The newer
  // of two readable copies wins, so a carried copy that stopped growing never replaces the live one.
  if (r.logs[i] === f) return false
  const now = mtime(f)
  if (now === undefined) return false
  const was = mtime(r.logs[i])
  if (was === undefined || now > was) {
    r.logs[i] = f
    return true
  }
  return false
}

/** an OpenCode session's log: its mirror brought up to date once. The path comes back whether or not that worked (the
 *  next look reads it again), and a failure is said, never thrown */
function mirrorOpencode(id: string): string {
  const f = opencodeLogPath(home(), id)
  try {
    mirrorSession(id, f)
  } catch (e) {
    console.error(`shepherdr: could not mirror OpenCode session ${id}: ${(e as Error).message}`)
  }
  return f
}

/** an agy conversation's log, its mirror brought up to date once (as mirrorOpencode does; a failure is said, never thrown) */
function mirrorAgy(id: string): string {
  const f = agyLogPath(home(), id)
  try {
    mirrorConversation(id, f)
  } catch (e) {
    console.error(`shepherdr: could not mirror agy conversation ${id}: ${(e as Error).message}`)
  }
  return f
}

/** a Claude Code session, copied into the project folder of the cwd it resumes in (Claude Code looks for it only
 *  there) from wherever it was written on that machine; its log path, or nothing when there is none */
export function carryClaudeSession(id: string, cwd: LogCwd): string | undefined {
  const to = claudeLogPath(cwd, id)
  const sh = `[ -e "$1" ] && exit 0; src=$(ls -t "$2"/*/"$3.jsonl" 2>/dev/null | head -n 1); [ -n "$src" ] || exit 1; mkdir -p "$(dirname "$1")" && cp "$src" "$1"`
  return runSync(['/bin/sh', '-c', sh, 'carry', task.unmirrored(to), task.unmirrored(join(claudeHome(), 'projects')), id]).code === 0 ? to : undefined
}

export interface AgentRecord {
  /** chat key */
  key: string
  /** herdr agent name */
  name: string
  /** herdr agent kind: claude, codex, pi, opencode, agy */
  kind: string
  cwd: string
  /** herdr workspace label it lives in */
  workspace: string
  tab?: string
  model?: string
  effort?: string
  /** instructions appended to the CLI's system prompt (or sent first, hidden, where it has no such option) */
  system?: string
  /** log files, oldest first: one per session */
  logs: string[]
  /** the CLI's own session id (claude, pi), for resuming */
  sessionId?: string
  started: number
  /** set when the agent's run ended for good (task done): writing resumes it */
  finished?: boolean
  /** set when the idle sweep parked it (SHE-72): the run ended the same way a finish ends it, and the task row, its
   *  chat and shepherdr status say so. Cleared when it starts again */
  parked?: number
  /** Set explicitly on every launch (source.ts coordinators and engine.ts tasks): 'full' runs without the CLI's
   *  approvals; 'ask' keeps them, with this launch's own shepherdr verbs allowed by each CLI's own mechanism. No launch
   *  leaves it undefined, so a missing value can never silently mean 'full'. Which access a coordinator should have is
   *  an open question for the human (docs/tasks.md): until they answer, coordinators run with 'full' as they always have. */
  access?: 'full' | 'ask'
  /** environment for its terminal: who it is to the shepherdr command */
  env?: Record<string, string>
  /** where its hooks record what it reports of itself (Claude Code: readers/hooks.ts) */
  hooks?: string
  /** the CLI, model and effort Settings said for its role when it last started on them: a change since is offered as
   *  a restart in its chat (restart.ts) */
  set?: { kind: string; model?: string; effort?: string }
  /** the pane its last run was started in, and whether herdr still had that launch pending when it was last seen: a
   *  launch herdr dropped can leave that pane behind, and a relaunch closes it rather than sit beside it */
  lastPane?: string
  pendingLaunch?: boolean
  /** panes earlier runs of this chat opened that a newer run has taken over from, still in herdr: closed once the new
   *  run is up and they hold nothing the person typed, ignored until then (an older pane must never read Needs you) */
  superseded?: string[]
  /** this run was told to resume the session it had (start.ts: a session that is gone is the one case a start without
   *  one is the way on) */
  resumed?: boolean
  /** the next launch starts a new session, whatever it kept: the one it had is gone (start.ts) */
  fresh?: boolean
  /** the last start that threw, where it did, before a pane could be read: the reason a start failed (start.ts) */
  startError?: string
  /** a backup agent went in once, where the agent it backs up can't go on (source.ts cannotGoOn): another one waits for
   *  the human, so a backup that keeps failing never loops. A task's own record keeps the same mark (TaskRec.tookOver) */
  tookOver?: { from: string; to: string; why: string; at: number; step?: number; blocked?: boolean }
  /** a coordinator's takeover on its way (source.ts coordinatorCantGoOn): the cut-off it answers and its takeover before
   *  this one. Kept until the backup is up or it failed: a restart of Shepherdr in between takes it again */
  handover?: { r: { cut: string; tries: number; reason: string; words: string; over?: boolean; lasting?: boolean }; prior?: AgentRecord['tookOver']; at: number }
}

export interface OutItem {
  id: string
  key: string
  text: string
  /** a reaction line: shown as a faded pill until it goes in */
  reaction?: { message: string; emoji: string }
  at: number
  /** the screen's own id for it (Message.cid) */
  cid?: string
  /** a CLI command (/model, /compact): goes in only between turns */
  idle?: boolean
  /** a slash command you typed: Shepherdr follows what it does (commands.ts) */
  command?: boolean
}

/** what starts an agent: its record, the first thing it is told, and where its pane comes from when it isn't its
 *  workspace by label (a task's herdr worktree space) */
/** was: the label its workspace had before, renamed in place when that one is still open */
export type Spec = Omit<AgentRecord, 'logs' | 'started'> & { first?: string; pane?: () => Promise<string>; was?: string }

/** why what you send waits: a menu or permission prompt is up, the agent is starting, or (a CLI command) mid-turn */
export type Hold = 'menu' | 'start' | 'turn'

export interface SendOpts {
  /** a reaction line: shown as a faded pill until it goes in */
  reaction?: OutItem['reaction']
  /** starts (or resumes) the agent when it isn't running */
  ensure?: () => Promise<unknown>
  /** the screen's own id for it */
  cid?: string
  /** a CLI command: only between turns */
  idle?: boolean
  /** a slash command you typed (commands.ts) */
  command?: boolean
}

export interface Sent {
  waiting: boolean
  /** why it waits */
  waitsFor?: Hold
  item: OutItem
}

export const ROUTING_FAILURE = 'Could not provision private agent command routing'

/** A route write is given 5 s. A stalled event loop can kill it late and report the child as failed although the
 *  write landed, so a non-zero code is never the answer on its own: read the file, retry a couple of times with backoff
 *  once the loop is healthy again, and fail only when the route is really absent. All waits are timers: no busy-wait,
 *  no synchronous sleep, and a ceiling so a wedged server cannot hold a launch for ever. */
const ROUTE_BIND_MS = 5_000
const ROUTE_CHECK_MS = 3_000
const ROUTE_BACKOFF = [500, 1000]
const ROUTE_POLL = 500
const ROUTE_DEADLINE = 60_000
/** the repair pass binds many agents: its ceiling is short, so a wedged machine cannot starve it for minutes */
const ROUTE_REPAIR_MS = 10_000
/** how many routes the repair pass binds at once. A restart re-provisions every live agent, and one at a time that
 *  chain is as long as the number of agents — minutes with ~60 — while a task starting during it can fail its first
 *  write (SHE-56). A handful at a time keeps the pass short without a burst of helper processes on a busy machine. */
const ROUTE_REPAIR_CHUNK = 6
/** how often a repair pass runs. The first one runs at the first look at herdr that lists an agent to bind (routesAt
 *  starts at 0), so a restart repairs its routes at once instead of waiting this out. */
const ROUTE_REPAIR_EVERY = 30_000
/** how often the routes folder is pruned of dead processes' files: at the first refresh after the server starts that
 *  reaches herdr (pruneAt starts at 0), then this often. A route file is written for every launch and nothing else
 *  removed one, so the folder grew without end (1707 files on 2026-11-21) and slowed every CLI call (SHE-185). */
const ROUTE_PRUNE_EVERY = 10 * 60_000
const ROUTE_PRUNE_MS = 30_000

/** An idle agent's screen is read on the refresh that ends its turn, then on each refresh for the first minute
 *  (background work is announced as the turn ends and ends soon after), and after that only every 30 s. While a read
 *  found work still running the fast pace holds, since its end is what the reader waits for. herdr's output event
 *  makes a pane read at once, whatever its pace would otherwise be. */
const SCREEN_FAST_FOR = 60_000
const SCREEN_SLOW_EVERY = 30_000
/** screen reads are herdr calls on the thread that serves the screen and starts agents: no more than this many at once */
const SCREEN_READ_CHUNK = 4

/** the events a look at herdr always wants; the panes it wants output from are added per agent (outputSub) */
const BASE_SUBS = [{ type: 'pane.agent_status_changed' }, { type: 'pane.closed' }, { type: 'pane.created' }]
/** herdr 0.9.5 offers pane.output_matched, not pane.output_changed: an empty regex matches any line a pane prints. The
 *  event carries the pane id we need, and one arrives when the subscription opens (the pane's current output). */
const outputSub = (pane_id: string) => ({ type: 'pane.output_matched', pane_id, source: 'visible', match: { type: 'regex', value: '' } })

type Events = {
  routed: [key: string]
  status: [key: string, status: AgentStatus | 'gone']
  logs: [key: string]
  sent: [item: OutItem]
  /** what a screen sent couldn't go in */
  failed: [key: string]
  output: [key: string]
}

/** where the hooks of the agents Shepherdr starts record their events */
export const HOOKS_DIR = join(boxDir(), 'hooks')

/** where an agent's instructions are kept for its CLI to read */
const promptPath = (name: string) => join(boxDir(), 'prompts', `${name}.md`)

/**
 * The one place an agent's status is decided. What the agent reports of itself wins: its CLI's own hooks today (Claude
 * Code, readers/hooks.ts), OSC 7501's program status once herdr passes that on (then only `said` changes). herdr's
 * reading of its screen counts where the agent reports nothing (Codex, pi, one started before hooks), and for a menu
 * up between turns that no hook tells of (a rate-limit or login menu), where typed text could pick an option.
 */
export function statusFrom(said: Said | undefined, seen: AgentStatus | 'gone'): AgentStatus | 'gone' {
  if (seen === 'gone' || !said) return seen
  if (said.helper) return 'blocked'
  if (said.state !== 'idle') return said.state
  return seen === 'done' || seen === 'blocked' ? seen : 'idle'
}

/** what a refusal from herdr means for what you send: a menu is up, or the agent just started and herdr doesn't count
 *  it as its named agent yet ("agent shep-all is not an active named agent"); anything else, it can't go in */
export function holdFrom(e: unknown): Hold | undefined {
  const code = (e as HerdrError).code
  if (code === 'agent_blocked') return 'menu'
  if (code === 'agent_not_found' || code === 'agent_not_ready' || code === 'agent_not_running') return 'start'
  if (/not an active named agent/.test((e as Error)?.message ?? '')) return 'start'
  return undefined
}

/** what an agent's hooks said is read again at most this often */
const SAID_MS = 250

/** one calm line for a chat whose agent runs but whose log can't be read (a symlinked space with no log under either
 *  cwd, a folder gone, a CLI that did not write): the truth, without blaming the send */
const UNREADABLE_LOG = "This chat's log can't be read right now, so messages here may not show."

/** wraps text Shepherdr sends that is not for the chat (instructions, news), in a tag of what it is when it is one
 *  of its lines: <shepherdr><news task="SHE-9" event="merged">…</news></shepherdr>; readers' text is stripped of it */
export const hidden = (s: string, kind?: string, attrs: Record<string, string> = {}) => tag('shepherdr', {}, kind ? tag(kind, attrs, s) : s)
export const stripHidden = (s: string) => s.replace(/<shepherdr(?:\s+[\w-]+="[^"]*")*\s*>[\s\S]*?<\/shepherdr>\s*/g, '').trim()

export class Agents extends Emitter<Events> {
  records: Record<string, AgentRecord> = readJson('agents.json', {})
  outbox: OutItem[] = readJson('outbox.json', [])
  live = new Map<string, AgentInfo>()
  /** every agent herdr lists under a name, including the older pane a hand-over can leave beside the new one. `live`
   *  keeps one per name for the rest of the registry; this keeps all of them so the recorded pane can be picked */
  private liveAll = new Map<string, AgentInfo[]>()
  private byName = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private sub: Subscription
  readonly secretAccess = new SecretAccess()
  secretScope: (chat: string) => string[] | undefined = () => undefined
  private readingBackground = false
  private refreshing = false
  private stopped = false
  /** agents.json is a whole 3.6 MB store: a change writes it once per event-loop turn (the microtask coalesces every
   *  save() in one turn), and the bursty, harmless pendingLaunch flips of settleLaunches get this short delay so a
   *  start burst becomes one write. outbox.json stays immediate: a queued message lost to a crash is data loss. */
  recordsSaveAfter = 1000
  private recordsDirty = false
  private recordsTimer: ReturnType<typeof setTimeout> | null = null
  private recordsFlushQueued = false
  private retryAt = 0
  private recovery = new LinkBackoff()
  private routesAt = 0
  private pruneAt = 0
  private routing = false
  private routes = new Map<string, string>()
  /** whether its own event loop is keeping up: source.ts sets this from the stall watch. A loop that stalls answers its
   *  own timers and child processes late, so no route check is trusted until it is healthy again. Tests leave it true. */
  healthy: () => boolean = () => true
  /** times this pass on source's stall watch (agents are built before source, so source injects it like `healthy`). When
   *  one of these passes holds the loop, doctor must name it instead of saying no timed pass was slow. Tests leave it a
   *  pass-through, or inject a watch on a held clock */
  timed: <T>(label: string, f: () => T) => T = (_label, f) => f()

  private starting = new Map<string, Promise<AgentInfo | null>>()
  /** agents being stopped for a restart: what you send waits for the one it starts */
  private stopping = new Set<string>()
  /** names a launch is being completed for right now, so a look at herdr never asks twice at once */
  private asking = new Set<string>()
  /** since when each launch has been seen pending, and the ones already said to be stuck, so each is said once */
  private pendingSince = new Map<string, number>()
  private pendingSaid = new Set<string>()
  /** how long a launch may stay pending while Shepherdr asks for it: past that it is left for herdr to drop, so a name
   *  that never goes ready is not kept alive for ever by the asking itself (the relaunch loop brings it back after) */
  pendingFor = 90_000
  private delivering = new Set<string>()
  /** what went in lately with a screen's id: the chat gives the id back once it reads the message from the log */
  private delivered: OutItem[] = []
  /** Durable internal news receipts, unlike the screen's short-lived send history. */
  private newsReceipts: string[] = readJson('requested-news-receipts.json', [])
  /** everything that went in lately, with when: what a merge checks the agent has read, so kept across a restart */
  private typed: OutItem[] = readJson('typed.json', [])
  /** what a screen sent that waited and then couldn't go in: the screen says so and offers Retry */
  private failures: { key: string; cid: string; error: string; at: number }[] = []
  /** what a screen sent that is on its way now, by its id: sent again meanwhile, it goes in once */
  private inflight = new Map<string, Promise<Sent>>()
  /** since when an agent with screen sends waiting for it is gone, or herdr out of reach */
  private stranded = new Map<string, number>()
  /** how long that may last (an agent starting again) before what waits for it fails */
  strandAfter = 30_000
  /** since when herdr lists an agent that just started but won't take input yet (not yet its named agent): what waits
   *  for it is tried again on each refresh, and fails after unreadyFor */
  private unready = new Map<string, number>()
  unreadyFor = 60_000
  reachable = true
  lastReach = Date.now()
  watchedPanes = new Set<string>()
  sessions = new ClaudeSessions()
  /** its processes: the headless reviewers of another CLI (codex exec, claude -p) it runs as subagents, not shells, and
   *  the background shells OpenCode keeps under its pty daemon */
  procs = new Procs()
  /** the process table and how a closing pane's leftovers are ended (RES-03); tests inject both */
  reaper: { source: Source; end: (pids: number[]) => Promise<number[]> } = {
    source: systemSource,
    end: (pids) => endProcesses(pids, endDeps),
  }
  /** what the screen of a Claude Code with no session file or an agy agent says still runs in the background */
  private screens = new Map<string, Background>()
  /** each screen-read agent's pane, when its turn ended, and when its screen was last read: the pace of future reads */
  private screenState = new Map<string, { pane: string; since: number; at: number }>()
  /** why an agent's screen must be read on this pass: its turn just ended, or herdr says its pane printed */
  private screenNow = new Map<string, 'turn' | 'output'>()
  /** a screen pass was asked for while one was in flight: run one more after it, so no trigger is lost */
  private backgroundAgain = false
  /** herdr sends an initial output event for every pane when a subscription opens: that is a snapshot of what is
   *  already on screen, not something that printed. Ignore those events for a moment after each (re)open. */
  private outputQuietUntil = 0
  /** what its hooks, session file or screen say still runs in the background, since when, and after which turn */
  private seen = new Map<string, { what: Background; since: number; turn?: number }>()
  /** the background work last told, so a change is told once */
  private bg = new Map<string, Background | undefined>()
  /** servers alone (a dev server, a preview) keep it at work this long after its turn ended: one it started for you
   *  to look at never wakes it, and what it said then may want an answer */
  serversFor = 10 * 60_000
  /** shells and monitors that end (a test run, a review) keep it at work this long after its turn ended: each wakes it
   *  when it ends, but one may hang */
  shellsFor = 60 * 60_000
  /** each watched pane's size in cells, and when it was read */
  private sizes = new Map<string, { at: number; size: { cols: number; rows: number } | null }>()
  hooks = new HookLogs()
  /** the status last told, by chat key */
  private told = new Map<string, AgentStatus | 'gone'>()
  private hookWatch: FSWatcher | null = null
  private saidAt = new Map<string, { at: number; said?: Said }>()
  private soon: ReturnType<typeof setTimeout> | null = null
  /** whether a menu a slash command opened is up, which herdr doesn't see: typed text could pick an option */
  menuUp?: (key: string) => boolean
  /** Read startup menus herdr may classify as idle before any text can choose from them. */
  beforeInput?: (key: string) => Promise<void>
  /** whether its log shows its turn ended after this time: a turn cut short (Esc, a prompt turned down) runs no hook */
  endedSince?: (key: string, at: number) => boolean

  constructor() {
    super()
    // records written before logs were kept once each
    for (const r of Object.values(this.records)) {
      r.logs = uniqueLogs(r.logs ?? [])
      this.byName.set(r.name, r.key)
    }
    this.sub = new Subscription(
      (e) => this.onEvent(e),
      () => {
        this.outputQuietUntil = Date.now() + 1000
        void this.refresh()
      },
    )
  }

  start() {
    this.refresh()
    this.timer = setInterval(() => this.refresh(), 2000)
    // a hook event is read at once, not at the next look
    try {
      mkdirSync(mirrored(HOOKS_DIR), { recursive: true })
      this.hookWatch = watch(mirrored(HOOKS_DIR), () => {
        this.soon ??= setTimeout(() => {
          this.soon = null
          this.refresh()
        }, 150)
      })
    } catch {
      /* read at the next look */
    }
  }

  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.hookWatch?.close()
    this.sub.stop()
    // a failed write at shutdown must not skip the rest of the stop (engine, usage, retries)
    try {
      this.flushRecords()
    } catch (e) {
      this.writeFailed(e)
    }
  }

  /** outbox.json goes down at once (a queued message must survive a crash); agents.json is coalesced to one write per
   *  turn by saveRecords. Callers that must be durable when they return (finish, forget) follow save() with
   *  flushRecords(). */
  save() {
    this.saveRecords()
    writeJson('outbox.json', this.outbox)
  }

  /** records changed: write once at the end of this event-loop turn, whatever else changed them meanwhile */
  private saveRecords() {
    this.recordsDirty = true
    if (this.recordsFlushQueued) return
    this.recordsFlushQueued = true
    queueMicrotask(() => {
      this.recordsFlushQueued = false
      try {
        this.flushRecords()
      } catch (e) {
        this.writeFailed(e)
      }
    })
  }

  /** a pendingLaunch flip (settleLaunches): safe to hold for this short window — herdr drops an unasked launch itself,
   *  so a flip lost to a hard kill costs at most a leftover pane. Many happen in one refresh burst, so one timer serves
   *  all flips until it fires; a save() in the same turn still flushes them at the end of that turn. */
  private savePending() {
    this.recordsDirty = true
    if (this.recordsTimer) return
    this.recordsTimer = setTimeout(() => {
      this.recordsTimer = null
      try {
        this.flushRecords()
      } catch (e) {
        this.writeFailed(e)
      }
    }, this.recordsSaveAfter)
    this.recordsTimer.unref?.()
  }

  /** a failed write leaves the records dirty for the next flush, and is said rather than thrown on the event loop */
  private writeFailed(e: unknown) {
    console.error(`shepherdr: could not write agents.json: ${(e as Error).message}`)
  }

  /** write the dirty records once, now; the outbox is never held back */
  flushRecords() {
    if (this.recordsTimer) {
      clearTimeout(this.recordsTimer)
      this.recordsTimer = null
    }
    if (!this.recordsDirty) return
    writeJson('agents.json', this.records, home(), true)
    this.recordsDirty = false
  }

  record(key: string) {
    return this.records[key]
  }

  /** the backup agent that took this chat over once, if it did (kept: a backup that keeps failing never loops) */
  tookOver(key: string) {
    return this.records[key]?.tookOver
  }

  /** A live model/effort switch: what the CLI now runs on, proved from the chat. No restart: the session, its route,
   *  hooks, pane and folder stay as they are. Settings' `set` is left alone, so the restart hint still says what
   *  Settings want; only this launch's own record moves to what the agent really runs on now. */
  switched(key: string, to: { model?: string; effort?: string }) {
    const r = this.records[key]
    if (!r) return
    if ('model' in to) r.model = to.model || undefined
    if ('effort' in to) r.effort = to.effort || undefined
    this.save()
    this.emit('logs', key)
  }

  /** mark this chat's agent as backed up once: another backup waits for the human */
  /** a coordinator's takeover is on its way (handover), or over (undefined) */
  markHandover(key: string, handover: AgentRecord['handover']) {
    const r = this.records[key]
    if (!r || (r.handover === undefined && handover === undefined)) return
    r.handover = handover
    this.save()
  }

  markTookOver(key: string, tookOver: AgentRecord['tookOver']) {
    const r = this.records[key]
    if (!r || JSON.stringify(r.tookOver ?? null) === JSON.stringify(tookOver ?? null)) return
    r.tookOver = tookOver
    this.save()
  }

  /**
   * The agent this chat's last launch started, and only that one. A hand-over can leave two herdr agents under one name
   * (the new CLI in a new pane, the old pane a plain shell after its CLI exited), and herdr's list order is no guarantee
   * which one `live` would keep: status, menus, screens and process checks must never read an older pane, or a task
   * whose new agent works reads Needs you (SHE-185, SHE-184, SHE-182). While a launch is under way the run it takes
   * over from still counts, so the brief window before herdr lists the new agent shows no false wait either.
   */
  info(key: string) {
    const r = this.records[key]
    if (!r) return undefined
    const under = this.liveAll.get(r.name) ?? []
    if (!under.length) return this.live.get(r.name)
    const launched = r.lastPane ? under.find((a) => a.pane_id === r.lastPane) : undefined
    if (launched) return launched
    if (!r.lastPane || this.starting.has(key) || this.stopping.has(key)) return under[0]
    return undefined
  }

  /** The cwds where this chat's agent may write its logs: what Shepherdr remembers, its real path (a symlinked space),
   *  and, leading, the cwd herdr reports for the live agent. Only this chat's own paths ever go into a log lookup. */
  logCwds(key: string): string[] {
    const r = this.records[key]
    return r ? cwdCandidates(r.cwd, this.info(key)?.cwd) : []
  }

  /** A running chat whose log can't be read is not an empty conversation: say so in one calm line (and in doctor),
   *  rather than let the person's own message look lost. A just-launched agent gets a few seconds to write its first
   *  log before this line appears. */
  unreadable(key: string): string | undefined {
    const r = this.records[key]
    if (!r || !this.info(key) || Date.now() - r.started < 15_000) return undefined
    // the log that matters is the current session's: an older session's file still on disk says nothing about
    // whether the one this agent is in now can be read — that is the case that makes a chat look empty
    // pi names a file <timestamp>_<session id>.jsonl, so match the end of the name, not the whole of it
    const current = r.sessionId ? r.logs.find((f) => f.endsWith(`${r.sessionId}.jsonl`)) : r.logs.at(-1)
    if (current && existsSync(current)) return undefined
    return UNREADABLE_LOG
  }

  /** the doctor's lines: one per running chat whose log can't be read */
  unreadableLogs(): string[] {
    const out: string[] = []
    for (const key of Object.keys(this.records)) {
      const line = this.unreadable(key)
      if (line) out.push(`${key}: ${line}`)
    }
    return out
  }

  /** Private routing was bound to this session's actual CLI process. */
  routed(key: string) {
    return this.reachable && !!this.info(key)?.agent && !this.record(key)?.finished && this.routes.has(key)
  }

  status(key: string): AgentStatus | 'gone' {
    const a = this.info(key)
    // herdr calls a pane whose program it cannot name 'unknown': a CLI that exited left its shell there. It is not an
    // agent at work or asking, so nothing may read Needs you from it (SHE-185/184/182). A launch herdr still has
    // pending is not that: it has no status yet and must stay 'unknown' until it goes ready
    const seen = !a || (a.agent_status === 'unknown' && !a.launch_pending) ? 'gone' : a.agent_status
    return statusFrom(this.said(key), seen)
  }

  private codexState = new Map<string, AgentRuntime>()
  private runtimeAt = 0
  private runtimeReading = false

  runtime(key: string): AgentRuntime | undefined {
    const state = this.codexState.get(key)
    return this.info(key) && state && Date.now() - state.at < 10_000 ? state : undefined
  }

  private async readRuntime() {
    if (this.runtimeReading || Date.now() - this.runtimeAt < 5000) return
    this.runtimeReading = true
    this.runtimeAt = Date.now()
    try {
      const sessions = new Map<string, { id: string; started: number }>()
      for (const [key, r] of Object.entries(this.records)) {
        if (r.kind !== 'codex' || !this.info(key)) continue
        const active = this.info(key)?.agent_session
        const id = active?.kind === 'id' ? active.value : (active?.kind === 'path' ? active.value : r.logs.at(-1))?.match(/([0-9a-f-]{36})\.jsonl$/)?.[1]
        if (id) sessions.set(key, { id, started: r.started })
      }
      const states = await readCodexRuntime([...new Set([...sessions.values()].map((s) => s.id))])
      this.codexState.clear()
      for (const [key, session] of sessions) {
        if (this.records[key]?.started !== session.started) continue
        const state = states.get(session.id)
        if (state) this.codexState.set(key, state)
        this.emit('logs', key)
      }
    } catch {
      this.codexState.clear()
    } finally {
      this.runtimeReading = false
    }
  }

  /** Runtime fields reported by this launch's main Claude process, never its subagents. */
  runtimeHook(key: string) {
    const r = this.records[key]
    if (!r?.hooks || r.kind !== 'claude' || !this.info(key)) return undefined
    const h = this.hooks.read(mirrored(r.hooks)).runtime
    return h && h.at >= r.started && (!h.session || h.session === r.sessionId) ? h : undefined
  }

  /** what the agent reports of itself, from its hooks; nothing when it reports nothing (see statusFrom). A turn its log
   *  shows ended after its last event was cut short with no hook: it is over. */
  said(key: string): Said | undefined {
    const r = this.records[key]
    if (!r?.hooks || !this.info(key)) return undefined
    // asked many times over for one screen: read at most every SAID_MS
    const now = Date.now()
    const c = this.saidAt.get(key)
    if (c && now - c.at < SAID_MS) return c.said
    let said = this.hooks.read(mirrored(r.hooks)).said
    if (said && said.state !== 'idle' && this.endedSince?.(key, said.at)) said = { state: 'idle', turnAt: said.turnAt, at: said.at, last: said.last, helper: said.helper, paused: said.paused }
    this.saidAt.set(key, { at: now, said })
    return said
  }

  /** a name herdr accepts: [a-z][a-z0-9_-]{0,31} */
  static nameFor(s: string) {
    const n = s
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z]+/, '')
      .slice(0, 32)
      .replace(/-+$/, '')
    return n || `shep-${randomUUID().slice(0, 6)}`
  }

  /* ---------- herdr state ---------- */

  async refresh() {
    if (this.stopped || this.refreshing || (BOX && Date.now() < this.retryAt)) return
    this.refreshing = true
    this.saidAt.clear()
    try {
      const list = await herdr.agents()
      // everything after the herdr look is synchronous, and is the part of this pass that can hold the loop: a herdr
      // list, settleLaunches and per-agent session follow. Timed together under one label, so a slow refresh is named.
      this.timed('agents.refresh', () => {
        if (this.stopped) return
        if (!this.reachable && BOX) console.info('shepherdr: herdr link recovered')
        this.recovery.success()
        this.retryAt = 0
        this.reachable = true
        this.lastReach = Date.now()
        // once herdr answers, so a worker whose link is down does not spend an ssh call on it
        if (Date.now() - this.pruneAt > ROUTE_PRUNE_EVERY) {
          this.pruneAt = Date.now()
          void this.pruneRoutes()
        }
        this.liveAll = new Map()
        for (const a of list) {
          if (!a.name) continue
          const under = this.liveAll.get(a.name) ?? []
          under.push(a)
          this.liveAll.set(a.name, under)
        }
        // one name can be in two panes during a hand-over. Every reader of `live` (route repair, an ensure that finds
        // an agent already running, session follow, pending launches) must see the same pane as status and screens: the
        // one this chat's record says it last launched. An older shell is no agent at all, so it is left out entirely
        this.live = new Map()
        for (const [name, under] of this.liveAll) {
          const key = this.byName.get(name)
          const want = key ? this.records[key]?.lastPane : undefined
          const launching = key && (this.starting.has(key) || this.stopping.has(key))
          const chosen = want ? (under.find((a) => a.pane_id === want) ?? (launching ? under[0] : undefined)) : under[0]
          if (chosen) this.live.set(name, chosen)
        }
        for (const key of this.byName.values()) {
          const now = this.status(key)
          const was = this.told.get(key) ?? 'gone'
          this.told.set(key, now)
          if (was !== now) this.changed(key, now)
        }
        for (const r of Object.values(this.records)) {
          if (!this.live.has(r.name) || r.finished) {
            this.secretAccess.revoke(r.key)
            this.routes.delete(r.key)
          }
        }
        // Repair running sessions without interrupting them, including ones restored by herdr.
        void this.readRuntime()
        // Slow pane reads must not hold up transport health checks. readBackground owns its own in-flight guard.
        void this.readBackground().catch(() => undefined)
        // what each launch is really doing now, before the repair pass reads it: a pendingLaunch its launch is done with
        // must not keep its route waiting for the next pass
        this.settleLaunches()
        const todo = this.repairTodo()
        if (todo.length && Date.now() - this.routesAt > ROUTE_REPAIR_EVERY && !this.routing) {
          this.routesAt = Date.now()
          void this.repairRoutes(todo)
        }
        // learn log files herdr names (its agent integrations report them)
        for (const [name, key] of this.byName) this.learnSession(key, this.live.get(name))
        // and the session its hooks say it is in now, which herdr doesn't name: a /clear starts another
        for (const key of this.byName.values()) this.followSession(key)
        // what waits goes in as soon as its agent can take it
        for (const key of new Set(this.outbox.map((o) => o.key))) if (!this.heldBy(key)) this.deliver(key)
        this.checkStranded()
        this.sub.set([...BASE_SUBS, ...[...this.outputPanes()].map(outputSub)])
      })
    } catch {
      if (BOX) this.retryAt = Date.now() + this.recovery.fail()
      if (this.reachable) {
        if (BOX) console.info('shepherdr: herdr link lost; retrying (3–30s backoff)')
        this.reachable = false
        this.emit('status', '*', 'gone')
      }
      this.checkStranded()
    } finally {
      this.refreshing = false
    }
  }

  /**
   * herdr starts an agent with `agent.start` and then leaves the launch pending: it finishes such a launch only when a
   * client asks for that agent by name, and about a minute later, if nobody did, it drops the name and closes the pane
   * (herdr 0.9.5, issue #491). Claude Code reports its own readiness through its hooks, pi does not, so a pi agent sat
   * at its start screen for ever and its brief stayed in outbox. Asking finishes the launch, and readiness then arrives
   * as it does for any agent. A name herdr dropped answers not found and is no longer listed, which the relaunch loop
   * handles as it handles any agent that stopped; nothing here starts or stops one.
   *
   * One ask in flight per agent, never awaited by the caller (a look at herdr never waits on a launch), and only for so
   * long: a launch that never goes ready must not be kept alive by our asking itself, so past pendingFor it is said
   * once and no longer asked for. Nothing here starts one again either: a pending agent is never counted as wrong, so
   * only herdr's own timeout on an unasked launch, which the relaunch loop then sees as gone, can end it.
   */
  private settleLaunches(now = Date.now()) {
    for (const [name, a] of this.live) {
      const key = this.byName.get(name)
      // another client's agent (the human's own `herdr agent start`, or another Shepherdr's): its launch is theirs
      if (!key) continue
      const r = this.records[key]
      if (!a.launch_pending) {
        if (r?.pendingLaunch) {
          r.pendingLaunch = false
          this.savePending()
        }
        this.pendingSince.delete(name)
        this.pendingSaid.delete(name)
        continue
      }
      if (r && !r.pendingLaunch) {
        r.pendingLaunch = true
        this.savePending()
      }
      const since = this.pendingSince.get(name) ?? now
      this.pendingSince.set(name, since)
      if (now - since < this.pendingFor) {
        void this.askLaunch(name)
        continue
      }
      if (this.pendingSaid.has(name)) continue
      this.pendingSaid.add(name)
      console.error(`shepherdr: ${name}'s launch hasn't become ready in ${Math.round((now - since) / 1000)} s; not asking for it any more`)
    }
    // forget the names herdr no longer lists, ready or dropped
    for (const name of this.pendingSince.keys()) if (!this.live.has(name)) this.pendingSince.delete(name)
    for (const name of [...this.pendingSaid]) if (!this.live.has(name)) this.pendingSaid.delete(name)
  }

  private async askLaunch(name: string) {
    if (this.asking.has(name)) return
    this.asking.add(name)
    try {
      await herdr.agent(name)
    } catch {
      /* dropped, or herdr out of reach: the next look says which */
    } finally {
      this.asking.delete(name)
    }
  }

  /**
   * The pane a launch herdr dropped can leave behind, closed before its agent is started again, so a relaunch never
   * sits beside an orphan (on herdr 0.9.5 the drop closes the pane itself; nothing guarantees that of every version).
   * Only such a pane is closed: one another chat's agent runs in, one where something else runs, and the pane it is
   * starting in now are all left alone.
   */
  private async closeLeftPane(r: AgentRecord, startingIn: string) {
    const pane = r.lastPane
    r.lastPane = undefined
    const dropped = r.pendingLaunch
    r.pendingLaunch = false
    if (!dropped || !pane || pane === startingIn || [...this.live.values()].some((a) => a.pane_id === pane)) return
    if (!(await herdr.paneIdle(pane).catch(() => false))) return
    await herdr.closePane(pane).catch(() => undefined)
  }

  /**
   * Close the panes earlier runs of this chat left behind, once the new run is up. Only a pane this chat launched, now
   * an idle shell with nothing typed at its prompt and no agent in it, is closed: another chat's or the person's own
   * pane is never touched, and a half-typed command stays theirs. What cannot be proved safe is left in herdr, ignored
   * for status and alerts by `info`'s lastPane rule — an old pane must never read Needs you (SHE-185/184/182).
   */
  private async retire(key: string, panes: string[], keep: string) {
    const r = this.records[key]
    const gone: string[] = []
    for (const pane of panes) {
      if (!pane || pane === keep || gone.includes(pane)) continue
      // idle means herdr sees only the shell in the foreground, not an agent process another chat could own
      if (!(await herdr.paneIdle(pane).catch(() => false))) continue
      if (!barePrompt(await herdr.visible(pane).catch(() => ''))) continue
      await this.reapPane(pane)
      gone.push(pane)
    }
    // a pass has considered every pane it was given: a pane with a program in it, or with words at its prompt, is left
    // for its owner and not probed again on every later launch. The ignore rule is `lastPane`, not this list
    if (this.records[key] === r) {
      r.superseded = []
      this.save()
    }
    if (gone.length) await this.refresh()
  }

  /** Bind the actual CLI process, not HERDR_PANE_ID (old shells can inherit another pane's id). `own`: the start
   *  flow itself (a launch) binds the agent it just started, so a restart's or a relaunch's stopping flag — held for
   *  what you send, not against its own bind — does not skip it. `deadlineMs`: the repair pass binds many, often. */
  private async bindRoute(r: AgentRecord, pane: string, own = false, deadlineMs = ROUTE_DEADLINE) {
    // a server that may start no agent binds no route for one either: no route file, no credential (launch-policy.ts)
    if (!launchesAgents()) {
      this.routes.delete(r.key)
      this.secretAccess.revoke(r.key)
      return
    }
    const p = await herdr.processInfo(pane)
    const proc = p.foreground_processes?.find((x) => x.pid && isAgentProcess(r.kind, x.argv))
    if (!proc?.pid || r.finished || this.records[r.key]?.finished || (!own && this.stopping.has(r.key))) {
      this.routes.delete(r.key)
      this.secretAccess.revoke(r.key)
      return
    }
    const env = agentEnv(r.key, ROOT)
    const chain = this.secretScope(r.key)
    const capability = chain ? this.secretAccess.issue(r.key, `${proc.pid}:${r.started}`, chain) : undefined
    const route = {
      chat: r.key,
      cwd: r.cwd,
      capability,
      credentialFile: this.records[r.key]?.env?.SHEPHERDR_SECRET_FILE ?? r.env?.SHEPHERDR_SECRET_FILE ?? env.SHEPHERDR_SECRET_FILE,
      ...(BOX ? { helper: env.SHEPHERDR_COMMAND } : { url: env.SHEPHERDR_URL }),
    }
    const signature = JSON.stringify([proc.pid, route])
    if (this.routes.get(r.key) === signature) {
      this.emit('routed', r.key)
      return
    }
    const router = BOX ? join(helperDir(BOX.home), 'route.pl') : join(ROOT, 'helper', 'route.pl')
    // the box's own Shepherdr home, said rather than left to what its login shell exports: the credential file it writes
    // is the box's, whether or not that shell sets SHEPHERDR_HOME as well
    const opts = { stdin: JSON.stringify(route), ...(BOX ? { env: { SHEPHERDR_HOME: join(BOX.home, '.shepherdr') } } : {}) }
    if (!(await this.provisionRoute(proc.pid, r.key, router, opts, own, deadlineMs))) {
      this.routes.delete(r.key)
      this.secretAccess.revoke(r.key)
      // a stop or a restart took the agent over while it provisioned: no failure of the start it abandoned — its own
      // flow owns what happens next, so a task the human just stopped never reads "Went wrong" for it
      if (this.records[r.key]?.finished || (!own && this.stopping.has(r.key))) return
      throw new Error(ROUTING_FAILURE)
    }
    // A stop may have raced the asynchronous provisioning write. Never restore its authority.
    if (this.records[r.key]?.finished || (!own && this.stopping.has(r.key))) {
      this.secretAccess.revoke(r.key)
      return
    }
    this.routes.set(r.key, signature)
    this.emit('routed', r.key)
  }

  /** `--bind` once, then verify the file rather than trusting a non-zero code (a stall can kill it late, after the write
   *  landed). A route genuinely absent is retried a couple of times after the loop is healthy again, with backoff and a
   *  ceiling. The waits are timers, so the loop stays free for herdr and the screen. `own` and `deadlineMs` ride from
   *  bindRoute: a launch's own bind is not cancelled by the restart that launched it, and the repair pass is short. */
  private async provisionRoute(pid: number, key: string, router: string, opts: { stdin: string; env?: Record<string, string> }, own = false, deadlineMs = ROUTE_DEADLINE) {
    const deadline = Date.now() + deadlineMs
    for (let attempt = 0; ; attempt++) {
      const result = await run(['perl', router, '--bind', String(pid)], { ...opts, timeoutMs: ROUTE_BIND_MS })
      if (!result.code) return true
      // a stalled loop answers its own timers late: wait for it to keep up before reading any answer as final
      while (!this.healthy() && Date.now() < deadline) await new Promise((res) => setTimeout(res, ROUTE_POLL))
      // a stop or a restart that took the agent over is not a routing failure of the start it abandoned (bindRoute
      // returns quietly for it); only the server itself stopping is, and its caller learns of the record either way
      if (this.stopped || this.records[key]?.finished || (!own && this.stopping.has(key))) return false
      // a clean "not there", a check reported late, and the ceiling passing alike, are never the answer: a write
      // killed at its very end can still have landed, so the file decides — including one last read past the ceiling
      const check = await run(['perl', router, '--check', String(pid)], { ...opts, timeoutMs: ROUTE_CHECK_MS })
      if (check.code === 0) return true
      if (attempt >= ROUTE_BACKOFF.length || Date.now() >= deadline) return false
      await new Promise((res) => setTimeout(res, ROUTE_BACKOFF[attempt]))
    }
  }

  /**
   * Bring every live agent's route back, a chunk at a time: the pass binds the agents already talking to herdr, and
   * never one whose own launch is about to bind it (a launch's bind stays its own, so the repair pass can neither
   * skip nor duplicate it). Each route fails on its own, said once, and never stops the others.
   */
  private async repairRoutes(todo = this.repairTodo()) {
    this.routing = true
    try {
      for (let i = 0; i < todo.length; i += ROUTE_REPAIR_CHUNK) {
        if (this.stopped) return
        await Promise.allSettled(todo.slice(i, i + ROUTE_REPAIR_CHUNK).map((r) => this.repairRoute(r)))
      }
    } finally {
      this.routing = false
    }
  }

  /** Remove the route files of processes that are gone (helper/route.pl --prune: a pid that no longer exists, or whose
   *  start stamp no longer matches; never a live one). A server that binds no routes prunes none. Its failure is the
   *  folder staying as it was, which only costs the CLI the cheap liveness test per file: never raised. */
  private async pruneRoutes() {
    // the tests (test/preload.ts) say no: they run with the real HOME, where route.pl looks, and touch nothing of this machine's
    if (!launchesAgents() || process.env.SHEPHERDR_PRUNE_ROUTES === '0') return
    const router = BOX ? join(helperDir(BOX.home), 'route.pl') : join(ROOT, 'helper', 'route.pl')
    const r = await run(['perl', router, '--prune'], { timeoutMs: ROUTE_PRUNE_MS }).catch(() => undefined)
    const n = Number(r?.out.toString().trim())
    if (n > 0) console.info(`shepherdr: removed ${n} route file${n === 1 ? '' : 's'} of processes that are gone`)
  }

  /** the live agents a repair pass has to bind: the ones no launch is binding itself right now */
  private repairTodo() {
    return Object.values(this.records).filter((r) => this.live.has(r.name) && !this.itsOwnBind(r))
  }

  /** whether a launch owns this route: it binds it itself, so the repair pass leaves it alone. Herdr's own answer for
   *  the launch, not only what the store kept, so a restart's stale pendingLaunch strands nothing. */
  private itsOwnBind(r: AgentRecord) {
    if (r.pendingLaunch || this.starting.has(r.key) || this.stopping.has(r.key)) return true
    return !!this.live.get(r.name)?.launch_pending
  }

  /** one route of the repair pass: its failure is said here and belongs to this route alone. Read again just before the
   *  write, so a launch that started while an earlier chunk bound is left to its own bind. */
  private async repairRoute(r: AgentRecord) {
    const a = this.live.get(r.name)
    if (!a || this.itsOwnBind(r)) return
    try {
      await this.bindRoute(r, a.pane_id, false, ROUTE_REPAIR_MS)
    } catch (e) {
      console.error(`shepherdr: routing ${r.key}: ${(e as Error).message}`)
    }
  }

  /**
   * Its turn ended, but work it started in the background still runs and will wake it: a subagent, a shell, a monitor
   * (Claude Code; see readers/background.ts). Nothing while it works, asks in a menu, or is gone.
   */
  background(key: string, now = Date.now()): Background | undefined {
    const what = this.stillRuns(key)
    if (what !== 'shells' && what !== 'servers') return what
    const s = this.seen.get(key)
    return s?.what === what && now - s.since >= (what === 'servers' ? this.serversFor : this.shellsFor) ? undefined : what
  }

  /** what its hooks said still ran as its turn ended, else its session file, else its screen; a shell that is a
   *  headless reviewer counts as a subagent. However long it has run (background() leaves shells out after a while) */
  stillRuns(key: string): Background | undefined {
    const what = this.ranOn(key)
    return what && what !== 'agents' && this.procs.runs(key) ? 'agents' : what
  }

  private ranOn(key: string): Background | undefined {
    const r = this.records[key]
    const st = this.status(key)
    // agy has no hooks or session file: its screen says what its turn left running
    if (r?.kind === 'agy') return st === 'idle' || st === 'done' ? this.screens.get(key) : undefined
    // OpenCode keeps its background shells under its own pty daemon, and wakes the agent when one ends
    if (r?.kind === 'opencode') return st === 'idle' || st === 'done' ? this.opencodeWork(key) : undefined
    if (r?.kind !== 'claude' || st === 'working' || st === 'blocked' || st === 'gone') return undefined
    const file = this.sessions.status(r.sessionId, this.logCwds(key))
    // its hooks said what still ran as its turn ended; its session file is newer once that work is gone, or once a
    // subagent runs again (one that paused on shells of its own woke)
    const said = this.said(key)
    if (said) return file === 'idle' ? undefined : said.bg && file === 'busy' ? 'agents' : said.bg
    return file === undefined ? this.screens.get(key) : sessionBackground(file)
  }

  /** what an OpenCode agent's turn left running: a subagent its session started (a busy child in its database, which
   *  reports back and wakes it however long it takes), else the shells its pty daemon still runs for it, each of which
   *  wakes it when it ends ("↳ Shell finished"), and 'servers' when every one of them serves or watches (a dev server it
   *  left for you to look at never does). A subagent wins over shells: both may run at once ("↓ 1 subagent · 2 shells").
   *  Where the database cannot tell, the footer read on the idle pane is the answer. */
  private opencodeWork(key: string): Background | undefined {
    const sessionId = this.records[key]?.sessionId
    const sub = sessionId ? opencodeSubagentRunning(sessionId) : undefined
    if (sub === true) return 'agents'
    const shells = this.procs.shells(key)
    const shellWork = shells.length ? (shells.some((argv) => !servesCommand(argv.join(' '))) ? 'shells' : 'servers') : undefined
    if (sub === false) return shellWork
    // the database cannot tell: a subagent the footer names still wins, but the process table says better than the
    // footer whether a shell is a job that ends or a server that does not
    const fromScreen = this.screens.get(key)
    return fromScreen === 'agents' ? 'agents' : (shellWork ?? fromScreen)
  }

  /** the pane whose screen alone tells what still runs for this agent: an idle or done agy agent, or a Claude Code whose
   *  hooks and session file say nothing. Only these panes get an output subscription and a screen read. */
  private needsScreen(key: string): string | undefined {
    const r = this.records[key]
    const pane = this.info(key)?.pane_id
    if (!r || !pane) return undefined
    const st = this.status(key)
    if (st !== 'idle' && st !== 'done') return undefined
    if (r.kind === 'agy') return pane
    // OpenCode has no hooks or session file: its database tells of a running subagent, and only when that cannot tell
    // is its footer read (as agy's always is)
    if (r.kind === 'opencode') return r.sessionId && opencodeSubagentRunning(r.sessionId) === undefined ? pane : undefined
    return r.kind === 'claude' && !this.said(key) && this.sessions.status(r.sessionId, this.logCwds(key)) === undefined ? pane : undefined
  }

  /** what the pane's screen says still runs in the background, for an idle or done agent that has no other way to say it:
   *  a Claude Code with no session file, any agy agent (none while it works), or an OpenCode whose database cannot tell */
  private async screenWork(key: string): Promise<Background | undefined> {
    const pane = this.needsScreen(key)
    if (!pane) return undefined
    const text = await herdr.visible(pane).catch(() => '')
    const kind = this.records[key]?.kind
    return kind === 'agy' ? agyScreenBackground(text) : kind === 'opencode' ? opencodeScreenBackground(text) : screenBackground(text)
  }

  /** the panes whose output herdr tells us about: those on screen in a terminal, and those whose screen is read for
   *  background work. A closed pane drops out when its agent is no longer live. */
  private outputPanes(): string[] {
    return [...new Set([...this.watchedPanes, ...[...this.screenState.values()].map((s) => s.pane)])].sort()
  }

  /** what still runs in the background, read again: a screen only when its turn just ended, when herdr says its pane
   *  printed, while work still runs there, or on a pace that slows from the refresh's 2 s to 30 s after a minute. A
   *  change is told as a status change, since the agent may have woken, said a word and stopped again between looks. */
  /** `eventOnly` is an output event for one pane: read that pane, not every agent still in its fast window */
  private async readBackground(eventOnly = false) {
    if (this.readingBackground) {
      this.backgroundAgain = true
      return
    }
    this.readingBackground = true
    try {
      do {
        this.backgroundAgain = false
        await this.backgroundPass(eventOnly)
      } while (this.backgroundAgain && !this.stopped)
    } finally {
      this.readingBackground = false
    }
  }

  /** one pass: decide whose screen is due, then walk the agents in order — telling what changed without a read at once,
   *  and reading a due screen (at most a few at a time) before telling that one. A key whose state comes from its hooks
   *  or session file is never held up by a pane read that belongs to another agent. */
  private async backgroundPass(eventOnly = false) {
    const now = Date.now()
    const due = new Set<string>()
    for (const key of this.byName.values()) {
      if (this.stopped) return
      const pane = this.needsScreen(key)
      if (!pane) {
        this.screens.delete(key)
        this.screenState.delete(key)
        this.screenNow.delete(key)
        continue
      }
      const why = this.screenNow.get(key)
      if (eventOnly && !why) continue
      let s = this.screenState.get(key)
      if (!s || s.pane !== pane) {
        s = { pane, since: now, at: 0 }
        this.screenState.set(key, s)
      }
      if (why === 'turn') s.since = now
      // a turn that just ended, an output event, or work that still runs: read now. Otherwise the first minute follows
      // the refresh's own 2 s pace; after that a screen that has not printed is read only every 30 s.
      if (why || s.at === 0 || this.screens.get(key) || now - s.since < SCREEN_FAST_FOR || now - s.at >= SCREEN_SLOW_EVERY) due.add(key)
    }
    this.screenNow.clear()

    /** what the hooks, session file, process table and screens say now, and whether it changed */
    const tell = (key: string) => {
      if (this.stopped) return
      const st = this.status(key)
      const what = this.stillRuns(key)
      const turn = this.said(key)?.turnAt
      const was = this.seen.get(key)
      if (!what) this.seen.delete(key)
      else if (was?.what !== what || was.turn !== turn) this.seen.set(key, { what, since: Date.now(), turn })
      const now = this.background(key)
      if (now === this.bg.get(key)) return
      this.bg.set(key, now)
      this.emit('status', key, st)
    }

    const read = async (key: string) => {
      const seen = await this.screenWork(key)
      if (seen) this.screens.set(key, seen)
      else this.screens.delete(key)
      const s = this.screenState.get(key)
      if (s) s.at = Date.now()
      tell(key)
    }

    const running: Promise<void>[] = []
    for (const key of this.byName.values()) {
      if (this.stopped) return
      if (!due.has(key)) {
        tell(key)
        continue
      }
      running.push(read(key))
      if (running.length >= SCREEN_READ_CHUNK) await Promise.all(running.splice(0))
    }
    await Promise.all(running)
    // a newly idle agent's pane was not in the subscription at the last look: add it without waiting for the next one
    this.sub.set([...BASE_SUBS, ...this.outputPanes().map(outputSub)])
  }

  /** what a screen sent waits only on a menu or a starting agent: one whose agent is gone (or herdr out of reach) for a
   *  while fails */
  checkStranded(now = Date.now()) {
    const keys = new Set(this.outbox.filter((o) => o.cid && !o.cid.startsWith('requested-news:')).map((o) => o.key))
    for (const key of this.stranded.keys()) if (!keys.has(key)) this.stranded.delete(key)
    for (const key of keys) {
      if (this.reachable && this.status(key) !== 'gone') {
        this.stranded.delete(key)
        continue
      }
      const since = this.stranded.get(key) ?? now
      this.stranded.set(key, since)
      if (now - since < this.strandAfter) continue
      this.stranded.delete(key)
      this.fail(key, this.reachable ? 'The agent stopped before it went in.' : 'Lost herdr before it went in.')
    }
  }

  /** what a screen sent that waits for this agent fails: the screen says why and offers Retry */
  private fail(key: string, error: string) {
    const mine = this.outbox.filter((o) => o.key === key && o.cid && !o.cid.startsWith('requested-news:'))
    if (!mine.length) return
    const now = Date.now()
    this.outbox = this.outbox.filter((o) => !mine.includes(o))
    this.save()
    this.failures = [...this.failures.filter((f) => now - f.at < 600_000), ...mine.map((o) => ({ key, cid: o.cid!, error, at: now }))]
    this.emit('failed', key)
  }

  private onEvent(e: HerdrEvent) {
    const type = String(e.data?.type ?? e.event)
    if (type.includes('output_changed') || type === 'pane.output_matched' || type === 'pane_output_matched') {
      // an output_matched subscription sends the pane's current text as soon as it opens: that is not a print
      if ((type === 'pane.output_matched' || type === 'pane_output_matched') && Date.now() < this.outputQuietUntil) return
      const pane = String(e.data.pane_id ?? '')
      for (const key of this.byName.values()) if (this.info(key)?.pane_id === pane) this.emit('output', key)
      // a pane whose screen we read printed: read it now, however old its turn is
      let due = false
      for (const [key, s] of this.screenState)
        if (s.pane === pane) {
          if (!this.screenNow.has(key)) this.screenNow.set(key, 'output')
          due = true
        }
      if (due) void this.readBackground(true).catch(() => undefined)
      return
    }
    // status and pane changes: read the authoritative list again
    this.refresh()
  }

  private changed(key: string, status: AgentStatus | 'gone') {
    // its turn just ended: this is when background work is announced, so read the screen now
    if (status === 'idle' || status === 'done') this.screenNow.set(key, 'turn')
    this.emit('status', key, status)
    if (status !== 'gone' && status !== 'blocked') this.deliver(key)
    if (status !== 'gone') this.emit('logs', key)
  }

  private learnSession(key: string, a?: AgentInfo) {
    const r = this.records[key]
    const s = a?.agent_session
    if (!r || !s) return
    // OpenCode's session is known from its API and read from its own mirror: herdr's report of a session is never followed
    if (r.kind === 'opencode') return
    if (s.kind === 'path' && addLog(r, mirrored(s.value))) {
      this.save()
      this.emit('logs', key)
    } else if (s.kind === 'id' && r.kind === 'claude') {
      const p = claudeLogPath(this.logCwds(key), s.value)
      if (addLog(r, p)) {
        r.sessionId = s.value
        this.save()
        this.emit('logs', key)
      }
    }
  }

  /** the session a Claude Code's hooks say it is in now (a /clear, /resume or new one), followed: its transcript
   *  joins the chat's logs, and resuming it resumes that one */
  followSession(key: string) {
    const r = this.records[key]
    if (r?.kind !== 'claude' || !r.hooks) return
    const s = this.hooks.read(mirrored(r.hooks)).session
    // another machine's copy of its events may still be an earlier run's, until the new run's first event comes
    if (!s || s.id === r.sessionId || s.at < r.started - 5000) return
    const log = s.log ? mirrored(s.log) : claudeLogPath(this.logCwds(key), s.id)
    r.sessionId = s.id
    addLog(r, log)
    this.save()
    this.emit('logs', key)
  }

  /** after a command that may start another session (/new, /clear, /resume), for an agent whose hooks don't say so: its
   *  CLI's newest log changed since then, once it is one the chat doesn't read yet */
  follow(key: string, since: number) {
    const r = this.records[key]
    if (!r || (r.kind === 'claude' && r.hooks)) return
    const look = () => {
      const f = findLog(r.kind, this.logCwds(key), since - 1000)
      if (!f || !addLog(r, f)) return
      // Claude Code and pi resume by the id in its name, OpenCode by its session id (its mirror is named by it); Codex by
      // its last log
      if (r.kind === 'opencode' || r.kind === 'agy') r.sessionId = logName(f).replace(/\.jsonl$/, '')
      else if (r.kind !== 'codex') r.sessionId = f.match(/([0-9a-f-]{36})\.jsonl$/)?.[1] ?? r.sessionId
      this.save()
      this.emit('logs', key)
    }
    // a menu it opened (Codex's /new asks where) may be answered a while later
    for (const ms of [1500, 5000, 15000, 60000, 180000]) setTimeout(look, ms)
  }

  /** find a log file this CLI started since the agent (re)started, when herdr didn't name one */
  discoverLog(key: string) {
    const r = this.records[key]
    if (!r) return
    const since = r.started - 5000
    const cwds = this.logCwds(key)
    const f =
      r.kind === 'claude'
        ? r.sessionId
          ? claudeLogPath(cwds, r.sessionId)
          : findClaudeLog(cwds, since)
        : r.kind === 'codex'
          ? findCodexLog(cwds, since)
          : r.kind === 'pi'
            ? findPiLog(cwds, since)
            : r.kind === 'opencode'
              ? r.sessionId
                ? mirrorOpencode(r.sessionId)
                : findOpencodeLog(cwds, since)
              : r.kind === 'agy'
                ? r.sessionId
                  ? mirrorAgy(r.sessionId)
                  : findAgyLog(cwds, since)
                : undefined
    // agy names its conversation by the log's name: that id is what --conversation resumes
    if (f && r.kind === 'agy') r.sessionId = logName(f).replace(/\.jsonl$/, '')
    if (f && addLog(r, f)) {
      this.save()
      this.emit('logs', key)
    }
  }

  /** an agent already running in herdr that Shepherdr should treat as this chat */
  adopt(key: string, a: AgentInfo, kind: string, workspace: string) {
    if (this.records[key]?.name === a.name) return
    this.records[key] = { key, name: a.name!, kind, cwd: a.cwd ?? '', workspace, logs: [], started: Date.now() }
    this.byName.set(a.name!, key)
    this.learnSession(key, a)
    this.save()
  }

  /* ---------- starting ---------- */

  /**
   * A server with a home of its own starts and moves no agent unless it was asked to (launch-policy.ts): refused before
   * anything it would do here (a turn stopped, a pane closed), and said in its log.
   */
  private allowed(key: string) {
    if (launchesAgents()) return true
    console.error(`shepherdr: ${skippedLaunch(key)}`)
    return false
  }

  /**
   * Start this chat's agent again on what spec says: `before` first (its turn stopped; what it returns is the first
   * message then, read once the turn is over), then its run ends and it starts, resuming its session on the same CLI.
   * Meanwhile anything that would start it waits for this instead, and what you send waits and goes in after the first
   * message. `before` throwing leaves it as it was.
   */
  restart(spec: Spec, before?: () => Promise<string | void>): Promise<AgentInfo | null> {
    if (!this.allowed(spec.key)) return Promise.reject(new Error(skippedLaunch(spec.key)))
    const problem = chatProblem(spec.kind)
    if (problem) return Promise.reject(new Error(problem))
    const p0 = this.starting.get(spec.key)
    const p = (async () => {
      await p0?.catch(() => undefined)
      this.stopping.add(spec.key)
      let next: { place: () => Promise<string>; close: () => Promise<void> } | undefined
      try {
        const first = await before?.()
        // the pane its new run goes in is opened while the run it takes over from still holds its own: herdr closes a
        // space with its last pane, and closing a task's only pane closed its worktree's space with it, under the run
        // coming in (a hand-over, SHE-166)
        next = await this.ahead(spec)
        await this.finish(spec.key)
        return await this.launch({ ...spec, ...(first ? { first } : {}), ...(next ? { pane: next.place } : {}) }).catch((e) => this.startedWrongly(spec.key, e))
      } finally {
        await next?.close()
        this.stopping.delete(spec.key)
        this.deliver(spec.key)
      }
    })().finally(() => this.starting.delete(spec.key))
    this.starting.set(spec.key, p)
    return p
  }

  /**
   * The pane this chat's next run goes in, opened before the run it takes over from ends (a restart): herdr closes a
   * space with its last pane, so a hand-over that closed a task's worktree space with the agent's only pane left the
   * run coming in nowhere to go. What the start would have opened itself, opened now; when that fails it falls back to
   * opening it in the start, as it always did, and a start that never gets that far (a cap, a worktree, a CLI) closes
   * the pane it never used.
   */
  private async ahead(spec: Spec) {
    // the record as the launch will leave it — its folder, space and tab as this spec has them, not as the run it takes
    // over from had them: a coordinator whose repo moved opens its tab in the folder the repo is in now
    const old = this.records[spec.key]
    const record: AgentRecord = {
      ...(old ?? { logs: [], started: Date.now() }),
      name: spec.name,
      kind: spec.kind,
      cwd: spec.cwd,
      workspace: spec.workspace,
      tab: spec.tab ?? old?.tab,
      env: spec.env ?? old?.env,
    }
    const make = spec.pane ?? (() => this.paneFor(record, spec.was))
    let pane: string | undefined
    try {
      pane = await make()
    } catch (e) {
      console.error(`shepherdr: couldn't open ${spec.key}'s pane ahead of its restart: ${(e as Error).message}`)
    }
    if (!pane) return undefined
    const made = pane
    let used = false
    return {
      place: async () => {
        used = true
        return made
      },
      close: async () => {
        if (!used) await herdr.closePane(made).catch(() => undefined)
      },
    }
  }

  /** start (or resume) this chat's agent; resolves once herdr says it is ready for input */
  ensure(spec: Spec): Promise<AgentInfo | null> {
    if (!this.allowed(spec.key)) return Promise.reject(new Error(skippedLaunch(spec.key)))
    const problem = chatProblem(spec.kind)
    if (problem) return Promise.reject(new Error(problem))
    const running = this.records[spec.key] ? this.info(spec.key) : this.live.get(spec.name)
    if (running) return this.bindRoute({ ...this.records[spec.key], ...spec } as AgentRecord, running.pane_id).then(() => running)
    const p0 = this.starting.get(spec.key)
    if (p0) return p0
    const p = this.launch(spec)
      .catch((e) => this.startedWrongly(spec.key, e))
      .finally(() => this.starting.delete(spec.key))
    this.starting.set(spec.key, p)
    return p
  }

  /** a start that threw where it could: its record keeps the reason, which start.ts shows the human */
  private startedWrongly(key: string, e: unknown): never {
    const r = this.records[key]
    if (r) {
      r.startError = (e as Error)?.message ?? String(e)
      this.save()
    }
    throw e
  }

  private async launch({ first, pane: place, was, ...spec }: Spec) {
    // the one place an agent is started: a server with a home of its own starts none unless it was asked to
    if (!this.allowed(spec.key)) throw new Error(skippedLaunch(spec.key))
    this.secretAccess.revoke(spec.key)
    this.routes.delete(spec.key)
    const old = this.records[spec.key]
    // its session is gone (start.ts): this launch starts a new one, whatever log files the chat keeps
    const resume = old && !old.fresh && old.kind === spec.kind && (old.sessionId || old.logs.length)
    const r: AgentRecord = old ?? { ...spec, logs: [], started: Date.now() }
    const changedPrompt = old?.system !== spec.system
    const from = old?.cwd
    Object.assign(r, {
      name: spec.name,
      kind: spec.kind,
      cwd: spec.cwd,
      workspace: spec.workspace,
      tab: spec.tab ?? r.tab,
      env: spec.env ?? r.env,
      access: spec.access ?? r.access,
      model: spec.model ?? r.model,
      effort: spec.effort ?? r.effort,
      system: spec.system ?? r.system,
      set: spec.set ?? r.set,
      finished: false,
      parked: undefined,
    })
    // on another machine the folder must exist there before its CLI starts. Make it here, once per launch (agentEnv
    // is called often — a route bind or a repair pass must never ssh): a box worker's own folder is made locally.
    if (BOX && r.env?.SHEPHERDR_TMP) await run(['mkdir', '-p', r.env.SHEPHERDR_TMP], { timeoutMs: 5000 }) // coverage-exempt: no box is reachable from these tests; the local path is covered
    this.codexState.delete(spec.key)
    r.started = Date.now()
    r.resumed = !!resume
    r.startError = undefined
    delete r.fresh
    // codex, opencode and agy name their session when they start: OpenCode's id comes from its own API (prepareOpencode)
    if (!resume) r.sessionId = r.kind === 'codex' || r.kind === 'opencode' || r.kind === 'agy' ? undefined : randomUUID()
    // a run of its own: what its hooks record starts over
    if (r.hooks) this.hooks.forget(mirrored(r.hooks))
    r.hooks = undefined
    this.records[spec.key] = r
    this.byName.set(r.name, r.key)
    this.save()
    // the start path reads this record back (a restart mid-launch must resume the new session), so make it durable
    this.flushRecords()
    task.mkdirSync(r.cwd, { recursive: true })
    // it starts in another folder now: its session goes with it, where --resume looks for it
    if (resume && r.kind === 'claude' && r.sessionId && from !== r.cwd) {
      const id = r.sessionId
      const log = carryClaudeSession(id, this.logCwds(spec.key))
      if (log) r.logs = [...r.logs.filter((f) => !f.endsWith(`/${id}.jsonl`)), log]
    }
    // herdr dropping a call (it closes a connection it was sent too late, see herdr.ts PASSING) is no failed start: each of
    // the two places that talk to it is tried again after a wait, a few times over a couple of minutes, and what the first
    // made (the worktree's space, the pane) is found again, never made twice (herdr.ts changing). Only when those tries
    // run out does the start fail, with the error
    const pane = await this.again(r, () => (place ? place() : this.paneFor(r, was)))
    // the pane this run takes over from, kept before closeLeftPane clears it: a new run retires it once it is up, and a
    // failed one leaves the record pointing at the run it abandoned, never at a pane with no agent in it
    const prior = [...new Set([r.lastPane, ...(r.superseded ?? [])].filter((p): p is string => !!p && p !== pane))]
    await this.closeLeftPane(r, pane)
    r.lastPane = pane
    r.superseded = undefined
    let ran = false
    try {
      await this.prepareOpencode(r, !!resume, changedPrompt)
      const args = this.args(r, !!resume)
      this.save()
      this.flushRecords()
      await this.again(r, () =>
        // a new pane needs a moment before its shell is at the prompt; the waits live with the reviewer's launch too
        startInPane(herdr, r.name, r.kind, pane, args, { giveUp: (e) => console.error(`shepherdr: could not start ${r.name}: ${(e as Error).message}`) }),
      )
      ran = true
      await this.refresh()
      try {
        // this launch owns the agent it just started: a restart's or a relaunch's stopping flag (held for what you send)
        // does not cancel its own bind, so the route is provisioned here, not left for the repair pass
        await this.bindRoute(r, pane, true)
      } catch (e) {
        // The CLI is up but Shepherdr cannot own it: an idle agent with no brief is worse than no agent. Take it down so
        // the next attempt starts clean, rather than leaving a pane that reads Working and never got its brief — also
        // inside a restart or a recovery, whose finally only delivers what you sent, never starts or stops. The pane
        // itself, not the live map finish() reads (which a concurrent refresh can leave stale under a stall): this
        // launch knows the pane it opened. A stop that raced the write already finished the record: never twice.
        if (!this.records[spec.key]?.finished) await this.finish(spec.key)
        await herdr.closePane(pane).catch(() => undefined)
        // the run that was up is down again and this launch's pane closed with it: leave no record pointing at a pane
        // with no agent, and keep the pane it took over from for the next launch to retire
        if (this.records[spec.key] === r) {
          r.lastPane = undefined
          r.superseded = prior
          this.save()
        }
        throw e
      }
      // CLIs without an option for extra instructions get them first, hidden from the chat: Claude Code and pi take them as
      // a flag, OpenCode in its session (prepareOpencode). Both wait until the CLI is ready, ahead of what you sent
      // meanwhile (a restart)
      this.queue(r.key, [r.kind !== 'claude' && r.kind !== 'pi' && r.kind !== 'opencode' && (!resume || changedPrompt) && r.system ? hidden(r.system) : '', first ?? ''].filter(Boolean), true)
      setTimeout(() => this.deliver(r.key), 1000)
      setTimeout(() => this.discoverLog(r.key), 3000)
      setTimeout(() => this.discoverLog(r.key), 15000)
      // a hand-over leaves two agents under one name: keep only the one in the pane just started, and retire the older
      // panes in this chat's herdr space. What the new run up there cannot prove safe is left, ignored by info's lastPane
      const current = this.info(spec.key)
      const older = (this.liveAll.get(r.name) ?? []).filter((a) => a.pane_id !== pane && (!current?.workspace_id || a.workspace_id === current.workspace_id)).map((a) => a.pane_id)
      await this.retire(spec.key, [...prior, ...older], pane)
      return this.info(spec.key) ?? null
    } catch (e) {
      if (!ran) {
        // a launch that never got its CLI up must not leave a second agent pane for a retry to find: it was ours, no
        // brief went in, and the record goes back to the run it abandoned, never at a pane with no agent in it
        await herdr.closePane(pane).catch(() => undefined)
        if (this.records[spec.key] === r) {
          r.lastPane = undefined
          r.superseded = prior
          this.save()
        }
      }
      throw e
    }
  }

  /** `f` again after each wait of startDelays() while herdr fails it in a passing way (isPassing); said in the log */
  private again<T>(r: AgentRecord, f: () => Promise<T>) {
    let n = 0
    return retrying(
      async () => {
        try {
          return await f()
        } catch (e) {
          if (isPassing(e)) console.error(`shepherdr: ${r.name}'s start met a passing herdr error (${(e as Error).message}); trying again (${++n})`)
          throw e
        }
      },
      startDelays(),
      dropped,
    )
  }

  /**
   * OpenCode's session is made here, before its TUI starts on it. A fresh start creates it (folder, the agent's name as
   * title, model and effort, its permissions when it asks) and puts its instructions in; a failure fails the launch. A
   * resume keeps the session: its model is switched, and changed instructions are put in again. A failure there is
   * logged and the launch goes on.
   */
  private async prepareOpencode(r: AgentRecord, resume: boolean, changedPrompt: boolean) {
    if (r.kind !== 'opencode') return
    const model = modelArg(r.kind, r.model)
    const effort = effortFor(r.kind, r.effort, r.model)
    if (resume && r.sessionId) {
      if (model) await switchModel(r.sessionId, model, effort, r.cwd).catch((e) => console.error(`shepherdr: ${r.name} could not switch its model: ${(e as Error).message}`))
      if (r.system && changedPrompt) await putInstructions(r.sessionId, r.system, r.cwd).catch((e) => console.error(`shepherdr: ${r.name} could not update its instructions: ${(e as Error).message}`))
      return
    }
    r.sessionId = await createSession({ cwd: r.cwd, title: r.name, model, effort, ask: r.access === 'ask', command: agentEnv(r.key, ROOT).SHEPHERDR_COMMAND, chat: r.key })
    addLog(r, opencodeLogPath(home(), r.sessionId))
    if (r.system) await putInstructions(r.sessionId, r.system, r.cwd)
    this.save()
    this.flushRecords()
  }

  args(r: AgentRecord, resume: boolean): string[] {
    const a: string[] = []
    // a model is kept by its id, or by its name when picked in the chat's menu (Opus 5.5); an effort its model lacks
    // goes in as the nearest it has
    const model = modelArg(r.kind, r.model)
    const effort = effortFor(r.kind, r.effort, r.model)
    if (r.kind === 'claude') {
      if (resume && r.sessionId) a.push('--resume', r.sessionId)
      else if (r.sessionId) a.push('--session-id', r.sessionId)
      // its hooks tell Shepherdr what it does (readers/hooks.ts), from a settings file of its own: yours stay untouched.
      // The same file lets it run its own shepherdr command without a prompt (readers/own-commands.ts), by the exact
      // path Shepherdr puts on its PATH and its own chat identity
      const h = hookSettings(HOOKS_DIR, r.name, { command: agentEnv(r.key, ROOT).SHEPHERDR_COMMAND, chat: r.key })
      r.hooks = h.events
      a.push('--settings', h.settings)
      if (r.system) a.push('--append-system-prompt-file', this.promptFile(r))
      if (model) a.push('--model', model)
      if (effort) a.push('--effort', effort)
    } else if (r.kind === 'pi') {
      // pi has no permission system, in either access mode: no flag, no allow list, nothing to port. --approve below is
      // about trusting a worktree's files, not about approving tool calls.
      // A worktree Shepherdr made is trusted for this run with pi's own one-shot --approve, so its .pi extensions,
      // skills and MCP servers load without anyone answering pi's trust prompt in the chat. Nothing is written to
      // pi's own trust.json (as with agy's --settings below). A coordinator on a space the human picked keeps pi's
      // first-run prompt. opencode has no trust dialog: its session carries permissions instead.
      if (taskWorktreeKey(r.key)) a.push('--approve')
      if (r.sessionId) a.push('--session-id', r.sessionId)
      if (r.system) a.push('--append-system-prompt', this.promptFile(r))
      if (model) a.push('--model', model)
      if (effort) a.push('--thinking', effort)
    } else if (r.kind === 'codex') {
      // Codex tools have their own environment policy. Set the owner explicitly even on resume;
      // do not depend on the pane's login shell or its stale inherited environment.
      const env = { ...r.env, ...agentEnv(r.key, ROOT) }
      a.push(
        '-c',
        `shell_environment_policy.set={${Object.entries(env)
          .map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`)
          .join(',')}}`,
      )
      // its own last log: a task it took over keeps the logs of the agent before it too
      const id = resume ? r.logs.findLast((f) => (logKind(f) ?? 'codex') === 'codex')?.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1] : undefined
      if (id) a.unshift('resume', id)
      if (r.access === 'ask') {
        // Keep Codex's approvals: its PermissionRequest hook allows exactly this launch's own shepherdr verbs
        // (own-commands.ts) and says nothing about other calls, so they still show Codex's prompt. A full-access launch
        // has no prompt to decide, so it needs no hook. This is the Codex half of upstream's SHEP-23, ported here
        // because 2.0 has no core-side permission mailbox: the decision must travel with the launch.
        const hook = codexPermissionHook(HOOKS_DIR, r.name, agentEnv(r.key, ROOT).SHEPHERDR_COMMAND, r.key)
        if (hook) a.push(...hook)
      } else a.push('--dangerously-bypass-approvals-and-sandbox')
      if (model) a.push('-m', model)
      if (effort) a.push('-c', `model_reasoning_effort="${effort}"`)
    } else if (r.kind === 'agy') {
      // agy names its conversation itself: a resume goes back to it by its id (--conversation; never --continue, which takes
      // the newest one of the whole machine). The model takes its effort in its id (gemini-3.8-flash-low), and --effort
      // conflicts with that, so it is never passed.
      // The worktree is trusted for this session only (--settings): a new worktree is a folder agy has not seen, and it would
      // stop on its trust screen. Nothing is written to agy's own settings.
      // Permissions: unlike Claude (a PreToolUse hook) and Codex (hooks.PermissionRequest), agy's installed help names
      // no per-command allow-list flag or settings key (--settings takes settings.json keys, and none is documented
      // here), so an 'ask' launch keeps agy's own prompts and a full-access launch keeps --dangerously-skip-permissions.
      // Upstream has nothing for agy (3.x runs Claude and Codex only); the asymmetry is this CLI's, not a launch's.
      a.push('--settings', JSON.stringify({ trustedWorkspaces: [r.cwd] }))
      if (resume && r.sessionId) a.push('--conversation', r.sessionId)
      if (model) a.push('--model', agyModelId(model, effort, agyIds()))
      if (r.access !== 'ask') a.push('--dangerously-skip-permissions')
    } else if (r.kind === 'opencode') {
      // --standalone always: its shell commands then run in the pane's own process tree, where helper/route.pl finds
      // this agent. No model flag (the TUI has none): the model and effort live in its session (prepareOpencode)
      a.push('--standalone', ...(r.sessionId ? ['--session', r.sessionId] : []), ...(r.access !== 'ask' ? ['--auto'] : []))
    }
    return a
  }

  /** instructions go in a file: long text with quotes and newlines can't travel as a shell argument */
  private promptFile(r: AgentRecord) {
    const f = promptPath(r.name)
    task.mkdirSync(dirname(f), { recursive: true })
    task.writeFileSync(f, r.system ?? '')
    return f
  }

  /** the files Shepherdr starts its CLI with now, by flag: its hooks' settings and its instructions. One started with
   *  others (herdr restored an older command after it restarted) runs without them */
  filesOf(r: AgentRecord): Record<string, string> {
    if (r.kind === 'claude') return { '--settings': join(HOOKS_DIR, `${r.name}.settings.json`), ...(r.system ? { '--append-system-prompt-file': promptPath(r.name) } : {}) }
    if (r.kind === 'pi' && r.system) return { '--append-system-prompt': promptPath(r.name) }
    return {}
  }

  /** what is wrong with this agent's run: gone from herdr, its CLI exited in its pane, or it runs on outdated files;
   *  nothing while it is fine (or while herdr still launches it), null when herdr can't say. One on outdated files is
   *  left alone while herdr sees it at work or asking (a turn is never cut for this); its hooks don't count, as what
   *  they last said may be from before */
  async wrong(key: string): Promise<Wrong | undefined | null> {
    const r = this.records[key]
    if (!r) return undefined
    const a = this.info(key)
    if (!a) return 'gone'
    // a launch herdr has not finished yet is neither gone nor exited (agentWrong): starting it again would launch it twice
    if (a.launch_pending) return undefined
    const p = await herdr.processInfo(a.pane_id).catch(() => null)
    return agentWrong(a, p, r.kind, this.filesOf(r))
  }

  /** whether its hooks last said it was at work, even while it is gone: a turn its log shows over is over */
  wasWorking(key: string) {
    const r = this.records[key]
    const said = r?.hooks ? this.hooks.read(mirrored(r.hooks)).said : undefined
    return said?.state === 'working' && !this.endedSince?.(key, said.at)
  }

  /** being started or stopped right now */
  busy(key: string) {
    return this.starting.has(key) || this.stopping.has(key)
  }

  /** started again by `start` (that resumes its session), its pane closed first where it still holds it (its CLI
   *  exited, or runs on outdated files). Meanwhile what you send waits for the one it starts, as in a restart */
  async relaunch(key: string, close: boolean, start: () => Promise<unknown>) {
    // nothing closed, nothing stopped, and the caller hears why (a recovery loop gives up instead of retrying for good)
    if (!this.allowed(key)) throw new Error(skippedLaunch(key))
    this.secretAccess.revoke(key)
    this.routes.delete(key)
    this.stopping.add(key)
    try {
      const r = this.records[key]
      const live = close ? this.info(key)?.pane_id : undefined
      if (live) {
        await this.reapPane(live)
        await this.refresh()
      }
      // a launch herdr dropped leaves its pane as a plain shell with no agent in it: info() has nothing to close, but
      // the record remembers it. Retire it before the retry, so the task never ends up with two of its own panes
      const stale = [r?.lastPane, ...(r?.superseded ?? [])].filter((p): p is string => !!p && p !== live)
      if (stale.length) await this.retire(key, stale, live ?? '')
      await start()
    } finally {
      this.stopping.delete(key)
      this.deliver(key)
    }
  }

  /** the workspace labelled so, or the one still labelled `was` (never a repo's), renamed to it */
  async space(label: string, was?: string) {
    const list = await herdr.workspaces()
    const ws = list.find((w) => w.label === label)
    const old = !ws && was ? list.find((w) => w.label === was && !w.worktree) : undefined
    if (old) await herdr.renameWorkspace(old.workspace_id, label)
    return ws ?? old
  }

  /** a pane for this chat, in its space: one herdr opens for it when it has none, in a tab of its own otherwise. A space
   *  that closed between finding it and opening a tab in it (herdr closes a space with its last pane, and a hand-over
   *  ends the agent's run) is one herdr opens again for the chat */
  private async paneFor(r: AgentRecord, was?: string): Promise<string> {
    const env = r.env ?? {}
    const make = async () => (await herdr.createWorkspace(r.workspace, r.cwd, env)).root_pane.pane_id
    const ws = await this.space(r.workspace, was)
    if (!ws) return make()
    try {
      return (await herdr.createTab(ws.workspace_id, r.tab ?? r.name, r.cwd, env)).root_pane.pane_id
    } catch (e) {
      // a space it still has is the chat's own failure; one that went away is made again
      if (!missing(e) || (await this.space(r.workspace, was))) throw e
      return make()
    }
  }

  /**
   * A chat's record put back as it was before a start that failed: a start writes its own CLI, and a session it never
   * ran, over the record before it asks herdr for a pane. What comes after starts from what the agent was, so the same
   * CLI resumes its own session and another CLI is handed the brief and its instructions again. Two things of the
   * failed start stay: why it failed (start.ts shows it), and whether its run was ended; its hooks were forgotten with
   * the run it started, so the old ones never come back.
   */
  restore(key: string, record: AgentRecord | undefined) {
    if (!record) return
    const now = this.records[key]
    const back = { ...record }
    delete back.hooks
    this.records[key] = { ...back, finished: now?.finished, ...(now?.startError ? { startError: now.startError } : {}) }
    this.byName.set(record.name, key)
    this.save()
    this.flushRecords()
  }

  /* ---------- sending ---------- */

  /** why what you send would wait now, or nothing: it goes in at once. Typed text could pick an option on a menu or
   *  permission prompt, so it waits for the prompt to go; a starting agent isn't taking input yet; a CLI command waits for
   *  the turn to end. Anything else goes in even mid-turn: the CLI takes it at its next step. */
  holdOf(key: string, item?: Pick<OutItem, 'idle'>): Hold | undefined {
    return this.heldBy(key, item) ?? (this.unready.has(key) ? 'start' : undefined)
  }

  /** the same, without an agent herdr refused as not ready yet: that one is simply tried again */
  private heldBy(key: string, item?: Pick<OutItem, 'idle'>): Hold | undefined {
    const st = this.status(key)
    // stopping for a restart: what you send goes to the agent it starts on
    if (st === 'gone' || this.stopping.has(key) || this.info(key)?.interactive_ready === false) return 'start'
    if (st === 'blocked' || this.menuUp?.(key)) return 'menu'
    if (item?.idle && st === 'working') return 'turn'
    return undefined
  }

  /** what you send: in at once, unless the agent is on a menu or still starting (see holdOf). Returns whether it waits.
   *  What a screen sent (with its id) waits only that long: when the agent can't take it or won't start, the screen hears
   *  so and offers Retry. */
  send(key: string, text: string, o: SendOpts = {}): Promise<Sent> {
    const cid = o.cid
    if (!cid) return this.sendNow(key, text, o)
    // the screen sends again what it heard no answer for, maybe while the first is still on its way: once is enough
    const on = this.inflight.get(cid)
    if (on) return on
    const p = this.sendNow(key, text, o).finally(() => this.inflight.delete(cid))
    this.inflight.set(cid, p)
    return p
  }

  private async sendNow(key: string, text: string, { reaction, ensure, cid, idle, command }: SendOpts): Promise<Sent> {
    if (cid?.startsWith('requested-news:') && this.newsReceipts.includes(cid)) return { waiting: false, item: { id: cid, cid, key, text, at: Date.now() } }
    const again = cid && this.outbox.find((o) => o.cid === cid)
    if (again) return { waiting: true, waitsFor: this.whyWaits(key), item: again }
    const done = cid && this.delivered.find((o) => o.cid === cid)
    if (done) return { waiting: false, item: done }
    // sent again after it failed: it is on its way once more
    if (cid) this.failures = this.failures.filter((f) => f.cid !== cid)
    const item: OutItem = { id: randomUUID(), key, text, reaction, at: Date.now(), ...(cid ? { cid } : {}), ...(idle ? { idle } : {}), ...(command ? { command } : {}) }
    if (this.status(key) === 'gone' && ensure && cid) {
      try {
        await ensure()
      } catch (e) {
        throw new Error(`The agent didn't start: ${(e as Error).message}`)
      }
      if (this.status(key) === 'gone') throw new Error(this.reachable ? "The agent isn't running." : "Can't reach herdr.")
    }
    await this.beforeInput?.(key)
    // what waits goes first, so nothing overtakes it
    let hold: Hold | undefined
    if (!this.holdOf(key, item) && !this.outbox.some((o) => o.key === key)) {
      try {
        await this.put(key, item)
        this.unready.delete(key)
        this.went(item)
        this.emit('sent', item)
        return { waiting: false, item }
      } catch (e) {
        // a menu came up just now, or the agent just started and herdr doesn't take input for it yet: it waits
        hold = holdFrom(e)
        if (hold === 'start' && !this.unready.has(key)) this.unready.set(key, Date.now())
        if (cid && !hold) throw new Error(`The agent didn't take it: ${(e as Error).message}`)
        /* falls through: it waits */
      }
    }
    this.outbox.push(item)
    this.save()
    const st = this.status(key)
    if (st === 'gone' && ensure)
      ensure()
        .then(() => this.deliver(key))
        .catch(() => undefined)
    else this.deliver(key)
    return { waiting: true, waitsFor: hold ?? this.whyWaits(key), item }
  }

  /** one thing into the CLI. A slash command is checked: a CLI may take its Enter for a pick in the list of commands
   *  it shows as you type, so while it still sits in the input, Enter goes again; one that never runs is wiped from
   *  the input and fails, so the chat says so instead of waiting on it. */
  private async put(key: string, item: OutItem) {
    // only the pane is cleaned: item.text stays the original in the chat log and in what went in
    const text = stripControl(item.text)
    await herdr.prompt(this.records[key].name, text)
    const pane = item.command && this.info(key)?.pane_id
    if (!pane) return
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const read = async () => leftAtPrompt(await herdr.read(pane, 'text', 30).catch(() => ''), text)
    // twice, a moment apart: a screen not yet redrawn must not get an Enter that picks from the menu it opened
    const left = async () => (await read()) && (await sleep(this.commandMs / 2), await read())
    for (let i = 0; i < 3; i++) {
      await sleep(this.commandMs)
      if (!(await left())) return
      if (i < 2) await herdr.paneKeys(pane, ['enter'])
    }
    await herdr.paneKeys(pane, Array(text.length + 2).fill('backspace')).catch(() => undefined)
    throw new Error(`${text.trim().split(/\s/)[0]} didn't run in the terminal.`)
  }

  /** how long a CLI has to run a slash command before its input is looked at */
  commandMs = 800

  /** why what waits for this agent waits: the first in line holds the rest */
  private whyWaits(key: string) {
    const first = this.outbox.find((o) => o.key === key)
    return first ? this.holdOf(key, first) : undefined
  }

  /** hand over what waited, oldest first, while the agent can take it */
  async deliver(key: string) {
    if (this.delivering.has(key)) return
    this.delivering.add(key)
    try {
      for (;;) {
        const next = this.outbox.find((o) => o.key === key)
        if (!next) return void this.unready.delete(key)
        if (next.cid?.startsWith('requested-news:') && this.newsReceipts.includes(next.cid)) {
          this.outbox = this.outbox.filter((o) => o !== next)
          this.save()
          continue
        }
        await this.beforeInput?.(key)
        if (this.heldBy(key, next)) return
        await this.put(key, next)
        this.unready.delete(key)
        this.went(next)
        this.outbox = this.outbox.filter((o) => o !== next)
        this.save()
        this.emit('sent', next)
        // give the CLI a moment to take it before the next item
        await new Promise((r) => setTimeout(r, 1500))
        await this.refresh()
      }
    } catch (e) {
      // a menu came up just now: it goes in once the menu is gone
      const hold = holdFrom(e)
      if (hold === 'menu') return
      // just started, not herdr's named agent yet: tried again on the next refresh, for a while
      if (hold === 'start') {
        const since = this.unready.get(key) ?? Date.now()
        this.unready.set(key, since)
        if (Date.now() - since < this.unreadyFor) return
        this.unready.delete(key)
      }
      // tried again on the next status change; what a screen sent fails now, so it doesn't wait on an agent that can't
      // take it
      this.fail(key, `The agent didn't take it: ${(e as Error).message}`)
    } finally {
      this.delivering.delete(key)
    }
  }

  /** what a screen sent that couldn't go in, in the last ten minutes */
  failedLately(key: string) {
    const now = Date.now()
    return this.failures.filter((f) => f.key === key && now - f.at < 600_000).map(({ cid, error }) => ({ cid, error }))
  }

  /** ahead: before what waits for this agent already */
  private queue(key: string, texts: string[], ahead = false) {
    if (!texts.length) return
    const items = texts.map((text) => ({ id: randomUUID(), key, text, at: Date.now() }))
    const i = ahead ? this.outbox.findIndex((o) => o.key === key) : -1
    if (i < 0) this.outbox.push(...items)
    else this.outbox.splice(i, 0, ...items)
    this.save()
  }

  waiting(key: string) {
    return this.outbox.filter((o) => o.key === key)
  }

  /** what went in with a screen's id in the last ten minutes, oldest first; at is when it went in */
  sentLately(key: string) {
    const now = Date.now()
    return this.delivered.filter((o) => o.key === key && now - o.at < 600_000)
  }

  /** what went in since this time (the last ten minutes at most) */
  typedSince(key: string, at: number) {
    return this.typed.filter((o) => o.key === key && o.at > at)
  }

  private went(item: OutItem) {
    const now = Date.now()
    this.typed = [...this.typed.filter((o) => now - o.at < 600_000), { ...item, at: now }].slice(-200)
    writeJson('typed.json', this.typed)
    if (!item.cid) return
    if (item.cid.startsWith('requested-news:') && !this.newsReceipts.includes(item.cid)) {
      this.newsReceipts.push(item.cid)
      writeJson('requested-news-receipts.json', this.newsReceipts)
    }
    this.delivered = [...this.delivered.filter((o) => now - o.at < 600_000), { ...item, at: now }].slice(-200)
  }

  async keys(key: string, keys: string[]) {
    const a = this.info(key)
    if (a) await herdr.paneKeys(a.pane_id, keys)
  }

  /**
   * "Send now" on a message its CLI holds in its own queue: Claude Code's Ctrl+Enter, pressed only while its screen
   * offers it (on any other screen it would type something else). A CLI with no such offer never gets a key. Whether it
   * was pressed: false once its turn is over, since what it queued goes in on its own then.
   */
  async steerNow(key: string): Promise<boolean> {
    if (this.record(key)?.kind !== 'claude') return false
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, i ? 300 : 150))
      const a = this.status(key) === 'working' ? this.info(key) : undefined
      if (!a) return false
      // what the pane shows now, never a deeper read: that would scroll a working agent's view
      if (!/ctrl\+enter to send now/i.test(await herdr.visible(a.pane_id).catch(() => ''))) continue
      await herdr.paneKeys(a.pane_id, ['ctrl+enter'])
      return true
    }
    return false
  }

  async text(key: string, text: string) {
    const a = this.info(key)
    if (a) await herdr.paneText(a.pane_id, stripControl(text))
  }

  /** its terminal's recent lines and the pane's size, so a screen draws them at its real width; the size is read again
   *  at most every few seconds, not on every change on the screen */
  async screen(key: string): Promise<TermScreen> {
    const a = this.info(key)
    if (!a) return { ansi: '' }
    const known = this.sizes.get(a.pane_id)
    const fresh = known && Date.now() - known.at < 3000
    const [ansi, size] = await Promise.all([herdr.read(a.pane_id, 'ansi', 300), fresh ? known.size : herdr.size(a.pane_id).catch(() => null)])
    if (!fresh) this.sizes.set(a.pane_id, { at: Date.now(), size })
    return { ansi, ...size }
  }

  /** its terminal's last lines as plain text */
  async screenText(key: string): Promise<string> {
    const a = this.info(key)
    return a ? herdr.read(a.pane_id, 'text', 60) : ''
  }

  watchTerminals(keys: string[]) {
    const panes = new Set(keys.map((k) => this.info(k)?.pane_id).filter(Boolean) as string[])
    const changed = panes.size !== this.watchedPanes.size || [...panes].some((p) => !this.watchedPanes.has(p))
    this.watchedPanes = panes
    for (const p of this.sizes.keys()) if (!panes.has(p)) this.sizes.delete(p)
    if (changed) this.refresh()
  }

  /** close a pane Shepherdr itself is done with: capture what runs under its shell, then end what survived the close.
   *  An MCP server, its Chrome, a dev or proof server the agent left are all reparented to init when the pane goes;
   *  they are ours to end only because their ancestry ran through this shell. A live task's agent-browser Chrome is
   *  left to browser.ts, and another user's process is never in the table (orphans.ts). */
  async reapPane(pane: string) {
    const caught = await herdr
      .processInfo(pane)
      .then((p) => (p.shell_pid ? capture(readTree(this.reaper.source), p.shell_pid) : []))
      .catch(() => [] as number[])
    await herdr.closePane(pane).catch(() => undefined)
    if (caught.length) await this.reaper.end(caught).catch(() => undefined)
  }

  /** park an idle agent (source.ts's sweep, SHE-72): its run ends as a finish ends it, its pane closes and what it
   *  left running is reaped, and the record keeps that it was parked, so the task row, its chat and shepherdr status
   *  can say so. Its chat keeps reading its session, and the next message to it starts it again on the same session */
  async park(key: string, at = Date.now()) {
    const r = this.records[key]
    if (!r || r.finished) return
    r.parked = at
    await this.finish(key)
  }

  /** end a task agent's run: its pane closes; its chat stays and writing to it resumes it */
  async finish(key: string) {
    this.secretAccess.revoke(key)
    this.routes.delete(key)
    const r = this.records[key]
    const a = this.info(key)
    if (r) r.finished = true
    this.save()
    this.flushRecords()
    if (!a) return
    await this.reapPane(a.pane_id)
    // gone from what herdr runs at once: starting it again (a backup agent taking over) starts a new one
    await this.refresh()
  }

  /** everything but the write: a record and what waited for it, dropped in memory */
  private drop(key: string) {
    this.secretAccess.revoke(key)
    this.routes.delete(key)
    const r = this.records[key]
    if (r && this.byName.get(r.name) === key) this.byName.delete(r.name)
    delete this.records[key]
    this.outbox = this.outbox.filter((o) => o.key !== key)
    this.failures = this.failures.filter((f) => f.key !== key)
    this.stranded.delete(key)
  }

  /** a deleted task's agent, forgotten: its record (so its chat no longer reads its CLI's log) and what waited for it */
  forget(key: string) {
    this.drop(key)
    this.save()
    // a forget is durable when it returns: a restart must not bring the deleted chat's agent back
    this.flushRecords()
  }

  /** drop records no screen, search or command can reach (PERFS-12), whatever the caller says is not live: today the
   *  engine only names task chats of deleted tasks, and keeps every coordinator. Kept records (archived tasks' chats
   *  above all) keep their logs, so a chat the operator can still open reads its history. One batched write for the
   *  whole pass, whatever the number of orphans. */
  prune(keep: (key: string, record: AgentRecord) => boolean): number {
    let dropped = 0
    for (const [key, r] of Object.entries(this.records)) {
      if (keep(key, r)) continue
      this.drop(key)
      dropped++
    }
    if (dropped) {
      this.save()
      this.flushRecords()
    }
    return dropped
  }

  /** a turn under way ended cleanly before its run ends (a restart): interrupted, then a few seconds for the CLI to
   *  stop and write what it had; still at work after that, it throws and is left as it is */
  async stopTurn(key: string, ms = 15_000) {
    if (this.status(key) !== 'working') return
    await this.interrupt(key)
    for (const end = Date.now() + ms; this.status(key) === 'working'; ) {
      if (Date.now() > end) throw new Error('It is still working after an interrupt: try again in a moment.')
      await new Promise((r) => setTimeout(r, 500))
      await this.refresh()
    }
    // what it wrote last reaches its log
    await new Promise((r) => setTimeout(r, 500))
  }

  async interrupt(key: string) {
    const a = this.info(key)
    if (a) await herdr.sendKeys(this.records[key].name, ['esc']).catch(() => undefined)
  }
}
