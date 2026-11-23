// biome-ignore-all lint/style/noNonNullAssertion: the CLI verb code is moved here from source.ts as it stood (SHE-160),
// biome-ignore-all lint/suspicious/noAssignInExpressions: so a reviewer can check it with git diff --color-moved. These
// are the file's own findings, baselined in source.ts before the move, not fixes this task should make on the way.
// The shepherdr CLI verb surface, moved out of server/live/source.ts with no change of behaviour (SHE-160).
// LiveSource keeps command() as a delegate; the verbs reach LiveSource's objects and methods through `this`, which
// createCliCommands() wires to the owning LiveSource. Keep method bodies identical when editing this file.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskAlert } from '../../shared/alerts.ts'
import { ADVISOR_AT_ONCE, waitingKind } from '../../shared/apply-waiting.ts'
import { ATTACH_MAX, isMedia, isVideo } from '../../shared/files.ts'
import { placeOrder } from '../../shared/space-order.ts'
import { type Action, type Alert, doneNewestFirst, type Peer, type Place, type RestartInfo, ROW_MAX, STATUS_MAX } from '../../shared/types.ts'
import { startsWords, whenFrom } from '../../shared/when.ts'
import { parseHosts, refusedHosts } from '../hosts.ts'
import { has } from '../plugins.ts'
import { HOME, readJson, writeJson } from '../store.ts'
import { ROOT } from '../root.ts'
import type { Agents } from './agents.ts'
import { HELP, helpTopic, helpVerb, one, type Parsed, summaryOpts } from './args.ts'
import { agentEnv } from './box.ts'
import { type ArtifactRec, Artifacts, type Checker } from './artifacts.ts'
import type { Automation, Automations, Template } from './automations.ts'
import { BOX, boxHome } from './box.ts'
import type { Browsers } from './browser.ts'
import type { FromAgent } from './chatlines.ts'
import type { Chats } from './chats.ts'
import { HELD_NAMED, HOME_NO_PLACE, minutesOf, statusLine } from './cli-shared.ts'
import { swallowedReport } from './debug.ts'
import { age, checkTitle, type Engine, ended, fitStatus, type HeldWhy, type Retune, retuneLine, reviewRetuneLine, type TaskRec } from './engine/engine.ts'
import { validateBase } from './engine/git.ts'
import { agyModelId } from './agy.ts'
import { type Monitor, perfReport, summary } from './health.ts'
import { type Heartbeats, heartbeatFile, WAKE_ANYWAY, wakesAnyway } from './heartbeat.ts'
import { herdr } from './herdr.ts'
import { chatDir } from './inbox.ts'
import type { Machines } from './machines.ts'
import * as task from './mfs.ts'
import { boxDir } from './mfs.ts'
import { agyIds, checkModelTable, effortsOf, findModel, knowsModels, modelsOf } from './models.ts'
import { type Finding, lines as orphanLines } from './orphans.ts'
import { asMode, HOST, NAME, type Places, placeId, type Space, shortId } from './places.ts'
import { type ProfileSchedules, scheduleRows, scheduleWords } from './profile-schedule.ts'
import { type Change, changeWords, PROFILES_ON_MAIN, type Profiles, previewWords, waitingPicks } from './profiles.ts'
import { createSession } from './opencode.ts'
import { parseFlags } from './flags.ts'
import { reviewRunLine, reviewerWords, settingsBlock } from './prompts.ts'
import { readPromptFile, runReviewInPane } from './review-pane.ts'
import { reviewerPromptFile, reviewerPromptPath } from './reviewer-prompt.ts'
import { trustWorktree } from './trust.ts'
import type { RequestedNewsMailbox } from './requested-news.ts'
import { type Resources, lines as resourceLines } from './resources.ts'
import { fitHarness, type Harness, harnessProblem, harnessWords } from './restart.ts'
import { SECRET_NAME, type Vault } from './secrets.ts'
import { CATALOG, CLI_NAME, CLIS, EXECUTABLE_KEYS, kindOf, type Level, refuse, type Settings, setForTask } from './settings.ts'
import type { StallWatch } from './stall.ts'
import { eventRules, eventsText, eventWords, nextWords, runWords, timeRule, timeWords, triggerWords } from './trigger.ts'

/** the narrow face of LiveSource the verbs use: its existing objects, and the methods the verbs still reach on it.
 *  Each is bound to that LiveSource so a moved body's `this.engine`, `this.emit` … behave exactly as before. */
export class CliCommands {
  declare act: (a: Action) => Promise<unknown>
  declare addAsSpace: (path: string, name?: string) => Promise<{ space: Space; found: boolean; existing: boolean; moved: boolean }>
  declare adoptEverywhere: () => void
  declare agents: Agents
  declare alert: (a: Alert) => void
  declare applyWaiting: (key: string, level: Level, dry?: boolean) => Retune
  declare artifacts: Artifacts
  declare automation: (
    place: string,
    op: 'add' | 'pause' | 'resume' | 'run' | 'remove',
    name: string | undefined,
    to?: { name: string; when?: string; on?: string; title: string; brief?: string; agent?: Template['agent']; set?: Record<string, string> },
  ) => unknown
  declare automations: Automations
  declare browsers: Browsers | null
  declare chatName: (key: string) => string
  declare chats: Chats
  declare checker: Checker
  declare deleteTask: (id: string, force: boolean) => Promise<string[]>
  declare emit: (event: string, ...args: unknown[]) => void
  declare engine: Engine
  declare health: Monitor
  declare heartbeatWork: (id: string, now?: number) => string[]
  declare heartbeats: Heartbeats
  declare heldWords: (why: HeldWhy, t: TaskRec) => string
  declare keeperOf: (a: ArtifactRec) => string
  declare levelOf: (id: string) => Level
  declare matrixSpaces: () => { key: string; name: string }[]
  declare onPeer: <T>(l: unknown, path: string, init?: RequestInit) => Promise<T>
  declare orphansFound: Finding[]
  declare peerOf: (p: FromAgent) => Peer
  declare peers: Machines | null
  declare placeList: () => Place[]
  declare places: Places
  declare profileRetune: (changes: Change[]) => string[]
  declare profileSchedules: ProfileSchedules
  declare profiles: Profiles
  declare pushWarnings: () => string[]
  declare removeSpace: (name: string) => Promise<Space>
  declare requestedNews: RequestedNewsMailbox
  declare resourceReader: () => Promise<Resources>
  declare roleOf: (id: string) => 'space' | 'home' | 'main'
  declare secretLevelName: (level: string) => string
  declare settingChanged: (key: string) => void
  declare settings: Settings
  declare staleInstallLines: () => string[]
  declare stall: StallWatch
  declare user: string
  declare vault: Vault
  declare wake: (place: string) => { name: string; queued: boolean }
  declare workingLine: () => string

  /** agents parked now (the idle sweep, SHE-72), still waiting for the message that starts them again: shepherdr
   *  status counts them. One whose task ended since (its record kept to keep reading its chat) is not waiting */
  parkedCount(): number {
    return Object.entries(this.agents.records).filter(([key, r]) => {
      if (!r.parked) return false
      const t = key.includes('/') ? this.engine.task(key.split('/')[0]) : undefined
      return !t || !ended(t)
    }).length
  }

  /** the space a command runs for: --space, its coordinator's, its task's, or the one its folder is in */
  private placeOfCommand(p: Parsed, ctx: { chat?: string; cwd?: string }) {
    if (one(p, 'space') || (ctx.chat?.startsWith('p:') && this.places.space(ctx.chat)) || ctx.chat?.includes('/')) return this.projectFor(p, ctx)
    return ctx.cwd ? this.places.forPath(ctx.cwd) : undefined
  }

