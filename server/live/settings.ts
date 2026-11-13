// Settings: the app's few defaults, set at three levels: Everywhere, each machine, and each space;
// the most specific one set wins (space > machine > Everywhere > Shepherdr's own). Task agents have none of their
// own: "How tasks work" is the Settings block Shepherdr adds to the end of every new task's brief (prompts.ts
// settingsBlock), who reviews its change among them, and "Agents" is which agent, model and effort each kind of agent
// starts with. A coordinator changes either for one task, in its brief and with task add's flags (--set).
// Settings come in two groups: what agents are told (only words in their prompts) and how Shepherdr runs (the rest).
// The main machine keeps the Everywhere level; a worker for another machine (machines.ts) reads it from the main
// machine's file as it changes, and its shepherdr set for Everywhere is run there.
import { CHAT_KINDS, chatProblem } from './readers/index.ts'
import { cpus, totalmem } from 'node:os'
import { NOTIFY, NOTIFY_DEFAULT, NOTIFY_KEY } from '../../shared/alerts.ts'
import type { SettingRow, SettingSection, TriggerRow } from '../../shared/types.ts'
import { home, readJson, writeJson } from '../store.ts'
import type { SetBy } from '../../shared/brief.ts'
import { settingsBlock, settingsLines, SEVERITIES, type Reviewer, type Said, type Ways } from './prompts.ts'
import { effortFor, effortsOf, findModel, knowsModels, LEVELS, modelsOf } from './models.ts'
import { picksOf, rememberModel } from './model-picks.ts'
import { NO_PICKS, orderByPicks } from '../../shared/picks.ts'
import { formatMaxAtOnce, parseMaxAtOnce, type MaxEntry } from '../../shared/model-caps.ts'
import { eventRules, eventsText, eventWords, nextWords, OWN_ZONE, timeRule, timeWords, validZone, type EventRule } from './trigger.ts'

/** every agent kind herdr can start (interactive chat requires runtime log discovery and a reader) */
const FALLBACK_KINDS = ['pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'letta', 'maki', 'muse']

function herdrKinds(): string[] {
  try {
    const r = Bun.spawnSync(['herdr', 'agent', 'start', '--help'], { stdout: 'pipe', stderr: 'pipe', timeout: 3000 })
    const m = `${r.stdout}${r.stderr}`.match(/possible values: ([^\]]+)\]/)
    const kinds = m?.[1].split(',').map((k) => k.trim()).filter(Boolean)
    if (kinds?.length) return kinds
  } catch {
    /* herdr not on PATH */
  }
  return FALLBACK_KINDS
}

// GitHub Copilot by its full name, not to be taken for the Copilot mode
const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'pi', opencode: 'OpenCode', qodercli: 'Qoder', agy: 'Antigravity', omp: 'Oh My Pi', mastracode: 'Mastra Code', copilot: 'GitHub Copilot' }
const nameOf = (kind: string) => NAMES[kind] ?? kind[0].toUpperCase() + kind.slice(1)
const KINDS = herdrKinds()
// chat-readable kinds first, then the rest as herdr lists them
const ORDER = [...CHAT_KINDS, ...KINDS.filter((k) => !CHAT_KINDS.includes(k))].filter((k) => KINDS.includes(k))

export const CLIS: string[] = ORDER.map(nameOf)
export const CHAT_CLIS = ORDER.filter((kind) => CHAT_KINDS.includes(kind)).map(nameOf)
export const KIND: Record<string, string> = Object.fromEntries(ORDER.map((k) => [nameOf(k), k]))
export const CLI_NAME: Record<string, string> = Object.fromEntries(ORDER.map((k) => [k, nameOf(k)]))

/** a CLI by its name or its herdr kind, any case ("Codex", "codex"): its kind */
export function kindOf(cli: string): string | undefined {
  const c = cli.trim().toLowerCase()
  return ORDER.find((k) => k === c || nameOf(k).toLowerCase() === c)
}

/** the effort words a setting may hold: each CLI and model takes its own few of them (models.ts), the rest becoming the
 *  nearest it has */
export const EFFORTS = ['default', ...LEVELS]

export { effortFor }

/** the CLIs a brief's Review line may suggest for a task's review */
export const REVIEWERS = ['Codex', 'Claude Code', 'pi', 'OpenCode']

/** Autopilot's heartbeat (Settings → Autopilot): its trigger, a time rule as kept ('off': none) and the news that
 *  wakes it at once, and the time zone of every time rule */
export interface Heartbeat {
  time: string
  on: EventRule[]
  zone: string
}

/** Autopilot's heartbeat by default: every 30 minutes, all day */
export const HEARTBEAT_RULE = timeRule('FREQ=MINUTELY;INTERVAL=30')

/** the heartbeat's few ready-made rules in Settings; anything else, the coordinator writes */
export const HEARTBEAT_PRESETS = [
  { label: '15 min', value: timeRule('FREQ=MINUTELY;INTERVAL=15') },
  { label: '30 min', value: HEARTBEAT_RULE },
  { label: '1 hour', value: timeRule('FREQ=HOURLY') },
  { label: 'Workdays', value: timeRule('FREQ=MINUTELY;INTERVAL=30;BYHOUR=8,9,10,11,12,13,14,15,16,17;BYDAY=MO,TU,WE,TH,FR') },
]

/** the news that wakes a coordinator on Autopilot at once, ready-made: all of it, or none (it waits for the heartbeat) */
const NEWS_PRESETS = [
  { label: 'All news', value: 'all news' },
  { label: 'None: it waits', value: 'none' },
]

/** the agents Settings picks a CLI, model and effort for */
type Role = 'task' | 'coordinator' | 'reviewer' | 'backup'

/** where a CLI, its model and its effort are set: a role's own three; each agent backup's own three (Agents → Tasks or
 *  Coordinators → Backups, the tasks' backup on task.fallback and the coordinators' on coordinator.fallback), so that each
 *  starts on a model its own CLI has; or a backup reviewer's (How tasks work → Reviewer → Backups), its own three so that
 *  neither reviewer replaces the other */
type Pair = { cli: string; model: string; effort: string }

/**
 * Each role's backups, in order: a chain. Backup 1 is the pair the role always had (task.fallback, coordinator.fallback,
 * reviewer.fallback, advisor.fallback and theirs); the 2nd to the 5th have three keys each, `<role>.fallback<n>`,
 * `<role>.fallback<n>Model` and `<role>.fallback<n>Effort`, off until the human adds one. One that is off is skipped. The
 * next one takes over where the one before it can't go on either (engine.ts cantGoOn, source.ts coordinatorCantGoOn,
 * the brief's Reviewer line, source.ts advise); the way back still asks the primary alone (return.ts).
 */
export const MAX_BACKUPS = 5
export type Chain = 'task' | 'coordinator' | 'reviewer' | 'advisor'
const CHAINS: Chain[] = ['task', 'coordinator', 'reviewer', 'advisor']
const EXTRA = [2, 3, 4, 5] as const
type ExtraName = `${Chain}${(typeof EXTRA)[number]}`
const FIRST_BACKUP = { task: 'backup', coordinator: 'coordinatorBackup', reviewer: 'reviewBackup', advisor: 'advisorBackup' } as const
const extraPair = (c: Chain, n: number): Pair => ({ cli: `${c}.fallback${n}`, model: `${c}.fallback${n}Model`, effort: `${c}.fallback${n}Effort` })

type PairName = Role | 'reviewBackup' | 'coordinatorBackup' | 'advisor' | 'advisorBackup' | ExtraName
const PAIRS: Record<PairName, Pair> = {
  ...(Object.fromEntries(CHAINS.flatMap((c) => EXTRA.map((n) => [`${c}${n}`, extraPair(c, n)]))) as Record<ExtraName, Pair>),
  task: { cli: 'task.agent', model: 'task.model', effort: 'task.effort' },
  coordinator: { cli: 'coordinator.agent', model: 'coordinator.model', effort: 'coordinator.effort' },
  reviewer: { cli: 'reviewer.agent', model: 'reviewer.model', effort: 'reviewer.effort' },
  backup: { cli: 'task.fallback', model: 'backup.model', effort: 'backup.effort' },
  coordinatorBackup: { cli: 'coordinator.fallback', model: 'coordinator.fallbackModel', effort: 'coordinator.fallbackEffort' },
  reviewBackup: { cli: 'reviewer.fallback', model: 'reviewer.fallbackModel', effort: 'reviewer.fallbackEffort' },
  advisor: { cli: 'advisor.agent', model: 'advisor.model', effort: 'advisor.effort' },
  advisorBackup: { cli: 'advisor.fallback', model: 'advisor.fallbackModel', effort: 'advisor.fallbackEffort' },
}

/** a chain's pairs, Backup 1 first */
export const chainNames = (c: Chain): PairName[] => [FIRST_BACKUP[c], ...EXTRA.map((n) => `${c}${n}` as ExtraName)]
/** a chain's pairs with their keys, Backup 1 first */
export const chainPairs = (c: Chain) => chainNames(c).map((name) => ({ name, ...PAIRS[name] }))
/** a role's pairs as the Settings matrix has them: its primary first, then its backups, Backup 1 first */
export const rolePairs = (c: Chain) => [{ name: c as PairName, ...PAIRS[c] }, ...chainPairs(c)]
const chainKeys = (c: Chain) => chainNames(c).map((n) => PAIRS[n].cli)
/** the backup reviewers' CLI keys: off, or one of the CLIs Shepherdr runs headless */
const REVIEWER_BACKUP_KEYS = chainKeys('reviewer')
/** the advisor's CLI keys, its backups' too: off (no advisor), or one of the CLIs Shepherdr runs headless */
const ADVISOR_CLI_KEYS = ['advisor.agent', ...chainKeys('advisor')]
/** a backup's CLI key, of any chain: off, or a CLI kept by its name */
const isBackupCli = (key: string) => isFallback(key) || REVIEWER_BACKUP_KEYS.includes(key) || ADVISOR_CLI_KEYS.includes(key)
/** how long a question waits for the human before it goes to the advisor by itself (advisor.after) */
export const ADVISOR_AFTER = ['off', '1 min', '2 min', '5 min', '10 min', '30 min']

/** the key a backup pair key is read from while it is at default: the coordinators' backup has its own model and effort,
 *  and follows the tasks' pair until the human sets one, so every configuration in use keeps its meaning */
