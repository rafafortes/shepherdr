// The view model every source (live herdr, demo) fills and the screen draws.
// Plain JSON both ways: the server sends a Snapshot and chat contents; the client sends Actions.
import type { BrowserNote } from './browser.ts'

/** Status marks: red needs you, green ready, green turning ring merging, amber working, grey ring idle or to do, grey
 * clock queued or scheduled (its agent starts by itself at a time), grey check done, dashed ring unreachable. */
export type Status = 'need' | 'ready' | 'merging' | 'work' | 'idle' | 'scheduled' | 'queued' | 'todo' | 'done' | 'off'

/** regular, always the fallback: the coordinator does what the human asks; or Autopilot, a switch on top of it */
export type Mode = 'regular' | 'autopilot'

/** each mode, its name and what it means in a few words */
export const MODES: [Mode, string, string][] = [
  ['regular', 'Regular', 'Does what you ask'],
  ['autopilot', 'Autopilot', 'Works on its own'],
]

/** the longest name a space can be given, as Slack's channels */
export const NAME_MAX = 80

/** a machine's emoji as given: one emoji, its skin tone and joins kept; '' none; null anything else */
export function asEmoji(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const e = v.trim()
  if (!e) return ''
  const one = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(e)].length === 1
  return one && e.length <= 16 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(e) ? e : null
}

/** a space's name as Slack's channel rules have it: lowercase letters, numbers, hyphens and underscores, no spaces.
 *  What was typed, turned into one ("My Project" → "my-project"); '' when nothing of it is left */
export function slugify(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX)
    .replace(/-+$/, '')
}

/** why a space's name can't be (it breaks a rule, or another space on its machine has it), or undefined */
export function nameProblem(name: string, taken: string[] = []): string | undefined {
  if (!name) return 'Give it a name.'
  if (name.length > NAME_MAX) return `At most ${NAME_MAX} characters.`
  if (/[A-Z]/.test(name)) return 'Lowercase only.'
  if (/\s/.test(name)) return 'No spaces: use - or _.'
  if (!/^[a-z0-9_-]+$/.test(name)) return 'Only letters, numbers, - and _.'
  if (taken.includes(name)) return 'Another space on this machine has that name.'
  return undefined
}

/** A space: a folder on a machine with a name and its own coordinator, as herdr's spaces. Every machine has its home
 *  space (its home folder, ~), always first under it and never removed: its coordinator also keeps an eye on the
 *  machine, and the main machine's on every machine. Spaces are the only places with a chat. */
export interface Place {
  id: string
  /** its name, Slack-channel style ("my-project"), unique on its machine: the slug its links and commands use */
  name: string
  /** the machine it is on (its key: herdr's label for it) */
  machine: string
  /** the machine's home space */
  home?: boolean
  /** what its Tasks and Artifacts list: 2 its own; 1 its machine's (a home space); 0 every machine's (the main
   *  machine's home space, where there are more machines) */
  level: 0 | 1 | 2
  status: Status
  mode: Mode
  /** chat key of this space's coordinator */
  chat: string
  /** its machine can't be reached: when it went quiet, as shown ("14:02") */
  unreachableSince?: string
  /** its machine hasn't been reached yet since Shepherdr started (an update): what it showed last, while it connects */
  connecting?: boolean
  /** does its repo have a GitHub remote */
  githubRemote?: boolean
  /** herdr on its machine isn't answering, since then ("14:02"): its agents can't hear anything */
  herdrDown?: string
  /** Autopilot's Run now from this screen, on this machine's own places on Autopilot (never another machine's): 'ready'
   *  to wake its coordinator once, or the tap that waits ('queued') or whose wake runs ('waking'), where it is refused */
  runNow?: 'ready' | 'queued' | 'waking'
  /** its coordinator runs on other than what Settings for coordinators say now (the comparison its chat's hint makes):
   *  one of the coordinators `shepherdr restart --all` restarts, which the places list's own item counts */
  restart?: boolean
}

/** A machine, as a heading over its spaces in the sidebar: no chat, nothing to open. How it is doing shows on it and in
 *  its home space. */
/** a section of the sidebar that only organizes spaces: Pinned (id 'pinned') or one the human made (s:<id>), at the top
 *  (any machine's spaces) or inside a machine (its key: only its spaces) */
export interface Section {
  id: string
  name: string
  emoji?: string
  machine?: string
  /** the spaces in it, in order */
  spaces: string[]
}

export interface Machine {
  /** m:<its key>: what its spaces' order and its fold are kept under */
  id: string
  /** its key: herdr's label for it */
  machine: string
  /** the name the human reads */
  name: string
  /** the emoji the human gave it, before its name as a Slack section's (none: a server icon) */
  emoji?: string
  /** off: Shepherdr can't reach it */
  status: 'idle' | 'off'
  unreachableSince?: string
  connecting?: boolean
  /** how it is doing, sampled every 30 seconds */
  health?: MachineHealth
  herdrDown?: string
}

/** what Shepherdr measures on a machine, as one level each: a share of what it has (CPU: its 1-minute load over its
 *  cores, so over 100 means more work than cores) */
export type HealthLevel = 'ok' | 'busy' | 'over'

export interface HealthMeter {
  /** CPU, Memory, Disk, GPU */
  name: string
  /** 0-100, or above for a CPU loaded past its cores */
  pct: number
  /** the numbers behind it, in a few words ("load 13.2 on 16 cores", "10 of 31 GB", "home 22% · /tmp 22%") */
  detail: string
  /** ok; busy: new tasks wait (start limit); over: past the alert limit, and the coordinator was told */
  level: HealthLevel
}

export interface MachineHealth {
  /** CPU, Memory, Disk, and GPU where the machine has one */
  meters: HealthMeter[]
  /** herdr answers */
  herdr: boolean
  /** tasks at work now, and how many may be (none: no limit by number) */
  working: number
  /** of those, the ones waiting on you: they keep their slot until they are answered */
  waiting?: number
  max?: number
  /** tasks Shepherdr holds until there is room, and why the first one waits */
  held: number
  heldWhy?: string
  /** when it was sampled ("08:41") */
  at: string
}

/** The most characters a task's title may have: with its id it fits one line of the tasks list on a 390 px phone. */
export const TITLE_MAX = 32

/** The most characters an agent's status line may have: one line of a task row on a 375 px phone. */
export const STATUS_MAX = 40

/** The most characters a task's summary may have: what changed for the human, in two or three lines of its card on a
    phone. More detail goes in its agent's chat or its proof, the facts (PR, commit, checks…) in the record, not on the card. */
export const SUMMARY_MAX = 160

/** a summary and its facts line apart: older summaries carried it at their end ("… Facts: PR #3 · commit 1a2b3c4") */
export function splitFacts(said: string, facts?: string): { said: string; facts?: string } {
  const at = said.search(/(^|\s)Facts:\s/)
  if (at < 0) return { said: said.trim(), facts: facts?.trim() || undefined }
  const tail = said.slice(at).replace(/^\s*Facts:\s*/, '').trim()
  return { said: said.slice(0, at).trim(), facts: facts?.trim() || tail || undefined }
}