  /** shepherdr task park [ID …] [--yes]: the waiting tasks that hold an agent and a worktree from before a waiting
   *  task got none (engine.parkable), listed; with --yes, parked */
  private async parkCommand(ids: string[], yes: boolean, ctx: { chat?: string }) {
    if (ctx.chat?.includes('/')) throw new Error("A task's agent doesn't park tasks: its coordinator or the human does.")
    if (yes) {
      const r = await this.engine.park(ids.length ? ids : undefined)
      return [
        `Parked ${r.parked.length}${r.parked.length ? `: ${r.parked.join(', ')}` : ''}. Each waits as before, with no agent, worktree or herdr space, and starts on its brief at its turn.`,
        ...(r.kept.length ? [`Left as they were: ${r.kept.join('; ')}.`] : []),
      ].join('\n')
    }
    const want = ids.map((i) => i.toUpperCase())
    const all = (await this.engine.parkable()).filter(({ t }) => !want.length || want.includes(t.id.toUpperCase()))
    if (!all.length) return 'No waiting task holds an agent or a worktree: nothing to park.'
    const go = all.filter((x) => !x.keep)
    const stay = all.filter((x) => x.keep)
    // one line for all the rows below, as the screen reads one per snapshot
    const line = this.engine.startLine()
    const sub = (t: TaskRec) => this.engine.subOf(t, this.engine.statusOf(t), false, line)
    const row = (t: TaskRec, why: string) => `  ${t.id.padEnd(8)} ${t.title}  · ${why}`
    return [
      go.length
        ? `${go.length} waiting task${go.length === 1 ? '' : 's'} would be parked (its agent and herdr space close, its empty worktree and branch go; it starts fresh on its brief at its turn):`
        : 'None can be parked.',
      ...go.map(({ t, notes }) =>
        row(t, `${sub(t)}${notes.length ? ` · ${notes.length === 1 ? 'a note' : `${notes.length} notes`} from another agent go${notes.length === 1 ? 'es' : ''} into its brief` : ''}`),
      ),
      ...(stay.length ? [`${stay.length} kept as ${stay.length === 1 ? 'it is' : 'they are'}:`, ...stay.map(({ t, keep }) => row(t, keep!))] : []),
      go.length ? `Park ${go.length === 1 ? 'it' : 'them'}: shepherdr task park${ids.length ? ` ${ids.join(' ')}` : ''} --yes` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  /** what a task's alert says and where it opens: its open card, else its last reply; a done task's card */
  private taskAlert(t: TaskRec, status = this.engine.statusOf(t), sub = this.engine.subOf(t, status)) {
    const shown = status === 'need' || status === 'ready' || status === 'done' ? status : 'need'
    return taskAlert(t, shown, sub, { task: this.chats.chat(`${t.id}/Agent`), project: status === 'done' ? this.chats.chat(t.project) : undefined })
  }

  projectFor(p: Parsed, ctx: { chat?: string; cwd?: string }) {
    const named = one(p, 'space')
    if (named) {
      const x = this.places.byName(named) ?? this.places.byKey(named)
      if (!x && this.places.find(named)) throw new Error(`${named} is ${NAME}'s home space: it holds no repo, so tasks go in another space (shepherdr space list).`)
      if (!x) throw new Error(`No space called ${named}; shepherdr space list shows them`)
      return x
    }
    if (ctx.chat?.startsWith('p:') && this.places.space(ctx.chat)) return this.places.space(ctx.chat)!
    if (ctx.chat?.includes('/')) return this.places.space(this.engine.task(ctx.chat.split('/')[0])!.project)!
    const byPath = ctx.cwd ? this.places.forPath(ctx.cwd) : undefined
    if (byPath) return byPath
    if (this.places.spaces.length === 1) return this.places.spaces[0]
    throw new Error('Which space? Add --space NAME (shepherdr space list shows them)')
  }

  private byWho(ctx: { chat?: string }) {
    if (!ctx.chat) return 'you (terminal)'
    const name = this.chatName(ctx.chat)
    // added in the turn that answered something you wrote
    return `${name}${ctx.chat.includes('/') ? '' : ' (you asked in chat)'}`
  }

  /**
   * Who a `task tell` comes from, when an agent's shell runs it: its chat (the launch's SHEPHERDR_CHAT), its herdr pane
   * and the space or task it works in. A shell with no chat is still an agent's when herdr says an agent runs in its
   * pane (another Claude Code or pi session of the operator's, not one of ours): it goes by that agent's name. A plain
   * terminal — no chat, no agent in its pane — sends nothing, so its words stay the human's.
   *
   * Declared, never verified: a shell could set SHEPHERDR_CHAT and the pane itself. The one thing asked of herdr is
   * whether an agent really runs in the pane a shell with no chat named, and which one; its name is only what herdr
   * calls it. Either way the chat shows the sender and grants it nothing.
   */
  async toldFrom(ctx: { chat?: string; pane?: string }): Promise<{ name: string; pane?: string; space?: string; task?: string } | undefined> {
    const pane = ctx.pane
    if (ctx.chat) {
      const [id, role] = ctx.chat.split('/')
      const t = role ? this.engine.task(id) : undefined
      const name = t ? `${t.id} ${role.toLowerCase()}` : ctx.chat.includes('/') ? this.chatName(ctx.chat) : `${this.chatName(ctx.chat)} coordinator`
      return {
        name,
        ...(pane ? { pane } : {}),
        ...(t ? { task: t.id, space: this.chatName(t.project) } : { space: this.chatName(ctx.chat) }),
      }
    }
    if (!pane) return undefined
    const a = await herdr.agent(pane).catch(() => undefined)
    if (!a?.agent) return undefined
    // an agent of ours is named as its chat is; anyone else by the herdr name it runs under, else its CLI
    const who = this.peerOf({ name: a.name?.trim() || CLI_NAME[a.agent] || a.agent, text: '' })
    return { name: who.name, pane, ...(who.space ? { space: who.space } : {}), ...(who.task ? { task: who.task } : {}) }
  }

  /** a task's agent says how far along it is: shepherdr status <id> "<line>" --done <0-100> [--left 5m] — at the start,
   *  at each natural step and at least every 5 minutes while it works; a revised --left says so in the line */
  private reportCommand(id: string, words: string[], p: Parsed, ctx: { chat?: string }) {
    const t = this.engine.task(id)
    if (!t) throw new Error(`No task ${id}; shepherdr status <id> "<line>" --done <0-100> [--left 5m]`)
    if (ctx.chat?.includes('/') && ctx.chat.split('/')[0].toUpperCase() !== t.id.toUpperCase()) throw new Error(`A task's agent reports only its own task's progress, not ${t.id}'s.`)
    const line = words.join(' ').trim()
    const done = (one(p, 'done') ?? '').replace(/%$/, '')
    if (!line || !/^\d{1,3}$/.test(done) || Number(done) > 100)
      throw new Error(`shepherdr status ${t.id} "<what you are doing, at most ${ROW_MAX} characters, e.g. 'Fixing two failing tests'>" --done <0-100> [--left 5m|1h20m]`)
    const leftArg = one(p, 'left')
    const left = leftArg === undefined ? undefined : minutesOf(leftArg)
    // up to 99 hours: what fits under the dot ("99h")
    if (p.flags.has('left') || left === null || (left ?? 0) > 99 * 60) throw new Error(`--left takes a time up to 99h, like 5m, 90m or 1h20m${leftArg ? `, not ${leftArg}` : ''}`)
    if (!/[\p{L}\p{N}]/u.test(fitStatus(line))) throw new Error('Write the line in words: what you are doing now.')
    const r = this.engine.report(t.id, line, Number(done), left)
    const cut = r.msg !== line.replace(/\s+/g, ' ') ? ` (cut to ${STATUS_MAX} characters; ask for at most ${ROW_MAX})` : ''
    return `Noted: ${t.id} shows "${r.msg}"${cut}, ${r.progress}% done${r.left !== undefined ? `, about ${r.left} min left` : ''}.`
  }

  /** what a profile's change does to the waiting tasks it reaches: counted, or moved with --apply-waiting (the question on
   *  the screen asks the same, once per kind and place) */
  private profileWaitingWords(changes: Change[], move: boolean): string[] {
    const picks = waitingPicks(changes)
    if (!picks.length) return []
    if (move) return this.profileRetune(changes)
    const n = picks.reduce((k, { change }) => k + this.applyWaiting(change.key, change.at, true).changed, 0)
    return n ? [`${n} waiting ${n === 1 ? 'task' : 'tasks'} would change with it: add --apply-waiting to move ${n === 1 ? 'it' : 'them'} too.`] : []
  }

  /** the profile a command's words open with: the longest run of them that is a saved name (a name may have spaces
   *  unquoted), and the words after it */
  private profileWords(rest: string[]): { name?: string; words: string[] } {
    for (let k = rest.length; k > 0; k--) {
      const found = this.profiles.find(rest.slice(0, k).join(' '))
      if (found) return { name: found.name, words: rest.slice(k) }
    }
    return { words: rest }
  }

  /** the id of a profile's schedule by its number in shepherdr profile schedules: the only one needs no number */
  private scheduleRef(name: string, n: string | undefined): string {
    const list = this.profiles.find(name)?.schedules ?? []
    if (!list.length) throw new Error(`${name} has no schedule. shepherdr profile schedules lists them.`)
    if (n === undefined) {
      if (list.length === 1) return list[0]!.id
      throw new Error(`${name} has ${list.length} schedules: give the number of one, 1 to ${list.length} (shepherdr profile schedules lists them).`)
    }
    const i = /^\d+$/.test(n) ? Number(n) : 0
    if (i < 1 || i > list.length) throw new Error(`No schedule ${n} on ${name}: 1 to ${list.length}.`)
    return list[i - 1]!.id
  }

  /** shepherdr profile list | save | show | preview | apply | undo | rename | delete | schedule…: named settings of this machine (profiles.ts) */
  private profileCommand(op: string | undefined, rest: string[], p: Parsed): string {
    if (BOX) throw new Error(PROFILES_ON_MAIN)
    const name = rest.join(' ')
    const usage =
      'shepherdr profile list | save <name> [--limits] [--force] | show <name> | preview <name> | apply <name> [--apply-waiting] | undo [--apply-waiting] | rename <name> <new-name> | delete <name> | schedule <name> "<rule>" [--waiting] | schedules | schedule-on|schedule-off <name> [<n>] | unschedule <name> [<n>]'
    const refusals = (r: { error?: string; refused: { where: string; label: string; error: string }[] }) => [r.error, ...r.refused.map((x) => `  ${x.where} · ${x.label}: ${x.error}`)].join('\n')
    switch (op) {
      case undefined:
      case 'list':
        return p.flags.has('json') ? JSON.stringify(this.profiles.view(), null, 2) : this.profiles.list()
      case 'save': {
        if (!name) throw new Error(usage)
        const r = this.profiles.save(name, { limits: p.flags.has('limits'), force: p.flags.has('force') })
        if (!r.ok) throw new Error(r.exists ? `${r.error} Add --force to replace it.` : r.error)
        this.emit('snapshot')
        return `Saved ${r.profile!.name}: ${r.profile!.limits ? 'the models and the limits' : 'the models'} of Everywhere, this machine and ${this.matrixSpaces().length} spaces (home included).`
      }
      case 'show':
        if (!name) throw new Error(usage)
        return this.profiles.show(name)
      case 'preview': {
        if (!name) throw new Error(usage)
        const r = this.profiles.preview(name)
        if (!r.ok) throw new Error(r.error)
        return previewWords(r)
      }
      case 'apply': {
        if (!name) throw new Error(usage)
        const r = this.profiles.apply(name)
        if (!r.ok) throw new Error(refusals(r))
        const n = r.changes.length
        return [
          n ? `Applied ${r.name}: ${n} ${n === 1 ? 'setting' : 'settings'} changed.` : `${r.name} is in force already: the settings read as it says.`,
          ...changeWords(r.changes),
          ...(r.skipped.length ? [`Skipped, no longer a space: ${r.skipped.join(', ')}.`] : []),
          ...(r.added.length ? [`Left as they are, added since the save: ${r.added.join(', ')}.`] : []),
          ...(n ? ['shepherdr profile undo puts back what this changed.'] : []),
          ...this.profileWaitingWords(r.changes, p.flags.has('apply-waiting')),
        ].join('\n')
      }
      case 'undo': {
        const r = this.profiles.undo()
        if (!r.ok) throw new Error(refusals(r))
        const n = r.changes.length
        return [
          `Undone: ${r.name}'s apply put back ${n} ${n === 1 ? 'setting' : 'settings'}.`,
          ...changeWords(r.changes),
          ...(r.kept.length ? [`Left as they are, changed since: ${r.kept.join(', ')}.`] : []),
          ...this.profileWaitingWords(r.changes, p.flags.has('apply-waiting')),
        ].join('\n')
      }
      case 'rename': {
        const [from, ...to] = rest
        if (!from || !to.length) throw new Error('shepherdr profile rename <name> <new-name> (quote a name with spaces)')
        const r = this.profiles.rename(from, to.join(' '))
        if (!r.ok) throw new Error(r.error)
        this.emit('snapshot')
        return `${from} is called ${to.join(' ')} now.`
      }
      case 'delete': {
        if (!name) throw new Error(usage)
        const r = this.profiles.remove(name)
        if (!r.ok) throw new Error(r.error)
        this.emit('snapshot')
        return `Deleted ${name}. Its undo points stay until they are used.`
      }
      case 'schedule': {
        const usageSchedule = 'shepherdr profile schedule <name> "<rule>" [--waiting], the rule in words ("daily 22:00") or as an RRULE'
        const found = this.profileWords(rest)
        if (!found.name) throw new Error(rest.length ? `No profile called ${rest[0]}.` : usageSchedule)
        const rule = found.words.join(' ')
        if (!rule) throw new Error(usageSchedule)
        const r = this.profileSchedules.add(found.name, rule, { waiting: p.flags.has('waiting') })
        if (!r.ok) throw new Error(r.error)
        this.emit('snapshot')
        const next = scheduleRows({ schedules: [r.schedule!] }, this.settings.zone())[0]?.next
        return `Scheduled ${found.name}: ${scheduleWords(r.schedule!, this.settings.zone())}.${next ? ` Next: ${next}.` : ''}`
      }
      case 'schedules': {
        const v = this.profiles.view()
        const rows = v.profiles.filter((x) => x.schedules?.length)
        if (!rows.length) return 'No schedules yet. shepherdr profile schedule <name> "daily 22:00" adds one.'
        return [
          ...rows.flatMap((x) => [
            x.name,
            ...(x.schedules ?? []).map(
              (s, i) => `  ${i + 1}  ${s.words}${s.waiting ? ' · also the waiting tasks' : ''}${s.on ? '' : ' · off'}${s.next ? ` · next ${s.next}` : ''}${s.last ? ` · ${s.last}` : ''}`,
            ),
          ]),
          ...(v.next ? [v.next] : []),
        ].join('\n')
      }
      case 'schedule-on':
      case 'schedule-off':
      case 'unschedule': {
        const found = this.profileWords(rest)
        if (!found.name) throw new Error(rest.length ? `No profile called ${rest[0]}.` : usage)
        const id = this.scheduleRef(found.name, found.words[0])
        // the row as it reads now, and again once changed (a switch on has its next run then)
        const rowOf = () =>
          this.profiles
            .view()
            .profiles.find((x) => x.name === found.name)
            ?.schedules?.find((s) => s.id === id)
        const what = `${found.name}: ${rowOf()?.words ?? 'its schedule'}`
        if (op === 'unschedule') {
          const r = this.profileSchedules.remove(found.name, id)
          if (!r.ok) throw new Error(r.error)
          this.emit('snapshot')
          return `Removed the schedule of ${what}.`
        }
        const on = op === 'schedule-on'
        const r = this.profileSchedules.edit(found.name, id, { on })
        if (!r.ok) throw new Error(r.error)
        this.emit('snapshot')
        const next = rowOf()?.next
        return `${what} is ${on ? 'on' : 'off'} now.${on && next ? ` Next: ${next}.` : ''}`
      }
      default:
        throw new Error(usage)
    }
  }

  /** this machine's spaces in the order their tasks wait for its room: numbered ones by their number, then the rest. A
   *  stable sort keeps the usual order for spaces with the same number (or none), as the engine's queue does */
  private orderedSpaces() {
    // the same order the engine's line and the Spaces table sort by (shared/space-order.ts), each space's number read once
    const byPlace = placeOrder((space) => this.settings.spacePriority(space))
    const key = (x: ReturnType<Places['shown']>[number]) => x.space?.name ?? '~'
    return [...this.places.shown()].sort((a, b) => byPlace(key(a), key(b)))
  }

  /** the one line shepherdr status adds when a space of this machine has a priority (none otherwise) */
  private spaceOrderLine() {
    const named = this.orderedSpaces().filter((x) => this.settings.spacePriority(x.space?.name ?? '~') !== null)
    if (!named.length) return ''
    const list = named.map((x) => `${x.name} (${this.settings.spacePriority(x.space?.name ?? '~')})`).join(' · ')
    return `Space order here: ${list}; spaces with no priority come after.`
  }

  /** the spaces held from starting new tasks (space.maxTasks 0), as they show in the status line and its json */
  private pausedSpaces() {
    return this.orderedSpaces()
      .filter((x) => !!x.space && this.settings.get('space.maxTasks', x.space.name) === '0')
      .map((x) => x.name)
  }

  /**
   * `shepherdr review <id> --run <prompt-file>` (SHE-182, SHE-183): run the round's reviewer interactive and read-only
   * in a tab of the task's herdr space, wait for its findings, close the pane and free the reviewer. The prompt file is
   * the one Shepherdr wrote when `review <id>` counted the round (or this command counts it when run alone). One verb for every
   * task CLI. A pane that cannot open (no herdr space, CLI will not start) is said plainly; the round then falls back to
   * the headless line and is left for `--done`, so a review that could not run is never passed off as one that found
   * nothing. The reviewer's findings come from its own CLI log, as every other Shepherdr agent's chat does.
   */
  private async reviewRunCommand(
    t: TaskRec,
    promptFile: string | undefined,
    ctx: { chat?: string; pane?: string; cwd?: string; stdin?: string; local?: boolean },
    onStep?: (words: string) => void,
  ): Promise<string> {
    if (ctx.chat !== `${t.id}/Agent`) throw new Error(`${t.id}'s own agent runs its review, not ${ctx.chat ? 'this chat' : 'you at the command'}`)
    // Every round gets Shepherdr's prompt (SHE-183): the agent names the file `review <id>` wrote, it never supplies
    // one of its own. Reuse the open round only for that file; any other name (a stale file after a restart, a headless
    // fallback left unreleased, or an agent-written prompt) counts a fresh round and is sent that round's own file, so
    // the prompt's round number stays true and no foreign words reach the reviewer.
    const active = this.engine.activeRound(t.id)
    const reuse = !!active && (!promptFile || promptFile === reviewerPromptPath(t.id, active.round))
    const r = reuse && active ? active : await this.engine.reviewRound(t.id)
    if ('wait' in r) return this.engine.reviewWaitWords(t.id, r.wait)
    const file = reviewerPromptFile(t.id, r.round)
    const prompt = readPromptFile(file)
    const round = r.round
    const reviewer = r.reviewer
    const env = { ...agentEnv(`${t.id}/Reviewer`, ROOT) }
    const step = (words: string) => {
      onStep?.(words)
      // the human watches the task's chat too: the round shows there while its pane is open
      if (words.startsWith(`Review round ${round} running in a pane`))
        this.chats.post(`${t.id}/Agent`, { id: `review-pane:${t.id}:${round}`, card: { id: `review-pane:${t.id}:${round}`, text: words } })
    }
    const got = await runReviewInPane({
      id: t.id,
      round,
      reviewer,
      cwd: t.worktree!,
      workspace: `${t.id} ${t.title}`,
      prompt,
      env,
      onStep: step,
      trust: trustWorktree,
      prepare: async (kind, _chat, rev) => {
        if (kind === 'opencode') return { session: await createSession({ cwd: t.worktree!, title: `${t.id} reviewer ${round}`, model: rev.model, effort: rev.effort, deny: ['edit'] }) }
        if (kind === 'codex')
          // codex gives its tools the environment its own policy names, not the pane's shell environment (agents.ts)
          return {
            sessionId: randomUUID(),
            extra: [
              '-c',
              `shell_environment_policy.set={${Object.entries(env)
                .map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`)
                .join(',')}}`,
            ],
          }
        if (kind === 'agy') return { sessionId: randomUUID(), modelId: rev.model ? agyModelId(rev.model, rev.effort, agyIds()) : undefined }
        return { sessionId: randomUUID() }
      },
    })
    // replace the "running in a pane" card with how the round ended, so the chat never shows a stale running line
    const cardId = `review-pane:${t.id}:${round}`
    const cardText = got.failed
      ? `Review round ${round} fell back to headless: its pane could not open.`
      : got.error
        ? `Review round ${round} ended early: its reviewer gave an error.`
        : `Review round ${round} finished in its reviewer pane.`
    this.chats.post(`${t.id}/Agent`, { id: cardId, card: { id: cardId, text: cardText } })
    if (got.failed) {
      return `Round ${round} of ${r.rounds} counted for ${t.id}. Its reviewer pane could not open (${got.failed}), so this round fell back to headless. Review with ${reviewerWords(reviewer)}: run \`${reviewRunLine(reviewer)}\` (fill in <out>; <prompt> is ${file}), then \`shepherdr review ${t.id} --done\` when the round's review has finished.`
    }
    // an answer, even "no findings", is the round's review of its commit; a round that errored or was cut with nothing
    // written reviewed nothing, so it frees the reviewer and records no commit
    this.engine.reviewDone(t.id, undefined, !!got.findings)
    // a provider error is not a timeout: say which it was, and never call an empty cut-short answer "partial findings"
    const cut = got.error
      ? `The reviewer gave an error (${got.error}); ${got.findings ? 'these are its partial findings' : 'it wrote no findings before the error'}.\n\n`
      : got.cutShort
        ? `Cut short at the 900 s timeout; these are its partial findings.\n\n`
        : ''
    const unrecorded = got.findings ? '' : `\n\nThis round is not recorded as a review of ${t.id}'s commit: \`shepherdr ready\` asks for one this commit was reviewed on.`
    return `Review round ${round} of ${r.rounds} for ${t.id} ran in a herdr pane (${reviewer.kind}); its pane is closed and its reviewer is free. Prompt: ${file}.\n\n${cut}${got.findings || 'The reviewer wrote no findings before its turn ended.'}${unrecorded}`
  }

  async command(p: Parsed, ctx: { chat?: string; pane?: string; cwd?: string; stdin?: string; local?: boolean }, onStep?: (words: string) => void): Promise<string> {
    const [a0, a1, ...rest] = p.words
    if (!a0) return HELP
    if (a0 === 'help') return helpTopic(a1)
    if (p.flags.has('help')) {
      const section = helpVerb(a0)
      if (section) return section
    }
    switch (a0) {
      case 'status': {
        if (a1) return this.reportCommand(a1, rest, p, ctx)
        const kept = this.engine.keptLeftovers()
        const parked = this.parkedCount()
        if (p.flags.has('json'))
          return JSON.stringify(
            {
              machine: NAME,
              spaces: this.places.shown().length,
              openTasks: this.engine.tasks.filter((t) => !ended(t) && !t.archived).length,
              herdr: this.agents.reachable,
              parked,
              paused: this.pausedSpaces(),
              spaceOrder: this.spaceOrderLine() || undefined,
              kept,
            },
            null,
            2,
          )
        const paused = this.pausedSpaces()
        const line = `Shepherdr on ${NAME}: ${this.places.shown().length} spaces, ${this.engine.tasks.filter((t) => !ended(t) && !t.archived).length} open tasks; herdr ${this.agents.reachable ? 'answers' : 'does not answer'}${parked ? `; ${parked} agent${parked === 1 ? '' : 's'} parked (a message to their chat starts each again)` : ''}${paused.length ? `; paused: ${paused.join(', ')}` : ''}.`
        const text = [line, this.spaceOrderLine()].filter(Boolean).join('\n')
        return kept.length ? `${text}\nDone tasks that kept work (remove it by hand once you're sure):\n${kept.map((k) => `  ${k}`).join('\n')}` : text
      }
      // project, from before spaces, is space
      case 'project':
      case 'space': {
        if (a1 === 'add') {
          const path = rest[0] ?? ctx.cwd
          if (!path) throw new Error('shepherdr space add <path> [--name NAME]')
          const asked = one(p, 'name')
          const { space: pr, found, existing, moved } = await this.addAsSpace(path, asked)
          const named = this.places.nameOf(placeId.space(pr.name)) ?? pr.name
          // a name asked for that the space already has does not take: say so, so it is not taken for the name it has
          const keeps = asked && asked !== pr.name ? ` It keeps its name ${named}.` : ''
          if (found && pr.was) {
            const turn = moved ? ` Its coordinator finishes its turn where it is: Restart agent in its row's menu puts it in the new folder.` : ''
            return `Found ${named} again at ${pr.path} (its folder was ${pr.was}), by its repo: its name, tasks, chat and mode are as they were.${keeps}${turn}`
          }
          if (existing) return `${named} is a space already (${pr.path}), with its tasks and chat.${keeps}`
          return `Added ${named} (${pr.path}) as a space; its tasks are ${pr.key}-1, ${pr.key}-2, …${pr.github ? ` GitHub: ${pr.github}.` : ' No GitHub remote: tasks merge here.'}`
        }
        if (a1 === 'list' || !a1) {
          const rows = this.orderedSpaces()
          if (p.flags.has('json'))
            return JSON.stringify(
              rows.map((x) => ({
                id: x.id,
                name: x.name,
                key: x.space?.key,
                folder: x.space ? this.places.folderLine(x.space) : boxHome(),
                github: x.space?.github,
                home: !x.space,
              })),
              null,
              2,
            )
          return rows
            .map((x) => (x.space ? `${x.name}  ${x.space.key}  ${this.places.folderLine(x.space)}${x.space.github ? `  github:${x.space.github}` : ''}` : `${x.name}  (home space)  ${boxHome()}`))
            .join('\n')
        }
        if (a1 === 'rename') {
          const x = rest[0] ? this.places.find(rest[0]) : undefined
          if (!x || !rest[1]) throw new Error('shepherdr space rename <name> <new-name> (shepherdr space list shows them)')
          const r = (await this.act({ type: 'rename', id: x.id, name: rest[1] })) as { ok?: boolean; error?: string }
          if (r.ok === false) throw new Error(r.error)
          return `${x.name} is called ${this.places.nameOf(x.id)} now.`
        }
        if (a1 === 'pause' || a1 === 'resume') {
          const name = rest[0] ?? one(p, 'space')
          const x = name ? this.places.find(name) : undefined
          if (!x) throw new Error(`shepherdr space ${a1} <name> (shepherdr space list shows them)`)
          const on = a1 === 'pause'
          // the CLI is two lines over the setting action: the same key, value and level, so it refuses what that refuses
          const r = (await this.act({ type: 'setting', key: 'space.maxTasks', value: on ? '0' : null, place: x.id })) as { ok?: boolean; error?: string }
          if (r.ok === false) throw new Error(r.error ?? `Could not ${a1} ${x.name}.`)
          const shown = this.places.nameOf(x.id) ?? x.name
          return on
            ? `${shown} is paused: its new tasks wait, held; tasks already running keep going. Resume with shepherdr space resume ${x.name}.`
            : `${shown} is not paused: its held tasks start by themselves again.`
        }
        if (a1 === 'set' && rest[0] === 'base') {
          const pr = this.projectFor(p, ctx)
          if (!rest[1]) throw new Error('shepherdr space set base <branch> --space NAME')
          await this.places.setBase(pr.name, rest[1])
          this.emit('snapshot')
          return `${this.places.shownName(pr.name)}: new tasks start from and merge into ${pr.base}. Existing tasks keep their target.`
        }
        if (a1 === 'remove') {
          if (!rest[0]) throw new Error('shepherdr space remove <name>')
          const shown = this.places.find(rest[0])?.name ?? rest[0]
          const pr = await this.removeSpace(rest[0])
          return `Removed ${shown} from Shepherdr; ${pr.path} and its code stay on disk. shepherdr space add ${pr.path} --name ${shown} brings it back with its open tasks and chat.`
        }
        throw new Error('shepherdr space add|list|rename|pause|resume|remove')
      }
      case 'mode': {
        const place = this.placeList().find((x) => x.name === a1 || x.id === a1)
        const mode = asMode(rest[0])
        if (!place || !mode) throw new Error('shepherdr mode <place> autopilot|regular')
        await this.act({ type: 'mode', place: place.id, mode })
        return `${place.name}: Autopilot ${mode === 'autopilot' ? 'on' : 'off'}.`
      }
      case 'task':
        return this.taskCommand(a1, rest, p, ctx)
      case 'restart':
        return this.restartCommand(a1, p, ctx)
      // a task's own agent counts each review round it starts, and is told which reviewer the caps leave it for that round
      // (engine.reviewRound); --done when the round's review has finished
      case 'review': {
        const t = this.engine.task(a1 ?? '')
        if (!t) throw new Error(`No task ${a1 ?? ''}; shepherdr review <id>`)
        if (ctx.chat !== `${t.id}/Agent`)
          throw new Error(`${t.id}'s own agent counts its review rounds, not ${ctx.chat ? 'this chat' : 'you at the command'}; a coordinator adds one with shepherdr task review-more ${t.id}`)
        if (p.flags.has('done')) {
          const before = t.reviewed?.length ?? 0
          const had = this.engine.reviewDone(t.id, one(p, 'commit'))
          const rec = (t.reviewed?.length ?? 0) > before ? t.reviewed?.at(-1) : undefined
          const on = rec ? `; the round is recorded on ${rec.commit.slice(0, 7)}` : ''
          if (had) return `Review of ${t.id} is done: its reviewer is free again${on}.`
          return rec ? `Review of ${t.id} is done: nothing was leased to release${on}.` : `No review of ${t.id} is running: nothing to release.`
        }
        if (one(p, 'run') !== undefined || p.flags.has('run')) return this.reviewRunCommand(t, one(p, 'run') ?? rest[0], ctx, onStep)
        const r = await this.engine.reviewRound(t.id)
        return 'wait' in r ? this.engine.reviewWaitWords(t.id, r.wait) : this.engine.reviewWords(t.id, r)
      }
      // done is ready's old name, still taken
      case 'ready':
      case 'done': {
        const t = this.engine.task(a1)
        if (!t) throw new Error(`No task ${a1}`)
        const { said, facts } = summaryOpts(p, rest)
        const r = await this.engine.done(t.id, said ?? '', facts)
        if (r.state === 'ended') return `Noted. ${t.id} is Done already (${t.closed ? 'nothing to merge' : 'merged'}).`
        if (r.state === 'merged')
          return `Noted: ${r.note}, so ${t.id} is Done (merged): there is nothing to merge, and no pull request to open.${ctx.chat === `${t.id}/Agent` ? ' Your worktree, branch and herdr space close once this turn ends: do nothing more in them.' : ''}`
        if (r.state === 'closed')
          return `Noted: ${t.branch} has no changes, so there is nothing to merge: ${t.id} is Done.${ctx.chat === `${t.id}/Agent` ? ' Your worktree, branch and herdr space close once this turn ends: do nothing more in them.' : ''}`
        return `Noted: ${t.id} shows as Ready to merge (not merged yet). Merge only when your brief or the human says so (shepherdr merge ${t.id}).`
      }
      case 'todo': {
        const t = this.engine.task(a1 ?? '')
        if (!t) throw new Error(`No task ${a1 ?? ''}; shepherdr todo <id>`)
        if (ctx.chat?.includes('/') && ctx.chat.split('/')[0].toUpperCase() !== t.id.toUpperCase()) throw new Error(`A task's agent says only its own task waits, not ${t.id}.`)
        this.engine.todo(t.id)
        return `Noted: ${t.id} shows as To do until it gets a go. Reply in one line that you have the brief, then end your turn.`
      }
      case 'merge':
        return this.mergeCommand(a1, ctx)
      case 'pr':
      case 'checks': {
        const t = this.engine.task(a1 ?? '')
        if (!t) throw new Error(`no task ${a1 ?? ''}; shepherdr ${a0} <id>`)
        if (ctx.chat?.includes('/') && ctx.chat.split('/')[0].toUpperCase() !== t.id.toUpperCase()) throw new Error(`A task's agent works on its own task's pull request only, not ${t.id}'s.`)
        const r = a0 === 'pr' ? await this.engine.openPr(t.id) : await this.engine.checks(t.id, undefined, onStep)
        if (!r.ok) throw new Error(r.text)
        return r.text
      }
      case 'plan': {
        const steps = p.opts.step ?? []
        if (!steps.length) throw new Error('shepherdr plan <id> --step "..." --step "..."')
        await this.engine.plan(a1, steps)
        return 'Plan posted. Stop now and wait: the yes, or a note, arrives as a message.'
      }
      case 'ask': {
        if (!ctx.chat) throw new Error('shepherdr ask works from an agent Shepherdr started')
        const title = a1
        const labels = p.opts.choice ?? []
        if (!title || labels.length < 2) throw new Error('shepherdr ask "<question>" --choice "<label>" --choice "<label>" …')
        const desc = Object.fromEntries((p.opts.desc ?? []).map((d) => d.split('=').map((s) => s.trim()) as [string, string]))
        const id = `ask:${randomUUID().slice(0, 8)}`
        this.chats.post(ctx.chat, {
          id,
          question: {
            id,
            title,
            ordinary: p.flags.has('ordinary') || undefined,
            kind: Object.keys(desc).length || p.flags.has('other') ? 'Question' : 'Form',
            choices: labels.map((label) => ({ label, description: desc[label] })),
            multi: p.flags.has('multi'),
            other: p.flags.has('other'),
            to: this.chatName(ctx.chat),
          },
        })
        this.emit('chat', ctx.chat)
        this.emit('snapshot')
        return 'Asked. End your turn now; the answer arrives as an [… answered …] line.'
      }
      case 'attach':
        return this.attachCommand([a1, ...rest].filter(Boolean), p, ctx)
      case 'artifact':
        return this.artifactCommand(a1, rest, p, ctx)
      case 'render':
      case 'preview':
        throw new Error(
          `shepherdr ${a0} is gone: pages are artifacts now. shepherdr artifact new <file.html> --title "…" shows one (checked at phone width first), shepherdr artifact check <file.html> only looks; shepherdr help has the rest.`,
        )
      case 'alert': {
        if (!a1) throw new Error('shepherdr alert "<title>" --body "<why>"')
        const t = one(p, 'task') ? this.engine.task(one(p, 'task')!) : undefined
        // another machine's task (the main machine's home space keeps every machine's overview): it opens on that task,
        // and while it waits on you it buzzes as the task's own alert would
        const far =
          one(p, 'task') && !t
            ? this.peers
                ?.list()
                .flatMap((l) => l.snap?.tasks ?? [])
                .find((x) => x.id.toUpperCase() === one(p, 'task')!.toUpperCase())
            : undefined
        const waits = far && (far.status === 'need' || far.status === 'ready') ? { tag: far.id, task: true as const } : {}
        // about a task: it opens on its card. While the task waits on you, it says what the task needs as its own alert
        // does (the choices first, then the coordinator's why) and takes that alert's place
        const about = t && this.taskAlert(t)
        const why = [a1, one(p, 'body')].filter(Boolean).join(': ')
        const from = ctx.chat ? this.chatName(ctx.chat) : 'Shepherdr'
        if (t && about && ['need', 'ready'].includes(this.engine.statusOf(t))) this.alert({ id: randomUUID(), from: 'Shepherdr', ...about, body: `${about.body}\n${from}: ${why}` })
        else if (far) this.alert({ id: randomUUID(), from, title: a1, body: one(p, 'body') ?? '', go: { place: far.place, task: far.id }, ...waits })
        else
          this.alert({
            id: randomUUID(),
            from,
            title: a1,
            body: one(p, 'body') ?? '',
            go: about?.go ?? { place: ctx.chat && !ctx.chat.includes('/') ? ctx.chat : placeId.home() },
            ...(ctx.chat?.includes('/') ? { task: true as const } : {}),
          })
        return 'Alert sent.'
      }
      case 'show': {
        // the defaults where it runs: its space's (a space's coordinator, one of its tasks, --space, or a folder in it),
        // else this machine's
        const pr = this.placeOfCommand(p, ctx)?.name
        const now = `${this.health.last ? `\n\n${NAME} now: ${summary(this.health.last)} · ${this.workingLine()}` : ''}`
        const head = `Defaults for ${pr ? `${this.places.nameOf(placeId.space(pr))} on ${NAME}` : NAME} (a space's own win over its machine's, which win over Everywhere; in brackets where each comes from):`
        const h = this.settings.heartbeat(pr ? { space: pr } : 'machine')
        const next = nextWords(h.time, h.zone)
        const beat = `\n\nHeartbeat on Autopilot: ${timeWords(h.time, h.zone)}${next.length ? ` (next ${next.join(', ')})` : ''}; news that wakes it at once: ${eventWords(h.on).toLowerCase()}, the rest waits for the heartbeat. Each brings the place's HEARTBEAT.md, its standing checklist: shepherdr heartbeat [<place>] shows it, shepherdr heartbeat set [<place>] < file changes it.`
        const block = settingsBlock('<id>', {
          ways: this.settings.ways(pr),
          reviewer: this.settings.harness('reviewer', pr),
          fallback: this.settings.reviewerBackups(pr),
          agent: this.settings.harness('task', pr),
          by: this.settings.setBy(pr),
        })
        const repo = pr ? this.places.byName(pr) : undefined
        const folder = repo ? `\nFolder: ${this.places.folderLine(repo)}${repo.repoId ? ` (found again by its repo's id ${shortId(repo.repoId)} if its folder is renamed or moved)` : ''}` : ''
        return `${head}${repo ? `${folder}\nBase branch: ${repo.base} (new tasks; per-task override: --base <branch>)` : ''}\n${this.settings.lines(pr, NAME)}${beat}${now}\n\nEvery new task's brief${pr ? ` in ${this.places.shownName(pr)}` : ''} ends with:\n${block}\n\nFor one task, set any of these with task add: --set review.rounds=1 --set merge="ask me first" (--set agent=codex, model, effort, reviewer, reviewer.model, reviewer.effort, reviewer.fallback, reviewer.fallbackModel, reviewer.fallbackEffort, task.fallback, coordinator.fallback, backup.model, backup.effort too, and a chain's 2nd to 5th backups by their own keys: task.fallback2, task.fallback2Model, task.fallback2Effort, reviewer.fallback2…), or say so in its brief, which wins.`
      }
      case 'profile':
        return this.profileCommand(a1, rest, p)
      case 'models': {
        if (p.flags.has('check')) {
          const { warnings, compared } = checkModelTable()
          if (!compared.length)
            return 'Model table: no CLI has a stored read yet, so nothing was compared; the fallback table is used until each CLI answers. pi, opencode and agy have no fallback table.'
          if (!warnings.length) return `Model table: no drift with the last stored read of ${compared.join(', ')} (CLIs with no read were skipped; pi, opencode and agy have no fallback table).`
          return `Model table: the fallback is stale (a warning, not a failure; the CLI's own answer still wins):\n  ${warnings.join('\n  ')}\nConfirm a model before editing the hand-kept table.`
        }
        const kinds = a1 ? [kindOf(a1)] : ['claude', 'codex', 'pi', 'opencode', 'agy']
        if (!kinds[0]) throw new Error(`No CLI called ${a1}; herdr starts ${CLIS.join(', ')}`)
        if (p.flags.has('json'))
          return JSON.stringify(
            kinds.filter((k): k is string => !!k).map((k) => ({ agent: k, cli: CLI_NAME[k], ...modelsOf(k) })),
            null,
            2,
          )
        return kinds
          .map((k) => {
            const c = modelsOf(k!)
            if (!c) return `${CLI_NAME[k!]}: Shepherdr passes it no model or effort; it picks its own.`
            const rows = c.models.map((m) => `  ${m.id.padEnd(28)} ${m.label === m.id ? '' : `${m.label}: `}${m.efforts.length ? m.efforts.join(', ') : 'no effort levels'}`)
            return `${CLI_NAME[k!]} (--agent ${k}), effort levels ${c.efforts.join(', ')}:\n${rows.length ? rows.join('\n') : '  any model id it knows'}${c.others?.length ? `\n  it also takes older ones by id: ${c.others.map((m) => m.id).join(', ')}` : ''}`
          })
          .join('\n\n')
      }
      case 'set':
      case 'unset': {
        const value = a0 === 'unset' ? null : rest.join(' ')
        if (!a1 || (a0 === 'set' && !value && !(a1.endsWith('.instructions') && rest.length))) throw new Error(`shepherdr ${a0} <key>${a0 === 'set' ? ' <value>' : ''}`)
        if (a1 === 'space.base') {
          if (a0 === 'unset' || !one(p, 'space')) throw new Error('Use shepherdr set space.base <branch> --space NAME; choose an explicit branch.')
          const pr = this.projectFor(p, ctx)
          await this.places.setBase(pr.name, value!)
          this.emit('snapshot')
          return `${this.places.shownName(pr.name)}: base branch ${pr.base}. Existing tasks keep their target.`
        }
        if (!CATALOG.some((s) => s.rows.some((r) => r.key === a1))) throw new Error(`No setting ${a1}; shepherdr show lists them`)
        // A browser page that got past same-site rules would send an Origin on its POST to /api/cli, so `local` is
        // false there. A shell running shepherdr (the operator, their alert installer) sends none and keeps working;
        // a local process gains nothing here anyway, as the lead's bound says (SEC-04).
        if (EXECUTABLE_KEYS.has(a1) && !ctx.local) throw new Error('Set it in Settings: a command here can only be changed from the Settings page.')
        const waiting = p.flags.has('apply-waiting')
        if (waiting && a0 === 'set' && a1.startsWith('advisor.')) throw new Error(`${ADVISOR_AT_ONCE} Set it without --apply-waiting.`)
        if (waiting && (a0 !== 'set' || !waitingKind(a1))) throw new Error('--apply-waiting goes with shepherdr set task.agent, task.model, task.effort or a reviewer.* key')
        // Everywhere unless it says --machine (this machine's own) or --space NAME (that space's own)
        const named = one(p, 'space')
        const pr = named ? (this.places.find(named)?.id === placeId.home() ? '~' : this.projectFor(p, ctx).name) : undefined
        if (a1 === 'space.priority' && pr === '~') throw new Error(HOME_NO_PLACE)
        const level: Level = pr ? { space: pr } : p.flags.has('machine') ? 'machine' : 'all'
        // what the setting kept otherwise than written, said after its value
        let note: string | undefined
        if (level === 'all' && BOX) {
          // the main machine keeps Everywhere: it sets it there, and this machine takes it at once
          const r = await mainCli([a0, a1, ...(value === null ? [] : [value])])
          if (r.code) throw new Error(r.out.trim())
          this.adoptEverywhere()
        } else {
          const r = this.settings.set(a1, value, level)
          if (!r.ok) throw new Error(r.error)
          note = r.note
        }
        this.settingChanged(a1)
        const applied = waiting ? this.applyWaiting(a1, level) : undefined
        const appliedWords = applied ? (waitingKind(a1) === 'reviewer' ? reviewRetuneLine(applied) : retuneLine(applied)) : undefined
        // the space as it shows (its settings are keyed by the name it was added under, and --space may name it by that)
        const where = pr ? `${this.places.nameOf(pr === '~' ? placeId.home() : placeId.space(pr)) ?? named}'s` : level === 'machine' ? `${NAME}'s` : "Everywhere's"
        const now = this.settings.get(a1, pr)
        // a trigger in words too, to tell the human
        return `${a0 === 'unset' ? `${a1}: ${where} own is unset; it is ${now} now.` : `${a1} = ${now} (${where})`}${this.settings.words(a1, now).replace(/^\n\s*/, '\nIn words: ')}${a1.endsWith('.instructions') ? '\nUsed at the next start or restart; running agents are unchanged. Reviewer changes need a new or restarted task agent.' : ''}${note ? `\n${note}` : ''}${appliedWords ? `\n${appliedWords}` : ''}`
      }
      case 'automation': {
        const op = a1 ?? 'list'
        const pr = one(p, 'space') || op !== 'list' ? this.projectFor(p, ctx) : null
        const place = pr ? placeId.space(pr.name) : ''
        const name = rest[0]
        const allowed = [
          'when',
          'on',
          'task',
          'brief',
          'desc',
          'space',
          'agent',
          'model',
          'effort',
          'flags',
          'name',
          ...(op === 'add' || op === 'edit' ? ['set'] : []),
          ...(op === 'list' ? ['json'] : []),
        ]
        const odd = [...Object.keys(p.opts), ...p.flags].filter((f) => !allowed.includes(f))
        if (odd.length)
          throw new Error(
            `Automation ${op} takes no --${odd[0]}: only --when (a time rule), --on (events), --task, --brief, --set, --agent, --model, --effort, --name and --space${op === 'list' ? ', plus --json on list' : ''}`,
          )
        // --set pairs, or a bare --set to clear them on edit; parse before the agent flags it can also name
        const sets = (op === 'add' || op === 'edit') && (p.flags.has('set') || p.opts.set?.length) ? automationSet(p, ctx.local) : undefined
        const agent = one(p, 'agent') || one(p, 'model') || one(p, 'effort') || one(p, 'flags') ? harnessOf(p, this.settings) : undefined
        if (agent) {
          const flags = flagsOf(p, this.settings, pr?.name)
          if (flags !== undefined) agent.flags = flags
        }
        const brief = one(p, 'brief') ?? one(p, 'desc')
        const zone = this.settings.zone()
        const runs = (x: Automation) => (x.runs?.at(-1) ? `last ran ${age(x.runs.at(-1)!.at)} ago: ${x.runs.at(-1)!.task ?? `failed (${x.runs.at(-1)!.error})`}` : 'not run yet')
        // its trigger in words, its next runs, and as kept (for an edit)
        const told = (x: Automation) => {
          const next = x.on ? nextWords(x.trigger.time, zone) : []
          return `${triggerWords(x.trigger, zone)}${next.length ? `; next ${next.join(', ')}` : ''} [${[x.trigger.time && `--when "${x.trigger.time}"`, x.trigger.on?.length && `--on "${eventsText(x.trigger.on)}"`].filter(Boolean).join(' ')}]`
        }
        if (op === 'add') {
          if (!name || !one(p, 'task') || (!one(p, 'when') && !one(p, 'on')))
            throw new Error('shepherdr automation add "<name>" --task "<title>" [--brief "<brief>"] [--when "<time rule>"] [--on "<events>"] [--set KEY=VALUE …] (one or both)')
          const x = this.automation(place, 'add', undefined, { name, when: one(p, 'when'), on: one(p, 'on'), title: one(p, 'task')!, brief, agent, set: sets }) as Automation
          return `Automation “${x.name}” is on: ${told(x)}. It adds the task “${x.task.title}” to ${this.places.shownName(pr!.name)}, with a fresh agent. Tell the human when it runs in these words.`
        }
        if (op === 'edit') {
          if (!name)
            throw new Error(
              'shepherdr automation edit "<name>" [--name "<new name>"] [--task …] [--brief …] [--when "<time rule>" | off] [--on "<events>" | none] [--set KEY=VALUE …] [--agent …] (a bare --set clears it)',
            )
          const when = one(p, 'when')
          const on = one(p, 'on')
          const x = this.automations.edit(place, name, {
            name: one(p, 'name'),
            time: when !== undefined ? timeRule(when) : undefined,
            on: on !== undefined ? eventRules(on) : undefined,
            task: { ...(one(p, 'task') ? { title: checkTitle(one(p, 'task')!) } : {}), ...(brief !== undefined ? { desc: brief || undefined } : {}), ...(agent ? { agent } : {}) },
            set: sets,
          })
          this.emit('snapshot')
          return `Automation “${x.name}” changed: ${told(x)}.`
        }
        if (op === 'pause' || op === 'resume' || op === 'run' || op === 'remove') {
          if (!name) throw new Error(`shepherdr automation ${op} "<name>"`)
          const r = this.automation(place, op, name)
          if (op === 'run') return `Ran “${name}”: added ${(r as TaskRec).id}.`
          return op === 'remove' ? 'Removed.' : op === 'pause' ? `Paused “${name}”.` : `“${name}” is on again.`
        }
        if (op !== 'list') throw new Error('shepherdr automation add|edit|pause|resume|run|remove|list')
        const shown = this.automations.list.filter((x) => !place || x.place === place)
        if (p.flags.has('json')) return JSON.stringify(shown, null, 2)
        return (
          shown
            .map(
              (x) =>
                `${x.name} · ${told(x)} · adds “${x.task.title}”${x.task.agent?.kind ? ` (${[x.task.agent.kind, x.task.agent.model, x.task.agent.effort].filter(Boolean).join(', ')})` : ''} · ${this.places.space(x.place) ? this.places.nameOf(x.place) : x.place}${x.on ? '' : ' · paused'} · ${runs(x)}`,
            )
            .join('\n') || 'No automations.'
        )
      }
      case 'heartbeat': {
        // a space by its name, else the coordinator asking, else the space of its folder, else the home space. Its
        // checklist is printed and changed here, never named by path: the file is on the machine Shepherdr runs from
        const set = a1 === 'set'
        const run = a1 === 'run'
        const name = set || run ? rest[0] : a1
        const named = name ? this.placeList().find((x) => x.name === name || x.id === name) : undefined
        if (name && !named) throw new Error(`No space ${name}`)
        const at =
          named ??
          this.placeList().find((x) => x.id === ctx.chat) ??
          this.placeList().find((x) => this.placeOfCommand(p, ctx) && x.id === placeId.space(this.placeOfCommand(p, ctx)!.name)) ??
          this.placeList().find((x) => x.id === placeId.home())!
        if (this.peers?.owner(at.id)) throw new Error(`${at.name} is on another machine: ask there`)
        // Run now: one heartbeat at once, the same as the pill's Run now and Settings' (refused while one wakes)
        if (run) {
          const r = this.wake(at.id)
          return r.queued
            ? `${r.name}'s coordinator is busy: it wakes once its turn is over, and says in the chat whether it found anything.`
            : `Woke ${r.name}'s coordinator: one heartbeat now. It says in the chat whether it found anything.`
        }
        if (set) {
          if (ctx.stdin === undefined) throw new Error('Give the whole new HEARTBEAT.md on stdin: shepherdr heartbeat set [<place>] < file, or with a heredoc. Empty stops the heartbeat.')
          this.heartbeats.write(at.id, ctx.stdin.trim() ? ctx.stdin : '')
          this.emit('snapshot')
          return ctx.stdin.trim() ? `${at.name}'s HEARTBEAT.md is saved: the next heartbeat goes through it.` : `${at.name}'s HEARTBEAT.md is empty now: no heartbeat until it has a checklist again.`
        }
        const h = this.settings.heartbeat(this.levelOf(at.id))
        const last = this.heartbeats.last(at.id)
        // on Autopilot, the next one counts from the last; else the rule's next three
        const due = at.mode === 'autopilot' && last ? this.heartbeats.next(at.id, h.time, h.zone) : undefined
        const times = due !== undefined ? [runWords(due, h.zone)] : nextWords(h.time, h.zone)
        const when = `${timeWords(h.time, h.zone)}${due !== undefined ? `; last ${age(last!)} ago` : ''}${times.length ? `; next ${times.join(', ')}${due !== undefined ? ' once idle' : ''}` : ''}`
        const held = this.heartbeats.held(at.id)
        const list = this.heartbeats.read(at.id, this.roleOf(at.id)).trim()
        // what a scheduled heartbeat over this place would find now: nothing, and it is skipped (heartbeatSkip)
        const skips = at.mode === 'autopilot' && this.roleOf(at.id) === 'space' && !!list && !wakesAnyway(list) && !this.heartbeatWork(at.id).length
        return [
          `${at.name}: Autopilot ${at.mode === 'autopilot' ? 'on' : 'off'}; heartbeat: ${when}. Wakes at once on: ${eventWords(h.on).toLowerCase()}${held.length ? ` (${held.length} news waiting for the heartbeat)` : ''}. (Settings: heartbeat.when, heartbeat.on, time.zone.)`,
          skips ? `Next wake would be skipped: nothing to do. To be woken every time, add ${WAKE_ANYWAY} to its HEARTBEAT.md.` : '',
          list ? `HEARTBEAT.md${existsSync(heartbeatFile(at.id)) ? '' : ' (the starting checklist: none saved yet)'}:\n${list}` : 'HEARTBEAT.md is empty: no heartbeat until it has a checklist.',
          `Change it: shepherdr heartbeat set${named ? ` ${at.name}` : ''} < file (the whole new text on stdin; empty stops the heartbeat), or the human in Settings → Autopilot.`,
          `Wake it once now: shepherdr heartbeat run${named ? ` ${at.name}` : ''} (one wake at a time, only on Autopilot).`,
        ]
          .filter(Boolean)
          .join('\n\n')
      }
      case 'doctor': {
        if (p.flags.has('json')) throw new Error('shepherdr doctor takes no --json; its answer is words, not records')
        if (BOX) throw new Error(`shepherdr doctor checks every machine from the main one: run it there (${HOST} is run from it over SSH).`)
        const own = `${NAME} (this machine, the main one): herdr ${this.agents.reachable ? 'answers' : 'does not answer'}${this.browsers ? `; shared browser ${this.browsers.status().ready ? 'ready' : this.browsers.status().hint}` : ''}`
        const named = this.settings.get('app.hosts').trim()
        const hosts = named ? `app.hosts: ${named}` : 'app.hosts is unset: only the loopback page works. On this machine run: shepherdr set app.hosts <host> (the host your phone uses).'
        const allowed = parseHosts(named)
        const still = [...refusedHosts].filter((h) => !allowed.includes(h) && !allowed.includes(h.replace(/:\d+$/, '')))
        const refused = still.length ? `Refused Host headers: ${still.join(', ')}. To allow one on this machine run: shepherdr set app.hosts <host>.` : ''
        return [
          own,
          hosts,
          refused,
          ...this.stall.report(),
          ...perfReport(this.health.samples),
          ...swallowedReport(),
          ...this.pushWarnings().map((warning) => `Alerts: ${warning}`),
          ...this.agents.unreadableLogs(),
          ...orphanLines(this.orphansFound),
          ...this.staleInstallLines(),
          ...resourceLines(await this.resourceReader()),
          ...((await this.peers?.doctor(onStep)) ?? []),
          ...(await this.places.doctor()),
        ]
          .filter(Boolean)
          .join('\n')
      }
      case 'secret': {
        if (a1 !== 'elevenlabs') return this.secretCommand(a1, rest, p, ctx)
        if (!ctx.stdin?.trim()) throw new Error('echo "<key>" | shepherdr secret elevenlabs')
        const s = readJson<Record<string, string>>('secrets.json', {})
        s.elevenlabs = ctx.stdin.trim()
        writeJson('secrets.json', s)
        return 'Saved. Voice calls use it from now on.'
      }
    }
    throw new Error(`No command ${a0}; shepherdr help lists them`)
  }

  /** the levels a command's secrets come from, most specific first: its space (the asking agent's, or the folder's),
   *  this machine, Everywhere */
  private secretChain(ctx: { chat?: string; cwd?: string }) {
    const space = ctx.chat?.includes('/')
      ? this.engine.task(ctx.chat.split('/')[0])?.project
      : ctx.chat?.startsWith('p:')
        ? ctx.chat
        : ctx.cwd
          ? this.places.forPath(ctx.cwd) && placeId.space(this.places.forPath(ctx.cwd)!.name)
          : undefined
    return [...(space ? [space] : []), placeId.machine(), 'all']
  }

  /** the level a human's shepherdr secret set or rm is for: Everywhere (none), this machine, or one space */
  private secretLevel(p: Parsed) {
    if (one(p, 'space')) return placeId.space(this.projectFor(p, {}).name)
    return p.flags.has('machine') ? placeId.machine() : 'all'
  }

  private secretCommand(sub: string | undefined, rest: string[], p: Parsed, ctx: { chat?: string; cwd?: string; stdin?: string }): string {
    const chain = this.secretChain(ctx)
    const name = rest[0]
    if (sub === 'list' || !sub) {
      const all = this.vault.visible(chain)
      if (!all.length) return 'No secrets here yet. Ask the human for one: shepherdr secret ask NAME --why "<what it is for>".'
      return `${all.map((x) => `${x.name}  (${this.secretLevelName(x.level)}, saved ${age(x.at)} ago)`).join('\n')}\nUse one by name: shepherdr secret run NAME -- <command>, or shepherdr secret env NAME --file .env.`
    }
    if (sub === 'ask') {
      if (!ctx.chat) throw new Error('shepherdr secret ask works from an agent Shepherdr started; add one yourself in Settings → Secrets, or with shepherdr secret set')
      if (!name || !SECRET_NAME.test(name)) throw new Error('shepherdr secret ask NAME --why "<what it is for>" (NAME: letters, digits and _, like GITHUB_TOKEN)')
      const had = this.vault.visible(chain).find((x) => x.name === name)
      if (had && !p.flags.has('force')) throw new Error(`${name} is kept already (${this.secretLevelName(had.level)}): use it. If it is wrong or expired, ask for a new one with --force.`)
      const id = `secret:${randomUUID().slice(0, 8)}`
      const levels = chain.map((l) => ({ id: l, label: this.secretLevelName(l) }))
      this.chats.post(ctx.chat, { id, secret: { id, name, why: one(p, 'why'), levels } })
      this.emit('chat', ctx.chat)
      this.emit('snapshot')
      return `Asked: your chat shows the human a masked box for ${name}. End your turn now; a <secret name="${name}"> line tells you once it is kept. Never ask for it in plain words.`
    }
    // only the main machine writes the vault: one writer, so no save is lost to another's at the same moment
    if ((sub === 'set' || sub === 'rm' || sub === 'remove') && BOX) throw new Error(`Secrets are kept on the main machine: set or remove them there, or in Settings → Secrets.`)
    if (sub === 'set') {
      if (!name || !SECRET_NAME.test(name)) throw new Error('shepherdr secret set NAME [--machine | --space NAME] < file (the value on stdin; none: Everywhere)')
      if (!ctx.stdin?.replace(/[\r\n]+$/, '')) throw new Error(`Give the value on stdin, never as a word: shepherdr secret set ${name} < file, or pipe it in.`)
      const level = this.secretLevel(p)
      const r = this.vault.set(level, name, ctx.stdin.replace(/[\r\n]+$/, ''))
      if (!r.ok) throw new Error(r.error)
      this.emit('snapshot')
      return `Saved ${name} for ${this.secretLevelName(level)}.`
    }
    if (sub === 'rm' || sub === 'remove') {
      if (!name) throw new Error('shepherdr secret rm NAME [--machine | --space NAME]')
      const level = this.secretLevel(p)
      const r = this.vault.set(level, name, null)
      if (!r.ok) throw new Error(`${r.error} (${this.secretLevelName(level)})`)
      this.emit('snapshot')
      return `Removed ${name} from ${this.secretLevelName(level)}.`
    }
    throw new Error('shepherdr secret list | ask NAME --why "…" | run NAME … -- <command> | env NAME … [--file .env] | set NAME [--machine | --space NAME] | rm NAME [--machine | --space NAME]')
  }

  /** where an artifact made here lives: the task's space, the coordinator's own space, the space you are in, else the
   *  home space */
  private artifactPlace(p: Parsed, ctx: { chat?: string; cwd?: string }) {
    if (one(p, 'space')) return placeId.space(this.projectFor(p, ctx).name)
    if (ctx.chat?.includes('/')) return this.engine.task(ctx.chat.split('/')[0])?.project ?? placeId.home()
    if (ctx.chat) return ctx.chat
    const here = ctx.cwd ? this.places.forPath(ctx.cwd) : undefined
    return here ? placeId.space(here.name) : placeId.home()
  }

  /** opens it at phone width, light and dark; refuses it when its scripts break or it reaches for the network */
  async checkArtifact(html: string, data: unknown, missing: string[]) {
    const c = await this.checker(html, data)
    const errors = [...missing.map((m) => `no picture at ${m} (or it isn't one under 1 MB)`), ...c.errors]
    // the pictures are taken here, on the main machine: an agent on another machine gets copies on its own
    let shots = c.shots
    // and never the main machine's own error, which names its paths
    let skipped = c.skipped && BOX ? 'the main machine could not open its browser (shepherdr doctor there says why)' : c.skipped
    try {
      if (shots) shots = { light: task.forAgent(shots.light, 'checks'), dark: task.forAgent(shots.dark, 'checks') }
    } catch (e) {
      shots = undefined
      skipped = `they could not be copied to ${NAME} (${(e as Error).message})`
    }
    const pics = shots ? `Pictures at phone width: ${shots.light} (dark: ${shots.dark}). Look at them.` : `No pictures: ${skipped ?? 'no browser here'}.`
    const warn = c.warnings.length ? `\nIt logged: ${c.warnings.join(' · ')}` : ''
    const media = c.media?.length ? `\nDoesn't fit at phone width (cut off, or it scrolls): ${c.media.join(' · ')}. Drop its fixed width or height: the frame fits media by itself.` : ''
    return { ok: !errors.length, c, report: errors.length ? `Problems:\n- ${errors.join('\n- ')}\n${pics}${warn}${media}` : `No errors. ${pics}${warn}${media}` }
  }

  /**
   * shepherdr attach <file> [<file> …] [--caption "…"]: a picture or a video the agent shows in its chat. The file is
   * copied into the chat's own inbox (the same folder the person's own attachments land in) and posted as a message of
   * the agent's, each file a message of its own right after the caption, so the screen draws it in place exactly as it
   * draws one the person sent: a tile, a video with its still (server/live/media.ts), the caption above.
   *
   * The copy is what makes it reachable: what it was in its worktree or /tmp never is, so no route serves a path a reply
   * names, and the file goes away with the chat's inbox.
   */
  private attachCommand(paths: string[], p: Parsed, ctx: { chat?: string; cwd?: string }): string {
    if (!ctx.chat) throw new Error("shepherdr attach works from an agent Shepherdr started: it sends into that agent's own chat.")
    const odd = [...Object.keys(p.opts), ...p.flags].filter((f) => f !== 'caption' && f !== 'text')
    if (odd.length) throw new Error(`shepherdr attach takes no --${odd[0]}: shepherdr attach <file> [<file> …] [--caption "…"]`)
    const caption = (one(p, 'caption') ?? one(p, 'text'))?.trim().replace(/\s*\n\s*/g, ' ') || undefined
    if (!paths.length) {
      // no path: what this folder has that it could send, so an agent that forgot the name finds it
      const here = (ctx.cwd ?? HOME).replace(/^~(?=\/)/, boxHome())
      let found: string[] = []
      try {
        found = task
          .readdirSync(here)
          .filter((n) => isMedia(n))
          .sort()
          .slice(0, 20)
      } catch {
        found = []
      }
      throw new Error(`shepherdr attach <file> [<file> …] [--caption "…"]: a picture or a video, shown in your chat where the person reads.${found.length ? `\nHere: ${found.join(' · ')}` : ''}`)
    }
    const dir = join(boxDir(), 'inbox', chatDir(ctx.chat))
    // every file is checked before one is copied, so a refusal leaves nothing behind in the inbox
    const checked = paths.map((path) => {
      const real = path.replace(/^~(?=\/)/, boxHome())
      let st: ReturnType<typeof task.statSync>
      try {
        st = task.statSync(real)
      } catch {
        throw new Error(`No file ${path}: shepherdr attach takes a picture or a video on this machine, by its path`)
      }
      if (!st.isFile()) throw new Error(`${path} is not a file`)
      const name = real.split('/').pop()!
      if (!isMedia(name))
        throw new Error(
          `${name} is neither a picture nor a video: shepherdr attach shows one of those in your chat (any picture the chat draws, and mp4, m4v, webm, mov or ogv). Anything else is words and a path.`,
        )
      if (st.size > ATTACH_MAX)
        throw new Error(`${name} is ${Math.round(st.size / 1024 / 1024)} MB: the chat takes a picture or a video up to ${ATTACH_MAX / 1024 / 1024} MB (crop it, or make it shorter first).`)
      // the bytes, never a link: a copy that is a link leads out of the inbox, and the chat would refuse to serve it
      return { real: task.realpathSync(real), name }
    })
    task.mkdirSync(dir, { recursive: true })
    const files = checked.map(({ real, name }) => {
      // its own path even next to a file of the same name, as an upload gets one: the message names the file by it
      const to = join(dir, `${Date.now().toString(36)}${randomUUID().slice(0, 4)}-${name.replace(/[^a-zA-Z0-9_. -]+/g, '_').slice(0, 120) || 'file'}`)
      task.cpSync(real, to)
      return { name, path: to }
    })
    // one post: the caption, then each file a message of its own, all at one time (pictures sent together lie side by side)
    const at = Date.now()
    this.chats.post(ctx.chat, { id: `media:${randomUUID().slice(0, 8)}`, at, ...(caption ? { text: caption } : {}), files })
    this.emit('chat', ctx.chat)
    this.emit('snapshot')
    const videos = files.filter((f) => isVideo(f.name)).length
    const pics = files.length - videos
    const what =
      files.length === 1
        ? videos
          ? 'a video'
          : 'a picture'
        : !videos
          ? `${files.length} pictures`
          : !pics
            ? `${files.length} videos`
            : `${files.length} files (${pics} ${pics === 1 ? 'picture' : 'pictures'}, ${videos} ${videos === 1 ? 'video' : 'videos'})`
    return `Posted ${what} in your chat${caption ? ', under your words' : ''}: the person sees ${files.length > 1 ? 'them' : 'it'} there in place.`
  }

  private async artifactCommand(sub: string | undefined, rest: string[], p: Parsed, ctx: { chat?: string; cwd?: string }): Promise<string> {
    if (!has('artifacts')) throw new Error('Artifacts are not in the plugin list')
    const cwd = ctx.cwd ?? HOME
    const by = ctx.chat ? this.chatName(ctx.chat) : this.user
    const post = (a: ArtifactRec, n: number) => {
      if (!ctx.chat) return
      this.chats.post(ctx.chat, { id: `artifact:${a.id}:${n}`, artifact: { id: a.id, v: n } })
      this.emit('chat', ctx.chat)
    }
    const find = (id: string | undefined) => {
      const a = id ? this.artifacts.get(id) : undefined
      if (!a) throw new Error(`No artifact ${id ?? ''} on this machine; shepherdr artifact list shows them`)
      return a
    }
    const dataOf = (r: { data?: string }) => (r.data !== undefined ? JSON.parse(r.data) : undefined)
    switch (sub) {
      case 'new': {
        const title = one(p, 'title')?.trim()
        if (!rest[0] || !title) throw new Error('shepherdr artifact new <file.html> --title "<title>" [--data <file.json>]')
        const r = Artifacts.read(rest[0], one(p, 'data'), cwd)
        const check = await this.checkArtifact(r.html!, dataOf(r), r.missing)
        if (!check.ok) throw new Error(`Not shown: fix these, then run it again.\n${check.report}`)
        const a = this.artifacts.create({ title, place: this.artifactPlace(p, ctx), by, chat: ctx.chat, html: r.html!, data: r.data, note: one(p, 'note') })
        if (check.c.shots) this.artifacts.setThumbs(a, check.c.shots)
        post(a, 1)
        this.emit('snapshot')
        return `Shown: artifact ${a.id} “${a.title}” v1${ctx.chat ? ', in your chat' : ''}, kept in ${this.chatName(a.place)}'s Artifacts. ${check.report}\nUpdate it, rather than making a new one: shepherdr artifact update ${a.id} [<file.html>] [--data <file.json>] [--note "<what changed>"]. Don't describe it in your reply: the human sees it.`
      }
      case 'update': {
        const a = find(rest[0])
        const r = Artifacts.read(rest[1], one(p, 'data'), cwd)
        if (!r.html && r.data === undefined && !one(p, 'title')) throw new Error(`shepherdr artifact update ${a.id} [<file.html>] [--data <file.json>] [--title "<title>"] [--note "<what changed>"]`)
        let check: Awaited<ReturnType<typeof this.checkArtifact>> | undefined
        if (r.html || r.data !== undefined) {
          check = await this.checkArtifact(r.html ?? this.artifacts.html(a) ?? '', r.data !== undefined ? dataOf(r) : this.artifacts.data(a), r.missing)
          if (!check.ok) throw new Error(`Not updated: fix these, then run it again.\n${check.report}`)
        }
        const v = this.artifacts.update(a, { by, chat: ctx.chat, html: r.html, data: r.data, note: one(p, 'note'), title: one(p, 'title')?.trim() })
        if (check?.c.shots) this.artifacts.setThumbs(a, check.c.shots)
        post(a, v.n)
        this.emit('snapshot')
        return `Updated: artifact ${a.id} “${a.title}” is v${v.n}${r.html ? '' : r.data !== undefined ? ' (same page, new data)' : ' (same page, new title)'}; open views of it change now. ${check?.report ?? ''}`.trim()
      }
      case 'check': {
        if (!rest[0]) throw new Error('shepherdr artifact check <file.html> [--data <file.json>]')
        const r = Artifacts.read(rest[0], one(p, 'data'), cwd)
        return (await this.checkArtifact(r.html!, dataOf(r), r.missing)).report
      }
      case 'show': {
        const a = find(rest[0])
        const last = this.artifacts.latest(a)
        const lines = [
          `${a.id} “${a.title}” in ${this.chatName(a.place)}: v${last.n}, ${age(last.at)} ago by ${last.by}. Its Send and notes go to ${this.chatName(this.keeperOf(a))}.`,
          // kept on the main machine: an agent on another machine gets copies on its own
          `HTML: ${task.forAgent(this.artifacts.file(a.id, last.html, 'html'), 'artifacts', `${a.id}-v${last.html}.html`)}`,
          last.data ? `Data: ${task.forAgent(this.artifacts.file(a.id, last.data, 'json'), 'artifacts', `${a.id}-v${last.data}.json`)}` : 'Data: none',
          `Copy them to edit; shepherdr artifact update ${a.id} makes the new version.`,
          'Versions:',
          ...[...a.versions].reverse().map((v) => `  v${v.n}  ${age(v.at)}  ${v.by}${v.html !== v.n ? (v.data === v.n ? '  (data only)' : '  (title only)') : ''}${v.note ? `  ${v.note}` : ''}`),
        ]
        return lines.join('\n')
      }
      case 'list':
      case undefined: {
        const pr = one(p, 'space') ? placeId.space(this.projectFor(p, ctx).name) : null
        const all = Object.values(this.artifacts.list)
          .filter((a) => !pr || a.place === pr)
          .sort((a, b) => b.at - a.at)
        if (p.flags.has('json')) return JSON.stringify(all, null, 2)
        return all.map((a) => `${a.id}  v${this.artifacts.latest(a).n}  ${a.title}  · ${this.chatName(a.place)} · ${age(a.at)}`).join('\n') || 'No artifacts here yet.'
      }
      case 'rm':
      case 'remove':
      case 'delete': {
        const a = find(rest[0])
        this.artifacts.remove(a.id)
        this.emit('snapshot')
        return `Deleted ${a.id} “${a.title}”.`
      }
    }
    throw new Error('shepherdr artifact new|update|check|list|show|rm')
  }

  private async taskCommand(sub: string | undefined, rest: string[], p: Parsed, ctx: { chat?: string; cwd?: string; local?: boolean }) {
    if (sub === 'add') {
      if (!rest[0]?.trim()) throw new Error('shepherdr task add "<title>" --desc "<the whole brief>"')
      if (p.flags.has('after')) throw new Error('--after needs the tasks it waits for: --after SHE-12,SHE-13')
      const odd = [...Object.keys(p.opts), ...p.flags].filter(
        (f) => !['brief', 'desc', 'space', 'base', 'after', 'at', 'in', 'later', 'priority', 'agent', 'model', 'effort', 'flags', 'reviewer', 'reviewer-model', 'reviewer-effort', 'set'].includes(f),
      )
      if (odd.length)
        throw new Error(
          `Task add takes no --${odd[0]}: only --desc, --space, --base, --after, --at, --in, --later, --priority, --set, --agent, --model, --effort, --flags, --reviewer, --reviewer-model and --reviewer-effort`,
        )
      // --set key=value: a How tasks work setting for this task, or what --agent, --reviewer and the like set
      const set: Record<string, string> = {}
      for (const pair of p.opts.set ?? []) {
        const r = setForTask(pair)
        if ('error' in r) throw new Error(r.error)
        // a per-task merge gate runs through sh too: a browser page (Origin present, local false) cannot plant one
        // through task add, while a shell on this machine still can (SEC-04)
        if ('key' in r && EXECUTABLE_KEYS.has(r.key) && !ctx.local) throw new Error('Set it in Settings: a command here can only be changed from the Settings page.')
        if ('flag' in r) (p.opts[r.flag] ??= []).push(r.value)
        else set[r.key] = r.value
      }
      const bare = [...p.flags].filter((f) => f !== 'later' && f !== 'priority')[0]
      if (bare) throw new Error(`--${bare} needs a value`)
      const title = checkTitle(rest[0])
      const named = one(p, 'space')
      if (named && !this.places.byName(named) && !this.places.byKey(named) && !this.places.space(named)) {
        // Helpers reach their own worker. Delegate a foreign target through the owning main installation.
        if (BOX && process.env.SHEPHERDR_MAIN_HOME) {
          const server = JSON.parse(readFileSync(join(process.env.SHEPHERDR_MAIN_HOME, 'server.json'), 'utf8')) as { port: number }
          const r = await fetch(`http://127.0.0.1:${server.port}/api/cli`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ args: taskAddArgs(rest, p), chat: this.requestedNews.known(ctx.chat) }),
            signal: AbortSignal.timeout(20_000),
          })
          const result = (await r.json()) as { out: string; code: number }
          if (result.code) throw new Error(result.out.trim())
          return result.out.trim()
        }
        const targets = (this.peers?.list() ?? []).flatMap((l) => (l.snap?.places ?? []).filter((x) => !x.home && (x.id === named || x.name === named)).map((x) => ({ l, x })))
        if (targets.length > 1) throw new Error('Several spaces have that name; use its full p:machine:space identity.')
        if (targets.length === 1) {
          const { l, x } = targets[0]
          const args = taskAddArgs(rest, p, x.id.split(':').slice(2).join(':'))
          const result = await this.onPeer<{ out: string; code: number }>(l, '/api/cli', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ args, chat: this.requestedNews.known(ctx.chat) }),
          })
          if (result.code) throw new Error(result.out.trim())
          return result.out.trim()
        }
      }
      const pr = named && this.places.space(named) ? this.places.space(named)! : this.projectFor(p, ctx)
      await validateBase(pr.path, one(p, 'base') ?? pr.base)
      // --at / --in: it starts by itself then, in the time zone Settings sets
      const at = one(p, 'at')
      const within = one(p, 'in')
      const when = at !== undefined || within !== undefined ? whenFrom(at, within, this.settings.zone()) : undefined
      const after = p.opts.after ?? []
      const agent = harnessOf(p, this.settings)
      // --flags (or --set flags=) is checked against the CLI this task will actually run, once, here
      const flags = flagsOf(p, this.settings, pr.name)
      const reviewer = reviewerOf(p, this.settings)
      const t = this.engine.add({
        project: pr.name,
        base: one(p, 'base'),
        title,
        desc: one(p, 'brief') ?? one(p, 'desc'),
        by: this.byWho(ctx),
        requester: this.requestedNews.known(ctx.chat),
        after,
        later: p.flags.has('later'),
        at: when,
        agent,
        reviewer,
        flags,
        set,
        priority: p.flags.has('priority'),
      })
      // one added for a time has no agent yet: nothing of Settings is read until it starts
      if (t.scheduled) {
        const starts = startsWords(t.scheduled.at, Date.now(), this.settings.zone())
        const waits = [t.after?.length ? `${t.after.join(', ')} ${t.after.length === 1 ? 'is' : 'are'} done` : '', 'the machine has room, as for any queued task'].filter(Boolean).join(' and ')
        return `Added ${t.id}: ${t.title}, ${starts.toLowerCase()}. It has no agent yet: it starts by itself then, once ${waits}, on the Settings as they are then.${p.flags.has('later') ? ` Its agent then reads the brief and waits for a go (shepherdr task tell ${t.id} "go").` : ''}`
      }
      const on = [CLI_NAME[t.agent!.kind] ?? t.agent!.kind, t.agent!.model, t.agent!.effort && `${t.agent!.effort} effort`].filter(Boolean).join(', ')
      if (t.after?.length)
        return `Added ${t.id}: ${t.title}, queued after ${t.after.join(', ')}. It has no agent, worktree or herdr space while it waits: once ${t.after.length === 1 ? 'that task is' : 'they are all'} done and the machine has room, its agent (${on}) starts on the brief. A message to it (shepherdr task tell ${t.id} …) starts its agent sooner, still queued.`
      if (p.flags.has('later')) return `Added ${t.id}: ${t.title}, for later. Its agent (${on}) reads the brief now and waits for a go (shepherdr task tell ${t.id} "go").`
      if (t.held)
        return `Added ${t.id}: ${t.title}, held: ${t.held.why === 'slots' ? `all ${this.settings.machine().max} slots are taken` : HELD_NAMED.has(t.held.why) ? this.heldWords(t.held.why, t) : 'the machine is busy'} (${this.workingLine()}). It shows as Queued and its agent (${on}) starts by itself when there's room, at its turn in the line (first in line, then each space's place, then oldest first).`
      return `Added ${t.id}: ${t.title}. Its agent (${on}) starts on the brief now.${after.length ? ' What it would wait for is done already.' : ''}`
    }
    if (sub === 'list' || !sub) {
      const pr = one(p, 'space') ? this.projectFor(p, ctx) : null
      // archived tasks only with --archived, and then only they
      const shown = (t: { archived?: unknown }) => !!t.archived === p.flags.has('archived')
      // the line read once for every row, as one snapshot reads it: a held row says what is ahead of it
      const line = this.engine.startLine()
      const ts = this.engine.tasks.filter((t) => (!pr || t.project === placeId.space(pr.name)) && shown(t)).map((t) => this.engine.view(t, line))
      const others = pr ? [] : (this.peers?.list() ?? []).flatMap((l) => (l.snap?.tasks ?? []).filter(shown).map((t) => ({ ...t, machine: l.rec.machine })))
      const all = doneNewestFirst<(typeof ts)[number] | (typeof others)[number]>([...ts, ...others])
      if (p.flags.has('json'))
        return JSON.stringify(
          all.map((t) => ({
            id: t.id,
            title: t.name,
            status: t.status,
            sub: statusLine(t),
            machine: 'machine' in t ? t.machine : undefined,
            archived: t.archived,
            pinned: t.pinned,
            ...(t.scheduled ? { scheduled: t.scheduled } : {}),
          })),
          null,
          2,
        )
      const rows = all.map(
        (t) => `${t.id.padEnd(8)} ${t.status.padEnd(5)} ${t.name}${t.pinned ? '  (pinned)' : ''}${statusLine(t) ? `  · ${statusLine(t)}` : ''}${'machine' in t ? `  (on ${t.machine})` : ''}`,
      )
      const archived = p.flags.has('archived') ? 0 : this.engine.tasks.filter((t) => t.archived && (!pr || t.project === placeId.space(pr.name))).length
      const tail = archived ? `\n(${archived} archived: shepherdr task list --archived)` : ''
      return (rows.join('\n') || (p.flags.has('archived') ? 'No archived tasks.' : 'No tasks.')) + tail
    }
    if (sub === 'merge') return this.mergeCommand(rest[0], ctx)
    if (sub === 'park') return this.parkCommand(rest.filter(Boolean), p.flags.has('yes'), ctx)
    if (sub === 'delete') {
      if (ctx.chat?.includes('/')) throw new Error("A task's agent can't delete tasks; only a coordinator does, when the human plainly asks.")
      const t = this.engine.task(rest[0] ?? '')
      if (!t) throw new Error(`No task ${rest[0] ?? ''}; shepherdr task delete <id> [--force]`)
      const left = await this.deleteTask(t.id, p.flags.has('force'))
      return `Deleted ${t.id}: its agent, chat, working folder and branch are gone${left.length ? `, except ${left.join(', ')} (remove that by hand)` : ''}.${t.merged ? ` Its commits stay on ${t.base ?? 'main'}.` : ''}`
    }
    const t = this.engine.task(rest[0] ?? '')
    if (!t) throw new Error(`No task ${rest[0] ?? ''}`)
    switch (sub) {
      case 'show': {
        const v = this.engine.view(t)
        if (p.flags.has('json')) return JSON.stringify(v, null, 2)
        // the rounds its agent counted, the one its coordinator may have added, and the commit the last one reviewed
        const rounds = t.reviews === undefined ? undefined : `Review rounds: ${t.reviews} of ${this.engine.roundsOf(t)} used${t.reviewsAdded ? ', one added by its coordinator' : ''}`
        const last = t.reviewed?.at(-1)
        const reviewed = last ? `Reviewed: round ${last.round} on ${last.commit.slice(0, 7)} (${last.reviewer.kind}${last.reviewer.model ? `/${last.reviewer.model}` : ''})` : undefined
        return [
          `${v.id} ${v.name}`,
          `State: ${v.state}${statusLine(v) ? ` · ${statusLine(v)}` : ''}${v.pinned ? ' · pinned' : ''}`,
          `Added: ${v.created}`,
          v.branch ? `Branch: ${v.branch}` : '',
          v.base ? `Merges into: ${v.base}` : '',
          rounds,
          reviewed,
          v.desc ? `\n${v.desc}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      }
      case 'tell': {
        // a coordinator's go to a task that waits starts it only when this machine has room; a message an agent's own
        // shell sends says who it came from, so the chat shows it as that agent's and never as the human's words
        const r = await this.engine.tell(t.id, rest.slice(1).join(' '), { gate: !ctx.chat?.includes('/'), from: await this.toldFrom(ctx) })
        if (r.held) return `${t.id} is held: ${this.heldWords(r.held, t)} (${this.workingLine()}). It shows as Queued and gets your message at its turn in the line.`
        return `Told ${t.id}.`
      }
      case 'start': {
        // yours alone: a coordinator puts one first in line with task priority, and the machine starts it at its turn
        if (ctx.chat) throw new Error(`Only the human starts a task now. To put ${t.id} first in line, run shepherdr task priority ${t.id}.`)
        const on = harnessOf(p, this.settings)
        const r = await this.engine.startNow(t.id, on.kind ? (on as Harness) : undefined)
        this.emit('snapshot')
        return r.held
          ? `${t.id} is first in line: ${this.heldWords(r.held, t)} (${this.workingLine()}). It starts as soon as there's room, ahead of the others.`
          : `Started ${t.id} now${on.kind ? ` on ${harnessWords(fitHarness(on as Harness))}` : ''}.`
      }
      case 'priority': {
        if (ctx.chat?.includes('/')) throw new Error("A task's agent doesn't set priorities: its coordinator or the human does.")
        const off = /^(off|no|none)$/i.test(rest[1] ?? '')
        this.engine.setPriority(t.id, !off)
        this.emit('snapshot')
        return off
          ? `${t.id} is back in line by its age.`
          : `${t.id} is first in line: it starts at the next free slot, past the machine's load, pressure and spacing (never past its ${this.settings.machine().max ?? 'unlimited'} slots)${t.after?.length ? `, once ${t.after.join(', ')} ${t.after.length === 1 ? 'is' : 'are'} done` : ''}.`
      }
      case 'queue': {
        const refs = p.opts.after ?? []
        const at = one(p, 'at')
        const within = one(p, 'in')
        // --at … / --in …: it starts by itself then; --at none (or "") cancels a time it waits for and starts it now
        if (at !== undefined || within !== undefined) {
          if (refs.length) throw new Error('One at a time: --at … or --after …, not both. A task scheduled --at still waits for what it is already --after.')
          if (within === undefined && /^(none|nothing|off|-|)$/i.test((at ?? '').trim())) {
            const r = this.engine.schedule(t.id, null)
            if (r.queued?.length) return `${t.id} no longer waits for a time: it starts once ${r.queued.join(', ')} ${r.queued.length === 1 ? 'is' : 'are'} done.`
            if (r.held)
              return `${t.id} no longer waits for a time, but is held: ${this.heldWords(r.held, t)} (${this.workingLine()}). It starts at its turn in the line (first in line, then each space's place, then oldest first).`
            return `${t.id} no longer waits for a time: it starts now.`
          }
          const when = whenFrom(at, within, this.settings.zone())
          this.engine.schedule(t.id, when)
          const after = this.engine.view(t).after ?? []
          return `${t.id} starts ${startsWords(when, Date.now(), this.settings.zone()).replace(/^Starts /, '')}. It waits for the machine's room like any queued task${after.length ? `, and for ${after.join(', ')}` : ''}; its Settings are read when it starts, not before.`
        }
        if (!refs.length) throw new Error('shepherdr task queue <id> --after SHE-12[,SHE-13]  (--after none clears it), or --at "tomorrow 9:00" / --in 6h  (--at none clears a time and starts it now)')
        const none = refs.length === 1 && /^(none|nothing|-)$/i.test(refs[0].trim())
        const r = this.engine.queue(t.id, none ? [] : refs, { self: ctx.chat === `${t.id}/Agent` })
        // one waiting for a time has no agent to tell: what it waits for is looked at once its time comes
        if (t.scheduled) {
          const starts = startsWords(t.scheduled.at, Date.now(), this.settings.zone()).replace(/^Starts /, '')
          if (!r.queued.length) return `${t.id} waits for no task now; it keeps its time (${starts}) and starts then.`
          return `${t.id} waits for ${r.queued.join(', ')} once its time comes (${starts}).`
        }
        if (r.queued.length)
          return `${t.id} is queued after ${r.queued.join(', ')}. ${ctx.chat === `${t.id}/Agent` ? 'Stop at a clean point, reply in one line and end your turn: Shepherdr tells you to go.' : 'Its agent is told to wait; Shepherdr tells it to go once they are done.'}`
        if (r.went)
          return t.held
            ? `${t.id} waits for no task now, but is held: ${t.held.why === 'slots' ? `all ${this.settings.machine().max} slots are taken` : HELD_NAMED.has(t.held.why) ? this.heldWords(t.held.why, t) : 'the machine is busy'} (${this.workingLine()}). Its agent gets the go when there's room.`
            : `${t.id} waits for nothing more: its agent is told to go.`
        return none ? `${t.id} was not queued.` : `${t.id} isn't queued: what it would wait for is done already.`
      }
      case 'stop': {
        const kept = await this.engine.stopTask(t.id)
        return `Stopped ${t.id}: its agent is closed${kept.length ? `; kept ${kept.join(', ')}` : ''}. Writing to it starts it again.`
      }
      case 'close': {
        if (ctx.chat?.includes('/'))
          throw new Error(`Coordinators close tasks. A task's agent reports with shepherdr ready ${ctx.chat.split('/')[0]} (with no changes on its branch, that is Done at once).`)
        const { said, facts } = summaryOpts(p)
        const { kept } = await this.engine.close(t.id, said, facts)
        return `Closed ${t.id}: it is Done, with nothing to merge, and its agent is closed${kept.length ? `; kept ${kept.join(', ')}` : t.worktree ? '; its working folder and branch are gone' : ''}.`
      }
      case 'archive':
      case 'unarchive': {
        if (ctx.chat?.includes('/')) throw new Error(`Only a coordinator ${sub}s tasks, when the human asks.`)
        if (sub === 'unarchive') {
          if (!t.archived) return `${t.id} isn't archived.`
          this.engine.unarchive(t.id)
          this.emit('snapshot')
          return `Brought ${t.id} back: it shows in its lists again (${this.engine.view(t).state}).`
        }
        if (t.archived) return `${t.id} is archived already.`
        const r = await this.engine.archive(t.id)
        this.emit('snapshot')
        return `Archived ${t.id}${r.stopped ? `: its agent was stopped first${r.kept.length ? `; kept ${r.kept.join(', ')}` : ''}` : ''}. It is out of every list; search and Archived still find it, and shepherdr task unarchive ${t.id} brings it back.`
      }
      case 'pause': {
        if (ctx.chat?.includes('/')) throw new Error(`Only a coordinator pauses tasks, when the human asks. To wait yourself: shepherdr todo ${ctx.chat.split('/')[0]}.`)
        await this.engine.pause(t.id)
        this.emit('snapshot')
        return `Paused ${t.id}: its agent was interrupted and it is To do. Its work, worktree and chat stay; any message to it (task tell) is the go to go on.`
      }
      case 'review-more': {
        const { rounds } = await this.engine.reviewMore(t.id, ctx.chat)
        return `${t.id} may now use ${rounds} review rounds, one more than its brief said: its agent is told to run it (its chat shows why it woke).`
      }
      case 'pin':
      case 'unpin': {
        if (ctx.chat?.includes('/')) throw new Error(`Only a coordinator ${sub}s tasks, when the human asks.`)
        const on = sub === 'pin'
        if (!!t.pinned === on) return on ? `${t.id} is pinned already.` : `${t.id} isn't pinned.`
        this.engine.pin(t.id, on)
        this.emit('snapshot')
        return on ? `Pinned ${t.id}: it shows in Pinned at the top of its tasks.` : `Unpinned ${t.id}: it is back in its group (${this.engine.view(t).state}).`
      }
    }
    throw new Error('shepherdr task add|list|show|tell|queue|stop|close|archive|unarchive|pin|unpin|pause|review-more|merge|delete')
  }

  /** shepherdr restart <space|id> [--agent CLI] [--model ID] [--effort LEVEL] [--save], or --all: every coordinator of
   *  this machine's spaces whose Settings changed; a task's agent restarts only its own task's */
  private async restartCommand(target: string | undefined, p: Parsed, ctx: { chat?: string }) {
    const usage = 'shepherdr restart <space|task id> [--agent CLI] [--model ID] [--effort LEVEL] [--save], or shepherdr restart --all'
    if (p.flags.has('all')) {
      const extra = [...Object.keys(p.opts), ...[...p.flags].filter((f) => f !== 'all')]
      if (target) throw new Error(`--all restarts every coordinator of this machine's spaces on what its Settings say, so it takes no space or task, not ${target}: shepherdr restart --all`)
      if (extra.length) throw new Error(`--all restarts every coordinator of this machine's spaces on what its Settings say, so it takes no --${extra[0]} of its own: shepherdr restart --all`)
      if (ctx.chat?.includes('/')) throw new Error("A task's agent restarts only its own agent; ask your coordinator or the human for --all.")
      const r = (await this.act({ type: 'restart-all' })) as { ok: boolean; error?: string; out?: string }
      if (!r.ok || !r.out) throw new Error(r.error ?? 'The coordinators could not be restarted.')
      return r.out
    }
    const odd = [...Object.keys(p.opts), ...p.flags].filter((f) => !['agent', 'model', 'effort', 'save'].includes(f))
    if (!target || odd.length) throw new Error(odd.length ? `Restart takes no --${odd[0]}: ${usage}` : usage)
    const t = this.engine.task(target)
    const peer = t ? undefined : (this.peers?.list() ?? []).flatMap((l) => l.snap?.tasks ?? []).find((x) => x.id.toUpperCase() === target.toUpperCase())
    const place = t || peer ? undefined : this.placeList().find((x) => x.name === target || x.id === target)
    const key = t ? `${t.id}/Agent` : peer ? `${peer.id}/Agent` : place?.id
    if (!key) throw new Error(`No space or task ${target}; ${usage}`)
    if (ctx.chat?.includes('/') && ctx.chat !== key) throw new Error("A task's agent restarts only its own agent; ask the coordinator.")
    const cli = one(p, 'agent')
    const kind = cli === undefined ? undefined : kindOf(cli)
    if (cli !== undefined && !kind) throw new Error(`No CLI called ${cli}; herdr starts ${CLIS.join(', ')}`)
    const info = (await this.act({ type: 'restart-info', chat: key })) as { ok: boolean; error?: string; info?: RestartInfo; waiting?: boolean }
    if (info.waiting) throw new Error(`${target}'s machine is out of reach: restart it once it is back.`)
    if (!info.ok || !info.info) throw new Error(info.error ?? 'It could not be restarted.')
    const on = kind ?? info.info.want.kind
    // what Settings say unless named: the model and effort only where they fit the CLI it restarts on
    const keep = on === info.info.want.kind
    const opts = fit(p, '', on, keep ? info.info.want.model : undefined)
    const model = 'model' in opts ? opts.model || undefined : keep ? info.info.want.model : undefined
    const effort = 'effort' in opts ? opts.effort || undefined : keep ? info.info.want.effort : undefined
    const r = (await this.act({ type: 'restart', chat: key, kind: on, model, effort, save: p.flags.has('save') })) as { ok: boolean; error?: string; waiting?: boolean; on?: string }
    if (r.waiting) return `${target}'s machine is out of reach: it restarts once it is back.`
    if (!r.ok) throw new Error(r.error ?? 'It could not be restarted.')
    return `Restarted ${t?.id ?? peer?.id ?? place!.name} on ${r.on}${p.flags.has('save') ? `, now its space's Settings too` : ''}. A card in its chat says so.`
  }

  /** a task's own agent merges its own task only; coordinators and you merge any */
  private async mergeCommand(id: string | undefined, ctx: { chat?: string }) {
    const t = this.engine.task(id ?? '')
    if (!t) throw new Error(`No task ${id ?? ''}; shepherdr merge <id>`)
    if (ctx.chat?.includes('/') && ctx.chat.split('/')[0].toUpperCase() !== t.id.toUpperCase()) throw new Error(`A task's agent merges only its own task, not ${t.id}.`)
    const r = await this.engine.merge(t.id, { self: ctx.chat === `${t.id}/Agent` })
    if (!r.ok) throw new Error(r.error)
    return `Merged ${t.id} into ${t.base}${r.note ? ` (${r.note})` : ''}.${ctx.chat === `${t.id}/Agent` ? ' Your worktree, branch and herdr space close once this turn ends: do nothing more in them.' : ''}`
  }
}