const FOLLOWS: Record<string, string> = { 'coordinator.fallbackModel': 'backup.model', 'coordinator.fallbackEffort': 'backup.effort' }

/** a pair's model (or effort) as it is read: its own, or the key it follows while it is at default (FOLLOWS) */
const pairValue = (get: (key: string) => string, pair: Pair, what: 'model' | 'effort'): string => {
  const own = get(pair[what])
  const up = FOLLOWS[pair[what]]
  return up && own.trim().toLowerCase() === 'default' ? get(up) : own
}

/** the pair a model or effort key belongs to, and which of the two it is */
const pairOfKey = (key: string): { pair: Pair; what: 'model' | 'effort' } | undefined => {
  for (const pair of Object.values(PAIRS)) {
    if (pair.model === key) return { pair, what: 'model' }
    if (pair.effort === key) return { pair, what: 'effort' }
  }
  return undefined
}

/** the role each backup CLI setting backs up: the CLI whose agent can't go on, its backup takes over from */
export const FALLBACK_OF = { task: 'task.fallback', coordinator: 'coordinator.fallback' } as const
/** the CLI keys of the tasks' and the coordinators' backups, every one of their chains: chat CLIs, as the agents they
 *  take over from */
const FALLBACKS: string[] = (['task', 'coordinator'] as const).flatMap((c) => [`${c}.fallback`, ...EXTRA.map((n) => `${c}.fallback${n}`)])
const isFallback = (key: string) => FALLBACKS.includes(key)

/** the CLIs backup agents start on, by these settings: the tasks' backups first, then the coordinators', each once */
export function fallbackKinds(get: (key: string) => string): string[] {
  return [...new Set(FALLBACKS.map((k) => kindOf(get(k))).filter((k): k is string => !!k))]
}

/** a count or a threshold: any number from min to max (step 1: whole numbers), kept with its unit ("7 days", "80%");
 *  off: it may be off too ("off"), zero: 0 is off */
export interface Num {
  min: number
  max: number
  step?: number
  /** the unit after the number, plural and singular ("days", "day"); none: a bare number */
  unit?: string
  one?: string
  off?: boolean
  zero?: boolean
}

type Row = { label: string; key: string; value: string; options?: string[]; ordered?: boolean; ids?: Record<string, string>; text?: boolean; multiline?: boolean; fixed?: boolean; group?: string; sub?: string; num?: Num; hint?: string; warn?: string; chain?: SettingRow['chain'] }

/** the small heading of a role's backups, under the role's own rows: its chain sits in a sub-block of that name */
const BACKUPS = 'Backups'
/** the button that adds the next backup of a chain (src/Settings.tsx) */
const ADD = 'Add a backup'

/** a role's chain of backups, under its own rows (group): Backup 1 first (the rows as given, the CLI first), then the 2nd
 *  to the 5th, each with its Model and Effort. Every row is in the role's Backups sub-block; the 2nd to the 5th show once
 *  they are on, and the screen adds the next one with the button at the sub-block's end (src/Settings.tsx) */
const chainRows = (c: Chain, group: string, first: Row[], clis: readonly string[]): Row[] => [
  ...first.map((r, i) => ({ ...r, group, sub: BACKUPS, chain: { of: c, n: 1, ...(i === 0 ? { cli: true as const, add: ADD } : {}) } })),
  ...EXTRA.flatMap((n) => {
    const p = extraPair(c, n)
    return [
      { group, sub: BACKUPS, label: `Backup ${n}`, key: p.cli, value: 'off', options: ['off', ...clis], hint: 'Off takes it out.', chain: { of: c, n, cli: true as const, add: ADD } },
      { group, sub: BACKUPS, label: `Backup ${n} model`, key: p.model, value: 'default', text: true, chain: { of: c, n } },
      { group, sub: BACKUPS, label: `Backup ${n} effort`, key: p.effort, value: 'default', options: [...EFFORTS], chain: { of: c, n } },
    ]
  }),
]
/** the levels a section's defaults may be set at (all three when none): a machine's capacity has no space level;
 *  alerts and voice are one for all */
type Section = { name: string; about?: string; rows: Row[]; levels?: LevelKind[]; told?: boolean; prompt?: boolean }

/** when this machine's tasks may start, and when its coordinator hears that the machine struggles (health.ts) */
export interface MachineLimits {
  /** tasks at work at once */
  max: number | null
  /** new tasks wait while the 1-minute load is over this many times the cores, or this much memory is in use (%);
   *  none: not limited by load */
  startLoad: number | null
  /** new tasks wait while some task waited for a CPU more than this share of the last minute (%, Linux PSI); none: off */
  startPressure: number | null
  /** minutes between two starts Shepherdr makes by itself (held tasks, the way back); none: as many as there's room for */
  startEvery: number | null
  startMemory: number | null
  /** the coordinator is told when the load stays over this many times the cores for 2 minutes, memory or a disk is
   *  fuller than this (%), or herdr stops answering; null: that one is off */
  alertLoad: number | null
  alertMemory: number | null
  alertDisk: number | null
  alertHerdr: boolean
}

const CORES: Num = { min: 0.1, max: 20, step: 0.05, unit: '× cores' }
const PCT: Num = { min: 1, max: 100, unit: '%' }

const agentRows = (group: string, role: string, cli: string[], model: string, effort: string): Row[] => [
  { group, label: 'Agent', key: `${role}.agent`, value: cli[0], options: cli },
  { group, label: 'Model', key: `${role}.model`, value: model, text: true },
  { group, label: 'Effort', key: `${role}.effort`, value: effort, options: [...EFFORTS] },
]

/** the Settings page of Autopilot's heartbeat */
/** the Settings section of the quota reads and the warning share: drawn on Settings → Models, not as a page */
export const QUOTAS = 'Quotas'
export const AUTOPILOT = 'Autopilot'

/** settings from before review was on or off and waiting for GitHub's checks a way to merge: as they are now */
function upgrade(v: Values): Values {
  const out = { ...v }
  // the heartbeat's interval and quiet hours, from before its trigger: one time rule (heartbeats() made it, with what
  // the levels above set)
  if (out['heartbeat.every'] || out['heartbeat.quiet']) {
    const rule = fromEvery(out['heartbeat.every'] ?? '30 min', out['heartbeat.quiet'] ?? 'off')
    if (rule) out['heartbeat.when'] ??= rule
    delete out['heartbeat.every']
    delete out['heartbeat.quiet']
  }
  if (/^[1-9]\d* rounds?$/.test(out['brief.review'] ?? '')) out['brief.review'] = 'on'
  if (out['brief.waitChecks'] === 'on' && out['brief.merge'] !== 'ask me first') out['brief.merge'] = 'after GitHub checks'
  // when the primary is back: on was its only other value before going back by itself came, and it meant tell me
  if (out['backup.watchReturn'] === 'on') out['backup.watchReturn'] = 'tell me'
  return out
}

/** values kept under their old words: read as today's */
const OLD_VALUES: Record<string, Record<string, string>> = { 'brief.merge': { 'by itself': 'on its own', 'after your yes': 'ask me first' } }

