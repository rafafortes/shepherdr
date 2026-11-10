import { taskIdsSection } from './task-ids.ts'
import { coordinatorRequestIds } from '../../shared/attention.ts'
// The live source: herdr is the truth for agents and their states; the CLIs' own logs are the chats; Shepherdr keeps
// only what herdr can't tell it (spaces, tasks, modes, cards, settings). Assembled from the base plugins' parts.
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { BODY_MAX, clip, lastReply, openCards, taskAlert, TITLE_MAX } from '../../shared/alerts.ts'
import { deleteSection, moveSpace, newSection, PINNED, renameSection, sectionProblem, sortPlaces } from '../../shared/order.ts'
import { asEmoji, doneNewestFirst, modeCard, NAME_MAX, nameProblem, slugify, STATUS_MAX, type Action, type ActivityAnswer, type ActivityAsk, type AddSpace, type Alert, type Artifact, type CardAsk, type Chat, type RestartInfo, type Peer, type Question, type Folders, type Machine, type Need, type Place, type Section, type Snapshot, type Task, type TaskStatus, type UpdateCard, type WorktreeAsk } from '../../shared/types.ts'
import { Emitter, type Overview, type Source, type SourceEvents } from '../source.ts'
import { HOME, readJson, writeJson } from '../store.ts'
import { ROOT } from '../root.ts'
import { wrapPage } from '../frame.ts'
import { Agents, hidden, type Spec } from './agents.ts'
import { herdr } from './herdr.ts'
import { followCommand, isCommand } from './commands.ts'
import { effortsOf, findModel, knowsModels, modelsOf, nearest } from './models.ts'
import { picksOf, pinModel, rememberModel } from './model-picks.ts'
import { HELP, one, parseArgs, summaryOpts, type Parsed } from './args.ts'
import { Automations, type Automation, type Template } from './automations.ts'
import { Heartbeats, heartbeatFile, Wakes, wakeProblem } from './heartbeat.ts'
import { eventRules, eventsText, eventWords, matches, nextWords, runWords, timeRule, timeWords, triggerWords, type Happened, type TriggerEvent } from './trigger.ts'
import { startsWords, whenFrom } from '../../shared/when.ts'
import { Browsers, type BrowserBridge, type BrowserClient } from './browser.ts'
import { excerpt, fromAgent, line, tag, type FromAgent } from './chatlines.ts'
import { Chats, menuId, menuKeys, rememberReply } from './chats.ts'
import { DISMISSED, dismissKind, dismissWords } from './dismiss.ts'
import { dictate as dictation } from './dictate.ts'
import { age, askOf, checkTitle, ended, Engine, fitStatus, type HeldWhy, type TaskRec } from './engine/engine.ts'
import { listFolders, makeRepo, resolveInHome } from './folders.ts'
import { sh, validateBase } from './engine/git.ts'
import { Artifacts, browserChecker, type ArtifactRec, type Checker } from './artifacts.ts'
import { Machines } from './machines.ts'
import { agentEnv, BOX, boxHome } from './box.ts'
import { ATTACH_MAX, fileType, isMedia, isVideo } from '../../shared/files.ts'
import { smaller, type Small } from './media.ts'
import { Mirror } from './mirror.ts'
import { claudeProjectDir, piSessionDir } from './readers/find.ts'
import { boxDir } from './mfs.ts'
import * as task from './mfs.ts'
import { asMode, HOME_SPACE, HOST, NAME, placeId, Places, shortId, type Space } from './places.ts'
import { privatePrompt, coordinatorPrompt, backupCardWords, wentBackCardWords, type BackWhy, backupKeptLine, coordinatorHandOverLine, relaunchedLine, restartLine, resumedLine, settingsBlock } from './prompts.ts'
import { fitHarness, harnessProblem, harnessWords, recentChat, restartAllWords, restartHint, restartInfo, sameHarness, type Harness, type RestartAllRow } from './restart.ts'
import { backCard, canProbe, FIRST_WAIT, FRESH, QUIET, returnMode, Returns, type Outage, type Probe } from './return.ts'
import { adviceWords, advisorPrompt, advisorWords, Advices, canAdvise, parseAdvice, runAdvisor, type Advice, type AdviceQuestion } from './advisor.ts'
import { Revivals, type Wrong } from './revive.ts'
import { RESUME_SETTLE, Starts, type StartStep } from './start.ts'
import { carryOn, Retries, type Retry } from './retry.ts'
import { CATALOG, CLI_NAME, CLIS, kindOf, MAX_BACKUPS, refuse, setForTask, repositorySection, Settings, type Level } from './settings.ts'
import { startVoice } from './voice.ts'
import { SECRET_NAME, secretPages, Vault } from './secrets.ts'
import { diffFiles, diffPatch, listFiles, pullRequest, readFile } from './worktree.ts'
import { RequestedNewsMailbox } from './requested-news.ts'
import { Unread } from './unread.ts'
import { Monitor, meters, procLines, summary, topProcs, type HealthEvent, type Kind } from './health.ts'
import { has, PLUGIN_KEY, pluginSection, setPluginOn } from '../plugins.ts'
import { TOOK_OVER, type TookOver } from '../../scripts/take-over.ts'

/** a start that never became a turn, in one line for the chat and the task: which CLI, and the reason it stopped on */
const startWords = (kind: string | undefined, why: string) => `${kind ? (CLI_NAME[kind] ?? kind) : 'Its agent'} couldn't start: ${why}`

function userName(): string {
  const set = readJson<{ user?: string }>('config.json', {}).user
  if (set) return set
  try {
    const n = execSync('git config --global user.name', { encoding: 'utf8' }).trim().split(/\s+/)[0]
    if (n) return n
  } catch {
    /* no git name */
  }
  const u = process.env.USER ?? 'You'
  return u[0].toUpperCase() + u.slice(1)
}


export class LiveSource extends Emitter<SourceEvents> implements Source {
  readonly kind = 'live' as const
  user = userName()
  settings = new Settings()
  places = new Places()
  agents = new Agents()
  chats = new Chats(
    this.agents,
    (k) => this.chatName(k),
    () => this.user,
    (p) => this.peerOf(p),
  )
  engine = new Engine(this.agents, this.chats, this.places, this.settings)
  automations = new Automations()
  heartbeats = new Heartbeats()
  /** Autopilot's Run now: the wake a tap waits for, and the one its turn runs */
  wakeQueue = new Wakes()
  artifacts = new Artifacts()
  /** agents' secrets: one file on the main machine, which a worker for another machine reads there */
  vault = new Vault(process.env.SHEPHERDR_MAIN_HOME || HOME)
  /** opens an artifact at phone width before anyone sees it (a test puts its own here) */
  checker: Checker = browserChecker(
    // on this machine, whichever machine the artifact came from
    (args) => sh(['agent-browser', ...args], HOME, { timeoutMs: 45_000, here: true }),
    (html, data) => wrapPage(html, { check: true, phone: true, data }),
  )
  /** turns the model's provider cut off: waited out and tried again, then a task's backup agent or the human (retry.ts) */
  retries = new Retries({
    nudge: (key, text) => {
      // a task stopped, paused or finished meanwhile is left as it is
      if (key.includes('/') && !this.engine.mayRetry(key)) return this.retries.clear(key)
      this.agents.send(key, text, { ensure: this.starter(key) }).catch(() => undefined)
    },
    over: (key, r) => this.cannotGoOn(key, r),
    changed: (key) => {
      if (key.includes('/')) this.engine.retried(key)
      this.emit('snapshot')
    },
  })
  /** the primary models of the roles whose agents a backup took over: asked now and then whether they answer again
   *  (Settings → Agents → Backup → When the primary is back; return.ts) */
  returns = new Returns()
  /** one pass of the way back at a time (watchReturns): its probes, and the restarts that take agents back */
  private returning = false
  /** what the advisor was asked, per question (Settings → Agents → Advisor; advisor.ts) */
  advices = new Advices()
  /** one advisor run at a time, the human's own first */
  private advising = false
  /** run one advisor (a test puts its own here) */
  runAdvisor: typeof runAdvisor = runAdvisor
  /** this machine's load, memory, disks and herdr, sampled every 30 seconds; its coordinator hears when one is past
   *  its limit (Settings → the machine). Tests never measure the machine they run on: they tick it themselves */
  health = new Monitor(
    () => this.settings.machine(),
    () => this.agents.reachable,
    (e) => void this.onHealth(e).catch(() => undefined),
    undefined,
    { read: () => readJson('health.json', {}), write: (w) => writeJson('health.json', w) },
  )
  /** when each chat last had something new, and how far you have read each (on the main machine) */
  unread = new Unread()
  /** when this server started: only what comes after it buzzes as a new message */
  private born = Date.now()
  private requestedNews = new RequestedNewsMailbox(process.env.SHEPHERDR_MAIN_HOME ?? HOME)
  private drainingNews = false
  private watched: string[] = []
  /** the task whose card went up last, for its news that follows at once */
  private carded?: string
  private terms: string[] = []
  private timers: ReturnType<typeof setInterval>[] = []
  private replyFns = new Map<string, Set<(t: string) => void>>()
  private lastAgentMsg = new Map<string, string>()
  /** coordinators being started again in their own folder (reseat) */
  private reseating = new Set<string>()
  /** agents that stopped or run on outdated files, started again by Shepherdr (revive.ts) */
  revivals = new Revivals()
  private reviving = new Set<string>()
  /** what each start has shown, and what was said of it: a start that never becomes a turn (start.ts) */
  starts = new Starts()
  private watchingStarts = new Set<string>()
  /** the launch each chat's agent began a turn in: a start it has since left is never looked at again */
  private begunStarts = new Map<string, number>()
  /** when a busy machine last had its finished tasks' browsers closed */
  private sweptAt = 0
  devices: () => string[] = () => []
  pushWarnings: () => string[] = () => []
  /** the main machine runs every other machine saved in herdr, each from a worker of its own (machines.ts); a worker
   *  is one of those (box.ts) */
  peers: Machines | null = BOX ? null : new Machines(process.env.NODE_ENV === 'test' ? null : undefined)
  /** a worker's copy of its machine's agent logs, as they grow */
  mirror = BOX ? new Mirror(BOX) : null
  /** each task's shared browser */
  browsers = has('browser')
    ? new Browsers({
        host: NAME,
        user: () => this.user,
        working: (task) => this.agents.status(`${task}/Agent`) === 'working',
        tell: (task, text) => void this.agents.send(`${task}/Agent`, hidden(text, 'browser')).catch(() => undefined),
        idleClose: (task) => {
          const t = this.engine.task(task)
          return this.settings.idleClose(t ? this.levelOf(t.project) : 'machine')
        },
      })
    : null

  constructor() {
    super()
    this.timers.push(setInterval(() => void this.drainRequestedNews(), 1000))
    this.agents.secretScope = (chat) => {
      const space = /^[^/]+\/(Agent|Reviewer)$/.test(chat) ? this.engine.task(chat.split('/')[0])?.project : this.places.find(chat)?.id === chat ? chat : undefined
      return space ? [space, placeId.machine(), 'all'] : undefined
    }
    mkdirSync(HOME, { recursive: true })
    // what the Watcher kept, from before agents reported their own progress
    for (const f of ['watcher.json', 'watcher-call.json']) rmSync(join(HOME, f), { force: true })
    if (this.mirror) {
      this.followLogs()
      this.mirror.start()
      this.timers.push(setInterval(() => this.followLogs(), 5000))
      // the Everywhere defaults: the main machine's, read from its settings as they change
      this.adoptEverywhere()
      this.timers.push(setInterval(() => this.adoptEverywhere(), 3000))
    }
    this.peers?.on('snapshot', () => {
      // another machine's task may be what a queued task here waits for
      this.engine.recheck()
      this.emit('snapshot')
    })
    this.engine.peerTask = this.peers ? (machine, id) => this.peerTask(machine, id) : undefined
    // held tasks start once this machine has room: by its load (once measured) and herdr answering
    this.engine.machine = () => (has('health') && this.health.last ? { busy: this.health.busy(), herdr: this.agents.reachable } : undefined)
    this.peers?.on('chat', (key) => this.emit('chat', key))
    this.peers?.on('terminal', (key, screen) => this.emit('terminal', key, screen))
    this.peers?.on('alert', (a) => this.emit('alert', this.renamed(a)))
    this.peers?.on('news', (machine, n) => this.peerNews(machine, n))
    this.chats.onPost = (key) => this.fresh(key)
    this.chats.onRead = (key) => {
      this.emit('chat', key)
      this.fresh(key)
    }
    this.agents.on('routed', (key) => this.engine.routeRecovered(key))
    this.agents.on('status', (key, st) => {
      if (key === '*') return this.emit('snapshot')
      this.revivals.status(key, st)
      this.engine.agentStatus(key)
      this.fresh(key)
      // its turn ended: maybe its provider cut it off (its log may say so a moment later)
      if (st !== 'working' && st !== 'blocked') {
        this.checkCut(key)
        setTimeout(() => this.checkCut(key), 2000)
        this.reseat(key)
      }
      this.emit('snapshot')
      this.chats.readMenu(key).then(() => this.emit('chat', key)).catch(() => {})
    })
    this.agents.on('logs', (key) => this.watched.includes(key) && this.emit('chat', key))
    this.agents.on('sent', (item) => {
      if (item.command) void followCommand(this.agents, this.chats, item, (key) => this.emit('chat', key))
      // anything else that goes in wakes it: the count of tries starts again
      if (item.text !== carryOn(this.retries.get(item.key)?.reason ?? '')) this.retries.clear(item.key)
      this.engine.sent(item.key)
      this.emit('chat', item.key)
    })
    this.agents.on('failed', (key) => this.emit('chat', key))
    this.agents.on('output', (key) => {
      if (this.terms.includes(key)) this.agents.screen(key).then((s) => this.emit('terminal', key, s))
    })
    this.engine.on('changed', () => this.emit('snapshot'))
    this.engine.retry = (key) => this.retries.get(key)
    // a task's backup went in for a reason waiting can't fix: what the primary may answer again to (return.ts)
    this.engine.noteTookOver = (t, ran, to, why) => {
      const space = this.places.space(t.project)?.name
      if (!space) return
      const primary = this.settings.harness('task', space)
      // only a role whose agent ran the harness Settings name: one of its own (`task add --agent …`) that ran out is no
      // primary coming back — a restart would take it to Settings' pair, not to what it ran
      // a backup that went in is no model out: a new task may start, and one this outage took back may come back again
      if (sameHarness(ran, primary)) this.returns.note({ role: 'task', space, primary, to, why, at: Date.now() }, { key: `${t.id}/Agent`, allOut: false })
    }
    // a task cut off for good waits for the human: started again once its provider answers (return.ts)
    this.engine.noteStuck = (t, ran, why) => {
      const space = this.places.space(t.project)?.name
      if (space !== undefined) this.noteStuck('task', space, ran, why, this.engine.backupHarnesses('task', space, t.set), `${t.id}/Agent`)
    }
    // a space whose models all ran out starts no task (each would be cut off too), and its cut-off tasks go back to
    // work before a new one takes a slot
    this.engine.startsWait = (t) => this.startsWait(t)
    // a task the way back takes again shows in line, not as one that needs the human
    this.engine.goesBack = (t) => this.goingBack.get(`${t.id}/Agent`)
    // known at once after a start, not only at the watch's first pass ten minutes on
    if (process.env.NODE_ENV !== 'test') setTimeout(() => this.refreshGoingBack(), 0)
    this.artifacts.migratePages(
      (chat) => (chat.includes('/') ? (this.engine.task(chat.split('/')[0])?.project ?? placeId.home()) : chat),
      (chat, id) => this.chats.repostPage(chat, id),
    )
    // a turn cut short (Esc, a prompt turned down) runs no hook: its log says it is over
    this.agents.endedSince = (key, at) => this.chats.endedSince(key, at)
    this.agents.beforeInput = async (key) => { if (!['working', 'gone'].includes(this.agents.status(key)) && await this.chats.readMenu(key, true)) this.emit('chat', key) }
    // a card of a start's screen with nothing to choose holds nothing: typing cannot pick what is not there
    this.agents.menuUp = (key) => this.menuAnswers.has(key) || !!this.chats.menu(key)?.choices.length
    this.engine.on('card', (t, status, sub) => this.onCard(t, status, sub))
    // a task's question shows on its needs-you card in its space's chat too: the card follows it
    this.on('chat', (key) => {
      const t = key.endsWith('/Agent') ? this.engine.task(key.slice(0, -'/Agent'.length)) : undefined
      if (!t) return
      if (this.watched.includes(t.project)) this.emit('chat', t.project)
      // no one looks at it now: its card still keeps what it asks, to show how it was answered
      else if (this.engine.statusOf(t) === 'need') this.withAsks(this.chats.chat(t.project))
    })
    this.engine.on('news', (project, text, kind, about, card) => this.news(project, text, kind, about, card))
    this.engine.on('gone', (t, forget) => {
      // stopped, closed or deleted: no try is due any more
      this.retries.clear(`${t.id}/Agent`)
      void this.browsers?.close(t.id, forget).catch(() => undefined)
    })
    if (this.browsers && process.env.NODE_ENV !== 'test') {
      // browsers left from before a restart, or opened again after their task ended (tests never sweep this machine's)
      const sweep = () => void this.sweepBrowsers().catch(() => undefined)
      this.timers.push(setTimeout(sweep, 20_000) as unknown as ReturnType<typeof setInterval>, setInterval(sweep, 600_000))
      // browsers left idle (Settings, browser.idleClose): looked for once a minute
      this.timers.push(setInterval(() => void this.browsers?.closeIdle().catch(() => undefined), 60_000))
    }
    this.agents.start()
    // the space the machine's and All machines' coordinators shared is the home space's now; their agents close
    void this.agents.space(HOME_SPACE.label, HOME_SPACE.was).catch(() => undefined)
    if (this.places.retired.length) this.retire(this.places.retired)
    this.sayTookOver()
    // watched chats: read new log lines once a second; schedules once a minute
    this.timers.push(setInterval(() => this.pollChats(), 1000))
    // a reply in a turn that goes on (or one only background work follows) changes no status: looked for here
    this.timers.push(setInterval(() => Object.keys(this.agents.records).forEach((k) => this.agents.status(k) !== 'gone' && this.fresh(k)), 5000))
    this.timers.push(setInterval(() => this.runSchedules(), 60_000))
    // whether a primary that ran out answers again: never at boot, the first look ten minutes after this machine
    // started, and every minute after that; never beside work on the model it asks (watchReturns)
    if (process.env.NODE_ENV !== 'test')
      this.timers.push(
        setTimeout(() => {
          void this.watchReturns().catch(() => undefined)
          this.timers.push(setInterval(() => void this.watchReturns().catch(() => undefined), 60_000))
        }, 10 * 60_000) as unknown as ReturnType<typeof setInterval>,
      )
    // a question that waited long enough for the human goes to the advisor by itself (watchAdvice)
    if (process.env.NODE_ENV !== 'test') this.timers.push(setInterval(() => void this.watchAdvice().catch(() => undefined), 30_000))
    // heartbeats: looked for twice a minute, so a busy coordinator gets its own soon after its turn ends
    this.timers.push(setInterval(() => this.heartbeat(), 30_000))
    this.timers.push(setInterval(() => this.emit('snapshot'), 30_000))
    if (process.env.NODE_ENV !== 'test') this.timers.push(setInterval(() => this.healthTick(), 5000))
    if (process.env.NODE_ENV !== 'test') this.timers.push(setInterval(() => void this.revive().catch(() => undefined), 15_000))
    // a start that never becomes a turn: looked at twice a second past its first look, so a card or an error comes
    // within seconds of it stopping, not at the stalled notice twenty minutes later
    if (process.env.NODE_ENV !== 'test') this.timers.push(setInterval(() => void this.watchStarts().catch(() => undefined), 2000))
  }

  /** once, after Shepherdr replaced herdr-projects here (scripts/take-over.ts): what it did, in the home space's chat */
  private sayTookOver() {
    const rec = readJson<TookOver | null>(TOOK_OVER, null)
    if (!rec || rec.said) return
    this.chats.post(placeId.home(), { id: `took-over:${rec.at}`, text: rec.text })
    writeJson(TOOK_OVER, { ...rec, said: true })
  }

  /** the agents of the machine's and All machines' coordinators, closed once herdr shows them (their chats live on in
   *  the home space): looked for a few minutes after the start that moved them */
  private retire(names: string[], tries = 60) {
    const left = names.filter((n) => {
      const a = this.agents.live.get(n)
      if (a) void herdr.closePane(a.pane_id).catch(() => undefined)
      return !a
    })
    if (left.length && tries > 0) this.timers.push(setTimeout(() => this.retire(left, tries - 1), 5000) as unknown as ReturnType<typeof setInterval>)
  }

  /** the shared browsers whose task stopped, is done or gone: closed (and a done or gone one's profile removed). Says
   *  which tasks they were */
  async sweepBrowsers(): Promise<string[]> {
    if (!this.browsers) return []
    const task = (id: string) => this.engine.tasks.find((t) => t.id === id)
    return this.browsers.sweep(
      (id) => !!task(id) && !ended(task(id)!) && !task(id)!.stopped && !task(id)!.archived,
      (id) => !task(id) || ended(task(id)!),
    )
  }

  /** a look at this machine: limits judged, held tasks started where there is room, the screen told of new numbers */
  healthTick(now = Date.now()) {
    const at = this.health.last?.at
    this.health.tick(now)
    // too busy to start held tasks: browsers finished tasks left open go first (at most once a minute)
    if (this.health.last?.at !== at && this.health.busy() && now - this.sweptAt > 60_000) {
      this.sweptAt = now
      void this.sweepBrowsers().catch(() => undefined)
    }
    this.engine.release(now)
    if (this.health.last?.at !== at) this.emit('snapshot')
  }

