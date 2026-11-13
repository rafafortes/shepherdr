import { TaskIds } from '../task-ids.ts'
import { trustWorktree } from '../trust.ts'
// The tasks engine. A task is added by a coordinator and at once gets one agent, in its own git worktree and branch
// from main. The coordinator's brief is the agent's first message and decides everything else (wait for a go, plan
// first, ask a reviewer, merge or wait for a yes). Its status comes from that agent alone: working, waiting on you, To
// do (it waits for a go: shepherdr todo), ready (shepherdr ready) or done (shepherdr merge, or closed with nothing to
// merge: shepherdr task close, or shepherdr ready on a branch with no changes). A task may also be queued after other
// tasks (--after): it has no agent, worktree or herdr space until they are done and the machine has room, when its
// agent starts on the brief and the go. On a GitHub repo gh is
// logged in to, its work goes through a pull request: shepherdr pr pushes its branch and opens one (a draft until it
// reports done), shepherdr checks waits for GitHub's checks, and shepherdr merge squash-merges it on GitHub at the
// commit this machine has, then brings main here up to date. Anywhere else it is squash-merged here.
import { existsSync, statSync } from '../mfs.ts'
import { agentEnv, BOX } from '../box.ts'
import { join } from 'node:path'
import { STATUS_MAX, TITLE_MAX, type Question, type Report, type Task, type TaskStatus, type UpdateCard } from '../../../shared/types.ts'
import { clockWords, startsLine } from '../../../shared/when.ts'
import { Emitter } from '../../source.ts'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { home, readJson, writeJson } from '../../store.ts'
import { ROOT } from '../../root.ts'
import { has } from '../../plugins.ts'
import { browserEnv } from '../browser.ts'
import { hidden, ROUTING_FAILURE, type Agents, type Spec } from '../agents.ts'
import { launchesAgents, refusedLaunch } from '../launch-policy.ts'
import { fromAgentLine } from '../chatlines.ts'
import type { Chats } from '../chats.ts'
import { HOST, placeId, type Places, type Space } from '../places.ts'
import { type BaseMoved, baseMovedCard, baseMovedLine, privatePrompt, freshLine, goLine, handOverLine, backupKeptLine, backupCardWords, wentBackCardWords, restartLine, type BackWhy, resumedLine, settingsBlock, prNewsLine, queuedLine, rebriefReviewer, briefReview, reviewerChangedLine, reviewerLine, splitBrief, taskFirst, taskPrompt } from '../prompts.ts'
import { inMins, type Retry } from '../retry.ts'
import { pastTimes } from '../estimates.ts'
import { backupModelOf, chainPairs, CLI_NAME, kindOf, type Settings } from '../settings.ts'
import { findModel, knowsModels } from '../models.ts'
import { keyOf } from '../models-summary.ts'
import { capFor, providerOfKey, type MaxEntry } from '../../../shared/model-caps.ts'
import { fitHarness, harnessWords, recentChat, sameHarness } from '../restart.ts'
import * as G from './git.ts'
import { Worktrees, type HerdrSpaces, type Made } from './worktrees.ts'

export interface TaskRec {
  id: string
  n: number
  project: string
  title: string
  desc: string
  by: string
  /** Exact coordinator chat that requested this task, when known. */
  requester?: string
  created: number
  updated: number
  branch?: string
  worktree?: string
  base?: string
  /** its pull request on GitHub, once one is open */
  pr?: { number: number; url: string }
  /** the commit Shepherdr last pushed to its branch on GitHub, and when: checks a push starts take a moment to show */
  pushed?: { sha: string; at: number }
  /** what its agent knows of its pull request, so news is told once: comments from before `since` (when it first
   *  reported done) and those in `seen` (by id), and the checks that failed at a commit (`failed`) */
  watch?: { since: string; seen?: string[]; failed?: string }
  /** the agent's own words when it reported done */
  said?: string
  /** its facts line (PR, commit, checks, review, not proven), apart from the summary */
  facts?: string
  /** the agent ran shepherdr ready and nothing was asked of it since */
  reported?: boolean
  /** on its way into main since it was reported ready: merging, GitHub's checks, a rebase (Merging) */
  landing?: Landing
  merged?: boolean
  /** the commit its squash merge made on its base: what its branch is checked against when it is put away */
  squash?: string
  /** done with nothing merged (shepherdr task close, or done with no changes): Done all the same */
  closed?: boolean
  /** when it was merged or closed; tasks from before it was kept fall back to their last update */
  doneAt?: number
  /** when its agent first reported done: how long tasks take, for agents' guesses of their time left (estimates.ts) */
  reportedAt?: number
  /** its place was put away once done: agent, space, worktree and branch (what lost nothing) */
  cleaned?: boolean
  /** what putting it away kept, and why ("~/x (uncommitted changes)") */
  kept?: string[]
  /** starting it went wrong */
  trouble?: string
  plan?: string[]
  /** its agent waits for a go (shepherdr todo); anything written to it clears it */
  todo?: boolean
  /** queued: the tasks it waits for ("SHE-12", or "vm-str:SHE-12" on another machine); cleared by the go Shepherdr
   *  sends once they are all done, or by anything written to it */
  after?: string[]
  /** starts by itself at a time (`task add --at`/`--in`, or `task queue <id> --at`): when, in the time zone Settings
   *  sets. A task added for a time has no agent yet, and takes its Settings when it starts, not when it was added */
  scheduled?: Scheduled
  /** the go sent to its agent, until the agent is seen at work: a restart in between sends it again */
  going?: string
  /** held by Shepherdr until this machine has room for it (Settings → the machine's limits): why it waits (all its
   *  slots are taken, or the machine is too loaded) and since when. go: the message its agent gets then, and why it
   *  starts (none: it has no agent yet, and starts then on its brief). Anything you write to it lets it go at once */
  held?: { why: HeldWhy; since: number; go?: string; goWhy?: string; plain?: boolean }
  /** shepherdr task stop closed its agent and space; writing to it again clears it */
  stopped?: boolean
  /** the words of a start that never became a turn (start.ts), kept so a restart still knows which trouble a turn, or a
   *  word, clears: another trouble that replaced it stays */
  startTrouble?: string
  /** the status coordinators were last told, so each change is told once */
  told?: TaskStatus
  /** the state last posted as a card (waiting on you, or done), so each is posted once */
  posted?: string
  /** when it was archived: out of every list and count, its record and chat kept (search and Archived show it) */
  archived?: number
  /** when it was last brought back: a Done task is archived again only that long after */
  unarchived?: number
  /** paused from the screen or task pause: 'sent' until its agent is seen stopped, then 'idle'. Seen at work again
   *  after that (work it left running in the background woke it), it is no longer paused: it works, and shows so */
  paused?: 'sent' | 'idle'
  /** when it was pinned: it shows in the Pinned group at the top of its lists; archiving or deleting it drops the pin */
  pinned?: number
  /** the CLI, model and effort its agent first starts with: from Settings, or task add's flags */
  agent?: Harness
  /** task add's --agent, --model or --effort chose `agent`, not Settings: counted apart when Settings' task agent is
   *  applied to the waiting tasks (retuneWaiting); a worker picked later (Start with…) clears it */
  chosen?: true
  /** the CLI, model and effort its brief says reviews its change: from Settings, or task add's --reviewer flags */
  reviewer?: Harness
  /** task add's --reviewer flags chose `reviewer`, not Settings: counted apart when Settings' reviewer is applied to the
   *  waiting tasks (retuneReviewers); a reviewer picked later clears it */
  reviewerChosen?: true
  /** Settings' reviewer changed while the task waited, and its agent already has its brief: the line its agent hears
   *  with its go, or with the first message that reaches it (takeNote) */
  reviewerNote?: string
  /** the coordinator's --set for this task, kept as it was given: the backup values this one task keeps for itself
   *  (task.fallback, backup.model, backup.effort) are read from here before its space's (cantGoOn) */
  set?: Record<string, string>
  /** shepherdr merge waits for GitHub's checks, as its brief's Settings block said when it was added (Settings, or
   *  task add --set); none: a task from before, which follows Settings as they are now */
  waitChecks?: boolean
  /** the review rounds its brief's Settings block said when it was added (Settings, or task add --set); none: a task
   *  from before, which follows its space's Settings as they are now */
  rounds?: number
  /** review rounds its agent has counted (shepherdr review): what the brief's at most so many are kept by */
  reviews?: number
  /** rounds its coordinator added past those (shepherdr task review-more): one at most, and never by its own agent */
  reviewsAdded?: number
  /** what its agent last said of its own progress (shepherdr status): kept while it works or waits on you */
  report?: Reported
  /** its backup agent took over once its agent couldn't go on (retry.ts): from which CLI, to which, and why */
  tookOver?: { from: string; to: string; why: string; at: number; step?: number }
  /** why its last merge stopped, in words its row shows until the next one starts: the gate's refusal with its last
   *  line ("Refused by the gate: …") */
  mergeStop?: string
  /** its merge gate's run, detached so that a restart of Shepherdr doesn't stop it (startGate): found again then */
  gateRun?: GateRun
  /** merged with this task's merge train, on its gate run (train) */
  train?: string
  /** a member of a merge train its gate refused: its next merge goes alone, on its own gate, before it rides or heads a
   *  train again (alone); cleared once that lone gate ran to its end (passed, refused or timed out). A turn a restart or
   *  a kill cut short never gated, so it keeps the mark and goes alone on its next merge */
  alone?: true
  /** first in line (start now, or a coordinator's priority mark for a fix of a red main): it goes ahead of the other
   *  held tasks and past the machine's load, pressure and spacing, never past its slots (room, release) */
  priority?: true
  /** started now on a worker of the human's choosing while its agent waited in its worktree: its go restarts it on
   *  this first (go) */
  switchTo?: Harness
  /** coordinators were told it stalled: its last sign of life then (`life`), and the report (by its time) it ran far
   *  past (`over`); each is told once, until it shows life again or reports anew */
  stalled?: { life?: number; over?: number }
}

/**
 * A task that starts by itself at a time (`task add --at "tomorrow 9:00"`, `--in 6h`, or `task queue <id> --at`): when,
 * and — for one added for a time — the brief as it was written, before Shepherdr's Settings block. Its agent, reviewer
 * and the Settings the block says are read when it starts, so a setting changed meanwhile still counts.
 */
export interface Scheduled {
  at: number
  /** the brief's own words; none for a task scheduled after it was added, whose brief is already whole */
  desc?: string
  /** the coordinator's --set for this task, applied when it starts */
  set?: Record<string, string>
  /** it was added --later: once its time comes its agent reads the brief and waits for a go */
  later?: boolean
  /** the CLI, model and effort the coordinator chose for it when it was added */
  agent?: Partial<Harness>
  reviewer?: Partial<Harness>
}

/**
 * A ready task on its way into main, from the first shepherdr merge until it is merged or back at work: what it waits
 * for (GitHub's checks, its agent's rebase, the merge itself), since when, and when the checks should be through (ms).
 */
export interface Landing {
  /** queue: in line behind another merge into its repo (behind: that task; gate: its space has a merge gate) */
  step: 'checks' | 'rebase' | 'merge' | 'gate' | 'queue'
  behind?: string
  gate?: boolean
  /** queue: it goes in with this task's merge train, on that one's gate run (train) */
  train?: string
  /** gate: the merges its run is for, this one's included, when it gates a train */
  cars?: number
  at: number
  due?: number
  /** its agent, at rest with the checks through, was told to merge once */
  nudged?: boolean
}

/** a landing task's line: "Checks running · ~3m", "Rebasing on main", "Merging" */
export function landingLine(l: Landing, base = 'main', now = Date.now()) {
  if (l.step === 'rebase') return `Rebasing on ${base}`
  if (l.step === 'merge') return 'Merging'
  if (l.step === 'gate') return l.cars ? `Running the merge gate (a train of ${l.cars})` : 'Running the merge gate'
  if (l.step === 'queue' && l.train) return `Going in with ${l.train}'s merge train`
  if (l.step === 'queue') return l.gate ? `Waiting for the merge gate (${l.behind}'s runs)` : `Waiting for ${l.behind}'s merge`
  const left = l.due === undefined ? 0 : Math.ceil((l.due - now) / 60_000)
  return left > 0 ? `Checks running · ~${left}m` : 'Checks running'
}

/** a report as kept: its line, % done and minutes left as said `at` then; `pausedAt` while it waits on you */
export interface Reported {
  msg: string
  progress: number
  left?: number
  at: number
  pausedAt?: number
}

/** how an agent starts: its herdr kind (claude, codex, pi, …), model and effort; nothing for the CLI's own default */
export interface Harness {
  kind: string
  model?: string
  effort?: string
}

/** what retuneWaiting changed (or, a dry run, would change) and what it left alone */
export interface Retune {
  /** waiting tasks whose agent changed to what Settings name for their space */
  changed: number
  /** waiting tasks already on it */
  same: number
  /** waiting tasks that start on Settings at their turn anyway: a scheduled one with no CLI of its own, or one the way
   *  back starts again on what Settings name */
  follow: number
  /** of the changed, those task add's flags chose (not Settings) */
  pinned: number
  /** tasks of the scope already started (working, asking, ready, merging): they keep their agent */
  running: number
  /** spaces whose own setting keeps its agent (machine scope only), with waiting tasks */
  kept: string[]
  /** the spaces whose waiting tasks changed, with the worker they take and how many */
  spaces: { name: string; on: Harness; changed: number }[]
}

/** the states a task waits to start in (Start with… takes its worker) */
const WAITING: TaskStatus[] = ['queued', 'todo', 'scheduled']

/** what a task that waits on you shows instead of its agent's message: a few words on why, never the message itself */
export const NEED = {
  plan: 'Plan to approve',
  permission: 'Asks permission',
  login: 'Signed out',
  question: 'Question for you',
  screen: 'Waiting on its screen',
  reply: 'Waits for your reply',
} as const

/** a CLI's own short error when its login ran out (Claude Code's API errors, its menu): never a reply about logins */
const LOGIN = /^\s*API Error\b.*(authentication_error|oauth token has expired|invalid api key|please run \/login)|^\s*(invalid api key|oauth token has expired)\b.*please run \/login/is
const loginGone = (text = '') => text.length < 400 && LOGIN.test(text)

/** A status line cut to STATUS_MAX characters at a word, so it ends cleanly: no half word, no dangling comma or "and". */
export function fitStatus(text: string) {
  const msg = text.replace(/\s+/g, ' ').trim()
  if (msg.length <= STATUS_MAX) return msg
  let cut = msg.slice(0, STATUS_MAX + 1).replace(/\s+\S*$/, '')
  if (cut.length > STATUS_MAX) return msg.slice(0, STATUS_MAX) // one word longer than the line
  for (let was = ''; was !== cut; ) {
    was = cut
    cut = cut.replace(/[\s,;:.(&+–—-]+$/, '').replace(/\s+(and|or|but|then|to|the|a|an|of|for|with|in|on|at|from|by|into)$/i, '')
  }
  return cut
}

/**
 * The report a task shows: while it works, its minutes left count down from what its agent said; while it waits on
 * you, all of it stays as it was. Nothing once its job is over (Ready, Done, To do, Queued).
 */
export function reportOf(r: Reported | undefined, status: TaskStatus, now = Date.now()): Report | undefined {
  if (!r || (status !== 'work' && status !== 'need')) return undefined
  const spent = ((r.pausedAt ?? now) - r.at) / 60000
  return { msg: r.msg, progress: r.progress, eta: r.left === undefined ? undefined : Math.max(0, Math.round(r.left - spent)), paused: status === 'need' || undefined }
}

/** a question mark that ends a sentence, not one in code (a?.b) or a path */
const ASKS = /\?(?=[\s"'”’)\]*_]|$)/

/**
 * The question an agent's last words ask you, as a status line: the last sentence that asks in its last paragraph
 * (links and code aside), cut to fit. Nothing when they ask nothing.
 */
export function askOf(text = ''): string | undefined {
  const last = text.replace(/```[\s\S]*?```/g, '').replace(/\S+:\/\/\S+/g, '').trim().split(/\n\s*\n/).at(-1) ?? ''
  const q = last.split(/\n+|(?<=[.!?])\s+(?=\S)/).findLast((s) => ASKS.test(s.replace(/`[^`]*`/g, '')))
  return q ? fitStatus(q.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, '').replace(/[*_`]+/g, '')) || undefined : undefined
}

/** finished: merged, or closed with nothing to merge */
export const ended = (t: TaskRec) => !!(t.merged || t.closed)

/** a retuneWaiting result in words, as the command line says it */
export function retuneLine(r: Retune) {
  const n = (k: number, one: string) => `${k} ${k === 1 ? one : `${one}s`}`
  const to = r.spaces.map((s) => `${s.name} on ${harnessWords(fitHarness(s.on))}`)
  const start = r.spaces.length === 1
    ? `${n(r.changed, 'waiting task')} in ${r.spaces[0].name} will start on ${harnessWords(fitHarness(r.spaces[0].on))} when ${r.changed === 1 ? 'its' : 'their'} turn comes`
    : `${n(r.changed, 'waiting task')} in ${r.spaces.length} spaces will start on what Settings name for each (${to.join('; ')})`
  const bits = [
    r.changed ? start : 'no waiting task changes',
    r.pinned ? `${r.pinned} of them had a worker of its own from task add, and changes too` : '',
    r.same ? `${r.same} already on it` : '',
    r.follow ? `${r.follow} start on Settings at their turn anyway` : '',
    r.running ? `${n(r.running, 'running task')} keep${r.running === 1 ? 's' : ''} its agent` : '',
    r.kept.length ? `${r.kept.join(', ')} keep${r.kept.length === 1 ? 's' : ''} its own setting` : '',
  ]
  return `${bits.filter(Boolean).join('; ')}.`
}

/** a retuneReviewers result in words, as the command line says it */
export function reviewRetuneLine(r: Retune) {
  const n = (k: number, one: string) => `${k} ${k === 1 ? one : `${one}s`}`
  const by = r.spaces.map((s) => `${s.name} by ${harnessWords(fitHarness(s.on))}`)
  const reviewed = r.spaces.length === 1
    ? `${n(r.changed, 'waiting task')} in ${r.spaces[0].name} ${r.changed === 1 ? 'is' : 'are'} reviewed by ${harnessWords(fitHarness(r.spaces[0].on))} when ${r.changed === 1 ? 'its' : 'their'} turn comes`
    : `${n(r.changed, 'waiting task')} in ${r.spaces.length} spaces ${r.changed === 1 ? 'is' : 'are'} reviewed by what Settings name for each (${by.join('; ')})`
  const bits = [
    r.changed ? reviewed : 'no waiting task changes',
    r.pinned ? `${r.pinned} of them had a reviewer of its own from task add, and changes too` : '',
    r.same ? `${r.same} already on it` : '',
    r.follow ? `${r.follow} take${r.follow === 1 ? 's' : ''} Settings' reviewer at ${r.follow === 1 ? 'its' : 'their'} turn anyway` : '',
    r.running ? `${n(r.running, 'running task')} ${r.running === 1 ? 'keeps its' : 'keep their'} reviewer` : '',
    r.kept.length ? `${r.kept.join(', ')} keep${r.kept.length === 1 ? 's' : ''} its own setting` : '',
  ]
  return `${bits.filter(Boolean).join('; ')}.`
}

const STATE: Record<TaskStatus, string> = { need: 'Needs you', ready: 'Ready', merging: 'Merging', work: 'Working', scheduled: 'Scheduled', queued: 'Queued', todo: 'To do', done: 'Done' }

/** one of the tasks a queued task waits for, as it stands: done, still open, ended without being done, gone, or on a
 *  machine that can't be reached right now */
type DepState = 'done' | 'open' | 'stopped' | 'failed' | 'gone' | 'away'

/** another machine's task, as it last showed itself: 'away' while that machine can't be reached, 'unknown' for a
 *  machine this one doesn't know, nothing when that machine has no such task */
export type PeerTask = (machine: string, id: string) => Task | 'away' | 'unknown' | undefined

/** "vm-str:SHE-12" is another machine's task; this machine's own name leads to its own */
const splitRef = (ref: string): [string | undefined, string] => {
  const i = ref.indexOf(':')
  if (i < 0) return [undefined, ref]
  const machine = ref.slice(0, i).toLowerCase()
  return [machine === HOST.toLowerCase() ? undefined : machine, ref.slice(i + 1)]
}

/** while load decides, held tasks start one at a time this far apart, so each one shows in the load first */
/** a waiting task whose agent replied more than this since its brief may have begun: task park leaves it as it is */
const PARK_REPLIES = 4
/** how long a space's merge gate may run (engine.gate) before it is stopped and the merge refused */
export const GATE_TIMEOUT = 45 * 60_000
/** what an agent is told when the gate refuses its merge: the gate is the merge's full check, so none of its own */
export const GATE_AGAIN = "The merge gate is the merge's full check: fix what its lines name, prove the fix with targeted tests, then run shepherdr merge again; no full check of your own first."

/** a merge gate's run: its process group, the files its words and its exit code go to, and the commit it gates (head)
 *  on the base as it was then (tip) */
export type GateRun = { pid: number; log: string; exit: string; at: number; head: string; tip: string }

/** a gate's process is gone with no exit code: a restart, or a kill, ended it */
const GATE_GONE = -1

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** a merge gate's command, in a session of its own (detached): a restart of Shepherdr, which ends its own process group,
 *  leaves it running, and the Shepherdr that comes back reads its words and exit code from their files. The files are
 *  named for this run (its task, its start and a random part): a stale run of the same task, still going after a newer
 *  one began, writes its exit code to its own files, never over the newer run's */
export function startGate(cmd: string, wt: string, env: Record<string, string>, dir: string, id: string, at: { head: string; tip: string }): GateRun {
  fs.mkdirSync(dir, { recursive: true })
  const start = Date.now()
  const name = `${id}-${start}-${randomUUID().slice(0, 8)}`
  const log = join(dir, `${name}.log`)
  const exit = join(dir, `${name}.exit`)
  for (const f of [log, exit]) fs.rmSync(f, { force: true })
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const c = spawn('/bin/sh', ['-c', `(${cmd}) > ${q(log)} 2>&1; echo $? > ${q(exit)}.tmp && mv ${q(exit)}.tmp ${q(exit)}`], { cwd: wt, env: { ...process.env, ...env }, detached: true, stdio: 'ignore' })
  c.unref()
  return { pid: c.pid ?? 0, log, exit, at: start, ...at }
}

/** a gate run's files once its outcome is read: nothing keeps them, each run has its own */
function forgetGate(run: GateRun) {
  for (const f of [run.log, run.exit, `${run.exit}.tmp`]) fs.rmSync(f, { force: true })
}

/** a gate run thrown away (a newer one replaces it, or a restart left it dead): its files go now, and again each second
 *  while its process still goes on, since it writes its exit code as it ends. Never killed here; the polling stops at the
 *  gate's own limit */
function dropGate(run: GateRun) {
  const going = alive(run.pid)
  forgetGate(run)
  if (going && Date.now() - run.at < GATE_TIMEOUT) setTimeout(() => dropGate(run), 1000).unref()
}

/** a gate's end: its exit code and words; past timeoutMs from its start, its process group is killed (124); gone with no
 *  code, GATE_GONE */
export async function waitGate(run: GateRun, timeoutMs: number, every = 250): Promise<{ code: number; out: string }> {
  const read = () => (fs.existsSync(run.log) ? fs.readFileSync(run.log, 'utf8') : '')
  for (;;) {
    if (fs.existsSync(run.exit)) return { code: Number(fs.readFileSync(run.exit, 'utf8').trim()), out: read().trimEnd() }
    if (!alive(run.pid)) {
      // it may have written its code just as it ended
      await Bun.sleep(50)
      return fs.existsSync(run.exit) ? { code: Number(fs.readFileSync(run.exit, 'utf8').trim()), out: read().trimEnd() } : { code: GATE_GONE, out: read().trimEnd() }
    }
    if (Date.now() - run.at > timeoutMs) {
      try {
        process.kill(-run.pid, 'SIGKILL')
        // coverage-exempt: the group ended between the alive check above and this kill, a race no test can time
      } catch {
        /* gone meanwhile */
      }
      return { code: 124, out: read().trimEnd() }
    }
    await Bun.sleep(every)
  }
}

/** how many times main may move while a merge gate runs before the merge gives up for now */
const GATE_ROUNDS = 3
/** the most merges one train takes (merge.train) */
const TRAIN_MAX = 5
/** one line of the server's log about a merge train's decision: what it decided and why, never a file's contents */
const trainLog = (line: string) => console.error(`shepherdr: ${line}`)
/** up to three paths, then how many more: `a.md, b.md, c.md and 2 more` */
const pathList = (files: string[]) => (files.length > 3 ? `${files.slice(0, 3).join(', ')} and ${files.length - 3} more` : files.join(', '))

/** why a task waits to start: its slots are taken, the machine is busy, every model of its space ran out (a start
 *  would only be cut off as well), its tasks that were cut off go back to work first (source.ts, return.ts), or its
 *  space's own cap (space.maxTasks, inside the machine's) is full: another space's task may still start */
export type HeldWhy = 'slots' | 'machine' | 'models' | 'resume' | 'space' | 'model'
export const HELD = { slots: 'Waiting for a free slot', machine: 'Waiting for the machine', models: 'Waiting: every model ran out', resume: 'Waiting: cut-off tasks go back to work first', space: 'Waiting for a free slot of its space', model: 'Waiting for a free slot of its model' } as const

/** one entry of models.maxAtOnce that caps the model a task starts on: the entry, the name the held line and the card
 *  give it, how many agents of this machine it counts now (the task itself not among them) and the most it allows */
export interface ModelCap {
  entry: MaxEntry
  name: string
  working: number
  max: number
}

/** queued tasks are first looked at once herdr has told which agents are alive: a go sent before would start a second */
const RECHECK_FIRST = 15_000

/** a scheduled task whose time passed by more than this was missed: Shepherdr was off, or the machine asleep, and its
 *  chat says so when it starts */
const MISSED_BY = 60_000

/** the branch every task's worktree gets */
const branchFor = (t: TaskRec) => `work/${t.n}-${G.slug(t.title)}`

/** one backup of a role's chain, in turn (n: its place, 1 for Backup 1): the harness it goes in on, or why it can't */
export type BackupPlan = { n: number; to?: { kind: string; model?: string; effort?: string }; why?: string }

/** its herdr space's name */
const labelOf = (t: TaskRec) => `${t.id} ${t.title}`

/** "7 days", "1 day", "off": how long a Done task stays before it archives itself (tasks.archiveAfter); null: never */
export function archiveAfterMs(v: string) {
  const m = v.trim().match(/^(\d+)(\s*days?)?$/i)
  return m && Number(m[1]) > 0 ? Number(m[1]) * 86_400_000 : null
}

/** leftovers of finished tasks are swept up this long after starting, and then every hour */
const SWEEP_FIRST = 20_000
const SWEEP_EVERY = 3_600_000

/** how long shepherdr checks waits for GitHub's checks at most, and how often it looks */
const CHECKS_WAIT = 9 * 60_000
const CHECKS_EVERY = 10_000
/** checks a repo's workflows will start may take this long to show on a pull request just pushed */
const CHECKS_SHOW = 90_000

/** shepherdr merge answers within this long: under the two minutes after which an agent's shell (Claude Code's)
 *  moves a command to the background. The shepherdr command itself gives up a little later (server/cli.ts, the
 *  helper's shepherdr) */
export const MERGE_DEADLINE = 90_000

/** done tasks' pull requests are looked at for news (failed checks, comments) this long after starting, then this often */
const WATCH_FIRST = 30_000
const WATCH_EVERY = 120_000
/** a working task with no sign of life this long (no output, status report or commit) has stalled; looked at this often */
export const STALL_QUIET = 20 * 60_000
const STALL_EVERY = 60_000
/** main's checks on GitHub are watched this long after a task merged through its pull request */
const MAIN_WATCH = 3 * 3_600_000

/** the failed checks at a commit, as one key: the same failure is told once */
const failKey = (head: string, c: G.PrChecks) => `${head}:${c.failed.map((f) => f.name).sort().join(',')}`

/** what someone wrote, as quoted to an agent: indented, and cut when long */
const quote = (s: string, max = 1500) => (s.length > max ? `${s.slice(0, max)}…` : s).split('\n').map((l) => `    ${l}`.trimEnd()).join('\n')

const COMMENT: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', COMMENTED: 'Review' }

/** now, as GitHub writes times (to the second): what is compared with them */
const ghNow = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

/** a pull request's footer, as the agent's CLI signs its work */
const SIGNED: Record<string, string> = { claude: '🤖 Generated with [Claude Code](https://claude.com/claude-code)', codex: '🤖 Generated with [Codex](https://openai.com/codex)' }

const troubleOf = (e: unknown) => ((e as Error)?.message ?? String(e)).split('\n')[0].slice(0, 90)

/** a title fits one row: one too long (from an automation saved before the limit) is cut at a word */
const short = (title: string) => (title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX).replace(/\s+\S*$/, '').slice(0, TITLE_MAX - 1)}…` : title)

/** A title someone writes is refused when it would not fit one line of the tasks list on a phone. */
export function checkTitle(title: string) {
  const t = title.trim()
  if (t.length > TITLE_MAX)
    throw new Error(`That title is ${t.length} characters: write a shorter one, ${TITLE_MAX} at most, so it fits one line on a phone (the rest goes in the brief)`)
  return t
}

export function age(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

const ago = (t: number) => (age(t) === 'now' ? 'just now' : `${age(t)} ago`)

function clock(t: number) {
  const d = new Date(t)
  const today = new Date().toDateString() === d.toDateString()
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return today ? `today ${hm}` : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${hm}`
}