export const CATALOG: Section[] = [
  {
    name: 'Private instructions',
    prompt: true,
    about: 'Personal rules kept outside your repos. Each role follows space → machine → Everywhere; an empty value means no private rules. Adds to team rules; explicit human instructions win. New starts or restarts only. No secrets here.',
    rows: [
      { label: 'Coordinators', key: 'coordinator.instructions', value: '', multiline: true },
      { label: 'Task agents', key: 'task.instructions', value: '', multiline: true },
      { label: 'Reviewers', key: 'reviewer.instructions', value: '', multiline: true },
    ],
  },
  {
    // what Shepherdr adds to the end of every new task's brief
    name: 'How tasks work',
    told: true,
    about: "Each new task's brief ends with these in its Settings block, each as the line shown. To change one for a single task, tell its coordinator.",
    rows: [
      // on: the brief's Review line asks the task's agent for a fresh-eyes review before it merges
      { label: 'Review', key: 'brief.review', value: 'on', options: ['on', 'off'] },
      // the reviewer tags each finding; the agent fixes those at or above this one and reviews again, at most so many
      // rounds, each counted by the agent (shepherdr review) and never more by its own word: its coordinator may add one
      // (engine.reviewMore). What counts as which is the skill's and the reviewer's judgment
      { label: 'Must fix', key: 'review.mustFix', value: 'major', options: [...SEVERITIES] },
      { label: 'Review rounds', key: 'review.rounds', value: '3 rounds', num: { min: 1, max: 10, unit: 'rounds', one: 'round' } },
      // on its own: once its own quick checks pass; GitHub's run on (pull request, main), and main's going red is told
      // to its coordinator (engine.watchMain). After GitHub checks: shepherdr merge waits for them
      { label: 'Merge', key: 'brief.merge', value: 'on its own', options: ['on its own', 'after GitHub checks', 'ask me first'] },
      // a command of the space's own, run in the task's worktree after its rebase and before it goes into main
      // (engine.gate): exit 0 lets it in, anything else stops it. Never a git hook: a hook refusing an update leaves
      // what it would write in the space's checkout, which may be a live service's folder
      { label: 'Merge gate', key: 'merge.gate', value: 'off', text: true, hint: "A command run in the task's worktree after its rebase, before it goes into main (here, not through a pull request): exit 0 lets it in, with its last line in the merge commit; anything else stops the merge, with its output, and main stays as it was. Off: none." },
      // with a merge gate, the first merges in line go in together on one gate run (engine.train)
      { label: 'Merge train', key: 'merge.train', value: 'off', options: ['off', '2', '3', '4', '5'], hint: "With a merge gate, for merges made here (not through a pull request): when several merges wait in line, the first ones, up to this many, go in together on one gate run, each as its own commit with the gate's line. One that conflicts with those before it waits for its own turn. A refusal makes each merge of the train go alone once. Off: one at a time." },
      // only words in the brief's Reviewer line: the task's agent has its change reviewed however it sees fit
      ...agentRows('Reviewer', 'reviewer', [...REVIEWERS], 'default', 'default'),
      // a reviewer that cannot run at all (out of allowance, signed out, its model is gone) leaves its task's agent
      // stuck at that step: a backup reviewer, named in the same Reviewer line, reviews instead. Off until the human
      // sets one: with it off the line reads exactly as it always has. More of them review in turn, each where the one
      // before it cannot run
      ...chainRows(
        'reviewer',
        'Reviewer',
        [
          { label: 'Backup', key: 'reviewer.fallback', value: 'off', options: ['off', ...REVIEWERS] },
          { label: 'Backup model', key: 'reviewer.fallbackModel', value: 'default', text: true },
          { label: 'Backup effort', key: 'reviewer.fallbackEffort', value: 'default', options: [...EFFORTS] },
        ],
        REVIEWERS,
      ),
    ],
  },
  {
    // which agent (CLI), model and effort each kind of agent starts with, and each role's backups under it
    name: 'Agents',
    about: "What each kind of agent starts with. Default is the agent's own model or effort. Each role's backups sit under its own rows: a backup takes over when an agent can't go on, the same CLI again on its backup's model and effort (keeping its session), or another CLI taking over. Each backup has its own model and effort; the coordinators' backup follows the tasks' one until you set its own. When the primary is back applies to every backup. Chat choices need a chat log reader; other installed CLIs cannot show replies here. Headless review is separate.",
    rows: [
      ...agentRows('Tasks', 'task', [...CHAT_CLIS], 'default', 'default'),
      // a backup takes over where a task's or a coordinator's agent can't go on (engine.ts cantGoOn, source.ts
      // cannotGoOn): the same CLI again on the backup's model and effort, keeping its session, or another CLI taking over
      // each takes over in turn: the 2nd where the 1st can't go on either, and so on
      ...chainRows(
        'task',
        'Tasks',
        [
          { label: 'Backup', key: 'task.fallback', value: 'Codex', options: ['off', ...CHAT_CLIS] },
          { label: 'Backup model', key: 'backup.model', value: 'default', text: true },
          { label: 'Backup effort', key: 'backup.effort', value: 'default', options: [...EFFORTS] },
        ],
        CHAT_CLIS,
      ),
      ...agentRows('Coordinators', 'coordinator', [...CHAT_CLIS], 'default', 'default'),
      // the coordinators' own pair, so that it can be on another CLI than the tasks' one and on a model that CLI has
      ...chainRows(
        'coordinator',
        'Coordinators',
        [
          { label: 'Backup', key: 'coordinator.fallback', value: 'off', options: ['off', ...CHAT_CLIS] },
          { label: 'Backup model', key: 'coordinator.fallbackModel', value: 'default', text: true, hint: "While default: the tasks' backup's." },
          { label: 'Backup effort', key: 'coordinator.fallbackEffort', value: 'default', options: [...EFFORTS], hint: "While default: the tasks' backup's." },
        ],
        CHAT_CLIS,
      ),
      // the advisor: a question a task or a coordinator opens for the human can go to it (Ask the advisor on its card),
      // and goes by itself once it has waited this long; it answers questions and choices, never a permission, a plan
      // or what only the human decides (source.ts advise, advisor.ts). One headless run per question, read-only
      { group: 'Advisor', label: 'Advisor', key: 'advisor.agent', value: 'off', options: ['off', ...REVIEWERS], hint: 'Off: no advisor. Answers the questions tasks and coordinators open for you, when you ask it or once one has waited.' },
      { group: 'Advisor', label: 'Model', key: 'advisor.model', value: 'default', text: true },
      { group: 'Advisor', label: 'Effort', key: 'advisor.effort', value: 'default', options: [...EFFORTS] },
      ...chainRows(
        'advisor',
        'Advisor',
        [
          { label: 'Backup', key: 'advisor.fallback', value: 'off', options: ['off', ...REVIEWERS], hint: 'Answers instead where the advisor cannot run at all.' },
          { label: 'Backup model', key: 'advisor.fallbackModel', value: 'default', text: true },
          { label: 'Backup effort', key: 'advisor.fallbackEffort', value: 'default', options: [...EFFORTS] },
        ],
        REVIEWERS,
      ),
      { group: 'Advisor', label: 'Answers for you after', key: 'advisor.after', value: '2 min', options: [...ADVISOR_AFTER], hint: 'A question nobody answered goes to the advisor by itself after this long. Never a permission, a plan, or what only you decide.' },
      // the way back from a backup: the primary is asked, now and then, whether it answers again (source.ts
      // watchReturns, return.ts); go back starts each agent still on the backup again on what Settings name once it is
      // idle, tell me only says so in their chats. A probe is one tiny request of one CLI, never beside work on that model.
      // It applies to every backup above, so it sits under a group of its own, named for what it does
      { group: 'Back to the primary', label: 'When the primary is back', key: 'backup.watchReturn', value: 'go back', options: ['go back', 'tell me', 'off'], hint: 'Applies to every backup above. Asks the primary model now and then whether it answers again. Go back: each agent still on a backup starts again on it once idle, never mid-turn. Tell me: only says so in their chats. Off: never asks.' },
    ],
  },
  {
    // the quota reads (plan-limits.ts, command-code-quota.ts, quota-estimate.ts, quotas.ts) and the share at which Shepherdr
    // warns (quota.alertAt, 4b). Not a page of its own: the Models page draws these rows above its summary (QuotaSettings).
    // Everywhere only. A run-out alerts whatever the warning share is set to
    name: QUOTAS,
    levels: ['all'],
    about: "What Shepherdr reads of each provider's quota, and when it warns. Shown on Settings → Models, above the summary.",
    rows: [
      { label: 'Claude Code', key: 'quota.claude', value: 'on', options: ['on', 'off'], hint: "Claude Code's own /usage, read in a sealed run that changes nothing (needs bubblewrap). Off: no read." },
      { label: 'Command Code', key: 'quota.commandcode', value: 'on', options: ['on', 'off'], hint: 'Command Code\'s own account API, with the key COMMANDCODE_API_KEY from Secrets. Off, or no key: no read.' },
      { label: 'OpenCode Go (estimate)', key: 'quota.opencodeGo', value: 'on', options: ['on', 'off'], hint: "Not read from OpenCode: an estimate from Shepherdr's own ledger, with the lowest limit its run-outs show. Off: no estimate." },
      { label: 'Warn when a provider is at', key: 'quota.alertAt', value: '80%', num: { min: 50, max: 95, unit: '%', off: true }, hint: 'Once a window of a provider reaches this share of its quota, one alert; again once it has refilled. Off: only a run-out alerts.' },
    ],
  },
  {
    // how many of one space's tasks work at once on this machine, inside the machine's own limit (engine.room): a space
    // that matters more may have more of them running. Off: only the machine's limit. Set at any of the three levels,
    // the most specific one that sets it wins (pick)
    name: 'Space',
    about: "How many of a space's tasks work at once on this machine, and how many agents of one model or provider it may run at once. Both work together with the machine's limits (Machine → Max tasks working at once, and Most at once per model or provider at this machine): a task starts only when every one has room. Off: only the machine's limits.",
    rows: [
      { label: 'Max tasks of this space working at once', key: 'space.maxTasks', value: 'off', num: { min: 1, max: 200, off: true }, hint: "Caps this space's working tasks within the machine's own limit, so a space that matters more can have more of them running than the others. Off: only the machine's limit." },
      // per provider or per model. Read at two levels, both applied (model-caps.ts, choose.ts): the machine's own value (Machine,
      // or Everywhere) is the machine's total, and a space's own value (pick: its own, else the machine's) is that space's
      // sub-limit inside it. A space's value never replaces the machine's total.
      { label: 'Most at once per model or provider', key: 'models.maxAtOnce', value: 'off', text: true, hint: `Most agents of one provider or model at once: spark=4 caps every spark model, anthropic/claude-opus-5-5=2 one model (a model's own entry wins). Set at this machine or Everywhere it is the machine's total, for every space together; set for a space, that space's own sub-limit inside it (its own runs only). A task waits for a free slot of its model, and the others start past it. Counts this machine's tasks and coordinators on it; requests from other apps on the same server are not seen. Off: no cap per model.` },
    ],
  },
  {
    // Done tasks put themselves in their place's Archived view this long after they finished (engine.autoArchive)
    name: 'Tasks',
    about: 'Done tasks move to their place\'s Archived list after this long.',
    rows: [{ label: 'Archive Done after', key: 'tasks.archiveAfter', value: '7 days', num: { min: 1, max: 3650, unit: 'days', one: 'day', off: true } }],
  },
  {
    // Autopilot's heartbeat, a trigger (trigger.ts): when its coordinator goes through its HEARTBEAT.md (a time rule),
    // and the news that wakes it at once (event rules; the rest waits for the heartbeat), then the checklist itself (a
    // row of its own at each level, sections). Any limit the human wants is words in the checklist
    name: AUTOPILOT,
    about: 'On Autopilot, a coordinator works on its own within what you asked for, and asks you when unsure. Each heartbeat, it goes through its checklist; the news you pick wakes it at once. Want a limit, such as 5 new tasks a day? Write it in the checklist.',
    rows: [
      { label: 'Heartbeat', key: 'heartbeat.when', value: HEARTBEAT_RULE },
      { label: 'Wakes at once on', key: 'heartbeat.on', value: 'all news' },
    ],
  },
  {
    // each machine's own: when its tasks may start (engine.release holds the rest as Queued) and when its coordinator
    // hears that it struggles (health.ts). Load is the 1-minute load average, in multiples of the machine's cores
    name: 'Machine',
    levels: ['all', 'machine'],
    about: "When a machine starts more tasks, and when its coordinator hears that it struggles. Set one machine's own to fit its cores and memory.",
    rows: [
      { group: 'Working tasks', label: 'Max tasks working at once', key: 'machine.maxTasks', value: '10', num: { min: 1, max: 200 } },
      // the 5-minute load: the 1-minute one swings between a tenth and three times the cores within minutes while builds
      // come and go, so it let tasks start in every lull. CPU pressure (Linux PSI) is the share of time some task waited
      // for a CPU: off unless set (health.ts busy)
      { group: 'Working tasks', label: 'Wait while CPU load is over', key: 'machine.startLoad', value: '1× cores', num: CORES, hint: 'The 5-minute load average, against the cores.' },
      { group: 'Working tasks', label: 'Wait while CPU pressure is over', key: 'machine.startPressure', value: 'off', num: { ...PCT, off: true }, hint: 'The share of the last minute some task spent waiting for a CPU (Linux pressure, /proc/pressure/cpu).' },
      { group: 'Working tasks', label: 'Wait while memory is over', key: 'machine.startMemory', value: '80%', num: PCT },
      // the load averages take minutes to show what a start adds: tasks Shepherdr starts by itself go one at a time
      // (engine.release, source.goBack); one you or a coordinator add starts at once when there is room
      { group: 'Working tasks', label: 'Start one task at most every', key: 'machine.startEvery', value: '2 min', num: { min: 0, max: 30, step: 0.5, unit: 'min', zero: true }, hint: "The tasks Shepherdr starts by itself (held ones, the way back's) go this far apart, so each one's load shows before the next. 0: as many at once as there's room for." },
      { group: 'Tell its coordinator when', label: 'CPU load stays over (2 min)', key: 'machine.alertLoad', value: '1.5× cores', num: { ...CORES, off: true } },
      { group: 'Tell its coordinator when', label: 'Memory is over', key: 'machine.alertMemory', value: '90%', num: { ...PCT, off: true } },
      { group: 'Tell its coordinator when', label: 'Disk is over', key: 'machine.alertDisk', value: '90%', num: { ...PCT, off: true } },
      { group: 'Tell its coordinator when', label: 'herdr stops answering', key: 'machine.alertHerdr', value: 'on', options: ['on', 'off'] },
    ],
  },
  {
    // a task's shared browser closes after this long with no agent command and no one watching it in its Browser panel
    // (browser.ts closeIdle); its sign-ins stay, and the next command or a look starts it again
    name: 'Browser',
    about: "A task's browser closes after this long with no agent using it and no one watching it, so it stops using CPU. Sign-ins stay; the agent's next command or opening the Browser panel starts it again.",
    rows: [{ label: 'Close idle browser after', key: 'browser.idleClose', value: '10 min', num: { min: 1, max: 1440, unit: 'min', off: true } }],
  },
  {
    // what buzzes from each place's coordinator chat (shared/alerts.ts notifies); a machine's or space's own is set from its row's menu
    name: 'Notify',
    about: "Which alerts a place's coordinator chat sends you. All: every new message too. Needs me: its questions and alerts. Off: none, and its row stays quiet. Tasks alert you either way. A place can set its own from its menu in the sidebar.",
    rows: [{ label: 'Notify', key: NOTIFY_KEY, value: NOTIFY_DEFAULT, options: [...NOTIFY] }],
  },
  {
    // the zone every time rule's times are in: Autopilot's heartbeats and automations
    name: 'Time zone',
    levels: ['all'],
    about: 'The time zone of every schedule: heartbeats and automations, on every machine.',
    rows: [{ label: 'Time zone', key: 'time.zone', value: OWN_ZONE, text: true }],
  },
  {
    // talk to type (src/dictation.ts, server/live/dictate.ts): the phone records, the machine that serves Shepherdr
    // writes it down with whisper.cpp. The model is a multilingual one, so one setting writes down Portuguese and
    // English; nothing of the recording is kept
    name: 'Dictation',
    levels: ['all', 'machine'],
    about:
      'Talk to type shows on its own; what it needs is here: whisper.cpp on the machine that serves Shepherdr (sudo apt install whisper.cpp) and a model file. The model is multilingual, so the same setting writes down more than one language; Language is what whisper is told, or Detect it to let it work the language out (a whisper code like es also works). The recording is written down and dropped: nothing of it is kept. Only the machine that serves the web app writes down, so a value set for another machine is not used.',
    rows: [
      { label: 'Model', key: 'dictate.model', value: '~/.local/share/shepherdr-whisper/ggml-base.bin', text: true },
      { label: 'Language', key: 'dictate.language', value: 'Detect it', options: ['Detect it', 'English', 'Portuguese'] },
    ],
  },
  {
    name: 'Alerts and voice',
    levels: ['all'],
    about: 'The same on every machine and space.',
    rows: [
      { label: 'Alerts on', key: 'alerts', value: 'No device yet', options: ['Add this device'] },
      { label: 'Voice agent', key: 'voice.service', value: 'ElevenLabs', options: ['ElevenLabs'] },
    ],
  },
]

