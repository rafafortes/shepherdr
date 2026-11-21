// The task view model: a task, its agent, what that agent runs on and what it last reported. shared/types.ts re-exports
// these, and stays the one file every module imports the view model from (audit 2026-11-18, MAINT-04).
import type { Status, UsageTotals } from '../types.ts'

/** What a task's agent last reported of its job (shepherdr status): a status line, how far through it is, the minutes left. */
export interface Report {
  /** at most STATUS_MAX characters: what it is doing right now */
  msg: string
  /** 0-100: how far through the whole task it is */
  progress: number
  /** minutes left, counted down while it works; 0 for under a minute; none when it gave none */
  eta?: number
  /** when the agent reported this line (ms), and its own estimate in minutes at that time: the screen counts the
   *  age and minutes left from these on its shared clock, so they keep moving through a snapshot that keeps its
   *  revision. Older snapshots leave them out, and keep the numbers above. */
  at?: number
  left?: number
  /** the agent waits on you or is blocked: the report stays as it was */
  paused?: boolean
  /** whole minutes since the agent reported this line, once it is past the cadence or its own time left while working:
   *  the row shows this age instead of a time left that has run out. Never set while it waits on you (frozen on purpose). */
  stale?: number
}

/** need: its agent asks or waits for you; ready: finished, waits for you to merge it; merging: finished and on its way
 * into main, nothing for you to do (GitHub's checks run, it is rebased or merged); work: its agent is at it; scheduled:
 * it starts by itself at a time, and has no agent yet (`task add --at`/`--in`); queued: it waits for other tasks to be
 * done, then Shepherdr tells its agent to go; todo: its agent waits for a go, or is starting and not yet at work on its
 * brief; done: merged */
export type TaskStatus = 'need' | 'ready' | 'merging' | 'work' | 'scheduled' | 'queued' | 'todo' | 'done'

/** A task's one agent: tapping the task opens its chat. */
export interface TaskAgent {
  /** chat key */
  chat: string
  role: string
  cli: string
  /** always the task's own status: the list and the chat show one and the same */
  status: Status
  /** its process is up: a To do task may still have an agent left to stop */
  running?: boolean
  age: string
  note: string
  /** what its agent runs on now, while its process is up: the provider (spark) and its name (Spark (local)), the model
   *  (as the CLI names it; default when the CLI picks) and the effort it started with */
  run?: TaskRun
}

/** what a task's agent runs on now (TaskAgent.run): its row's line under the status, and that line's title in full */
export interface TaskRun {
  provider: string
  providerName: string
  model: string
  effort?: string
}

export interface Task {
  /** short name, as people say it: GTM-15 */
  id: string
  name: string
  status: TaskStatus
  /** project place id */
  place: string
  /** second line in lists */
  sub?: string
  /** the whole of `sub` when the line is cut short (a held task's chain, shortened in the row): the row's title */
  subTitle?: string
  age: string
  /** when a Done task finished (ms): the Done group shows newest first */
  doneAt?: number
  branch?: string
  /** destination captured when this task was added */
  base?: string
  /** the agent's plan, when it posted one */
  plan?: string[]
  /** none until the task's agent starts */
  agent?: TaskAgent
  /** what this task's agent chat used since its first counted call, kept until 35 days after its last one: tokens,
   *  calls and pi's cost estimate; none while it has made no counted call */
  usage?: UsageTotals
  desc?: string
  said?: string
  /** its facts line when done: PR, commit, checks, review, what is not proven */
  facts?: string
  state: string
  on: string
  created: string
  /** its agent's job, while it works or pauses; none once it is done */
  report?: Report
  /** its pull request on GitHub, once one is open */
  pr?: { number: number; url: string }
  /** queued: the tasks it still waits for ("SHE-12", "vm-str:SHE-12" on another machine) */
  after?: string[]
  /** scheduled: when it starts by itself (ms), in the time zone Settings sets */
  scheduled?: number
  /** how it ended, for a task queued after it: done (merged, or closed with nothing to merge), stopped, failed */
  outcome?: 'done' | 'stopped' | 'failed'
  /** when it was archived (ms): out of every list and count, only search and its place's Archived view show it */
  archived?: number
  /** when it was pinned (ms): it shows in the Pinned group at the top of its lists */
  pinned?: number
  /** the shared browser (the browser plugin), for a task not merged: whether it works on its machine, and if not why */
  browser?: { ready: boolean; hint?: string }
}