type Events = {
  changed: []
  /** news for coordinators: a task was added, waits on you, is ready, merged or closed; main went red on GitHub */
  /** card: one for the project's chat that no task's status posts (main went red) */
  news: [project: string, text: string, kind: 'added' | 'ready' | 'need' | 'done' | 'red' | 'stalled', about: { task: string; event: 'added' | 'ready' | 'needs-you' | 'merged' | 'closed' | 'main-red' | 'stalled' }, card?: Omit<UpdateCard, 'id'>]
  /** a card for its project's chat: the task now waits on you (needs you, or ready), or it is done */
  card: [task: TaskRec, status: TaskStatus, sub: string]
  /** a task was stopped, merged, closed or deleted: what it had running beside its agent (its shared browser) goes;
   *  for good (forget) unless it was only stopped */
  gone: [task: TaskRec, forget: boolean]
}

/** a message you wrote makes the agent busy a moment later: until then it counts as working */
const ANSWER_GRACE = 6000

/** an agent that never gets to work on its brief leaves To do after this long anyway (and then waits on you) */
const BRIEF_WAIT = 120_000

/** what a task for later (task add --later) is told: its agent reads the brief and waits for a go */
const LATER = "Don't start yet: wait for a go."

/** who a `task tell` comes from, when an agent's own shell runs it: what it says about itself (chatlines.FromAgent) */
export type TellFrom = { name: string; pane?: string; space?: string; task?: string }

export class Engine extends Emitter<Events> {
  /** the folder its files are in, taken when it is made: a test's world keeps its own, whatever comes after it */
  private dir = home()
  /** main: by project path, the failing commit on GitHub's main its coordinator was told of, until main is green */
  private data = readJson<{ next: Record<string, number>; tasks: TaskRec[]; red?: Record<string, string> }>('tasks.json', { next: {}, tasks: [] }, this.dir)
  readonly taskIds: TaskIds
  private starting = new Set<string>()
  /** started, its brief not yet taken up: To do until its agent works on it */
  private briefing = new Set<string>()
  private wrote = new Map<string, number>()
  /** when its agent last reported its progress (shepherdr status) */
  private heard = new Map<string, number>()
  private later = new Map<string, ReturnType<typeof setTimeout>>()
  /** one merge at a time per repo: each one's main checkout is shared */
  private merging = new Map<string, Promise<unknown>>()
  /** merges whose caller heard by the deadline that they go on: their agent is told how each went (tellMerge) */
  private lateFor = new Set<string>()

  /** a merge that went on past its caller's deadline is through: its agent hears how it went, and wakes on it */
  private tellMerge(t: TaskRec, r: { ok: boolean; error?: string; note?: string }) {
    const words = r.ok ? `Your merge went in${r.note ? ` (${r.note})` : ''}: ${t.id} is merged. Nothing more to do for it: end your turn.` : `Your merge didn't go in: ${r.error}`
    void this.agents.send(this.key(t), hidden(words, 'merge')).catch(() => undefined)
  }

  /**
   * Merges a restart of Shepherdr cut short: a gate that went on by itself (startGate) is found again, and its merge goes
   * on from it, its agent told how it went; a merge that only waited in line takes its place in line again, in the
   * order it had, and its agent hears how it went as well; any other merge in flight went with the server that ran it,
   * so the task is back at its turn, its row and its agent saying to merge again.
   */
  resumeMerges() {
    const cut = this.tasks.filter((x) => !ended(x) && !this.landings.has(x.id) && x.landing && ['gate', 'merge', 'queue'].includes(x.landing.step))
    // the gate that goes on is first in its repo's line, then those that waited, as they stood
    const rank = (x: TaskRec) => (x.landing!.step === 'gate' ? 0 : x.landing!.step === 'queue' ? 1 : 2)
    for (const t of cut.sort((a, b) => rank(a) - rank(b) || a.landing!.at - b.landing!.at)) {
      const g = t.gateRun
      if ((t.landing!.step === 'gate' && g && (fs.existsSync(g.exit) || alive(g.pid))) || t.landing!.step === 'queue') {
        this.lateFor.add(t.id)
        void this.merge(t.id, { self: true }).catch(() => undefined)
        continue
      }
      const gate = t.landing!.step === 'gate'
      t.landing = undefined
      if (g) dropGate(g)
      t.gateRun = undefined
      t.mergeStop = `Merge${gate ? ' gate' : ''} interrupted by a restart: run shepherdr merge again`
      this.save()
      this.settle(t)
      void this.agents.send(this.key(t), hidden(`Shepherdr restarted while your merge ran${gate ? ' (its gate was stopped)' : ''}: nothing was merged. Run shepherdr merge ${t.id} again.`, 'merge')).catch(() => undefined)
    }
  }

  /** the task whose merge runs in each repo now: one asked meanwhile waits behind it (merge) */
  private mergingNow = new Map<string, string>()
  /** each task's merge while it runs */
  private landings = new Map<string, Promise<{ ok: boolean; error?: string; note?: string }>>()
  /** how long shepherdr merge may take before it answers that it isn't through yet (tests shorten it) */
  mergeDeadline = MERGE_DEADLINE
  /** stopping: no merge starts */
  private closing = false
  /** how long GitHub's checks took lately, per repo, and when that was asked */
  private took = new Map<string, { ms?: number; at: number }>()
  /** tasks whose place is being put away */
  private cleaning = new Set<string>()
  private sweeps: ReturnType<typeof setTimeout>[] = []
  /** the timer that starts the next scheduled task at its time */
  private dueTimer?: ReturnType<typeof setTimeout>
  private wt: Worktrees
  /** other machines' tasks, for a task queued after one (the main copy only: it is the one that sees them) */
  peerTask?: PeerTask
  /** its agent's turn the provider cut off (retry.ts): waited out, or given up */
  retry?: (key: string) => Retry | undefined
  /** its backup took over for a reason waiting can't fix: the primary Settings name is what the human may want back
   *  (source.ts keeps it, and asks it later whether it answers again) */
  noteTookOver?: (t: TaskRec, ran: Harness, to: Harness, why: string) => void
  /** its agent was cut off for good and waits for the human (no backup, one that couldn't start, or the backup cut off
   *  too): what started again once its provider answers (source.ts, return.ts) */
  noteStuck?: (t: TaskRec, ran: Harness, why: string) => void
  /** its space waits before a task starts: every model ran out, or its cut-off tasks go back to work first */
  startsWait?: (t: TaskRec) => 'models' | 'resume' | undefined
  /** it was cut off and the way back takes it again (source.ts goingBack): once a slot is free, or once its model answers */
  goesBack?: (t: TaskRec) => 'slot' | 'model' | undefined
  /** its backup agent is taking over */
  private handing = new Set<string>()
  /** chats whose last start never became a turn (start.ts): when it failed and the words it shows, so a relaunch loop
   *  leaves it to the human until someone writes */
  private failedStarts = new Map<string, { at: number; why: string }>()
  /** a CLI is installed here (a test says) */
  installed = (kind: string) => !!Bun.which(kind)
  /** how loaded this machine is now: over a start limit (health.ts busy), and whether herdr answers; none until first
   *  measured, which holds nothing by load */
  machine?: () => { busy?: 'cpu' | 'memory'; herdr: boolean } | undefined
  /** when a held task last started while load decided */
  private lastStart = 0
  private releasing = false
  private checking = false
  /** a look at done tasks' pull requests is under way */
  private watching = false
  private watchingMain = false

  constructor(
    private agents: Agents,
    private chats: Chats,
    private places: Places,
    private settings: Settings,
    h?: HerdrSpaces,
  ) {
    super()
    this.taskIds = new TaskIds(this.places.spaces, this.data, (name) => placeId.space(name), this.dir)
    this.places.takenTaskKeys = () => this.taskIds.keys()
    this.wt = new Worktrees(h, this.dir)
    let snapped = false
    // tasks from before statuses came from the agent: a finished one is merged, and was cleaned up then
    for (const t of this.data.tasks as (Omit<TaskRec, 'after'> & { stage?: string; after?: string | string[] })[]) {
      if (t.stage === 'done') Object.assign(t, { merged: true, cleaned: true })
      delete t.stage
      // Freeze older queued records before any space setting can change.
      if (!t.base) {
        t.base = this.places.space(t.project)?.base
        snapped ||= !!t.base
      }
      // from an older way a task waited on another one's merge
      if (typeof t.after === 'string') delete t.after
      // from when the Watcher put what a task asks in a few words
      delete (t as { gist?: unknown }).gist
    }
    if (snapped) this.save()
    queueMicrotask(() => {
      // saved for later with no agent, before every task got one at once: its agent starts now and waits for a go
      let chain = Promise.resolve()
      for (const t of this.tasks.filter((t) => t.told === 'todo' && !t.worktree && !ended(t) && !t.stopped && !t.trouble)) {
        if (!t.desc.includes(LATER)) t.desc = `${t.desc || t.title}\n\n${LATER}`
        chain = chain.then(() => this.startTask(t)).catch((e) => this.troubled(t, e))
      }
    })
    // herdr has told which agents are alive: what waits for other tasks may go, and a task whose time passed while
    // Shepherdr was off starts now — the machine's room can be seen, so it waits for a slot like any other
    const recheck = setTimeout(() => {
      this.duePass()
      this.armDue()
      this.resumeQueue()
      this.resumeMerges()
    }, RECHECK_FIRST)
    recheck.unref?.()
    this.sweeps.push(recheck)
    // a repo that gained its GitHub remote after it was added shows it from the start
    queueMicrotask(() => Promise.all(this.places.spaces.map((p) => this.places.recheckGithub(p))).then(() => this.emit('changed'), () => undefined))
    // once herdr has told which agents are at work: a restart (main updated by a merge) cuts a clean-up short
    const first = setTimeout(() => {
      this.autoArchive()
      this.sweep().catch(() => undefined)
    }, SWEEP_FIRST)
    const every = setInterval(() => {
      this.autoArchive()
      this.sweep().catch(() => undefined)
    }, SWEEP_EVERY)
    first.unref?.()
    every.unref?.()
    this.sweeps.push(first, every)
    const watch = () => this.watchPrs().then(() => this.watchMains()).catch(() => undefined)
    const watchFirst = setTimeout(watch, WATCH_FIRST)
    const watchEvery = setInterval(watch, WATCH_EVERY)
    watchFirst.unref?.()
    watchEvery.unref?.()
    this.sweeps.push(watchFirst, watchEvery)
    const stalls = setInterval(() => this.checkStalls(), STALL_EVERY)
    stalls.unref?.()
    this.sweeps.push(stalls)
  }

  get tasks() {
    return this.data.tasks
  }

  task(id: string) {
    const list = this.data.tasks
    const key = id.toUpperCase()
    // by an index of ids: a task is looked up hundreds of times a snapshot (each queue, each dependency), and a scan of
    // every id was most of a cold start. A hit is checked where it stands, so a list changed since never answers with
    // the wrong task; anything else is the scan it always was, and makes the index again when it finds the task
    const i = this.byId?.list === list ? this.byId.at.get(key) : undefined
    const hit = i === undefined ? undefined : list[i]
    if (hit && hit.id.toUpperCase() === key) return hit
    const found = list.find((t) => t.id.toUpperCase() === key)
    if (found) this.byId = { list, at: new Map(list.map((t, j) => [t.id.toUpperCase(), j])) }
    return found
  }

  /** where each task is in the list, by its id in capitals (task) */
  private byId?: { list: TaskRec[]; at: Map<string, number> }

  private save() {
    writeJson('tasks.json', this.data, this.dir)
    this.emit('changed')
  }

  private proj(t: TaskRec): Space {
    const p = this.places.space(t.project)
    if (!p) throw new Error(`${t.id}: its project is gone`)
    return p
  }

  private key(t: TaskRec) {
    return `${t.id}/Agent`
  }

  stop() {
    this.taskIds.close()
    clearTimeout(this.dueTimer)
    for (const x of this.later.values()) clearTimeout(x)
    for (const x of this.sweeps) clearTimeout(x)
  }

  /* ---------- status: from the agent alone ---------- */

  /** the one status the task list, the task's own chat, the place dots and the command all show */
  statusOf(t: TaskRec): TaskStatus {
    if (ended(t)) return 'done'
    // cut off by its provider, and the way back starts it again once its model answers and a slot is free: in line,
    // nothing of the human's to do (a start that went wrong on the way to its backup included)
    if (this.goesBack?.(t)) return 'queued'
    if (t.trouble) return 'need'
    // stopped (task stop, or the way on from a delete that was refused): its agent is closed and it is To do, whatever
    // card its chat still ends on, until something is written to it
    if (t.stopped) return 'todo'
    // it waits for its time, with no agent yet (task add --at/--in): never Needs you while it counts down
    if (t.scheduled) return 'scheduled'
    const key = this.key(t)
    const st = this.agents.status(key)
    // a start that stopped on a screen of its own (start.ts) waits on you as a menu does
    if (st === 'blocked' || this.asks(key) || this.chats.startMenuUp(key)) return 'need'
    // queued: until they are all done, or one ends without being done (then it waits for you to decide)
    if (this.queued(t)) return this.halts(t).length ? 'need' : 'queued'
    // held until the machine has room
    if (this.holding(t)) return 'queued'
    // its agent starting, or reading its brief, is To do; one its go starts (a queued task's turn came) is at work
    if (t.todo || ((this.starting.has(t.id) || this.briefing.has(t.id)) && !t.going)) return 'todo'
    // on its way into main, nothing for you to do (a question or a card it asks is handled above: then it needs you)
    // a merge stopped on a conflict is its agent's to rebase by hand: no merging meanwhile, its own status (subOf says so)
    if (t.reported && t.landing && t.landing.step !== 'rebase' && (st === 'working' || !this.asks(key))) return 'merging'
    if (st === 'working' || this.handing.has(t.id)) return 'work'
    if (this.agents.waiting(key).length || Date.now() - (this.wrote.get(t.id) ?? 0) < ANSWER_GRACE) return 'work'
    if (t.reported) return 'ready'
    if (this.retrying(t)) return 'work'
    // its turn ended while work it started in the background (a subagent, a shell, a monitor) still runs and will wake
    // it: a pause, not a question, unless what it said last asks you something
    if (this.agents.background(key) && !this.asks(key)) return 'work'
    // its turn ended (or it stopped) without reporting done: it waits for you
    return 'need'
  }

  /** the provider cut its last turn off and it will be told to carry on, or was just now */
  private retrying(t: TaskRec) {
    const r = this.mayRetry(this.key(t)) ? this.retry?.(this.key(t)) : undefined
    return !!r && !r.over && (!!r.due || Date.now() - (r.nudged ?? 0) < 60_000)
  }

  /** a task's agent the provider cut off may be told to carry on: not stopped, paused, waiting for a go, archived or
   *  finished since */
  mayRetry(key: string) {
    const t = this.task(key.split('/')[0])
    return !!t && key === this.key(t) && !t.stopped && !t.todo && !t.archived && !ended(t)
  }

  /** it asks you something: a choice card or the CLI's own question still open (facts, never a guess from its words) */
  private asks(key: string) {
    return !!(this.chats.openCard(key) || this.chats.openQuestion(key))
  }

  /**
   * the second line of a list row: what the status is about, in one short standard line, never the brief. While it
   * works, its agent's own status line (shepherdr status) takes its place on screen and in the CLI (source.ts).
   */
  subOf(t: TaskRec, status = this.statusOf(t)): string {
    const key = this.key(t)
    const s = (() => {
      // a few words, never the summary: that is in its chat's card
      if (status === 'done') return t.closed ? 'Nothing to merge' : 'Merged'
      // when it starts by itself: the countdown the screen keeps is its own
      if (status === 'scheduled' && t.scheduled) return startsLine(t.scheduled.at, Date.now(), this.zone())
      if (status === 'need' && (this.agents.status(key) === 'blocked' || this.asks(key) || this.chats.startMenuUp(key))) return this.reasonOf(key) ?? NEED.question
      // in line to go back to work: what it waits for, before what went wrong on its way to the backup
      const back = status === 'queued' ? this.goesBack?.(t) : undefined
      if (back) return back === 'slot' ? 'Waiting for a free slot to go back to work' : 'Waiting for its model to answer again'
      if (t.trouble) return fitStatus(`Went wrong: ${t.trouble}`)
      // a To do row is its title alone
      if (status === 'todo') return ''
      if (status === 'queued') return this.holding(t) ? `${t.priority ? 'First in line · ' : ''}${this.heldLabel(t)}` : this.waitLine(t)
      if (status === 'need' && this.queued(t) && this.agents.status(key) !== 'blocked') return fitStatus(this.halts(t).join(' · '))
      if (status === 'need') return this.reasonOf(key) ?? NEED.reply
      // why its last merge stopped, while its agent is on it: a conflict to rebase by hand, or the gate's refusal
      // Shepherdr's own words, not an agent's line: the row's whole length (below), so the gate's line shows
      const stop = t.landing?.step === 'rebase' ? `Merge stopped on a conflict with ${t.base}: rebasing by hand` : t.mergeStop
      if (stop && status !== 'merging') return stop.replace(/\s+/g, ' ')
      if (status === 'ready') return 'Ready to merge'
      if (status === 'merging') return landingLine(t.landing!, t.base)
      if (this.handing.has(t.id) && t.tookOver) {
        const on = CLI_NAME[t.tookOver.to] ?? t.tookOver.to
        return fitStatus(`${on} ${t.tookOver.from === t.tookOver.to ? 'starts again' : 'takes over'}: ${t.tookOver.why}`)
      }
      const r = this.retry?.(key)
      if (r?.due) return `${r.reason} · retry in ${inMins(r.due)}`
      return 'Working'
    })()
    return s.length > 90 ? `${s.slice(0, 89).trimEnd()}…` : s
  }

  /**
   * why its agent waits on you: a standard reason, or the agent's own question cut to a status line. From what the agent
   * reports (its hooks, its log, its cards), never a model's reading of it.
   */
  private reasonOf(key: string): string | undefined {
    const cut = this.retry?.(key)
    if (cut?.over) return fitStatus(cut.reason)
    // a start stopped on a screen of its own: what the CLI asks there, in its own words where it asks something
    if (this.chats.startMenuUp(key)) return fitStatus(this.chats.menu(key)?.title ?? '') || NEED.screen
    const said = this.agents.said(key)
    if (this.agents.status(key) === 'blocked') {
      if (said?.state === 'blocked') return said.kind === 'plan' ? NEED.plan : said.kind === 'question' ? (said.ask && fitStatus(said.ask)) || NEED.question : NEED.permission
      // a subagent of its own asks for a permission
      if (said?.helper) return NEED.permission
      const q = this.chats.openQuestion(key)
      if (q) return fitStatus(q.items[0]?.question ?? '') || NEED.question
      return loginGone(this.chats.menu(key)?.title) ? NEED.login : NEED.permission
    }
    const card = this.chats.openCard(key)
    if (card) return card === 'plan' ? NEED.plan : fitStatus(this.chats.openCardTitle(key) ?? '') || NEED.question
    const question = this.chats.openQuestion(key)
    if (question) return fitStatus(question.items[0]?.question ?? '') || NEED.question
    const last = this.chats.lastReply(key)
    if (said?.kind === 'auth' || loginGone(last)) return NEED.login
    return askOf(last)
  }

  /** settle one task, then the tasks queued after others: what it did may be what one of them waits for */
  private settle(t: TaskRec) {
    this.settleOne(t)
    this.recheck()
    // what it did may free room for a held one
    this.release()
  }

  /** tell coordinators and the screen when the status changed; a card when it now waits on you or is done */
  private settleOne(t: TaskRec) {
    const status = this.statusOf(t)
    this.pace(t, status)
    if (status === t.told) return this.emit('changed')
    // archived: put away quietly, no card, news or alert
    if (t.archived) return this.quiet(t, status)
    const before = t.told
    t.told = status
    const sub = this.subOf(t, status)
    // a task from before this was told: what it shows now is where it starts, not news
    if (before === undefined) {
      t.posted = `${status}|${sub}`
      return this.save()
    }
    t.updated = Date.now()
    // back at work: the next time it waits is news again, even with the same words
    if (status === 'work') t.posted = undefined
    if (status === 'need' || status === 'ready') {
      const key = `${status}|${sub}`
      if (t.posted !== key) {
        t.posted = key
        this.emit('card', t, status, sub)
        this.emit('news', t.project, `${t.id} ${status === 'ready' ? `is ready to merge${t.said ? `: ${t.said}` : ''}${t.facts ? ` (Facts: ${t.facts})` : ''}` : `needs you: ${sub}`}`, status === 'ready' ? 'ready' : 'need', { task: t.id, event: status === 'ready' ? 'ready' : 'needs-you' })
      }
    }
    if (status === 'done' && before !== 'done') {
      t.posted = `done|${sub}`
      this.emit('card', t, status, sub)
      this.emit('news', t.project, `${t.id} ${t.closed ? `is done, nothing to merge${t.said ? `: ${t.said}` : ''}` : 'was merged'}`, 'done', { task: t.id, event: t.closed ? 'closed' : 'merged' })
    }
    this.save()
  }

  /** its report follows its status: its clock stops while it waits on you, and the report goes once its job is over */
  private pace(t: TaskRec, status: TaskStatus) {
    const r = t.report
    if (!r) return
    if (status === 'need') r.pausedAt ??= Date.now()
    else if (status !== 'work') t.report = undefined
    else if (r.pausedAt) {
      r.at += Date.now() - r.pausedAt
      r.pausedAt = undefined
    }
  }