/** What a task's agent last reported of its job (shepherdr status): a status line, how far through it is, the minutes left. */
export interface Report {
  /** at most STATUS_MAX characters: what it is doing right now */
  msg: string
  /** 0-100: how far through the whole task it is */
  progress: number
  /** minutes left, counted down while it works; 0 for under a minute; none when it gave none */
  eta?: number
  /** the agent waits on you or is blocked: the report stays as it was */
  paused?: boolean
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

/** An automation as a project's Tasks lists it: its name, when it runs, the task it adds */
export interface Automation {
  name: string
  /** its trigger in words: "Monday to Friday at 9:00 (Stockholm)", "When a task is merged" */
  when: string
  /** the title of the task it adds */
  what: string
  /** the brief of the task it adds */
  brief?: string
  /** off: paused */
  on: boolean
  /** its trigger as kept, for agents: its time rule (an RRULE, or "once …") and its event rules ("ready, merged") */
  time?: string
  events?: string
  /** its next runs by its time rule, in words ("Tomorrow 9:00"); none while paused or without one */
  next: string[]
  /** its latest runs, newest first: when (ms), and the task it added or why it couldn't */
  runs: { at: number; task?: string; error?: string }[]
}

/** A question card: built-in choice cards, a CLI's own menus, plans. */
export interface Choice {
  label: string
  description?: string
}

export interface Question {
  id: string
  title: string
  kind: 'Form' | 'Question' | 'Plan'
  /** Explicitly an ordinary question, never permission or approval. Missing means confirm. */
  ordinary?: boolean
  steps?: string[]
  /** CLI prompt context, read from its visible screen. */
  screen?: string
  terminal?: boolean
  /** A terminal checkbox prompt can be declined without enabling any of its choices. */
  reject?: string
  choices: Choice[]
  multi?: boolean
  /** an "Other" answer with free text */
  other?: boolean
  /** which choice needs a note to be sent (a plan sent back) */
  noteRequiredFor?: number
  /** no note box at all */
  noNote?: boolean
  to: string
  /** index of the choice sent, once answered; -1 answered without a pick */
  sent?: number
  /** answered without a pick: the words it was answered with (an Other answer, or the message that answered it) */
  said?: string
  /** answered without a pick, and not on the card: by a message in the chat, or in the CLI's own terminal */
  via?: 'chat' | 'terminal'
  /** the advisor can take it (Settings → Agents → Advisor): its card offers Ask the advisor */
  advise?: boolean
  /** closed without an answer, by its Dismiss (or Esc on it): the agent heard the person declined, never an answer */
  dismissed?: true
  /** no Dismiss on this card: a start's own screen, whose Esc would end the launch */
  noDismiss?: true
  /** who asks, when it is not the agent's own message ("Claude Code asks") */
  asks?: string
  /** answered on its other copy (a task's question and its copy in its space's chat): where, and a link to that chat */
  elsewhere?: { label: string; chat: string; name: string }
}

/** an artifact: what an agent shows beyond words, kept in its place and updated as new versions */
export interface Artifact {
  id: string
  title: string
  /** the place it lives in */
  place: string
  /** its latest version, and when that came (ms) */
  v: number
  at: number
  /** when that came, short ("2m"), and who made it ("SHE-56 agent") */
  when: string
  by: string
  /** who its Send, notes and messages go to: the agent that made the latest version, or the place's coordinator once
   *  that agent's task is over */
  keeper: string
  /** the check's picture of it, for the list */
  thumb?: boolean
  /** the chats its kept versions came from (a chat's ⋯ → Artifacts) */
  chats?: string[]
  /** newest first */
  versions: ArtifactVersion[]
}

export interface ArtifactVersion {
  n: number
  when: string
  by: string
  note?: string
  /** the version whose HTML it shows: one that only brought new data shows the HTML before it */
  html: number
  /** what it brought, when not a new page: only data, or only a title */
  what?: 'data' | 'title'
}

/** an artifact as posted in a chat: the version it came with. A message of its own (words posted with it come just
 *  before it), so it takes reactions and replies like any message */
export interface ArtifactPost {
  id: string
  v: number
}

/** how a reaction or a reply names an artifact: its title and the version posted ("Weekly board · v2") */
export const artifactQuote = (title: string, v: number) => `${title} · v${v}`

/** an artifact posted with words becomes a message of its own right after them, as a file does; a question that came
 *  with it goes after it, the last thing the chat waits on */
export const apart = (msgs: Message[]): Message[] =>
  msgs.flatMap((m) => {
    if (!m.artifact || !(m.text || m.question || m.file)) return [m]
    const { artifact, question, ...words } = m
    const card = { id: `${m.id}:art`, who: m.who, at: m.at, artifact }
    if (!question) return [words, card]
    return words.text || words.file ? [words, card, { id: `${m.id}:q`, who: m.who, at: m.at, question }] : [{ ...card, id: m.id }, { id: `${m.id}:q`, who: m.who, at: m.at, question }]
  })

export interface Reaction {
  emoji: string
  by: 'me' | 'them' | 'both'
  /** sent while the agent shows a menu or is starting: waits like a typed message */
  pending?: boolean
}

export interface Message {
  id: string
  who: 'you' | 'agent' | 'peer'
  /** plain text (yours) or markdown (the agent's, and another agent's) */
  text?: string
  /** another agent's message to this one (`who: 'peer'`): who it says it is. The sender is only the name the sending
   *  side wrote, never verified, so the chat shows it without vouching for it: it is text, not the human's word */
  peer?: Peer
  /** "Answered “Rerun CI on main?”" */
  answered?: string
  /** answered on the question's copy in a space's chat: a link there */
  elsewhere?: Question['elsewhere']
  artifact?: ArtifactPost
  question?: Question
  reactions?: Reaction[]
  /** waits to go in: the agent shows a menu or permission prompt, or is still starting (a busy one takes it at once) */
  waiting?: boolean
  /** why it waits: a menu is up (typed text could pick an option), the agent is starting, or a CLI command waits for the
   *  turn to end */
  waitsFor?: 'menu' | 'start' | 'turn'
  /** an attached file: each one is a message of its own, right after the text it came with */
  file?: { name: string; path: string }
  /** the id the screen gave what you sent: it showed it at once, and this message takes its place */
  cid?: string
  /** what it answers: a short quote of that message, and its id while the chat still has it (a tap jumps to it) */
  reply?: ReplyQuote
  /** a thin "New session" divider before this message */
  newSession?: boolean
  /** Shepherdr's update card about a task, drawn as the card; its text ("SHE-4 is done: …") is what a reaction or a
   *  reply quotes */
  card?: UpdateCard
  /** a turn's tool steps, as a few rows in plain words, just before its last reply */
  activity?: TurnActivity
  /** an Autopilot wake's one quiet line: why it woke, and that it answered with nothing ("Autopilot woke · Run now ·
   *  nothing to report"): the chat draws it as a quiet row, never a card and never an alert */
  pilot?: string
  /** a secret the agent asked for (shepherdr secret ask): a masked box to give it in */
  secret?: SecretAsk
  at?: number
}

/** Another agent's message: everything the sending side said about itself, and nothing this machine proved. A name is
 *  what the sender wrote (a chat, a herdr agent name, a handle or a pane id); pane, space and task are there when that
 *  side said them or this machine knows the name */
export interface Peer {
  /** the sender's name as the screen shows it ("SHE-17 agent", "shepherdr coordinator", a herdr name) */
  name: string
  /** its herdr pane here (w7R:p2) */
  pane?: string
  /** the space's name as the screen shows it, when the sender works in one */
  space?: string
  /** the task it works in, when it is a task's agent */
  task?: string
}

/** a secret an agent asked for by name: the human types or pastes it in a masked box, for one of the levels offered;
 *  only its name ever shows, never its value */
export interface SecretAsk {
  id: string
  name: string
  /** why the agent needs it, in its words */
  why?: string
  /** where it may be kept, the agent's space first: a level's id (p:<machine>:<space>, m:<machine>, all) and its name */
  levels: { id: string; label: string }[]
  /** saved: where, by its level's name */
  saved?: string
}

/** what kind of step a tool call is, for its icon and its row */
export type StepKind = 'run' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'other'

/** What a tool call did, in plain words, from its tool and input (the agent's own short description where it gave one) */
export interface StepWords {
  /** once over: "Checked the task list", "Read app.ts", "Searched the code for “review”" */
  title: string
  /** while it runs: "Checking the task list" */
  doing: string
  /** what it is on, to group by: a file's name (read, edit), a search's words; may be empty */
  target: string
  /** the raw thing, one tap deeper: the command, a file's path, the pattern, the address */
  detail?: string
  /** an edit's lines added and removed */
  added?: number
  removed?: number
  /** a test run: its outcome ("41 passed") reads from its output once over */
  test?: boolean
}

/** One tool call of an agent's turn: what it did, on what */
export interface Step extends StepWords {
  id: string
  kind: StepKind
  /** the tool's own name: Bash, Read, exec_command */
  tool: string
  at: number
  /** when it ended; none while it runs */
  end?: number
  failed?: boolean
  /** a test run's outcome: "41 passed", "2 failed, 39 passed" */
  result?: string
  /** it started this background job (Job.id) */
  job?: string
  /** its raw output can be read (activityOf, what: 'output') */
  output?: boolean
}

/** A turn's steps grouped into rows that read at a glance: "Edited 2 files: app.ts, panel.tsx", "Ran tests: 41 passed" */
export interface StepRow {
  /** the same row whether it came with the turn or from its steps */
  key: string
  kind: StepKind
  text: string
  added?: number
  removed?: number
  /** how many of its steps failed */
  failed?: number
  /** its steps (Step.id), in order */
  steps: string[]
}

/** A turn's steps as the chat shows them: a few rows at a glance; all its steps come when it opens (activityOf, what:
 *  'turn') */
export interface TurnActivity {
  /** the turn's id, to ask for its steps */
  id: string
  at: number
  /** when it ended; none while it runs */
  end?: number
  /** the rows that say most, at most three, in the order they happened */
  rows: StepRow[]
  /** how many rows more it has */
  more?: number
  /** how many steps */
  steps: number
  /** the step it is on now (a live turn only) */
  now?: Step
  /** how many failed */
  failed?: number
}

/** Work an agent started in the background that still runs */
export interface Job {
  id: string
  kind: 'agent' | 'shell' | 'monitor' | 'headless'
  /** what it is: a subagent's description, a shell's command, a headless CLI's words */
  title: string
  at: number
  /** what it does now: its latest step, or its output's last line */
  now?: string
  /** its own steps (a subagent, a headless agent) or its output (a shell) can be read (activityOf, what: 'job') */
  more?: 'steps' | 'output'
}

/** what the screen asks of a chat's activity: a turn's steps, a step's raw output, a background job's steps or output */
export interface ActivityAsk {
  chat: string
  what: 'turn' | 'output' | 'job'
  id: string
}

export type ActivityAnswer = { steps: Step[]; more?: number } | { output: string; cut?: boolean } | { error: string }

/** A reply's quote of the message it answers */
export interface ReplyQuote {
  /** none when that message is no longer in the chat (only the quote is known) */
  id?: string
  who?: 'you' | 'agent' | 'peer'
  /** the sender another agent's message named, when the quote is of one */
  from?: string
  /** the start of its words, a file's name, or an artifact's title and version */
  text: string
  file?: boolean
  artifact?: boolean
}

/** One small update card Shepherdr posts in a project's coordinator chat. */
export interface UpdateCard {
  id: string
  /** a note beside the questions before it (the advisor's): it answers and closes none of them, so they still wait */
  aside?: true
  /** the task it is about; none on a mode card */
  task?: string
  /** the task's state when posted */
  status?: TaskStatus
  /** a mode card: the place's coordinator went on this mode (text: "on · works on its own"); an older one may say Manual */
  mode?: Mode
  /** a few words on one line ("is merged"); a task's summary is in the task, never on its card */
  text: string
  /** the task's pull request, linked from the card */
  pr?: { number: number; url: string }
  /** a machine health card: what crossed its limit (or came back under it); text says it in words */
  health?: { level: HealthLevel; machine: string }
  /** the project's base branch went red on GitHub ("main"); text says which checks failed */
  red?: string
  /** its agent started again (text: "Restarted on Codex (GPT-6-Sol, high)") */
  restart?: boolean
  /** a task that needs you: a copy of what it asks, answered here as in its own chat */
  ask?: CardAsk
}

/** what a needs-you card asks, from its task's chat: its question cards, or the agent's plain question */
export interface CardAsk {
  /** the task's chat, where the answer goes */
  chat: string
  /** its question cards, as asked; on screen each as it stands in the task's chat */
  questions?: Question[]
  /** a plain question with no choices: the agent's words, answered with a reply */
  reply?: { id: string; text: string }
  /** once answered: where (in this card, in the task's chat or its terminal) and the words, if known */
  answered?: { where: 'space' | 'task' | 'terminal'; text?: string; dismissed?: true }
  /** on screen: it still waits, so it takes an answer here */
  open?: boolean
  /** its plain question can go to the advisor (Settings → Agents → Advisor): the card offers Ask the advisor */
  advise?: boolean
}

/** One thing waiting on the human, from any agent: its own card, never a forwarded copy. The Needs you view lists these
 *  and every count counts these, so a number and its list always agree. */
export interface Need {
  /** the request's id in its chat; 'attention' when the agent waits with no card */
  id: string
  /** the agent's chat, where the answer goes */
  chat: string
  place: string
  /** the task it belongs to; none for a coordinator */
  task?: string
  /** when it began to wait (ms), for the list's oldest-first order */
  at: number
  /** the card it waits on (a choice, a plan, the CLI's own menu or a start's screen): drawn in its chat, where it is
   *  answered */
  question?: Question
  /** no card: what it waits with (a plain question, a failed start), for its row to say */
  text?: string
}

/** Done tasks newest first, at the end; the rest keep their order (a stable sort) */
/** a machine's name as the human reads it ("Mac mini"), from its key, a place's machine ("Mac") */
export const machineName = (machines: Machine[] | undefined, machine?: string) => machines?.find((m) => m.machine === machine)?.name ?? machine ?? ''

export const doneNewestFirst = <T extends Pick<Task, 'status' | 'doneAt'>>(ts: T[]): T[] =>
  [...ts.filter((t) => t.status !== 'done'), ...ts.filter((t) => t.status === 'done').sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))]