  /** what a worker's mirror follows on its machine: the hooks, Claude Code's session files, and each agent's logs and
   *  the folders its CLI writes new ones in */
  private followLogs() {
    const b = BOX!
    const day = (t: number) => {
      const d = new Date(t)
      return `${b.home}/.codex/sessions/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
    }
    const dirs = [join(boxDir(), 'hooks'), `${b.home}/.claude/sessions`, day(Date.now()), day(Date.now() - 86_400_000)]
    const files: string[] = []
    for (const r of Object.values(this.agents.records)) {
      if (r.kind === 'claude') dirs.push(task.unmirrored(claudeProjectDir(r.cwd)))
      if (r.kind === 'pi') dirs.push(task.unmirrored(piSessionDir(r.cwd)))
      files.push(...r.logs.map(task.unmirrored))
    }
    this.mirror!.follow(dirs, files)
  }

  /** before it stops: the merges on their way finish (engine.drain) */
  drain() {
    return this.engine.drain()
  }

  stop() {
    this.peers?.stop()
    this.mirror?.stop()
    this.timers.forEach(clearInterval)
    this.agents.stop()
    this.engine.stop()
    this.retries.stop()
  }

  /* ---------- unread ---------- */

  /** a coordinator's chat may have something new: it shows unread, and a new message buzzes where its place's Notify is
   *  All (app.ts asks shared/alerts.ts notifies); a card about a task does not, the task's own alert says it. A task's
   *  chat counts for nothing here: its row shows its status, and its alerts follow no Notify */
  private fresh(key: string) {
    if (key.includes('/')) return
    const n = this.chats.newest(key)
    if (!n || !this.unread.saw(key, n.at)) return
    this.emit('snapshot')
    // what the first look after a restart finds came before
    if (n.at < this.born || n.card) return
    this.alert({ id: randomUUID(), from: 'Shepherdr', title: clip(this.chatName(key), TITLE_MAX), body: clip(n.text || 'New message', BODY_MAX), go: { place: key }, message: true })
  }

  /* ---------- names ---------- */

  chatName(key: string) {
    if (key.includes('/')) {
      const [id, role] = key.split('/')
      return `${id} ${role.toLowerCase()}`
    }
    return this.placeList().find((p) => p.chat === key)?.name ?? key
  }

  /** another machine's alert about its coordinator says the name the human gave the place: that machine knows only its own */
  private renamed(a: Alert): Alert {
    const name = !a.go.task && this.places.names[a.go.place]
    const was = name && this.peers?.owner(a.go.place)?.snap?.places.find((p) => p.id === a.go.place)?.name
    return was && a.title.startsWith(was) ? { ...a, title: clip(name + a.title.slice(was.length), TITLE_MAX) } : a
  }

  private placeList(): Place[] {
    return this.placesNow ?? this.listed().places
  }

  /** the places list of the snapshot being made (snapshot() is synchronous): the names it reads by the hundred — one
   *  per artifact, need and chat — come from that one list instead of each building it again, restart hints and all */
  private placesNow?: Place[]

  /** every space and every machine, as the sidebar shows them: this machine's, then the others' as they last showed
   *  themselves (just after a start, while they connect, as before it), the names the human gave them, in their order */
  private listed(): { places: Place[]; machines: Machine[]; sections: Section[] } {
    const ts = this.engine.tasks
    const status = (ids: string[], coord: string[]): Place['status'] => {
      const mine = ts.filter((t) => ids.includes(t.project) && !t.archived).map((t) => this.engine.statusOf(t))
      if (mine.includes('need') || ids.some((id) => this.asks()[id])) return 'need'
      if (mine.includes('ready')) return 'ready'
      if (mine.includes('work') || mine.includes('merging') || coord.some((k) => this.agents.status(k) === 'working')) return 'work'
      return 'idle'
    }
    const peers = this.peers?.list() ?? []
    const up = this.agents.reachable
    const machines: Machine[] = [{ id: placeId.machine(), machine: HOST, name: NAME, status: up ? 'idle' : 'off', unreachableSince: up ? undefined : clock(this.agents.lastReach), health: this.healthView(), herdrDown: up ? undefined : clock(this.agents.lastReach) }]
    const places: Place[] = this.places.shown().map(({ id, name, space }) => ({
      id,
      name,
      machine: HOST,
      ...(space ? {} : { home: true }),
      // what its lists show: a home space its machine's, the main machine's every machine's
      level: space ? 2 : peers.length ? 0 : 1,
      status: space ? status([id], [id]) : status(this.places.spaces.map((p) => placeId.space(p.name)), [id]),
      mode: this.places.mode(id),
      chat: id,
      ...(space ? { githubRemote: !!space.github } : {}),
      // Autopilot's Run now: this machine's own places only (another machine's wakes its own)
      ...(this.runNow(id) ? { runNow: this.runNow(id) } : {}),
      // herdr gone: this machine's chats say so plainly
      ...(up ? {} : { herdrDown: clock(this.agents.lastReach) }),
      // a coordinator Settings moved away from: what the places list's "Restart n coordinators" counts
      ...(this.restartHintOf(id) ? { restart: true } : {}),
    }))
    for (const l of peers) {
      const m = l.snap?.machines?.find((x) => x.machine === l.rec.machine) ?? { id: placeId.machine(l.rec.machine), machine: l.rec.machine, name: l.rec.machine, status: 'idle' as const }
      const away = !l.reachable ? (l.connecting ? { connecting: true } : { status: 'off' as const, unreachableSince: clock(l.down ?? l.rec.lastSeen) }) : {}
      machines.push({ ...m, ...away })
      // a machine never reached yet still has its home space, to come back to
      const theirs = l.snap?.places ?? [{ id: placeId.home(l.rec.machine), name: 'home', machine: l.rec.machine, home: true, level: 1 as const, status: 'off' as const, mode: 'regular' as const, chat: placeId.home(l.rec.machine) }]
      for (const p of theirs) places.push({ ...p, mode: asMode(p.mode) ?? 'regular', ...(p.home ? { level: 1 as const } : {}), ...away, runNow: undefined })
    }
    // the names the human gave them: a space's by the space rules (another on its machine with it keeps its own)
    for (const m of machines) {
      if (this.places.names[m.id]) m.name = this.places.names[m.id]
      if (this.places.emojis[m.id]) m.emoji = this.places.emojis[m.id]
      else delete m.emoji
    }
    for (const p of places) {
      const want = this.places.names[p.id] && slugify(this.places.names[p.id])
      if (want && !places.some((x) => x !== p && x.machine === p.machine && x.name === want)) p.name = want
    }
    return sortPlaces(places, machines, this.places.order, this.places.sections)
  }

  /** another machine's task, as it last showed itself, for a task queued after it */
  private peerTask(machine: string, id: string) {
    const l = this.peers?.list().find((x) => x.rec.machine.toLowerCase() === machine.toLowerCase())
    if (!l) return 'unknown' as const
    if (!l.reachable) return 'away' as const
    return l.snap?.tasks.find((t) => t.id.toUpperCase() === id.toUpperCase() && t.place.startsWith(`p:${l.rec.machine}:`))
  }

  /** open coordinator questions by place: a choice card not answered yet, or the CLI's own menu (a permission) it waits on */
  asks(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const p of [placeId.home(), ...this.places.spaces.map((x) => placeId.space(x.name))]) {
      const open = this.chats.log(p).posted.find((x) => x.question && x.question.id.startsWith('ask:') && x.question.sent === undefined && this.chats.log(p).answers[x.question.id] === undefined)
      if (open) out[p] = open.question!.id
      // stopped on a start's screen of its own (start.ts): it waits on you as a menu does
      else if (this.chats.startMenuUp(p)) out[p] = menuId(p, this.chats.menu(p)!)
      else if (this.agents.status(p) === 'blocked') out[p] = 'blocked'
    }
    return out
  }

  /**
   * Everything waiting on the human, oldest first, each once: a coordinator's open card (a question it asked, a start
   * stopped on a screen of its own) or the menu its CLI blocks on, and every task that needs you, with its cards or
   * with what it waits with. Read from the original chats only: a card forwarded to a space must never count twice.
   * The Needs you view lists these and every count counts these, so a number and its list always agree.
   */
  /** only: one chat's needs alone (the advisor's look at a chat), without a look at every task */
  private needs(only?: string): Need[] {
    const out: Need[] = []
    const open = (chat: string) => new Map(openCards(this.chats.chat(chat)).map((m) => [m.question.id, m]))
    // a coordinator: the cards it asked that still wait, then the CLI's own menu, then a menu nobody reads
    for (const p of [placeId.home(), ...this.places.spaces.map((x) => placeId.space(x.name))]) {
      if (only && p !== only) continue
      const log = this.chats.log(p)
      const cards = open(p)
      const blocked = this.agents.status(p) === 'blocked'
      const ids = coordinatorRequestIds(log.posted, log.answers, [...cards.keys()], blocked)
      for (const id of ids) {
        const message = cards.get(id) ?? log.posted.find((x) => x.question?.id === id)
        const question = message && 'question' in message ? message.question : undefined
        const text = 'The terminal is waiting for you'
        // its CLI's own menu is drawn anew on every look (its message says now), and a menu nobody reads names no time:
        // when its agent last said anything (0: before this screen knew)
        const last = this.chats.chat(p).messages.findLast((m) => m.who === 'agent' && (m.text || m.file))?.at ?? 0
        const at = message && !question?.terminal ? (message.at ?? last) : last
        out.push({ id, chat: p, place: p, at, ...(question ? { question } : { text }) })
      }
    }
    // a task that needs you: one need per card it waits on, else one for what it waits with
    for (const t of this.engine.tasks) {
      if ((only && only !== `${t.id}/Agent`) || t.archived || this.engine.statusOf(t) !== 'need') continue
      const key = `${t.id}/Agent`
      const cards = [...open(key).values()]
      const menu = this.chats.startMenuUp(key) && !cards.length ? this.chats.menu(key) : undefined
      if (menu) out.push({ id: menuId(key, menu), chat: key, place: t.project, task: t.id, at: t.updated, question: { id: menuId(key, menu), kind: 'Form', title: menu.title, screen: menu.screen, terminal: true, noNote: true, multi: menu.multi, reject: menu.reject, choices: menu.choices.map((label, i) => ({ label, description: menu.descriptions?.[i] })), to: t.id, asks: 'Its screen waits', noDismiss: true } })
      else if (cards.length) for (const m of cards) out.push({ id: m.question.id, chat: key, place: t.project, task: t.id, at: m.question.terminal || !m.at ? t.updated : m.at, question: m.question })
      // a plain question or a failed start has no card: its row says what it waits with
      else out.push({ id: 'attention', chat: key, place: t.project, task: t.id, at: t.updated, text: this.engine.subOf(t, 'need') })
    }
    return out.sort((a, b) => a.at - b.at)
  }

  /** the Everywhere defaults, for the other machines (they keep a copy) */
  everywhere() {
    return this.settings.everywhere()
  }

  /* ---------- reading ---------- */

  snapshot(): Snapshot {
    const { places, machines, sections } = this.listed()
    this.placesNow = places
    try {
      const peers = this.peers?.list() ?? []
      const automations: Snapshot['automations'] = Object.fromEntries(places.map((p) => [p.id, this.automations.view(p.id, this.settings.zone())]))
      const asks = this.asks()
      const needs = [...this.needs(), ...peers.flatMap((l) => l.snap?.needs ?? [])].sort((a, b) => a.at - b.at)
      // the same needs by chat, for plugins and older machines that read the field it replaced
      const attentionRequests: Record<string, string[]> = {}
      for (const n of needs) (attentionRequests[n.chat] ??= []).push(n.id)
      for (const l of peers) {
        Object.assign(automations, l.snap?.automations ?? {})
        Object.assign(asks, l.snap?.asks ?? {})
      }
      return this.withSecrets({
        name: 'Shepherdr',
        host: HOST,
        places,
        machines,
        tasks: [
          ...this.engine.tasks
            .filter((t) => this.places.space(t.project))
            .map((t) => ({ ...this.engine.view(t), ...(this.browsers && !ended(t) ? { browser: t.stopped ? STOPPED : this.browsers.status() } : {}) })),
          ...peers.flatMap((l) => l.snap?.tasks ?? []),
        ],
        automations,
        artifacts: [...Object.values(this.artifacts.list).map((a) => this.artifactView(a)), ...peers.flatMap((l) => l.snap?.artifacts ?? [])].sort((a, b) => b.at - a.at),
        asks,
        needs,
        attentionRequests,
        last: Object.assign({}, ...peers.map((l) => l.snap?.last ?? {}), this.unread.last),
        read: this.unread.read,
        sections,
        settings: this.settings.sections(
          this.devices(),
          [
            { name: NAME, state: `${BOX ? `Run from the main machine over SSH (${BOX.target})` : 'Main'} · ${this.agents.reachable ? 'reachable' : 'herdr not answering'}` },
            ...(this.peers?.rows() ?? []),
          ],
          pluginSection(),
          HOST,
          ['~', ...this.places.spaces.map((p) => p.name)],
          NAME,
          (id) => this.heartbeats.read(id, this.roleOf(id)),
          this.pushWarnings(),
        ).concat(this.places.spaces.map((p) => {
          const id = placeId.space(p.name)
          this.engine.taskIds.ensure(id, p.key)
          const seq = this.engine.taskIds.get(id)
          return taskIdsSection(id, HOST, seq.prefix, seq.last + 1)
        })).concat(this.places.spaces.map((p) => repositorySection(placeId.space(p.name), HOST, p.base))).concat(peers.flatMap((l) => (l.snap?.settings ?? []).filter((x) => x.machine === l.rec.machine))),
        user: this.user,
      })
    } finally {
      this.placesNow = undefined
    }
  }

  /** each level's Secrets page, after its other pages: the names kept there, never a value. The main machine's
   *  snapshot has them for every machine (the vault is its own); a worker's has none */
  private withSecrets(s: Snapshot): Snapshot {
    return BOX ? s : { ...s, settings: secretPages(s.settings, this.vault.names()) }
  }

  chatStatus(key: string): string {
    return this.agents.status(key)
  }

  chat(key: string): Chat | undefined {
    if (this.peers?.owner(key)) return this.peers.chat(key)
    const c = this.withAdvice({ ...this.chats.chat(key), restart: this.restartHintOf(key) })
    return key.includes('/') ? c : this.withAsks(c)
  }

  /* ---------- the advisor ---------- */

  /** a chat whose open questions the advisor can take: their cards carry Ask the advisor (none asked yet, one set) */
  private withAdvice(c: Chat): Chat {
    // nothing asked here: no need of any task to look at (a chat is drawn often, and a cold start draws hundreds)
    if (!c.messages.some((m) => m.question && m.question.sent === undefined && !m.question.dismissed)) return c
    const open = new Set(this.advisable(c.key).filter((x) => x.need.question).map((x) => x.qid))
    if (!open.size) return c
    return { ...c, messages: c.messages.map((m) => (m.question && open.has(m.question.id) ? { ...m, question: { ...m.question, advise: true } } : m)) }
  }

  /**
   * The questions open for the human that the advisor can take: a choice card, the CLI's own question, a plan (only to
   * suggest), or a task's plain question in words — never a permission or a terminal's own screen, nor what waits for
   * other reasons (a provider's cut-off, a start that went wrong, a login). Only where an advisor is set for its space,
   * and not asked about already.
   */
  private advisable(only?: string): { need: Need; qid: string; q: AdviceQuestion; space: string; cwd: string; asker: string; brief?: string }[] {
    const out: ReturnType<LiveSource['advisable']> = []
    for (const n of this.needs(only)) {
      const t = n.task ? this.engine.task(n.task) : undefined
      const space = t ? this.places.space(t.project)?.name : this.spaceKey(n.chat)
      if (space === undefined || !this.settings.advisor(space)) continue
      const cwd = (t ? t.worktree : this.places.coordinator(n.chat)?.cwd) ?? this.places.space(n.place)?.path
      if (!cwd) continue
      const asker = t ? `${t.id}'s agent` : `the coordinator of ${this.places.nameOf(n.chat) ?? n.chat}`
      const brief = t ? `${t.title}\n\n${t.desc}`.trim() : undefined
      let q: AdviceQuestion
      let qid: string
      if (n.question) {
        const x = n.question
        // a permission, or a terminal's own screen: the human's alone; and the advisor's own suggestion, the human's to send
        if (x.id.startsWith('menu:') || x.id.startsWith('advice:') || x.terminal || x.screen) continue
        q = { kind: 'choice', title: x.title, choices: x.choices.map((c) => ({ label: c.label, description: c.description })), multi: x.multi, other: x.other, plan: x.kind === 'Plan' || x.id.startsWith('plan:') }
        qid = x.id
      } else {
        // a task's plain question: its last words ask something, and nothing else holds it (a cut-off, a start, a login)
        if (!t || t.trouble || this.retries.get(n.chat)?.over || this.agents.status(n.chat) === 'blocked') continue
        const last = this.chats.lastReply(n.chat)
        // its last words, as the space's needs-you card shows them (alerts.ts lastReply): the same id either side
        const said = this.chats.chat(n.chat).messages.findLast((m) => m.who === 'agent' && m.text && !m.card)
        if (!last || !said || !askOf(last)) continue
        q = { kind: 'words', title: last.slice(-3000) }
        qid = `words:${said.id}`
      }
      const had = this.advices.get(n.chat, qid)
      if (had && had.state !== 'failed') continue
      out.push({ need: n, qid, q, space, cwd, asker, brief })
    }
    return out
  }

  /** the questions that waited long enough for the human go to the advisor by themselves, oldest first, one at a time */
  async watchAdvice(now = Date.now()) {
    if (this.advising) return
    for (const x of this.advisable()) {
      const after = this.settings.advisorAfter(x.space)
      // a plan is never sent by itself: it waits for the human, who may ask for advice on it
      if (after === null || x.q.plan || now - x.need.at < after || this.advices.get(x.need.chat, x.qid)) continue
      await this.advise(x.need.chat, x.qid, true)
      return
    }
  }

  /**
   * Ask the advisor about one open question: its primary, then its backup where the primary can't run or answers nothing
   * that makes sense. A sure answer goes to the agent as the human's would, and the chat says it was the advisor's — at
   * once on the human's word (Ask the advisor), or once the question waited (auto), which also alerts. A plan only ever
   * gets a card the human sends or not. Unsure, or a question only the human decides: a card says so, and the question
   * waits for them.
   */
  /** note: the human's words for the advisor, when they chose Ask the advisor with a note */
  async advise(chat: string, qid: string, auto = false, note?: string): Promise<{ ok: boolean; error?: string }> {
    const x = this.advisable(chat).find((y) => y.qid === qid)
    if (!x) return { ok: false, error: this.advices.get(chat, qid) ? 'The advisor was asked about this already.' : 'This question no longer waits, or no advisor is set for its space.' }
    if (this.advising) return { ok: false, error: 'The advisor is answering another question; try again in a moment.' }
    this.advising = true
    const rec = { chat, question: qid, at: Date.now(), state: 'asking' as const, ...(auto ? { auto } : {}) }
    this.advices.set(rec)
    this.emit('chat', chat)
    try {
      const prompt = advisorPrompt({ question: x.q, asker: x.asker, brief: x.brief, chat: recentChat(this.chats.chat(chat).messages, x.asker), folder: x.cwd, human: this.user, note: note?.trim() || undefined })
      let advice: Advice | undefined
      let said = ''
      // the advisor, then each of its backups in turn
      for (let n = 0; n <= MAX_BACKUPS; n++) {
        const h = this.settings.advisor(x.space, n)
        if (!h || !canAdvise(h.kind) || !this.engine.installed(h.kind)) continue
        const r = await this.runAdvisor(h, prompt, x.cwd)
        const parsed = r.ok ? parseAdvice(r.out, x.q) : undefined
        if (parsed) {
          advice = { ...parsed, by: advisorWords(h) }
          break
        }
        said = r.out.replace(/\s+/g, ' ').trim().slice(-200)
        // what it said whole, for the day it needs explaining: the log keeps only its end
        const kept = this.keepAdvisorOutput(chat, r.out)
        console.error(`shepherdr: the advisor (${advisorWords(h)}) gave no answer for ${chat}: ${said || 'nothing it said made sense'}${kept ? ` (whole: ${kept})` : ''}`)
      }
      if (!advice) {
        this.advices.set({ ...rec, state: 'failed' })
        // asked by the human: they hear it went wrong; by itself, the question simply goes on waiting for them
        if (!auto) this.adviceCard(chat, `The advisor couldn't answer: ${said || 'it gave no answer that fits the question'}`)
        return { ok: false, error: 'The advisor gave no answer.' }
      }
      if (advice.human) {
        this.advices.set({ ...rec, state: 'human', advice })
        this.adviceCard(chat, `The advisor leaves this to you: ${advice.human} (${advice.by})`)
        return { ok: true }
      }
      // still open? the human may have answered while it read
      const open = this.needs(chat).some((n) => n.question?.id === qid || (!n.question && qid.startsWith('words:')))
      if (!open) {
        this.advices.set({ ...rec, state: 'human', advice })
        return { ok: true }
      }
      if (!x.q.plan) {
        const sent = await this.deliverAdvice(chat, qid, x.q, advice)
        if (!sent.ok) {
          this.advices.set({ ...rec, state: 'failed', advice })
          return sent
        }
        this.advices.set({ ...rec, state: 'sent', advice })
        const words = adviceWords(advice, x.q)
        this.adviceCard(chat, `The advisor answered ${auto ? "for you, as you didn't" : 'as you asked'}: “${words}”. ${advice.why} (${advice.by})`)
        // asked by the human, they are looking at it: an alert only for one that went by itself
        if (!auto) return { ok: true }
        const t = x.need.task
        this.alert({ id: randomUUID(), from: 'Shepherdr', title: `The advisor answered ${t ?? this.chatName(chat)}`, body: `${x.q.kind === 'choice' ? x.q.title : 'Its question'}: ${words}`.slice(0, 200), go: { place: chat }, tag: `advice:${chat}`, ...(t ? { task: true as const } : {}) })
        return { ok: true }
      }
      // a plan: a card the human sends or not
      const card = `advice:${randomUUID().slice(0, 8)}`
      const words = adviceWords(advice, x.q)
      this.chats.post(chat, {
        id: card,
        question: { id: card, title: `The advisor suggests: “${words.slice(0, 300)}”`, kind: 'Question', choices: [{ label: 'Send it', description: `${advice.why} (${advice.by})` }, { label: "I'll answer myself" }], to: this.chatName(chat), noNote: true },
      })
      this.advices.set({ ...rec, state: 'suggested', advice, card })
      this.emit('chat', chat)
      return { ok: true }
    } finally {
      this.advising = false
      this.emit('chat', chat)
      this.emit('snapshot')
    }
  }