  /** what it shows now is taken as told and posted: nothing about it is news */
  private quiet(t: TaskRec, status = this.statusOf(t)) {
    t.told = status
    t.posted = `${status}|${this.subOf(t, status)}`
    this.save()
  }

  /** a turn that ends may be followed at once by the next: wait a moment before telling anyone it waits */
  private settleSoon(t: TaskRec, ms = 4000) {
    clearTimeout(this.later.get(t.id))
    this.later.set(
      t.id,
      setTimeout(() => {
        this.later.delete(t.id)
        const t2 = this.task(t.id)
        if (t2) this.settle(t2)
      }, ms),
    )
  }

  /* ---------- the view the screen draws ---------- */

  view(t: TaskRec): Task {
    const status = this.statusOf(t)
    const key = this.key(t)
    const rec = this.agents.record(key)
    const cli = CLI_NAME[rec?.kind ?? t.agent?.kind ?? ''] ?? this.settings.get('task.agent', this.nameOf(t))
    const sub = this.subOf(t, status)
    const doneAt = status === 'done' ? (t.doneAt ?? t.updated) : undefined
    return {
      id: t.id,
      name: t.title,
      status,
      place: t.project,
      sub,
      age: age(t.archived ?? doneAt ?? (status === 'todo' || status === 'scheduled' ? t.created : t.updated)),
      doneAt,
      branch: t.branch,
      base: t.base,
      pr: t.pr,
      plan: t.plan,
      agent: rec || t.worktree ? { chat: key, role: 'Agent', cli, status, age: age(rec?.started ?? t.updated), note: sub, running: !t.stopped && this.agents.status(key) !== 'gone' } : undefined,
      desc: t.desc || 'No brief yet.',
      said: t.said,
      facts: t.facts,
      state: t.archived
        ? `Archived · ${ago(t.archived)}`
        : status === 'todo'
          ? `To do · added ${ago(t.created)}`
          : status === 'scheduled'
            ? `Scheduled · added ${ago(t.created)}`
            : t.closed
              ? `Done · nothing to merge · ${ago(doneAt ?? t.updated)}`
              : status === 'done'
                ? `Done · merged ${ago(doneAt ?? t.updated)}`
                : `${STATE[status]} · ${ago(doneAt ?? t.updated)}`,
      on: cli,
      created: `${clock(t.created)} by ${t.by}`,
      after: this.queued(t) ? this.open(t) : undefined,
      scheduled: t.scheduled?.at,
      outcome: this.outcomeOf(t),
      archived: t.archived,
      pinned: t.pinned,
      // waiting out the provider, or a backup taking over: that line shows, not what its agent last reported
      report: this.retrying(t) || this.handing.has(t.id) ? undefined : reportOf(t.report, status),
    }
  }

  /* ---------- stalled ---------- */

  /**
   * Working tasks that went quiet (no sign of life for STALL_QUIET) or ran far past the time their agent said was left:
   * news for their coordinator, once per stall. Only time and liveness, which agents can't see of themselves: what to
   * do about it is the coordinator's call.
   */
  checkStalls(now = Date.now()) {
    for (const t of this.tasks) {
      if (t.archived || t.paused || this.statusOf(t) !== 'work' || this.retrying(t) || this.handing.has(t.id)) continue
      const life = this.lifeOf(t)
      const r = t.report
      // shown life since: its next stall is news again
      if (t.stalled?.life !== undefined && life > t.stalled.life) t.stalled.life = undefined
      const quiet = now - life >= STALL_QUIET && t.stalled?.life === undefined
      const over = r?.left !== undefined && r.at !== t.stalled?.over && now - r.at > (r.left + Math.max(r.left, 20)) * 60_000
      if (!quiet && !over) continue
      t.stalled = { life: quiet ? life : t.stalled?.life, over: r?.at }
      const mins = Math.max(0, Math.round((now - (quiet ? life : r!.at + r!.left! * 60_000)) / 60_000))
      this.emit('card', t, 'work', quiet ? `may be stuck: quiet for ${mins}m` : `may be stuck: ${mins}m past its time left`)
      this.emit('news', t.project, this.stallLine(t, now, quiet ? life : undefined), 'stalled', { task: t.id, event: 'stalled' })
      this.save()
    }
  }

  /** its last sign of life: its status changed, it was written to or reported, its hooks or its CLI's log moved */
  private lifeOf(t: TaskRec) {
    const key = this.key(t)
    const logs = (this.agents.record(key)?.logs ?? []).slice(-2).map((p) => {
      try {
        return statSync(p).mtimeMs
      } catch {
        return 0
      }
    })
    return Math.max(t.updated, this.wrote.get(t.id) ?? 0, this.heard.get(t.id) ?? 0, this.agents.said(key)?.at ?? 0, ...logs)
  }