/** the CLI a pair's agent runs, by these settings: its herdr kind; nothing for a backup that is off */
const roleKind = (role: PairName, get: (key: string) => string): string | undefined =>
  kindOf(get(PAIRS[role].cli)) ?? (role === 'task' || role === 'coordinator' || role === 'reviewer' ? 'claude' : undefined)

/** a role's Model and Effort rows as its CLI has them, by these settings (r.value is the row's own): a pick of its
 *  models and of the levels its model takes, each showing what it starts with (a level the model lacks shows as the
 *  nearest it has); a CLI that can't list its models takes any id; one Shepherdr passes neither to picks its own. The
 *  models are this machine's picks first (pinned, then recent), then the CLI's own order. Each pair of keys takes the CLI
 *  its own cli key names: a role's agent, or one of the two backups' own, so each backup offers what its own CLI has. */
export function agentRow(r: Row, get: (key: string) => string, picksOfKind: (kind: string) => { pinned: string[]; recent: string[] } = picksOf): Row {
  // only a role's own model and effort, or a backup's, are a pick of a CLI's: dictate.model, say, is free text
  const own = pairOfKey(r.key)
  if (!own) return r
  const kind = kindOf(get(own.pair.cli))
  const c = kind ? modelsOf(kind) : undefined
  // nothing to choose: a row too, and no hint about what it would follow (there is no CLI to follow it on)
  if (!kind || !c) return { ...r, value: kind ? `${CLI_NAME[kind] ?? kind}'s own` : 'off', fixed: true, text: false, hint: undefined }
  const what = own.what
  const stored = pairValue(get, own.pair, 'model')
  const model = findModel(kind, stored)
  if (what === 'model') {
    if (!c.models.length) return { ...r, value: stored }
    const picks = picksOfKind(kind)
    // an older model it still takes by id stays on offer while it is pinned or was picked, as in the restart sheet
    const saved = (c.others ?? []).filter((m) => picks.pinned.includes(m.id) || picks.recent.includes(m.id))
    const ordered = orderByPicks([...c.models, ...saved], picks)
    const labels = ordered.map((m) => m.label)
    const ids = Object.fromEntries(ordered.map((m) => [m.label, m.id]))
    // what it starts on, when that is a model the CLI no longer lists: still offered, to be replaced
    if (model && !labels.includes(model.label)) {
      labels.push(model.label)
      ids[model.label] = model.id
    }
    return { ...r, text: false, value: model?.label ?? 'default', options: ['default', ...labels], ordered: true, ids }
  }
  const levels = effortsOf(kind, stored)
  if (!levels.length) return { ...r, value: 'none', fixed: true, hint: undefined }
  return { ...r, value: effortFor(kind, r.value, stored) ?? 'default', options: ['default', ...levels] }
}

const ROWS = CATALOG.flatMap((s) => s.rows)
const KEYS = ROWS.map((r) => r.key)

/** the choices a setting offers, as its row of Settings has them (undefined for a free value or an unknown key) */
export const optionsOf = (key: string): string[] | undefined => ROWS.find((r) => r.key === key)?.options

export function defaultOf(key: string) {
  return ROWS.find((r) => r.key === key)?.value
}

/** the model a role's backup starts on, and the Settings row it is set in: the coordinators' backup has its own pair, and
 *  follows the tasks' one while that is at default (a model its CLI doesn't have is no takeover: engine.backupFor) */
export function backupModelOf(role: 'task' | 'coordinator', get: (key: string) => string): { model: string; row: string } {
  const pair = PAIRS[role === 'task' ? 'backup' : 'coordinatorBackup']
  const model = pairValue(get, pair, 'model')
  const follows = role === 'coordinator' && get(pair.model).trim().toLowerCase() === 'default' && model.trim().toLowerCase() !== 'default'
  return { model, row: role === 'task' || follows ? 'Tasks → Backup model' : 'Coordinators → Backup model' }
}

/** a level defaults are set at: Everywhere, this machine, or one of its spaces */
export type LevelKind = 'all' | 'machine' | 'space'
export type Level = 'all' | 'machine' | { space: string }

const kindOfLevel = (l: Level): LevelKind => (typeof l === 'string' ? l : 'space')
const levelsOf = (key: string): LevelKind[] => CATALOG.find((s) => s.rows.some((r) => r.key === key))?.levels ?? ['all', 'machine', 'space']

type Values = Record<string, string>
export interface Stored {
  everywhere: Values
  machine: Values
  spaces: Record<string, Values>
}

/** the defaults you set, at their levels */
export class Settings {
  /** the folder it reads and writes, taken when it is made: a test's world keeps its own, whatever comes after it */
  private dir = home()
  private d: Stored

  /** seed: these values, kept only in memory (the demo's) */
  constructor(private seed?: Stored) {
    const raw = (seed ?? readJson<Record<string, unknown>>('settings.json', {}, this.dir)) as Record<string, unknown>
    const keep = (v: unknown) => Object.fromEntries(Object.entries(upgrade((v ?? {}) as Values)).filter(([k, x]) => KEYS.includes(k) && typeof x === 'string' && !refuse(k, x))) as Values
    if (raw.everywhere) {
      // the space level was the project level before spaces came (read here too: Settings may start before migrate.ts)
      const spaces = (raw.spaces ?? raw.projects ?? {}) as Record<string, unknown>
      heartbeats([raw.everywhere as Values, (raw.machine ?? {}) as Values], Object.values(spaces) as Values[])
      this.d = { everywhere: keep(raw.everywhere), machine: keep(raw.machine), spaces: Object.fromEntries(Object.entries(spaces).map(([k, v]) => [k, keep(v)])) }
      // settings no longer kept (Autopilot's old limits and wake picks) leave the file too
      if (JSON.stringify(this.d) !== JSON.stringify(raw)) this.save()
      return
    }
    // settings.json once held one level, set Everywhere (and before that scopes, many task settings and one CLI for
    // every agent): its values go to All machines, but a machine's capacity was each machine's own and stays so
    const all = (typeof raw.all === 'object' && raw.all ? raw.all : raw) as Record<string, unknown>
    const one = all.agent ?? all['coordinator.agent'] ?? (typeof all['worker.agent'] === 'string' ? all['worker.agent'].split(' · ')[0] : undefined)
    if (typeof one === 'string') {
      all['task.agent'] ??= one
      all['coordinator.agent'] ??= one
    }
    for (const [k, old] of Object.entries(OLD_VALUES)) if (typeof all[k] === 'string' && old[all[k]]) all[k] = old[all[k]]
    const old = keep(all)
    const mine = (k: string) => k.startsWith('machine.')
    this.d = {
      everywhere: Object.fromEntries(Object.entries(old).filter(([k]) => !mine(k))),
      machine: Object.fromEntries(Object.entries(old).filter(([k]) => mine(k))),
      spaces: {},
    }
  }