  /** the advisor's answer goes to the agent as the human's would: the card's pick, the CLI's keys, or its words */
  private async deliverAdvice(chat: string, qid: string, q: AdviceQuestion, a: Advice): Promise<{ ok: boolean; error?: string }> {
    if (q.kind === 'words') {
      await this.send(chat, `The advisor, answering for ${this.user} (who left your question to it): ${a.reply}`, [], true)
      return { ok: true }
    }
    const r = (await this.answer({ type: 'answer', chat, question: qid, choice: a.choice ?? 0, choices: a.choices, other: a.other }, 'The advisor')) as { ok?: boolean; error?: string }
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'The question no longer takes that answer.' }
  }

  /** an advisor run's words that gave no answer, kept whole in ~/.shepherdr/advisor (the twenty newest): its file */
  private keepAdvisorOutput(chat: string, out: string): string | undefined {
    try {
      const dir = join(HOME, 'advisor')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${chat.replace(/[^\w-]+/g, '_')}.txt`)
      writeFileSync(file, out)
      const old = readdirSync(dir).sort().slice(0, -20)
      for (const f of old) rmSync(join(dir, f), { force: true })
      return file
    } catch {
      return undefined
    }
  }

  /** a short note from the advisor in the chat its question is in, and in the space's chat for a task's (where its
   *  needs-you card shows the question too): beside the question, which still waits wherever it shows */
  private adviceCard(chat: string, text: string) {
    const at = Date.now()
    const t = chat.includes('/') ? this.engine.task(chat.split('/')[0]) : undefined
    for (const key of [chat, ...(t ? [t.project] : [])]) {
      const id = `advice-note:${at}:${key === chat ? 'chat' : 'space'}`
      // in the space's chat its task's id leads it, as a link to the task
      this.chats.post(key, { id, card: { id, aside: true, text, ...(t && key !== chat ? { task: t.id } : {}) } })
      this.emit('chat', key)
    }
  }

  /** the advisor's suggestion card answered: sent to the agent as the human's own answer, or left there */
  private async adviceAnswered(card: string, choice: number, dismiss = false): Promise<{ ok: boolean; error?: string }> {
    const r = this.advices.byCard(card)
    if (!r?.advice) return { ok: false, error: 'That advice is gone.' }
    if (r.state !== 'suggested') return { ok: false, error: 'This advice was answered already.' }
    this.chats.answer(r.chat, card, dismiss ? 1 : choice)
    if (dismiss || choice !== 0) {
      this.advices.set({ ...r, state: 'human' })
      this.emit('chat', r.chat)
      return { ok: true }
    }
    const x = this.needs(r.chat).find((n) => n.question?.id === r.question || (!n.question && r.question.startsWith('words:')))
    if (!x) {
      this.advices.set({ ...r, state: 'human' })
      return { ok: false, error: 'The question no longer waits: it was answered meanwhile.' }
    }
    const q: AdviceQuestion = x.question ? { kind: 'choice', title: x.question.title, choices: x.question.choices, multi: x.question.multi, other: x.question.other } : { kind: 'words', title: '' }
    // sent on the human's word: their answer, the advisor's words
    const sent = q.kind === 'words' ? (await this.send(r.chat, r.advice.reply ?? '', [], true), { ok: true }) : ((await this.answer({ type: 'answer', chat: r.chat, question: r.question, choice: r.advice.choice ?? 0, choices: r.advice.choices, other: r.advice.other })) as { ok?: boolean; error?: string })
    this.advices.set({ ...r, state: sent.ok ? 'sent' : 'failed' })
    this.emit('chat', r.chat)
    return sent.ok ? { ok: true } : { ok: false, error: (sent as { error?: string }).error ?? 'The question no longer takes that answer.' }
  }

  /** a needs-you card in a space's chat carries what its task asks, to answer there as in the task's own chat: its
   *  question cards as they stand there, or the agent's plain question and a reply box. What it asked is kept on the
   *  card once seen, so it still shows how it was answered */
  private withAsks(c: Chat): Chat {
    const l = this.chats.log(c.key)
    const latest = new Map<string, string>()
    for (const p of l.posted) if (p.card?.task) latest.set(p.card.task, p.card.id)
    const chats = new Map<string, Chat>()
    const chatOf = (key: string) => chats.get(key) ?? chats.set(key, this.chats.chat(key)).get(key)!
    const shown = new Map<string, CardAsk>()
    let saved = false
    for (const p of l.posted) {
      const card = p.card
      if (!card?.task) continue
      const t = this.engine.task(card.task)
      const last = latest.get(card.task) === card.id && card.status === 'need'
      if (!t || (!card.ask && !last)) continue
      const key = `${t.id}/Agent`
      const waits = last && this.engine.statusOf(t) === 'need'
      const tc = chatOf(key)
      const open = waits ? openCards(tc) : []
      // what it asks now, once seen: a question card that came while it waits, or its plain question
      if (open.length && open.some((m) => !card.ask?.questions?.some((q) => q.id === m.question.id)) && (!card.ask || !this.askOf(card.ask, tc, false).open)) {
        card.ask = { chat: key, questions: open.map((m) => m.question) }
        saved = true
      } else if (waits && !card.ask && !open.length && this.agents.status(key) !== 'blocked' && !/^needs you: (?:Went wrong|Signed out)/.test(card.text)) {
        const r = lastReply(tc)
        if (r?.text) {
          card.ask = { chat: key, reply: { id: r.id, text: r.text } }
          saved = true
        }
      }
      if (card.ask) shown.set(card.id, this.askOf(card.ask, tc, waits, t.id))
    }
    if (saved) this.chats.saveLog(c.key)
    if (!shown.size) return c
    return { ...c, messages: c.messages.map((m) => (m.card && shown.has(m.card.id) ? { ...m, card: { ...m.card, ask: shown.get(m.card.id) } } : m)) }
  }

  /** a needs-you card's ask as it stands now in its task's chat: each question as it is there (a terminal's menu is
   *  gone once answered), whether it still takes an answer, and where it was answered */
  private askOf(ask: CardAsk, tc: Chat, waits: boolean, task = ask.chat.split('/')[0]): CardAsk {
    const link = (label: string) => ({ label, chat: ask.chat, name: `${task} chat` })
    // what the advisor can take of it, as on the task's own cards: Ask the advisor shows here too
    const advisable = waits ? new Set(this.advisable(ask.chat).map((x) => x.qid)) : new Set<string>()
    if (ask.reply) {
      const at = tc.messages.findIndex((m) => m.id === ask.reply!.id)
      const yours = at >= 0 ? tc.messages.slice(at + 1).find((m) => m.who === 'you' && !m.waiting && (m.text || m.file)) : undefined
      const answered = ask.answered ?? (yours ? { where: 'task' as const, text: yours.text ?? yours.file?.name } : !waits ? { where: 'task' as const } : undefined)
      return { ...ask, answered, open: !answered && waits, ...(!answered && advisable.has(`words:${ask.reply.id}`) ? { advise: true } : {}) }
    }
    const live = new Map(tc.messages.flatMap((m) => (m.question ? [[m.question.id, m.question] as const] : [])))
    const open = new Set(openCards(tc).map((m) => m.question.id))
    const qs = (ask.questions ?? []).map((q) => live.get(q.id) ?? { ...q, sent: -1, said: ask.answered?.text, dismissed: ask.answered?.dismissed })
    const settled = qs.every((q) => q.sent !== undefined)
    const dismissed = !!ask.answered?.dismissed || qs.some((q) => q.dismissed)
    const where = ask.answered?.where ?? (qs.some((q) => q.via === 'terminal') ? 'terminal' : 'task')
    const answeredLabel = where === 'space' ? 'Answered here ·' : where === 'terminal' ? 'Answered in the terminal ·' : 'Answered in'
    const questions = qs.map((q): Question => {
      if (q.sent === undefined && !open.has(q.id)) return { ...q, sent: -1, elsewhere: link('No longer waits ·') }
      // the words it was answered with show on the card; the message that said them is in the task's chat
      // each question says how it was settled: a dismissed one among answered ones says so for itself
      return q.sent === undefined ? { ...q, ...(advisable.has(q.id) ? { advise: true } : {}) } : { ...q, via: undefined, elsewhere: link(q.dismissed ? 'Dismissed ·' : answeredLabel) }
    })
    return { ...ask, questions, answered: settled ? { where, text: ask.answered?.text, dismissed: dismissed || undefined } : undefined, open: !settled && questions.some((q) => q.sent === undefined) }
  }

  /** answered on a needs-you card in its space's chat: the card says so, and the space's coordinator hears the human
   *  answered it, so it doesn't answer it too; dismissed: closed without an answer, and the coordinator hears that */
  private answeredHere(space: string, key: string, title: string, text: string, dismissed = false) {
    const l = this.chats.log(space)
    const p = l.posted.findLast((x) => x.card?.ask?.chat === key)
    if (p?.card?.ask) {
      p.card.ask.answered = { where: 'space', text, dismissed: dismissed || undefined }
      this.chats.saveLog(space)
    }
    const task = key.split('/')[0]
    const words = dismissed
      ? `The human dismissed ${task}'s card “${excerpt(title, 120)}” in this chat without answering it: ${task}'s agent heard the decline and acts on it. Nothing else to say: reply with only <no-reply>dismissed by the human</no-reply>.`
      : `The human answered ${task}'s question from its card in this chat (“${excerpt(title, 120)}”: ${excerpt(text, 200)}). It went to ${task}'s agent as their answer: don't answer it too. Nothing else to say: reply with only <no-reply>answered by the human</no-reply>.`
    this.agents.send(space, hidden(words, 'news', { task, event: dismissed ? 'dismissed' : 'answered' })).catch(() => undefined)
    this.emit('chat', space)
  }

  private replies = new Set<string>()

  /** a reply to a plain question from its needs-you card: once, though two screens show it, and the card says
   *  answered only once it went to the agent */
  private async replyHere(space: string, a: Extract<Action, { type: 'send' }>) {
    if (!a.reply || this.replies.has(a.chat) || !this.askOpen(space, a.chat, a.reply)) return { ok: false, error: 'This card is answered already.' }
    this.replies.add(a.chat)
    try {
      const r = await this.send(a.chat, this.replying(a.chat, a.text, a.reply), a.attachments ?? [], false, a.cid)
      this.chats.repliedFrom(a.chat, a.reply, space)
      this.answeredHere(space, a.chat, this.chats.chat(a.chat).messages.find((m) => m.id === a.reply)?.text ?? 'its question', a.text)
      return r
    } finally {
      this.replies.delete(a.chat)
    }
  }

  /** does the needs-you card for this task's chat still take an answer */
  private askOpen(space: string, key: string, reply?: string) {
    const card = this.chats.log(space).posted.findLast((p) => p.card?.task && `${p.card.task}/Agent` === key)?.card
    const t = this.engine.task(key.slice(0, -'/Agent'.length))
    return !!card?.ask && !!t && (!reply || card.ask.reply?.id === reply) && this.askOf(card.ask, this.chats.chat(key), card.status === 'need' && this.engine.statusOf(t) === 'need').open
  }

  /** the space a needs-you card's answer came from, when that is the task's own space */
  private spaceOf(key: string, space?: string) {
    return space && key.endsWith('/Agent') && this.engine.task(key.slice(0, -'/Agent'.length))?.project === space ? space : undefined
  }

  /* ---------- artifacts ---------- */

  private artifactView(a: ArtifactRec): Artifact {
    const last = this.artifacts.latest(a)
    return {
      id: a.id,
      title: a.title,
      place: a.place,
      at: last.at,
      v: last.n,
      when: age(last.at),
      by: last.by,
      keeper: this.chatName(this.keeperOf(a)),
      thumb: a.thumb,
      chats: [...new Set(a.versions.flatMap((v) => (v.chat ? [v.chat] : [])))],
      versions: [...a.versions].reverse().map((v) => ({ n: v.n, when: age(v.at), by: v.by, note: v.note, html: v.html, what: v.html === v.n ? undefined : v.data === v.n ? ('data' as const) : ('title' as const) })),
    }
  }

  /** who hears from an artifact: the agent that made its latest version, while it has a task to come back to; its
   *  place's coordinator after that (or when it came from a terminal) */
  private keeperOf(a: ArtifactRec) {
    const chat = this.artifacts.latest(a).chat
    if (!chat) return a.place
    if (!chat.includes('/')) return chat
    const t = this.engine.task(chat.split('/')[0])
    return t && !ended(t) ? chat : a.place
  }

  /** the machine an artifact lives on, when it is not this one */
  private artifactPeer(id: string) {
    if (this.artifacts.get(id)) return undefined
    return this.peers?.list().find((l) => l.snap?.artifacts?.some((x) => x.id === id))
  }

  async artifact(id: string, v?: number): Promise<{ html: string; data?: unknown; sent?: string } | undefined> {
    const peer = this.artifactPeer(id)
    if (peer) {
      const r = await this.peers!.fetch(peer, `/api/artifacts/${encodeURIComponent(id)}/raw${v ? `?v=${v}` : ''}`).catch(() => null)
      return r?.ok ? ((await r.json()) as { html: string; data?: unknown; sent?: string }) : undefined
    }
    const a = this.artifacts.get(id)
    const html = a && this.artifacts.html(a, v)
    return html ? { html, data: this.artifacts.data(a, v), sent: this.artifacts.sentFor(a, v) } : undefined
  }

  async artifactThumb(id: string, dark: boolean): Promise<Blob | null> {
    const peer = this.artifactPeer(id)
    if (peer) {
      const r = await this.peers!.fetch(peer, `/api/artifacts/${encodeURIComponent(id)}/thumb${dark ? '?dark=1' : ''}`).catch(() => null)
      return r?.ok ? r.blob() : null
    }
    const a = this.artifacts.get(id)
    const f = a?.thumb ? Bun.file(this.artifacts.thumbFile(a.id, dark)) : null
    return f && (await f.exists()) ? f : null
  }

  watch(chats: string[], terms: string[]) {
    this.peers?.watch(chats, terms[0] ?? null)
    if (this.peers) {
      chats = chats.filter((k) => !this.peers!.owner(k))
      terms = terms.filter((k) => !this.peers!.owner(k))
    }
    this.watched = chats
    this.terms = terms
    this.agents.watchTerminals(terms)
    for (const k of terms) this.agents.screen(k).then((s) => this.emit('terminal', k, s))
    for (const k of chats) this.agents.discoverLog(k)
  }

  private async pollChats() {
    for (const k of new Set([...this.watched, ...Object.keys(this.agents.records).filter((k) => !['gone', 'working'].includes(this.agents.status(k)))])) {
      // pull first: the reply's read goes by the turn the log shows now
      const pulled = this.chats.pull(k)
      const menu = await this.chats.readMenu(k).catch(() => false)
      const reply = await this.chats.readReply(k).catch(() => false)
      // what runs in the background shows live too, though its agent writes nothing meanwhile
      const jobs = this.chats.jobsChanged(k)
      if (pulled || menu || reply || jobs) this.emit('chat', k)
    }
    // replies a voice call reads out
    for (const [k, fns] of this.replyFns) {
      if (!fns.size) continue
      this.chats.pull(k)
      const last = this.chats.lastReply(k)
      if (last && last !== this.lastAgentMsg.get(k)) {
        if (this.lastAgentMsg.has(k)) fns.forEach((f) => f(excerpt(last, 600)))
        this.lastAgentMsg.set(k, last)
      }
    }
  }

  async upload(chat: string, name: string, data: Uint8Array) {
    // a file lands on the machine of the agent it is for
    const peer = this.peers?.owner(chat)
    if (peer) {
      const body = new FormData()
      body.append('chat', chat)
      body.append('file', new File([new Uint8Array(data)], name))
      const r = await this.peers!.fetch(peer, '/api/upload', { method: 'POST', body })
      return ((await r.json()) as { path: string }).path
    }
    // on the machine of the agent it is for: there it reads it
    const dir = join(boxDir(), 'inbox', chatDir(chat))
    task.mkdirSync(dir, { recursive: true })
    const safe = name.replace(/[^a-zA-Z0-9_. -]+/g, '_').slice(0, 120) || 'file'
    // its own path even next to a file of the same name: a reaction names the file by it
    const f = join(dir, `${Date.now().toString(36)}${randomUUID().slice(0, 4)}-${safe}`)
    task.writeFileSync(f, data)
    return f
  }

  /** Talk to type: whisper.cpp on this machine writes the recording down, with the model and language Settings name.
   *  The words come back; the audio and its wav go with the temporary folder, so nothing is kept. */
  dictate(audio: Blob, signal?: AbortSignal) {
    return dictation(audio, this.settings.get('dictate.model'), this.settings.get('dictate.language'), { signal })
  }

  async attachment(chat: string, path: string) {
    // only a file attached in this chat, or uploaded for it and still waiting in the message box, and only from the
    // inbox: a path that leads anywhere else is refused
    if (!this.chat(chat)) return null
    const peer = this.peers?.owner(chat)
    if (peer) {
      const r = await this.peers!.fetch(peer, `/api/file?chat=${encodeURIComponent(chat)}&path=${encodeURIComponent(path)}`).catch(() => null)
      return r?.ok ? r.blob() : null
    }
    const real = this.inboxFile(chat, path)
    if (!real) return null
    return BOX ? new Blob([new Uint8Array(task.readFileSync(real))], { type: fileType(real).type }) : Bun.file(real)
  }

  /** a file of this chat's own inbox, as it really is on disk, or null: what a chat line names, and nothing else */
  private inboxFile(chat: string, path: string): string | null {
    const c = this.chat(chat)
    if (!c) return null
    const sent = c.messages.some((m) => m.file?.path === path)
    try {
      const inbox = task.realpathSync(join(boxDir(), 'inbox'))
      const real = task.realpathSync(path.replace(/^~(?=\/)/, boxHome()))
      // a file sent before this machine was run from the main one is still in its own install's inbox
      const old = () => {
        try {
          return BOX ? real.startsWith(task.realpathSync(join(boxHome(), '.shepherdr', 'inbox')) + sep) : false
        } catch {
          return false
        }
      }
      const ok = sent ? real.startsWith(inbox + sep) || old() : dirname(real) === join(inbox, chatDir(chat))
      if (!ok || !task.statSync(real).isFile()) return null
      return real
    } catch {
      return null
    }
  }

  /** a tile's small copy of a picture (thumb) or a still of a video (poster), made once from this chat's own file and
   *  kept beside it; null when it isn't worth one, and the screen shows the file itself (server/live/media.ts) */
  async media(chat: string, path: string, want: Small): Promise<Blob | null> {
    // a chat on another machine: its tile asks that machine, which holds the file and makes the small copy there (the
    // same route: it serves only a file that chat really has)
    const peer = this.peers?.owner(chat)
    if (peer) {
      const q = new URLSearchParams({ chat, path, [want]: '1' })
      const r = await this.peers!.fetch(peer, `/api/file?${q}`).catch(() => null)
      return r?.ok ? r.blob() : null
    }
    const real = this.inboxFile(chat, path)
    if (!real) return null
    const small = await smaller(real, want).catch(() => null)
    if (!small) return null
    return BOX ? new Blob([new Uint8Array(task.readFileSync(small))], { type: 'image/jpeg' }) : Bun.file(small)
  }

  /* ---------- a chat's activity: a turn's steps, a step's output, a background job ---------- */

  async activity(ask: ActivityAsk): Promise<ActivityAnswer> {
    const peer = this.peers?.owner(ask.chat)
    if (peer) {
      if (!peer.reachable) return { error: `Can't reach ${peer.rec.machine} right now.` }
      return this.onPeer(peer, `/api/activity?${new URLSearchParams({ chat: ask.chat, what: ask.what, id: ask.id })}`)
    }
    if (!this.agents.record(ask.chat)) return { error: 'No such chat.' }
    return this.chats.activity(ask)
  }

  /* ---------- a task's worktree, for its side panel ---------- */

  /** what PR a task has, asked of gh: kept a little while, so a panel open on many screens asks GitHub once */
  private prs = new Map<string, { at: number; v: Promise<unknown> }>()

  async worktree(ask: WorktreeAsk): Promise<unknown> {
    if (!has('worktree')) throw new Error('The worktree plugin is off.')
    const peer = this.peers?.owner(ask.task)
    if (peer) {
      if (!peer.reachable) throw new Error(`Can't reach ${peer.rec.machine} right now.`)
      const q = new URLSearchParams({ task: ask.task, what: ask.what, ...('path' in ask ? { path: ask.path } : {}) })
      return this.onPeer(peer, `/api/worktree?${q}`)
    }
    const t = this.engine.tasks.find((x) => x.id === ask.task && this.places.space(x.project))
    if (!t) throw new Error(`No task ${ask.task}.`)
    if (!t.worktree || !task.existsSync(t.worktree)) throw new Error(ended(t) ? `${t.id} is Done (${t.closed ? 'nothing to merge' : 'merged'}): its worktree was put away.` : `${t.id} has no worktree yet.`)
    const base = t.base ?? this.places.space(t.project)!.base
    if (ask.what === 'files') return listFiles(t.worktree)
    if (ask.what === 'file') return readFile(t.worktree, ask.path)
    if (ask.what === 'diff') return diffFiles(t.worktree, base)
    if (ask.what === 'patch') return diffPatch(t.worktree, base, ask.path)
    const had = this.prs.get(t.id)
    if (had && Date.now() - had.at < 30_000) return had.v
    const v = pullRequest(t.worktree, t.branch ?? '')
    for (const [k, x] of this.prs) if (Date.now() - x.at > 300_000) this.prs.delete(k)
    this.prs.set(t.id, { at: Date.now(), v })
    return v
  }

  /* ---------- adding spaces ---------- */

  /** a repo becomes a space: its own herdr space, with its coordinator in it; `found`: this add found an existing
   *  space again, by its repo's id, at the folder the repo is in now */
  private async addAsSpace(path: string, name?: string): Promise<{ space: Space; found: boolean; existing: boolean; moved: boolean }> {
    const added: { found?: boolean; existing?: boolean } = {}
    const pr = await this.places.add(path, name, added)
    const id = placeId.space(pr.name)
    // its repo found again elsewhere here: its coordinator works in the folder it is in now — unless it is mid-turn,
    // which it finishes where it is (the space's own folder is what its commands use from now on)
    const busy = ['working', 'blocked'].includes(this.agents.status(id))
    if (added.found && !busy) this.coordinator(id, { restart: async () => undefined }).catch(() => undefined)
    else this.coordinator(id).catch(() => undefined)
    this.emit('snapshot')
    return { space: pr, found: !!added.found, existing: !!added.existing, moved: !!added.found && busy }
  }

  /**
   * Shepherdr forgets a space, as `shepherdr space remove` and the sidebar's menu do: nothing on disk changes. Its
   * coordinator closes; its tasks, chat and mode are kept and come back if it is added again. Refused while one of its
   * tasks is working: pause or finish it first. A home space is never removed, nor a machine's last space.
   */
  private async removeSpace(name: string) {
    if (this.places.find(name)?.id === placeId.home()) throw new Error(`${name} is ${NAME}'s home space: it can be renamed, not removed.`)
    const pr = this.places.byName(name)
    if (!pr) throw new Error(`No space called ${name}`)
    if (this.places.shown().length < 2) throw new Error(`${name} is the last space on ${NAME}: a machine always keeps one.`)
    const id = placeId.space(pr.name)
    const working = this.engine.tasks.filter((t) => t.project === id && !t.archived && this.engine.statusOf(t) === 'work').map((t) => t.id)
    if (working.length > 1) throw new Error(`${working.slice(0, -1).join(', ')} and ${working.at(-1)} are still working: pause or finish them first.`)
    if (working.length) throw new Error(`${working[0]} is still working: pause or finish it first.`)
    this.places.remove(pr.name)
    await this.agents.finish(id)
    this.emit('snapshot')
    return pr
  }

  /** the other machine a request is for; none for this one */
  private peerFor(machine: string) {
    if (!machine || machine === HOST) return null
    const l = this.peers?.owner(placeId.machine(machine))
    if (!l) throw new Error(`No machine called ${machine}.`)
    if (!l.reachable) throw new Error(`Can't reach ${machine} right now.`)
    return l
  }

  private async onPeer<T>(l: NonNullable<ReturnType<LiveSource['peerFor']>>, path: string, init?: RequestInit): Promise<T> {
    const r = await this.peers!.fetch(l, path, { ...init, signal: AbortSignal.timeout(20_000) })
    const b = (await r.json().catch(() => ({}))) as T & { error?: string }
    if (!r.ok) throw new Error(b.error ?? `${l.rec.machine} said ${r.status}`)
    return b
  }

  async folders(machine: string, path: string): Promise<Folders> {
    const l = this.peerFor(machine)
    if (l) return this.onPeer(l, `/api/folders?machine=${encodeURIComponent(machine)}&path=${encodeURIComponent(path)}`)
    return listFolders(path, this.places.spaces.map((p) => p.path))
  }

  async addSpace(req: AddSpace): Promise<{ place: string }> {
    const l = this.peerFor(req.machine)
    if (l) return this.onPeer(l, '/api/spaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })
    const name = req.name === undefined ? undefined : req.name.trim()
    // its name is checked where the space is made, and only when it is a new one: a folder that turns out to be a space
    // already (its repo's id, or a link left at the old name) keeps the name it has
    // never git init the home folder itself: it is the home space already
    if (resolveInHome(req.path).abs === resolveInHome('~').abs) throw new Error('Your home folder is the home space already: pick a folder in it.')
    const at = req.create ? await makeRepo(req.path) : resolveInHome(req.path).abs
    const { space } = await this.addAsSpace(at, name)
    return { place: placeId.space(space.name) }
  }

  /** take the main machine's Everywhere defaults (a worker for another machine), and what a change sets going */
  private adoptEverywhere() {
    const all = sharedEverywhere()
    if (!all || !this.settings.adopt(all)) return
    this.engine.release()
    // the restart hint of the chats open now
    for (const k of this.watched) this.emit('chat', k)
    this.emit('snapshot')
  }

  /** what a changed default sets going: Done tasks archived on time, held ones started where there is room */
  private settingChanged(key: string) {
    if (key === 'tasks.archiveAfter') this.engine.autoArchive()
    if (key.startsWith('machine.')) this.engine.release()
    // an agent's CLI, model or effort: the restart hint of the chats open now
    if (/^(task|coordinator)\.(agent|model|effort)$/.test(key)) for (const k of this.watched) this.emit('chat', k)
    this.emit('snapshot')
  }

  /** the space a command runs for: --space, its coordinator's, its task's, or the one its folder is in */
  private placeOfCommand(p: Parsed, ctx: { chat?: string; cwd?: string }) {
    if (one(p, 'space') || (ctx.chat?.startsWith('p:') && this.places.space(ctx.chat)) || ctx.chat?.includes('/')) return this.projectFor(p, ctx)
    return ctx.cwd ? this.places.forPath(ctx.cwd) : undefined
  }

  /* ---------- coordinators ---------- */

  /**
   * Start (or resume) a place's coordinator: on Settings' CLI, model and effort the first time, then on what it runs on
   * (its chat's pickers change those) until it is restarted on others (`as`; `restart` stops its turn and says what
   * it is told first).
   */
  private coordinator(id: string, o: { as?: Harness; restart?: () => Promise<string | undefined> } = {}) {
    const c = this.places.coordinator(id)
    if (!c) throw new Error(`No place ${id}`)
    const set = this.settings.harness('coordinator', this.spaceKey(id))
    const rec = this.agents.record(id)
    const h = o.as ?? (rec ? undefined : set)
    const spec: Spec = {
      key: id,
      name: c.name,
      kind: h?.kind ?? rec!.kind,
      // '' is the CLI's own default
      ...(h ? { model: h.model ?? '', effort: h.effort ?? '', set } : {}),
      cwd: c.cwd,
      workspace: c.workspace,
      was: (c as { was?: string }).was,
      tab: c.tab,
      system: coordinatorPrompt({ role: this.roleOf(id), name: c.label, path: c.path, machine: NAME, chat: id }, this.places.mode(id)) + '\n\n' + privatePrompt(this.settings.instructions('coordinator', this.spaceKey(id))),
      env: agentEnv(id, ROOT),
    }
    return o.restart ? this.agents.restart(spec, o.restart) : this.agents.ensure(spec)
  }

  /** a coordinator started again on this CLI, model and effort: the same CLI resumes its session, another takes over
   *  with its role's prompt and the chat's last words. Its tasks go on as they are; a card in its chat marks it. A
   *  backup's own start (`backup`: the reason its agent can't go on) says so in the card and in what it is told, and so
   *  does one going back to its primary model, which answers again (`back`, return.ts) */
  private async restartCoordinator(id: string, to: Harness, backup?: string, back?: BackWhy) {
    if (!this.places.coordinator(id)) throw new Error(`No place ${id}`)
    if (!this.engine.installed(to.kind)) throw new Error(`${CLI_NAME[to.kind] ?? to.kind} isn't installed on this machine.`)
    const h = fitHarness(to)
    const words = harnessWords(h)
    const from = this.agents.record(id)?.kind
    const them = CLI_NAME[from ?? ''] ?? from ?? 'Its agent'
    // read once its turn has stopped: what it said meanwhile counts
    const first = async () => {
      await this.agents.stopTurn(id)
      if (!from) return undefined
      if (backup) {
        if (from === h.kind) return hidden(backupKeptLine({ on: words, why: backup }), 'restart')
        return hidden(coordinatorHandOverLine({ from: them, why: backup, tasks: this.openTasks(id), chat: recentChat(this.chats.chat(id).messages, them) }), 'restart')
      }
      return from === h.kind ? hidden(resumedLine(words, back), 'restart') : hidden(restartLine({ from: them, to: words, back: !!back, chat: recentChat(this.chats.chat(id).messages, them) }), 'restart')
    }
    await this.coordinator(id, { as: h, restart: first })
    const card = `${backup ? 'takeover' : 'restart'}:${id}:${Date.now()}`
    const text = backup ? backupCardWords({ from: them, to: CLI_NAME[h.kind] ?? h.kind, words, same: from === h.kind, why: backup }) : back ? wentBackCardWords(words, back) : `Restarted on ${words}`
    this.chats.post(id, { id: card, card: { id: card, restart: true, text } })
    if (this.watched.includes(id)) this.emit('chat', id)
    return words
  }

  /** a space's tasks that are not done, one line each, for its coordinator's backup agent: they go on as they are */
  private openTasks(id: string) {
    return this.engine.tasks
      .filter((t) => t.project === id && !t.closed && !t.merged && !t.landing)
      .slice(0, 20)
      .map((t) => `${t.id} ${t.title}`)
  }

  /** a coordinator (its place id) or a task's agent (ID/Agent) restarted: its role and space, what it runs on, what
   *  Settings say for it now and what Settings said when it last started on them */
  private restartable(key: string) {
    const t = key.includes('/') ? this.engine.task(key.split('/')[0]) : undefined
    if (key.includes('/') && !t) throw new Error('No such task.')
    if (!t && !this.places.coordinator(key)) throw new Error('No such place.')
    const role = t ? ('task' as const) : ('coordinator' as const)
    const space = t ? this.places.space(t.project)?.name : this.spaceKey(key)
    const want = this.settings.harness(role, space)
    const r = this.agents.record(key)
    const on: Harness = r ? { kind: r.kind, model: r.model, effort: r.effort } : (t?.agent ?? want)
    return { t, role, space, want, on, set: r?.set }
  }

  /** the calm hint a chat shows once Settings for its role say other than what its agent runs on */
  private restartHintOf(key: string) {
    try {
      const x = this.restartable(key)
      if (!this.agents.record(key) || (x.t && (ended(x.t) || x.t.archived))) return undefined
      return restartHint(x.on, x.set, x.want)
    } catch {
      return undefined
    }
  }

  /**
   * `shepherdr restart --all` and the places list's own item: every coordinator of this machine's places whose agent
   * runs on other than what its Settings say now (the very comparison a chat's hint makes), one at a time and exactly
   * as a single restart does, never stopping at one that fails. A task's agent is its own to restart, and another
   * machine's coordinator belongs to its machine: neither is touched here, and the words say so.
   */
  private async restartAllCoordinators() {
    const rows: RestartAllRow[] = []
    for (const p of this.placeList()) {
      // another machine's place: its own coordinator's to restart
      if (this.peers?.owner(p.id)) continue
      // nothing to restart: it agrees, or it was never started (its first start will be on what Settings say)
      if (!this.restartHintOf(p.chat)) {
        try {
          const on = harnessWords(fitHarness(this.restartable(p.chat).on))
          rows.push({ name: p.name, state: 'same', on, ...(this.agents.record(p.chat) ? {} : { idle: true }) })
        } catch (e) {
          rows.push({ name: p.name, state: 'failed', error: (e as Error).message })
        }
        continue
      }
      // a turn at work is stopped first, inside the same restart a single one runs: the line says it was
      const interrupted = this.agents.status(p.chat) === 'working'
      try {
        const on = await this.restart(p.chat, {})
        rows.push({ name: p.name, state: 'restarted', on, ...(interrupted ? { interrupted } : {}) })
      } catch (e) {
        rows.push({ name: p.name, state: 'failed', error: (e as Error).message })
      }
    }
    const count = (state: RestartAllRow['state']) => rows.filter((r) => r.state === state).length
    // the ones that could not, by name: the row in the app says which beside the count (the full lines go to the CLI)
    const failures = rows.filter((r): r is Extract<RestartAllRow, { state: 'failed' }> => r.state === 'failed').map((r) => r.name)
    return { out: restartAllWords(rows, this.otherMachines()), restarted: count('restarted'), same: count('same'), failed: failures.length, failures }
  }

  /** the other machines' places, named for `restart --all`: theirs are not restarted from here */
  private otherMachines() {
    return (this.peers?.list() ?? []).map((l) => {
      const name = l.snap?.machines?.find((x) => x.machine === l.rec.machine)?.name ?? l.rec.machine
      const places = (l.snap?.places ?? []).filter((x) => !x.home).map((x) => x.name)
      return places.length ? `${name} (${places.join(', ')})` : name
    })
  }

  /** start a coordinator or a task's agent again, on Settings' CLI, model and effort or these; save: as its space's
   *  Settings too; back: Shepherdr takes it back to its primary, which answers again (return.ts), not the human */
  private async restart(key: string, to: Partial<Harness>, save = false, back?: BackWhy) {
    const x = this.restartable(key)
    const requested = { ...x.want, ...to, kind: to.kind ?? x.want.kind }
    const problem = harnessProblem(requested)
    if (problem) throw new Error(problem)
    const h = fitHarness(requested)
    // refused before anything is saved
    if (x.t && ended(x.t)) throw new Error(`${x.t.id} is Done already: it has no agent to restart.`)
    if (x.t && !x.t.worktree) throw new Error(`${x.t.id} hasn't started yet: it starts on what its brief says.`)
    if (!this.engine.installed(h.kind)) throw new Error(`${CLI_NAME[h.kind] ?? h.kind} isn't installed on this machine.`)
    if (save) {
      const at = x.space ? { space: x.space } : ('machine' as const)
      for (const [k, v] of [['agent', CLI_NAME[h.kind] ?? h.kind], ['model', h.model ?? 'default'], ['effort', h.effort ?? 'default']])
        if (this.settings.pick(`${x.role}.${k}`, at).value !== v) {
          const r = this.settings.set(`${x.role}.${k}`, v, at)
          if (!r.ok) throw new Error(r.error ?? `Couldn't save ${x.role}.${k}`)
          this.settingChanged(`${x.role}.${k}`)
        }
    }
    const words = x.t ? await this.engine.restart(x.t.id, h, back) : await this.restartCoordinator(key, h, undefined, back)
    // you started it again yourself, or it went back to its primary: a backup may go in once more the next time it
    // can't go on (a task keeps its own, unless it went back: engine.ts restart)
    if (!x.t) this.agents.markTookOver(key, undefined)
    // the model it now runs on is one of the human's picks: first among the recent ones (only one a CLI lists, never
    // a word typed before its list was read). Going back to its primary is no pick of theirs
    const picked = h.model && !back ? findModel(h.kind, h.model) : undefined
    if (picked) rememberModel(h.kind, picked.id)
    this.emit('snapshot')
    this.emit('chat', key)
    return words
  }

  /** a coordinator that runs outside its folder (another machine's started in the main machine's path for it, where
   *  that machine had no such folder, or a home space's that was its machine's coordinator): started again in its own,
   *  with its session, once its turn is over */
  private reseat(key: string) {
    const c = key.includes('/') ? null : this.places.coordinator(key)
    const r = this.agents.record(key)
    const st = this.agents.status(key)
    if (!c || !c.home || !r || r.cwd === c.cwd || this.reseating.has(key) || (st !== 'idle' && st !== 'done') || this.agents.background(key)) return
    this.reseating.add(key)
    this.agents
      .finish(key)
      .then(() => this.coordinator(key))
      .catch(() => undefined)
      .finally(() => this.reseating.delete(key))
  }

  /** an agent Shepherdr keeps running: a space's coordinator it started, or a task's agent while its task goes on */
  private keepsRunning(key: string) {
    const r = this.agents.record(key)
    if (!r || r.finished || this.agents.busy(key) || this.reseating.has(key) || this.peers?.owner(key)) return false
    // a start that failed is the human's to try again by writing to it: a relaunch would only say the same error twice
    if (this.engine.startFailedAt(key) !== undefined) return false
    if (!key.includes('/')) return !!this.places.coordinator(key)
    return this.engine.mayRetry(key) && !!this.engine.task(key.split('/')[0])?.worktree
  }

  /**
   * Coordinators and task agents that stopped, or run without the files Shepherdr starts them with now (herdr restored
   * an older command after it restarted): started again, resuming their session, a few times at most (revive.ts)
   */
  async revive(now = Date.now()) {
    if (!this.agents.reachable || now - this.agents.lastReach > 10_000) return
    for (const key of Object.keys(this.agents.records)) {
      if (this.reviving.has(key)) continue
      if (!this.keepsRunning(key)) {
        this.revivals.skip(key)
        continue
      }
      const why = await this.agents.wrong(key)
      if (why === null) continue
      if (!why) this.revivals.fine(key, now)
      else {
        const go = this.revivals.seen(key, now)
        if (go === 'go') void this.relaunch(key, why)
        else if (go === 'give-up') this.gaveUp(key, why)
      }
    }
  }

  /**
   * A start that never becomes a turn: a CLI that exited before its first turn, a resume whose session is gone, or an
   * agent stopped on a startup screen of its own (folder trust, the theme, signing in, a model that isn't there, pi's
   * start screen). No hook and no log tells those, so its screen does (start.ts, and screen.ts for reading it). Read for
   * every launch until it either reports a turn or is settled, and settled once: one card, one error.
   *
   * The screen is only read while it can still be a start: herdr is not finishing the launch, no turn has begun, and
   * herdr does not see the agent at work. A moving screen is a slow start and is left alone, however long it takes.
   */
  async watchStarts(now = Date.now()) {
    if (!this.agents.reachable || now - this.agents.lastReach > 10_000) return
    for (const [key, r] of Object.entries(this.agents.records)) {
      if (r.finished || this.watchingStarts.has(key) || this.agents.busy(key)) continue
      this.watchingStarts.add(key)
      try {
        await this.lookStart(key, now)
      } catch (e) {
        if (BOX) console.error(`shepherdr: reading ${key}'s start: ${(e as Error).message}`)
      } finally {
        this.watchingStarts.delete(key)
      }
    }
  }

  private async lookStart(key: string, now: number) {
    const r = this.agents.record(key)
    if (!r) return
    // it began its turn in this launch: no start any more, nothing left to read (a new launch is a new start)
    if (this.begunStarts.get(key) === r.started) return
    // back on a session from before, past its settle: no read of herdr or its log is worth anything there
    if (r.resumed && now - r.started >= RESUME_SETTLE) return
    const st = this.agents.status(key)
    // at work, on a menu herdr sees, or done: no start any more
    const begun = st === 'working' || st === 'blocked' || st === 'done' || this.chats.begunSince(key, r.started)
    if (begun) this.begunStarts.set(key, r.started)
    const info = this.agents.info(key)
    const pending = !!info?.launch_pending
    // herdr's word on what runs in its pane: exited, gone, unknown (null) or fine
    const wrong = begun || pending ? undefined : await this.agents.wrong(key)
    // its screen, from the pane it started in: herdr drops a name it was never asked for, and its pane is still the
    // only witness of what it printed
    const pane = info?.pane_id ?? r.lastPane
    // a launch that never opened a pane and threw nothing of its own has nothing to say: no start ever happened
    if (!pane && !r.startError && wrong === 'gone') return
    const screen = !begun && !pending && wrong !== null && pane ? await herdr.visible(pane).catch(() => '') : ''
    // a relaunch may have begun while herdr answered: that is a new launch, and the next look reads it
    if (this.agents.record(key)?.started !== r.started) return
    const card = this.chats.startMenuUp(key)
    const step = this.starts.look(key, { started: r.started, wrong, pending, begun, prior: !!r.resumed, screen, resumed: !!r.resumed, waits: this.agents.waiting(key).length > 0, card, error: r.startError }, now)
    await this.startStep(key, step)
  }

  /** what a look at a start means: nothing, a card of its screen, or an error in the chat */
  private async startStep(key: string, step: StartStep) {
    const r = this.agents.record(key)
    if (step.do === 'wait' || !r) return
    const cli = CLI_NAME[r.kind] ?? r.kind
    if (step.do === 'card') {
      // what the CLI asks is the card's title; nothing to choose, its own words are still the card (Open terminal is
      // the way on). The same screen looked at again says nothing new
      const menu = step.menu.choices.length ? step.menu : { ...step.menu, title: `${cli} is waiting on its screen` }
      if (!this.chats.showStartMenu(key, menu)) return
      this.emit('chat', key)
      this.engine.screenCard(key)
      return
    }
    // its screen moved on: the card of it goes, and the next screen is read as a card of its own
    if (step.do === 'clear') {
      if (this.chats.clearStartMenu(key)) this.emit('chat', key)
      return
    }
    // its session is gone: a new one, with its brief, says so in the chat (and the start is not a failure)
    if (step.fresh) return this.startFresh(key, cli)
    // a task shows it as an error instead of working; a coordinator's chat says it, as its own failed start
    this.engine.startFailed(key, startWords(r.kind, step.why), r.started)
    this.emit('chat', key)
  }

  /** a resume found no session: the same start without one, its brief again, and the chat says why */
  private async startFresh(key: string, cli: string) {
    const r = this.agents.record(key)
    if (!r) return
    const started = r.started
    delete r.sessionId
    r.fresh = true
    this.agents.save()
    const id = `start-fresh:${key}:${started}`
    this.chats.post(key, { id, card: { id, text: `Its earlier session was gone, so ${cli} started a new one.` } })
    this.emit('chat', key)
    try {
      // the CLI is not in that pane any more: closed, and started again where its work is
      await this.agents.relaunch(key, true, () => (key.includes('/') ? this.engine.resume(key.split('/')[0], true) : this.coordinator(key)))
    } catch (e) {
      this.engine.startFailed(key, startWords(r.kind, (e as Error).message), started)
      this.emit('chat', key)
    }
    this.emit('snapshot')
  }

  private async relaunch(key: string, why: Wrong) {
    this.reviving.add(key)
    // read before it starts: its status once started says it is idle
    const working = this.agents.wasWorking(key) || this.revivals.wasWorking(key)
    try {
      console.error(`shepherdr: ${key}'s agent ${why === 'stale' ? 'runs on outdated settings' : 'stopped'}: starting it again`)
      // its pane still holds it, or its shell: herdr would count that as running
      await this.agents.relaunch(key, why !== 'gone', () => (key.includes('/') ? this.resumeTaskAgent(key) : this.coordinator(key)))
      // it started again; one whose start failed says so instead, and nothing goes into an agent that isn't there
      if (working && this.engine.startFailedAt(key) === undefined) await this.agents.send(key, hidden(relaunchedLine(), 'restart'))
    } catch (e) {
      console.error(`shepherdr: couldn't start ${key}'s agent again: ${(e as Error).message}`)
    } finally {
      this.reviving.delete(key)
      this.emit('snapshot')
    }
  }

  /** started again a few times and still not right: its chat says so, with an alert */
  private gaveUp(key: string, why: Wrong) {
    const id = `revive:${key}:${Date.now()}`
    const what = why === 'stale' ? 'keeps running on outdated settings' : 'stopped'
    this.chats.post(key, { id, card: { id, text: `Its agent ${what}, and starting it again didn't help. Restart it from ⋯ → Restart agent.` } })
    if (this.watched.includes(key)) this.emit('chat', key)
    this.alert({ id: randomUUID(), from: 'Shepherdr', title: `${this.chatName(key)} stopped`, body: `Its agent ${what}, and Shepherdr couldn't start it again.`, go: { place: key, focus: id }, tag: `revive:${key}` })
  }

  /** what cut off an agent's last turn, if its log says the provider did */
  private checkCut(key: string) {
    if (this.agents.record(key) && !this.peers?.owner(key)) this.retries.seen(key, this.chats.cutOff(key))
  }

  /** an agent can't go on by itself: its backup agent takes over once (a task's engine.ts cantGoOn, a coordinator's
   *  below), or it waits for you in its chat, with an alert */
  private cannotGoOn(key: string, r: Retry) {
    if (key.includes('/')) return void this.engine.cantGoOn(key.split('/')[0], r.reason, r.lasting).catch(() => undefined)
    void this.coordinatorCantGoOn(key, r).catch(() => undefined)
  }

  /**
   * A coordinator that can't go on (retry.ts): the next backup of its chain takes the chat over, each once (Settings'
   * coordinator.fallback on the coordinators' backup model and effort — coordinator.fallbackModel and
   * coordinator.fallbackEffort, or the tasks' backup.model and backup.effort while those are at default — then the 2nd to
   * the 5th): the same CLI again, resuming its session, or another CLI, which is a takeover of the conversation and says
   * so. Its tasks go on as they are. Past the last one, or with none, it waits for you: a card in the space and an alert.
   */
  private async coordinatorCantGoOn(key: string, r: Retry) {
    const rec = this.agents.record(key)
    const from = rec?.kind
    const chain = from ? this.engine.backupsFor('coordinator', this.spaceKey(key)) : []
    const took = this.agents.tookOver(key)
    // the backups after the one it is on (all of them while none took over): each once, until you restart it yourself,
    // so a chain that keeps failing waits for the human, never a loop
    const later = chain.filter((p) => p.n > (took ? (took.step ?? 1) : 0))
    const plan = later.find((p) => p.to) ?? later[0] ?? {}
    const backups = chain.flatMap((p) => (p.to ? [p.to] : []))
    if (plan.to && from && rec) {
      const why = r.reason.charAt(0).toLowerCase() + r.reason.slice(1)
      // the coordinators' Model and Effort, or else the model and effort it ran on: a model the backup's CLI lacks is dropped
      const on: Harness = {
        kind: plan.to.kind,
        model: plan.to.model ?? (rec.model ? findModel(plan.to.kind, rec.model)?.id : undefined),
        effort: plan.to.effort ?? rec.effort,
      }
      // the same mark as before it, with its place in the chain
      const prior = took
      this.agents.markTookOver(key, { from, to: plan.to.kind, why, at: Date.now(), step: plan.n })
      try {
        await this.restartCoordinator(key, on, why)
        // a lasting one: the primary it ran out of is what the watch asks about later (return.ts), and only while it ran
        // what Settings name. A note that can't be written must never undo the takeover that just went in
        const space = this.spaceKey(key) ?? ''
        const primary = this.settings.harness('coordinator', space || undefined)
        if (r.lasting && sameHarness({ kind: rec.kind, model: rec.model, effort: rec.effort }, primary))
          try {
            this.returns.note({ role: 'coordinator', space, primary, to: on, why, at: Date.now() })
          } catch (e) {
            console.error(`shepherdr: couldn't keep that ${key} runs on a backup: ${(e as Error).message}`)
          }
        return
      } catch (e) {
        // it didn't start: the human hears why, and a later hand-over may try again
        this.agents.markTookOver(key, prior)
        this.coordinatorStuck(key, r, backups)
        return this.cutOff(key, r, `its backup, ${CLI_NAME[plan.to.kind] ?? plan.to.kind}, couldn't start: ${(e as Error).message}`)
      }
    }
    const also = took ? `its backup agent (${CLI_NAME[took.to] ?? took.to}) already went in once${chain.length > 1 ? ', the last of its backups' : ''}` : plan.why ? `no backup agent took over: ${plan.why}` : undefined
    this.coordinatorStuck(key, r, backups)
    this.cutOff(key, r, also)
  }

  /** a coordinator cut off for good waits for the human: started again once its provider answers (return.ts) */
  private coordinatorStuck(key: string, r: Retry, backups: Harness[]) {
    const rec = this.agents.record(key)
    if (!r.lasting || !rec) return
    this.noteStuck('coordinator', this.spaceKey(key) ?? '', { kind: rec.kind, model: rec.model, effort: rec.effort }, r.reason.charAt(0).toLowerCase() + r.reason.slice(1), backups, key)
  }

  /**
   * An agent of that role cut off for good, on `ran`, that waits for the human: its outage is kept (or, open already, it
   * counts one more cut-off), so the watch asks its primary and starts it again once that one answers (return.ts). Only
   * an agent on what Settings name for its role, or on one of its backups: one on a harness of its own is not the
   * primary's to bring back. A note that can't be written never changes what happens to the agent.
   */
  private noteStuck(role: 'task' | 'coordinator', space: string, ran: Harness, why: string, backups: Harness[], key: string) {
    try {
      const primary = this.settings.harness(role, space || undefined)
      if (!sameHarness(ran, primary) && !backups.some((b) => sameHarness(ran, b))) return
      // its last backup was cut off too, or there is none: every model of that role ran out here
      const allOut = noneLeft(ran, primary, backups)
      const o = this.returns.get(role, space)
      // a cut-off on the backup says nothing of the primary: only one on the primary puts its answer off
      if (o && !o.back) this.returns.cut(role, space, Date.now(), { key, allOut, onPrimary: sameHarness(ran, primary) })
      else this.returns.note({ role, space, primary, to: ran, why, at: Date.now() }, { key, allOut })
      // it shows in line at once, not as needing the human until the watch's next pass
      this.refreshGoingBack()
    } catch (e) {
      console.error(`shepherdr: couldn't keep that a ${role} of ${space || 'this machine'} waits for its provider: ${(e as Error).message}`)
    }
  }

  /** a coordinator whose agent can't go on waits for you: its space's card, and an alert; `also` says why no backup went in */
  private cutOff(key: string, r: Retry, also?: string) {
    const id = `cut:${r.cut}`
    const words = `Cut off by its provider: ${r.reason.charAt(0).toLowerCase()}${r.reason.slice(1)}.${also ? ` ${also.charAt(0).toUpperCase()}${also.slice(1)}.` : ''} Write to carry on.`
    this.chats.post(key, { id, card: { id, text: words } })
    if (this.watched.includes(key)) this.emit('chat', key)
    this.alert({ id: randomUUID(), from: 'Shepherdr', title: `${this.chatName(key)} stopped`, body: `${r.reason}. ${r.words}`.slice(0, 200), go: { place: key, focus: id }, tag: `cut:${key}` })
  }

  /* ---------- when the primary model is back ---------- */

  /**
   * Settings → Agents → Backup → When the primary is back: the model a backup took over from is asked now and then
   * whether it answers again (return.ts). Go back: each agent still on the backup starts again on what Settings name,
   * once it is idle — never mid-turn, never a paused task, never one asking you something — and the ones still busy
   * follow on later passes while the answer is fresh. Tell me: one card in each of those chats says so, with the way
   * back named, and nothing switches. A probe never runs beside work on the model it asks, one at a time, and its
   * failures only lengthen the wait: no card, no alert, nothing of its words anywhere.
   */
  async watchReturns(now = Date.now()) {
    // a pass still at it (a probe, or an agent starting again) is the only one: two would start the same agent twice
    if (this.returning) return
    this.returning = true
    try {
      await this.returnPass(now)
    } finally {
      this.returning = false
    }
  }

  private async returnPass(now: number) {
    this.noteReviewer(now)
    this.adoptCutOffs(now)
    /** the roles this pass already alerted for: a reviewer set Everywhere is one news, not one per space */
    const alerted = new Set<string>()
    /** the spaces whose cut-off tasks still wait for a slot, found again each pass: a wait over is never kept */
    const resuming = new Set<string>()
    for (const o of this.returns.list()) {
      if (o.back) continue
      const mode = returnMode(this.settings.get('backup.watchReturn', o.space || undefined))
      if (mode === 'off') continue
      const to = this.backTo(o)
      // nothing of this machine's is on that backup or cut off any more: there is nothing to come back to
      if (!to) {
        this.returns.over(o.role, o.space, now)
        continue
      }
      // a reviewer has nothing to move (every review asks the primary reviewer first), and a role that went back by
      // itself too often today waits for the human: both only hear
      const often = this.returns.tooOften(o, now)
      const moves = mode === 'go back' && o.role !== 'reviewer' && !often
      // the primary answered a moment ago: what is still on the backup follows, without asking it again
      if (!(moves && o.ok && now - o.ok < FRESH)) {
        // an agent of this machine at work on that very model, with no cut-off of its own, and none in this outage for
        // a while: the primary answers, and nothing needs asking
        if (now - (o.lastCut ?? o.at) >= QUIET && this.answersNow(to.primary)) this.returns.ok(o.role, o.space, now, false)
        else {
          if ((o.due ?? 0) > now) continue
          // a CLI this machine doesn't have, or one Shepherdr has no silent one-shot for, is never asked
          if (!canProbe(to.primary.kind) || !this.engine.installed(to.primary.kind)) continue
          let probe: Probe
          try {
            probe = await this.returns.probe(to.primary)
          } catch (e) {
            probe = { ok: false, said: (e as Error).message }
          }
          // its failure is silent for the human — no card, no alert, nothing to answer — and leaves only the log and a
          // longer wait
          if (!probe.ok) {
            console.error(`shepherdr: ${to.primary.kind} doesn't answer yet: ${probe.said.slice(0, 160)}`)
            this.returns.failed(o.role, o.space, now)
            continue
          }
          this.returns.ok(o.role, o.space, now)
        }
      }
      if (!moves) {
        this.returns.answered(o.role, o.space, now)
        this.sayBack(o, to, !alerted.has(o.role), often)
        alerted.add(o.role)
        continue
      }
      const { moved, waiting } = await this.goBack(o, to.chats)
      // the tasks that wait for a slot go back before any new one takes a slot on this machine (startsWait)
      if (o.role === 'task' && waiting) resuming.add(o.space)
      if (!moved.length) continue
      // one alert per return: the chats that follow on later passes go back quietly, their cards only
      const first = !o.went
      this.returns.wentBack(o.role, o.space, now)
      // every chat went back: it is over (a later pass finds none left either, and says nothing)
      if (moved.length === to.chats.length) this.returns.answered(o.role, o.space, now)
      if (first && !alerted.has(o.role)) {
        alerted.add(o.role)
        const names = moved.map((k) => this.chatName(k))
        const more = waiting ? `; ${waiting} more as slots free up` : ''
        this.alert({ id: randomUUID(), from: 'Shepherdr', title: 'Back to work on the primary model', body: `${harnessWords(to.primary)} answers again: ${names.join(', ')} started again on it${more}.`.slice(0, 200), go: { place: moved[0] }, tag: `back:${o.role}:${o.space}:${o.at}`, ...(moved[0].includes('/') ? { task: true as const } : {}) })
      }
    }
    this.resuming = resuming
    this.refreshGoingBack()
    // a wait over (its models answer, or its cut-off tasks went back): the queue goes on, or waits on with its reason
    this.engine.release()
  }

  /**
   * The chats cut off for good, or still on the backup that took them over, that no open outage covers — cut off before
   * Shepherdr kept them, or whose note was lost — are taken in, so their primary is asked like any other's, at once
   * (their cut-off is old). Each cut-off or takeover once per server run: one that can't start again is not taken in
   * again and again.
   */
  private adoptCutOffs(now: number) {
    for (const t of this.engine.tasks) {
      if (ended(t) || t.stopped || t.archived || !t.worktree) continue
      const space = this.places.space(t.project)?.name
      if (space !== undefined) this.adopt('task', space, `${t.id}/Agent`, t.tookOver?.at, this.engine.backupHarnesses('task', space, t.set), now)
    }
    for (const { id } of this.places.shown()) {
      if (!this.places.coordinator(id)) continue
      const space = this.spaceKey(id) ?? ''
      this.adopt('coordinator', space, id, this.agents.tookOver(id)?.at, this.engine.backupHarnesses('coordinator', space || undefined), now)
    }
  }

  /** the cut-offs and takeovers taken in this run (adoptCutOffs), and the ones the way back already started again */
  private adopted = new Set<string>()

  /** one cut-off (its retry) or one takeover (its time) of a chat, as adoptCutOffs tells them apart */
  private cutMark(key: string, r?: Retry, took?: number) {
    return r ? `${key}:cut:${r.cut}` : `${key}:took:${took ?? ''}`
  }

  private adopt(role: 'task' | 'coordinator', space: string, key: string, took: number | undefined, backups: Harness[], now: number) {
    const o = this.returns.get(role, space)
    if (o && !o.back) return
    const rec = this.agents.record(key)
    if (!rec) return
    const ran: Harness = { kind: rec.kind, model: rec.model, effort: rec.effort }
    const primary = this.settings.harness(role, space || undefined)
    const r = this.retries.get(key)
    const onBackup = backups.some((b) => !sameHarness(b, primary) && sameHarness(ran, b))
    const cut = !!r?.over && !!r.lasting && (sameHarness(ran, primary) || onBackup)
    // still on a backup that took it over (the backup may work: it goes back once the primary answers)
    const away = !!took && onBackup
    if (!cut && !away) return
    const seen = this.cutMark(key, cut ? r : undefined, cut ? undefined : took)
    if (this.adopted.has(seen)) return
    this.adopted.add(seen)
    // its last backup was cut off too, or there is none: every model of that role ran out here
    const allOut = cut && noneLeft(ran, primary, backups)
    const why = r?.reason ? r.reason.charAt(0).toLowerCase() + r.reason.slice(1) : 'its backup took it over'
    // noted as old as it is: its first question due now (past its first wait and its random fifth), no quiet to wait for
    this.returns.note({ role, space, primary, to: ran, why, at: now - 2 * FIRST_WAIT }, { key, allOut })
  }

  /** the task chats the way back takes again, and what each waits for: a free slot (its primary answers) or its model */
  private goingBack = new Map<string, 'slot' | 'model'>()

  /**
   * Which cut-off tasks the way back will take again, while it goes back by itself: the ones cut off for good (on the
   * backup, or on the primary itself), not paused and asking nothing of their own. They show as queued (engine.ts
   * statusOf) instead of needing the human; one at work on its backup shows as it is. Told me or off, the human is the
   * way back and they still need them.
   */
  private refreshGoingBack() {
    try {
      const next = new Map<string, 'slot' | 'model'>()
      for (const o of this.returns.list()) {
        if (o.back || o.role !== 'task' || this.returns.tooOften(o) || returnMode(this.settings.get('backup.watchReturn', o.space || undefined)) !== 'go back') continue
        for (const c of this.backTo(o)?.chats ?? []) {
          const t = c.task ? this.engine.task(c.task) : undefined
          // a pause, or a question of its own, is the human's: it shows as it is
          if (!t || t.paused || this.chats.openQuestion(c.key) || this.chats.openCard(c.key) || this.chats.startMenuUp(c.key)) continue
          // only one its provider cut off for good: one that works on its backup (or is done there) is no wait
          const r = this.retries.get(c.key)
          if (!r?.over || !r.lasting) continue
          next.set(c.key, o.ok ? 'slot' : 'model')
        }
      }
      const changed = next.size !== this.goingBack.size || [...next].some(([k, v]) => this.goingBack.get(k) !== v)
      this.goingBack = next
      if (changed) this.emit('snapshot')
    } catch (e) {
      console.error(`shepherdr: couldn't tell which tasks go back to work: ${(e as Error).message}`)
    }
  }

  /** the spaces whose cut-off tasks still wait for a slot to go back to work: a slot is this machine's, so no new task
   *  of any space takes one before them */
  private resuming = new Set<string>()

  /**
   * Each chat still on a backup, or cut off for good, whose agent is idle now starts again on its primary, which answers
   * again: the ones at work, asking you something or paused wait for a later pass, and a task takes a free slot as a new
   * one would (Settings → the machine's limit), the rest following as slots free up. Each chat once per outage: one
   * that can't start again (or goes on failing) is the human's. The keys that went back, and how many wait for a slot.
   */
  private async goBack(o: Outage, chats: { key: string; task?: string; stuck?: boolean }[]) {
    const moved: string[] = []
    const tried: string[] = []
    let slots = this.engine.freeSlots()
    let waiting = 0
    for (const c of chats) {
      const st = this.agents.status(c.key)
      // between turns, with nothing of its own still running: what a restart would cut short waits. One whose pane is
      // gone has nothing to cut short (its start had failed, or herdr closed it): it starts again too, while herdr answers
      if ((st !== 'idle' && st !== 'done' && !(st === 'gone' && this.agents.reachable)) || this.agents.background(c.key)) continue
      // a try of its own still due, or what it asks you (a question, a plan or a choice, a start stopped on a screen of
      // its own): yours to answer on the agent that asked
      const r = this.retries.get(c.key)
      if ((r && !r.over) || this.chats.openQuestion(c.key) || this.chats.openCard(c.key) || this.chats.startMenuUp(c.key)) continue
      if (c.task) {
        const t = this.engine.task(c.task)
        // a pause is yours to end (a restart would end it)
        if (!t || t.paused) continue
        if (slots <= 0) {
          waiting++
          continue
        }
      }
      tried.push(c.key)
      // started again by the way back: never taken in again for the same cut-off or takeover
      const took = c.task ? this.engine.task(c.task)?.tookOver?.at : this.agents.tookOver(c.key)?.at
      if (r) this.adopted.add(this.cutMark(c.key, r))
      if (took) this.adopted.add(this.cutMark(c.key, undefined, took))
      try {
        // back from its backup, or again on the very model that cut it off: its provider answers again either way
        await this.restart(c.key, {}, false, c.stuck ? 'again' : 'backup')
        moved.push(c.key)
        if (c.task) slots--
      } catch (e) {
        console.error(`shepherdr: couldn't start ${c.key} again on its primary model: ${(e as Error).message}`)
      }
    }
    this.returns.moved(o.role, o.space, tried)
    return { moved, waiting }
  }

  /** an agent of this machine works on that model now (whatever its effort), and nothing cut it off: it answers */
  private answersNow(h: Harness) {
    const model = { kind: h.kind, model: h.model }
    return Object.keys(this.agents.records).some((k) => {
      const r = this.agents.record(k)
      return !!r && this.agents.status(k) === 'working' && !this.retries.get(k) && sameHarness({ kind: r.kind, model: r.model }, model)
    })
  }

  /** why a task waits before it starts (engine.ts room): this machine's cut-off tasks go back to work first (a slot is
   *  the machine's, whichever space), or every model of its space ran out and a start would only be cut off too, until
   *  the primary answers again */
  private startsWait(t: TaskRec): 'models' | 'resume' | undefined {
    if (this.resuming.size) return 'resume'
    const space = this.places.space(t.project)?.name
    if (space === undefined) return undefined
    const o = this.returns.get('task', space)
    if (!o || o.back || returnMode(this.settings.get('backup.watchReturn', space)) === 'off') return undefined
    return o.allOut && !o.ok ? 'models' : undefined
  }

  /**
   * A backup reviewer set to another harness is the one thing Shepherdr knows of a reviewer whose primary can't run (it
   * never starts a reviewer itself, so it never sees one fail): while one is set, the primary reviewer is asked whether
   * it answers again, so the human can go back. Nothing once it is dropped or set to the same harness.
   */
  private noteReviewer(now = Date.now()) {
    for (const p of this.places.spaces) {
      const primary = this.settings.harness('reviewer', p.name)
      const backup = this.settings.reviewerBackup(p.name)
      // nothing while the human set the watch to go back or off: going back, a reviewer has nothing to move (every
      // review asks the primary reviewer first), so only tell me asks about it
      const worth =
        returnMode(this.settings.get('backup.watchReturn', p.name)) === 'tell me' && !!backup && this.settings.ways(p.name).review && !sameHarness(primary, backup) && canProbe(primary.kind)
      const had = this.returns.get('reviewer', p.name)
      if (!worth) {
        if (had) this.returns.forget('reviewer', p.name)
        continue
      }
      // another backup reviewer than the one it was told about: a new record, so a later recovery is a card of its own
      // (one already told about, set the same way, stays quiet). The primary set differently since is only what it will
      // be asked about now: a primary changed by hand never failed, so it is no card on its own
      if (had && !sameHarness(had.to, backup!)) this.returns.forget('reviewer', p.name)
      if (!this.returns.get('reviewer', p.name)) this.returns.note({ role: 'reviewer', space: p.name, primary, to: backup, why: 'a backup reviewer is set', at: now })
      else this.returns.retarget('reviewer', p.name, primary)
    }
  }

  /**
   * What a role's outage comes back to now: the primary Settings name, and the chats to start again on it — the ones
   * still on the backup (what took over, or the backup Settings name), and the ones cut off for good on the primary
   * itself (stuck: no backup, one that couldn't go in, or taken back already): a task's per task, a coordinator's own, a
   * space's for a reviewer, which has no chat of its own. Never one this outage started again already, and nothing once
   * none is left.
   */
  private backTo(o: Outage): { primary: Harness; chats: { key: string; task?: string; stuck?: boolean }[] } | undefined {
    const primary = this.settings.harness(o.role, o.space || undefined)
    // its agents ran on a backup (else it had none: only the ones cut off come back)
    const away = !sameHarness(primary, o.to)
    const backups = o.role === 'reviewer' ? [] : this.engine.backupHarnesses(o.role, o.space || undefined)
    const on = (key: string) => {
      const r = this.agents.record(key)
      return r ? ({ kind: r.kind, model: r.model, effort: r.effort } as Harness) : undefined
    }
    const pick = (key: string): { stuck?: boolean } | undefined => {
      if (o.moved?.includes(key)) return undefined
      const h = on(key)
      if (!h) return undefined
      // still on what took over (or on one of the backups Settings name): one that went back asks nothing
      if ((away && sameHarness(h, o.to)) || backups.some((b) => !sameHarness(b, primary) && sameHarness(h, b))) return {}
      // cut off for good on the primary: it waits, on the model that answers again
      const r = this.retries.get(key)
      return r?.over && r.lasting && sameHarness(h, primary) ? { stuck: true } : undefined
    }
    const chats: { key: string; task?: string; stuck?: boolean }[] = []
    if (o.role === 'task') {
      for (const t of this.engine.tasks) {
        if ((this.places.space(t.project)?.name ?? '') !== o.space || ended(t) || t.stopped || t.archived) continue
        const p = pick(`${t.id}/Agent`)
        if (p) chats.push({ key: `${t.id}/Agent`, task: t.id, ...p })
      }
    } else {
      const id = o.space === '~' ? placeId.home() : placeId.space(o.space)
      if (o.role === 'coordinator') {
        const p = pick(id)
        if (p) chats.push({ key: id, ...p })
      } else if (away && this.places.coordinator(id)) chats.push({ key: id })
    }
    return chats.length ? { primary, chats } : undefined
  }

  /** its primary answered: one card in each chat still on the backup, and an alert; the card names the way back. often:
   *  it went back by itself as often as it may today, so this time it is the human's */
  private sayBack(o: Outage, to: { primary: Harness; chats: { key: string; task?: string; stuck?: boolean }[] }, alert = true, often = false) {
    const id = `back:${o.role}:${o.space}:${o.at}`
    // the name the space shows ('~' is a home space), which is what the restart command takes too
    const shown = this.places.nameOf(o.space === '~' ? placeId.home() : placeId.space(o.space)) ?? o.space
    const words = (c: { task?: string; stuck?: boolean }) => backCard({ role: o.role, primary: to.primary, to: o.to, task: c.task, space: shown, often, stuck: c.stuck })
    for (const c of to.chats) {
      const text = words(c)
      this.chats.post(c.key, { id, card: { id, text } })
      if (this.watched.includes(c.key)) this.emit('chat', c.key)
    }
    const first = to.chats[0]
    if (!alert) return
    this.alert({ id: randomUUID(), from: 'Shepherdr', title: 'The primary model answers again', body: words(first).slice(0, 200), go: { place: first.key, focus: id }, tag: `back:${o.role}:${o.space}:${o.at}`, ...(first.task ? { task: true as const } : {}) })
  }

  /** news for coordinators: they act on it when the human asked them to, and on Autopilot on their own. News the human
   *  sees as a card in the space's chat gets its coordinator's short reply after it, so a card never ends the chat. The
   *  space's own coordinator hears it, and its machine's home space's while that one is on Autopilot. The main
   *  machine's home space keeps every machine's overview and picks what buzzes: it hears each space's news in one line
   *  (overview()), another machine's over its worker's link */
  private news(project: string, text: string, kind: 'added' | 'ready' | 'need' | 'done' | 'red' | 'stalled', about?: { task: string; event: string }, card?: Omit<UpdateCard, 'id'>) {
    const projName = this.places.nameOf(project) ?? project
    if (card) {
      const id = `card:${about?.event ?? kind}:${Date.now()}`
      this.chats.post(project, { id, card: { id, ...card } })
      if (this.watched.includes(project)) this.emit('chat', project)
    }
    // its task's card went up just before (a status's news follows its card at once); a second word on it has none
    const seen = !!card || (!!about?.task && this.carded === about.task)
    this.carded = undefined
    const home = placeId.home()
    const main = this.roleOf(home) === 'main'
    for (const id of project === home ? [home] : [project, home]) {
      const mode = this.places.mode(id)
      if (mode === 'regular' && kind === 'added') continue
      if (id === home && id !== project) {
        if (main) {
          // its event rules looked at in overview()
          this.overview(projName, { place: project, line: text, kind, about })
          continue
        }
        // the space's own coordinator is awake for it: another machine's home space, off Autopilot, would only say the same again
        if (mode === 'regular') continue
      }
      const prefix = id === project ? '' : `${projName}: `
      if (!this.wakes(id, this.happened(kind, project, text, about?.task), `${prefix}${text}`)) continue
      const act = mode === 'regular' ? ' Act on it if the human asked you to handle such things.' : ' Act on it by your Autopilot rules.'
      const tail =
        id === project && seen
          ? `${act} A card in this chat already shows the human the news${kind === 'need' ? ', and lets them answer the task right there (you hear when they do)' : ''}: ${REPLY_AFTER_CARD}`
          : kind === 'done'
            ? ' A card in the space’s chat already tells the human. Check for a next step (a task waiting for it, a failure, a question); if there is none, reply with only <no-reply>reason</no-reply>.'
            : mode === 'regular'
              ? ' Act on it if the human asked you to handle such things; otherwise tell the human what matters in a line or two. Nothing matters: reply with only <no-reply>reason</no-reply>.'
              : ' Act on it by your Autopilot rules. Nothing worth saying: reply with only <no-reply>reason</no-reply>.'
      this.agents.send(id, hidden(`${prefix}${text}.${tail}`, 'news', about), { ensure: this.starter(id) }).catch(() => undefined)
    }
    const requester = about?.task ? this.engine.task(about.task)?.requester : undefined
    // Owner and home already heard above. The main home already receives the overview over the worker link.
    const mainHome = requester && !BOX ? placeId.home() : undefined
    if (requester && requester !== project && requester !== mainHome && !(requester === home && this.places.mode(home) === 'autopilot')) {
      this.requestedNews.post({ to: requester, from: project, text, task: about!.task, event: about!.event })
      void this.drainRequestedNews()
    }
    // for the main machine's home space, when this is another machine's worker: its link carries it there (app.ts; the
    // main machine has no link, and hears its own above)
    this.emit('news', { place: project, line: text, kind, about })
    // one event each: a task that went wrong is failed, not needs-you too
    this.fireTaskAutomations(this.happened(kind, project, text, about?.task), project, about?.task)
  }

  private async drainRequestedNews() {
    if (this.drainingNews) return
    this.drainingNews = true
    try {
      await this.requestedNews.drain(
        (chat) => chat.startsWith(`p:${HOST}:`),
        async (n) => {
          // Removed spaces and invented identities must not start a coordinator or receive task details.
          if (!this.places.find(n.to) || !this.agents.record(n.to) || this.agents.record(n.to)?.finished) return
          // Main home receives this event through the existing overview route.
          if (n.to === placeId.home() && !BOX) return
          const kind = ({ added: 'added', ready: 'ready', 'needs-you': 'need', merged: 'done', closed: 'done', stalled: 'stalled' } as const)[n.event as 'ready'] ?? 'need'
          if (!this.wakes(n.to, this.happened(kind, n.from, n.text, n.task), `${n.from}: ${n.text}`)) return
          const words = `${n.from}: ${n.text}. You requested this task. Its owning coordinator still handles it. Act only within the human's request; otherwise reply with only <no-reply>reason</no-reply>.`
          await this.agents.send(n.to, hidden(words, 'news', { task: n.task, event: n.event }), { cid: `requested-news:${n.id}`, ensure: this.starter(n.to) })
        },
      )
    } catch { /* keep it on disk until herdr/the coordinator can receive it */ }
    finally { this.drainingNews = false }
  }

  /** news for the main machine's home space from another space, on any machine: its first line only, since that
   *  space's own coordinator has the whole of it and acts on it; this one keeps the overview and picks what buzzes */
  private overview(from: string, n: Overview) {
    const home = placeId.home()
    if (n.kind === 'added' && this.places.mode(home) === 'regular') return
    const line = clip(n.line.split('\n')[0].replace(/\.$/, ''), OVERVIEW_MAX)
    if (!this.wakes(home, n.kind === 'health' ? { event: 'health' } : this.happened(n.kind, n.place, n.line, (n.about as { task?: string } | undefined)?.task), `${from}: ${line}`)) return
    const tail = ' Its own coordinator has the whole of it. If it can’t wait, alert the human with shepherdr alert (--task <id> when it is about a task) and say why; otherwise reply with only <no-reply>reason</no-reply>.'
    this.agents.send(home, hidden(`${from}: ${line}.${tail}`, n.kind === 'health' ? 'health' : 'news', n.about), { ensure: this.starter(home) }).catch(() => undefined)
  }

  /** another machine's news, from its worker: its space by the name the human sees, or the machine for its health */
  private peerNews(machine: string, n: Overview) {
    if (this.roleOf(placeId.home()) !== 'main') return
    this.overview(n.kind === 'health' ? `Machine ${machine}` : `${machine} · ${this.chatName(n.place)}`, n)
  }

  /* ---------- heartbeat ---------- */

  /** a space's folder key: its name as added, or a home space's ~ */
  private spaceKey(id: string) {
    return id === placeId.home() ? '~' : this.places.space(id)?.name
  }

  /** the level a space's own defaults are set at */
  private levelOf(id: string): Level {
    const key = this.spaceKey(id)
    return key ? { space: key } : 'machine'
  }

  /** what a space's coordinator does: its space's work; a home space's also its machine's; the main machine's home
   *  space's also every machine's overview */
  private roleOf(id: string): 'space' | 'home' | 'main' {
    if (id !== placeId.home()) return 'space'
    return BOX ? 'home' : 'main'
  }

  /** is a coordinator free for its heartbeat: its turn over (or not started), nothing it runs in the background, and
   *  nothing waiting to go in */
  private idle(id: string) {
    const st = this.agents.status(id)
    return (st === 'idle' || st === 'done' || st === 'gone') && !this.agents.background(id) && !this.agents.waiting(id).length
  }

  /** each coordinator on Autopilot that runs here gets its heartbeat once one is due and it is idle (heartbeat.ts), and
   *  the wake a Run now tap waits for goes as soon as it is idle too */
  heartbeat(now = Date.now()) {
    if (!has('autopilot') || !this.agents.reachable) return
    this.wakeQueue.prune(now)
    for (const p of this.placeList()) {
      if (this.peers?.owner(p.id)) continue
      const free = this.idle(p.id)
      // its turn was over: a wake that waited for it is sent, and one that ran is done holding the place
      this.wakeQueue.observe(p.id, !free, now)
      if (p.mode !== 'autopilot') continue
      if (this.wakeQueue.state(p.id) === 'queued') {
        if (free) this.sendWake(p.id, now)
        continue
      }
      const h = this.settings.heartbeat(this.levelOf(p.id))
      if (!free || !this.heartbeats.due(p.id, h.time, h.zone, now)) continue
      const text = this.heartbeats.beat(p.id, this.roleOf(p.id), now)
      if (text) this.agents.send(p.id, hidden(text, 'heartbeat'), { ensure: this.starter(p.id), idle: true }).catch(() => undefined)
    }
  }

  /** Autopilot's Run now (Settings → Autopilot, the chat's pill, shepherdr heartbeat run): one heartbeat to a place's
   *  coordinator now, or as soon as its turn is over. One at a time: a second ask while one waits or runs is refused,
   *  and never one for another machine's place */
  wake(place: string): { name: string; queued: boolean } {
    const p = this.placeList().find((x) => x.id === place || x.name === place)
    if (!p) throw new Error('No such space: name one of its places.')
    if (!has('autopilot')) throw new Error('Autopilot is not in the plugin list.')
    const problem = wakeProblem({
      name: p.name,
      autopilot: p.mode === 'autopilot',
      elsewhere: !!this.peers?.owner(p.id),
      reachable: this.agents.reachable,
      state: this.wakeQueue.state(p.id),
      checklist: this.heartbeats.read(p.id, this.roleOf(p.id)),
      held: this.heartbeats.held(p.id).length,
    })
    if (problem) throw new Error(problem)
    if (!this.wakeQueue.ask(p.id)) throw new Error(`${p.name}'s coordinator is already waking: one wake at a time.`)
    const queued = !this.idle(p.id)
    if (!queued) this.sendWake(p.id)
    this.emit('snapshot')
    return { name: p.name, queued }
  }

  /** the one wake: its heartbeat prompt, as Run now brought it, which the chat shows as one quiet line */
  private sendWake(place: string, now = Date.now()) {
    const text = this.heartbeats.beat(place, this.roleOf(place), now)
    // its checklist may have emptied while the tap waited: the tap keeps waiting, instead of going in silence
    if (!text || !this.wakeQueue.take(place, now)) return
    this.agents.send(place, hidden(text, 'heartbeat', { reason: 'run now' }), { ensure: this.starter(place), idle: true }).catch(() => this.wakeQueue.forget(place))
    this.emit('snapshot')
  }

  /** what Run now is doing for a place, for the screens: nothing where it isn't one of this machine's on Autopilot */
  private runNow(id: string): Place['runNow'] {
    if (!has('autopilot') || !this.agents.reachable || this.peers?.owner(id) || this.places.mode(id) !== 'autopilot') return undefined
    return this.wakeQueue.state(id) ?? 'ready'
  }

  /** does news wake this coordinator at once: always off Autopilot; on it, when its heartbeat's event rules name it.
   *  News they don't name waits for its next heartbeat */
  private wakes(id: string, h: Happened, line: string) {
    if (this.places.mode(id) !== 'autopilot') return true
    if (matches(this.settings.heartbeat(this.levelOf(id)).on, h)) return true
    this.heartbeats.hold(id, line)
    return false
  }

  /** what a piece of news is, to match against event rules: its event, and its space and task */
  private happened(kind: string, project: string, text: string, task?: string): Happened {
    const t = task ? this.engine.task(task) : undefined
    const event: TriggerEvent = kind === 'need' ? (/needs you: Went wrong/.test(text) ? 'failed' : 'needs-you') : kind === 'done' ? 'merged' : kind === 'red' ? 'main-red' : (kind as TriggerEvent)
    return { event, space: this.places.space(project)?.name ?? this.places.nameOf(project) ?? undefined, branch: t?.branch, title: t?.title }
  }

  /* ---------- machine health ---------- */

  /** how many tasks work here, against the limit: "3 of 5 working, 2 held" */
  /** why a task is held, in the words the command says it */
  /** shepherdr task park [ID …] [--yes]: the waiting tasks that hold an agent and a worktree from before a waiting
   *  task got none (engine.parkable), listed; with --yes, parked */
  private async parkCommand(ids: string[], yes: boolean, ctx: { chat?: string }) {
    if (ctx.chat?.includes('/')) throw new Error("A task's agent doesn't park tasks: its coordinator or the human does.")
    if (yes) {
      const r = await this.engine.park(ids.length ? ids : undefined)
      return [`Parked ${r.parked.length}${r.parked.length ? `: ${r.parked.join(', ')}` : ''}. Each waits as before, with no agent, worktree or herdr space, and starts on its brief at its turn.`, ...(r.kept.length ? [`Left as they were: ${r.kept.join('; ')}.`] : [])].join('\n')
    }
    const want = ids.map((i) => i.toUpperCase())
    const all = (await this.engine.parkable()).filter(({ t }) => !want.length || want.includes(t.id.toUpperCase()))
    if (!all.length) return 'No waiting task holds an agent or a worktree: nothing to park.'
    const go = all.filter((x) => !x.keep)
    const stay = all.filter((x) => x.keep)
    const row = (t: TaskRec, why: string) => `  ${t.id.padEnd(8)} ${t.title}  · ${why}`
    return [
      go.length ? `${go.length} waiting task${go.length === 1 ? '' : 's'} would be parked (its agent and herdr space close, its empty worktree and branch go; it starts fresh on its brief at its turn):` : 'None can be parked.',
      ...go.map(({ t, notes }) => row(t, `${this.engine.subOf(t)}${notes.length ? ` · ${notes.length === 1 ? 'a note' : `${notes.length} notes`} from another agent go${notes.length === 1 ? 'es' : ''} into its brief` : ''}`)),
      ...(stay.length ? [`${stay.length} kept as ${stay.length === 1 ? 'it is' : 'they are'}:`, ...stay.map(({ t, keep }) => row(t, keep!))] : []),
      go.length ? `Park ${go.length === 1 ? 'it' : 'them'}: shepherdr task park${ids.length ? ` ${ids.join(' ')}` : ''} --yes` : '',
    ].filter(Boolean).join('\n')
  }

  private heldWords(why: HeldWhy) {
    return {
      slots: `all ${this.settings.machine().max} slots are taken`,
      machine: 'the machine is busy',
      models: 'every model of its space ran out, so it would only be cut off too, until the primary answers again',
      resume: 'the tasks that were cut off go back to work first',
    }[why]
  }

  private workingLine() {
    const max = this.settings.machine().max
    const held = this.engine.heldTasks().length
    return `${this.engine.slotsWords(max)}${held ? `, ${held} held` : ''}`
  }

  /** this machine's numbers for the screen */
  private healthView() {
    const s = this.health.last
    if (!s || !has('health')) return undefined
    const held = this.engine.heldTasks()
    return {
      meters: meters(s, this.settings.machine(), this.health.told()),
      herdr: this.agents.reachable,
      working: this.engine.working(),
      waiting: this.engine.waitingOnYou(),
      max: this.settings.machine().max ?? undefined,
      held: held.length,
      heldWhy: held[0] && this.engine.subOf(held[0]),
      at: clock(s.at),
    }
  }

  /**
   * Something crossed its limit, or came back under: a card in the machine's home space's chat, and news for its
   * coordinator with the numbers and what uses it most. Only measured and told: what to do is the coordinator's call.
   */
  private async onHealth(e: HealthEvent) {
    if (!has('health')) return
    const s = e.sample
    const l = this.settings.machine()
    const load = (x: number | null) => +((x ?? 0) * s.cores).toFixed(1)
    const disk = s.disks.reduce((a, d) => (d.pct > a.pct ? d : a), s.disks[0])
    const over: Record<Kind, string> = {
      cpu: `CPU load has stayed over ${load(l.alertLoad)} (${l.alertLoad}× its ${s.cores} cores) for 2 minutes: ${s.load.toFixed(1)} now`,
      memory: `memory is over ${l.alertMemory}%: ${Math.round((s.memUsed / s.memTotal) * 100)}% in use`,
      disk: `${disk?.path === homedir() ? 'home' : disk?.path} is ${disk?.pct}% full (over ${l.alertDisk}%), ${Math.round(disk?.freeGb ?? 0)} GB free`,
      herdr: `herdr isn't answering (since ${clock(e.since ?? Date.now())}), so its agents can't hear anything`,
    }
    const back: Record<Kind, string> = {
      cpu: `CPU load is back under ${load(l.alertLoad)}: ${s.load.toFixed(1)} now`,
      memory: `memory is back under ${l.alertMemory}%`,
      disk: 'disk space is back under its limit',
      herdr: `herdr answers again; it was gone from ${clock(e.since ?? Date.now())} to ${clock(Date.now())}`,
    }
    // on its card, a few words
    const brief: Record<Kind, [string, string]> = {
      cpu: [`CPU load is high: ${s.load.toFixed(1)}`, 'CPU load is back to normal'],
      memory: [`memory is ${Math.round((s.memUsed / s.memTotal) * 100)}% used`, 'memory is back to normal'],
      disk: [`${disk?.path === homedir() ? 'home' : disk?.path} is ${disk?.pct}% full`, 'disk space is back to normal'],
      herdr: ["herdr isn't answering", 'herdr answers again'],
    }
    const words = e.what === 'over' ? over[e.kind] : back[e.kind]
    const machine = placeId.home()
    const id = `health:${e.kind}:${e.what}:${Date.now()}`
    this.chats.post(machine, { id, card: { id, text: brief[e.kind][e.what === 'over' ? 0 : 1], health: { level: e.what === 'over' ? 'over' : 'ok', machine: NAME } } })
    if (this.watched.includes(machine)) this.emit('chat', machine)
    this.emit('snapshot')
    // for the main machine's home space, when this is another machine's worker (as news above), herdr gone too: it
    // still runs
    this.emit('news', { place: machine, line: words, kind: 'health', about: { kind: e.kind, what: e.what } })
    // herdr gone takes its agents with it, coordinators too: they hear of it once it is back
    if (e.kind === 'herdr' && e.what === 'over') return
    // browsers that finished tasks left open go first: a web game in one takes a core or two for nothing
    const swept = e.what === 'over' && (e.kind === 'cpu' || e.kind === 'memory') ? await this.sweepBrowsers().catch(() => []) : []
    const procs = e.kind === 'cpu' || e.kind === 'memory' ? procLines(await topProcs(e.kind), this.engine.tasks.filter((t) => !ended(t)), e.kind) : []
    const what =
      e.what === 'back'
        ? e.kind === 'herdr'
          ? 'Agents it ran may have stopped with it: check which tasks need writing to again (shepherdr task list).'
          : 'If you paused or held tasks for it, they may go on now.'
        : e.kind === 'disk'
          ? 'Decide what to do: clean up (finished tasks\' leftovers, caches, /tmp), pause tasks, or tell the human.'
          : 'Decide what to do: pause tasks (shepherdr task pause <id>; a message to one lets it go on), queue them after others (shepherdr task queue <id> --after <ids>), or tell the human.'
    const closed = swept.length ? [`Shepherdr closed ${swept.length} shared browser${swept.length > 1 ? 's' : ''} that finished tasks left open (${swept.join(', ')}).`] : []
    const text = [`Machine ${NAME}: ${words}.`, summary(s), `Tasks: ${this.workingLine()}.`, ...closed, ...procs, what].join('\n')
    const mode = this.places.mode(machine)
    if (e.what === 'over') this.fireTaskAutomations({ event: 'health' }, machine)
    if (!this.wakes(machine, { event: 'health' }, `Machine ${NAME}: ${words}`)) return
    const tail = `${mode === 'regular' ? 'Act on it if the human asked you to handle such things.' : 'Act on it by your machine health rules.'} If it can’t wait, alert the human with shepherdr alert and say why. A card in this chat already shows the human the news: ${REPLY_AFTER_CARD}`
    this.agents.send(machine, hidden(`${text}\n${tail}`, 'health', { kind: e.kind, what: e.what }), { ensure: this.starter(machine) }).catch(() => undefined)
  }

  /** a task now waits on you, is done, or stalled: one small update card in its space's chat, one line of a few
   *  words; its summary is in the task (the main machine's home space's coordinator picks what buzzes) */
  private onCard(t: TaskRec, status: TaskStatus, sub: string) {
    const id = status === 'work' ? `card:${t.id}:stalled:${Date.now()}` : `card:${t.id}:${t.posted}`
    const text = status === 'done' ? (t.closed ? 'is done, nothing to merge' : 'is merged') : status === 'ready' ? 'is ready to merge' : status === 'work' ? sub : `needs you: ${sub}`
    this.chats.post(t.project, { id, card: { id, task: t.id, status, text, pr: t.pr } })
    this.carded = t.id
    if (this.watched.includes(t.project)) this.emit('chat', t.project)
    // what it asks, kept on its card though no one looks yet
    else if (status === 'need') this.withAsks(this.chats.chat(t.project))
  }

  /** what a task's alert says and where it opens: its open card, else its last reply; a done task's card */
  private taskAlert(t: TaskRec, status = this.engine.statusOf(t), sub = this.engine.subOf(t, status)) {
    const shown = status === 'need' || status === 'ready' || status === 'done' ? status : 'need'
    return taskAlert(t, shown, sub, { task: this.chats.chat(`${t.id}/Agent`), project: status === 'done' ? this.chats.chat(t.project) : undefined })
  }

  alert(a: Alert) {
    if (has('alerts')) this.emit('alert', a)
  }

  /* ---------- automations ---------- */

  private fireTaskAutomations(h: Happened, project: string, task?: string) {
    // a task an automation added sets off no automation on being added: one could add tasks without end
    if (h.event === 'added' && task && this.engine.task(task)?.by.startsWith(BY_AUTOMATION)) return
    for (const a of this.automations.on(h, project)) this.fire(a)
  }

  private runSchedules() {
    for (const a of this.automations.dueNow(this.settings.zone())) this.fire(a, true)
  }

  /** an automation runs (timed: on its time rule): a new task from its template, with a fresh agent of its own */
  private fire(a: Automation, timed = false) {
    const p = this.places.space(a.place)
    try {
      if (!p) throw new Error('Its space is gone')
      const t = this.engine.add({ project: p.name, title: a.task.title, desc: a.task.desc, by: `${BY_AUTOMATION} “${a.name}”`, agent: a.task.agent })
      this.automations.fired(a, { task: t.id }, Date.now(), timed)
      return t
    } catch (e) {
      this.automations.fired(a, { error: (e as Error).message }, Date.now(), timed)
      this.emit('snapshot')
      return undefined
    }
  }

  /** a space's automation: added (by the command only), paused or on again, run now, removed */
  private automation(place: string, op: 'add' | 'pause' | 'resume' | 'run' | 'remove', name: string | undefined, to?: { name: string; when?: string; on?: string; title: string; brief?: string; agent?: Template['agent'] }) {
    if (!this.places.space(place)) throw new Error('Automations add tasks to a space with a repo: pick one (--space NAME)')
    if (op === 'add') {
      const t = to!
      const task: Template = { title: checkTitle(t.title), ...(t.brief?.trim() ? { desc: t.brief.trim() } : {}), ...(t.agent ? { agent: t.agent } : {}) }
      const time = t.when?.trim() ? timeRule(t.when) : 'off'
      const on = t.on?.trim() ? eventRules(t.on) : []
      if (!t.name?.trim()) throw new Error('An automation needs a name')
      const x = this.automations.add({ place, name: t.name.trim(), trigger: { ...(time !== 'off' ? { time } : {}), ...(on.length ? { on } : {}) }, task })
      this.emit('snapshot')
      return x
    }
    const x = this.automations.find(place, name ?? '')
    if (!x) throw new Error(`No automation “${name}” here`)
    if (op === 'remove') this.automations.remove(place, x.name)
    else if (op === 'run') {
      const t = this.fire(x)
      if (!t) throw new Error(x.runs?.at(-1)?.error ?? 'It could not add its task')
      this.emit('snapshot')
      return t
    } else this.automations.pause(place, x.name, op === 'resume')
    this.emit('snapshot')
    return x
  }

  /* ---------- acting ---------- */

  async act(a: Action): Promise<unknown> {
    const peer = this.peers?.ownerOfAction(a)
    if (peer) return this.peers!.act(peer, a)
    return this.actLocal(a)
  }

  private async actLocal(a: Action): Promise<unknown> {
    switch (a.type) {
      case 'send':
        // a slash command goes into the CLI as you typed it, for the CLI to run
        if (isCommand(a.text) && !a.reply) return this.slashCommand(a.chat, a.text.trim(), a.attachments ?? [], a.cid)
        const space = this.spaceOf(a.chat, a.space)
        if (space) return this.replyHere(space, a)
        // your words answer the choice cards still open there: they quote them
        if (this.chats.closeAsks(a.chat, a.text)) this.emit('snapshot')
        return this.send(a.chat, this.replying(a.chat, a.text, a.reply), a.attachments ?? [], false, a.cid)
      case 'react':
        return this.react(a.chat, a.message, a.emoji)
      case 'answer':
        return this.answer(a)
      case 'advise':
        return this.advise(a.chat, a.question, false, a.note)
      case 'secret': {
        // kept on the main machine, whichever machine it is for: a worker never gets one from the screen
        if (BOX) return { ok: false, error: 'Secrets are kept on the main machine.' }
        const value = a.value === null ? null : String(a.value ?? '').replace(/[\r\n]+$/, '')
        const r = this.vault.set(a.level, a.name, value)
        if (!r.ok) return r
        this.emit('snapshot')
        // the agent that asked for it is told, by name, wherever it runs
        if (a.card && value !== null) await this.act({ type: 'secret-saved', chat: a.card.chat, card: a.card.id, name: a.name, level: a.level })
        return { ok: true }
      }
      case 'secret-saved': {
        const posted = this.chats.log(a.chat).posted.find((x) => x.id === a.card && x.secret?.name === a.name)
        if (!posted?.secret || !this.vault.has(a.level, a.name)) return { ok: false, error: 'That secret is not kept there.' }
        const where = posted.secret.levels.find((l) => l.id === a.level)?.label ?? this.secretLevelName(a.level)
        this.chats.post(a.chat, { id: a.card, secret: { ...posted.secret, saved: where } })
        await this.send(a.chat, line.secret(this.user, a.name, where), [], true)
        this.emit('chat', a.chat)
        return { ok: true }
      }
      case 'artifact-send':
      case 'artifact-note':
      case 'artifact-say': {
        const x = this.artifacts.get(a.artifact)
        if (!x) return { ok: false, error: 'That artifact is gone.' }
        const to = this.keeperOf(x)
        const art = line.artifact(x.title, x.id, a.v)
        if (a.type === 'artifact-send') this.artifacts.sent(x, a.v, a.text)
        const text =
          a.type === 'artifact-send' ? line.artifactSend(this.user, art, a.text) : a.type === 'artifact-say' ? line.artifactSay(this.user, art, a.text) : line.note(this.user, art, a.target, a.note)
        await this.send(to, text, [], true)
        return { to: this.chatName(to) }
      }
      case 'artifact-delete': {
        if (!this.artifacts.remove(a.artifact)) return { ok: false, error: 'That artifact is gone.' }
        this.emit('snapshot')
        return {}
      }
      case 'browser-notes': {
        if (!this.browsers || !a.notes?.length) return { ok: false }
        // a shot goes in only from this chat's own inbox, where Mark up saved it
        const inbox = join(boxDir(), 'inbox', chatDir(a.chat))
        const notes = a.notes.map((n) => ({ comment: String(n.comment ?? ''), pick: { ...n.pick, shot: n.pick.shot && dirname(n.pick.shot) === inbox && /^[\w-]+-note-[\w-]+\.png$/.test(n.pick.shot.split('/').pop()!) ? n.pick.shot : undefined } }))
        const shots = notes.map((n) => n.pick.shot).filter((x): x is string => !!x)
        await this.send(a.chat, line.browserNotes(this.user, { url: a.url, title: a.title, viewport: a.viewport }, notes), shots, true)
        return {}
      }
      case 'automation':
        try {
          // the screen only pauses, runs or removes one: agents add and change them, through the command
          if (!['pause', 'resume', 'run', 'remove'].includes(a.op)) throw new Error('Ask the coordinator in the chat to add or change an automation')
          this.automation(a.place, a.op, a.name)
          return { ok: true }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      case 'mode': {
        const mode = asMode(a.mode)
        if (!mode) return { ok: false, error: 'No such mode.' }
        if (mode === 'autopilot' && !has('autopilot')) return { ok: false, error: 'Autopilot is not in the plugin list.' }
        if (this.places.mode(a.place) === mode) return {}
        this.places.setMode(a.place, mode)
        this.heartbeats.switched(a.place, mode === 'autopilot')
        // off: a Run now that waited has nothing to go through any more
        if (mode !== 'autopilot') this.wakeQueue.forget(a.place)
        // a small card in the place's chat marks when the mode began; the coordinator is told quietly
        const id = `mode:${mode}:${Date.now()}`
        this.chats.post(a.place, { id, card: modeCard(id, mode) })
        if (this.watched.includes(a.place)) this.emit('chat', a.place)
        if (this.agents.status(a.place) !== 'gone') await this.agents.send(a.place, hidden(`Autopilot is now ${mode === 'autopilot' ? 'on: you also work on your own, by your Autopilot rules, and get a heartbeat while idle' : 'off: do what the human asks, nothing on your own, and no more heartbeats'}. A card in this chat already tells the human: don't announce it, reply with only <no-reply>reason</no-reply>.`, 'mode', { mode }))
        this.emit('snapshot')
        return {}
      }
      case 'heartbeat':
        try {
          if (a.op !== 'run') throw new Error('Only Run now: shepherdr heartbeat run [<space>] wakes it from a terminal.')
          const { queued } = this.wake(a.place)
          return { ok: true, queued }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      case 'model':
      case 'effort':
        return { ok: false, error: 'Use the + menu agent controls and Restart to apply model or effort changes. Chat and work are preserved.' }
      case 'keys':
        await this.agents.keys(a.chat, a.keys)
        return {}
      case 'text':
        await this.agents.text(a.chat, a.text)
        return {}
      case 'call':
        return {}
      case 'setting': {
        if (a.key.startsWith('taskIds.')) {
          const p = a.place && this.places.space(a.place)
          if (!p) return { ok: false, error: 'Select a repository space in Settings.' }
          try {
            this.engine.taskIds.ensure(a.place!, p.key)
            p.key = this.engine.taskIds.set(a.place!, a.key, a.value).prefix
            this.places.save()
            this.emit('snapshot')
            return { ok: true }
          } catch (e) { return { ok: false, error: (e as Error).message } }
        }
        if (a.key === 'space.base') {
          if (!a.place || !a.value) return { ok: false, error: 'Choose a repository space and branch.' }
          try {
            await this.places.setBase(a.place, a.value)
            this.emit('snapshot')
            return { ok: true }
          } catch (e) { return { ok: false, error: (e as Error).message } }
        }
        // a plugin's switch: the human's own list, on the main machine
        if (a.key.startsWith(PLUGIN_KEY)) {
          const r = setPluginOn(a.key.slice(PLUGIN_KEY.length), a.value !== 'off')
          if (r.ok) this.emit('snapshot')
          return r
        }
        // a space's HEARTBEAT.md: its own file
        if (a.key === 'heartbeat.md') {
          const at = this.placeList().find((p) => p.id === a.place)
          if (!at) return { ok: false, error: 'No such place.' }
          this.heartbeats.write(at.id, a.value ?? '')
          this.emit('snapshot')
          return { ok: true }
        }
        // its level: Everywhere (all, or none), this machine (its m: id), or one of its spaces
        const pr = a.place?.startsWith('p:') ? this.spaceKey(a.place) : undefined
        if (a.place?.startsWith('p:') && !pr) return { ok: false, error: 'No such space.' }
        const r = this.settings.set(a.key, a.value, pr ? { space: pr } : a.place?.startsWith('m:') ? 'machine' : 'all')
        if (r.ok) this.settingChanged(a.key)
        return r
      }
      case 'archive': {
        const t = this.engine.task(a.chat.split('/')[0])
        if (!t) return { ok: false, error: 'No such task.' }
        if (a.on) await this.engine.archive(t.id)
        else this.engine.unarchive(t.id)
        this.emit('snapshot')
        return { ok: true }
      }
      case 'pin': {
        const t = this.engine.task(a.chat.split('/')[0])
        if (!t) return { ok: false, error: 'No such task.' }
        if (a.on && t.archived) return { ok: false, error: `${t.id} is archived.` }
        this.engine.pin(t.id, a.on)
        this.emit('snapshot')
        return { ok: true }
      }
      case 'pause': {
        const t = this.engine.task(a.chat.split('/')[0])
        if (!t) return { ok: false, error: 'No such task.' }
        try {
          await this.engine.pause(t.id)
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
        this.emit('snapshot')
        return { ok: true }
      }
      case 'stop': {
        const t = this.engine.task(a.chat.split('/')[0])
        if (!t) return { ok: false, error: 'No such task.' }
        try {
          await this.engine.stopTask(t.id)
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
        this.emit('snapshot')
        return { ok: true }
      }
      case 'steer': {
        // Send now on a message Claude Code queued while it works: its Ctrl+Enter, only while its screen offers it
        if (await this.agents.steerNow(a.chat)) return { ok: true }
        return { ok: false, error: "It couldn't take it now." }
      }
      case 'restart-info': {
        try {
          const x = this.restartable(a.chat)
          return { ok: true, info: restartInfo({ role: x.role, space: x.space, on: x.on, onKnown: !!this.agents.record(a.chat), want: x.want, kinds: Object.keys(CLI_NAME).filter(this.engine.installed), working: this.agents.status(a.chat) === 'working' }) }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      }
      case 'restart': {
        try {
          if (!a.kind) return { ok: true, on: await this.restart(a.chat, {}) }
          const kind = kindOf(a.kind)
          if (!kind) return { ok: false, error: `No CLI called ${a.kind}.` }
          return { ok: true, on: await this.restart(a.chat, { kind, model: a.model ?? '', effort: a.effort ?? '' }, !!a.save) }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      }
      case 'restart-all': {
        try {
          return { ok: true, ...(await this.restartAllCoordinators()) }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      }
      case 'model-pin': {
        const kind = kindOf(a.kind)
        if (!kind) return { ok: false, error: `No CLI called ${a.kind}.` }
        const m = findModel(kind, a.model)
        if (!m) return { ok: false, error: `${CLI_NAME[kind] ?? kind} has no model ${a.model}.` }
        pinModel(kind, m.id, !!a.on)
        // Settings' model rows lead with the pins too
        this.emit('snapshot')
        return { ok: true, ...picksOf(kind) }
      }
      case 'close': {
        const t = this.engine.task(a.chat.split('/')[0])
        if (!t) return { ok: false, error: 'No such task.' }
        if (t.closed || t.merged) return { ok: false, error: `${t.id} is Done already (${t.closed ? 'nothing to merge' : 'merged'}).` }
        // work main lacks stays in its worktree and branch, but the screen asks first
        const held = a.force ? [] : await this.engine.holds(t)
        if (held.length) return { ok: false, held: held.map(heldWords) }
        try {
          const { kept } = await this.engine.close(t.id)
          this.emit('snapshot')
          return { ok: true, kept }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      }
      case 'space-remove': {
        const pr = this.places.space(a.place)
        if (!pr && a.place === placeId.home()) return { ok: false, error: `${this.places.nameOf(a.place)} is ${NAME}'s home space: it can be renamed, not removed.` }
        if (!pr) return { ok: false, error: 'That space is gone already.' }
        try {
          await this.removeSpace(pr.name)
          return { ok: true }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      }
      case 'read': {
        if (!a.chats || typeof a.chats !== 'object') return { ok: false, error: 'No chats to mark read.' }
        if (this.unread.mark(a.chats)) this.emit('snapshot')
        return { ok: true }
      }
      case 'rename': {
        const name = typeof a.name === 'string' ? a.name.replace(/\s+/g, ' ').trim() : null
        if (this.places.sections[a.id] || a.id === PINNED) {
          const emoji = a.emoji === undefined ? undefined : asEmoji(a.emoji)
          const bad = emoji === null ? 'One emoji at a time.' : renameSection(this.places.sections, a.id, name ?? '', emoji)
          if (bad) return { ok: false, error: bad }
          this.places.saveSections()
          this.emit('snapshot')
          return { ok: true }
        }
        const { places, machines } = this.listed()
        const m = machines.find((x) => x.id === a.id)
        const p = places.find((x) => x.id === a.id)
        if ((!p && !m) || name === null) return { ok: false, error: 'Nothing to rename.' }
        const emoji = a.emoji === undefined ? undefined : asEmoji(a.emoji)
        if (emoji === null || (emoji !== undefined && !m)) return { ok: false, error: 'Only a machine takes an emoji, one at a time.' }
        if (name.length > NAME_MAX) return { ok: false, error: `A name fits ${NAME_MAX} characters.` }
        if (m && name && machines.some((x) => x.id !== m.id && x.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: `A machine is called ${name} already.` }
        // a space's name follows the space rules, its own on its machine
        const bad = p && name ? nameProblem(name, places.filter((x) => x.machine === p.machine && x.id !== p.id).map((x) => x.name)) : undefined
        if (bad) return { ok: false, error: bad }
        this.places.rename(a.id, name)
        if (emoji !== undefined) this.places.setEmoji(a.id, emoji)
        this.emit('snapshot')
        return { ok: true }
      }
      case 'order': {
        if (typeof a.under !== 'string' || !Array.isArray(a.ids) || !a.ids.every((x) => typeof x === 'string')) return { ok: false, error: 'No order to keep.' }
        this.places.setOrder(a.under, a.ids)
        this.emit('snapshot')
        return { ok: true }
      }
      case 'move': {
        if (typeof a.id !== 'string' || typeof a.to !== 'string') return { ok: false, error: 'Nothing to move.' }
        const { places, machines } = this.listed()
        const bad = moveSpace(this.places.order, this.places.sections, places, machines, a.id, a.to, typeof a.before === 'string' ? a.before : undefined)
        if (bad) return { ok: false, error: bad }
        this.places.saveSections()
        this.emit('snapshot')
        return { ok: true }
      }
      case 'section': {
        if (a.op === 'delete') {
          if (!this.places.sections[a.id] || a.id === PINNED) return { ok: false, error: a.id === PINNED ? 'Pinned stays.' : 'No such section.' }
          deleteSection(this.places.sections, this.places.order, a.id)
        } else {
          const name = typeof a.name === 'string' ? a.name.replace(/\s+/g, ' ').trim() : ''
          const emoji = a.emoji === undefined ? '' : asEmoji(a.emoji)
          const machine = typeof a.machine === 'string' && a.machine ? a.machine : undefined
          const { machines } = this.listed()
          if (emoji === null) return { ok: false, error: 'One emoji at a time.' }
          if (machine && !machines.some((m) => m.machine === machine)) return { ok: false, error: 'No such machine.' }
          const bad = sectionProblem(this.places.sections, name, machine)
          if (bad) return { ok: false, error: bad }
          const id = newSection(this.places.sections, this.places.order, { name, ...(emoji ? { emoji } : {}), ...(machine ? { machine } : {}) }, machines)
          this.places.saveSections()
          this.emit('snapshot')
          return { ok: true, id }
        }
        this.places.saveSections()
        this.emit('snapshot')
        return { ok: true }
      }
      case 'delete': {
        const t = this.engine.task(a.chat.split('/')[0])
        if (!t) return { ok: false, error: 'No such task.' }
        try {
          const left = await this.deleteTask(t.id, !!a.force)
          return { ok: true, left }
        } catch (e) {
          // the work it holds, in words without its paths ("uncommitted changes"): the screen offers to lose it
          const { message, held, stopped } = e as Error & { held?: string[]; stopped?: boolean }
          if (!held) return { ok: false, error: message }
          return { ok: false, held: held.map(heldWords), stopped }
        }
      }
    }
  }

  /** what you write: a coordinator wakes for it (resumed with its memory); a task agent is resumed if it finished.
   *  keepAsks: a card's own answer or a close without one, which leaves the chat's other cards as they were (a message
   *  typed answers them all) */
  private async send(key: string, text: string, files: string[], fromScreen = false, cid?: string, opts: { keepAsks?: boolean } = {}) {
    const at = Date.now()
    const lines = files.map((p) => line.attach(this.user, p.split('/').pop()!.replace(/^[a-z0-9]+-/, ''), p))
    const full = [text, ...lines].filter(Boolean).join('\n')
    if (!full) return {}
    // whatever you send answers the choice cards still open there: the place's dot no longer waits on them
    if (!opts.keepAsks && this.chats.closeAsks(key)) this.emit('snapshot')
    // a task held before it ever started has no agent: what you write starts it now, on its brief and your words
    if (key.includes('/') && this.engine.unstarted(key.split('/')[0])) {
      await this.engine.tell(key.split('/')[0], full)
      this.emit('chat', key)
      return { waiting: true, at }
    }
    const ensure = key.includes('/') ? () => this.resumeTaskAgent(key) : () => this.coordinator(key)
    if (!key.includes('/') && this.agents.status(key) === 'gone') await this.coordinator(key).catch(() => undefined)
    const r = await this.agents.send(key, full, { ensure, cid })
    if (key.includes('/')) this.engine.youWrote(key)
    void fromScreen
    this.emit('chat', key)
    // at: when it began to go in, by this machine's clock: the log has it after that (a screen matching what it sent
    // without the id goes by it)
    return { waiting: r.waiting, waitsFor: r.waitsFor, at }
  }

  /** a slash command you typed: into the CLI as typed, once its turn is over, and no answer to a card or go for a
   *  queued task. Files with it follow as a message of their own. */
  private async slashCommand(key: string, text: string, files: string[], cid?: string) {
    // a task held before it ever started has no CLI yet: your words start it
    if (key.includes('/') && this.engine.unstarted(key.split('/')[0])) return this.send(key, text, files, false, cid)
    const at = Date.now()
    const ensure = key.includes('/') ? () => this.resumeTaskAgent(key) : () => this.coordinator(key)
    if (!key.includes('/') && this.agents.status(key) === 'gone') await this.coordinator(key).catch(() => undefined)
    const r = await this.agents.send(key, text, { ensure, cid, idle: true, command: true })
    if (key.includes('/')) this.engine.youWrote(key, { go: false })
    if (files.length) await this.send(key, '', files)
    this.emit('chat', key)
    return { waiting: r.waiting, waitsFor: r.waitsFor, at }
  }

  /** your words as a reply to a message, quoting its start (a file by its name); plain words when it is gone */
  private replying(key: string, text: string, reply?: string) {
    if (!reply) return text
    const m = this.chats.chat(key).messages.find((x) => x.id === reply)
    const art = !m?.text && m?.artifact && this.artifacts.get(m.artifact.id)
    const quoted = m?.text ?? m?.file?.name
    if (!quoted && !art) return text
    const l = art ? line.replyArtifact(this.user, line.artifact(art.title, art.id, m.artifact!.v), text) : line.reply(this.user, quoted!, text)
    rememberReply(l, reply)
    return l
  }

  private resumeTaskAgent(key: string) {
    return this.engine.resume(key.split('/')[0])
  }

  /** the way a message behind the chat (news, a heartbeat, a health line, a provider's retry) starts its agent again:
   *  never one whose last start failed, which is the human's to try again by writing (start.ts), and what waits for it
   *  goes in at once when it does */
  private starter(key: string) {
    return () => (this.engine.startFailedAt(key) !== undefined ? Promise.resolve(null) : key.includes('/') ? this.resumeTaskAgent(key) : this.coordinator(key))
  }

  private async react(key: string, messageId: string, emoji: string) {
    if (!has('reactions')) return { ok: false }
    const chat = this.chats.chat(key)
    const m = chat.messages.find((x) => x.id === messageId)
    // an artifact's card by its title, id and the version posted
    const art = !m?.text && !m?.file && m?.artifact && this.artifacts.get(m.artifact.id)
    if (!m || !(m.text || m.file || art)) return { ok: false }
    const mine = m.reactions?.find((r) => r.emoji === emoji && (r.by === 'me' || r.by === 'both'))
    // a file is named with its path: two files may share a name
    const f = m.text ? undefined : m.file
    const text = art
      ? (mine ? line.unreactArtifact : line.reactArtifact)(this.user, emoji, line.artifact(art.title, art.id, m.artifact!.v))
      : f
        ? (mine ? line.unreactFile : line.reactFile)(this.user, emoji, f.name, f.path)
        : (mine ? line.unreact : line.react)(this.user, emoji, m.text!)
    await this.agents.send(key, text, { reaction: { message: messageId, emoji }, ensure: key.includes('/') ? () => this.resumeTaskAgent(key) : () => this.coordinator(key) })
    this.emit('chat', key)
    return {}
  }

  private menuAnswers = new Set<string>()

  /** by: who answered, when it was not the human (the advisor): its words name it */
  private async answer(a: Extract<Action, { type: 'answer' }>, by?: string) {
    const key = a.chat
    const qid = a.question
    // the advisor's suggestion: sent as the human's own answer, or left to them (never a chat line of its own)
    if (qid.startsWith('advice:')) return this.adviceAnswered(qid, a.choice, !!a.dismiss)
    const answered = (title: string) => `${by ? `${by} answered` : 'Answered'} “${title}”`
    // answered on its copy in the space's chat: the task's chat says so, as does the copy
    const space = this.spaceOf(key, a.space)
    // a notification's button: only the card the chat still ends on, unanswered
    if (a.fromAlert && !openCards(this.chats.chat(key)).some((m) => m.question.id === qid)) return { ok: false, error: 'This card no longer waits on you.' }
    // its Dismiss, or Esc on it: closed without an answer, never a yes
    if (a.dismiss) return this.dismissCard(a, space)
    // a menu in the terminal: the keys that pick the choice
    if (qid.startsWith('menu:')) {
      await this.chats.readMenu(key, true)
      const menu = this.chats.menu(key)
      if (!menu || menuId(key, menu) !== qid) return { ok: false, error: 'The terminal prompt changed. Read the new card before answering.' }
      const keys = menuKeys(menu, a.choice, a.choices)
      if (!keys) return { ok: false, error: 'Choose one of the options on the card.' }
      // Lock this prompt across concurrent taps, and hold typed messages while its answer is checked.
      if (this.menuAnswers.has(key)) return { ok: false, error: 'Your answer is still being checked.' }
      this.menuAnswers.add(key)
      try {
        const failed = await this.pressMenu(key, keys, qid)
        if (failed) return { ok: false, error: failed }
        const said = menu.multi ? (a.choices?.length ? a.choices.map((i) => menu.choices[i]).join(', ') : menu.reject) : menu.choices[a.choice]
        this.chats.post(key, { id: `menu-answer:${Date.now()}`, who: 'you', answered: answered(menu.title), elsewhere: space ? this.chats.answeredIn(space) : undefined, text: said })
        if (space) this.answeredHere(space, key, menu.title, said ?? '')
        if (a.note) await this.agents.send(key, a.note)
      } finally {
        this.menuAnswers.delete(key)
        void this.agents.deliver(key)
      }
      // an answer in the CLI's own menu (a permission) is no go for a queued task
      this.engine.youWrote(key, { go: false })
      this.emit('chat', key)
      return { ok: true }
    }
    // Shepherdr's own choice card: the answer goes in as one chat line
    const posted = this.chats.log(key).posted.find((p) => p.question?.id === qid)
    if (posted?.question) {
      const q = posted.question
      // answered already (in the app, by typing, or an old alert's button): never a second answer
      if (q.sent !== undefined || this.chats.log(key).answers[qid] !== undefined) return { ok: false, error: 'This card is answered already.' }
      const labels = (a.choices ?? [a.choice]).map((i) => q.choices[i]?.label).filter(Boolean)
      const answer = a.other || labels.join(', ')
      q.sent = a.choice
      this.chats.answer(key, qid, a.choice, a.other, space)
      if (space) this.answeredHere(space, key, q.title, answer)
      // the answer of this card alone: the chat's other cards still wait for theirs (a message of the human's own, typed,
      // is what answers them all)
      await this.send(key, `${line.answer(by ?? this.user, q.title, answer)}${a.note ? `\n${a.note}` : ''}`, [], true, undefined, { keepAsks: true })
      this.emit('snapshot')
      return { ok: true }
    }
    // the CLI's own question tool (AskUserQuestion, request_user_input): keys in its own menu
    const open = this.chats.openQuestion(key)
    // only the question still asked, and only a part of it not answered yet: an old alert's button can't answer the next
    if (open && (qid === open.id || qid.startsWith(`${open.id}:`)) && this.chats.log(key).answers[qid] === undefined) {
      const idx = qid === open.id ? undefined : qid.slice(open.id.length + 1)
      const item = open.items[Number(idx ?? 0)]
      // noted before the keys go in: a second tap meanwhile (the app and an alert's button) is refused
      this.chats.answer(key, qid, a.choice, a.other, space)
      const keys: string[] = []
      if (a.other) keys.push(String((item?.options.length ?? 0) + 1))
      else if (item?.multiSelect) {
        for (const c of a.choices ?? [a.choice]) keys.push(String(c + 1))
        keys.push('enter')
      } else keys.push(String(a.choice + 1))
      await this.agents.keys(key, keys)
      if (a.other) {
        await this.agents.text(key, a.other)
        await this.agents.keys(key, ['enter'])
      }
      // the last question of a form: the CLI asks to submit
      if (Number(idx ?? 0) >= open.items.length - 1 && open.items.length > 1) setTimeout(() => this.agents.keys(key, ['enter']), 600)
      const label = a.other || (a.choices ?? [a.choice]).map((i) => item?.options[i]?.label).filter(Boolean).join(', ')
      this.chats.post(key, { id: `cli-answer:${qid}`, who: 'you', answered: answered(item?.question ?? ''), elsewhere: space ? this.chats.answeredIn(space) : undefined, text: label })
      if (space) this.answeredHere(space, key, item?.question ?? '', label)
      this.engine.youWrote(key, { go: false })
      this.emit('chat', key)
      return { ok: true }
    }
    return { ok: false }
  }

  /** something of yours came after that message: the question it asked is answered already (in words, or by a dismissal
   *  of its own, which shows as answered with no words) */
  private answeredSince(key: string, id: string) {
    const msgs = this.chats.chat(key).messages
    const at = msgs.findIndex((m) => m.id === id)
    return at >= 0 && msgs.slice(at + 1).some((m) => m.who === 'you' && (m.text || m.file || m.answered))
  }

  /** keys go into the menu the card shows: this waits until its prompt has moved on, or says it has not (the card stands
   *  as it was, so nothing was pressed) */
  private async pressMenu(key: string, keys: string[], qid: string): Promise<string | undefined> {
    await this.agents.keys(key, keys)
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 350))
      await this.agents.refresh()
      await this.chats.readMenu(key, true)
      const next = this.chats.menu(key)
      if (!next || menuId(key, next) !== qid) return
    }
    const error = 'The terminal still shows this prompt. Try again or open the terminal.'
    this.chats.post(key, { id: `menu-failed:${Date.now()}`, card: { id: `menu-failed:${Date.now()}`, text: error } })
    this.emit('chat', key)
    return error
  }

  /**
   * A card closed without an answer: its Dismiss, or Esc on it. A CLI's own prompt takes Esc, exactly as the person's Esc
   * in the terminal would, and the CLI's own words reach the agent; Shepherdr's own card says what the person declined,
   * so its agent carries on with its own judgment. Never an answer: a dismissed permission is no, a dismissed plan is no
   * approval.
   */
  private async dismissCard(a: Extract<Action, { type: 'answer' }>, space?: string): Promise<{ ok: boolean; error?: string }> {
    const key = a.chat
    const qid = a.question
    // a prompt on the CLI's own screen (a permission, a form, its question tool): Esc there, as the person would press it
    if (qid.startsWith('menu:')) {
      await this.chats.readMenu(key, true)
      const menu = this.chats.menu(key)
      if (!menu || menuId(key, menu) !== qid) return { ok: false, error: 'The terminal prompt changed. Read the new card before deciding.' }
      // a start stopped on its own screen: Esc there ends the launch, and it asks nothing yet
      if (this.chats.startMenuUp(key)) return { ok: false, error: 'This start waits on its own screen, not on a question: open the terminal to answer it.' }
      // a prompt whose choices could not be read: its keys are a guess, so Esc is not pressed into it
      if (!menu.choices.length) return { ok: false, error: 'Its prompt shows no choices to decline: open the terminal.' }
      if (this.menuAnswers.has(key)) return { ok: false, error: 'Your answer is still being checked.' }
      // a prompt it asked something at (read before Esc: its own answer clears what it said), never a menu a slash
      // command opened: that one asks the agent nothing, and Esc alone closes it
      const asked = !this.chats.commandMenuUp(key) && this.agents.status(key) === 'blocked'
      const words = asked ? dismissWords(this.agents.said(key)?.kind === 'plan' ? 'plan' : 'questions') : undefined
      this.menuAnswers.add(key)
      try {
        const failed = await this.pressMenu(key, ['escape'], qid)
        if (failed) return { ok: false, error: failed }
        // the CLI's own Esc declines it, and the person's words reach the agent too, so it carries on rather than stops
        if (words) await this.send(key, line.dismiss(this.user, menu.title, words), [], true, undefined, { keepAsks: true })
        // its keys are not in the CLI's log: the chat shows the dismissal itself (the line above shows on its own)
        else this.chats.post(key, { id: `menu-dismiss:${Date.now()}`, who: 'you', answered: `Dismissed “${menu.title}”`, elsewhere: space ? this.chats.dismissedIn(space) : undefined })
        if (space) this.answeredHere(space, key, menu.title, DISMISSED, true)
      } finally {
        this.menuAnswers.delete(key)
        void this.agents.deliver(key)
      }
      // a dismissal in the CLI's own menu is no go for a queued task either
      this.engine.youWrote(key, { go: false })
      this.emit('chat', key)
      return { ok: true }
    }
    // Shepherdr's own choice card or plan: the decline goes in as one chat line, so its agent hears it and decides
    const posted = this.chats.log(key).posted.find((p) => p.question?.id === qid)
    if (posted?.question) {
      const q = posted.question
      if (q.sent !== undefined || this.chats.log(key).answers[qid] !== undefined) return { ok: false, error: 'This card is answered already.' }
      const words = dismissWords(dismissKind(qid))
      q.sent = -1
      this.chats.answer(key, qid, -1, words, space, true)
      if (space) this.answeredHere(space, key, q.title, words, true)
      await this.send(key, line.dismiss(this.user, q.title, words), [], true, undefined, { keepAsks: true })
      this.emit('snapshot')
      return { ok: true }
    }
    // the CLI's own question tool (AskUserQuestion, request_user_input): its Esc, which declines the question
    const open = this.chats.openQuestion(key)
    if (open && (qid === open.id || qid.startsWith(`${open.id}:`))) {
      if (this.chats.log(key).answers[qid] !== undefined) return { ok: false, error: 'This card is answered already.' }
      const item = open.items[Number(qid === open.id ? 0 : qid.slice(open.id.length + 1)) ?? 0]
      // only while the CLI waits on it: a question answered in the terminal (its log lagging) must not take Esc, and the
      // card must not say Dismissed for a form that is up
      if (this.agents.status(key) !== 'blocked') return { ok: false, error: 'The CLI no longer waits on this question: read the chat again.' }
      // Esc declines the CLI's whole form, so every question of it is closed, not only the one on the card
      for (let i = 0; i < open.items.length; i++) this.chats.answer(key, open.items.length > 1 ? `${open.id}:${i}` : open.id, -1, undefined, space, true)
      await this.agents.keys(key, ['escape'])
      if (space) this.answeredHere(space, key, item?.question ?? '', DISMISSED, true)
      // its own Esc declines the question, and the person's words reach the agent too (its line shows in the chat)
      await this.send(key, line.dismiss(this.user, excerpt(item?.question ?? ''), dismissWords('questions')), [], true, undefined, { keepAsks: true })
      this.engine.youWrote(key, { go: false })
      this.emit('chat', key)
      return { ok: true }
    }
    // the agent's plain question on its needs-you card in a space's chat: no card of its own in the task's chat, so the
    // decline goes in as its dismissal, quoting the question. Once, like a reply, and only while its card still waits
    const asked = this.chats.chat(key).messages.find((m) => m.id === qid && m.who === 'agent' && m.text && !m.question)
    if (!asked) return { ok: false, error: 'This card is answered already.' }
    if (this.answeredSince(key, qid) || (space && !this.askOpen(space, key, qid))) return { ok: false, error: 'This card is answered already.' }
    if (this.replies.has(key)) return { ok: false, error: 'Your answer is still being checked.' }
    this.replies.add(key)
    try {
      await this.send(key, line.dismiss(this.user, excerpt(asked.text!), dismissWords('questions')), [], true, undefined, { keepAsks: true })
      if (space) {
        this.chats.repliedFrom(key, qid, space)
        this.answeredHere(space, key, asked.text ?? '', DISMISSED, true)
      }
    } finally {
      this.replies.delete(key)
    }
    this.emit('chat', key)
    return { ok: true }
  }

  /* ---------- voice ---------- */

  /** a Browser panel's link to a task's shared browser: here, or passed through to the machine the task is on */
  browser(task: string, out: BrowserClient): BrowserBridge {
    const peer = this.peers?.owner(task)
    if (peer) {
      const url = new URL(`${peer.rec.url}/api/browser?task=${encodeURIComponent(task)}`)
      url.protocol = url.protocol.replace('http', 'ws')
      const ws = new WebSocket(url)
      const early: string[] = []
      ws.onopen = () => early.splice(0).forEach((m) => ws.send(m))
      // frames (the big messages) are skipped for a screen that can't keep up, as on the task's own machine
      ws.onmessage = (e) => {
        const d = String(e.data)
        if (d.length < 20_000 || (out.buffered?.() ?? 0) < 2_000_000) out.send(d)
      }
      ws.onclose = () => out.close()
      return { message: (m) => (ws.readyState === WebSocket.OPEN ? ws.send(m) : early.push(m)), end: () => ws.close() }
    }
    const t = this.engine.tasks.find((x) => x.id === task)
    // a stopped task's browser stays closed until the task is talked to again
    if (!this.browsers || !t || ended(t) || t.stopped) {
      out.send(JSON.stringify({ type: 'error', gone: true, message: !this.browsers ? 'The browser is not in the plugin list.' : t?.stopped ? 'The browser closed when the task was stopped.' : 'No such task here.' }))
      out.close()
      return { message() {}, end() {} }
    }
    return this.browsers.attach(task, out)
  }

  voice(chat: string, out: { send(d: ArrayBuffer | string): void; close(): void }) {
    if (!has('voice')) {
      out.send(JSON.stringify({ type: 'error', message: 'Voice is not in the plugin list.' }))
      return { audio() {}, end() {} }
    }
    try {
      return startVoice(this.voiceTools(chat), out)
    } catch (e) {
      out.send(JSON.stringify({ type: 'error', message: (e as Error).message }))
      out.close()
      return { audio() {}, end() {} }
    }
  }

  /** Voice uses the same actions and chat views as the screen; the owner stays attached to a target. */
  voiceTools(chat: string): import('./voice.ts').VoiceTools {
    const targets = () => {
      const local = this.placeList().filter((p) => !this.peers?.owner(p.chat)).map((p) => ({ key: p.chat, name: p.name, machine: HOST, peer: undefined as ReturnType<Machines['owner']> }))
      local.push(...this.engine.tasks.flatMap((t) => ['Agent', 'Reviewer'].map((role) => ({ key: `${t.id}/${role}`, name: role === 'Agent' ? t.id : `${t.id} reviewer`, machine: HOST, peer: undefined }))))
      for (const peer of this.peers?.list() ?? []) {
        local.push(...(peer.snap?.places ?? []).map((p) => ({ key: p.chat, name: this.chatName(p.chat), machine: peer.rec.machine, peer })))
        local.push(...(peer.snap?.tasks ?? []).flatMap((t) => ['Agent', 'Reviewer'].map((role) => ({ key: role === 'Agent' ? t.agent?.chat ?? `${t.id}/Agent` : `${t.id}/Reviewer`, name: role === 'Agent' ? t.id : `${t.id} reviewer`, machine: peer.rec.machine, peer }))))
      }
      return local
    }
    const resolve = (to?: string) => {
      const all = targets()
      const n = (to || chat).trim().toLowerCase()
      const found = all.filter((t) => [t.key, t.name, `${t.machine}:${t.name}`, `${t.machine}:${t.key}`].some((v) => v.toLowerCase() === n))
      if (found.length !== 1) throw new Error(found.length ? 'Several chats match; use machine:name or the full space key.' : 'No such chat. Use overview to find its full name.')
      return found[0]
    }
    const load = async (t: ReturnType<typeof resolve>) => {
      if (!t.peer) return { chat: this.chats.chat(t.key), status: this.chatStatus(t.key) }
      if (!t.peer.reachable) throw new Error(`${t.machine} is unavailable; its chat may be stale.`)
      const r = await this.peers!.fetch(t.peer, `/api/chat?chat=${encodeURIComponent(t.key)}`, { signal: AbortSignal.timeout(4000) })
      if (!r.ok) throw new Error(`${t.machine} could not read the chat.`)
      const view = await r.json() as { chat: Chat | null; status?: string }
      if (!view.chat || view.chat.key !== t.key || !view.status) throw new Error('The owning machine did not return this chat.')
      return { chat: view.chat, status: view.status }
    }
    return {
      name: `${resolve().machine}:${resolve().name}`,
      send: async (text, to) => {
        const t = resolve(to)
        const action: Action = { type: 'send', chat: t.key, text }
        const queuedHere = t.peer && !t.peer.reachable
        const r = (await (t.peer ? this.peers!.act(t.peer, action) : this.actLocal(action))) as { ok?: boolean; error?: string; waiting?: boolean; waitsFor?: string }
        if (r.error || r.ok === false) throw new Error(r.error ?? 'The message was refused.')
        if (!r.waiting) return 'Sent.'
        if (queuedHere) return 'Queued here while the owning machine is unavailable. It has not reached the agent yet.'
        if (r.waitsFor === 'menu') return 'It waits until the question on its screen is answered; it goes in then.'
        return r.waitsFor === 'turn' ? 'It goes in once the agent finishes this step.' : 'It goes in once the agent has started.'
      },
      read: async (to) => {
        const t = resolve(to)
        const { chat: c, status: state } = await load(t)
        return `${t.machine}:${t.name} is ${state === 'gone' ? 'not running' : state}.\n${c.messages.slice(-8).map((m) => `${m.who === 'you' ? this.user : m.peer ? `${m.peer.name} (another agent)` : t.name}: ${excerpt(m.text ?? m.question?.title ?? (m.artifact ? tag('artifact', { id: m.artifact.id, title: this.snapshot().artifacts.find((a) => a.id === m.artifact!.id)?.title ?? 'deleted' }) : ''), 300)}`).join('\n')}`
      },
      overview: async () => {
        const s = this.snapshot()
        const places = s.places.map((p) => `${p.id} (${p.machine}:${p.name}): ${p.unreachableSince || p.connecting ? 'unavailable; last known ' : ''}${p.status}`)
        const tasks = s.tasks.filter((t) => !t.archived).map((t) => {
          const p = s.places.find((p) => p.id === t.place)
          return `${p?.machine ?? t.place}:${t.id} ${t.name}: ${p?.unreachableSince || p?.connecting ? 'unavailable; last known ' : ''}${t.state}${statusLine(t) ? ` (${statusLine(t)})` : ''}`
        })
        return [...places, ...tasks].join('\n') || 'No tasks.'
      },
      onReply: (fn) => {
        const t = resolve()
        if (!t.peer) {
          const set = this.replyFns.get(t.key) ?? new Set()
          set.add(fn)
          this.replyFns.set(t.key, set)
          this.lastAgentMsg.set(t.key, this.chats.lastReply(t.key) ?? '')
          return () => { set.delete(fn); if (!set.size) { this.replyFns.delete(t.key); this.lastAgentMsg.delete(t.key) } }
        }
        let active = true
        let ready = false
        const seen = new Map<string, string>()
        const accept = (c: Chat) => {
          const replies = c.messages.filter((m) => m.who === 'agent' && m.text && !m.card)
          if (ready) for (const m of replies) if (seen.get(m.id) !== m.text) fn(excerpt(m.text!, 600))
          for (const m of replies) seen.set(m.id, m.text!)
          ready = true
        }
        const off = this.peers!.subscribeChat(t.peer, t.key, (c) => { if (active) accept(c) })
        void load(t).then((view) => { if (active && !ready) accept(view.chat) }).catch(() => {})
        return () => { active = false; off() }
      },
    }
  }

  /* ---------- the shepherdr command ---------- */

  async cli(args: string[], ctx: { chat?: string; pane?: string; cwd?: string; stdin?: string; local?: boolean; proof?: string }): Promise<{ out: string; code: number; secrets?: Record<string, string> }> {
    try {
      // the values themselves, for the shepherdr command to put in a command's environment or a file: never printed,
      // only with a worker-issued capability whose stored scope selects the secret chain
      if (args[0] === 'secret' && (args[1] === 'run' || args[1] === 'env')) {
        const owner = this.agents.secretAccess.authenticate(ctx.proof)
        if (!owner || this.agents.record(owner.chat)?.finished) throw new Error('Secret access needs a current agent credential. Use the owning session command; older sessions must wait for route provisioning. No unauthenticated fallback.')
        if (JSON.stringify(this.agents.secretScope(owner.chat)) !== JSON.stringify(owner.chain)) throw new Error('Secret credential scope is no longer valid.')
        return { out: '', code: 0, secrets: this.secretValues(parseArgs(args).words.slice(2), owner.chain) }
      }
      const out = await this.command(parseArgs(args), ctx)
      return { out: out.endsWith('\n') ? out : `${out}\n`, code: 0 }
    } catch (e) {
      return { out: `${(e as Error).message}\n`, code: 1 }
    }
  }

  private projectFor(p: Parsed, ctx: { chat?: string; cwd?: string }) {
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
  private async toldFrom(ctx: { chat?: string; pane?: string }): Promise<{ name: string; pane?: string; space?: string; task?: string } | undefined> {
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

  /**
   * Who a message from another agent says it is: the name it declared, with our own name for it, its pane and the space
   * or task it works in when the declared one is one of our agents' (a herdr agent name or pane id). Nothing more is
   * looked up: it is still only what that side wrote.
   */
  private peerOf(p: FromAgent): Peer {
    // our own line already says where it runs: the pane, the space and the task it wrote
    if (p.pane || p.space || p.task) return { name: p.name, ...(p.pane ? { pane: p.pane } : {}), ...(p.space ? { space: p.space } : {}), ...(p.task ? { task: p.task } : {}) }
    const key = Object.keys(this.agents.records).find((k) => this.agents.records[k].name === p.name || this.agents.info(k)?.pane_id === p.name)
    if (!key) return { name: p.name }
    const pane = this.agents.info(key)?.pane_id
    const t = key.includes('/') ? this.engine.task(key.split('/')[0]) : undefined
    return { name: this.chatName(key), ...(pane ? { pane } : {}), ...(t ? { task: t.id, space: this.chatName(t.project) } : { space: this.chatName(key) }) }
  }

  /** a task's agent says how far along it is: shepherdr status <id> "<line>" --done <0-100> [--left 5m] */
  private reportCommand(id: string, words: string[], p: Parsed, ctx: { chat?: string }) {
    const t = this.engine.task(id)
    if (!t) throw new Error(`No task ${id}; shepherdr status <id> "<line>" --done <0-100> [--left 5m]`)
    if (ctx.chat?.includes('/') && ctx.chat.split('/')[0].toUpperCase() !== t.id.toUpperCase()) throw new Error(`A task's agent reports only its own task's progress, not ${t.id}'s.`)
    const line = words.join(' ').trim()
    const done = (one(p, 'done') ?? '').replace(/%$/, '')
    if (!line || !/^\d{1,3}$/.test(done) || Number(done) > 100) throw new Error(`shepherdr status ${t.id} "<what you are doing, at most ${STATUS_MAX} characters>" --done <0-100> [--left 5m|1h20m]`)
    const leftArg = one(p, 'left')
    const left = leftArg === undefined ? undefined : minutesOf(leftArg)
    // up to 99 hours: what fits under the dot ("99h")
    if (p.flags.has('left') || left === null || (left ?? 0) > 99 * 60) throw new Error(`--left takes a time up to 99h, like 5m, 90m or 1h20m${leftArg ? `, not ${leftArg}` : ''}`)
    if (!/[\p{L}\p{N}]/u.test(fitStatus(line))) throw new Error('Write the line in words: what you are doing now.')
    const r = this.engine.report(t.id, line, Number(done), left)
    const cut = r.msg !== line.replace(/\s+/g, ' ') ? ` (cut to ${STATUS_MAX} characters)` : ''
    return `Noted: ${t.id} shows "${r.msg}"${cut}, ${r.progress}% done${r.left !== undefined ? `, about ${r.left} min left` : ''}.`
  }

  private async command(p: Parsed, ctx: { chat?: string; pane?: string; cwd?: string; stdin?: string }): Promise<string> {
    const [a0, a1, ...rest] = p.words
    if (!a0 || a0 === 'help' || p.flags.has('help')) return HELP
    switch (a0) {
      case 'status': {
        if (a1) return this.reportCommand(a1, rest, p, ctx)
        const kept = this.engine.keptLeftovers()
        const line = `Shepherdr on ${NAME}: ${this.places.shown().length} spaces, ${this.engine.tasks.filter((t) => !ended(t) && !t.archived).length} open tasks; herdr ${this.agents.reachable ? 'answers' : 'does not answer'}.`
        return kept.length ? `${line}\nDone tasks that kept work (remove it by hand once you're sure):\n${kept.map((k) => `  ${k}`).join('\n')}` : line
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
        if (a1 === 'list' || !a1)
          return this.places
            .shown()
            .map((x) => (x.space ? `${x.name}  ${x.space.key}  ${this.places.folderLine(x.space)}${x.space.github ? `  github:${x.space.github}` : ''}` : `${x.name}  (home space)  ${boxHome()}`))
            .join('\n')
        if (a1 === 'rename') {
          const x = rest[0] ? this.places.find(rest[0]) : undefined
          if (!x || !rest[1]) throw new Error('shepherdr space rename <name> <new-name> (shepherdr space list shows them)')
          const r = (await this.act({ type: 'rename', id: x.id, name: rest[1] })) as { ok?: boolean; error?: string }
          if (r.ok === false) throw new Error(r.error)
          return `${x.name} is called ${this.places.nameOf(x.id)} now.`
        }
        if (a1 === 'set' && rest[0] === 'base') {
          const pr = this.projectFor(p, ctx)
          if (!rest[1]) throw new Error('shepherdr space set base <branch> --space NAME')
          await this.places.setBase(pr.name, rest[1])
          this.emit('snapshot')
          return `${pr.name}: new tasks start from and merge into ${pr.base}. Existing tasks keep their target.`
        }
        if (a1 === 'remove') {
          if (!rest[0]) throw new Error('shepherdr space remove <name>')
          const shown = this.places.find(rest[0])?.name ?? rest[0]
          const pr = await this.removeSpace(rest[0])
          return `Removed ${shown} from Shepherdr; ${pr.path} and its code stay on disk. shepherdr space add ${pr.path} --name ${shown} brings it back with its open tasks and chat.`
        }
        throw new Error('shepherdr space add|list|rename|remove')
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
      // a task's own agent counts each review round it starts, so its brief's at most so many are kept by
      case 'review': {
        const t = this.engine.task(a1 ?? '')
        if (!t) throw new Error(`No task ${a1 ?? ''}; shepherdr review <id>`)
        if (ctx.chat !== `${t.id}/Agent`) throw new Error(`${t.id}'s own agent counts its review rounds, not ${ctx.chat ? 'this chat' : 'you at the command'}; a coordinator adds one with shepherdr task review-more ${t.id}`)
        const { round, rounds } = this.engine.reviewRound(t.id)
        return `Round ${round} of ${rounds} counted for ${t.id}: review its final commit before you report ready.`
      }
      // done is ready's old name, still taken
      case 'ready':
      case 'done': {
        const t = this.engine.task(a1)
        if (!t) throw new Error(`No task ${a1}`)
        const { said, facts } = summaryOpts(p, rest)
        const r = await this.engine.done(t.id, said ?? '', facts)
        if (r.state === 'ended') return `Noted. ${t.id} is Done already (${t.closed ? 'nothing to merge' : 'merged'}).`
        if (r.state === 'merged') return `Noted: ${r.note}, so ${t.id} is Done (merged): there is nothing to merge, and no pull request to open.${ctx.chat === `${t.id}/Agent` ? ' Your worktree, branch and herdr space close once this turn ends: do nothing more in them.' : ''}`
        if (r.state === 'closed') return `Noted: ${t.branch} has no changes, so there is nothing to merge: ${t.id} is Done.${ctx.chat === `${t.id}/Agent` ? ' Your worktree, branch and herdr space close once this turn ends: do nothing more in them.' : ''}`
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
        const r = a0 === 'pr' ? await this.engine.openPr(t.id) : await this.engine.checks(t.id)
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
          question: { id, title, ordinary: p.flags.has('ordinary') || undefined, kind: Object.keys(desc).length || p.flags.has('other') ? 'Question' : 'Form', choices: labels.map((label) => ({ label, description: desc[label] })), multi: p.flags.has('multi'), other: p.flags.has('other'), to: this.chatName(ctx.chat) },
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
        throw new Error(`shepherdr ${a0} is gone: pages are artifacts now. shepherdr artifact new <file.html> --title "…" shows one (checked at phone width first), shepherdr artifact check <file.html> only looks; shepherdr help has the rest.`)
      case 'alert': {
        if (!a1) throw new Error('shepherdr alert "<title>" --body "<why>"')
        const t = one(p, 'task') ? this.engine.task(one(p, 'task')!) : undefined
        // another machine's task (the main machine's home space keeps every machine's overview): it opens on that task,
        // and while it waits on you it buzzes as the task's own alert would
        const far = one(p, 'task') && !t ? this.peers?.list().flatMap((l) => l.snap?.tasks ?? []).find((x) => x.id.toUpperCase() === one(p, 'task')!.toUpperCase()) : undefined
        const waits = far && (far.status === 'need' || far.status === 'ready') ? { tag: far.id, task: true as const } : {}
        // about a task: it opens on its card. While the task waits on you, it says what the task needs as its own alert
        // does (the choices first, then the coordinator's why) and takes that alert's place
        const about = t && this.taskAlert(t)
        const why = [a1, one(p, 'body')].filter(Boolean).join(': ')
        const from = ctx.chat ? this.chatName(ctx.chat) : 'Shepherdr'
        if (t && about && ['need', 'ready'].includes(this.engine.statusOf(t))) this.alert({ id: randomUUID(), from: 'Shepherdr', ...about, body: `${about.body}\n${from}: ${why}` })
        else if (far) this.alert({ id: randomUUID(), from, title: a1, body: one(p, 'body') ?? '', go: { place: far.place, task: far.id }, ...waits })
        else this.alert({ id: randomUUID(), from, title: a1, body: one(p, 'body') ?? '', go: about?.go ?? { place: ctx.chat && !ctx.chat.includes('/') ? ctx.chat : placeId.home() }, ...(ctx.chat?.includes('/') ? { task: true as const } : {}) })
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
        const block = settingsBlock('<id>', { ways: this.settings.ways(pr), reviewer: this.settings.harness('reviewer', pr), fallback: this.settings.reviewerBackups(pr), agent: this.settings.harness('task', pr), by: this.settings.setBy(pr) })
        const repo = pr ? this.places.byName(pr) : undefined
        const folder = repo ? `\nFolder: ${this.places.folderLine(repo)}${repo.repoId ? ` (found again by its repo's id ${shortId(repo.repoId)} if its folder is renamed or moved)` : ''}` : ''
        return `${head}${repo ? `${folder}\nBase branch: ${repo.base} (new tasks; per-task override: --base <branch>)` : ''}\n${this.settings.lines(pr, NAME)}${beat}${now}\n\nEvery new task's brief${pr ? ` in ${pr}` : ''} ends with:\n${block}\n\nFor one task, set any of these with task add: --set review.rounds=1 --set merge="ask me first" (--set agent=codex, model, effort, reviewer, reviewer.model, reviewer.effort, reviewer.fallback, reviewer.fallbackModel, reviewer.fallbackEffort, task.fallback, coordinator.fallback, backup.model, backup.effort too, and a chain's 2nd to 5th backups by their own keys: task.fallback2, task.fallback2Model, task.fallback2Effort, reviewer.fallback2…), or say so in its brief, which wins.`
      }
      case 'models': {
        const kinds = a1 ? [kindOf(a1)] : ['claude', 'codex', 'pi']
        if (!kinds[0]) throw new Error(`No CLI called ${a1}; herdr starts ${CLIS.join(', ')}`)
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
          return `${pr.name}: base branch ${pr.base}. Existing tasks keep their target.`
        }
        if (!CATALOG.some((s) => s.rows.some((r) => r.key === a1))) throw new Error(`No setting ${a1}; shepherdr show lists them`)
        // Everywhere unless it says --machine (this machine's own) or --space NAME (that space's own)
        const named = one(p, 'space')
        const pr = named ? (this.places.find(named)?.id === placeId.home() ? '~' : this.projectFor(p, ctx).name) : undefined
        const level: Level = pr ? { space: pr } : p.flags.has('machine') ? 'machine' : 'all'
        if (level === 'all' && BOX) {
          // the main machine keeps Everywhere: it sets it there, and this machine takes it at once
          const r = await mainCli([a0, a1, ...(value === null ? [] : [value])])
          if (r.code) throw new Error(r.out.trim())
          this.adoptEverywhere()
        } else {
          const r = this.settings.set(a1, value, level)
          if (!r.ok) throw new Error(r.error)
        }
        this.settingChanged(a1)
        const where = pr ? `${named}'s` : level === 'machine' ? `${NAME}'s` : "Everywhere's"
        const now = this.settings.get(a1, pr)
        // a trigger in words too, to tell the human
        return `${a0 === 'unset' ? `${a1}: ${where} own is unset; it is ${now} now.` : `${a1} = ${now} (${where})`}${this.settings.words(a1, now).replace(/^\n\s*/, '\nIn words: ')}${a1.endsWith('.instructions') ? '\nUsed at the next start or restart; running agents are unchanged. Reviewer changes need a new or restarted task agent.' : ''}`
      }
      case 'automation': {
        const op = a1 ?? 'list'
        const pr = one(p, 'space') || op !== 'list' ? this.projectFor(p, ctx) : null
        const place = pr ? placeId.space(pr.name) : ''
        const name = rest[0]
        const odd = [...Object.keys(p.opts), ...p.flags].filter((f) => !['when', 'on', 'task', 'brief', 'desc', 'space', 'agent', 'model', 'effort', 'name'].includes(f))
        if (odd.length) throw new Error(`Automation ${op} takes no --${odd[0]}: only --when (a time rule), --on (events), --task, --brief, --agent, --model, --effort, --name and --space`)
        const agent = one(p, 'agent') || one(p, 'model') || one(p, 'effort') ? harnessOf(p, this.settings) : undefined
        const brief = one(p, 'brief') ?? one(p, 'desc')
        const zone = this.settings.zone()
        const runs = (x: Automation) => x.runs?.at(-1) ? `last ran ${age(x.runs.at(-1)!.at)} ago: ${x.runs.at(-1)!.task ?? `failed (${x.runs.at(-1)!.error})`}` : 'not run yet'
        // its trigger in words, its next runs, and as kept (for an edit)
        const told = (x: Automation) => {
          const next = x.on ? nextWords(x.trigger.time, zone) : []
          return `${triggerWords(x.trigger, zone)}${next.length ? `; next ${next.join(', ')}` : ''} [${[x.trigger.time && `--when "${x.trigger.time}"`, x.trigger.on?.length && `--on "${eventsText(x.trigger.on)}"`].filter(Boolean).join(' ')}]`
        }
        if (op === 'add') {
          if (!name || !one(p, 'task') || (!one(p, 'when') && !one(p, 'on'))) throw new Error('shepherdr automation add "<name>" --task "<title>" [--brief "<brief>"] [--when "<time rule>"] [--on "<events>"] (one or both)')
          const x = this.automation(place, 'add', undefined, { name, when: one(p, 'when'), on: one(p, 'on'), title: one(p, 'task')!, brief, agent }) as Automation
          return `Automation “${x.name}” is on: ${told(x)}. It adds the task “${x.task.title}” to ${pr!.name}, with a fresh agent. Tell the human when it runs in these words.`
        }
        if (op === 'edit') {
          if (!name) throw new Error('shepherdr automation edit "<name>" [--name "<new name>"] [--task …] [--brief …] [--when "<time rule>" | off] [--on "<events>" | none] [--agent …]')
          const when = one(p, 'when')
          const on = one(p, 'on')
          const x = this.automations.edit(place, name, { name: one(p, 'name'), time: when !== undefined ? timeRule(when) : undefined, on: on !== undefined ? eventRules(on) : undefined, task: { ...(one(p, 'task') ? { title: checkTitle(one(p, 'task')!) } : {}), ...(brief !== undefined ? { desc: brief || undefined } : {}), ...(agent ? { agent } : {}) } })
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
        return (
          this.automations.list
            .filter((x) => !place || x.place === place)
            .map((x) => `${x.name} · ${told(x)} · adds “${x.task.title}”${x.task.agent?.kind ? ` (${[x.task.agent.kind, x.task.agent.model, x.task.agent.effort].filter(Boolean).join(', ')})` : ''} · ${this.places.space(x.place)?.name ?? x.place}${x.on ? '' : ' · paused'} · ${runs(x)}`)
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
        if (name && !named) throw new Error(`No place ${name}`)
        const at = named ?? this.placeList().find((x) => x.id === ctx.chat) ?? this.placeList().find((x) => this.placeOfCommand(p, ctx) && x.id === placeId.space(this.placeOfCommand(p, ctx)!.name)) ?? this.placeList().find((x) => x.id === placeId.home())!
        if (this.peers?.owner(at.id)) throw new Error(`${at.name} is on another machine: ask there`)
        // Run now: one heartbeat at once, the same as the pill's Run now and Settings' (refused while one wakes)
        if (run) {
          const r = this.wake(at.id)
          return r.queued ? `${r.name}'s coordinator is busy: it wakes once its turn is over, and says in the chat whether it found anything.` : `Woke ${r.name}'s coordinator: one heartbeat now. It says in the chat whether it found anything.`
        }
        if (set) {
          if (ctx.stdin === undefined) throw new Error("Give the whole new HEARTBEAT.md on stdin: shepherdr heartbeat set [<place>] < file, or with a heredoc. Empty stops the heartbeat.")
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
        return [
          `${at.name}: Autopilot ${at.mode === 'autopilot' ? 'on' : 'off'}; heartbeat: ${when}. Wakes at once on: ${eventWords(h.on).toLowerCase()}${held.length ? ` (${held.length} news waiting for the heartbeat)` : ''}. (Settings: heartbeat.when, heartbeat.on, time.zone.)`,
          list ? `HEARTBEAT.md${existsSync(heartbeatFile(at.id)) ? '' : ' (the starting checklist: none saved yet)'}:\n${list}` : 'HEARTBEAT.md is empty: no heartbeat until it has a checklist.',
          `Change it: shepherdr heartbeat set${named ? ` ${at.name}` : ''} < file (the whole new text on stdin; empty stops the heartbeat), or the human in Settings → Autopilot.`,
          `Wake it once now: shepherdr heartbeat run${named ? ` ${at.name}` : ''} (one wake at a time, only on Autopilot).`,
        ].join('\n\n')
      }
      case 'doctor': {
        if (BOX) throw new Error(`shepherdr doctor checks every machine from the main one: run it there (${HOST} is run from it over SSH).`)
        const own = `${NAME} (this machine, the main one): herdr ${this.agents.reachable ? 'answers' : 'does not answer'}${this.browsers ? `; shared browser ${this.browsers.status().ready ? 'ready' : this.browsers.status().hint}` : ''}`
        return [own, ...this.pushWarnings().map((warning) => `Alerts: ${warning}`), ...((await this.peers?.doctor()) ?? []), ...(await this.places.doctor())].join('\n')
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

  /* ---------- secrets ---------- */

  /** the levels a command's secrets come from, most specific first: its space (the asking agent's, or the folder's),
   *  this machine, Everywhere */
  private secretChain(ctx: { chat?: string; cwd?: string }) {
    const space = ctx.chat?.includes('/') ? this.engine.task(ctx.chat.split('/')[0])?.project : ctx.chat?.startsWith('p:') ? ctx.chat : ctx.cwd ? this.places.forPath(ctx.cwd) && placeId.space(this.places.forPath(ctx.cwd)!.name) : undefined
    return [...(space ? [space] : []), placeId.machine(), 'all']
  }

  /** a level's name, as Settings shows it: Everywhere, this machine's, a space's */
  private secretLevelName(level: string) {
    if (level === 'all') return 'Everywhere'
    if (level === placeId.machine()) return NAME
    return level.startsWith('p:') ? (this.places.nameOf(level) ?? level.split(':').slice(2).join(':')) : level.slice(2)
  }

  /** the level a human's shepherdr secret set or rm is for: Everywhere (none), this machine, or one space */
  private secretLevel(p: Parsed) {
    if (one(p, 'space')) return placeId.space(this.projectFor(p, {}).name)
    return p.flags.has('machine') ? placeId.machine() : 'all'
  }

  /** each name's value, for shepherdr secret run and env (names may come comma-separated) */
  private secretValues(words: string[], chain: string[]) {
    const names = words.flatMap((w) => w.split(',')).map((w) => w.trim()).filter(Boolean)
    if (!names.length) throw new Error('shepherdr secret run NAME [NAME …] -- <command>, or shepherdr secret env NAME [NAME …] [--file .env]')
    const bad = names.filter((n) => !SECRET_NAME.test(n))
    if (bad.length) throw new Error(`Not a secret's name: ${bad.join(', ')} (letters, digits and _, like GITHUB_TOKEN)`)
    const { found, missing } = this.vault.pick(names, chain)
    if (missing.length) throw new Error(`No secret ${missing.join(', ')} here. Ask the human for it: shepherdr secret ask ${missing[0]} --why "<what it is for>", then end your turn.`)
    return Object.fromEntries(Object.entries(found).map(([n, f]) => [n, f.value]))
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
  private async checkArtifact(html: string, data: unknown, missing: string[]) {
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
    if (!ctx.chat) throw new Error('shepherdr attach works from an agent Shepherdr started: it sends into that agent\'s own chat.')
    const odd = [...Object.keys(p.opts), ...p.flags].filter((f) => f !== 'caption' && f !== 'text')
    if (odd.length) throw new Error(`shepherdr attach takes no --${odd[0]}: shepherdr attach <file> [<file> …] [--caption "…"]`)
    const caption = (one(p, 'caption') ?? one(p, 'text'))?.trim().replace(/\s*\n\s*/g, ' ') || undefined
    if (!paths.length) {
      // no path: what this folder has that it could send, so an agent that forgot the name finds it
      const here = (ctx.cwd ?? HOME).replace(/^~(?=\/)/, boxHome())
      let found: string[] = []
      try {
        found = task.readdirSync(here).filter((n) => isMedia(n)).sort().slice(0, 20)
      } catch {
        found = []
      }
      throw new Error(
        `shepherdr attach <file> [<file> …] [--caption "…"]: a picture or a video, shown in your chat where the person reads.${found.length ? `\nHere: ${found.join(' · ')}` : ''}`,
      )
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
        throw new Error(`${name} is neither a picture nor a video: shepherdr attach shows one of those in your chat (any picture the chat draws, and mp4, m4v, webm, mov or ogv). Anything else is words and a path.`)
      if (st.size > ATTACH_MAX) throw new Error(`${name} is ${Math.round(st.size / 1024 / 1024)} MB: the chat takes a picture or a video up to ${ATTACH_MAX / 1024 / 1024} MB (crop it, or make it shorter first).`)
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
      files.length === 1 ? (videos ? 'a video' : 'a picture') : !videos ? `${files.length} pictures` : !pics ? `${files.length} videos` : `${files.length} files (${pics} ${pics === 1 ? 'picture' : 'pictures'}, ${videos} ${videos === 1 ? 'video' : 'videos'})`
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
        const all = Object.values(this.artifacts.list).filter((a) => !pr || a.place === pr)
        return all.sort((a, b) => b.at - a.at).map((a) => `${a.id}  v${this.artifacts.latest(a).n}  ${a.title}  · ${this.chatName(a.place)} · ${age(a.at)}`).join('\n') || 'No artifacts here yet.'
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

  private async taskCommand(sub: string | undefined, rest: string[], p: Parsed, ctx: { chat?: string; cwd?: string }) {
    if (sub === 'add') {
      if (!rest[0]?.trim()) throw new Error('shepherdr task add "<title>" --desc "<the whole brief>"')
      if (p.flags.has('after')) throw new Error('--after needs the tasks it waits for: --after SHE-12,SHE-13')
      const odd = [...Object.keys(p.opts), ...p.flags].filter((f) => !['brief', 'desc', 'space', 'base', 'after', 'at', 'in', 'later', 'agent', 'model', 'effort', 'reviewer', 'reviewer-model', 'reviewer-effort', 'set'].includes(f))
      if (odd.length) throw new Error(`Task add takes no --${odd[0]}: only --desc, --space, --base, --after, --at, --in, --later, --set, --agent, --model, --effort, --reviewer, --reviewer-model and --reviewer-effort`)
      // --set key=value: a How tasks work setting for this task, or what --agent, --reviewer and the like set
      const set: Record<string, string> = {}
      for (const pair of p.opts.set ?? []) {
        const r = setForTask(pair)
        if ('error' in r) throw new Error(r.error)
        if ('flag' in r) (p.opts[r.flag] ??= []).push(r.value)
        else set[r.key] = r.value
      }
      const bare = [...p.flags].filter((f) => f !== 'later')[0]
      if (bare) throw new Error(`--${bare} needs a value`)
      const title = checkTitle(rest[0])
      const named = one(p, 'space')
      if (named && !this.places.byName(named) && !this.places.byKey(named) && !this.places.space(named)) {
        // Helpers reach their own worker. Delegate a foreign target through the owning main installation.
        if (BOX && process.env.SHEPHERDR_MAIN_HOME) {
          const server = JSON.parse(readFileSync(join(process.env.SHEPHERDR_MAIN_HOME, 'server.json'), 'utf8')) as { port: number }
          const r = await fetch(`http://127.0.0.1:${server.port}/api/cli`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ args: taskAddArgs(rest, p), chat: this.requestedNews.known(ctx.chat) }),
            signal: AbortSignal.timeout(20_000),
          })
          const result = await r.json() as { out: string; code: number }
          if (result.code) throw new Error(result.out.trim())
          return result.out.trim()
        }
        const targets = (this.peers?.list() ?? []).flatMap((l) => (l.snap?.places ?? []).filter((x) => !x.home && (x.id === named || x.name === named)).map((x) => ({ l, x })))
        if (targets.length > 1) throw new Error('Several spaces have that name; use its full p:machine:space identity.')
        if (targets.length === 1) {
          const { l, x } = targets[0]
          const args = taskAddArgs(rest, p, x.id.split(':').slice(2).join(':'))
          const result = await this.onPeer<{ out: string; code: number }>(l, '/api/cli', {
            method: 'POST', headers: { 'content-type': 'application/json' },
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
      const reviewer = reviewerOf(p, this.settings)
      const t = this.engine.add({ project: pr.name, base: one(p, 'base'), title, desc: one(p, 'brief') ?? one(p, 'desc'), by: this.byWho(ctx), requester: this.requestedNews.known(ctx.chat), after, later: p.flags.has('later'), at: when, agent, reviewer, set })
      // one added for a time has no agent yet: nothing of Settings is read until it starts
      if (t.scheduled) {
        const starts = startsWords(t.scheduled.at, Date.now(), this.settings.zone())
        const waits = [t.after?.length ? `${t.after.join(', ')} ${t.after.length === 1 ? 'is' : 'are'} done` : '', 'the machine has room, as for any queued task'].filter(Boolean).join(' and ')
        return `Added ${t.id}: ${t.title}, ${starts.toLowerCase()}. It has no agent yet: it starts by itself then, once ${waits}, on the Settings as they are then.${p.flags.has('later') ? ` Its agent then reads the brief and waits for a go (shepherdr task tell ${t.id} "go").` : ''}`
      }
      const on = [CLI_NAME[t.agent!.kind] ?? t.agent!.kind, t.agent!.model, t.agent!.effort && `${t.agent!.effort} effort`].filter(Boolean).join(', ')
      if (t.after?.length) return `Added ${t.id}: ${t.title}, queued after ${t.after.join(', ')}. It has no agent, worktree or herdr space while it waits: once ${t.after.length === 1 ? 'that task is' : 'they are all'} done and the machine has room, its agent (${on}) starts on the brief. A message to it (shepherdr task tell ${t.id} …) starts its agent sooner, still queued.`
      if (p.flags.has('later')) return `Added ${t.id}: ${t.title}, for later. Its agent (${on}) reads the brief now and waits for a go (shepherdr task tell ${t.id} "go").`
      if (t.held) return `Added ${t.id}: ${t.title}, held: ${t.held.why === 'slots' ? `all ${this.settings.machine().max} slots are taken` : 'the machine is busy'} (${this.workingLine()}). It shows as Queued and its agent (${on}) starts by itself when there's room, oldest first.`
      return `Added ${t.id}: ${t.title}. Its agent (${on}) starts on the brief now.${after.length ? ' What it would wait for is done already.' : ''}`
    }
    if (sub === 'list' || !sub) {
      const pr = one(p, 'space') ? this.projectFor(p, ctx) : null
      // archived tasks only with --archived, and then only they
      const shown = (t: { archived?: unknown }) => !!t.archived === p.flags.has('archived')
      const ts = this.engine.tasks.filter((t) => (!pr || t.project === placeId.space(pr.name)) && shown(t)).map((t) => this.engine.view(t))
      const others = pr ? [] : (this.peers?.list() ?? []).flatMap((l) => (l.snap?.tasks ?? []).filter(shown).map((t) => ({ ...t, machine: l.rec.machine })))
      const all = doneNewestFirst<(typeof ts)[number] | (typeof others)[number]>([...ts, ...others])
      if (p.flags.has('json')) return JSON.stringify(all.map((t) => ({ id: t.id, title: t.name, status: t.status, sub: statusLine(t), machine: 'machine' in t ? t.machine : undefined, archived: t.archived, pinned: t.pinned, ...(t.scheduled ? { scheduled: t.scheduled } : {}) })), null, 2)
      const rows = all.map((t) => `${t.id.padEnd(8)} ${t.status.padEnd(5)} ${t.name}${t.pinned ? '  (pinned)' : ''}${statusLine(t) ? `  · ${statusLine(t)}` : ''}${'machine' in t ? `  (on ${t.machine})` : ''}`)
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
        // the rounds its agent counted, and the one its coordinator may have added
        const rounds = t.reviews === undefined ? undefined : `Review rounds: ${t.reviews} of ${this.engine.roundsOf(t)} used${t.reviewsAdded ? ', one added by its coordinator' : ''}`
        return [`${v.id} ${v.name}`, `State: ${v.state}${statusLine(v) ? ` · ${statusLine(v)}` : ''}${v.pinned ? ' · pinned' : ''}`, `Added: ${v.created}`, v.branch ? `Branch: ${v.branch}` : '', v.base ? `Merges into: ${v.base}` : '', rounds, v.desc ? `\n${v.desc}` : ''].filter(Boolean).join('\n')
      }
      case 'tell': {
        // a coordinator's go to a task that waits starts it only when this machine has room; a message an agent's own
        // shell sends says who it came from, so the chat shows it as that agent's and never as the human's words
        const r = await this.engine.tell(t.id, rest.slice(1).join(' '), { gate: !ctx.chat?.includes('/'), from: await this.toldFrom(ctx) })
        if (r.held) return `${t.id} is held: ${this.heldWords(r.held)} (${this.workingLine()}). It shows as Queued and gets your message when there's room, oldest first.`
        return `Told ${t.id}.`
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
            if (r.held) return `${t.id} no longer waits for a time, but is held: ${this.heldWords(r.held)} (${this.workingLine()}). It starts as soon as there's room, oldest first.`
            return `${t.id} no longer waits for a time: it starts now.`
          }
          const when = whenFrom(at, within, this.settings.zone())
          this.engine.schedule(t.id, when)
          const after = this.engine.view(t).after ?? []
          return `${t.id} starts ${startsWords(when, Date.now(), this.settings.zone()).replace(/^Starts /, '')}. It waits for the machine's room like any queued task${after.length ? `, and for ${after.join(', ')}` : ''}; its Settings are read when it starts, not before.`
        }
        if (!refs.length)
          throw new Error(
            'shepherdr task queue <id> --after SHE-12[,SHE-13]  (--after none clears it), or --at "tomorrow 9:00" / --in 6h  (--at none clears a time and starts it now)',
          )
        const none = refs.length === 1 && /^(none|nothing|-)$/i.test(refs[0].trim())
        const r = this.engine.queue(t.id, none ? [] : refs, { self: ctx.chat === `${t.id}/Agent` })
        // one waiting for a time has no agent to tell: what it waits for is looked at once its time comes
        if (t.scheduled) {
          const starts = startsWords(t.scheduled.at, Date.now(), this.settings.zone()).replace(/^Starts /, '')
          if (!r.queued.length) return `${t.id} waits for no task now; it keeps its time (${starts}) and starts then.`
          return `${t.id} waits for ${r.queued.join(', ')} once its time comes (${starts}).`
        }
        if (r.queued.length) return `${t.id} is queued after ${r.queued.join(', ')}. ${ctx.chat === `${t.id}/Agent` ? 'Stop at a clean point, reply in one line and end your turn: Shepherdr tells you to go.' : 'Its agent is told to wait; Shepherdr tells it to go once they are done.'}`
        if (r.went) return t.held ? `${t.id} waits for no task now, but is held: ${t.held.why === 'slots' ? `all ${this.settings.machine().max} slots are taken` : 'the machine is busy'} (${this.workingLine()}). Its agent gets the go when there's room.` : `${t.id} waits for nothing more: its agent is told to go.`
        return none ? `${t.id} was not queued.` : `${t.id} isn't queued: what it would wait for is done already.`
      }
      case 'stop': {
        const kept = await this.engine.stopTask(t.id)
        return `Stopped ${t.id}: its agent is closed${kept.length ? `; kept ${kept.join(', ')}` : ''}. Writing to it starts it again.`
      }
      case 'close': {
        if (ctx.chat?.includes('/')) throw new Error(`Coordinators close tasks. A task's agent reports with shepherdr ready ${ctx.chat.split('/')[0]} (with no changes on its branch, that is Done at once).`)
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
      if (extra.length)
        throw new Error(`--all restarts every coordinator of this machine's spaces on what its Settings say, so it takes no --${extra[0]} of its own: shepherdr restart --all`)
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

  /** delete a task (its agent, herdr space, worktree, branch, chat and record) and what this side kept of its chat */
  private async deleteTask(id: string, force: boolean) {
    const key = `${id}/Agent`
    const left = await this.engine.deleteTask(id, { force })
    rmSync(join(HOME, 'inbox', chatDir(key)), { recursive: true, force: true })
    this.replyFns.delete(key)
    this.lastAgentMsg.delete(key)
    this.emit('snapshot')
    return left
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

/** how long one line of another space's news may be for the main machine's home space */
const OVERVIEW_MAX = 240

/** how a coordinator answers news the human sees as a card: the card is never the chat's last word */
const REPLY_AFTER_CARD =
  'reply after it in one or two short lines of plain words: what it means here, what comes next, and whether the human needs to know or do anything (“Letter garden is live. TG-30 starts next, nothing needed from you.”). Never <no-reply> to it.'

/** what a task holds, in words for the screen without its path: "uncommitted changes" */
/** who added a task an automation added: "the automation “Nightly”" */
const BY_AUTOMATION = 'the automation'


/** no backup is left after the harness an agent ran on: it was the last of its chain that differs from the primary, or
 *  none differs (then it ran on the primary): every model of that role ran out */
export function noneLeft(ran: Harness, primary: Harness, backups: Harness[]) {
  const i = backups.findIndex((b) => sameHarness(b, ran))
  return !backups.slice(i + 1).some((b) => !sameHarness(b, primary) && !sameHarness(b, ran))
}

const heldWords = (h: string) => /\(([^)]*)\)$/.exec(h)?.[1] ?? h

/** a time left as minutes: "5m", "5 min", "90", "1h", "1h20m", "1.5h"; null when it is none of those */
export function minutesOf(text: string): number | null {
  const m = text.trim().toLowerCase().match(/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*(?:m|mins?|minutes?)?)?$/)
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return Math.round(Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0))
}

/** a task's line in the CLI, as on screen: its agent's own line while it works, else its standard status line (never the brief) */
function statusLine(t: Task) {
  return t.status === 'work' && t.report && !t.report.paused ? t.report.msg : t.sub
}

/** a stopped task's Browser item */
const STOPPED = { ready: false, hint: 'The browser closed when the task was stopped. Write to the task to start it again.' }

/** a chat's own folder in the inbox: never "." or "..", so it can't lead out of it */
function chatDir(chat: string) {
  return chat.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^\.+/, '_')
}

function clock(t: number) {
  return new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/** task add's --agent, --model and --effort: what it sets for this one task, refused when it makes no sense */
function harnessOf(p: Parsed, settings: Settings): { kind?: string; model?: string; effort?: string } {
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
  if (((m && m !== 'default') || (e && e !== 'default')) && !c) throw new Error(`Shepherdr passes a model and effort to Claude Code, Codex and pi only; ${name} runs on its own`)
  if (m !== undefined && refuse(`task.model`, m)) throw new Error(`--${flag}model ${m}: ${refuse('task.model', m)}`)
  const found = m && m !== 'default' ? findModel(kind, m) : undefined
  if (m && m !== 'default' && knowsModels(kind) && !found) throw new Error(`--${flag}model ${m}: ${name} has no such model. It takes ${c!.models.map((x) => x.id).join(', ')}, or default`)
  const on = m === undefined ? model : m === 'default' ? undefined : (found?.id ?? m)
  if (e !== undefined && e !== 'default') {
    const levels = effortsOf(kind, on)
    if (!levels.includes(e)) throw new Error(levels.length ? `--${flag}effort takes default, ${levels.join(', ')}${on ? ` on ${findModel(kind, on)?.label ?? on}` : ` on ${name}`}` : `--${flag}effort: ${findModel(kind, on)?.label ?? on} takes no effort level`)
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

/** a worker's Everywhere defaults: the main machine's settings file, as it is now */
function sharedEverywhere(): Record<string, string> | null {
  const dir = process.env.SHEPHERDR_SHARED_HOME
  if (!dir) return null
  try {
    return (JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { everywhere?: Record<string, string> }).everywhere ?? null
  } catch {
    return null
  }
}

/** Preserve all task options when a helper asks for a task on another machine. */
function taskAddArgs(rest: string[], p: Parsed, space?: string): string[] {
  return ['task', 'add', ...rest, ...Object.entries(p.opts).flatMap(([key, values]) => (key === 'space' && space ? [space] : values).flatMap((value) => [`--${key}`, value])), ...[...p.flags].map((key) => `--${key}`)]
}