  /** what Shepherdr saw of a stall: how long quiet (or past its estimate), its last status line, whether its agent runs */
  private stallLine(t: TaskRec, now: number, quietSince?: number) {
    const key = this.key(t)
    const mins = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))}m`
    const r = t.report
    const bg = this.agents.status(key) !== 'working' && this.agents.background(key)
    const ran = { agents: 'a subagent', shells: 'a shell', servers: 'a server' }
    const why =
      quietSince === undefined
        ? `it has worked ${mins(now - r!.at)} since its agent said ${r!.left}m were left`
        : bg
          ? `its agent's turn ended while ${ran[bg]} it started runs on, and nothing has changed for ${mins(now - quietSince)}`
          : `its agent shows as working, but nothing has changed for ${mins(now - quietSince)}: no new output, status report or commit`
    const heard = this.heard.get(t.id)
    const last = r ? `Its last status: "${r.msg}", ${r.progress}% done${heard ? `, ${mins(now - heard)} ago` : ''}` : 'It has reported no status'
    const info = this.agents.info(key)
    const alive = !info ? 'herdr shows no pane for its agent' : info.agent ? 'its agent process is running' : 'herdr sees no agent CLI running in its pane'
    return `${t.id} may have stalled: ${why}. ${last}; ${alive}. Nudge it (shepherdr task tell ${t.id} "…"), stop it, or tell the human`
  }

  /* ---------- queued after other tasks ---------- */

  /** it waits for other tasks (a stopped task waits for nothing until it is written to again) */
  private queued(t: TaskRec) {
    return !!t.after?.length && !ended(t) && !t.stopped
  }

  /** how it ended, for a task queued after it: merged, or closed with nothing to merge, is done */
  outcomeOf(t: TaskRec): Task['outcome'] {
    if (ended(t)) return 'done'
    if (t.trouble) return 'failed'
    if (t.stopped) return 'stopped'
  }

  private depState(ref: string): DepState {
    const [machine, id] = splitRef(ref)
    if (machine) {
      const x = this.peerTask?.(machine, id)
      if (x === 'away') return 'away'
      if (!x || x === 'unknown') return 'gone'
      return x.outcome ?? (x.status === 'done' ? 'done' : 'open')
    }
    const d = this.task(id)
    if (!d || (!ended(d) && !this.places.space(d.project))) return 'gone'
    return this.outcomeOf(d) ?? 'open'
  }

  /** the tasks it still waits for */
  private open(t: TaskRec) {
    return (t.after ?? []).filter((ref) => this.depState(ref) !== 'done')
  }

  /** why it can't go on by itself: a task it waits for was stopped, went wrong or is gone */
  private halts(t: TaskRec) {
    const why: Partial<Record<DepState, string>> = { stopped: 'was stopped', failed: 'went wrong', gone: 'is gone' }
    return (t.after ?? []).flatMap((ref) => {
      const w = why[this.depState(ref)]
      return w ? [`${ref} ${w}`] : []
    })
  }

  /** a queued task's line: what it still waits for ("After SHE-12, SHE-13"), and a machine that can't be reached */
  private waitLine(t: TaskRec) {
    const open = this.open(t)
    const away = [...new Set(open.filter((ref) => this.depState(ref) === 'away').map((ref) => splitRef(ref)[0]))]
    return `After ${open.join(', ')}${away.length ? ` · can't reach ${away.join(', ')}` : ''}`
  }

  /**
   * Queued tasks: each whose tasks are all done is told to go; the rest show what they wait for, or that one of them
   * ended without being done (then it waits for you).
   */
  recheck() {
    if (this.checking) return
    this.checking = true
    try {
      // a task still waiting for its time is no queued task yet: it starts when it is due, then waits for the machine
      for (const t of this.tasks.filter((t) => this.queued(t) && !t.scheduled)) {
        if (!this.open(t).length) this.goWhenRoom(t, goLine(t.after!, this.notes(t.after!)), `${t.after!.join(', ')} ${t.after!.length === 1 ? 'is' : 'are'} done`)
        else if (this.statusOf(t) !== t.told) this.settleOne(t)
      }
    } finally {
      this.checking = false
    }
  }

  /**
   * After a start: a go that never reached its agent (a restart cut it off) is sent again; then the queue is checked.
   */
  resumeQueue() {
    for (const t of this.tasks.filter((t) => t.going && !ended(t) && !t.stopped && this.agents.status(this.key(t)) !== 'working'))
      this.agents.send(this.key(t), hidden(t.going!, 'go'), { ensure: this.starter(t) }).catch(() => undefined)
    this.recheck()
  }

  /** what each task it waited for said when it was done */
  private notes(refs: string[]) {
    return refs.flatMap((ref) => {
      const [machine, id] = splitRef(ref)
      const x = machine ? this.peerTask?.(machine, id) : this.task(id)
      if (!x || typeof x === 'string') return []
      return x.said ? [`${ref} (${'title' in x ? x.title : x.name}): ${x.said}`] : []
    })
  }

  /** a task whose agent has its brief already: it was started once (a worktree, or an agent's record). One that was not
   *  reads Settings from its brief when it starts, so its brief is all that changes */
  private hasBrief(t: TaskRec) {
    return !!t.worktree || !!this.agents.record(this.key(t))
  }

  /** the reviewer line a waiting task's agent is still to hear (retuneReviewers), taken: it goes in once, with the
   *  message that reaches the agent next */
  private takeNote(t: TaskRec) {
    const note = t.reviewerNote
    t.reviewerNote = undefined
    return note
  }

  /** the go: its agent hears it (hidden from the chat, where a small card says why it started) and starts on the work */
  private go(t: TaskRec, text: string, why: string, plain = false) {
    // a server that may start no agent spends none of its queue on one: the task says why instead
    if (!launchesAgents()) {
      t.trouble = troubleOf(refusedLaunch(this.key(t)))
      this.settle(t)
      return
    }
    // archived while it waited: it starts work, so it shows again
    if (t.archived) this.unarchive(t.id)
    t.after = undefined
    t.held = undefined
    t.todo = undefined
    t.reported = false
    this.briefing.delete(t.id)
    // a coordinator's own words go in as they are, and are not sent again after a restart
    // a reviewer Settings changed while it waited goes in with the go, once (its agent read the brief before)
    const reviewer = this.takeNote(t)
    t.going = plain ? undefined : [text, reviewer].filter(Boolean).join('\n\n')
    this.wrote.set(t.id, Date.now())
    const key = this.key(t)
    const id = `go:${t.id}:${Date.now()}`
    this.chats.post(key, { id, card: { id, task: t.id, status: 'work', text: `started: ${why}` } })
    this.save()
    // its agent hears it: one that never started (a scheduled task whose time came while it waited for another) is
    // started first by `ensure`, and gets the go as its first message after the brief (starter). One waiting in a
    // worktree it already has is brought up to its base first, and the go says how (launch does it for one whose agent
    // is gone)
    const go = plain ? text : hidden(text, 'go')
    const send = (more?: string) => this.agents.send(key, [go, more, reviewer].filter(Boolean).join('\n\n'), { ensure: this.starter(t) }).catch(() => undefined)
    // started now on a worker of your choosing while its agent waited: on that one first (its restart brings it up to
    // its base), then the go
    const to = t.switchTo
    t.switchTo = undefined
    if (to && t.worktree && existsSync(t.worktree)) void this.restart(t.id, to).then(() => send(), () => send())
    else if (t.worktree && existsSync(t.worktree) && this.agents.status(key) !== 'gone') void this.freshen(t).then((moved) => send(moved), () => send())
    else void send()
    this.settleOne(t)
    this.settleSoon(t, ANSWER_GRACE + 500)
  }

  /**
   * What a task waits for, as written ("SHE-12", "she-12", "vm-str:SHE-12"), checked: each one there, never itself, and
   * no circle (SHE-3 waits for SHE-5, which waits for SHE-3). Kept by their ids as shown.
   */
  checkAfter(self: string | undefined, refs: string[]): string[] {
    const out: string[] = []
    for (const raw of refs.flatMap((r) => r.split(/[\s,]+/)).filter(Boolean)) {
      const [machine, id] = splitRef(raw)
      let ref: string
      if (machine) {
        if (!this.peerTask) throw new Error(`${raw}: only the main machine sees other machines' tasks, so only its tasks can wait for them`)
        const x = this.peerTask(machine, id)
        if (x === 'unknown') throw new Error(`${raw}: no machine called ${machine}`)
        if (x === 'away') throw new Error(`${raw}: can't reach ${machine} right now, so it can't be checked; try again later`)
        if (!x) throw new Error(`${raw}: ${machine} has no task ${id}`)
        ref = `${machine}:${x.id}`
      } else {
        const d = this.task(id)
        if (!d) throw new Error(`No task ${id}`)
        if (self && d.id.toUpperCase() === self.toUpperCase()) throw new Error(`${d.id} can't wait for itself`)
        ref = d.id
      }
      if (!out.includes(ref)) out.push(ref)
    }
    if (self)
      for (const ref of out) {
        const loop = this.circle(self, ref, [self])
        if (loop) throw new Error(`That would wait in a circle: ${loop.join(' → ')}`)
      }
    return out
  }

  /** the path back to `self` through what `ref` waits for in turn, if there is one */
  private circle(self: string, ref: string, path: string[]): string[] | undefined {
    if (splitRef(ref)[0]) return undefined
    const d = this.task(ref)
    if (!d) return undefined
    if (d.id.toUpperCase() === self.toUpperCase()) return [...path, d.id]
    if (path.includes(d.id)) return undefined
    for (const next of this.queued(d) ? d.after! : []) {
      const loop = this.circle(self, next, [...path, d.id])
      if (loop) return loop
    }
  }

  /**
   * Queue a task after others, change what it waits for, or (none) clear it. Its agent is told: to hold on (it may be
   * at work), what it waits for now, or to go. `self`: its own agent asked, and needs no message for it.
   */
  queue(id: string, refs: string[], opts: { self?: boolean } = {}): { queued: string[]; went?: boolean } {
    const t = this.req(id)
    if (ended(t)) throw new Error(`${t.id} is Done already (${t.closed ? 'nothing to merge' : 'merged'})`)
    const after = this.checkAfter(t.id, refs)
    // one still waiting for its time keeps it: only what it waits for changes, and at its time it starts once those are done
    if (t.scheduled) {
      const open = after.filter((ref) => this.depState(ref) !== 'done')
      t.after = open.length ? open : undefined
      this.save()
      this.settleOne(t)
      return { queued: open }
    }
    const was = this.queued(t) ? t.after! : []
    const open = after.filter((ref) => this.depState(ref) !== 'done')
    if (!open.length) {
      if (!was.length) return { queued: [] }
      if (after.length) this.goWhenRoom(t, goLine(after, this.notes(after)), `${after.join(', ')} ${after.length === 1 ? 'is' : 'are'} done`)
      else this.goWhenRoom(t, goLine(was, [], true), `no longer waits for ${was.join(', ')}`)
      return { queued: [], went: true }
    }
    t.after = after
    t.stopped = undefined
    clearTimeout(this.later.get(t.id))
    const key = this.key(t)
    const cid = `queued:${t.id}:${Date.now()}`
    this.chats.post(key, { id: cid, card: { id: cid, task: t.id, status: 'queued', text: `queued after ${open.join(', ')}` } })
    this.save()
    if (!opts.self && this.agents.status(key) !== 'gone') this.agents.send(key, hidden(queuedLine(open, was.length ? 'changed' : 'later', t.id), 'queue'), { ensure: this.starter(t) }).catch(() => undefined)
    this.settleOne(t)
    return { queued: open }
  }

  /* ---------- room on this machine ---------- */

  /** held until this machine has room (and nothing it waits for is still open) */
  private holding(t: TaskRec) {
    return !!t.held && !ended(t) && !t.stopped && !this.queued(t)
  }

  /**
   * A task that holds one of the machine's slots: at work, on its way to it, or waiting on you with its agent there. One
   * that asks you something keeps its slot, as upstream counts every task with a live agent (3.x queueReason): your
   * answer, the advisor's or its coordinator's takes it back to work without going past the limit (it once read 12 of
   * 10 working, the tasks answered after others had taken their slots).
   */
  private busy(t: TaskRec) {
    if (ended(t) || t.archived || t.stopped || this.holding(t) || !this.places.space(t.project)) return false
    // in line for its merge, or in its gate: its repo's merges go one at a time already, so no slot of the machine's
    if (t.landing?.step === 'queue' || t.landing?.step === 'gate') return false
    // a go sent just now counts before its agent is seen at work; one left from long ago (its agent gone) doesn't
    const going = !!t.going && Date.now() - (this.wrote.get(t.id) ?? 0) < BRIEF_WAIT
    if (this.starting.has(t.id) || going || (this.briefing.has(t.id) && !t.todo)) return true
    const st = this.statusOf(t)
    return st === 'work' || (st === 'need' && this.waitsOnYou(t))
  }

  /** it needs you and its agent is there to go on once you answer: not one whose start went wrong, that waits on a task
   *  it is queued after, whose agent is gone, or that its provider cut off (the way back brings that one, at a free slot) */
  private waitsOnYou(t: TaskRec) {
    const key = this.key(t)
    return !!t.worktree && !t.trouble && !this.queued(t) && this.agents.status(key) !== 'gone' && !this.retry?.(key)?.over
  }

  /** how many of the machine's slots are taken now: tasks at work, and the ones waiting on you with their agent there */
  working() {
    return this.tasks.filter((t) => this.busy(t)).length
  }

  /** of those, how many wait on you */
  waitingOnYou() {
    return this.tasks.filter((t) => this.busy(t) && this.statusOf(t) === 'need').length
  }

  /** the slots in words: "7 of 10 working", and how many of them wait on you ("10 of 10 working, 3 of them waiting on
   *  you") */
  slotsWords(max = this.settings.machine().max) {
    const waiting = this.waitingOnYou()
    return `${this.working()}${max === null ? '' : ` of ${max}`} working${waiting ? `, ${waiting} of them waiting on you` : ''}`
  }

  /** whether one more task may start now (this one, when one is named), and if not, why: its slots are all taken, the
   *  machine is too loaded, its space waits for its models (startsWait), or its space's own cap is full (spaceCap) */
  room(t?: TaskRec): { why?: HeldWhy } {
    const l = this.settings.machine()
    if (l.max !== null && this.working() >= l.max) return { why: 'slots' }
    const m = this.machine?.()
    // one first in line goes past the machine's load and pressure, and ahead of the cut-off tasks' way back; never past
    // a herdr that doesn't answer, nor its space's models all out (it would only be cut off)
    if (m && (!m.herdr || (m.busy && !t?.priority))) return { why: 'machine' }
    const w = t ? this.startsWait?.(t) : undefined
    if (w && !(w === 'resume' && t?.priority)) return { why: w }
    // a first in line passes neither: its space's cap is as much its slots as the machine's are, nor its model's
    const cap = t ? this.spaceCap(t) : undefined
    if (cap && cap.working >= cap.max) return { why: 'space' }
    return t && this.blockingCap(t) ? { why: 'model' } : {}
  }

  /** the model a task's agent runs on, as its usage is kept (keyOf): its live agent's model, else the one it starts on
   *  (its own agent, or Settings' task agent) */
  modelOfTask(t: TaskRec): string {
    const key = this.key(t)
    const rec = this.agents.record(key)
    if (rec && this.agents.status(key) !== 'gone') return keyOf(rec.kind, rec.model)
    const h = t.agent ?? this.settings.harness('task', this.nameOf(t))
    return keyOf(h.kind, h.model)
  }

  /** the agents of this machine that hold a slot or work now, by model key (models.maxAtOnce counts them): the tasks that
   *  hold a slot, each on the model it runs, and the coordinators working right now (never held, but they use the
   *  capacity). Advisor and reviewer runs are not counted; another machine's agents are not seen here at all */
  runsOn(except?: TaskRec): string[] {
    const keys: string[] = []
    for (const t of this.tasks) if (t !== except && this.busy(t)) keys.push(this.modelOfTask(t))
    for (const [key, r] of Object.entries(this.agents.records)) if (!key.includes('/') && this.agents.status(key) === 'working') keys.push(keyOf(r.kind, r.model))
    return keys
  }

  /** the entries of models.maxAtOnce that cap the model a task starts on, each with what it counts now: a model's own
   *  entry counts that model's agents, a provider's entry every agent of that provider (a server's total, as the DGX Spark
   *  takes four requests at once in all). Both apply: a model's own entry sets its limit, and the provider's still holds
   *  its total; nothing when neither is set */
  modelCaps(t: TaskRec, key = this.modelOfTask(t)): ModelCap[] {
    const entries = this.settings.maxAtOnce()
    const runs = this.runsOn(t).map((k) => k.toLowerCase())
    const provider = providerOfKey(key.toLowerCase())
    const own = capFor(entries, key)
    const out: ModelCap[] = []
    // a model's own entry (its name is the model key) counts its own agents; the provider's counts all of them
    if (own && own.pattern === key.toLowerCase()) out.push({ entry: own, name: own.pattern, working: runs.filter((k) => k === own.pattern).length, max: own.max })
    const byProvider = entries.find((e) => e.pattern === provider && !e.pattern.includes('/'))
    if (byProvider) out.push({ entry: byProvider, name: byProvider.pattern, working: runs.filter((k) => providerOfKey(k) === provider).length, max: byProvider.max })
    return out
  }

  /** the entry that holds a task on its model now: the first of its caps that is full (none when it has room) */
  blockingCap(t: TaskRec, key?: string): ModelCap | undefined {
    return this.modelCaps(t, key).find((c) => c.working >= c.max)
  }

  /** a task's space's own cap on this machine (space.maxTasks), with how many of that space's tasks work now (busy, as
   *  the machine's count is); none when the space has no cap of its own. `space` is the name it was added under (the
   *  key its settings and returns keep); `shown` is the name the human reads (places.shownName) */
  spaceCap(t: TaskRec): { space: string; shown: string; max: number; working: number } | undefined {
    const space = this.places.space(t.project)?.name
    const max = space === undefined ? null : this.settings.spaceMax(space)
    if (space === undefined || max === null) return undefined
    return { space, shown: this.places.shownName(space), max, working: this.tasks.filter((x) => this.places.space(x.project)?.name === space && this.busy(x)).length }
  }

  /** a held task's line in its row: a task held by its space's cap names the space, as it shows */
  private heldLabel(t: TaskRec) {
    if (t.held!.why === 'model') {
      const c = this.blockingCap(t)
      if (c) return `Waiting for a free slot of ${c.name} (${c.working} of ${c.max} at once)`
    }
    const cap = t.held!.why === 'space' ? this.spaceCap(t) : undefined
    return cap ? `Waiting for a free slot of ${cap.shown}` : HELD[t.held!.why]
  }

  /** the name a space of this machine was added under, for a scope that names it: its place id, the name it was added
   *  under (what the settings and the tasks hold, so checked first), or the name it shows (the CLI's --space takes that) */
  private addedNameOf(name: string) {
    return this.places.space(name)?.name ?? this.places.spaces.find((p) => p.name === name)?.name ?? this.places.byName(name)?.name
  }

  /** how many starts Shepherdr may make by itself now (machine.startEvery): one once the last is that long ago, none
   *  before; with none set, as many as there's room for */
  startsNow(now = Date.now()) {
    const every = this.settings.machine().startEvery
    return !every ? Infinity : now - this.lastStart >= every * 60_000 ? 1 : 0
  }

  /** a start Shepherdr made by itself (the way back's), counted for the next one's wait */
  noteStart(now = Date.now()) {
    this.lastStart = now
  }

  /** how many more tasks may work here now: none while the machine is too loaded */
  freeSlots() {
    const r = this.room()
    if (r.why) return 0
    const l = this.settings.machine()
    return l.max === null ? Infinity : Math.max(0, l.max - this.working())
  }

  /** tasks held now, oldest first */
  heldTasks() {
    // first in line first, then the oldest
    return this.tasks.filter((t) => this.holding(t) && !t.archived).sort((a, b) => Number(!!b.priority) - Number(!!a.priority) || a.held!.since - b.held!.since)
  }

  /** hold it until there's room: its line says why, and its chat gets a small card */
  private hold(t: TaskRec, why: HeldWhy, go?: { text: string; why: string; plain?: boolean }) {
    const l = this.settings.machine()
    t.held = { why, since: t.held?.since ?? Date.now(), ...(go ? { go: go.text, goWhy: go.why, plain: go.plain } : {}) }
    t.after = undefined
    t.todo = undefined
    const id = `held:${t.id}:${Date.now()}`
    const cap = why === 'space' ? this.spaceCap(t) : undefined
    const model = why === 'model' ? this.blockingCap(t) : undefined
    const words = {
      slots: `waiting for a free slot (${this.slotsWords(l.max)})`,
      machine: 'waiting for the machine: it is busy',
      models: 'waiting: every model of this space ran out, so a start would only be cut off too',
      resume: 'waiting: the tasks that were cut off go back to work first',
      space: `waiting for a free slot of ${cap?.shown ?? 'its space'} (${cap?.working ?? 0} of ${cap?.max ?? 0} of its tasks working)`,
      model: `waiting for a free slot of ${model?.name ?? 'its model'} (${model?.working ?? 0} of ${model?.max ?? 0} at once)`,
    }[why]
    this.chats.post(this.key(t), { id, card: { id, task: t.id, status: 'queued', text: words } })
    this.save()
    this.settleOne(t)
  }

  /** the go, now if this machine has room, else once it has */
  private goWhenRoom(t: TaskRec, text: string, why: string, plain = false) {
    const r = this.room(t)
    if (r.why) return this.hold(t, r.why, { text, why, plain })
    this.go(t, text, why, plain)
  }

  /**
   * Start held tasks while this machine has room, oldest first, one at a time machine.startEvery apart (2 min by
   * default): the load averages take minutes to show what a task adds. Called on each health sample and status change.
   */
  release(now = Date.now()) {
    if (this.releasing) return
    this.releasing = true
    try {
      for (const t of this.heldTasks()) {
        const r = this.room(t)
        // its own space waits for its models, or its cap is full, or its model's: another space's or model's may still start
        if (r.why === 'models' || r.why === 'resume' || r.why === 'space' || r.why === 'model') {
          if (t.held!.why !== r.why) {
            t.held!.why = r.why
            this.save()
            this.settleOne(t)
          }
          continue
        }
        if (r.why) {
          // each one waits for the same reason: its line says the one that holds them now
          const stale = this.heldTasks().filter((x) => x.held!.why !== r.why)
          for (const x of stale) x.held!.why = r.why
          if (stale.length) this.save()
          return
        }
        // one first in line doesn't wait for the spacing either
        if (!t.priority && !this.startsNow(now)) return
        this.lastStart = now
        const why = { slots: 'a slot is free', machine: 'the machine has room', models: 'its models answer again', resume: 'the cut-off tasks went back to work', space: 'a slot of its space is free', model: 'a slot of its model is free' }[t.held!.why]
        if (t.held!.go) this.go(t, t.held!.go, `${t.held!.goWhy ?? why} · ${why}`, t.held!.plain)
        else {
          t.held = undefined
          const id = `go:${t.id}:${now}`
          this.chats.post(this.key(t), { id, card: { id, task: t.id, status: 'work', text: `started: ${why}` } })
          this.save()
          this.startTask(t).catch((e) => this.troubled(t, e))
        }
      }
    } finally {
      this.releasing = false
    }
  }

  /* ---------- adding and starting ---------- */

  /**
   * A new task: its agent starts on the brief at once, unless it is added for a time (`at`): that one waits in Scheduled,
   * with no agent yet, and takes its Settings when it starts. The brief ends with the default way of working from
   * Settings; its CLI, model and effort are Settings' too, unless the coordinator chose others for it.
   */
  add(o: { project: string; base?: string; title: string; desc?: string; by: string; requester?: string; after?: string[]; later?: boolean; at?: number; agent?: Partial<Harness>; reviewer?: Partial<Harness>; set?: Record<string, string>; priority?: boolean }) {
    const p = this.places.byName(o.project) ?? this.places.byKey(o.project) ?? this.places.space(o.project)
    if (!p) throw new Error(`No project called ${o.project}`)
    // a new task is in no circle; those already done are not waited for
    const after = this.checkAfter(undefined, o.after ?? []).filter((ref) => this.depState(ref) !== 'done')
    const title = short(o.title)
    const space = placeId.space(p.name)
    this.taskIds.ensure(space, p.key)
    const { id, n, prefix } = this.taskIds.allocate(space)
    p.key = prefix
    this.data.next[prefix] = n
    const work = o.desc ?? (title !== o.title ? o.title : '')
    if (o.at !== undefined) {
      // for a time: no agent yet, and no Settings read yet (its brief, its agent and its ways are built when it starts)
      const t: TaskRec = {
        id,
        n,
        project: space,
        base: o.base ?? p.base,
        title,
        desc: work,
        by: o.by,
        requester: o.requester,
        created: Date.now(),
        updated: Date.now(),
        told: 'scheduled',
        ...(after.length ? { after } : {}),
        ...(o.priority ? { priority: true as const } : {}),
        scheduled: {
          at: o.at,
          desc: work,
          ...(o.set && Object.keys(o.set).length ? { set: o.set } : {}),
          ...(o.later ? { later: true } : {}),
          ...(Object.keys(o.agent ?? {}).length ? { agent: o.agent } : {}),
          ...(Object.keys(o.reviewer ?? {}).length ? { reviewer: o.reviewer } : {}),
        },
        ...(Object.keys(o.agent ?? {}).length ? { chosen: true as const } : {}),
      }
      this.data.tasks.push(t)
      this.save()
      this.armDue()
      this.emit('news', t.project, `${t.id} was added: ${t.title}`, 'added', { task: t.id, event: 'added' })
      return t
    }
    // its project's defaults: its own, else its machine's, else All machines'
    const reviewer = this.harness(o.reviewer, 'reviewer', p.name)
    const agent = this.harness(o.agent, 'task', p.name)
    const set = o.set && Object.keys(o.set).length ? o.set : undefined
    // each line that differs from Shepherdr's own says who set it: the coordinator's flags, or a level of Settings
    const by = { ...this.settings.setBy(p.name, set), ...(Object.keys(o.reviewer ?? {}).length ? { reviewer: 'task' as const } : {}), ...(Object.keys(o.agent ?? {}).length ? { agent: 'task' as const } : {}) }
    const ways = this.settings.ways(p.name, set)
    // the backup reviewer, off unless the human set one (its own keys, or the coordinator's --set for this task)
    const fallback = this.settings.reviewerBackups(p.name, set)
    const how = settingsBlock(id, { ways, reviewer, fallback, agent, by })
    const desc = [work, o.later ? LATER : '', how].filter(Boolean).join('\n\n')
    const t: TaskRec = {
      id,
      n,
      project: placeId.space(p.name),
      base: o.base ?? p.base,
      title,
      desc,
      by: o.by,
      requester: o.requester,
      created: Date.now(),
      updated: Date.now(),
      told: after.length ? 'queued' : 'work',
      agent,
      reviewer,
      waitChecks: ways.waitChecks,
      rounds: ways.rounds,
      ...(o.priority ? { priority: true as const } : {}),
      ...(Object.keys(o.agent ?? {}).length ? { chosen: true as const } : {}),
      ...(Object.keys(o.reviewer ?? {}).length ? { reviewerChosen: true as const } : {}),
    }
    if (after.length) t.after = after
    if (set) t.set = set
    // one that starts work now waits for room; one for later only reads its brief, so it starts at once. One queued
    // after other tasks gets no worktree, agent or herdr space while it waits: its go starts it (starter), as the
    // scheduler starts a queued task at its turn upstream (3.x herdr-task tick), and a message to it starts it sooner
    const room = after.length || o.later ? {} : this.room(t)
    this.data.tasks.push(t)
    if (room.why) {
      t.told = 'queued'
      this.hold(t, room.why)
    } else this.save()
    this.emit('news', t.project, `${t.id} was added: ${t.title}`, 'added', { task: t.id, event: 'added' })
    if (!room.why && !after.length) this.startTask(t).catch((e) => this.troubled(t, e))
    return t
  }

  /** Settings' CLI, model and effort for tasks (or their reviewer), with what the coordinator chose for this one on
   *  top. Another CLI drops Settings' model, which names one of the first CLI's models; its effort goes in as the
   *  nearest level the other CLI takes (models.ts). */
  private harness(chosen: Partial<Harness> = {}, role: 'task' | 'reviewer' = 'task', project?: string): Harness {
    const h = this.settings.harness(role, project)
    return { ...h, ...(chosen.kind && chosen.kind !== h.kind ? { model: undefined } : {}), ...chosen }
  }

  /* ---------- scheduled: a task that starts by itself at a time (--at / --in) ---------- */

  /** the time zone every time here is read in: Settings' (time.zone, Everywhere), as the heartbeat and automations' */
  private zone() {
    return this.settings.zone()
  }

  /**
   * A task added for a time takes its Settings when it starts, not when it was added: its brief's Settings block, its
   * agent and reviewer, and the ways it works are built here, from Settings as they are now. A task scheduled after it
   * was added already has its brief; it is left as it is.
   */
  private materialize(t: TaskRec) {
    const s = t.scheduled
    if (!s || s.desc === undefined) return
    const p = this.proj(t)
    const reviewer = this.harness(s.reviewer, 'reviewer', p.name)
    const agent = this.harness(s.agent, 'task', p.name)
    const set = s.set && Object.keys(s.set).length ? s.set : undefined
    const by = { ...this.settings.setBy(p.name, set), ...(Object.keys(s.reviewer ?? {}).length ? { reviewer: 'task' as const } : {}), ...(Object.keys(s.agent ?? {}).length ? { agent: 'task' as const } : {}) }
    const ways = this.settings.ways(p.name, set)
    t.desc = [s.desc, s.later ? LATER : '', settingsBlock(t.id, { ways, reviewer, fallback: this.settings.reviewerBackups(p.name, set), agent, by })].filter(Boolean).join('\n\n')
    t.agent = agent
    t.chosen = Object.keys(s.agent ?? {}).length ? true : undefined
    t.reviewer = reviewer
    t.reviewerChosen = Object.keys(s.reviewer ?? {}).length ? true : undefined
    t.waitChecks = ways.waitChecks
    t.rounds = ways.rounds
    if (set) t.set = set
  }

  /**
   * The timer for the next task due: at its exact time, and never longer than a minute at a stretch, so a clock that
   * moved or a machine that slept still starts it on the next look.
   */
  private armDue() {
    clearTimeout(this.dueTimer)
    const next = this.dueTasks().map((t) => t.scheduled!.at).sort((a, b) => a - b)[0]
    if (next === undefined) return
    const wait = Math.max(250, next - Date.now())
    const x = setTimeout(() => {
      this.duePass()
      this.armDue()
    }, Math.min(wait, 60_000))
    x.unref?.()
    this.dueTimer = x
  }

  /** tasks waiting for a time, whose agent starts then: not stopped, not archived, not done */
  private dueTasks() {
    return this.tasks.filter((t) => !!t.scheduled && !ended(t) && !t.stopped && !t.archived)
  }

  /** the tasks whose time has come now, oldest time first */
  dueNow(now = Date.now()) {
    return this.dueTasks().filter((t) => t.scheduled!.at <= now).sort((a, b) => a.scheduled!.at - b.scheduled!.at)
  }

  /** Start every task whose time has come (on the timer, and on the first look after a start): also one whose time
   *  passed while Shepherdr was off, which starts as soon as it is back and says so in its chat. */
  duePass(now = Date.now(), note?: string) {
    for (const t of this.dueNow(now)) this.beginScheduled(t, now, note)
  }

  /**
   * Its time has come: it starts as a task added now would. It takes its Settings first (a setting changed since it was
   * added counts), then waits for room on this machine, and for the tasks it was queued after (--after) — an agent of
   * its own starts only once both hold, with no countdown left to show.
   */
  private beginScheduled(t: TaskRec, now = Date.now(), note?: string) {
    const s = t.scheduled!
    const late = now - s.at > MISSED_BY
    try {
      this.materialize(t)
    } catch (e) {
      t.scheduled = undefined
      this.troubled(t, e)
      return
    }
    t.scheduled = undefined
    if (late) {
      const id = `due:${t.id}:${now}`
      const when = clockWords(s.at, now, this.zone())
      // why it is late: Shepherdr was off at its time (the usual case), or it was put away and brought back
      const why = note ?? 'while Shepherdr was off'
      this.chats.post(this.key(t), { id, card: { id, task: t.id, status: 'queued', text: `its time (${when}) passed ${why}: starting now` } })
    }
    // what it waits for still open: it is queued now, and Shepherdr starts it once those are done. One that is done
    // already is no wait any more: kept, it would start the agent on the queued line all the same
    const open = this.queued(t) ? this.open(t) : []
    t.after = open.length ? open : undefined
    if (open.length) {
      t.told = 'queued'
      this.save()
      this.settleOne(t)
      return
    }
    const r = this.room(t)
    if (r.why) {
      this.hold(t, r.why)
      return
    }
    if (!late) {
      const id = `due:${t.id}:${now}`
      this.chats.post(this.key(t), { id, card: { id, task: t.id, status: 'work', text: 'its time came: starting' } })
    }
    this.save()
    this.startTask(t).catch((e) => this.troubled(t, e))
  }

  /**
   * Start a task that has not started yet by itself at a time (`task queue <id> --at …`), or (null) cancel its time and
   * start it now, waiting for room and for what it waits for like a task added now. A task already at work, or one
   * whose agent ran before, keeps its own life: only one that has not started can be scheduled.
   */
  schedule(id: string, at: number | null): { at?: number; queued?: string[]; held?: HeldWhy } {
    const t = this.req(id)
    if (ended(t)) throw new Error(`${t.id} is Done already (${t.closed ? 'nothing to merge' : 'merged'})`)
    if (t.worktree || this.starting.has(t.id) || this.agents.record(this.key(t))) throw new Error(`${t.id} has already started: only a task that has not started yet can wait for a time. Write to its chat, or stop it first (shepherdr task stop ${t.id}).`)
    t.stopped = undefined
    t.todo = undefined
    t.trouble = undefined
    if (at !== null) {
      // it keeps what it waits for (--after): at its time it waits for the machine, and for those, before its agent starts
      t.held = undefined
      // a task added for a time keeps the brief it was added with, unread by Settings; one scheduled after it was added
      // already has its own, whole
      t.scheduled = { ...(t.scheduled ?? {}), at }
      this.save()
      this.armDue()
      this.settle(t)
      return { at }
    }
    // cancelled: from now on it waits for nothing but room, and for what it waits for (those done already are no wait)
    this.materialize(t)
    t.scheduled = undefined
    this.save()
    this.armDue()
    const open = this.queued(t) ? this.open(t) : []
    t.after = open.length ? open : undefined
    if (open.length) {
      this.settle(t)
      return { queued: open }
    }
    const r = this.room(t)
    if (r.why) {
      this.hold(t, r.why)
      return { held: r.why }
    }
    // no longer held: it starts here, and release() must not start it a second time
    t.held = undefined
    this.startTask(t).catch((e) => this.troubled(t, e))
    return {}
  }

  /** its agent waits for a go: To do until something is written to it (the go, or a change to the brief) */
  todo(id: string) {
    const t = this.req(id)
    if (ended(t)) throw new Error(`${t.id} is Done already (${t.closed ? 'nothing to merge' : 'merged'})`)
    t.todo = true
    // waiting for a go of its own: no longer just paused
    t.paused = undefined
    clearTimeout(this.later.get(t.id))
    this.settle(t)
    return t
  }

  private env(key: string) {
    return {
      ...(has('browser') ? browserEnv(key.split('/')[0]) : {}),
      ...agentEnv(key, ROOT),
    }
  }

  private async startTask(t: TaskRec) {
    this.starting.add(t.id)
    t.trouble = undefined
    this.emit('changed')
    try {
      // a server that may start no agent makes nothing for one either: no worktree, no branch, nothing in herdr
      if (!launchesAgents()) throw refusedLaunch(this.key(t))
      const p = this.proj(t)
      const branch = branchFor(t)
      // Old records without a snapshot keep the existing fallback; new tasks snapshot at add.
      t.base ??= p.base
      this.save()
      await G.validateBase(p.path, t.base)
      const made = await this.wt.create({ repo: p.path, name: p.name }, branch, t.base, labelOf(t)).catch((e) => {
        throw new Error(`Could not make a worktree: ${(e as Error).message}`)
      })
      Object.assign(t, { branch, worktree: made.path })
      this.save()
      await this.launch(t, this.queued(t) ? `${taskFirst(t)}\n\n${queuedLine(this.open(t), 'start', t.id)}` : taskFirst(t), made)
      this.briefing.add(t.id)
      clearTimeout(this.later.get(`${t.id}:brief`))
      const x = setTimeout(() => {
        this.later.delete(`${t.id}:brief`)
        if (this.briefing.delete(t.id)) this.settle(t)
      }, BRIEF_WAIT)
      x.unref?.()
      this.later.set(`${t.id}:brief`, x)
    } catch (e) {
      // went wrong before its worktree was there: it shows so
      t.trouble = troubleOf(e)
      throw e
    } finally {
      this.starting.delete(t.id)
      this.begun(t)
      this.settle(t)
    }
  }

  /**
   * Its agent, in its herdr space. A worktree that is gone (a stop with no work put it away) is made again first, in
   * the same folder, so its agent's session (kept by folder) is found again; never a finished task's.
   */
  private async launch(t: TaskRec, first?: string, made?: Made, as?: Harness, restart?: () => Promise<string | void>) {
    // refused before the worktree it would make, the herdr space it would open and the CLI trust file it would write
    if (!launchesAgents()) throw refusedLaunch(this.key(t))
    const key = this.key(t)
    const rec = this.agents.record(key)
    const p = this.proj(t)
    const home = { repo: p.path, name: p.name }
    if (!made && !ended(t) && !existsSync(t.worktree!) && this.agents.status(key) === 'gone') {
      made = await this.wt.create(home, t.branch!, t.base!, labelOf(t), t.worktree)
      t.worktree = made.path
      this.save()
    }
    // back to work in the worktree it had (not one made just now): what came into its base meanwhile reaches it first
    const moved = made ? undefined : await this.freshen(t).catch(() => undefined)
    if (moved) {
      if (restart) {
        const before = restart
        restart = async () => [await before(), moved].filter(Boolean).join('\n\n')
      } else first = first ? `${first}\n\n${moved}` : moved
    }
    const env = this.env(key)
    // a task from before tasks kept their own CLI starts on Settings'
    const h = t.agent ?? this.settings.harness('task', this.nameOf(t))
    trustWorktree(t.worktree!, as?.kind ?? rec?.kind ?? h.kind, env)
    const spec: Spec = {
      access: 'full',
      key,
      name: rec?.name ?? `shep-${t.id.toLowerCase()}`,
      kind: as?.kind ?? rec?.kind ?? h.kind,
      // only its first start (or a backup's, on its CLI's own model): later, its own chat's pickers are what count
      ...(as ? { model: as.model ?? 'default', effort: as.effort } : rec ? {} : { model: h.model, effort: h.effort }),
      // what Settings said when it started on them: a change since is offered as a restart (restart.ts)
      ...(as || !rec ? { set: this.settings.harness('task', this.nameOf(t)) } : {}),
      cwd: t.worktree!,
      workspace: labelOf(t),
      tab: 'Agent',
      system: taskPrompt({ id: t.id, branch: t.branch!, base: t.base! }, pastTimes(this.data.tasks, t)) + '\n\n' + privatePrompt(this.settings.instructions('task', this.nameOf(t)), this.settings.instructions('reviewer', this.nameOf(t))),
      env,
      first,
      pane: () => this.wt.agentPane({ home, wt: t.worktree!, label: labelOf(t), tab: 'Agent', env, made }),
    }
    return restart ? this.agents.restart(spec, restart) : this.agents.ensure(spec)
  }

  /**
   * You start a task that waits (queued, held, To do, scheduled) now: it no longer waits for the tasks it was queued
   * after nor for a time, and it is first in line, past the machine's load, pressure and spacing; never past its slots,
   * where it waits for the next free one ahead of the others. `on`: a worker of your choosing for this task's agent
   * alone (its reviewer and its backups stay as Settings say). Returns what still holds it.
   */
  async startNow(id: string, on?: Harness): Promise<{ held?: HeldWhy }> {
    const t = this.req(id)
    if (ended(t)) throw new Error(`${t.id} is Done already (${t.closed ? 'nothing to merge' : 'merged'})`)
    if (this.starting.has(t.id) || this.handing.has(t.id) || ['work', 'merging', 'need', 'ready'].includes(this.statusOf(t)))
      throw new Error(`${t.id} isn't waiting to start${on ? ': Restart agent… changes what it runs on' : ''}`)
    if (t.scheduled) {
      this.materialize(t)
      t.scheduled = undefined
      this.armDue()
    }
    const was = this.queued(t) ? t.after! : []
    if (on) t.agent = on
    Object.assign(t, { priority: true as const, after: undefined, todo: undefined, stopped: undefined, paused: undefined, held: undefined })
    const live = !!t.worktree && existsSync(t.worktree) && this.agents.status(this.key(t)) !== 'gone'
    const rec = this.agents.record(this.key(t))
    t.switchTo = on && live && rec && !sameHarness({ kind: rec.kind, model: rec.model, effort: rec.effort }, on) ? on : undefined
    const why = `you started it now${on ? ` on ${harnessWords(fitHarness(on))}` : ''}${was.length ? `; it no longer waits for ${was.join(', ')}` : ''}`
    const goText = was.length ? goLine(was, [], true) : 'Go: you were started now, start the work.'
    const r = this.room(t)
    if (r.why) {
      if (t.worktree) this.hold(t, r.why, { text: goText, why })
      else this.hold(t, r.why)
      return { held: r.why }
    }
    if (t.worktree) this.go(t, goText, why)
    else {
      const card = `go:${t.id}:${Date.now()}`
      this.chats.post(this.key(t), { id: card, card: { id: card, task: t.id, status: 'work', text: `started: ${why}` } })
      this.save()
      // as a task added with room starts: one that can't start says so on the task
      this.startTask(t).catch((e) => this.troubled(t, e))
    }
    return {}
  }

  /** Start with…: the worker a task that waits starts on, for it alone (its own agent, never Settings'), and nothing
   *  else: it stays in line as it is. One whose agent waits in its worktree on another is restarted on it at its go */
  setWorker(id: string, on: Harness) {
    const t = this.req(id)
    if (ended(t) || !['queued', 'todo', 'scheduled'].includes(this.statusOf(t))) throw new Error(`${t.id} isn't waiting to start: Restart agent… changes what it runs on`)
    t.agent = on
    // a worker picked here is no task add's flag any more
    t.chosen = undefined
    if (t.scheduled) t.scheduled.agent = on
    const rec = this.agents.record(this.key(t))
    const live = !!t.worktree && existsSync(t.worktree) && this.agents.status(this.key(t)) !== 'gone'
    t.switchTo = live && rec && !sameHarness({ kind: rec.kind, model: rec.model, effort: rec.effort }, on) ? on : undefined
    const id2 = `worker:${t.id}:${Date.now()}`
    this.chats.post(this.key(t), { id: id2, card: { id: id2, task: t.id, text: `Starts on ${harnessWords(fitHarness(on))} when its turn comes` } })
    this.save()
    this.settleOne(t)
    return t
  }

  /**
   * Settings' task agent changed (task.agent, task.model or task.effort): the waiting tasks it reaches take what
   * Settings now name for their space, each as Start with… sets it (setWorker), so they run on it at their turn.
   * Scope: `space` (that space's waiting tasks, whatever its own setting), or `key` at the Everywhere or machine level
   * (every space of this machine that does not set that key itself: one that does keeps its own). Running tasks keep
   * their agent, and so does one already on it. `dry`: count only, change nothing.
   */
  retuneWaiting(scope: { space: string } | { key: string }, dry = false): Retune {
    const out: Retune = { changed: 0, same: 0, follow: 0, pinned: 0, running: 0, kept: [], spaces: [] }
    const want = 'space' in scope ? this.addedNameOf(scope.space) : undefined
    const plan: { t: TaskRec; on: Harness }[] = []
    const perSpace = new Map<string, { on: Harness; changed: number }>()
    for (const t of this.tasks) {
      const space = this.nameOf(t)
      if (t.archived || ended(t) || !space || ('space' in scope && space !== want)) continue
      const waiting = WAITING.includes(this.statusOf(t))
      if (!('space' in scope) && this.settings.pick(scope.key, { space }).from === 'space') {
        if (waiting && !out.kept.includes(space)) out.kept.push(space)
        continue
      }
      if (!waiting) {
        out.running++
        continue
      }
      // a scheduled task takes Settings when it starts, over the flags task add gave it (if any): with none, it follows
      // Settings already; so does one the way back starts again on what Settings name
      const flags = t.scheduled?.agent
      const cur = t.scheduled ? (flags && Object.keys(flags).length ? this.harness(flags, 'task', space) : undefined) : t.agent
      if (!cur || this.goesBack?.(t)) {
        out.follow++
        continue
      }
      const on = this.settings.harness('task', space)
      if (sameHarness(cur, on)) {
        out.same++
        continue
      }
      out.changed++
      if (t.chosen) out.pinned++
      const s = perSpace.get(space) ?? { on, changed: 0 }
      s.changed++
      perSpace.set(space, s)
      plan.push({ t, on })
    }
    if (!dry) for (const { t, on } of plan) this.setWorker(t.id, on)
    // the answer names each space as it shows; the scope and the settings keep the name it was added under
    out.kept = out.kept.map((name) => this.places.shownName(name))
    out.spaces = [...perSpace].map(([name, s]) => ({ name: this.places.shownName(name), ...s }))
    return out
  }

  /**
   * Settings' reviewer changed (reviewer.agent, reviewer.model, reviewer.effort, and the backup reviewers' keys): the
   * waiting tasks it reaches take what Settings now name for their space, as a task added now would. Their brief's
   * Settings block says it: its Reviewer line is written again (rebriefReviewer), the words above it untouched. Scope as
   * retuneWaiting: a space's own setting for the key it changes is kept. A task whose agent has its brief already cannot
   * read a changed block, so its agent hears the new Reviewer line with its go (takeNote), and nothing is sent now. A
   * scheduled task builds its brief at its time, so it follows Settings unless task add gave it a reviewer of its own
   * (that goes). A reviewer task add chose (reviewerChosen) is changed too, and counted apart. `dry`: count only.
   */
  retuneReviewers(scope: { space: string } | { key: string }, dry = false): Retune {
    const out: Retune = { changed: 0, same: 0, follow: 0, pinned: 0, running: 0, kept: [], spaces: [] }
    const want = 'space' in scope ? this.addedNameOf(scope.space) : undefined
    const plan: (() => void)[] = []
    const perSpace = new Map<string, { on: Harness; changed: number }>()
    const told = (t: TaskRec, on: Harness) => {
      const words = `Reviewed by ${harnessWords(fitHarness(on))}`
      const id = `reviewer:${t.id}:${Date.now()}`
      const text = this.hasBrief(t) ? `${words}: its agent is told at its go` : `${words} when its turn comes`
      this.chats.post(this.key(t), { id, card: { id, task: t.id, text } })
    }
    for (const t of this.tasks) {
      const space = this.nameOf(t)
      if (t.archived || ended(t) || !space || ('space' in scope && space !== want)) continue
      const waiting = WAITING.includes(this.statusOf(t))
      if (!('space' in scope) && this.settings.pick(scope.key, { space }).from === 'space') {
        if (waiting && !out.kept.includes(space)) out.kept.push(space)
        continue
      }
      if (!waiting) {
        out.running++
        continue
      }
      const on = this.settings.harness('reviewer', space)
      let pinned: boolean
      let changed: () => void
      if (t.scheduled) {
        // its brief is built at its time from Settings: only a reviewer task add gave it is a change
        const flags = t.scheduled.reviewer
        if (!flags || !Object.keys(flags).length) {
          out.follow++
          continue
        }
        if (sameHarness(this.harness(flags, 'reviewer', space), on)) {
          out.same++
          continue
        }
        pinned = true
        changed = () => {
          t.scheduled!.reviewer = undefined
          told(t, on)
        }
      } else {
        const fallback = this.settings.reviewerBackups(space, t.set)
        const review = this.settings.ways(space, t.set).review
        const desc = rebriefReviewer(t.desc, { reviewer: on, fallback, review, by: this.settings.setBy(space, t.set).reviewer })
        if ((!t.reviewer || sameHarness(t.reviewer, on)) && desc === t.desc && !t.reviewerChosen) {
          out.same++
          continue
        }
        pinned = !!t.reviewerChosen
        changed = () => {
          const line = reviewerLine(on, (briefReview(desc) ?? review) ? fallback : undefined)
          t.reviewer = on
          t.desc = desc
          t.reviewerChosen = undefined
          if (this.hasBrief(t)) t.reviewerNote = reviewerChangedLine(line)
          told(t, on)
        }
      }
      out.changed++
      if (pinned) out.pinned++
      const s = perSpace.get(space) ?? { on, changed: 0 }
      s.changed++
      perSpace.set(space, s)
      plan.push(changed)
    }
    if (!dry && plan.length) {
      for (const f of plan) f()
      this.save()
    }
    // as retuneWaiting: the answer names each space as it shows
    out.kept = out.kept.map((name) => this.places.shownName(name))
    out.spaces = [...perSpace].map(([name, s]) => ({ name: this.places.shownName(name), ...s }))
    return out
  }

  /** a coordinator's mark (task priority, task add --priority): first in line, past the machine's load, pressure and
   *  spacing, within its slots; off: back in line by its age. Nothing more: what it is queued after still holds it */
  setPriority(id: string, on: boolean) {
    const t = this.req(id)
    if (ended(t)) throw new Error(`${t.id} is Done already (${t.closed ? 'nothing to merge' : 'merged'})`)
    t.priority = on ? true : undefined
    this.save()
    this.settleOne(t)
    this.release()
    return t
  }

  /**
   * Bring a task's branch up to its base before its agent goes back to work in the worktree it had: what was merged into
   * the base meanwhile (build settings, the check, its tools, AGENTS.md) reaches it at once instead of at its merge. Only
   * a clean worktree is rebased, and a conflict leaves it as it was (G.rebase aborts). Its chat gets a card, and what
   * comes back is its agent's note (hidden from the chat): rebased, or what to do at its next good point. Nothing when
   * its base didn't move, or for a task done or on its way into its base. The local base is what merges here keep up to
   * date: no fetch, so a way back of many tasks asks the remote nothing.
   */
  private async freshen(t: TaskRec): Promise<string | undefined> {
    if (ended(t) || t.landing || !t.base || !t.worktree || !existsSync(t.worktree)) return
    const wt = t.worktree
    const base = t.base
    if (!(await G.git(wt, 'rev-parse', '--verify', '--quiet', `refs/heads/${base}`)).ok) return
    if ((await G.git(wt, 'merge-base', '--is-ancestor', base, 'HEAD')).ok) return
    const from = (await G.git(wt, 'merge-base', base, 'HEAD')).out
    if (!from) return
    const commits = (await G.git(wt, 'log', '--format=%h %s', `${from}..${base}`)).out.split('\n').filter(Boolean)
    const rules = (await G.git(wt, 'diff', '--name-only', `${from}..${base}`, '--', ':(glob)**/AGENTS.md', ':(glob)**/CLAUDE.md')).out.split('\n').filter(Boolean)
    const state: BaseMoved['state'] = (await G.dirty(wt)) ? 'dirty' : (await G.rebase(wt, base)).ok ? 'rebased' : 'conflict'
    const m: BaseMoved = { base, commits, rules, state, ...(this.gateOf(t) ? { gate: true } : {}) }
    const key = this.key(t)
    const id = `base:${t.id}:${Date.now()}`
    this.chats.post(key, { id, card: { id, task: t.id, text: baseMovedCard(m) } })
    return hidden(baseMovedLine(m), 'base')
  }

  /**
   * Words about to go in to a task's agent that waits at rest, its turn over: it asked you something on a card, ended
   * its turn without reporting done, is To do, or reported ready. They take it back to work, so its branch is brought up
   * to its base first (freshen), and they carry the note. Nothing for an agent mid-turn (a permission, its CLI's own
   * question: the answer goes in as keys while its turn goes on), at work, or gone (its start does this), nor for a task
   * done or queued (the way back starts that one).
   */
  async beforeWords(id: string): Promise<string | undefined> {
    const t = this.task(id)
    if (!t || ended(t)) return
    if (['working', 'blocked', 'gone'].includes(this.agents.status(this.key(t)))) return
    if (!['need', 'todo', 'ready'].includes(this.statusOf(t))) return
    return this.freshen(t).catch(() => undefined)
  }

  /**
   * Writing to a task whose agent stopped starts it again, with its memory. `fresh`: its session is gone (start.ts), so
   * it starts on a new one and is told its brief again: all it remembers of the work is the branch and the chat.
   */
  resume(id: string, fresh = false) {
    const t = this.task(id)
    if (!t?.worktree) return Promise.resolve(null)
    const first = fresh ? `${taskFirst(t)}\n\n${freshLine()}` : undefined
    return this.launch(t, first).catch((e) => {
      // it never got going: the human hears why, in the chat and on the task, and nothing starts it again meanwhile
      const kind = this.agents.record(this.key(t))?.kind
      this.startFailed(this.key(t), `${kind ? (CLI_NAME[kind] ?? kind) : 'Its agent'} couldn't start: ${troubleOf(e)}`)
      return null
    })
  }

  /**
   * A start that never became a turn (start.ts): its chat says the error with the reason, a task shows it instead of
   * working, and nothing starts it again until someone writes to it, or a fresh session was the way on.
   */
  startFailed(key: string, why: string, at = Date.now()) {
    const before = this.failedStarts.get(key)
    // one launch, one error: a look that comes again, or the relaunch loop, says nothing new
    if (before !== undefined && at <= before.at) return
    this.failedStarts.set(key, { at, why })
    const card = `start-failed:${key}:${at}`
    this.chats.post(key, { id: card, card: { id: card, text: why } })
    const t = this.task(key.split('/')[0])
    if (!t || key !== this.key(t) || ended(t) || t.archived) return
    t.trouble = why
    t.startTrouble = why
    this.settle(t)
  }

  /** when this chat's last start failed, if it did: the relaunch loop leaves a failed start to the human */
  startFailedAt(key: string) {
    return this.failedStarts.get(key)
  }

  /** it began its turn, or something was handed to it: its start is no longer a failed one, and the error it shows for
   *  it goes (one that was another trouble, or that a restart kept, stays) */
  private started(key: string) {
    this.failedStarts.delete(key)
    const t = this.task(key.split('/')[0])
    if (!t || key !== this.key(t) || !t.startTrouble) return
    // another trouble replaced the start's own: that one is not this
    if (t.trouble === t.startTrouble) t.trouble = undefined
    t.startTrouble = undefined
    this.settle(t)
  }

  /**
   * Its agent started again on this CLI, model and effort (the restart sheet, shepherdr restart). Mid-turn it is
   * interrupted first. The same CLI resumes its session; another takes over with the brief, the branch's commits,
   * what lies uncommitted and the chat's last messages. What you sent meanwhile waits for it; its worktree and branch
   * stay as they are; a card in its chat marks it. back: Shepherdr starts it again once the primary answers again
   * (return.ts) — back from its backup, or again on the model that cut it off: it is told so, and its backup may go in
   * again the next time that one runs out. A start that went wrong before is over once it starts.
   */
  async restart(id: string, to: Harness, back?: BackWhy) {
    const t = this.req(id)
    if (ended(t)) throw new Error(`${t.id} is Done already (${t.closed ? 'nothing to merge' : 'merged'}): it has no agent to restart.`)
    if (!t.worktree) throw new Error(`${t.id} hasn't started yet: it starts on what its brief says.`)
    if (this.handing.has(t.id)) throw new Error(`${t.id}'s agent is starting again already.`)
    if (!this.installed(to.kind)) throw new Error(`${CLI_NAME[to.kind] ?? to.kind} isn't installed on this machine.`)
    const key = this.key(t)
    const h = fitHarness(to)
    const from = this.agents.record(key)?.kind ?? t.agent?.kind ?? ''
    const name = (k: string) => CLI_NAME[k] ?? k
    const words = harnessWords(h)
    this.handing.add(t.id)
    try {
      // what it is told, read once its turn has stopped: what it did meanwhile counts
      const first = async () => {
        await this.agents.stopTurn(key)
        // a reviewer Settings changed meanwhile: the same CLI, which reads its brief from its session, is told it now;
        // another CLI reads the brief as it is now (taskFirst), which has it
        const reviewer = this.takeNote(t)
        if (from === h.kind) return hidden([resumedLine(words, back), reviewer].filter(Boolean).join('\n\n'), 'restart')
        return hidden(`${taskFirst(t)}\n\n${restartLine({ from: name(from), to: words, back: !!back, ...(await this.soFar(t, key, name(from))) })}`, 'restart')
      }
      await this.launch(t, undefined, undefined, { ...h, model: h.model ?? '', effort: h.effort ?? '' }, first)
      // a pause or a stop is over: it carries on
      t.stopped = undefined
      t.paused = undefined
      t.agent = h
      // it started: what went wrong with a start before is over
      t.trouble = undefined
      // back on its primary: the backup's one go is given back, for the next time that one runs out
      if (back) t.tookOver = undefined
      const card = `restart:${t.id}:${Date.now()}`
      this.chats.post(key, { id: card, card: { id: card, restart: true, text: back ? wentBackCardWords(words, back) : `Restarted on ${words}` } })
    } finally {
      this.handing.delete(t.id)
      this.save()
      this.settle(t)
    }
    return words
  }

  /** its agent works and its brief has gone in: it is at work on it, no longer To do */
  private begun(t: TaskRec) {
    const key = this.key(t)
    if (!this.briefing.has(t.id) || this.agents.status(key) !== 'working' || this.agents.waiting(key).length) return
    this.briefing.delete(t.id)
    clearTimeout(this.later.get(`${t.id}:brief`))
    this.later.delete(`${t.id}:brief`)
  }

  /** something went in to an agent: its brief, maybe, which it may already be at work on */
  sent(key: string) {
    const t = this.task(key.split('/')[0])
    if (!t || !this.briefing.has(t.id)) return
    this.begun(t)
    this.settle(t)
  }

  /**
   * Its agent can't go on (retry.ts): out of allowance, signed out, or its provider still down after the last try. The
   * next backup of its chain (Settings' task.fallback on backup.model and backup.effort, then the 2nd to the 5th, of its
   * space) takes over, each once: the same CLI starts again and resumes its own session, so nothing is lost; another CLI
   * takes over in the same worktree and branch, with the brief and what was done so far. Once the last one can't go on
   * either, or none is set, it waits for you.
   */
  async cantGoOn(id: string, why: string, lasting = false) {
    const t = this.task(id)
    if (!t || !this.mayRetry(this.key(t)) || this.handing.has(t.id)) return
    const key = this.key(t)
    const rec = this.agents.record(key)
    const from = rec?.kind ?? t.agent?.kind ?? ''
    const space = this.nameOf(t)
    // the harness its agent really ran on: its own (task add --agent) where it has one, else what Settings name
    const ran: Harness = rec ? { kind: rec.kind, model: rec.model, effort: rec.effort } : (t.agent ?? this.settings.harness('task', space))
    // what this task keeps for itself (task add --set) first, then its space's settings, its machine's and Everywhere's:
    // the backups after the one it is on now (all of them, while none took over), the first that can go in
    const at = t.tookOver ? (t.tookOver.step ?? 1) : 0
    const later = this.backupsFor('task', space, t.set).filter((p) => p.n > at)
    const plan = later.find((p) => p.to)
    // waits for the human from here: one cut off for good is started again once its provider answers (return.ts). A
    // note that can't be written never changes what happens to the task
    const stuck = () => {
      if (!lasting) return
      try {
        this.noteStuck?.(t, ran, why.charAt(0).toLowerCase() + why.slice(1))
      } catch (e) {
        console.error(`shepherdr: couldn't keep that ${t.id} waits for its provider: ${(e as Error).message}`)
      }
    }
    if (!t.worktree) return this.settle(t)
    // each backup goes in once: past the last one, a takeover that keeps failing is the human's, not a loop
    if (!plan?.to) {
      stuck()
      return this.noBackup(key, later.find((p) => p.why)?.why)
    }
    const to = plan.to.kind
    // only an agent whose session is there has one to keep: one with no record, or whose session is gone, starts fresh,
    // with the brief and the chat
    const same = to === from && !!rec && !rec.fresh && (!!rec.sessionId || rec.logs.length > 0)
    const name = (k: string) => CLI_NAME[k] ?? k
    this.handing.add(t.id)
    t.tookOver = { from, to, why: why.charAt(0).toLowerCase() + why.slice(1), at: Date.now(), step: plan.n }
    this.settle(t)
    try {
      // Settings' Backup model and effort (this task's own first), or else the task's own: its CLI may not take them, in
      // which case it starts on its own default
      const own = t.agent ?? this.settings.harness('task', space)
      const model = plan.to.model ?? (own.model ? findModel(to, own.model)?.id : undefined)
      const effort = plan.to.effort ?? own.effort
      const h: Harness = { kind: to, model, effort }
      const words = harnessWords(fitHarness(h))
      const first = same
        ? hidden(backupKeptLine({ on: words, why: t.tookOver.why }), 'restart')
        : `${taskFirst(t)}\n\n${handOverLine({ from: name(from), why: t.tookOver.why, ...(await this.soFar(t, key, name(from))) })}`
      await this.agents.finish(key)
      await this.launch(t, first, undefined, h)
      const card = `takeover:${t.id}:${t.tookOver.at}`
      const text = backupCardWords({ from: name(from), to: name(to), words, same, why: t.tookOver.why })
      this.chats.post(key, { id: card, card: { id: card, text } })
      // a lasting one: the primary it ran out of is what the watch asks about later (return.ts). A note that can't be
      // written must never undo the takeover that just went in
      if (lasting)
        try {
          this.noteTookOver?.(t, ran, h, t.tookOver.why)
        } catch (e) {
          console.error(`shepherdr: couldn't keep that ${t.id} runs on a backup: ${(e as Error).message}`)
        }
    } catch (e) {
      // the backup didn't start: it went wrong, and a later hand-over may try again
      t.trouble = troubleOf(e)
      t.tookOver = undefined
      stuck()
    } finally {
      this.handing.delete(t.id)
      this.settle(t)
    }
  }

  /**
   * The backup agent a role's agent gets when it can't go on, by Settings at this level: its CLI, and the model and effort
   * it starts on (each backup's own pair: the tasks' on backup.model and backup.effort, the coordinators' on
   * coordinator.fallbackModel and coordinator.fallbackEffort, read from the tasks' pair while that one is at default).
   * `own` is what one task keeps for itself (task add --set), read before the space's. Nothing when the backup is off,
   * not installed, or set to a model that CLI doesn't have; `why` says why a backup the human set can't go in (its
   * words in that chat), nothing when there is no backup at all.
   */
  backupFor(role: 'task' | 'coordinator', space?: string, own?: Record<string, string>): { to?: { kind: string; model?: string; effort?: string }; why?: string } {
    const first = this.backupsFor(role, space, own)[0]
    return first?.n === 1 ? { ...(first.to ? { to: first.to } : {}), ...(first.why ? { why: first.why } : {}) } : {}
  }

  /** every backup of a role's chain that is on, in turn (n: its place, 1 for Backup 1), each as backupFor says it: the
   *  harness it goes in on, or why it can't. Backup 1's model follows the tasks' pair as it always did (backupModelOf);
   *  the 2nd to the 5th read their own */
  backupsFor(role: 'task' | 'coordinator', space?: string, own?: Record<string, string>): BackupPlan[] {
    const get = (key: string) => own?.[key] ?? this.settings.get(key, space)
    return chainPairs(role).flatMap((p, i): BackupPlan[] => {
      const n = i + 1
      const to = kindOf(get(p.cli))
      if (!to) return []
      const them = CLI_NAME[to] ?? to
      if (!this.installed(to)) return [{ n, why: `${them} isn't installed on this machine` }]
      const { model, row } = n === 1 ? backupModelOf(role, get) : { model: get(p.model), row: `${role === 'task' ? 'Tasks' : 'Coordinators'} → Backup ${n} model` }
      if (model.toLowerCase() !== 'default' && knowsModels(to) && !findModel(to, model)) return [{ n, why: `${them} has no model ${model}: ${row} is set to one it doesn't have` }]
      return [{ n, to: { kind: to, ...this.settings.modelOf(p.name, to, space, get) } }]
    })
  }

  /** the harnesses a role's chain goes in on, in turn: what the way back counts as being on a backup (source.ts) */
  backupHarnesses(role: 'task' | 'coordinator', space?: string, own?: Record<string, string>) {
    return this.backupsFor(role, space, own).flatMap((p) => (p.to ? [p.to] : []))
  }

  /** no backup went in, and the human set one: its chat says why, so a backup that can't go leaves no silence */
  private noBackup(key: string, why?: string) {
    if (why) {
      // one card per reason: a cut that comes again says the same thing in the same card
      const id = `backup:${key}:${why}`
      this.chats.post(key, { id, card: { id, text: `No backup agent took over: ${why}.` } })
    }
    const t = this.task(key.split('/')[0])
    if (t && key === this.key(t)) this.settle(t)
  }

  /** what a backup agent is told was done: the branch's commits, what lies uncommitted, the chat's last messages */
  private async soFar(t: TaskRec, key: string, them: string) {
    const out = async (...args: string[]) => {
      const r = await G.git(t.worktree!, ...args)
      return r.ok ? r.out.split('\n').filter(Boolean).slice(0, 20).join('\n') : ''
    }
    return { commits: await out('log', '--oneline', `${t.base}..HEAD`), changes: await out('status', '--short'), chat: recentChat(this.chats.chat(key).messages, them, taskFirst(t).trim()) }
  }

  private troubled(t: TaskRec, e: unknown) {
    t.trouble = troubleOf(e)
    this.settle(t)
  }

  /* ---------- what agents report ---------- */

  /** the agent's plan: a card in its chat; your answer goes back to it as a chat line */
  async plan(id: string, steps: string[]) {
    const t = this.req(id)
    t.plan = steps
    const q: Question = {
      id: `plan:${t.id}:${Date.now()}`,
      title: `Plan for ${t.id}`,
      kind: 'Plan',
      steps,
      choices: [{ label: 'Approve the plan' }, { label: 'Send it back with a note' }],
      noteRequiredFor: 1,
      to: `${t.id} agent`,
    }
    this.chats.post(this.key(t), { id: q.id, question: q })
    this.save()
  }

  /** the agent's own progress (shepherdr status): its line, how far through the task, the minutes left if it said */
  report(id: string, msg: string, progress: number, left?: number) {
    const t = this.req(id)
    if (ended(t)) throw new Error(`${t.id} is Done already (${t.closed ? 'nothing to merge' : 'merged'})`)
    // reported done: nothing shows, and a line kept now would come back stale once it works again
    if (t.reported) throw new Error(`${t.id} is Ready: no progress shows until it works again.`)
    const at = Date.now()
    this.heard.set(t.id, at)
    t.report = { msg: fitStatus(msg), progress, left, at, pausedAt: this.statusOf(t) === 'need' ? at : undefined }
    this.save()
    return t.report
  }

  /* ---------- review rounds ---------- */

  /**
   * The most review rounds its brief asks for: the rounds it said when the task was added, and any its coordinator
   * added past them (one, and only once those were used).
   */
  roundsOf(t: TaskRec) {
    return (t.rounds ?? this.settings.ways(this.places.space(t.project)?.name).rounds) + (t.reviewsAdded ?? 0)
  }

  /** the review rounds it has left, as its agent counted them (shepherdr review) */
  reviewsLeft(t: TaskRec) {
    return this.roundsOf(t) - (t.reviews ?? 0)
  }

  /**
   * Its own agent counts the review round it starts (shepherdr review): no round goes by uncounted, so one that has
   * used them all is refused and asks its coordinator instead of reviewing on its own for ever.
   */
  reviewRound(id: string) {
    const t = this.req(id)
    if (ended(t)) throw new Error(`${t.id} is Done already: it has no review to run`)
    if (this.reviewsLeft(t) <= 0) throw new Error(this.roundsUsed(t))
    t.reviews = (t.reviews ?? 0) + 1
    this.save()
    return { round: t.reviews, rounds: this.roundsOf(t) }
  }

  /** what a task out of review rounds is told: the rounds are a limit, so only its coordinator raises it */
  private roundsUsed(t: TaskRec) {
    return `All ${this.roundsOf(t)} of ${t.id}'s review rounds are used. If its last commit still needs a review, say why in your chat and end your turn: only ${this.spaceName(t)}'s coordinator adds one (shepherdr task review-more ${t.id})`
  }

  private spaceName(t: TaskRec) {
    return this.places.nameOf(t.project) ?? t.project
  }

  /**
   * Its coordinator gives it exactly one more review round, once its own are used, and its agent hears it in its chat
   * and runs it: the limit is what stops an agent reviewing for ever, so the verb is its coordinator's. `from` is the
   * chat the command carries, which helper/route.pl takes from the caller's live process: a task's agent arrives as
   * `<ID>/Agent` and is refused. A caller that sets SHEPHERDR_CHAT to a live coordinator's chat, or posts to the
   * loopback API itself, arrives as that coordinator: 2.0 proves who a caller is only for secrets (`secret run` and
   * `secret env`, with the launch's own credential), and every coordinator-only verb here (`task delete`, `archive`,
   * `pause`) shares that boundary.
   */
  async reviewMore(id: string, from?: string) {
    const t = this.req(id)
    if (from?.includes('/')) throw new Error(`Only ${t.id}'s coordinator adds a review round, never its own agent: ask your coordinator`)
    // a coordinator of another space (another machine's included) is not this task's
    if (from && from !== t.project) throw new Error(`Only ${this.spaceName(t)}'s coordinator adds ${t.id} a review round, not ${this.places.nameOf(from) ?? from}'s: ask it`)
    if (ended(t) || t.landing) throw new Error(`${t.id} is ${t.closed ? 'Done with nothing to merge' : t.merged ? 'merged' : 'on its way into main'}: it needs no more review`)
    // one, ever: using the round it added is the last of them, not room for another
    if (t.reviewsAdded) throw new Error(`${t.id}'s coordinator has already added its one more review round (${t.reviews ?? 0} of ${this.roundsOf(t)} used): there is no second`)
    // a task from before rounds were counted has none: its agent counts the next one, and only then can one be added
    if (this.reviewsLeft(t) > 0) throw new Error(`${t.id} has used ${t.reviews ?? 0} of ${this.roundsOf(t)} review rounds; it takes one more only once they are all used${t.reviews === undefined ? ` (its agent counts each round: shepherdr review ${t.id})` : ''}`)
    t.reviewsAdded = (t.reviewsAdded ?? 0) + 1
    const rounds = this.roundsOf(t)
    this.save()
    const text = `Your coordinator added one review round: ${rounds} in all. Run shepherdr review ${t.id}, then review your final commit as your brief says.`
    const cid = `review:${t.id}:${Date.now()}`
    this.chats.post(this.key(t), { id: cid, card: { id: cid, task: t.id, status: 'work', text: `woken: your coordinator added one review round (${rounds} in all)` } })
    await this.sendBack(t, hidden(text, 'review', { task: t.id }))
    return { rounds }
  }

  /**
   * The agent reports done: Ready, waiting for review or merge. A branch with no changes at all (a research task, an
   * answer) has nothing to merge: it is closed, Done at once, and put away once the agent's turn ends. So is one whose
   * work is in its base already, its pull request merged on GitHub by hand among them: Done (merged), never a pull
   * request opened for what is in.
   */
  async done(id: string, summary: string, facts?: string): Promise<{ state: 'ready' | 'closed' | 'merged' | 'ended'; note?: string }> {
    const t = this.req(id)
    if (ended(t)) return { state: 'ended' }
    if (summary) t.said = summary
    if (facts) t.facts = facts
    t.reported = true
    t.reportedAt ??= Date.now()
    t.landing = undefined
    t.going = undefined
    // news on its pull request from now on is told to it
    t.watch ??= { since: ghNow() }
    // its job is over: so is what it said of its progress
    t.report = undefined
    if (t.worktree && t.base && existsSync(t.worktree)) {
      const ahead = await G.aheadCount(t.worktree, t.base)
      if (!(await G.dirty(t.worktree)) && ahead === 0) {
        this.markClosed(t)
        if (this.agents.status(this.key(t)) !== 'working') await this.cleanup(t)
        return { state: 'closed' }
      }
      // its own work is in its base already, though not as its commits: its pull request was merged there (a squash
      // merge leaves the branch's commits out), or the work got in by hand. Done at once, merged.
      const why = ahead > 0 ? await this.mergedAlready(t).catch(() => null) : null
      if (why) {
        // its words are the note the merge left, with main here being behind GitHub's said in it when it is
        const r = await this.mergedOnGitHub(t, this.proj(t), why, 20_000)
        return { state: 'merged', note: r.note ?? why }
      }
    }
    this.save()
    // told once its turn ends: an agent that merges right after never shows as waiting
    this.settleSoon(t)
    // its pull request gets the summary and is ready for review; GitHub away changes nothing here
    if (t.pr && !t.merged) this.readyForReview(t).catch(() => undefined)
    return { state: 'ready' }
  }

  /**
   * Its own work is in its base already, though not as its commits: its pull request was merged on GitHub (by hand
   * too, and a squash merge leaves the branch's commits out of the base), or the work got there some other way. What
   * it would add to the base is what decides, so a branch that only caught up with its base is never this (it has
   * nothing to merge), and neither is one with a commit after the merge. GitHub is asked for the pull request's number
   * alone, never to decide; null when this branch still has work of its own to merge.
   */
  private async mergedAlready(t: TaskRec): Promise<string | null> {
    const wt = t.worktree!
    const base = t.base!
    const p = this.proj(t)
    // the remote's base counts too: a pull request merged on GitHub is in it, and not in the local branch yet. Bounded:
    // a remote that does not answer leaves the local base to decide, never holds its agent's own ready for ever
    await G.sh(['git', 'fetch', '--quiet', 'origin', base], p.path, { timeoutMs: 20_000 }).catch(() => undefined)
    let there = false
    for (const at of [base, `origin/${base}`]) if (await G.inBase(wt, 'HEAD', at)) there = true
    if (!there) return null
    // which pull request it was: only its number, and only when GitHub answers
    const g = t.pr ? await this.hub(p).catch(() => null) : null
    const pr = g ? await this.prOf(t, g, wt).catch(() => null) : null
    const tip = (await G.git(wt, 'rev-parse', 'HEAD')).out
    return pr?.state === 'MERGED' && pr.headRefOid === tip ? `PR #${pr.number} was merged on GitHub` : `its work was in ${base} already`
  }

  private markClosed(t: TaskRec) {
    Object.assign(t, { closed: true, doneAt: Date.now(), reported: true, landing: undefined, trouble: undefined, stopped: undefined, todo: undefined, scheduled: undefined })
    clearTimeout(this.later.get(t.id))
    this.settle(t)
    this.emit('gone', t, true)
  }

  /**
   * Close a task with nothing to merge: Done with its summary (what it said when ready, else "Nothing to merge"). Its agent
   * stops and its space closes; its worktree and branch go when they hold nothing unsaved or unmerged, else they are
   * kept and said so.
   */
  async close(id: string, summary?: string, facts?: string): Promise<{ kept: string[] }> {
    const t = this.req(id)
    if (ended(t)) throw new Error(`${t.id} is Done already (${t.closed ? 'nothing to merge' : 'merged'})`)
    const key = this.key(t)
    if (this.agents.status(key) === 'working') await this.agents.interrupt(key)
    if (summary) t.said = summary
    if (facts) t.facts = facts
    this.markClosed(t)
    // putting it away closes the agent too, after looking at its work
    return { kept: (await this.cleanup(t, true))?.kept ?? [] }
  }

  /** what a task's worktree and branch hold that its base lacks, in words ("~/x (uncommitted changes)"); none: nothing is lost */
  async holds(t: TaskRec): Promise<string[]> {
    const p = this.places.space(t.project)
    if (!p) return []
    const on = t.base ?? p.base
    return this.wt.holds({ repo: p.path, wt: t.worktree, branch: t.branch, base: on, squashes: await this.squashes(t, p.path, on) })
  }

  /**
   * Pause a working task: its agent is interrupted mid-work (as Esc does; it stays alive) and the task is To do, as
   * with shepherdr todo, until something is written to it. Its work, worktree and chat stay.
   */
  async pause(id: string) {
    const t = this.req(id)
    if (this.statusOf(t) !== 'work') throw new Error(`${t.id} isn't working: only a working task is paused`)
    // To do first: the turn the interrupt ends is no question for you
    t.todo = true
    t.paused = this.agents.status(this.key(t)) === 'working' ? 'sent' : 'idle'
    clearTimeout(this.later.get(t.id))
    await this.agents.interrupt(this.key(t))
    this.settle(t)
    return t
  }

  private req(id: string) {
    const t = this.task(id)
    if (!t) throw new Error(`No task ${id}`)
    return t
  }

  /* ---------- GitHub: pull requests ---------- */

  /**
   * The project's GitHub repo when gh is logged in to its host, read live: a repo may gain its remote after it was
   * added. Each form of origin is tried (as git rewrites it, as written) for one gh is logged in to. None: the task
   * merges here. Logged in but GitHub not answering throws: that never falls back to merging here.
   */
  private async hub(p: Space): Promise<G.GitHub | null> {
    const was = p.github
    await this.places.recheckGithub(p)
    if (p.github !== was) this.emit('changed')
    let down: string | undefined
    for (const g of await G.githubs(p.path)) {
      const l = await G.ghLogin(g, p.path)
      if (l.state === 'yes') return g
      if (l.state === 'down') down ??= `${g.host}: ${l.said}`
    }
    if (down) throw new Error(`gh can't reach GitHub now (${down}). Nothing was done: try again in a while, or see gh auth status.`)
    return null
  }

  /** the pull request's words: the agent's summary, the brief's gist, and the footer its CLI signs with */
  private prBody(t: TaskRec) {
    const kind = this.agents.record(this.key(t))?.kind ?? t.agent?.kind ?? this.settings.harness('task', this.nameOf(t)).kind
    // the coordinator's words, not the default way of working Shepherdr ended the brief with
    const brief = (splitBrief(t.desc)[0] || t.title).trim()
    const gist = brief.length > 700 ? `${brief.slice(0, 700).replace(/\s+\S*$/, '')} …` : brief
    return [
      t.said || 'Work in progress: the summary comes when the task is done.',
      ...(t.facts ? [`Facts: ${t.facts}`] : []),
      `**Brief** (${t.id})\n\n${gist
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n')}`,
      SIGNED[kind] ?? `🤖 Generated with ${CLI_NAME[kind] ?? kind}`,
    ].join('\n\n')
  }

  /** its pull request as GitHub has it now: the one recorded, else the branch's own (one opened by hand) */
  private async prOf(t: TaskRec, g: G.GitHub, cwd: string) {
    const known = t.pr ? await G.viewPr(g, cwd, t.pr.number) : null
    // one closed on GitHub is no longer its pull request: the branch may have another
    const pr = known && known.state !== 'CLOSED' ? known : await G.findPr(g, cwd, t.branch!)
    if ((pr?.number ?? null) !== (t.pr?.number ?? null) && (pr || known?.state === 'CLOSED')) {
      t.pr = pr ? { number: pr.number, url: pr.url } : undefined
      this.save()
    }
    return pr
  }

  private async readyForReview(t: TaskRec, hub?: G.GitHub) {
    const p = this.proj(t)
    const g = hub ?? (await this.hub(p))
    if (!g || !t.pr) return
    await G.editPr(g, p.path, t.pr.number, this.prBody(t))
    await G.readyPr(g, p.path, t.pr.number)
  }

  /**
   * A space's merge gate (Settings → How tasks work → Merge gate, a command of its own): run in the task's worktree
   * after its rebase and before it goes into main, here. Exit 0 lets it in, with the last line it printed; anything else
   * (or GATE_TIMEOUT) refuses the merge with the end of its output, and main is untouched. Merges into one repo go one at
   * a time (merge), so the others wait while it runs; main moved meanwhile anyway (by hand, say), the branch is rebased
   * on it and the gate runs again.
   */
  private async gate(t: TaskRec, repo: string, space: string, wt: string): Promise<{ ok: true; line?: string } | { ok: false; error: string; stopped?: true }> {
    const cmd = this.gateOf(t, space)
    if (!cmd) return { ok: true }
    const tip = async () => (await G.git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${t.base}`)).out
    for (let round = 1; round <= GATE_ROUNDS; round++) {
      const at = await tip()
      const head = (await G.git(wt, 'rev-parse', 'HEAD')).out
      this.land(t, 'gate')
      const ran = await this.runGate(t, cmd, wt, head, at)
      if (ran.code === GATE_GONE) return { ok: false, error: `${t.id}'s merge gate (${cmd}) was stopped before it ended (a restart, or a kill): nothing was merged. Run shepherdr merge ${t.id} again.`, stopped: true }
      const r = { ok: ran.code === 0, code: ran.code, out: ran.out, err: '' }
      if (!r.ok) {
        const said = r.out.trim().split('\n').slice(-20).join('\n').slice(-2000)
        // its row says it until the next merge: the last line the gate printed
        const last = r.out.split('\n').filter((l) => l.trim()).at(-1)?.trim() ?? (r.code === 124 ? 'it ran out of time' : `exit ${r.code}`)
        t.mergeStop = `Refused by the gate: ${last}`
        const limit = this.gateTimeout < 60_000 ? `${Math.round(this.gateTimeout / 1000)} s` : `${Math.round(this.gateTimeout / 60_000)} min`
        const why = r.code === 124 ? `didn't finish in ${limit}` : `failed (exit ${r.code})`
        return { ok: false, error: `${t.id}'s merge gate (${cmd}) ${why}: nothing was merged, and ${t.base} is as it was.${said ? ` Its output ends:\n${said}` : ''}\n${GATE_AGAIN}` }
      }
      if ((await tip()) === at) return { ok: true, line: r.out.split('\n').filter((l) => l.trim()).at(-1)?.trim() }
      // main moved while it ran: on top of it again, and the gate once more
      const rb = await G.rebase(wt, t.base!)
      if (!rb.ok) {
        this.land(t, 'rebase')
        return { ok: false, error: `Conflict with ${t.base}, which moved while the merge gate ran: rebase ${t.branch} on ${t.base} by hand, commit, then run shepherdr merge ${t.id} again.` }
      }
    }
    return { ok: false, error: `${t.base} kept moving while ${t.id}'s merge gate ran (${GATE_ROUNDS} times): nothing was merged. Run shepherdr merge ${t.id} again.` }
  }

  /**
   * One run of the gate in `wt` at `head`, on the base at `at`: this very commit's run on the base as it is, still going
   * (or done) since Shepherdr restarted, when there is one, not a second beside it; else a new one, detached (startGate).
   */
  private async runGate(t: TaskRec, cmd: string, wt: string, head: string, at: string): Promise<{ code: number; out: string }> {
    const env = { SHEPHERDR_TASK: t.id, SHEPHERDR_BASE: t.base! }
    if (BOX) {
      // a worker machine runs it over its own link, as every command there: it ends with Shepherdr as before
      const r = await G.sh(['/bin/sh', '-c', cmd], wt, { timeoutMs: this.gateTimeout, env })
      return { code: r.code, out: [r.out, r.err].filter(Boolean).join('\n') }
    }
    const g = t.gateRun
    const run = g && g.head === head && g.tip === at && (fs.existsSync(g.exit) || alive(g.pid)) ? g : startGate(cmd, wt, env, join(home(), 'gates'), t.id, { head, tip: at })
    // an earlier run this one does not pick up is thrown away: its files go, its process is left to end
    if (g && g !== run) dropGate(g)
    t.gateRun = run
    this.save()
    const ran = await waitGate(run, this.gateTimeout)
    t.gateRun = undefined
    this.save()
    forgetGate(run)
    return ran
  }

  /**
   * The merges in line behind `t` in its repo (queued for a merge into its base, reported, with a branch), in line order:
   * those a train with `t` may take (riders), and every one of them with `why` set when it may not (another merge gate, marked
   * alone, its agent at work, a message it hasn't read). Its own turn decides what an agent still at work, or a message it
   * hasn't read, changes.
   */
  private trainLine(t: TaskRec, p: Space, cmd: string) {
    const inLine = this.tasks
      .filter((x) => x !== t && x.landing?.step === 'queue' && this.landings.has(x.id) && !ended(x) && x.project === t.project && x.base === t.base && !!x.worktree && !!x.branch)
      .sort((a, b) => a.landing!.at - b.landing!.at)
      .map((x) => ({ t: x, why: this.trainBlock(x, p, cmd) }))
    return { riders: inLine.filter((e) => !e.why).map((e) => e.t), inLine }
  }

  /** why a merge in line can't ride a train of gate `cmd` (its gate, its mark, its agent, a message it hasn't read), or nothing */
  private trainBlock(x: TaskRec, p: Space, cmd: string): string | undefined {
    if (this.gateOf(x, p.name) !== cmd) return `${x.id} has a different merge gate`
    if (x.alone) return `${x.id} is marked alone (its turn after a refused train)`
    if (this.agents.status(this.key(x)) === 'working') return `${x.id}'s agent is working`
    if (this.chats.unseen(this.key(x)).length) return `${x.id} has a message it hasn't read`
    return undefined
  }

  /** how many merges a space's train takes at most (merge.train): 1 while it is off */
  private trainSize(space: string) {
    const n = Number(this.settings.get('merge.train', space).trim())
    return Number.isInteger(n) && n >= 2 ? Math.min(n, TRAIN_MAX) : 1
  }

  /**
   * A merge train (merge.train): with a merge gate and others in line behind `t` in its repo, the first of them, in line
   * order, go in with it on one gate run. Their changes are stacked on main as the squash commits they would each be
   * (built by git, no checkout touched), the gate runs once in t's worktree at the top of the stack, its branch as it was
   * after, and on exit 0 each goes in as its own commit carrying the gate's line. One that doesn't stack cleanly on those
   * before it, or adds nothing to them, stays in line for its own turn. A refusal, or main moving meanwhile, leaves them
   * all in line and t goes on alone (nothing returned): one at a time, as without a train.
   */
  private async train(t: TaskRec, p: Space, wt: string): Promise<{ ok: boolean; error?: string; note?: string } | undefined> {
    const cmd = this.gateOf(t, p.name)
    const k = this.trainSize(p.name)
    if (k < 2 || !cmd || BOX) return undefined
    // a task a refused train took in goes alone first (alone): it rides none until then, and heads none
    if (t.alone) {
      trainLog(`${t.id}'s merge goes alone (its turn alone after a refused train)`)
      return undefined
    }
    const { riders, inLine } = this.trainLine(t, p, cmd)
    // why each merge in line that does not ride is left out, in line order: the reason it had on the way in (its gate,
    // its mark, its agent), or the one stacking gave it (a conflict, nothing new, a full train); the head's too, when its
    // change does not stack on main
    const why = new Map<TaskRec, string>(inLine.flatMap((e) => (e.why ? [[e.t, e.why] as const] : [])))
    const leftOut = () => [t, ...inLine.map((e) => e.t)].flatMap((x) => (why.has(x) ? [why.get(x)!] : []))
    if (!riders.length) {
      // nothing else in line: a quiet turn, nothing to explain; someone in line who can't ride is said here
      if (inLine.length) trainLog(`${t.id}'s merge goes alone: ${leftOut().join('; ')}`)
      return undefined
    }
    const at = (await G.git(p.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${t.base}`)).out
    // made the same way each time (main's tip's date): after a restart, the same stack finds its gate's run again
    const date = (await G.git(p.path, 'log', '-1', '--format=%cI', at)).out
    const cars: { t: TaskRec; tree: string }[] = []
    let top = at
    for (const [i, x] of [t, ...riders].entries()) {
      if (cars.length === k) {
        for (const r of riders.slice(i - 1)) why.set(r, `${r.id} waits (the train is full at ${k})`)
        break
      }
      if (x !== t) await G.commitAll(x.worktree!, `${x.id}: ${x.title}`)
      const merged = await G.git(p.path, 'merge-tree', '--write-tree', '--no-messages', '--name-only', top, x.branch!)
      const tree = merged.out.split('\n')[0]
      // the head stacks on main, every other on those before it
      const before = i ? 'those before it' : 'main'
      if (!merged.ok) {
        const files = G.conflictedPaths(merged.out)
        why.set(x, `${x.id} conflicts with ${before}${files.length ? ` (${pathList(files)})` : ''}`)
        continue
      }
      if (tree === (await G.git(p.path, 'rev-parse', `${top}^{tree}`)).out) {
        why.set(x, `${x.id} adds nothing to ${before}`)
        continue
      }
      const c = await G.sh(['git', 'commit-tree', tree, '-p', top, '-m', `${x.id}: ${x.title}`], p.path, { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
      cars.push({ t: x, tree })
      top = c.out
    }
    if (cars.length < 2 || cars[0].t !== t) {
      trainLog(`${t.id}'s merge goes alone: ${leftOut().join('; ')}`)
      return undefined
    }
    const names = cars.map((c) => c.t.id)
    const riding = cars.slice(1).map((c) => c.t)
    trainLog(`${t.id}'s merge train: ${names.join(', ')} (one gate run on ${top.slice(0, 7)}, main at ${at.slice(0, 7)})${leftOut().length ? `. Left out: ${leftOut().join('; ')}` : ''}`)
    for (const x of riding) x.landing = { ...x.landing!, train: t.id }
    this.save()
    riding.forEach((x) => this.settle(x))
    // the gate, once, in t's worktree at the top of the stack; its branch is back as it was after
    let ran: { code: number; out: string } | undefined
    if ((await G.git(wt, 'checkout', '--quiet', '--detach', top)).ok) {
      this.land(t, 'gate', undefined, { cars: cars.length })
      try {
        ran = await this.runGate(t, cmd, wt, top, at)
      } finally {
        await G.git(wt, 'checkout', '--quiet', t.branch!)
      }
    }
    // on main as the gate saw it: each its own commit, with the gate's line and who went in together
    const last = ran?.out.split('\n').filter((l) => l.trim()).at(-1)?.trim()
    const together = `Merge train: ${names.join(', ')} (one merge gate run)`
    const shas = ran?.code === 0 ? await G.landStack(p.path, t.base!, at, cars.map((c) => ({ tree: c.tree, message: this.mergeMessage(c.t, last, together) }))) : undefined
    if (!shas) {
      // what ends it: then each merge in it goes its own way (the head alone, the riders in line as before)
      if (!ran) trainLog(`${t.id}'s merge train: its gate could not start (checkout of ${top.slice(0, 7)} failed): ${t.id} goes alone`)
      else if (ran.code === GATE_GONE) trainLog(`${t.id}'s merge train stopped before its gate ended (a restart, or a kill): nothing went in`)
      else if (ran.code !== 0) trainLog(`${t.id}'s merge train refused (exit ${ran.code}): each goes alone once`)
      else trainLog(`${t.id}'s merge train: main moved while its gate ran: ${t.id} goes alone`)
      // a refusal by the gate marks every member, the head included: each goes alone once. A base that moved, or a gate
      // that never ran, marks none: the change did not fail
      if (ran && ran.code !== 0 && ran.code !== GATE_GONE) for (const c of cars) c.t.alone = true
      for (const x of riding) if (x.landing?.train === t.id) x.landing = { ...x.landing, train: undefined }
      this.save()
      riding.forEach((x) => this.settle(x))
      return undefined
    }
    cars.forEach((c, i) => (c.t.squash = shas[i]))
    trainLog(`${t.id}'s merge train went in: ${cars.map((c, i) => `${c.t.id} ${shas[i].slice(0, 7)}`).join(', ')}`)
    const note = await this.pushBase(p, t.base!, `it went in with ${names.slice(1).join(', ')} on one merge gate run`)
    for (const x of riding) {
      x.train = t.id
      await this.markMerged(x, `it went in with ${t.id}'s merge train`)
    }
    return this.markMerged(t, note)
  }

  /** a merge commit's words: the task and its title, what its agent said it did, its facts, then the lines after */
  private mergeMessage(t: TaskRec, ...after: (string | undefined)[]) {
    return [`${t.id}: ${t.title}`, t.said, t.facts && `Facts: ${t.facts}`, ...after].filter(Boolean).join('\n\n')
  }

  /** a GitHub remote gh can't use (not logged in): main is pushed as it is here, and the note says how that went */
  private async pushBase(p: Space, base: string, note?: string) {
    if (!p.github) return note
    const push = await G.git(p.path, 'push', '--quiet', 'origin', base)
    const pushed = push.ok ? `pushed ${base} to GitHub` : `could not push ${base} to GitHub: ${push.err.split('\n')[0]}`
    return note ? `${note}; ${pushed}` : pushed
  }

  /** a task's merge gate command, its own --set first, then its space's; nothing while it is off */
  private gateOf(t: TaskRec, space = this.nameOf(t)) {
    const cmd = (t.set?.['merge.gate'] ?? this.settings.get('merge.gate', space)).trim()
    return cmd && cmd.toLowerCase() !== 'off' ? cmd : undefined
  }

  /** how long a merge gate may run: GATE_TIMEOUT, shorter in a test */
  gateTimeout = GATE_TIMEOUT

  /** push the task's branch as it is committed, to GitHub: forced, since it is rebased on main and only its agent's */
  private async push(t: TaskRec) {
    const sha = (await G.git(t.worktree!, 'rev-parse', 'HEAD')).out
    const r = await G.git(t.worktree!, 'push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${t.branch}`)
    if (r.ok) {
      t.pushed = { sha, at: Date.now() }
      this.save()
    }
    return r
  }

  /** a GitHub step that could not reach GitHub says so, and did nothing */
  private async onGitHub<T extends { ok: boolean }>(f: () => Promise<T>, failed: (why: string) => T): Promise<T> {
    try {
      return await f()
    } catch (e) {
      return failed((e as Error).message)
    }
  }

  /**
   * shepherdr pr: push the branch and open its pull request (a draft until the agent reports done), or bring the open
   * one up to the branch. Its title is the task's, its words the summary and the brief's gist.
   */
  openPr(id: string): Promise<{ ok: boolean; text: string }> {
    return this.onGitHub(() => this.openPrNow(this.req(id)), (text) => ({ ok: false, text }))
  }

  private async openPrNow(t: TaskRec): Promise<{ ok: boolean; text: string }> {
    if (ended(t)) return { ok: false, text: `${t.id} is Done already (${t.closed ? 'nothing to merge' : 'merged'}).` }
    if (!t.worktree || !t.branch || !t.base) return { ok: false, text: `${t.id} has no branch yet.` }
    const p = this.proj(t)
    const g = await this.hub(p)
    if (!g) return { ok: true, text: `No pull request: ${this.places.shownName(p.name)} has no GitHub remote, or gh isn't logged in to it (gh auth status). shepherdr merge ${t.id} squash-merges it here.` }
    if ((await G.aheadCount(t.worktree, t.base)) === 0) return { ok: false, text: `${t.id} has no commits yet: commit your work, then run shepherdr pr ${t.id} again.` }
    const dirty = await G.dirty(t.worktree)
    const pushed = await this.push(t)
    if (!pushed.ok) return { ok: false, text: `Could not push ${t.branch} to GitHub: ${(pushed.err || pushed.out).split('\n')[0]}` }
    let pr = await this.prOf(t, g, t.worktree)
    if (pr && pr.baseRefName !== t.base) return { ok: false, text: `PR #${pr.number} targets ${pr.baseRefName}, but ${t.id} targets ${t.base}. Correct the pull request target on GitHub first.` }
    let opened = false
    if (pr?.state === 'MERGED') return { ok: false, text: `PR #${pr.number} is merged on GitHub already: run shepherdr merge ${t.id} to mark it merged and clean up.` }
    if (!pr) {
      const o = await G.openPr(g, t.worktree, { branch: t.branch, base: t.base, title: t.title, body: this.prBody(t), draft: !t.reported })
      if ('error' in o) return { ok: false, text: `Pushed ${t.branch}, but GitHub did not open a pull request: ${o.error}` }
      t.pr = { number: o.number, url: o.url }
      this.save()
      opened = true
    } else if (t.reported) await this.readyForReview(t, g)
    const head = (await G.git(t.worktree, 'rev-parse', '--short', 'HEAD')).out
    return {
      ok: true,
      text: `${opened ? `Opened PR #${t.pr!.number}${t.reported ? '' : ' as a draft'}` : `Pushed to PR #${t.pr!.number}`} at ${head}: ${t.pr!.url}${dirty ? '\nUncommitted changes are not in it: commit them and run shepherdr pr again.' : ''}\n${(t.waitChecks ?? this.settings.ways(p.name).waitChecks) ? `Next: shepherdr checks ${t.id} waits for GitHub's checks (run it with a long timeout, up to 10 minutes).` : `Merging doesn't wait for GitHub's checks (shepherdr checks ${t.id} waits for any that run on it, if you want to see them).`}`,
    }
  }

  /**
   * GitHub's checks on the task's pull request, waited for while they run (up to `waitMs`). A commit Shepherdr just
   * pushed, in a repo with workflows that run on pull requests, shows none for a moment: that moment is waited out, never taken as passed (after
   * it, none is none: the repo's workflows may not run on pull requests). GitHub not answering three times running
   * is said, not waited on.
   */
  private async checksOf(t: TaskRec, g: G.GitHub, n: number, waitMs: number): Promise<G.PrChecks> {
    const t0 = Date.now()
    const head = (await G.git(t.worktree!, 'rev-parse', 'HEAD')).out
    const expect = await G.hasPrWorkflows(t.worktree!)
    let errors = 0
    for (;;) {
      const c = await G.prChecks(g, t.worktree!, n)
      errors = c.state === 'error' ? errors + 1 : 0
      const early = c.state === 'none' && expect && t.pushed?.sha === head && Date.now() - t.pushed.at < CHECKS_SHOW
      if ((c.state !== 'pending' && c.state !== 'error' && !early) || errors >= 3) return c
      if (Date.now() - t0 + CHECKS_EVERY > waitMs) return early ? { ...c, state: 'pending' } : c
      await Bun.sleep(CHECKS_EVERY)
    }
  }

  /** a ready task's next step into main (Merging), or none: Ready again, or back at work */
  private land(t: TaskRec, step?: Landing['step'], due?: number, more?: Partial<Landing>) {
    if (!t.reported || ended(t)) return
    t.landing = step ? { step, at: Date.now(), due, ...more } : undefined
    this.save()
    this.settle(t)
  }

  /** when GitHub's checks at `head` should be through: from when it was pushed, as long as they took lately */
  private async checksDue(t: TaskRec, p: Space, g: G.GitHub, head: string) {
    let took = this.took.get(p.path)
    if (!took || Date.now() - took.at > 30 * 60_000) {
      took = { ms: await G.checksTook(g, p.path).catch(() => undefined), at: Date.now() }
      this.took.set(p.path, took)
    }
    if (took.ms === undefined) return undefined
    return (t.pushed?.sha === head ? t.pushed.at : Date.now()) + took.ms
  }

  /** which of GitHub's checks failed, and where to see why */
  private checksFailed(n: number, c: G.PrChecks) {
    const link = c.failed.find((f) => f.link)?.link
    return `GitHub's checks failed on PR #${n}: ${c.failed.map((f) => f.name).join(', ')}.${link ? ` See ${link} (gh run view --log-failed shows why).` : ''}`
  }

  private fixIt = (t: TaskRec) => `Fix it, commit, push with shepherdr pr ${t.id}, wait with shepherdr checks ${t.id}, then run shepherdr merge ${t.id} again.`

  /** shepherdr checks: wait for GitHub's checks on the task's pull request, at the commit this machine has */
  checks(id: string, waitMs = CHECKS_WAIT): Promise<{ ok: boolean; text: string }> {
    return this.onGitHub(() => this.checksNow(this.req(id), waitMs), (text) => ({ ok: false, text }))
  }

  private async checksNow(t: TaskRec, waitMs: number): Promise<{ ok: boolean; text: string }> {
    if (!t.worktree || !t.branch) return { ok: false, text: `${t.id} has no branch yet.` }
    const p = this.proj(t)
    const g = await this.hub(p)
    if (!g) return { ok: true, text: `No GitHub checks: ${this.places.shownName(p.name)} has no GitHub remote, or gh isn't logged in to it. Run the project's own checks here.` }
    const pr = await this.prOf(t, g, t.worktree)
    if (!pr) return { ok: false, text: `${t.id} has no pull request yet: shepherdr pr ${t.id} pushes the branch and opens one.` }
    const head = (await G.git(t.worktree, 'rev-parse', 'HEAD')).out
    if (pr.headRefOid !== head) return { ok: false, text: `PR #${pr.number} is not at your commit (${head.slice(0, 7)}): push it with shepherdr pr ${t.id} first.` }
    // on its way into main (a merge waits for them): the row says they run, then what comes next
    if (t.landing) this.land(t, 'checks', await this.checksDue(t, p, g, head))
    const c = await this.checksOf(t, g, pr.number, waitMs)
    if (t.landing && c.state !== 'pending') this.land(t, c.state === 'pass' || c.state === 'none' ? 'merge' : undefined)
    if (c.state === 'fail') {
      this.toldFailed(t, head, c)
      return { ok: false, text: `${this.checksFailed(pr.number, c)} ${this.fixIt(t)}` }
    }
    if (c.state === 'pending') return { ok: false, text: `GitHub's checks still run on PR #${pr.number}: run shepherdr checks ${t.id} again.` }
    if (c.state === 'error') return { ok: false, text: `Could not read GitHub's checks on PR #${pr.number}: ${c.error}` }
    return { ok: true, text: c.state === 'none' ? `PR #${pr.number} has no checks on GitHub: nothing to wait for.` : `GitHub's checks passed on PR #${pr.number} (${c.passed}).` }
  }

  /**
   * News on done tasks' pull requests: checks that failed, and what someone wrote on it (a review, a comment) since its
   * agent reported done. Its agent hears each once, in <shepherdr> tags, which wakes it; what to do about it is its own
   * call (the shepherdr-agent skill). Only an agent at rest is told: one at work, or at a prompt, hears it next time.
   * A pull request merged on GitHub by hand ends the task here (Done, merged), whatever its checks say.
   */
  async watchPrs() {
    if (this.watching) return
    this.watching = true
    try {
      const hubs = new Map<string, G.GitHub | null>()
      for (const t of this.tasks.filter((t) => t.reported && t.pr && t.worktree && !ended(t) && !t.archived && !t.stopped)) {
        if (['working', 'blocked'].includes(this.agents.status(this.key(t)))) continue
        const p = this.places.space(t.project)
        if (!p || !existsSync(t.worktree!)) continue
        if (!hubs.has(p.path)) hubs.set(p.path, await this.hub(p).catch(() => null))
        const g = hubs.get(p.path)
        if (g) await this.watchPr(t, g).catch(() => undefined)
      }
    } finally {
      this.watching = false
    }
  }

  private async watchPr(t: TaskRec, g: G.GitHub) {
    const pr = await this.prOf(t, g, t.worktree!)
    // merged on GitHub by hand (a squash merge leaves its commits out of the base): Done as ready would, and no turn of
    // its own to be cut: a task on its way in (Merging) is its merge's own to mark
    if (pr?.state === 'MERGED') {
      if (t.landing) return
      const why = await this.mergedAlready(t).catch(() => null)
      if (why) await this.mergedOnGitHub(t, this.proj(t), why, 20_000).catch(() => undefined)
      return
    }
    if (pr?.state !== 'OPEN') return
    const w = (t.watch ??= { since: ghNow() })
    const news: string[] = []
    const what: string[] = []
    const c = await G.prChecks(g, t.worktree!, pr.number)
    const failed = c.state === 'fail' ? failKey(pr.headRefOid, c) : c.state === 'pass' ? undefined : w.failed
    if (c.state === 'fail' && failed !== w.failed) {
      for (const f of c.failed) {
        const log = f.link ? await G.failedLog(g, t.worktree!, f.link) : undefined
        news.push(`- Check failed: ${f.name}${f.link ? ` (${f.link})` : ''}${log ? `. Its log ends:\n${quote(log)}` : ''}`)
      }
      what.push(`${c.failed.map((f) => f.name).join(', ')} failed`)
    }
    const all = await G.prComments(g, t.worktree!, pr.number)
    const seen = new Set(w.seen)
    // an approval or a review with no words of its own (it only carries its line comments) is no news
    const fresh = (all ?? []).filter((x) => !seen.has(x.id) && x.at >= w.since && (x.body || x.state === 'CHANGES_REQUESTED'))
    for (const x of fresh)
      news.push(`- ${x.state ? (COMMENT[x.state] ?? 'Review') : 'Comment'} by ${x.who}${x.where ? ` on ${x.where}` : ''} (${x.url}):\n${quote(x.body || '(no words)')}`)
    if (fresh.length) what.push(fresh.length === 1 ? 'a new comment' : `${fresh.length} new comments`)
    // put to work, or at a prompt, while GitHub was asked: it hears all this next time
    if (news.length && ['working', 'blocked'].includes(this.agents.status(this.key(t)))) return
    w.failed = failed
    if (all) w.seen = all.map((x) => x.id)
    this.save()
    if (!news.length) return this.nudgeToMerge(t, pr.number, c)
    const id = `pr:${t.id}:${Date.now()}`
    this.chats.post(this.key(t), { id, card: { id, task: t.id, status: 'work', text: `woken: ${what.join(' and ')} on PR #${pr.number}`, pr: t.pr } })
    await this.sendBack(t, hidden(prNewsLine(t.id, t.pr!, news), 'github', { task: t.id, pr: String(t.pr!.number) }))
  }

  /**
   * On its way into main, its agent at rest with nothing left running to wake it, and GitHub's checks through: it is
   * told once to merge, so it never shows Merging while nothing happens.
   */
  private async nudgeToMerge(t: TaskRec, n: number, c: G.PrChecks) {
    const key = this.key(t)
    if (!t.landing || t.landing.nudged || (c.state !== 'pass' && c.state !== 'none') || this.agents.background(key)) return
    t.landing.nudged = true
    this.save()
    const text = `GitHub's checks passed on PR #${n}: merge ${t.id} now (shepherdr merge ${t.id}), as your brief says.`
    await this.agents.send(key, hidden(text, 'github', { task: t.id, pr: String(n) }), { ensure: this.starter(t) }).catch(() => undefined)
  }

  /**
   * GitHub's checks on main after merges, which a task merges without waiting for (Settings), or that merged cleanly
   * but clash: once a run on main fails, its coordinator hears it once, with the run and the tasks merged since main
   * was last green. What follows (a fix task) is its call. Looked at while a task merged through its pull request
   * lately, or main is red, until it is green again.
   */
  async watchMains() {
    if (this.watchingMain) return
    this.watchingMain = true
    try {
      for (const p of this.places.spaces) await this.watchMain(p).catch(() => undefined)
    } finally {
      this.watchingMain = false
    }
  }

  private async watchMain(p: Space) {
    const red = this.data.red?.[p.path]
    const lately = Date.now() - MAIN_WATCH
    if (!red && !this.tasks.some((t) => t.merged && t.pr && (t.doneAt ?? 0) > lately && this.places.space(t.project) === p)) return
    const g = await this.hub(p).catch(() => null)
    const runs = g && (await G.branchRuns(g, p.path, p.base))
    // the newest commit on main its runs have a verdict on
    const i = runs ? runs.findIndex((r) => r.state !== 'pending') : -1
    if (!g || !runs || i < 0) return
    const now = runs[i]
    if (now.state === 'pass') {
      if (red) delete this.data.red![p.path]
      if (red) this.save()
      return
    }
    // told once while it stays red, whatever else merges meanwhile
    if (red) return
    ;(this.data.red ??= {})[p.path] = now.sha
    this.save()
    const green = runs.slice(i + 1).find((r) => r.state === 'pass')?.sha
    await G.git(p.path, 'fetch', '--quiet', 'origin', p.base)
    const log = await G.git(p.path, 'log', '--format=%s', '-n', '20', green ? `${green}..${now.sha}` : `${now.sha}^!`)
    const merged = log.ok ? log.out.split('\n').filter(Boolean) : []
    const f = now.failed[0]
    const tail = await G.failedLog(g, p.path, f.link)
    const ids = merged.map((m) => m.match(/^([A-Z][A-Z0-9]*-\d+):/)?.[1]).filter((x): x is string => !!x)
    this.emit(
      'news',
      placeId.space(p.name),
      [
        `${p.base} went red on GitHub at ${now.sha.slice(0, 7)}: ${now.failed.map((x) => `${x.name} failed (${x.link})`).join(', ')}.`,
        `Merged since it was last green${green ? ` (${green.slice(0, 7)})` : ''}: ${merged.length ? merged.join('; ') : 'none Shepherdr can tell'}.`,
        tail ? `Its log ends:\n${quote(tail)}` : '',
        'A fix-forward task follows if you decide so: its brief names the failing run and these merges',
      ].filter(Boolean).join('\n'),
      'red',
      { task: ids[0] ?? '', event: 'main-red' },
      { red: p.base, text: `went red: ${now.failed.map((x) => x.name).join(', ')} failed` },
    )
  }

  /** checks that failed at a commit were told to the agent (shepherdr checks, merge): watching won't tell it again */
  private toldFailed(t: TaskRec, head: string, c: G.PrChecks) {
    t.watch = { ...t.watch, since: t.watch?.since ?? ghNow(), failed: failKey(head, c) }
    this.save()
  }

  /* ---------- merging ---------- */

  /**
   * Rebase the task's branch on main, squash-merge it into main and mark it merged: through its pull request on a
   * GitHub repo gh is logged in to, else here. Its agent and worktree are put away once the agent's turn ends (it may
   * be the one asking). A conflict or failed checks stop it with what to do. Anyone but the task's own agent waits
   * until that agent's turn has ended, so no half-done work goes in.
   */
  merge(id: string, opts: { self?: boolean } = {}): Promise<{ ok: boolean; error?: string; note?: string }> {
    const t = this.req(id)
    if (this.closing) return Promise.resolve({ ok: false, error: `Shepherdr is restarting: nothing was merged. Run shepherdr merge ${t.id} again in a minute.` })
    // asked again while its merge still runs: the same one is waited for, never a second beside it
    let run = this.landings.get(t.id)
    // its own agent asking to merge says its work is ready, as shepherdr done does: one written to since it reported (a
    // coordinator's "rebase on main and merge") is on its way into main, and its row, its place in line and a restart
    // say so; never Needs you while its agent waits, as told, for how it went
    if (!run && opts.self && !t.reported && !ended(t)) {
      t.reported = true
      this.save()
    }
    if (!run) {
      const repo = this.places.space(t.project)?.path ?? ''
      // in line behind another merge into its repo: its row says whose, and whether that one runs the gate
      const ahead = this.mergingNow.get(repo)
      if (ahead && ahead !== t.id && t.reported && !ended(t)) {
        t.landing = { step: 'queue', at: Date.now(), behind: ahead, gate: this.gateOf(t) !== undefined }
        this.save()
        this.settle(t)
      }
      const now = (this.merging.get(repo) ?? Promise.resolve())
        .then(() => {
          this.mergingNow.set(repo, t.id)
          this.inLineBehind(repo, t)
          return this.onGitHub(() => this.mergeNow(t, !!opts.self), (error) => ({ ok: false, error: `Can't merge ${t.id}: ${error}` }))
        })
        .finally(() => this.mergingNow.get(repo) === t.id && this.mergingNow.delete(repo))
        // stopped short with nothing more to wait for (failed checks, GitHub refused): Ready again, or back at work
        .then((r) => (!r.ok && (t.landing?.step === 'merge' || t.landing?.step === 'gate' || t.landing?.step === 'queue') && this.land(t), r))
        // its caller heard by the deadline that it goes on: its agent hears now how it went, and wakes on it
        .then((r) => (this.lateFor.delete(t.id) && this.tellMerge(t, r), r))
      run = now
      this.landings.set(t.id, now)
      const tail = now.catch(() => undefined)
      tail.then(() => this.landings.get(t.id) === now && this.landings.delete(t.id))
      // the next merge into this repo waits until this one is really through, however long: two at once would write
      // over each other's main. Its caller still hears by the deadline
      this.merging.set(repo, tail)
      tail.then(() => this.merging.get(repo) === tail && this.merging.delete(repo))
    }
    // its caller hears by the deadline, whatever hangs on the way (git, gh, GitHub): never a command that waits on and
    // on until the agent's shell moves it to the background, where its answer is lost. The merge itself goes on.
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<{ ok: boolean; error: string }>((done) => {
      timer = setTimeout(() => {
        this.lateFor.add(t.id)
        const l = t.landing
        const where = l?.step === 'queue' && l.train ? `goes in with ${l.train}'s merge train (its gate runs)` : l?.step === 'queue' ? `waits in line behind ${l.behind}'s${l.gate ? ' (one merge gate at a time)' : ''}` : l?.step === 'gate' ? 'is in its gate: its merge gate still runs' : `isn't through after ${Math.round(this.mergeDeadline / 1000)} s (git or GitHub is slow)`
        done({ ok: false, error: `${t.id}'s merge ${where}. Shepherdr goes on with it and tells you here how it went (merged, or what stopped it): end your turn now, without polling or sleeping. A shepherdr merge ${t.id} meanwhile only waits for this one.` })
      }, this.mergeDeadline)
    })
    return Promise.race([run, late]).finally(() => clearTimeout(timer))
  }

  /** `t`'s merge into `repo` takes its turn: each merge still in line there now waits behind it, and its row says so */
  private inLineBehind(repo: string, t: TaskRec) {
    let moved = false
    for (const x of this.tasks) {
      if (x === t || x.landing?.step !== 'queue' || x.landing.behind === t.id || (this.places.space(x.project)?.path ?? '') !== repo) continue
      x.landing = { ...x.landing, behind: t.id }
      this.settle(x)
      moved = true
    }
    if (moved) this.save()
  }

  /**
   * Shepherdr stops (an update restarts it, as one right after a merge into its own repo does): the merges on their
   * way finish first, at most their deadline, so none is cut halfway (merged on GitHub, never marked, its agent never
   * told) and each caller gets its answer. No new one starts meanwhile. True when there was one to wait for.
   */
  async drain(): Promise<boolean> {
    this.closing = true
    const on = [...this.landings.values()]
    if (!on.length) return false
    await Promise.race([Promise.allSettled(on), Bun.sleep(this.mergeDeadline)])
    return true
  }

  private async mergeNow(t: TaskRec, self: boolean): Promise<{ ok: boolean; error?: string; note?: string }> {
    // one a merge train took along went in on that train's gate: its own turn only says so
    if (t.merged) return t.train ? { ok: true, note: `it went in with ${t.train}'s merge train` } : { ok: false, error: `${t.id} is already merged` }
    if (t.closed) return { ok: false, error: `${t.id} is Done: it had nothing to merge` }
    if (!t.worktree || !t.branch || !t.base) return { ok: false, error: `${t.id} has no branch yet` }
    if (!self && this.agents.status(this.key(t)) === 'working') return { ok: false, error: `${t.id}'s agent is working: wait for its turn to end, or ask it to merge (shepherdr task tell ${t.id} "merge it").` }
    // a late note from you or a coordinator, not read yet, may change what goes in
    if (this.chats.unseen(this.key(t)).length)
      return { ok: false, error: self ? 'You have a new message in your chat: read and handle it, then merge again.' : `${t.id}'s agent has a new message it hasn't read yet: let it handle that first.` }
    // asked by you or a coordinator, with its agent at rest: going in, it is on its way into main as one reported is
    if (!t.reported) t.reported = true
    this.land(t, 'merge')
    t.mergeStop = undefined
    const p = this.proj(t)
    const wt = t.worktree
    // main here first catches up with the remote's, so the branch is rebased on what main really is
    const up = await G.catchUp(p.path, t.base)
    if (!up.ok) return { ok: false, error: `Can't merge ${t.id}: ${up.err}` }
    // a train's gate left it at the top of its stack (Shepherdr stopped while it ran): back on its branch first
    if (!(await G.git(wt, 'branch', '--show-current')).out) await G.git(wt, 'checkout', '--quiet', t.branch)
    await G.commitAll(wt, `${t.id}: ${t.title}`)
    const g = await this.hub(p)
    if (g) return this.mergeOnGitHub(t, p, g, self)
    // its pull request is open, but gh can't use GitHub here now: it is never merged around it
    if (t.pr) return { ok: false, error: `Can't merge ${t.id}: its PR #${t.pr.number} is on GitHub, but gh isn't signed in to it here (gh auth login), so nothing was merged.` }
    // nothing ahead of main and no work ever made here; work merged by a merge commit (a pull request) is behind it too
    if ((await G.aheadCount(wt, t.base)) === 0 && !(await G.workedOn(wt, t.branch))) return { ok: false, error: `${t.id} has no changes to merge` }
    let note: string | undefined
    // merged already, by hand or as its pull request on GitHub (squashed, or with a merge commit), even with main
    // moved on since: it only needs marking
    if (await G.landed(wt, 'HEAD', t.base)) note = `it was in ${t.base} already`
    else {
      const rb = await G.rebase(wt, t.base)
      if (!rb.ok) {
        this.land(t, 'rebase')
        return { ok: false, error: `Conflict with ${t.base}: rebase ${t.branch} on ${t.base} by hand, commit, then run shepherdr merge ${t.id} again.` }
      }
      // others in line behind it go in with it on one gate run, when its space takes merge trains
      const train = await this.train(t, p, wt)
      if (train) return train
      // the space's merge gate, on the branch as it would go in: its last line goes into the commit
      const gate = await this.gate(t, p.path, p.name, wt)
      // its turn alone is over once its gate ran to its end, however that ended: it may ride a train again
      if (t.alone && !(!gate.ok && gate.stopped)) {
        t.alone = undefined
        this.save()
      }
      if (!gate.ok) return { ok: false, error: gate.error }
      const m = await G.mergeHere(p.path, t.branch, t.base, this.mergeMessage(t, gate.line), true)
      if (!m.ok) {
        // mergeHere marks a conflict with its own prefix, so a file name (conflicts.md) is never taken for one
        const conflict = m.err.startsWith('conflict:')
        if (conflict) this.land(t, 'rebase')
        // mergeHere already says what stopped it, in words that name the file when git refused to write over one
        return { ok: false, error: conflict ? `Conflict with ${t.base}` : m.err || m.out || `${t.id}'s merge did not go through` }
      }
      t.squash = (await G.git(p.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${t.base}`)).out || undefined
    }
    return this.markMerged(t, await this.pushBase(p, t.base, note))
  }

  /**
   * Through the pull request, as herdr-projects lands one: the branch pushed as it is, rebased on GitHub's main only
   * when it conflicts with it (its pull request opened if the agent didn't), GitHub's checks passed at exactly that
   * commit, then squash-merged on GitHub only while its head is still that commit, its branch there deleted, and main here brought up to GitHub's (which
   * is what Shepherdr's own update watches). Failed checks go back to the agent.
   */
  private async mergeOnGitHub(t: TaskRec, p: Space, g: G.GitHub, self: boolean): Promise<{ ok: boolean; error?: string; note?: string }> {
    const wt = t.worktree!
    const base = `origin/${t.base}`
    if (!(await G.git(p.path, 'rev-parse', '--verify', '--quiet', base)).ok) return { ok: false, error: `GitHub has no ${t.base} yet: push it once (git push origin ${t.base}), then merge again.` }
    // main here holds commits GitHub lacks: merging on GitHub would split the two, so they go up first, by you
    const ahead = Number((await G.git(p.path, 'rev-list', '--count', `${base}..${t.base}`)).out || 0)
    if (ahead) return { ok: false, error: `${t.base} here has ${ahead} commit${ahead === 1 ? '' : 's'} GitHub lacks: push ${t.base} (git push origin ${t.base}) or move them off it, then merge ${t.id} again. Nothing was merged.` }
    let pr = await this.prOf(t, g, wt)
    if (pr && pr.baseRefName !== t.base) return { ok: false, error: `PR #${pr.number} targets ${pr.baseRefName}, but ${t.id} targets ${t.base}. Correct the pull request target on GitHub first. Nothing was merged.` }
    // merged on GitHub already (by hand, or a merge whose answer was lost): it only needs main here and marking
    if (pr?.state === 'MERGED') return this.mergedOnGitHub(t, p, `PR #${pr.number} was merged on GitHub already`)
    if ((await G.aheadCount(wt, t.base!)) === 0) return { ok: false, error: `${t.id} has no changes to merge` }
    // GitHub squash-merges a branch behind main as it is: rebasing it would make a new commit, and all its checks run
    // again (again each time main moves meanwhile). Only a real conflict is rebased here; a clash that merges cleanly
    // but breaks is caught by the checks on main.
    let rebased = false
    if (!(await G.mergesCleanly(wt, base, 'HEAD'))) {
      const rb = await G.rebase(wt, base)
      if (!rb.ok) {
        this.land(t, 'rebase')
        return { ok: false, error: `Conflict with ${t.base}: rebase ${t.branch} on ${base} by hand, commit, push with shepherdr pr ${t.id}, then run shepherdr merge ${t.id} again.` }
      }
      rebased = true
    }
    // main has this work already (merged another way): its pull request would change nothing
    if (await G.landed(wt, 'HEAD', base)) {
      // closed, with its branch there
      const closed = pr ? (await G.closePr(g, wt, pr.number, `Closed by Shepherdr: ${t.base} has this work already.`)).ok : false
      if (closed) await G.git(p.path, 'push', '--quiet', 'origin', '--delete', t.branch!)
      return this.mergedOnGitHub(t, p, `it was in ${t.base} already${pr ? (closed ? `; closed PR #${pr.number}` : `; could not close PR #${pr.number}: close it on GitHub`) : ''}`)
    }
    const head = (await G.git(wt, 'rev-parse', 'HEAD')).out
    const pushing = !pr || pr.headRefOid !== head
    if (pushing) {
      const push = await this.push(t)
      if (!push.ok) return { ok: false, error: `Could not push ${t.branch} to GitHub: ${(push.err || push.out).split('\n')[0]}` }
    }
    if (!pr) {
      const o = await G.openPr(g, wt, { branch: t.branch!, base: t.base!, title: t.title, body: this.prBody(t), draft: false })
      if ('error' in o) return { ok: false, error: `GitHub did not open a pull request for ${t.branch}: ${o.error}` }
      t.pr = { number: o.number, url: o.url }
      this.save()
    } else {
      // its words carry the summary, whether or not the agent reported done before
      if (t.said) await G.editPr(g, wt, pr.number, this.prBody(t))
      if (pr.isDraft) await G.readyPr(g, wt, pr.number)
    }
    const n = t.pr!.number
    const wait = t.waitChecks ?? this.settings.ways(p.name).waitChecks
    // not waited for (Settings): its own quick checks passed, and GitHub's run on, here and then on main
    // (watchMain); only a failure GitHub already shows at this very commit stops it
    const now = wait || pushing ? undefined : await G.prChecks(g, wt, n)
    const c = wait ? await this.checksOf(t, g, n, 0) : now?.state === 'fail' ? now : { state: 'pass' as const, passed: 0, failed: [] }
    if (c.state === 'pending') {
      this.land(t, 'checks', await this.checksDue(t, p, g, head))
      return { ok: false, error: `GitHub's checks are running on PR #${n}${pushing ? ` (just pushed${rebased ? `, rebased on ${t.base} for a conflict` : ''})` : ''}: wait for them with shepherdr checks ${t.id}, then run shepherdr merge ${t.id} again.` }
    }
    if (c.state === 'error') return { ok: false, error: `Could not read GitHub's checks on PR #${n}: ${c.error}. Nothing was merged.` }
    if (c.state === 'fail') {
      const why = this.checksFailed(n, c)
      if (self) {
        this.toldFailed(t, head, c)
        return { ok: false, error: `${why} ${this.fixIt(t)}` }
      }
      this.toldFailed(t, head, c)
      await this.sendBack(t, `${why} ${this.fixIt(t)}`)
      return { ok: false, error: `${why} Sent back to ${t.id}'s agent to fix.` }
    }
    const m = await G.mergePr(g, wt, n, head, `${t.id}: ${t.title} (#${n})`, [t.said, t.facts && `Facts: ${t.facts}`].filter(Boolean).join('\n\n'))
    if ((await G.viewPr(g, wt, n))?.state !== 'MERGED') {
      const said = (m.err || m.out || 'it did not say why').split('\n')[0]
      // main moved on GitHub since it was fetched: merging again rebases it if it now conflicts (Merging meanwhile)
      if (/conflict|not mergeable/i.test(said)) this.land(t, 'rebase')
      return { ok: false, error: /conflict|not mergeable/i.test(said) ? `Conflict with ${t.base} on GitHub: run shepherdr merge ${t.id} again, which rebases ${t.branch} on ${base} (or rebase it by hand, push with shepherdr pr ${t.id}, then merge again).` : `GitHub did not merge PR #${n}: ${said}` }
    }
    await G.git(p.path, 'push', '--quiet', 'origin', '--delete', t.branch!)
    return this.mergedOnGitHub(t, p, `merged PR #${n} on GitHub${wait ? '' : ', not waiting for its checks'}`)
  }

  /**
   * main here comes up to GitHub's, so the merge is here too (and Shepherdr's own update sees it), then it is marked.
   * `fetchMs` bounds the catch-up's fetch: `ready` and the watch call this with no deadline of their own around it, so
   * a remote that does not answer leaves main here as it is, said in the note, rather than holding them. The merge
   * path passes none: its own caller races a deadline of its own.
   */
  private async mergedOnGitHub(t: TaskRec, p: Space, note: string, fetchMs?: number) {
    const up = await G.catchUp(p.path, t.base!, `then run git pull in ${t.base} here`, fetchMs)
    const stale = !up.ok ? up.err : up.err ? `${t.base} here was not brought up to GitHub's: ${up.err}` : undefined
    return this.markMerged(t, stale ? `${note}; ${stale}` : note)
  }

  private async markMerged(t: TaskRec, note?: string) {
    t.merged = true
    t.doneAt = Date.now()
    t.reported = true
    t.landing = undefined
    t.trouble = undefined
    t.stopped = undefined
    this.settle(t)
    this.emit('gone', t, true)
    if (this.agents.status(this.key(t)) !== 'working') await this.cleanup(t)
    return { ok: true, note }
  }

  /** what its agent must fix, written to it: it is at work again */
  private async sendBack(t: TaskRec, text: string) {
    await this.agents.send(this.key(t), text, { ensure: () => this.launch(t) }).catch(() => undefined)
    this.youWrote(this.key(t))
  }

  /**
   * Put a finished task's place away: agent, space, worktree and branch, keeping whatever holds unsaved or unmerged
   * work (said in news, and in shepherdr status). Marked cleaned only once done, so one cut short (a restart) or put
   * off (something still runs in its space) is tried again.
   */
  private async cleanup(t: TaskRec, quiet = false) {
    const p = this.places.space(t.project)
    if (!p || this.cleaning.has(t.id)) return
    this.cleaning.add(t.id)
    try {
      const r = await this.putAway(t, p.path, p.base)
      if (r.busy) return r
      const news = r.kept.length && JSON.stringify(r.kept) !== JSON.stringify(t.kept)
      t.kept = r.kept.length ? r.kept : undefined
      t.cleaned = true
      this.save()
      if (news && !quiet) this.emit('news', t.project, `${t.id} ${t.closed ? 'is done, nothing to merge' : 'was merged'}; kept ${r.kept.join(', ')}`, 'done', { task: t.id, event: t.closed ? 'closed' : 'merged' })
      return r
    } finally {
      this.cleaning.delete(t.id)
    }
  }

  /** a merged task's branch is checked against its squash merge: the one recorded, else (merged before one was) the
   *  commits its subject names */
  private async putAway(t: TaskRec, repo: string, base: string) {
    const key = this.key(t)
    const on = t.base ?? base
    return this.wt.putAway({ repo, wt: t.worktree, branch: t.branch, base: on, squashes: await this.squashes(t, repo, on), label: labelOf(t), agentPane: this.agents.info(key)?.pane_id, closeAgent: () => this.agents.finish(key) })
  }

  private async squashes(t: TaskRec, repo: string, on: string) {
    return !t.merged ? [] : t.squash ? [t.squash] : G.squashesOf(repo, on, t.id)
  }

  /**
   * Leftovers of finished tasks, put away: at startup and every hour, so none pile up. Only tasks Shepherdr made and
   * merged or closed, never one whose agent is at work (or that you talk to again after its clean-up), and never what holds
   * unsaved or unmerged work. Nothing is touched while herdr does not answer.
   */
  async sweep() {
    const spaces = await this.wt.workspaces().catch(() => null)
    if (!spaces) return
    for (const t of this.tasks.filter(ended)) {
      const p = this.places.space(t.project)
      const st = this.agents.status(this.key(t))
      if (!p || st === 'working' || (t.cleaned && st !== 'gone')) continue
      const left = !t.cleaned || (!!t.worktree && existsSync(t.worktree)) || (!!t.branch && (await G.branchExists(p.path, t.branch))) || !!(await this.wt.spaceOf(t.worktree, labelOf(t), spaces))
      if (left) await this.cleanup(t, true).catch(() => undefined)
    }
    await this.wt.closeRepoSpaces()
  }

  /**
   * Tasks that wait (queued after others, or held for room) with an agent, a herdr space and a worktree they got when
   * they were added, from before a waiting task was given none, each with what keeps it as it is: work in its worktree
   * or branch, your words to it beyond its brief, its agent at work, asking something, or past a few replies (it may have
   * begun). The rest can be parked; `notes`: what other agents wrote to it, which goes into its brief when it is.
   */
  async parkable(): Promise<{ t: TaskRec; keep?: string; notes: string[] }[]> {
    const out: { t: TaskRec; keep?: string; notes: string[] }[] = []
    for (const t of this.tasks.filter((t) => this.waitsToStart(t) && (t.worktree || this.agents.record(this.key(t))))) {
      const key = this.key(t)
      const st = this.agents.status(key)
      const held = await this.holds(t)
      const w = this.wordsTo(t)
      const keep =
        st === 'working' ? 'its agent is at work'
        : st === 'blocked' || this.asks(key) ? 'its agent asks something'
        : held.length ? held.join(', ')
        : w.yours ? `${w.yours === 1 ? 'a message of yours' : `${w.yours} messages of yours`} to it beyond its brief`
        : w.replies > PARK_REPLIES ? `its agent replied ${w.replies} times: it may have begun`
        : undefined
      out.push({ t, ...(keep ? { keep } : {}), notes: w.notes })
    }
    return out
  }

  /**
   * Park the tasks `parkable` finds nothing to keep in (only `ids`, when named): what other agents wrote to it goes into
   * its brief, its agent closes with its herdr space, its worktree and branch go, and it waits as a task added now does,
   * with none of them; its turn starts it on its brief. Returns those parked, and those left as they were with why.
   */
  async park(ids?: string[]): Promise<{ parked: string[]; kept: string[] }> {
    const want = ids?.map((i) => this.req(i).id)
    const parked: string[] = []
    const kept: string[] = []
    for (const { t, keep, notes } of await this.parkable()) {
      if (want && !want.includes(t.id)) continue
      if (keep) {
        kept.push(`${t.id}: ${keep}`)
        continue
      }
      const p = this.places.space(t.project)
      if (!p || !this.waitsToStart(t)) continue
      const key = this.key(t)
      this.cleaning.add(t.id)
      try {
        const r = await this.putAway(t, p.path, p.base)
        if (r.busy || r.kept.length) {
          kept.push(`${t.id}: ${r.kept.join(', ')}`)
          continue
        }
        // above the Settings block, plain, as a brief takes words written to a task with no agent (tell)
        if (notes.length) {
          const [work, how] = splitBrief(t.desc)
          t.desc = [work, `Written to this task while it waited:\n\n${notes.join('\n\n')}`, how].filter(Boolean).join('\n\n')
        }
        t.worktree = undefined
        t.branch = undefined
        t.reviewerNote = undefined
        this.briefing.delete(t.id)
        // a fresh start at its turn: its brief again, on what Settings say then, never the closed agent's session
        this.agents.forget(key)
        this.save()
        this.settleOne(t)
        parked.push(t.id)
      } finally {
        this.cleaning.delete(t.id)
      }
    }
    return { parked, kept }
  }

  /** it waits for other tasks or for room, and its turn is what starts it: not a time, a stop, or the way back */
  private waitsToStart(t: TaskRec) {
    return (this.queued(t) || this.holding(t)) && !t.scheduled && !ended(t) && !t.stopped && !this.goesBack?.(t) && !this.starting.has(t.id) && !this.cleaning.has(t.id)
  }

  /** what was written to a task beyond its brief (the first of your messages): yours (a count), other agents' (as they
   *  wrote them, with who), and how many times its agent replied */
  private wordsTo(t: TaskRec) {
    const ms = this.chats.chat(this.key(t)).messages.filter((m) => m.text && !m.card)
    const yours = ms.filter((m) => m.who === 'you')
    const brief = yours[0]?.text!.trim().startsWith(t.title) ? 1 : 0
    return {
      yours: yours.length - brief,
      notes: ms.filter((m) => m.who === 'peer').map((m) => `${m.peer?.name ?? 'Another agent'}: ${m.text!.trim()}`),
      replies: ms.filter((m) => m.who === 'agent').length,
    }
  }

  /** finished tasks that kept a worktree or branch, and why: for shepherdr status */
  keptLeftovers() {
    return this.tasks.filter((t) => ended(t) && t.kept?.length).map((t) => `${t.id} ${t.kept!.join(', ')}`)
  }

  /* ---------- you and coordinators ---------- */

  /**
   * A message to a task (task tell, or yours in its chat). `gate`: a coordinator's go to a task that waits (To do, or
   * held) waits for room on this machine; it says so. Yours always goes in at once. One queued after other tasks gets
   * it at once and stays queued: its agent clears the queue itself if the words are a go. `from`: another agent sent it
   * (its shell ran the command), so its agent reads who it came from, and the chat draws it as that agent's message.
   */
  async tell(id: string, text: string, { gate = false, from }: { gate?: boolean; from?: TellFrom } = {}): Promise<{ held?: HeldWhy }> {
    const t = this.req(id)
    // what its agent reads, once it has an agent to read it: another agent's message says who sent it, in the envelope
    // herdr's messaging writes (chatlines.fromAgents). A brief is never wrapped: those words are the task's own
    const said = from ? fromAgentLine({ ...from, to: `${t.id} agent` }, text) : text
    // a message to a task waiting for its time is the go: it starts now, on its brief with the words in it, and the time
    // it waited for is gone
    const wasScheduled = !!t.scheduled
    if (t.scheduled) {
      // the words start it now: it no longer waits for its time, nor for the tasks it was queued after (a hold would
      // drop them too)
      this.materialize(t)
      t.scheduled = undefined
      t.after = undefined
      this.armDue()
    }
    // a stopped task is no wait for room: its agent is closed, and the words start it again where it is
    const waits = wasScheduled || (this.statusOf(t) === 'todo' && !t.stopped) || this.holding(t)
    const r = gate && waits && !ended(t) ? this.room(t) : {}
    if (r.why) {
      if (!t.worktree) {
        // its brief takes the words, as below, plain: a brief is its own words, never another agent's envelope; it
        // starts on it once there's room
        const [work, how] = splitBrief(t.desc)
        t.desc = [work, text, how].filter(Boolean).join('\n\n')
        this.hold(t, r.why)
      } else this.hold(t, r.why, { text: t.held?.go ? `${t.held.go}\n\n${said}` : said, why: 'its coordinator said go', plain: true })
      return { held: r.why }
    }
    if (!t.worktree && !this.starting.has(t.id)) {
      // above the defaults Shepherdr ended the brief with, so it wins over them like the rest of the brief: plain, as
      // a brief is
      const [work, how] = splitBrief(t.desc)
      t.desc = [work, text, how].filter(Boolean).join('\n\n')
      // a message is the go, as for one at work: what a stop left (stopped, To do, paused) goes with it, so the task it
      // starts reads as it is (working) and counts against the machine's limit
      t.held = undefined
      t.stopped = undefined
      t.todo = undefined
      t.paused = undefined
      t.reported = false
      this.wrote.set(t.id, Date.now())
      await this.startTask(t)
      return {}
    }
    // one at rest waiting on you goes back to work on its base as it is now (beforeWords); a reviewer Settings changed
    // while it waited goes in with the first message that reaches it
    const reviewer = this.takeNote(t)
    const note = await this.beforeWords(t.id)
    await this.agents.send(this.key(t), [said, reviewer, note].filter(Boolean).join('\n\n'), { ensure: () => this.launch(t) })
    this.youWrote(this.key(t))
    return {}
  }

  /** the way a message behind the chat starts its agent again: never one whose last start failed, which is the human's
   *  to try again by writing (start.ts); what waits for it goes in at once when it does */
  private starter(t: TaskRec) {
    return () =>
      this.startFailedAt(this.key(t)) !== undefined
        ? Promise.resolve(null)
        : // never started (a scheduled task whose time came, or one that was held): it gets its worktree and its brief
          t.worktree && existsSync(t.worktree)
          ? this.launch(t)
          : this.startTask(t)
  }

  /** a task held before it ever started: it has no agent yet, so what you write starts it (tell) */
  unstarted(id: string) {
    const t = this.task(id)
    return !!t && !t.worktree && !this.starting.has(t.id) && !ended(t)
  }

  /**
   * Stop a task: its agent and its herdr space close. Its work stays: a worktree with unsaved or unmerged work is kept,
   * one with none goes with its branch. Writing to it again opens its space (or makes its worktree) and resumes it.
   */
  async stopTask(id: string): Promise<string[]> {
    const t = this.req(id)
    t.stopped = true
    // To do, as task pause leaves it: its agent is closed, and writing to it is how it starts again. A start that failed
    // is no longer what it waits on (writing tries it again, and says so if it fails again); a time it waited for is
    // dropped too, so it does not start by itself while it is stopped
    if (t.scheduled) {
      // the Settings it would have taken are built now, so writing to it later starts it on them; then no time is left
      // for it to start by itself while it is stopped
      try {
        this.materialize(t)
      } catch {
        /* its project is gone: its start says so */
      }
      t.scheduled = undefined
      this.armDue()
    }
    t.todo = true
    t.paused = undefined
    t.trouble = undefined
    t.startTrouble = undefined
    this.briefing.delete(t.id)
    this.settle(t)
    const key = this.key(t)
    await this.agents.interrupt(key)
    // closed before anything is looked at, so it changes nothing more
    await this.agents.finish(key)
    this.emit('gone', t, false)
    const p = this.places.space(t.project)
    if (!p || !t.worktree || ended(t) || this.cleaning.has(t.id)) return []
    this.cleaning.add(t.id)
    try {
      return (await this.putAway(t, p.path, p.base)).kept
    } finally {
      this.cleaning.delete(t.id)
    }
  }

  /**
   * Delete a task for good (only when the human plainly asks): its agent stops, its herdr space closes, its worktree
   * and branch go, its chat log and its record too, so it leaves every list. Nothing is posted. Refused while its
   * worktree or branch holds work its base lacks, unless forced; a merged task's commits stay on main. Returns what
   * could not be removed.
   */
  async deleteTask(id: string, opts: { force?: boolean } = {}): Promise<string[]> {
    const t = this.req(id)
    if (this.starting.has(t.id) || this.cleaning.has(t.id)) throw new Error(`${t.id} is starting or being put away: try again in a moment`)
    const p = this.places.space(t.project)
    const key = this.key(t)
    // a merge under way in its repo goes first: never its worktree removed under it
    if (p) await this.merging.get(p.path)
    if (!this.task(t.id)) throw new Error(`No task ${id}`)
    const holds = async (stopped = '') => {
      if (opts.force) return
      const held = await this.holds(t)
      // what it holds goes with the error too, for the screen to ask whether to lose it
      if (held.length) throw Object.assign(new Error(`Not deleted: ${t.id} holds ${held.join(', ')}.${stopped} Merge or save that work first, or delete with --force to lose it.`), { held, stopped: !!stopped })
    }
    await holds()
    this.cleaning.add(t.id)
    try {
      await this.agents.interrupt(key)
      await this.agents.finish(key)
      // its agent may have written something before it closed: it stays stopped, and writing to it resumes it
      await holds(' Its agent was stopped (writing to it starts it again).').catch((e) => {
        t.stopped = true
        this.save()
        throw e
      })
      const left = p ? await this.wt.remove({ repo: p.path, wt: t.worktree, branch: t.branch, label: labelOf(t) }) : []
      if (!p && t.worktree && existsSync(t.worktree)) left.push(`${t.worktree} (its project is gone)`)
      clearTimeout(this.later.get(t.id))
      for (const m of [this.later, this.wrote]) m.delete(t.id)
      this.data.tasks = this.data.tasks.filter((x) => x !== t)
      this.emit('gone', t, true)
      this.chats.forget(key)
      this.agents.forget(key)
      this.save()
      // a task queued after it waits on you now
      this.recheck()
      return left
    } finally {
      this.cleaning.delete(t.id)
    }
  }

  /* ---------- archiving ---------- */

  /**
   * Archive a task: it leaves every list and count, keeping its record, chat and summary (search and its place's
   * Archived view find it). A task whose agent runs is stopped first, as with task stop: its work stays.
   */
  async archive(id: string): Promise<{ kept: string[]; stopped: boolean }> {
    const t = this.req(id)
    if (t.archived) return { kept: [], stopped: false }
    t.archived = Date.now()
    t.pinned = undefined
    clearTimeout(this.later.get(t.id))
    this.quiet(t)
    const stopped = this.agents.status(this.key(t)) !== 'gone' && !ended(t)
    const kept = stopped ? await this.stopTask(t.id) : []
    // its shared browser closes too (stopping it already did)
    if (!stopped) this.emit('gone', t, ended(t))
    // a finished task's agent may still be about: put away as merging would
    if (ended(t) && !t.cleaned && this.agents.status(this.key(t)) !== 'working') this.cleanup(t, true).catch(() => undefined)
    return { kept, stopped }
  }

  /** bring an archived task back into its lists, as it is now: nothing about it is news */
  unarchive(id: string) {
    const t = this.req(id)
    if (!t.archived) return t
    t.archived = undefined
    t.unarchived = Date.now()
    this.quiet(t)
    // one that waited for a time meanwhile: its time may have come while it was away
    if (t.scheduled) {
      this.armDue()
      this.duePass(undefined, 'while it was archived')
    }
    return t
  }

  /** pin a task to the top of its lists (on) or unpin it; an archived one can't be pinned */
  pin(id: string, on: boolean) {
    const t = this.req(id)
    if (on && t.archived) throw new Error(`${t.id} is archived: unarchive it first (shepherdr task unarchive ${t.id})`)
    if (!!t.pinned === on) return t
    t.pinned = on ? Date.now() : undefined
    this.save()
    return t
  }

  /** a task's project's name, for its defaults */
  private nameOf(t: TaskRec) {
    return this.places.space(t.project)?.name
  }

  /** Done tasks archive themselves once tasks.archiveAfter has passed since they finished (or were last brought back) */
  autoArchive(now = Date.now()) {
    // each after its own project's tasks.archiveAfter (off: never); never one whose agent you are talking to (it
    // works): its row would vanish mid-conversation
    const after = (t: TaskRec) => archiveAfterMs(this.settings.get('tasks.archiveAfter', this.nameOf(t)))
    const due = this.tasks.filter((t) => {
      const ms = after(t)
      return ms !== null && !t.archived && this.statusOf(t) === 'done' && this.agents.status(this.key(t)) !== 'working' && now - Math.max(t.doneAt ?? t.updated, t.unarchived ?? 0) >= ms
    })
    for (const t of due) {
      t.archived = now
      t.pinned = undefined
    }
    if (due.length) this.save()
    return due.length
  }

  /** a message sent to a task agent asks something of it: it is working again, not done. `go`: false for an answer in
   *  its CLI's own menu or question, which is no go for a queued task */
  youWrote(key: string, { go = true } = {}) {
    const [id] = key.split('/')
    const t = this.task(id)
    if (!t) return
    // writing to an archived task brings it back: you talk to it again
    if (t.archived) this.unarchive(t.id)
    if (ended(t)) return
    // writing to it is how a start that failed is tried again
    this.started(key)
    t.reported = false
    t.landing = undefined
    t.stopped = undefined
    // talking to it is the go, or a change to the brief: it says so again if it still waits. Queued, it stays so: its
    // agent decides from the words whether they are a go, and clears its queue itself (task queue --after none)
    t.todo = undefined
    t.paused = undefined
    t.going = undefined
    // what it was held with is said already, or overtaken by what you wrote
    if (go) t.held = undefined
    this.wrote.set(t.id, Date.now())
    this.settle(t)
    this.settleSoon(t, ANSWER_GRACE + 500)
  }

  /** A launch error is superseded only by verified private routing and a live owning agent.
   * Progress reports, queued messages and old hooks alone are not evidence of recovery. */
  routeRecovered(key: string) {
    const t = this.task(key.split('/')[0])
    if (!t || key !== this.key(t)) return

    const st = this.agents.status(key)
    if (t.trouble !== ROUTING_FAILURE || t.stopped || ended(t) || !this.agents.routed(key) || (st !== 'working' && st !== 'blocked')) return false
    t.trouble = undefined
    this.settle(t)
    this.save()
  }

  /** an agent's state changed in herdr */
  agentStatus(key: string) {
    const [id, role] = key.split('/')
    const t = this.task(id)
    if (!t || !role) return
    const st = this.agents.status(key)
    // a reviewer or attempt from before tasks had one agent only: put it away
    if (role !== 'Agent') {
      if (st !== 'gone' && !this.agents.record(key)?.finished) this.agents.finish(key).catch(() => undefined)
      return
    }
    if (ended(t)) {
      if (st !== 'working' && !t.cleaned) this.cleanup(t).catch(() => undefined)
      return
    }
    this.begun(t)
    // at work: the go reached it, and a start that failed is over
    if (st === 'working') {
      this.started(key)
      if (t.going) t.going = undefined
    }
    // paused, it stopped; at work again on its own after that, it isn't paused any more
    if (t.paused && st !== 'working') t.paused = 'idle'
    else if (t.paused === 'idle' && st === 'working') {
      t.paused = undefined
      t.todo = undefined
    }
    if (st === 'working' || st === 'blocked') {
      clearTimeout(this.later.get(t.id))
      this.settle(t)
    } else this.settleSoon(t)
  }

  /** what the provider did to its agent's turn changed (retry.ts): waiting, trying again, or given up */
  retried(key: string) {
    const t = this.task(key.split('/')[0])
    if (t && key === this.key(t)) this.settle(t)
  }

  /** a start stopped on a screen of its own (start.ts): the task waits on you for it now, not at the next look */
  screenCard(key: string) {
    const t = this.task(key.split('/')[0])
    if (t && key === this.key(t) && !ended(t)) this.settle(t)
  }

  /** automations: tasks of a project, by status (archived ones left out) */
  count(project: string, status: TaskStatus) {
    return this.tasks.filter((t) => t.project === project && !t.archived && this.statusOf(t) === status).length
  }
}