  private save() {
    if (!this.seed) writeJson('settings.json', this.d, this.dir)
  }

  /** the values set at one level */
  private at(l: Level): Values {
    return l === 'all' ? this.d.everywhere : l === 'machine' ? this.d.machine : (this.d.spaces[l.space] ?? {})
  }

  /** a key's value at a level and where it comes from: that level, one above it, or Shepherdr's own default */
  pick(key: string, l: Level = 'machine'): { value: string; from: LevelKind | 'default' } {
    const ok = levelsOf(key)
    const chain: Level[] = l === 'all' ? ['all'] : l === 'machine' ? ['machine', 'all'] : [l, 'machine', 'all']
    for (const x of chain) {
      const v = ok.includes(kindOfLevel(x)) ? this.at(x)[key] : undefined
      if (v !== undefined) return { value: v, from: kindOfLevel(x) }
    }
    return { value: defaultOf(key) ?? '', from: 'default' }
  }

  /** a key's value as it is read, and where it comes from: a backup key at default reads the key it follows (FOLLOWS),
   *  and says which (rows, shepherdr show) */
  readAt(key: string, l: Level = 'machine'): { value: string; from: LevelKind | 'default'; follows?: string } {
    const p = this.pick(key, l)
    const up = FOLLOWS[key]
    if (!up || p.value.trim().toLowerCase() !== 'default') return p
    const q = this.pick(up, l)
    return q.value.trim().toLowerCase() === 'default' ? p : { ...q, follows: up }
  }

  /** a key's value for a space of this machine (none: the machine's own) */
  get(key: string, space?: string): string {
    return this.pick(key, space ? { space } : 'machine').value
  }

  /** set (or with null, unset) a value at a level (Everywhere when none); refused values say why */
  set(key: string, value: string | null, l: Level = 'all'): { ok: boolean; error?: string } {
    if (!KEYS.includes(key)) return { ok: false, error: `No setting ${key}` }
    if (!levelsOf(key).includes(kindOfLevel(l))) return { ok: false, error: levelsOf(key).includes('machine') ? `${key} is set Everywhere or for one machine, not a space.` : `${key} is set Everywhere only.` }
    if (value !== null) {
      const chat = key === 'task.agent' || key === 'coordinator.agent' || (isFallback(key) && value.trim().toLowerCase() !== 'off')
      const err = refuse(key, value) ?? (chat ? chatProblem(kindOf(value) ?? value) : undefined) ?? this.unfit(key, value, l)
      if (err) return { ok: false, error: err }
      const num = numOf(key)
      // a number is kept with its unit, however it was written ("13", "1.5x", "80 %")
      if (num) value = numValue(num, value)!
      else if (key === 'heartbeat.when') value = timeRule(value)
      else if (key === 'heartbeat.on') value = eventsText(eventRules(value))
      else if (key === 'time.zone') value = value.trim()
      else if (key === 'models.maxAtOnce') {
        const cap = parseMaxAtOnce(value)
        value = cap.ok ? formatMaxAtOnce(cap.entries) || 'off' : value
      }
      // a CLI is kept by its name, however it was written
      else if (isBackupCli(key) && value.trim().toLowerCase() === 'off') value = 'off'
      else if (key.endsWith('.agent') || isBackupCli(key)) value = CLI_NAME[kindOf(value)!]
    }
    const at = typeof l === 'object' ? (this.d.spaces[l.space] ??= {}) : this.at(l)
    if (value === null) delete at[key]
    else at[key] = value
    if (typeof l === 'object' && !Object.keys(at).length) delete this.d.spaces[l.space]
    this.save()
    // a model chosen here is one of the human's picks: first among the recent ones in every model list (a world of its
    // own, the demo's, keeps its picks to itself)
    const own = pairOfKey(key)
    if (!this.seed && value !== null && own?.what === 'model') {
      // the tasks' backup model is one the tasks' backup CLI has, and the coordinators' one while it follows it; the
      // coordinators' own model, one its own backup CLI has
      const kinds =
        own.pair === PAIRS.backup
          ? [this.kindOf('backup', l), this.pick(PAIRS.coordinatorBackup.model, l).value.trim().toLowerCase() === 'default' ? this.kindOf('coordinatorBackup', l) : undefined]
          : [kindOf(this.pick(own.pair.cli, l).value)]
      for (const kind of kinds) {
        const picked = kind ? findModel(kind, value) : undefined
        if (kind && picked) rememberModel(kind, picked.id)
      }
    }
    return { ok: true }
  }

  /** the picks a role's model rows lead with: this machine's, or none for a world of its own (the demo's) */
  picksAt(kind: string) {
    return this.seed ? NO_PICKS : picksOf(kind)
  }

  /** a copy of every level's values, to try writes on (a dry run, profiles.ts): it never reaches this one or the file */
  copy(): Settings {
    return new Settings(structuredClone(this.d))
  }

  /** the Everywhere level, as the main machine hands it to the others */
  everywhere(): Values {
    return { ...this.d.everywhere }
  }

  /** take the main machine's Everywhere level (this one is not the main one) */
  adopt(all: Values) {
    // read as today's words, as a level loaded from settings.json is: the main machine may run older code
    const next = Object.fromEntries(Object.entries(upgrade(all)).filter(([k, v]) => KEYS.includes(k) && typeof v === 'string' && !refuse(k, v)))
    if (JSON.stringify(next) === JSON.stringify(this.d.everywhere)) return false
    this.d.everywhere = next
    this.save()
    return true
  }

  /** the CLI a pair's agent runs at a level (a role's own, or a backup's): its herdr kind; nothing for an unset backup */
  kindOf(role: PairName, l: Level = 'machine'): string | undefined {
    return roleKind(role, (k) => this.pick(k, l).value)
  }

  /** the CLIs that read a pair's model (or effort) at a level and the levels below it (unfit): what is set there has to
   *  fit a backup that will use it, a space's own included. A role's own pair is its CLI's at that level; the tasks'
   *  backup pair is read by their backup, and by the coordinators' while theirs is at default (FOLLOWS); the
   *  coordinators' own pair only where their backup has one of its own */
  private pairKinds(pair: Pair, what: 'model' | 'effort', l: Level): string[] {
    if (pair !== PAIRS.backup && pair !== PAIRS.coordinatorBackup) return [kindOf(this.pick(pair.cli, l).value)].filter((k): k is string => !!k)
    const at: Level[] = l === 'all' ? ['all', 'machine'] : [l]
    const spaces: Level[] = l === 'all' || l === 'machine' ? Object.keys(this.d.spaces).map((space) => ({ space }) as Level) : []
    const kinds = [...at, ...spaces].flatMap((x) => {
      // only a level that will read this value has to fit it: one whose own key is stored would win over it
      if (x !== l && !this.readsAt(x, l, pair[what])) return []
      const get = (k: string) => this.pick(k, x).value
      // the tasks' pair is read by their backup, and by the coordinators' while their own is at default
      if (pair === PAIRS.backup) return get(PAIRS.coordinatorBackup[what]).trim().toLowerCase() === 'default' ? fallbackKinds(get) : [kindOf(get(PAIRS.backup.cli))]
      return [kindOf(get(PAIRS.coordinatorBackup.cli))]
    })
    return [...new Set(kinds.filter((k): k is string => !!k))]
  }

  /** whether a value set at a level would be the one a level below reads it: the first level of its chain that stores the
   *  key is that one, or this value's when none does (pairKinds) */
  private readsAt(x: Level, l: Level, key: string): boolean {
    const chain: Level[] = x === 'all' ? ['all'] : x === 'machine' ? ['machine', 'all'] : [x, 'machine', 'all']
    // the level being set already holds it: it is written after this check
    const first = chain.find((y) => y === l || this.at(y)[key] !== undefined)
    return first === undefined || first === l
  }

  /** why a model or effort doesn't fit the CLI its own pair of keys names at a level: it lists what does */
  private unfit(key: string, value: string, l: Level): string | undefined {
    const own = pairOfKey(key)
    if (!own || value.trim().toLowerCase() === 'default') return undefined
    const kinds = this.pairKinds(own.pair, own.what, l).filter((k) => !!modelsOf(k))
    // no CLI to ask (its own or none set): an effort is one of the levels Shepherdr knows
    if (!kinds.length) return own.what === 'effort' && !EFFORTS.includes(value.trim().toLowerCase()) ? `Pick one of: ${EFFORTS.join(' · ')}.` : undefined
    if (own.what === 'model') {
      const listed = kinds.filter(knowsModels)
      if (!listed.length || listed.some((k) => findModel(k, value))) return undefined
      const labels = [...new Set(listed.flatMap((k) => modelsOf(k)!.models.map((m) => m.label)))]
      const them = listed.map((k) => CLI_NAME[k]).join(' nor ')
      return listed.length === 1 ? `${CLI_NAME[listed[0]]} has no model ${value}. Pick one of: default · ${labels.join(' · ')}.` : `Neither ${them} has a model ${value}. Pick one of: default · ${labels.join(' · ')}.`
    }
    const model = pairValue((k) => this.pick(k, l).value, own.pair, 'model')
    const levels = [...new Set(kinds.flatMap((kind) => effortsOf(kind, model)))]
    if (levels.includes(value.trim().toLowerCase())) return undefined
    const levelWords = levels.length ? `takes ${['default', ...levels].join(' · ')}.` : 'has no effort levels.'
    if (kinds.length === 1) return `${findModel(kinds[0], model)?.label ?? CLI_NAME[kinds[0]]} ${levelWords}`
    const which = kinds.map((k) => findModel(k, model)?.label ?? CLI_NAME[k])
    return levels.length ? `${which.join(' and ')} take ${['default', ...levels].join(' · ')}.` : `${which.join(' and ')} have no effort levels.`
  }

  /** what every new brief is told about how to work, for a space (none: this machine), with what the coordinator set
   *  for one task (task add --set) on top */
  ways(space?: string, set: Values = {}): Ways {
    return this.waysAt(space ? { space } : 'machine', set)
  }