/** an automation's --set pairs: task add's parser, so its keys, values and refusals are the same. An agent key names
 *  the template's own agent (its --agent/--model/--effort); a reviewer is not part of an automation's template. */
function automationSet(p: Parsed, local?: boolean): Record<string, string> {
  const set: Record<string, string> = {}
  for (const pair of p.opts.set ?? []) {
    const r = setForTask(pair)
    if ('error' in r) throw new Error(r.error)
    // a per-task merge gate runs through sh too: a browser page (Origin present, local false) cannot plant one
    // through automation add, while a shell on this machine still can (SEC-04)
    if ('key' in r && EXECUTABLE_KEYS.has(r.key) && !local) throw new Error('Set it in Settings: a command here can only be changed from the Settings page.')
    if ('flag' in r) {
      if (r.flag.startsWith('reviewer')) throw new Error(`An automation's --set takes task ways, not ${r.flag}: its tasks use the space's reviewer.`)
      const flags = p.opts[r.flag] ?? []
      flags.push(r.value)
      p.opts[r.flag] = flags
    } else set[r.key] = r.value
  }
  return set
}

/** task add's --flags (or --set flags=): extra flags for this one task's agent CLI. Validated here, at set time,
 *  against the CLI it will run (an explicit --agent, else the space's task agent). "none" means no flags; an empty
 *  value or "default" leaves the space's Settings row to apply. */