/** a mode's name: "Autopilot" */
export const modeName = (mode: Mode) => MODES.find(([m]) => m === mode)?.[1] ?? mode

/** a mode card, Autopilot switched on or off: "Autopilot on · works on its own", "Autopilot off · does what you ask" */
export function modeCard(id: string, mode: Mode): UpdateCard {
  const what = MODES.find(([m]) => m === mode)?.[2] ?? ''
  return { id, mode: 'autopilot', text: `${mode === 'autopilot' ? 'on' : 'off'} · ${what.toLowerCase()}` }
}

/** an update card as a message in the chat: its words are what a reaction or a reply quotes */
export const cardMessage = (card: UpdateCard, at?: number): Message => ({
  id: card.id,
  who: 'agent',
  at,
  text: `${card.task ?? (card.mode ? modeName(card.mode) : (card.health?.machine ?? card.red ?? ''))} ${card.text}`,
  card,
})

export interface Chat {
  key: string
  /** the agent's and yours, and Shepherdr's update cards among them */
  messages: Message[]
  /** herdr says the agent works: the CLI takes what you send at its next step */
  working?: boolean
  /** the ids the screen gave what it sent that the CLI still holds in its own queue (it takes one at its next step, or
   *  now with Send now): Claude Code's offer, so another CLI gives none */
  queued?: string[]
  /** it works, but no message you will see is on its way: its turn is over and only background work runs (a subagent,
   *  a shell), or in a turn it started itself (news, background work waking it) no reply has shown yet; no dots then */
  background?: boolean
  /** what a screen sent (by its Message.cid) that waited for the agent and then couldn't go in, and why */
  failed?: { cid: string; error: string }[]
  /** finished agent: writing resumes it */
  finished?: boolean
  /** the turn that runs now: how far it got and its step on now, drawn as one quiet line at the end of the chat */
  live?: TurnActivity
  /** what it started in the background that still runs: subagents, shells, headless agents */
  jobs?: Job[]
  cli: string
  /** what this CLI lets the + menu change; only what it supports is listed */
  controls?: ChatControls
  /** Recorded launch values, never inferred from Settings. Missing values are CLI defaults, not observed telemetry. */
  agent?: { kind: string; model?: string; modelLabel?: string; effort?: string; runtime?: AgentRuntime }
  /** Settings for its role now say something else than what its agent runs on: a calm hint offers a restart */
  restart?: RestartHint
}