  private waysAt(l: Level, set: Values = {}): Ways {
    const get = (key: string) => set[key] ?? this.pick(key, l).value
    const merge = get('brief.merge')
    const rounds = Number.parseInt(get('review.rounds'), 10)
    return {
      review: get('brief.review') !== 'off',
      mustFix: get('review.mustFix'),
      rounds: Number.isFinite(rounds) && rounds > 0 ? rounds : 3,
      merge: merge === 'ask me first' ? merge : 'on its own',
      waitChecks: merge === 'after GitHub checks',
    }
  }

  /** who set each line of a brief's Settings block that differs from Shepherdr's own default, for a space (none: this
   *  machine): the coordinator for this one task (set), else the most specific level it comes from */
  setBy(space?: string, set: Values = {}): Partial<Record<Said, SetBy>> {
    return this.setByAt(space ? { space } : 'machine', set)
  }

  private setByAt(l: Level, set: Values = {}): Partial<Record<Said, SetBy>> {
    const by = (...keys: string[]): SetBy | undefined => {
      if (keys.some((k) => k in set)) return 'task'
      const froms = keys.map((k) => ({ ...this.pick(k, l), key: k })).filter((p) => p.from !== 'default' && p.value !== defaultOf(p.key)).map((p) => p.from)
      return (['space', 'machine', 'all'] as const).find((f) => froms.includes(f))
    }
    const all: Record<Said, SetBy | undefined> = {
      review: by('brief.review'),
      // a backup reviewer's three keys mark the line only where the line shows one: with it off, and with Review off,
      // the Reviewer line reads as the plain one
      reviewer: by('reviewer.agent', 'reviewer.model', 'reviewer.effort', ...(this.waysAt(l, set).review ? chainNames('reviewer').filter((n) => kindOf((set[PAIRS[n].cli] ?? this.pick(PAIRS[n].cli, l).value))).flatMap((n) => Object.values(PAIRS[n])) : [])),
      mustFix: by('review.mustFix'),
      rounds: by('review.rounds'),
      merge: by('brief.merge'),
      agent: by('task.agent', 'task.model', 'task.effort'),
    }
    return Object.fromEntries(Object.entries(all).filter(([, v]) => v)) as Partial<Record<Said, SetBy>>
  }

  /** A launch snapshot, with the same per-role inheritance as other settings. Never part of a task's saved brief. */
  instructions(role: 'coordinator' | 'task' | 'reviewer', space?: string): string {
    const p = this.pick(`${role}.instructions`, space ? { space } : 'machine')
    const scope = { all: 'Everywhere', machine: 'this machine', space: `space ${space}`, default: 'default' }[p.from]
    return `Private instructions for ${role} (from ${scope}):\n${p.value.trim() || '(none)'}`
  }

  /** Autopilot's heartbeat at a level */
  heartbeat(l: Level = 'machine'): Heartbeat {
    return { time: this.pick('heartbeat.when', l).value, on: eventRules(this.pick('heartbeat.on', l).value), zone: this.zone() }
  }

  /** the time zone of every time rule */
  zone() {
    return this.pick('time.zone', 'all').value
  }

  /** how long a task's shared browser may sit idle before it closes, in ms, at a level; null: it never does */
  idleClose(l: Level = 'machine'): number | null {
    const n = Number.parseFloat(this.pick('browser.idleClose', l).value)
    return Number.isFinite(n) && n > 0 ? n * 60_000 : null
  }

  /** when this machine's tasks may start, and when its coordinator is told it struggles, as numbers */
  machine(l: 'all' | 'machine' = 'machine'): MachineLimits {
    const get = (key: string) => this.pick(key, l).value
    const num = (key: string) => {
      const n = Number.parseFloat(get(key))
      return Number.isFinite(n) && n > 0 ? n : null
    }
    return {
      max: Math.max(1, Math.round(num('machine.maxTasks') ?? 10)),
      startLoad: num('machine.startLoad'),
      startPressure: num('machine.startPressure'),
      startEvery: num('machine.startEvery'),
      startMemory: num('machine.startMemory'),
      alertLoad: num('machine.alertLoad'),
      alertMemory: num('machine.alertMemory'),
      alertDisk: num('machine.alertDisk'),
      alertHerdr: get('machine.alertHerdr') !== 'off',
    }
  }

  /** the most agents at once per provider or per model (models.maxAtOnce), as entries; none while it is off (model-caps.ts).
   *  Without a space: the machine's total, read at this machine (its own, else Everywhere's). With one: that space's
   *  sub-limit, its own value or else the machine's; the caller applies both (choose.ts), so a space's value never
   *  replaces the machine's total */
  maxAtOnce(space?: string): MaxEntry[] {
    const p = parseMaxAtOnce(this.pick('models.maxAtOnce', space ? { space } : 'machine').value)
    return p.ok ? p.entries : []
  }

  /** how many of one space's tasks may work on this machine at once (space.maxTasks, inside the machine's own limit): the
   *  most specific level that sets it; none: the space has no cap of its own */
  spaceMax(space: string): number | null {
    const n = Number.parseFloat(this.get('space.maxTasks', space))
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null
  }

  /** the CLI, model and effort tasks or coordinators start with, or tasks are reviewed by, for a space (none: this
   *  machine); nothing for a CLI's own default */
  harness(role: 'task' | 'coordinator' | 'reviewer', space?: string): { kind: string; model?: string; effort?: string } {
    return this.harnessAt(role, space ? { space } : 'machine')
  }

  private harnessAt(role: 'task' | 'coordinator' | 'reviewer', l: Level) {
    const kind = this.kindOf(role, l)!
    return { kind, ...this.modelAt(role, kind, l) }
  }

  /** the backup reviewer's CLI, model and effort, for a space (none: this machine), with what the coordinator set for one
   *  task on top (task add --set); nothing while it is off, so a brief's Reviewer line reads as it always has */
  reviewerBackup(space?: string, set: Values = {}): { kind: string; model?: string; effort?: string } | undefined {
    return this.reviewerBackupAt(space ? { space } : 'machine', set)
  }

  /** the backup reviewers, in turn (the chain's ones that are on), for a space (none: this machine), with what the
   *  coordinator set for this task first */
  reviewerBackups(space?: string, set: Values = {}): { kind: string; model?: string; effort?: string }[] {
    return this.reviewerBackupsAt(space ? { space } : 'machine', set)
  }

  private reviewerBackupsAt(l: Level, set: Values = {}): { kind: string; model?: string; effort?: string }[] {
    const get = (key: string) => set[key] ?? this.pick(key, l).value
    return chainNames('reviewer').flatMap((n) => {
      const kind = kindOf(get(PAIRS[n].cli))
      return kind ? [{ kind, ...this.modelIn(PAIRS[n], kind, l, get) }] : []
    })
  }

  private reviewerBackupAt(l: Level, set: Values = {}) {
    const get = (key: string) => set[key] ?? this.pick(key, l).value
    const kind = kindOf(get(PAIRS.reviewBackup.cli))
    return kind ? { kind, ...this.modelIn(PAIRS.reviewBackup, kind, l, get) } : undefined
  }

  /** the advisor's CLI, model and effort for a space (none: this machine), or its nth backup's (true: the 1st); nothing
   *  while that one is off */
  advisor(space?: string, backup: boolean | number = false): { kind: string; model?: string; effort?: string } | undefined {
    const l: Level = space ? { space } : 'machine'
    const n = backup === true ? 1 : backup === false ? 0 : backup
    const name = n ? chainNames('advisor')[n - 1] : undefined
    if (n && !name) return undefined
    const pair = name ? PAIRS[name] : PAIRS.advisor
    const kind = kindOf(this.pick(pair.cli, l).value)
    return kind ? { kind, ...this.modelIn(pair, kind, l) } : undefined
  }

  /** how long a question waits for the human before it goes to the advisor by itself, for a space; null: never */
  advisorAfter(space?: string): number | null {
    const v = this.pick('advisor.after', space ? { space } : 'machine').value
    const m = /^(\d+) min$/.exec(v)
    return m ? Number(m[1]) * 60_000 : null
  }

  /** a role's model and effort as its CLI takes them, for a space (none: this machine): one it doesn't have is its
   *  own default, a level its model lacks the nearest it has; nothing for the CLI's own. `own`: a value a task keeps
   *  for itself (its own --set), read before the space's. A backup's pair is one of PAIRS': the tasks' (backup) or the
   *  coordinators' (coordinatorBackup), whose model and effort are read from the tasks' pair while they are at default */
  modelOf(role: PairName, kind?: string, space?: string, own?: (key: string) => string): { model?: string; effort?: string } {
    const l: Level = space ? { space } : 'machine'
    return this.modelAt(role, kind ?? this.kindOf(role, l), l, own)
  }

  private modelAt(role: PairName, kind: string | undefined, l: Level, own?: (key: string) => string): { model?: string; effort?: string } {
    return this.modelIn(PAIRS[role], kind, l, own ?? ((key: string) => this.pick(key, l).value))
  }

  /** one pair of keys' model and effort as a CLI takes them: one it doesn't have is its own default, a level its model
   *  lacks the nearest it has; nothing for the CLI's own */
  private modelIn(pair: Pair, kind: string | undefined, l: Level, get = (key: string) => this.pick(key, l).value): { model?: string; effort?: string } {
    if (!kind) return {}
    const stored = pairValue(get, pair, 'model')
    const model = stored === 'default' ? undefined : knowsModels(kind) ? findModel(kind, stored)?.id : modelsOf(kind) ? stored : undefined
    return { model, effort: effortFor(kind, pairValue(get, pair, 'effort'), model) }
  }

  /** what a row's reset goes back to: its value one level up or, while that is default, the key a backup key follows there
   *  (the followed key's own value at this level, where it may be set) */
  private resetTo(key: string, l: Level, up: Level): { value: string; from: LevelKind | 'default' } {
    const above = this.pick(key, up)
    const peer = FOLLOWS[key]
    if (!peer || above.value.trim().toLowerCase() !== 'default') return above
    const q = this.pick(peer, l)
    return q.value.trim().toLowerCase() === 'default' ? above : q
  }

  /** a backup's Model row whose CLI has no model for the value it reads — its own, or the tasks' pair's while it follows:
   *  said where it is read, so that a backup which won't go in (engine.ts backupFor) is no surprise */
  private modelProblem(key: string, read: { value: string }, l: Level): string | undefined {
    const own = pairOfKey(key)
    if (!own || own.what !== 'model' || (own.pair !== PAIRS.backup && own.pair !== PAIRS.coordinatorBackup)) return undefined
    // default is no model at all: a backup set to it starts on its CLI's own
    if (read.value.trim().toLowerCase() === 'default') return undefined
    const kind = kindOf(this.pick(own.pair.cli, l).value)
    if (!kind || !knowsModels(kind) || findModel(kind, read.value)) return undefined
    return `${read.value} is no model ${CLI_NAME[kind] ?? kind} has: this backup doesn't go in until you set one here.`
  }