function flagsOf(p: Parsed, settings: Settings, space?: string): string[] | undefined {
  const given = one(p, 'flags')
  if (given === undefined) return undefined
  const v = given.trim()
  if (!v || /^default$/i.test(v)) return undefined
  if (/^none$/i.test(v)) return []
  const cli = one(p, 'agent')
  // validate against the CLI this task will really run: its own --agent, else the TARGET space's task agent. A
  // machine-level lookup would check a Claude flag for a space that runs Codex (SHEP-266)
  const kind = cli === undefined ? settings.harness('task', space).kind : (kindOf(cli) ?? cli)
  try {
    return parseFlags(kind, v)
  } catch (e) {
    throw new Error(`--flags: ${(e as Error).message}`)
  }
}

/** task add's --agent, --model and --effort: what it sets for this one task, refused when it makes no sense */
function harnessOf(p: Parsed, settings: Settings): { kind?: string; model?: string; effort?: string; flags?: string[] } {
  const cli = one(p, 'agent')
  const kind = cli === undefined ? undefined : kindOf(cli)
  if (cli !== undefined && !kind) throw new Error(`No CLI called ${cli}; herdr starts ${CLIS.join(', ')}`)
  if (kind) {
    const problem = harnessProblem({ kind })
    if (problem) throw new Error(problem)
  }
  const h = settings.harness('task')
  return { ...(kind ? { kind } : {}), ...fit(p, '', kind ?? h.kind, kind && kind !== h.kind ? undefined : h.model) }
}