/** "Runs on {on} · Settings now say {want}", by the first that differs: the CLI, the model or the effort */
export interface RestartHint {
  on: string
  want: string
}

/** a CLI the restart sheet offers; models and efforts where Shepherdr passes them (none: it runs on its own) */
export interface RestartCli {
  kind: string
  name: string
  models?: { id: string; label: string; efforts: string[]; defaultEffort?: string }[]
  /** the levels its own default model takes */
  efforts?: string[]
  defaultModel?: string
  defaultEffort?: string
  /** the human's pinned models here, by id, in the order they were pinned: they lead the list */
  pinned?: string[]
  /** the ones picked last here, by id, newest first: they come next */
  recent?: string[]
}

/** what the restart sheet shows: what its agent runs on now and what Settings say for its role (what it restarts with
 *  unless changed), each a CLI kind with a model id and level (none: the CLI's own) */
/** CLI-reported state, kept separate from the selected next-launch policy. */
export interface AgentRuntime {
  model?: string
  modelLabel?: string
  effort?: string
  effortUnsupported?: boolean
  source: 'session' | 'hook'
  at: number
}

export interface RestartInfo {
  role: 'task' | 'coordinator'
  /** its space, whose Settings a save changes */
  space?: string
  on: { kind: string; model?: string; effort?: string }
  /** False if no launch record exists; on is then only a proposed starting configuration. */
  onKnown?: boolean
  onWords: string
  want: { kind: string; model?: string; effort?: string }
  clis: RestartCli[]
  /** its agent is mid-turn: a restart interrupts it first */
  working: boolean
}

export interface ChatControls {
  /** the models its CLI offers, by name (Opus 5.5) */
  models: string[]
  model: number
  /** the effort levels the model it is on takes, as the CLI names them (low, xhigh) */
  efforts: string[]
  effort: number
}

export interface SettingRow {
  label: string
  key: string
  value: string
  /** one of a role's backups, in turn (n: 1 is Backup 1): the screen shows the 2nd to the 5th once their CLI (cli: its
   *  row) is on, and adds the next one with `add`, the words of its button */
  chain?: { of: string; n: number; cli?: true; add?: string }
  /** free text instead of a pick list */
  text?: boolean
  /** private instruction text, saved explicitly without a repository file */
  multiline?: boolean
  /** a trigger's time rule or event rules (Autopilot's heartbeat): shown in words, never as written */
  trigger?: TriggerRow
  /** a whole file's words (a coordinator's HEARTBEAT.md), in a box as wide as the page */
  doc?: boolean
  /** read-only row (plugins, machines) */
  fixed?: boolean
  /** a line under the row's label (a plugin of yours replaces the built-in one) */
  hint?: string
  /** a refusal or a fault shown under the row */
  warn?: string
  /** pick list values */
  options?: string[]
  /** the values in their own order (a model list: Default, then the ones pinned or picked first), not what is set first */
  ordered?: boolean
  /** each value's id, which a search finds it by where the value is its model's name (a model list) */
  ids?: Record<string, string>
  /** a number from min to max (step: what it goes up by, 1 when none), with its unit (plural, and one: singular);
   *  off: it may be left empty for off, zero: 0 is off. limit: a limit, with three choices (no cap = off, blocked = 0 starts
   *  none, Limit: a number from 1 to max) */
  num?: { min: number; max: number; step?: number; unit?: string; one?: string; off?: boolean; zero?: boolean; limit?: boolean }
  /** the small heading it sits under (Tasks, Coordinators) */
  group?: string
  /** the sub-block of its group it sits in (Backups): drawn indented under its own small heading, the rows after it
   *  back at the group's level */
  sub?: string
  /** not set at this level: where its value comes from (All machines, a machine's name) */
  from?: string
  /** set at this level: the value a reset goes back to, and where that comes from (Default at All machines) */
  inherits?: { value: string; from: string }
  /** the exact line it adds to every new brief's Settings block, as it is set now (What agents are told) */
  line?: string
}

/** a trigger setting as Settings shows it: in plain words, its next runs (a time rule's), and a few ready-made values
 *  to pick; anything else the coordinator writes from the human's words */
export interface TriggerRow {
  words: string
  next: string[]
  presets: { label: string; value: string }[]
}

export interface SettingSection {
  name: string
  rows: SettingRow[]
  /** one line on what the section is for, above its rows */
  about?: string
  /** text shown under the rows as it is (the lines every new brief ends with) */
  note?: string
  /** the note's heading ("Every new brief ends with" when none) */
  noteTitle?: string
  /** the machine whose level it is (a machine's or one of its projects'); none: All machines */
  machine?: string
  /** the level its defaults are set at, as a place id: all (All machines), m:<machine> or p:<machine>:<project> */
  level?: string
  /** one for all machines and projects (alerts, voice): shown once, whatever level is picked */
  global?: boolean
  /** only words in agents' prompts (What agents are told), not how Shepherdr runs */
  told?: boolean
  /** the secrets kept at its level, by name (Secrets): added, replaced and removed in masked boxes */
  secrets?: { name: string; at: number }[]
}