  /** every key with its value for a space (none: this machine) and where it comes from, as shepherdr show prints
   *  them */
  lines(space?: string, host = 'this machine') {
    const l: Level = space ? { space } : 'machine'
    const name = { space: 'this space', machine: host, all: 'Everywhere', default: 'default' }
    const keys = (told: boolean) =>
      // a chain's 2nd to 5th backups only once they are on: the rest say nothing
      CATALOG.filter((s) => !!(s.told || s.prompt) === told).flatMap((s) => s.rows.filter((r) => r.key !== 'alerts' && !(r.chain && r.chain.n > 1 && !kindOf(this.readAt(extraPair(r.chain.of as Chain, r.chain.n).cli, l).value))).map((r) => {
        const p = this.readAt(r.key, l)
        // a backup's own key at default reads the tasks' pair's, which the line says
        const from = `${name[p.from]}${p.follows ? `, the tasks' backup's ${p.follows === 'backup.model' ? 'model' : 'effort'}` : ''}`
        // a trigger in words, as the human hears it; the rule as kept under it, for an agent to change
        const words = this.words(r.key, p.value)
        return words ? `${r.key.padEnd(26)} ${words.trim()}  (${from})\n${''.padEnd(27)}as written: ${p.value}` : `${r.key.padEnd(26)} ${p.value}  (${from})`
      }))
    return `What agents are told (private launch instructions and new briefs):\n${keys(true).join('\n')}\n\nHow Shepherdr runs:\n${keys(false).join('\n')}`
  }

  /** a trigger setting in plain words, on a line after its value; nothing for the others */
  words(key: string, value: string) {
    if (key === 'heartbeat.when') {
      const next = nextWords(value, this.zone())
      return `\n${''.padEnd(27)}${timeWords(value, this.zone())}${next.length ? `; next ${next.join(', ')}` : ''}`
    }
    return key === 'heartbeat.on' ? `\n${''.padEnd(27)}${eventWords(eventRules(value))}` : ''
  }

  /** a trigger row as Settings shows it: in words, its next runs, and its few ready-made picks */
  private triggerRow(key: string, value: string): { trigger?: TriggerRow } {
    if (key === 'heartbeat.when') return { trigger: { words: timeWords(value, this.zone()), next: nextWords(value, this.zone()), presets: HEARTBEAT_PRESETS } }
    if (key === 'heartbeat.on') return { trigger: { words: eventWords(eventRules(value)), next: [], presets: NEWS_PRESETS } }
    return {}
  }

  /** the pages of every level this machine holds: Everywhere (the main machine's, which its others share), this
   *  machine, and each of its spaces. `checklist`: the HEARTBEAT.md of a level's place (its id), shown last under
   *  Autopilot */
  sections(devices: string[], machines: { name: string; state: string }[], plugins: SettingSection | null, host = 'this machine', spaces: string[] = [], name = host, checklist?: (place: string) => string, pushWarnings: string[] = []): SettingSection[] {
    const levels: { l: Level; id: string }[] = [
      { l: 'all', id: 'all' },
      { l: 'machine', id: `m:${host}` },
      ...spaces.map((space) => ({ l: { space } as Level, id: `p:${host}:${space}` })),
    ]
    const fromName = (f: LevelKind | 'default') => (f === 'machine' ? name : 'Everywhere')
    // a value that reads another key's at this same level is this space's, not Everywhere's
    const fromPeer = (f: LevelKind | 'default') => (f === 'space' ? 'this space' : fromName(f))
    const above = (l: Level): Level | null => (l === 'all' ? null : l === 'machine' ? 'all' : 'machine')
    const rows = (s: Section, l: Level) => {
      // the words each row of How tasks work adds to a brief, as its Settings block has them at this level
      const told = s.told ? settingsLines('<id>', { ways: this.waysAt(l), reviewer: this.harnessAt('reviewer', l), fallback: this.reviewerBackupsAt(l), by: this.setByAt(l) }) : []
      const text = (said: Said) => told.find((x) => x.said === said)?.text
      const lines: Record<string, string | undefined> = s.told
        ? { 'brief.review': text('review'), 'reviewer.agent': text('reviewer'), ...Object.fromEntries(REVIEWER_BACKUP_KEYS.map((k) => [k, text('reviewer')])), 'review.mustFix': text('mustFix'), 'review.rounds': text('rounds'), 'brief.merge': text('merge') }
        : {}
      return s.rows.map((r) => {
        if (r.key === 'alerts') return { ...r, value: devices.length ? devices.join(', ') : 'No device yet', warn: pushWarnings.length ? `${pushWarnings.length} device${pushWarnings.length === 1 ? '' : 's'} could not receive the last alert.\n${pushWarnings.slice(0, 3).join('\n')}${pushWarnings.length > 3 ? '\nMore details: shepherdr doctor' : ''}` : undefined }
        const p = this.pick(r.key, l)
        // its value as it is read: a backup's own key at default reads the tasks' pair's (readAt), and says so
        const read = this.readAt(r.key, l)
        const here = p.from === kindOfLevel(l)
        const up = above(l)
        // set here: what a reset goes back to; not set here: where its value comes from
        const back = up ? this.resetTo(r.key, l, up) : { value: defaultOf(r.key) ?? '', from: 'default' as const }
        const warn = this.modelProblem(r.key, read, l)
        return {
          ...agentRow({ ...r, value: read.value }, (k) => this.readAt(k, l).value, (kind) => this.picksAt(kind)),
          ...(lines[r.key] ? { line: lines[r.key] } : {}),
          ...this.triggerRow(r.key, p.value),
          ...(here ? { inherits: { value: back.value, from: back.from === 'default' && l === 'all' ? 'Default' : fromPeer(back.from) } } : l === 'all' ? {} : { from: read.follows ? `the tasks' backup (${fromPeer(read.from)})` : fromName(read.from) }),
          ...(warn ? { warn } : {}),
        }
      })
    }
    const note = (s: Section, l: Level) =>
      s.name === 'Private instructions'
        ? { noteTitle: 'When rules take effect', note: 'Used at the next start or restart. Saving leaves running agents alone. A resumed session may remember old rules: the new snapshot replaces those private rules. Task agents pass the reviewer snapshot from their own latest start to each review; restart the task agent to refresh it.' }
        : s.name === 'How tasks work'
          ? { note: settingsBlock('<id>', { ways: this.waysAt(l), reviewer: this.harnessAt('reviewer', l), fallback: this.reviewerBackupsAt(l), by: this.setByAt(l) }) }
        : s.name === AUTOPILOT
          ? autopilotNote()
          : s.name === 'Machine'
            ? machineNote(this.machine(l === 'all' ? 'all' : 'machine'))
            : {}
    // each space's own HEARTBEAT.md, after the heartbeat's rows: a file, not a default its levels pass down
    const withChecklist = (s: Section, list: SettingSection['rows'], id: string): SettingSection['rows'] =>
      s.name === AUTOPILOT && checklist && id.startsWith('p:') ? [...list, { label: 'Checklist', key: 'heartbeat.md', value: checklist(id), doc: true }] : list
    return [
      ...levels.flatMap(({ l, id }) =>
        CATALOG.filter((s) => (s.levels ?? ['all', 'machine', 'space']).includes(kindOfLevel(l))).map((s) => ({
          name: s.name,
          about: s.about,
          rows: withChecklist(s, rows(s, l), id),
          ...note(s, l),
          level: id,
          ...(s.levels?.length === 1 ? { global: true } : {}),
          ...(s.told || s.prompt ? { told: true } : {}),
          ...(l === 'all' ? {} : { machine: host }),
        })),
      ),
      ...(plugins ? [plugins] : []),
      { name: 'Machines', about: 'Every machine Shepherdr reaches, and how it is now.', rows: machines.map((m) => ({ label: m.name, key: '', value: m.state, fixed: true })) },
    ]
  }
}

/** the old heartbeat interval and quiet hours of each level, as one time rule there, filled in with what the levels
 *  above it set (a space's quiet hours keep Everywhere's 45 minutes); in place, before upgrade() reads each level */
function heartbeats(above: Values[], spaces: Values[]) {
  const KEYS = ['heartbeat.every', 'heartbeat.quiet']
  const chain = (levels: Values[]) => {
    const own = levels.at(-1)!
    if (!KEYS.some((k) => own[k]) || own['heartbeat.when']) return
    const of = (k: string) => [...levels].reverse().find((l) => l[k])?.[k]
    own['heartbeat.every'] ??= of('heartbeat.every') ?? '30 min'
    own['heartbeat.quiet'] ??= of('heartbeat.quiet') ?? 'off'
  }
  chain([above[0]])
  chain(above)
  for (const sp of spaces) if (sp) chain([...above, sp])
}

/** an old heartbeat interval ("30 min", "off") and quiet hours ("22:00-07:00") as a time rule: every so often, in the
 *  whole hours outside the quiet ones */
function fromEvery(every: string, quiet: string): string | undefined {
  if (every.trim().toLowerCase() === 'off') return 'off'
  const n = Number.parseInt(every, 10)
  if (!Number.isFinite(n) || n < 1) return undefined
  const q = quiet.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/)
  const [from, to] = q ? [+q[1] * 60 + +q[2], +q[3] * 60 + +q[4]] : [0, 0]
  const isQuiet = (t: number) => (from <= to ? t >= from && t < to : t >= from || t < to)
  // an hour with any quiet minute in it is left out: never a heartbeat in quiet hours
  const hours = Array.from({ length: 24 }, (_, h) => h).filter((h) => !q || !Array.from({ length: 60 }, (_, m) => h * 60 + m).some(isQuiet))
  try {
    return timeRule(`FREQ=MINUTELY;INTERVAL=${n}${q && hours.length ? `;BYHOUR=${hours.join(',')}` : ''}`)
  } catch {
    return undefined
  }
}

/** what Autopilot does on its own, and never does, as the human reads it under its Settings; coordinators read the
 *  same rules in their skill (skill/shepherdr-coordinator) */