/** task add's --reviewer, --reviewer-model and --reviewer-effort: who reviews this one task's change, refused when it
 *  makes no sense */
function reviewerOf(p: Parsed, settings: Settings): { kind?: string; model?: string; effort?: string } {
  const cli = one(p, 'reviewer')
  if (cli !== undefined && refuse('reviewer.agent', cli)) throw new Error(`--reviewer ${cli}: ${refuse('reviewer.agent', cli)}`)
  const kind = cli === undefined ? undefined : kindOf(cli)
  const h = settings.harness('reviewer')
  return { ...(kind ? { kind } : {}), ...fit(p, 'reviewer-', kind ?? h.kind, kind && kind !== h.kind ? undefined : h.model) }
}

/** a --model and --effort as this CLI takes them (a model by its id), refused when it has no such model, or the model
 *  (or else `model`, Settings') takes no such level; default: the CLI's own */
function fit(p: Parsed, flag: '' | 'reviewer-', kind: string, model?: string): { model?: string; effort?: string } {
  const m = one(p, `${flag}model`)?.trim()
  const e = one(p, `${flag}effort`)?.trim().toLowerCase()
  const name = CLI_NAME[kind] ?? kind
  const c = modelsOf(kind)
  if (((m && m !== 'default') || (e && e !== 'default')) && !c) throw new Error(`Shepherdr passes a model and effort to Claude Code, Codex, pi, OpenCode and Antigravity only; ${name} runs on its own`)
  if (m !== undefined && refuse(`task.model`, m)) throw new Error(`--${flag}model ${m}: ${refuse('task.model', m)}`)
  const found = m && m !== 'default' ? findModel(kind, m) : undefined
  if (m && m !== 'default' && knowsModels(kind) && !found) throw new Error(`--${flag}model ${m}: ${name} has no such model. It takes ${c!.models.map((x) => x.id).join(', ')}, or default`)
  const on = m === undefined ? model : m === 'default' ? undefined : (found?.id ?? m)
  if (e !== undefined && e !== 'default') {
    const levels = effortsOf(kind, on)
    if (!levels.includes(e))
      throw new Error(
        levels.length
          ? `--${flag}effort takes default, ${levels.join(', ')}${on ? ` on ${findModel(kind, on)?.label ?? on}` : ` on ${name}`}`
          : `--${flag}effort: ${findModel(kind, on)?.label ?? on} takes no effort level`,
      )
  }
  const pick = (v?: string) => (v === undefined ? undefined : v === 'default' ? '' : v)
  return Object.fromEntries(Object.entries({ model: pick(m === undefined ? undefined : (found?.id ?? m)), effort: pick(e) }).filter(([, v]) => v !== undefined))
}