/** Settings → Models: every level's model settings in one table (models-matrix.ts). A slot is one agent of a role: its
 *  primary, or one of its backups (n: 0 is the primary, 1 is Backup 1), with the three keys that set its CLI, model and
 *  effort */
export type MatrixRole = 'task' | 'coordinator' | 'reviewer' | 'advisor'
export interface MatrixSlot {
  id: string
  role: MatrixRole
  /** the role's group heading: Tasks, Coordinators, Reviewer, Advisor */
  title: string
  /** Primary, Backup 1 … Backup 5 */
  name: string
  n: number
  cli: string
  model: string
  effort: string
  /** the CLI choices the slot offers, as its Settings row does (off first for a backup) */
  clis: string[]
}
/** a key's value as its row reads it, and where that comes from: this row's own level (set), a level above it, or
 *  Shepherdr's default. A model shows its label, a CLI its name; follows: the key a backup's model or effort reads
 *  while it is at default (the tasks' backup's) */
export interface MatrixValue {
  value: string
  from: 'all' | 'machine' | 'space' | 'default'
  set: boolean
  follows?: string
}
/** one slot in one row: what it runs on in words ("pi · opencode-go/deepseek-v4.1-flash · high", "off"), whether any of
 *  its three keys is set in this row, and where its CLI comes from */
export interface MatrixCell {
  words: string
  set: boolean
  from: MatrixValue['from']
}
export interface MatrixRow {
  /** the level's place id: all, m:<machine>, p:<machine>:<space> (the setting action's place) */
  id: string
  name: string
  kind: 'all' | 'machine' | 'space'
  /** every key the row reads (the slots' three keys, and the plain columns') */
  values: Record<string, MatrixValue>
  cells: Record<string, MatrixCell>
}
/** what one CLI takes: its models in the order the picks put them first, with the efforts each model takes */
export interface MatrixCatalog {
  /** false where the CLI can't list its models: any id goes */
  known: boolean
  models: { label: string; id: string; efforts: string[] }[]
  /** the levels its own default model takes */
  efforts: string[]
}
export interface ModelsMatrix {
  machine: { id: string; name: string }
  slots: MatrixSlot[]
  /** the plain columns after the roles: a key of its own, its title, and what it takes (a choice or a number) */
  plain: { key: string; title: string; options?: string[]; num?: SettingRow['num'] }[]
  rows: MatrixRow[]
  /** by the CLI's name (Codex, Claude Code, pi): what each one takes */
  catalog: Record<string, MatrixCatalog>
}

/** one window of a provider's quota, as a read of its own gives it (4b): used as a share or a count, against a cap, and
 *  when it refills. A window refilled since its read says nothing of now */
export interface QuotaWindow {
  name: string
  usedPct?: number
  used?: number
  cap?: number
  resetAt?: number
  /** what is left of a count that has no cap (Command Code's credits) */
  left?: number
  /** an estimate's usage in the window: pi's cost estimate, when its logs gave one */
  cost?: number
  /** an estimate's learned limit: what the window held when the provider ran out, the latest few, newest first */
  learned?: { at: number; tokens: number; cost?: number }[]
}
/** a provider's quota figure: its windows, where the read came from and when, and whether the numbers are an estimate */
export interface QuotaFigure {
  windows: QuotaWindow[]
  source: string
  at: number
  estimate?: boolean
}

/** a provider's quota read as the summary shows it (quotas.ts): its switch, why nothing is read (a hint: a key to add,
 *  bubblewrap to install), and how its last try went (the figure stays the last good one) */
export interface QuotaRead {
  on: boolean
  hint?: string
  failed?: string
  /** when it was last tried (ms) */
  tried?: number
}

/** Settings → Models → Summary (models-summary.ts): where the work runs, per provider and per model. Usage is read from
 *  the logs of Shepherdr's agents on this machine (usage-ledger.ts); the rest is the table's configured values and what
 *  runs and waits now */
export interface SummaryUsage {
  tokens: number
  calls: number
  /** pi's own cost estimate, in dollars, when its logs gave one: an estimate, never a bill */
  cost?: number
}
export interface SummaryWindows<T> {
  h5: T
  h24: T
  d7: T
}
/** the role slots that point at a provider or model: primaries and backups, by role and by space (its name, ~ for home) */
export interface SummaryConfigured {
  primary: number
  backup: number
  roles: Partial<Record<MatrixRole, number>>
  spaces: Record<string, number>
}
/** what runs and waits on it now: live agents by role, and the waiting tasks that start on it or are reviewed by it */
export interface SummaryNow {
  agents: number
  working: number
  roles: Partial<Record<'task' | 'coordinator' | 'reviewer', number>>
  starts: number
  reviews: number
}
export interface SummaryRunOuts {
  count7d: number
  last?: { at: number; reason: string; reset?: string; resetAt?: number; chat: string; role: string; model: string }
  /** out right now: until its known reset, or until its return watch says the primary is back, or until a call goes through */
  out: boolean
  until?: number
}
/** the most agents at once on this machine for a row (models.maxAtOnce): what counts toward it now, the entry that caps
 *  the row itself (its own, set at the machine or Everywhere), the provider's entry that also holds a model (via), and
 *  how many tasks wait for the entry now */
export interface SummaryAtOnce {
  now: number
  own?: { pattern: string; max: number; from: 'all' | 'machine' }
  via?: { pattern: string; max: number; from: 'all' | 'machine' }
  held: number
  /** the sub-limits the spaces set for this row (their own entry for it, inside the machine's total), with what each runs */
  spaces?: SummarySpaceCap[]
}
/** one space's sub-limit on a row: its key and name, its most at once, and how many of its runs count under it now */
export interface SummarySpaceCap {
  key: string
  name: string
  max: number
  now: number
}
/** one space's own models.maxAtOnce text (its key, name and place id, '' where it sets none): the cell editor's writes */
export interface SummarySpaceText {
  key: string
  name: string
  place: string
  text: string
}
/** one row of the summary: a provider, or one of its models */
export interface SummaryRow {
  configured: SummaryConfigured
  now: SummaryNow
  usage: SummaryWindows<SummaryUsage>
  runOuts: SummaryRunOuts
  atOnce: SummaryAtOnce
}
export interface SummaryModel extends SummaryRow {
  /** the model key (provider/model) and the model's name in words */
  key: string
  label: string
}
export interface SummaryProvider extends SummaryRow {
  provider: string
  /** the provider in words (Claude Code, Codex, OpenCode Go, or its own name) */
  name: string
  /** one of this machine's own models (spark, radeon, avell, dell): no quota, shared */
  local: boolean
  /** nothing uses it yet: no slot, agent, run, run-out in the week, or cap. Such a provider is listed under Other providers,
   *  with the models its CLI offers and no numbers */
  idle: boolean
  /** its share of all tokens in the last 24 h and in the last 7 d (none when nothing was used) */
  share: { h24?: number; d7?: number }
  quota?: QuotaFigure
  /** the provider's quota read as quotas.ts has it (none for a provider with no read of its own) */
  quotaRead?: QuotaRead
  models: SummaryModel[]
}
/** a rule-based warning about the settings or the providers, with its fix in words; go opens the cell that changes it
 *  (a row's place and a slot's id, as the table names them) */