const AUTOPILOT_DOES = [
  'Goes through its HEARTBEAT.md each heartbeat while idle, and says nothing when nothing needs it',
  "Answers task agents' questions it can answer from the brief or the space",
  'Has conflicts rebased and failed checks fixed',
  'Starts queued tasks and closes tasks whose work is over',
  'Adds small follow-up fix tasks for what reviews, proofs or a red main found',
  'Switches itself off and tells you why when things keep breaking',
]
const AUTOPILOT_NEVER = ['Deletes tasks', 'Changes Settings', 'Starts work nobody asked for', 'Force-pushes', 'Merges past a brief\'s "ask me first"']

/** under Autopilot's rows: what it does on its own, and never does */
export const autopilotNote = () => ({
  noteTitle: 'On its own it',
  note: `${AUTOPILOT_DOES.map((x) => `- ${x}`).join('\n')}\n\nIt never ${AUTOPILOT_NEVER.map((x) => x.charAt(0).toLowerCase() + x.slice(1)).join(', ').replace(/, ([^,]+)$/, ' or $1')}.`,
})

/** under a machine's rows: why the defaults are what they are, in this machine's own numbers */
export function machineNote(l: MachineLimits, cores = cpus().length, memGb = Math.round(totalmem() / 2 ** 30)) {
  const load = (x: number | null) => (x === null ? 'off' : `${+(x * cores).toFixed(1)}`)
  const gb = (pct: number | null) => (pct === null ? 'off' : `${Math.round((memGb * pct) / 100)} GB`)
  const now = [
    l.max !== null || l.startLoad !== null
      ? `New tasks wait${l.max !== null ? ` while ${l.max} are at work` : ''}${l.max !== null && l.startLoad !== null ? ', or' : ''}${l.startLoad !== null ? ` while the load is over ${load(l.startLoad)}` : ''}${l.startMemory !== null ? ` or over ${gb(l.startMemory)} of memory is in use` : ''}.`
      : '',
    `Its coordinator hears when the load stays over ${load(l.alertLoad)} for 2 minutes, memory passes ${gb(l.alertMemory)}, home or /tmp is over ${l.alertDisk === null ? 'off' : `${l.alertDisk}%`} full${l.alertHerdr ? ', or herdr stops answering' : ''}.`,
  ].filter(Boolean)
  return {
    noteTitle: 'Why these defaults',
    note: [
      `This machine has ${cores} cores and ${memGb} GB of memory. ${now.join(' ')}`,
      '',
      '- 10 tasks at once: each task spends most of its time waiting on its model, and the tests it may run keep to a fraction of the cores at the lowest priority; past about 10 they start to slow each other down.',
      '- Load 1× cores to start: every core is busy then, so one more task only slows the rest.',
      "- Memory 80% to start: room for a test run's peak before the machine starts killing processes.",
      "- Load 1.5× cores for 2 minutes to alert: half again more work than cores, for longer than one test run's spike.",
      '- Memory and disk 90% to alert: close enough to full that something will soon fail.',
      '',
      'Waiting tasks show as Queued and start by themselves, oldest first; while load counts, one at a time, 30 seconds apart, so each one shows in the load. Only working tasks count. Shepherdr never pauses a running task: when told, the coordinator decides.',
    ].join('\n'),
  }
}

/** why a value can't be set, or nothing */
export function refuse(key: string, value: string): string | undefined {
  if (key.endsWith('.instructions') && (value.length > 16000 || value.includes('\0'))) return 'Use at most 16,000 characters, without null characters. Keep secrets in Secrets.'
  const cli = key === 'task.agent' || key === 'coordinator.agent' || (isFallback(key) && value.trim().toLowerCase() !== 'off')
  if (cli && !kindOf(value)) return `${value} is not an agent herdr can start.`
  if (key === 'reviewer.agent' && !REVIEWERS.includes(CLI_NAME[kindOf(value) ?? ''] ?? '')) return `Pick one of: ${REVIEWERS.join(' · ')}.`
  // a backup reviewer: one of the reviewer CLIs, or off (there is none)
  if (REVIEWER_BACKUP_KEYS.includes(key) && value.trim().toLowerCase() !== 'off' && !REVIEWERS.includes(CLI_NAME[kindOf(value) ?? ''] ?? '')) return `Pick one of: off · ${REVIEWERS.join(' · ')}.`
  // the advisor and its backup: off, or one of the CLIs Shepherdr runs headless
  if (ADVISOR_CLI_KEYS.includes(key) && value.trim().toLowerCase() !== 'off' && !REVIEWERS.includes(CLI_NAME[kindOf(value) ?? ''] ?? '')) return `Pick one of: off · ${REVIEWERS.join(' · ')}.`
  if (pairOfKey(key)?.what === 'model' && !/^[\w.:/@[\] -]+$/.test(value.trim())) return 'Write a model id like claude-opus-5-5, or default.'
  const num = numOf(key)
  if (key === 'heartbeat.when' || key === 'heartbeat.on') {
    try {
      if (key === 'heartbeat.when') timeRule(value)
      else eventRules(value)
    } catch (e) {
      return (e as Error).message
    }
  }
  if (key === 'models.maxAtOnce') {
    const p = parseMaxAtOnce(value)
    if (!p.ok) return p.error
  }
  if (key === 'time.zone' && !validZone(value.trim())) return `${value} is no time zone: write one like Europe/Stockholm.`
  const options = ROWS.find((r) => r.key === key)?.options
  // a dictation language by name or by its whisper code (es, pt): whisper knows more of them than Settings lists
  if (key === 'dictate.language' && !options?.includes(value) && !/^(auto|[a-z]{2,3})$/i.test(value.trim()))
    return 'Pick a language, or write its whisper code (en, pt, es).'
  if (num && numValue(num, value) === undefined) return `Write a number from ${num.min} to ${num.max}${num.step ? '' : ' (whole)'}${num.unit ? `, in ${num.unit}` : ''}${num.off ? ', or off' : num.zero ? ' (0 is off)' : ''}.`
  // an effort word is checked against the levels its model takes (unfit): OpenCode's variants are its own lowercase words
  // (thinking, none…), not LEVELS, so only a word that is not lowercase is refused here
  const variant = pairOfKey(key)?.what === 'effort' && value === value.trim().toLowerCase()
  if (options && !cli && key !== 'reviewer.agent' && !isBackupCli(key) && key !== 'alerts' && key !== 'dictate.language' && !variant && !options.includes(value)) return `Pick one of: ${options.join(' · ')}.`
  return undefined
}

const numOf = (key: string) => ROWS.find((r) => r.key === key)?.num

/** task add's --set for one task: a How tasks work key by its Settings key or its short name, and the flag of task
 *  add's own the agent and reviewer keys stand for */
const ONE_TASK: Record<string, string> = { review: 'brief.review', merge: 'brief.merge', mustfix: 'review.mustFix', 'must-fix': 'review.mustFix', rounds: 'review.rounds', 'review-rounds': 'review.rounds' }
/** the backup settings one task keeps for itself, its own fallback and pair, as engine.ts cantGoOn reads them first */
const ONE_BACKUP: Record<string, string> = {
  'task.fallback': 'task.fallback',
  fallback: 'task.fallback',
  'backup.model': 'backup.model',
  'backup.effort': 'backup.effort',
  // the rest of its chain, by their own keys
  ...Object.fromEntries(EXTRA.flatMap((n) => Object.values(extraPair('task', n)).map((k) => [k.toLowerCase(), k]))),
}
const FLAG_OF: Record<string, string> = { 'task.agent': 'agent', 'task.model': 'model', 'task.effort': 'effort', 'reviewer.agent': 'reviewer', 'reviewer.model': 'reviewer-model', 'reviewer.effort': 'reviewer-effort' }

/** one --set key=value: a How tasks work setting for this task as Settings keeps it, the task add flag it stands for
 *  (agent, model, effort, reviewer…), a backup value this one task keeps for itself, or why it can't be */
export function setForTask(pair: string): { key: string; value: string } | { flag: string; value: string } | { error: string } {
  const eq = pair.indexOf('=')
  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
  const told = CATALOG.filter((x) => x.told).flatMap((x) => x.rows.map((r) => r.key))
  const short = name.toLowerCase()
  const key =
    told.find((k) => k.toLowerCase() === short) ??
    ONE_TASK[short] ??
    ONE_BACKUP[short] ??
    (FLAG_OF[`task.${short}`] && `task.${short}`) ??
    (short === 'reviewer' ? 'reviewer.agent' : Object.keys(FLAG_OF).find((k) => k.toLowerCase() === short))
  if (eq < 1 || !key) return { error: `--set takes key=value, a key of: ${[...told.filter((k) => !FLAG_OF[k]), ...Object.keys(ONE_BACKUP), 'agent', 'model', 'effort', 'reviewer', 'reviewer.model', 'reviewer.effort'].join(', ')} (shepherdr show has them)` }
  if (FLAG_OF[key]) return { flag: FLAG_OF[key], value }
  const err = refuse(key, value)
  if (err) return { error: `--set ${name}: ${err}` }
  const num = numOf(key)
  return { key, value: num ? numValue(num, value)! : value }
}

/** a number as it is kept ("7 days", "1.5× cores", "off"), or nothing where it is no number in range */
export function numValue(n: Num, value: string): string | undefined {
  const v = value.trim().toLowerCase()
  if (v === 'off') return n.off || n.zero ? 'off' : undefined
  // its unit (or any word of it) may follow: "13", "13 tasks", "1.5x cores", "80 %"
  const m = v.match(/^(\d+(?:[.,]\d+)?)\s*(?:[×x%]|[a-z][a-z ]*)?\s*(?:cores?)?$/)
  if (!m) return undefined
  const x = Number(m[1].replace(',', '.'))
  if (n.zero && x === 0) return 'off'
  const step = n.step ?? 1
  if (x < n.min || x > n.max || Math.abs(Math.round(x / step) * step - x) > 1e-9) return undefined
  const unit = x === 1 && n.one ? n.one : n.unit
  return unit ? `${x}${unit.startsWith('×') || unit === '%' ? '' : ' '}${unit}` : String(x)
}

/** A repository's own destination; it has no machine or Everywhere fallback. */
export const repositorySection = (level: string, machine: string, base: string): SettingSection => ({
  name: 'Repository', machine, level,
  rows: [{ key: 'space.base', label: 'Base branch', value: base, text: true, hint: 'New tasks start from and merge into this branch. Existing tasks keep their target.' }],
})