/** a worker's shepherdr command run by the main machine's Shepherdr, as the main machine's own */
async function mainCli(args: string[]): Promise<{ out: string; code: number }> {
  try {
    const { port } = JSON.parse(readFileSync(join(process.env.SHEPHERDR_MAIN_HOME ?? '', 'server.json'), 'utf8')) as { port: number }
    const r = await fetch(`http://127.0.0.1:${port}/api/cli`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) })
    return (await r.json()) as { out: string; code: number }
  } catch {
    return { out: "The main machine's Shepherdr can't be reached right now (it may be restarting): try again in a minute.", code: 1 }
  }
}

/** Preserve all task options when a helper asks for a task on another machine. */
function taskAddArgs(rest: string[], p: Parsed, space?: string): string[] {
  return [
    'task',
    'add',
    ...rest,
    ...Object.entries(p.opts).flatMap(([key, values]) => (key === 'space' && space ? [space] : values).flatMap((value) => [`--${key}`, value])),
    ...[...p.flags].map((key) => `--${key}`),
  ]
}

/** LiveSource's CLI face, bound so the moved bodies keep their `this.*` references verbatim. */
export function createCliCommands(src: object): CliCommands {
  const cli = new CliCommands()
  // Read the host live, not a copy made at construction: tests (and callers) replace its methods and objects after
  // LiveSource is built, and the moved bodies must see those replacements. Methods are called with src as their `this`.
  return new Proxy(cli, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      const value = Reflect.get(src, prop, src)
      return typeof value === 'function' ? value.bind(src) : value
    },
  })
}