export interface SummaryWarning {
  id: string
  level: 'risk' | 'note'
  words: string
  fix?: string
  go?: { row: string; slot: string }
}
export interface ModelsSummary {
  at: number
  /** when the logs were read once from their start (the backfill); none while it runs */
  backfilled?: number
  providers: SummaryProvider[]
  warnings: SummaryWarning[]
  /** models.maxAtOnce as each level holds it (its text, '' for none), and the machine's place id a write goes to: the
   *  cap editors write the entries at the level they pick */
  caps: { all: string; machine: string; place: string; spaces: SummarySpaceText[] }
}

/** Settings → Limits (limits-view.ts): every limit this machine holds, at each level it is set, with the numbers now. A
 *  cell is one setting in one row (Everywhere, this machine, or a space): its control as Settings draws it (`row`, with
 *  the value its level reads), where that value comes from, and the live number beside it. Its writes are the setting
 *  action at `place` */
export interface LimitCell {
  key: string
  /** the place its write goes to: all (Everywhere), m:<host> (this machine), p:<host>:<space> (a space) */
  place: string
  /** the control: its label and kind as Settings has them, the value its level reads */
  row: SettingRow
  from: MatrixValue['from']
  /** set at this level itself (strong), else inherited (faint, with where from) */
  set: boolean
  /** the live numbers beside the value, in words ("7 of 9 working", "load 0.4× cores now") */
  now?: string
}
export interface LimitColumn {
  key: string
  title: string
  hint?: string
}
/** one level's row of a limits table: Everywhere, this machine, or a space, with a cell per column */
export interface LimitRow {
  id: string
  name: string
  kind: 'all' | 'machine' | 'space'
  cells: Record<string, LimitCell>
}
export interface LimitTable {
  columns: LimitColumn[]
  rows: LimitRow[]
}
/** one space's sub-limit under a model or provider column: its own entry, and how many of its runs count under it now */
export interface LimitSpaceCap {
  max: number
  now: number
}
/** a space's row of the Spaces table: its key (the settings' name for it), its tasks working and held now, and its
 *  sub-limits by column (the patterns the columns name) */
export interface LimitSpaceRow extends LimitRow {
  key: string
  working: number
  held: number
  caps: Record<string, LimitSpaceCap>
}
/** the Spaces table: its columns (Max tasks, Merge train), and then one column per pattern a models.maxAtOnce entry names */
export interface LimitSpaces extends LimitTable {
  rows: LimitSpaceRow[]
  patterns: string[]
  /** the machine's total that covers each pattern (its own entry, or its provider's), when one is set: what a space's
   *  sub-limit sits inside */
  totals: Record<string, { pattern: string; max: number }>
}
/** what runs now by role on a provider or a model (the runs that count toward models.maxAtOnce), and the ids of the tasks
 *  among them, in order (none while no task runs there) */
export interface LimitByRole {
  byRole: Partial<Record<MatrixRole, number>>
  tasks?: string[]
}
/** a provider of the Providers table: the summary's row (quota, run-outs, its cap), with what runs by role and its models */
export interface LimitProvider extends Omit<SummaryProvider, 'models'>, LimitByRole {
  models: (SummaryModel & LimitByRole)[]
}
/** a task that waits now, by its id and space (its key, shown as its name), and its line as its row says it */
export interface WaitingTask {
  id: string
  space: string
  words: string
}
/** one group of the Waiting now list: what holds the tasks in it, its limit now, and the tasks */
export interface WaitingGroup {
  id: string
  title: string
  limit?: string
  tasks: WaitingTask[]
}
/** what holds work now (limits-view.ts): the held tasks grouped by what holds them, the advisor's questions and the reviews
 *  that wait for a reviewer */
export interface WaitingNow {
  held: number
  groups: WaitingGroup[]
  advisor: { chat: string; task?: string; words: string }[]
  reviews: { task: string; space: string; words: string }[]
}
/** a pattern the + column can add: a provider, or a model key, with its words */
export interface LimitKnown {
  pattern: string
  name: string
  kind: 'provider' | 'model'
}
export interface LimitsView {
  at: number
  machine: { id: string; name: string; herdr: boolean }
  /** Machine: Everywhere and this machine, the limits to start tasks by (and Merge train when Everywhere sets it) */
  machineTable: LimitTable
  /** Machine, the second group: when this machine's coordinator is told (alerts) */
  alerts: LimitTable
  spaces: LimitSpaces
  /** every provider with an entry, an agent, a run or usage, with its models under it */
  providers: LimitProvider[]
  /** models.maxAtOnce as each level holds it, and the places its writes go to (the summary's cap editors use it) */
  caps: ModelsSummary['caps']
  /** what the + column can add */
  known: LimitKnown[]
  waiting: WaitingNow
}

/** Settings → Models → profiles (server/live/profiles.ts): one setting a profile changes, as the preview and the answer
 *  name it */
export interface ProfileChange {
  /** the level's place id: all (Everywhere), m:<host> (this machine) or p:<host>:<space> */
  place: string
  /** the level in words: Everywhere, this machine's name, or the space's name */
  where: string
  key: string
  /** the setting in words: "Tasks · Primary · Agent", "Max tasks" */
  label: string
  /** its value now, and the one the profile gives (null: not set at that level) */
  now: string | null
  then: string | null
}
/** a change a profile would make that the setting refuses, with why */
export interface ProfileRefusal extends ProfileChange {
  error: string
}
/** one schedule of a profile (profile-schedule.ts), as the screen and the command line show it */
export interface ProfileScheduleRow {
  id: string
  /** its rule in words: "Every day at 22:00 (Madrid)" */
  words: string
  /** the time and days the editor shows: every day when days is null, else 0 for Monday to 6 for Sunday */
  form?: { time: string; days: number[] | null }
  /** also the tasks already created take the profile's task and reviewer settings */
  waiting: boolean
  on: boolean
  /** its next run in words, when it is on: "Today 22:00" */
  next?: string
  /** its last run in words: "Applied Today 22:00", "Not applied Tomorrow 8:00" */
  last?: string
}
export interface ProfileSummary {
  name: string
  /** holds Max tasks and Merge train as well as the models */
  limits: boolean
  saved: number
  applied?: number
  /** its schedules, in the order they were made */
  schedules?: ProfileScheduleRow[]
}
/** the profiles bar: what is saved, what the settings match now, and the undo point an undo restores */
export interface ProfilesView {
  profiles: ProfileSummary[]
  /** the next two scheduled applies, in words: "Next: night at 22:00, then day at 08:00" */
  next?: string
  /** the profile the settings match now (the last one applied first), or Custom */
  active: string
  /** the last apply: its profile, when (the bar says Changed since when the settings no longer match it) */
  last?: { name: string; at: number }
  /** the undo point the next undo restores, with its words: Before night, 13 Nov, 01:05 */
  undo?: { name: string; at: number; label: string }
  /** why profiles are not kept here: a worker keeps none, the main machine does */
  unavailable?: string
}
/** what applying a profile would change, and what would hold it back (a refused setting: then nothing is applied) */
export interface ProfilePreview {
  ok: boolean
  error?: string
  name?: string
  changes: ProfileChange[]
  refused: ProfileRefusal[]
  /** saved spaces that are no longer spaces: their values are skipped */
  skipped: string[]
  /** spaces added since the save: applying leaves them as they are */
  added: string[]
}

export interface Alert {
  id: string
  from: string
  title: string
  body: string
  /** where tapping it goes; focus: the message or card (by its id, or its question's) brought into view and lit up */
  go: { place: string; task?: string; focus?: string }
  /** one alert per task (its id) or coordinator question: a newer one with the same tag takes the old one's place */
  tag?: string
  /** the card it is about: where a device shows buttons on alerts, they answer it */
  card?: { chat: string; question: string; choices: { label: string; choice: number }[] }
  /** a new message in a coordinator's chat, nothing more: it buzzes only where Notify is All */
  message?: true
  /** about a task (from its agent, or what it needs): it buzzes whatever its place's Notify, which is its coordinator's */
  task?: true
}

/** A folder on a machine, for adding a space from the sidebar (home only) */
export interface FolderEntry {
  name: string
  /** as the human writes it: ~/dev/shepherdr */
  path: string
  /** has its own .git */
  repo: boolean
  /** a space already */
  added?: boolean
}

/** What a typed path is on that machine, and the folders in it */
export interface Folders {
  path: string
  exists: boolean
  /** a folder (not a file) */
  dir: boolean
  /** the repo it is in (its top folder), if any */
  repo: string | null
  added?: boolean
  entries: FolderEntry[]
  /** more folders than listed */
  more?: boolean
  /** at home: repos it likely is, the latest worked in first */
  likely?: FolderEntry[]
}

/** Adding a space from the sidebar: an existing repo, or (create) a new one made there first; its name as given */
export interface AddSpace {
  machine: string
  path: string
  name?: string
  create?: boolean
}

/* ---------- a task's worktree, read only, for its side panel ---------- */

/** the files in a task's worktree: tracked ones and new ones git doesn't ignore */
export interface TreeFiles {
  files: string[]
  /** more files than listed */
  more?: boolean
}

/** one file of a task's worktree */
export interface FileText {
  path: string
  size: number
  text?: string
  binary?: boolean
  /** only its start is shown */
  tooBig?: boolean
}

/** one file a task changed against its base */
export interface DiffFile {
  path: string
  /** a renamed file's old path */
  from?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  /** lines added and taken out */
  add: number
  del: number
  binary?: boolean
}

/** what a task changed against its base (main): committed or not */
export interface Diff {
  base: string
  files: DiffFile[]
  add: number
  del: number
}

/** one changed file's unified diff */
export interface Patch {
  path: string
  text: string
  binary?: boolean
  tooBig?: boolean
}

export interface PrCheck {
  name: string
  state: 'pass' | 'fail' | 'pending' | 'skip'
  url?: string
}

/** a task's pull request on GitHub */
export interface PullRequest {
  number: number
  title: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  url: string
  checks: PrCheck[]
}

/** what the side panel asks of a task's worktree */
export type WorktreeAsk = { task: string } & ({ what: 'files' } | { what: 'file'; path: string } | { what: 'diff' } | { what: 'patch'; path: string } | { what: 'pr' })

export interface Snapshot {
  name: string
  host: string
  /** every space, in the sidebar's order: each machine's home space first */
  places: Place[]
  /** the machines, as headings over their spaces, in the sidebar's order */
  machines: Machine[]
  tasks: Task[]
  automations: Record<string, Automation[]>
  /** every artifact, of every machine */
  artifacts: Artifact[]
  /** open coordinator questions, by place id (a choice card's id, or "blocked" on the CLI's own menu): counted as waiting on you */
  asks: Record<string, string>
  /** everything waiting on the human, oldest first, each once: what the Needs you view lists and every count counts */
  needs: Need[]
  /** the same needs by chat, oldest first: kept filled for plugins written for it and for machines on an older
   *  version (read `needs`: it is what the screen draws) */
  attentionRequests?: Record<string, string[]>
  settings: SettingSection[]
  /** a source like demo marks its data as fictional */
  demo?: boolean
  /** where the human's name in chat lines comes from */
  user: string
  /** when each chat (by its key) last had something new from its agent or Shepherdr (ms): it shows bold until read */
  last?: Record<string, number>
  /** how far you have read each chat (ms), the same on every device; '*': since when read marks are kept, so anything
   *  older counts as read */
  read?: Record<string, number>
  /** the sidebar's sections, as Slack's, each with its spaces in the human's order: the top ones first (Pinned, id
   *  'pinned', among them), then each machine's, its machine in order (shared/order.ts) */
  sections?: Section[]
}

export type Action =
  /** cid: the screen's own id for what it sent, which comes back on the message (Message.cid); reply: the id of the
      message it answers */
  /** space: sent from a needs-you card in that space's chat (CardAsk) */
  | { type: 'send'; chat: string; text: string; attachments?: string[]; cid?: string; reply?: string; space?: string }
  | { type: 'react'; chat: string; message: string; emoji: string }
  /** a secret kept at a level (all, m:<machine>, p:<machine>:<space>), or removed (null); kept on the main machine, so
      it names no chat or place to be passed on by. card: the agent's ask it answers, told once it is kept */
  | { type: 'secret'; level: string; name: string; value: string | null; card?: { chat: string; id: string } }
  /** the main machine kept a secret an agent asked for: its card says so, and its agent is told (no value) */
  | { type: 'secret-saved'; chat: string; card: string; name: string; level: string }
  /** fromAlert: a notification's button, which answers only the card the chat still waits on (an old alert's can't
      answer what came after, or a card already settled in words) */
  /** dismiss: the card closed without an answer (its Dismiss, or Esc on it) instead of a pick */
  | { type: 'answer'; chat: string; question: string; choice: number; choices?: number[]; note?: string; other?: string; fromAlert?: boolean; space?: string; dismiss?: boolean }
  /** the advisor answers this open question (Settings → Agents → Advisor): its suggestion comes back as a card to send or not */
  | { type: 'advise'; chat: string; question: string; note?: string }
  | { type: 'page-send'; chat: string; page: string; text: string }
  | { type: 'page-note'; chat: string; page: string; note: string; target?: string }
  /** an artifact's page sent something, you noted on it, or wrote about it in its viewer: to its keeper. By its place,
      so another machine's goes there */
  | { type: 'artifact-send'; place: string; artifact: string; v: number; text: string }
  | { type: 'artifact-note'; place: string; artifact: string; v: number; note: string; target?: string }
  | { type: 'artifact-say'; place: string; artifact: string; v: number; text: string }
  | { type: 'artifact-delete'; place: string; artifact: string }
  /** Mark up's notes from the shared browser, sent together into the task's chat */
  | { type: 'browser-notes'; chat: string; url: string; title?: string; viewport?: { w: number; h: number }; notes: BrowserNote[] }
  | { type: 'mode'; place: string; mode: Mode }
  /** Autopilot's Run now: wake that place's coordinator once, now (or as soon as its turn is over); refused while a
      wake waits or runs, and never for another machine's place */
  | { type: 'heartbeat'; place: string; op: 'run' }
  /** a project's automation: pause or go on, run now, remove. Only agents add or change one, through the command. By
      its place, so another machine's goes there */
  | { type: 'automation'; place: string; op: 'pause' | 'resume' | 'run' | 'remove'; name: string }
  | { type: 'model'; chat: string; model: string }
  | { type: 'effort'; chat: string; effort: string }
  | { type: 'keys'; chat: string; keys: string[] }
  | { type: 'text'; chat: string; text: string }
  | { type: 'call'; chat: string; on: boolean }
  /** place: the level it is set at, as a place id (all when none); a machine's or project's goes to that machine */
  | { type: 'setting'; key: string; value: string | null; place?: string }
  /** a task agent Setting (task.agent, task.model, task.effort) changed at a level (place: a space, this machine, or none
   *  for Everywhere): the waiting tasks it reaches take what Settings name for their space, as Start with… gives each
   *  (engine retuneWaiting). dry: the counts only, for the question asked first. Running tasks keep their agent */
  | { type: 'apply-to-waiting'; key: string; place?: string; dry?: boolean }
  /** Settings → Models: every level's model settings as one table (read only; the writes are the setting action) */
  | { type: 'models-matrix' }
  /** Settings → Models → Summary: per provider and model, what they run, use and ran out of, and the warnings (read only) */
  | { type: 'models-summary' }
  /** Settings → Limits: every limit of this machine at each level, the spaces' and the providers' caps, what waits and why (read only) */
  | { type: 'limits-view' }
  /** Settings → Models → Quotas: read each quota now, at most once a minute per provider (quotas.ts refresh) */
  | { type: 'quota-refresh' }
  /** Settings → Models → profiles: the saved profiles and what the settings match now (read only) */
  | { type: 'profiles' }
  /** save the current settings as a profile: the models, and the limits (Max tasks, Merge train) when limits is set;
   *  a name that is saved already is replaced only with force (the screen asks first) */
  | { type: 'profile-save'; name: string; limits?: boolean; force?: boolean }
  /** what applying a profile would change now (read only) */
  | { type: 'profile-preview'; name: string }
  /** apply a profile: all of it or none (a refused setting stops it); an undo point is kept first */
  | { type: 'profile-apply'; name: string }
  /** put back what the last apply changed, where it still reads as the apply left it */
  | { type: 'profile-undo' }
  /** a profile's schedule: a new one (no id: its rule as words or a time rule, waiting tasks and on or off), or a change
   *  of one (its id: any of those); the main machine only */
  | { type: 'profile-schedule'; name: string; id?: string; rule?: string; waiting?: boolean; on?: boolean }
  | { type: 'profile-schedule-remove'; name: string; id: string }
  | { type: 'profile-rename'; name: string; to: string }
  | { type: 'profile-delete'; name: string }
  /** archive a task (on: true; its agent stops first) or bring it back; chat is its agent's key (ID/Agent) */
  | { type: 'archive'; chat: string; on: boolean }
  /** pin a task to the top of its lists (on: true) or unpin it */
  | { type: 'pin'; chat: string; on: boolean }
  /** pause a working task: its agent is interrupted (it stays alive) and the task is To do until written to */
  | { type: 'pause'; chat: string }
  /** stop a task: its agent and space close, it is To do and its work stays, until written to */
  | { type: 'stop'; chat: string }
  /** Send now on a message its CLI holds in its own queue: Claude Code's Ctrl+Enter, pressed only while its screen
   *  offers it */
  | { type: 'steer'; chat: string }
  /** what the restart sheet shows for a coordinator (chat: its place id) or a task's agent (ID/Agent): RestartInfo */
  | { type: 'restart-info'; chat: string }
  /** start a coordinator or a task's agent again on this CLI, model and effort (none: the CLI's own; no kind: all as
      Settings say for its role); save: as its space's Settings for its role too */
  | { type: 'restart'; chat: string; kind?: string; model?: string; effort?: string; save?: boolean }
  /** start a task that waits now, first in line (on a worker of the human's choosing, for it alone) */
  | { type: 'start-now'; chat: string; kind?: string; model?: string; effort?: string }
  /** the worker a task that waits starts on, for it alone, when its turn comes: it stays in line as it is */
  | { type: 'start-with'; chat: string; kind: string; model?: string; effort?: string }
  /** every coordinator of this machine's spaces whose agent runs on other than what its Settings say now, each started
   *  again as a single restart does (never a task's agent, never another machine's place): the lines, and the counts */
  | { type: 'restart-all' }
  /** pin a model to the top of its CLI's lists (on: false unpins it), on the machine that owns this chat (its picks are
      the machine's own): the answer is that CLI's pins and recents there */
  | { type: 'model-pin'; chat: string; kind: string; model: string; on: boolean }
  /** mark a task done with nothing merged (shepherdr task close); refused (held) while it holds unmerged work, unless force */
  | { type: 'close'; chat: string; force?: boolean }
  /** delete a task: its agent, herdr space, worktree, branch, chat and record; refused while it holds work, unless force */
  | { type: 'delete'; chat: string; force?: boolean }
  /** forget a space (shepherdr space remove): its folder and code stay on disk, its coordinator closes, and its open
      tasks and chat come back if it is added again; refused while one of its tasks is working */
  | { type: 'space-remove'; place: string }
  /** the sidebar's order, dragged by the human: the machines (under 'all'), or one machine's spaces
      (under its id), or a section's (under its id: 'pinned' for Pinned), or the sections at the top ('sections') or in a
      machine ('sections:<machine id>'). Kept by the machine the screen talks to, never sent on to another */
  | { type: 'order'; under: string; ids: string[] }
  /** a space into a section, or back under its machine (to: the machine's id), before another there or last */
  | { type: 'move'; id: string; to: string; before?: string }
  /** a section of the sidebar made (at the top, or inside a machine: its key) or deleted (its spaces go back under their
      machines); renamed with 'rename'. Kept as the order is */
  | { type: 'section'; op: 'new'; name: string; emoji?: string; machine?: string }
  | { type: 'section'; op: 'delete'; id: string }
  /** a machine's or space's name as it shows everywhere ('' gives it back its own); kept by the main machine (id,
      not place: never sent on to another), and nothing else changes: its folder, repo, herdr space and task ids stay */
  /** a machine's or section's emoji too: '' takes it away, none leaves it */
  | { type: 'rename'; id: string; name: string; emoji?: string }
  /** chats you have read, each up to its Snapshot.last as the screen saw it. Kept by the machine the screen talks to,
      never sent on to another */
  | { type: 'read'; chats: Record<string, number> }

/** an agent's terminal as herdr draws it: its recent lines (ANSI), and the pane's size in cells (none from an older
 *  machine) */
export interface TermScreen {
  ansi: string
  cols?: number
  rows?: number
}

export type ServerEvent =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'chat'; chat: Chat }
  | ({ type: 'terminal'; chat: string } & TermScreen)
  | { type: 'offline'; since: number }
  /** the build of the screen the server serves: a screen on another build reloads */
  | { type: 'build'; id: string }
  | { type: 'update'; update: UpdateStatus | null }
  /** the answer to a screen's ping: its link still works */
  | { type: 'pong' }

/** how Shepherdr's last update of itself went (update.json in its folder, written by the supervisor) */
export interface UpdateStatus {
  /** ok: running the newest commit; failed: kept the running version; restarting: about to come back on a new one */
  state: 'ok' | 'failed' | 'restarting'
  /** the commit tried last, and its subject line */
  commit: string
  subject: string
  /** the commit the running build was made from */
  built: string | null
  /** the release folder (in .releases) the server runs from */
  release?: string
  error?: string
  at: number
}
