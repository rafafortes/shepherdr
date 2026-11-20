// Chats: one chat per agent across all its sessions, read from the CLI's own log files, plus what Shepherdr itself
// posts (update cards, choice cards, plans, artifacts, merge cards) kept in its own small log per chat.
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  apart,
  cardMessage,
  type ActivityAnswer,
  type ActivityAsk,
  type Chat,
  type ChatChange,
  type ChatControls,
  type ChatDelta,
  type ChatEventDelta,
  type ChatEventFull,
  type ArtifactPost,
  type Job,
  type Message,
  type Peer,
  type Question,
  type Reaction,
  type SecretAsk,
  type UpdateCard,
} from '../../shared/types.ts'
import { HOME, readJson, writeJson } from '../store.ts'
import { stripHidden, type Agents, type OutItem } from './agents.ts'
import { agentLines, excerpt, findQuoted, fromAgents, markerSoFar, parseBrowserNotes, parseReply, parseUserLine, quietReply, userLines, type FromAgent, type Parsed } from './chatlines.ts'
import { pilotLine, wakeOf, type Woke } from './heartbeat.ts'
import { shortUrl } from '../../shared/browser.ts'
import { herdr } from './herdr.ts'
import { logKind } from './readers/find.ts'
import { LogTail, readerFor } from './readers/index.ts'
import type { LogEvent } from './readers/types.ts'
import type { Cut } from './retry.ts'
import { findModel, modelsOf, nearest } from './models.ts'
import { sameCommand } from './commands.ts'
import { sessionRuntime } from './runtime.ts'
import { launchHarness } from './restart.ts'
import { CLI_NAME } from './settings.ts'
import { replyOnScreen } from './streaming.ts'
import { activityOf, codexThreadLog, cutOutput, headlessJob, JobLogs, lastLine, lineOf, outputAt, shown as shownStep, tailOf, type JobRec } from './activity.ts'
import { menuId, parseMenu, sameScreen, type ScreenMenu } from './screen.ts'

export { menuId, menuKeys, parseMenu, type ScreenMenu } from './screen.ts'

/** a chat line of yours that shows as words: an answer, a dismissal (no answer: a line of its own, never the agent's
 *  instructions as your words), a page's Send and words about an artifact under what they answer, a note with what it
 *  is on */
function shownAs(p: Parsed): { title?: string; text: string } | undefined {
  if (p.kind === 'answer') return { title: `Answered “${p.title}”`, text: p.answer }
  if (p.kind === 'dismiss') return { title: `Dismissed “${p.title}”`, text: '' }
  if (p.kind === 'secret') return { title: 'Gave a secret', text: `${p.name}${p.where ? `, for ${p.where}` : ''}` }
  if (p.kind === 'artifact-send') return { title: `Sent from "${p.title}"`, text: p.text }
  if (p.kind === 'artifact-say') return { title: `About "${p.title}"`, text: p.text }
  if (p.kind === 'note') return { text: `[note on ${p.target}] ${p.note}` }
  return undefined
}

/** a message of the human's, hidden or not: their words (or their notes on a page, which Shepherdr hides in a tag),
 *  never only reactions and never Shepherdr's own news */
const wordsOf = (text: string) => yours(text) || /<shepherdr[^>]*>\s*<browser\b/i.test(text)

/** a line of yours the agent will answer: words of yours, not Shepherdr's hidden news and not only reactions */
const yours = (text: string) =>
  stripHidden(text)
    .split('\n')
    .some((ln) => ln.trim() && !['react', 'unreact'].includes(parseUserLine(ln.trim())?.kind ?? ''))

/** The turn the agent is in, by its log: one your message started ('yours'), one it started itself on Shepherdr's news,
 *  an automation or its background work waking it ('own', with that turn's id), or none ('over': its reply ended the
 *  last one, and what herdr still sees working is background work: a subagent, a shell). No turn marks: 'unknown'. */
export function turnOf(ev: LogEvent[], sent: { at: number }[]): { kind: 'yours' | 'own' | 'over' | 'unknown'; id?: string } {
  if (!ev.some((e) => e.kind === 'turn-start' || e.kind === 'turn-end')) return { kind: 'unknown' }
  const end = ev.findLastIndex((e) => e.kind === 'turn-end')
  // what you sent from a screen since the last turn ended went in before the CLI wrote it down: its turn is on its way
  if (sent.some((o) => o.at > (end < 0 ? -Infinity : ev[end].at))) return { kind: 'yours' }
  const now = ev.slice(end + 1)
  const start = now.find((e) => e.kind === 'turn-start')
  if (!start) return { kind: 'over' }
  // yours once a message of yours is in it, even one taken in mid-turn; another agent's message is one the agent will
  // answer just the same
  return now.some((e) => (e.kind === 'user' && yours(e.text)) || e.kind === 'peer') ? { kind: 'yours' } : { kind: 'own', id: start.id }
}

/** a reply you will see that already landed in the agent's own turn (a hidden <no-reply> is none) */
export const landed = (ev: LogEvent[]) => {
  const start = ev.findLastIndex((e) => e.kind === 'turn-start')
  return start >= 0 && ev.slice(start).some((e) => e.kind === 'agent' && agentLines(stripHidden(e.text)).text)
}

/** Autopilot's wakes in a chat, by the log line that brought each one: why it woke, and whether it answered with
 *  nothing (heartbeat.ts pilotLine). A wake is Shepherdr's hidden heartbeat in the log; its own reply fills the line in,
 *  and another message to it ends that wake's watch */
function wakeLines(ev: LogEvent[]) {
  const out = new Map<string, { at: number; line: string }>()
  let w: (Woke & { id: string; at: number }) | undefined
  const close = () => {
    if (!w) return
    out.set(w.id, { at: w.at, line: pilotLine(w) })
    w = undefined
  }
  for (const e of ev) {
    if (e.kind === 'session') close()
    else if (e.kind === 'user' || e.kind === 'peer') {
      close()
      const wake = e.kind === 'user' ? wakeOf(e.text) : undefined
      if (wake) w = { ...wake, id: e.id, at: e.at, quiet: false, said: false }
    } else if (!w || e.kind !== 'agent') continue
    else {
      const text = stripHidden(e.text)
      if (agentLines(text).text) w.said = true
      else if (quietReply(text)) w.quiet = true
    }
  }
  close()
  return out
}

/** Do the typing dots show: is a message you will see on its way? In a turn you started, at once (an agent never
 *  answers you with a hidden <no-reply>). In one it started itself, only once its reply shows: on its screen as it
 *  streams (`shown`) or landed in its log; until then it may be thinking, running tools, or about to say <no-reply>. */
export function replying(turn: ReturnType<typeof turnOf>, shown: boolean, ev: LogEvent[]): boolean {
  if (turn.kind === 'yours' || turn.kind === 'unknown') return true
  return turn.kind === 'own' && (shown || landed(ev))
}

/** what the screen showed of the reply in a turn the agent started itself */
interface Shown {
  turn: string
  /** the reply's text at the last read; it must grow once before it counts, so a still line (a job's "completed") never does */
  last?: string
  on: boolean
  at: number
}

/** something Shepherdr posted into a chat */
export interface Posted {
  id: string
  at: number
  card?: UpdateCard
  question?: Question
  artifact?: ArtifactPost
  /** a secret the agent asked for: its masked box */
  secret?: SecretAsk
  /** text shown with it, when it stands alone */
  text?: string
  /** pictures or a video an agent sends into its chat (shepherdr attach): the words above them, then each file a
   *  message of its own, exactly as the person's own attachments go */
  files?: { name: string; path: string }[]
  /** an Autopilot heartbeat skipped for having nothing to act on: its one quiet line, as a wake's own (heartbeat.ts
   *  SKIPPED_LINE), drawn by the chat the same way */
  pilot?: string
  /** a line of yours Shepherdr shows for you (an answer typed as keys, or a command, which the log doesn't keep) */
  who?: 'you'
  answered?: string
  /** answered on the question's copy in a space's chat: a link there */
  elsewhere?: Question['elsewhere']
  /** the screen's own id for it: the log's line, when it has one after all, shows instead */
  cid?: string
}

interface ChatLog {
  posted: Posted[]
  /** the choice you sent for each question, by question id */
  answers: Record<string, number>
  /** the words a question was answered with instead of a pick, by question id; chat: a message in the chat; space: on
   *  its copy in that space's chat; dismissed: closed without an answer (a Dismiss or Esc), those words the decline */
  said?: Record<string, { text?: string; chat?: true; space?: string; dismissed?: true }>
}

/** a card Shepherdr posted, with its answer: a choice card answered without a pick and no words typed on it was
 *  answered by a message in the chat (closeAsks; older logs kept no words) */
function withAnswer(q: Question, l: ChatLog, place: (key: string) => Question['elsewhere']): Question {
  const sent = q.sent ?? l.answers[q.id]
  const s = l.said?.[q.id]
  const at = s?.space ? place(s.space) : undefined
  // dismissed on its copy in a space's chat: it says so there too, never "answered"
  const elsewhere = at && s?.dismissed ? { ...at, label: 'Dismissed in' } : at
  if (sent !== -1) return { ...q, sent, elsewhere }
  return {
    ...q,
    sent,
    said: s?.text,
    via: s?.dismissed ? undefined : s?.chat || (!s && q.id.startsWith('ask:')) ? 'chat' : undefined,
    dismissed: s?.dismissed,
    elsewhere,
  }
}

const safe = (key: string) => key.replace(/[^a-zA-Z0-9_.-]+/g, '_')

/** words as typed, whatever the spacing a CLI's log keeps */
const words = (s: string) => s.replace(/\s+/g, ' ').trim()

/** the message each reply sent from a screen answers, by the words of its line: a quote alone may fit a newer message
    that starts the same way ("Done."). Kept until a restart; after one the quote finds it. */
const replied = new Map<string, string>()

export function rememberReply(line: string, id: string) {
  replied.set(words(line), id)
  if (replied.size > 500) replied.delete(replied.keys().next().value!)
}

/** the agent's reply of the same turn, written at or after `at`, before you wrote again (never past `until`) */
function hostFor(msgs: Message[], at: number, p: { question?: unknown; artifact?: unknown }, hosting: Set<Message>, until?: number): Message | undefined {
  for (const m of msgs) {
    if ((m.at ?? 0) < at - 1000) continue
    if (m.who !== 'agent' || (until !== undefined && (m.at ?? 0) >= until)) return undefined
    if (m.text && !m.card && !(p.question && m.question) && !(p.artifact && hosting.has(m))) return m
  }
  return undefined
}

/** an artifact's card in a chat, by the version posted (the latest post of it when that version's is gone) */
function artifactPost(msgs: Message[], id: string, v?: number) {
  return msgs.findLast((m) => m.artifact?.id === id && !m.text && (v === undefined || m.artifact.v === v)) ?? msgs.findLast((m) => m.artifact?.id === id && !m.text)
}

/** a reply's quote of the message it answers: that message when it is still in the chat, else the quote alone. An
 *  artifact's card is posted after the log line that quotes it, so the build resolves such a quote once cards joined. */
function replyTo(msgs: Message[], quoted: string, path?: string, line?: string, artifact?: string, later?: (() => void)[], joined = true): Message['reply'] {
  if (artifact) {
    const q: NonNullable<Message['reply']> = { text: quoted.replace(/”/g, '"'), artifact: true }
    const find = () => {
      const m = artifactPost(msgs, artifact, Number(quoted.match(/ · v(\d+)$/)?.[1]) || undefined)
      if (m) Object.assign(q, { id: m.id, who: m.who })
    }
    if (joined) find()
    else later?.push(find)
    return q
  }
  const id = line && replied.get(words(line))
  const m = (id && msgs.find((x) => x.id === id)) || findQuoted(msgs, quoted, path)
  if (!m) return { text: quoted.replace(/”/g, '"') }
  return { id: m.id, who: m.who, ...(m.peer ? { from: m.peer.name } : {}), text: m.text ? excerpt(m.text, 160) : (m.file?.name ?? ''), ...(m.text ? {} : { file: true }) }
}

/** add or take away a reaction on one message of a chat */
function addRx(m: Message | undefined, emoji: string, who: 'me' | 'them', on: boolean, pending = false) {
  if (!m) return
  const rx = (m.reactions ??= [])
  const i = rx.findIndex((x) => x.emoji === emoji)
  const cur = i >= 0 ? rx[i].by : undefined
  let next: Reaction['by'] | undefined
  if (on) next = cur && cur !== who ? 'both' : who
  else next = cur === 'both' ? (who === 'me' ? 'them' : 'me') : cur === who ? undefined : cur
  if (i >= 0) rx.splice(i, 1)
  if (next) rx.splice(i >= 0 ? i : rx.length, 0, { emoji, by: next, ...(pending ? { pending } : {}) })
}

/** the first close time strictly after `at` in a sorted list: a binary search, so a chat with many posted cards and
 *  many close lines does not scan the whole list for each card (the old `closedAt.find` was O(posted × closed)) */
export function nextClose(closedAt: number[], at: number): number | undefined {
  let lo = 0
  let hi = closedAt.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (closedAt[mid]! <= at) lo = mid + 1
    else hi = mid
  }
  return lo < closedAt.length ? closedAt[lo] : undefined
}

/** one more read of the screen: the reply counts once it grew since the last read and, past its reaction and reply
 *  lines, starts with two letters or more that aren't a hidden marker (<no-reply>, an older [[...]]), whole or still coming */
export function sawReply(s: Pick<Shown, 'last' | 'on'>, text: string | undefined): Pick<Shown, 'last' | 'on'> {
  const words = text === undefined ? '' : agentLines(text).text
  const ok = words.length >= 2 && !markerSoFar(words)
  return { on: s.on || (ok && s.last !== undefined && text !== s.last), last: ok ? text : undefined }
}

/** how much of a chat's logs one pull reads: the rest is read in the background a piece at a time, so a log of a
 *  hundred MB (a long-lived coordinator's) never holds up the server, at a restart or as it grows */
const PIECE = 2 << 20

/** how many parsed events all chats may hold before a sweep evicts the coldest ones (PERFS-07) */
const MAX_EVENTS = 100_000
/** how long a chat no one has read may keep its parsed events, even when the total is under the cap */
const EVICT_IDLE = 6 * 60 * 60_000

/** The fields of one message that moved since the last push (PERFC-03). One rebuilt object with the same contents as
 *  the last one is not a change: compare each field's JSON, not its identity. A field that went away cannot travel in
 *  a JSON patch (undefined is dropped), so the caller then sends the whole chat instead. */
function patchOf(base: Message, next: Message): Partial<Message> | null | undefined {
  const patch: Record<string, unknown> = {}
  let any = false
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    const before = (base as unknown as Record<string, unknown>)[key]
    const after = (next as unknown as Record<string, unknown>)[key]
    if (JSON.stringify(before) === JSON.stringify(after)) continue
    // null says a field went away: the caller must send the whole chat, since JSON drops undefined
    if (after === undefined || !(key in next)) return null
    patch[key] = after
    any = true
  }
  return any ? (patch as Partial<Message>) : undefined
}

/** The change between two built message arrays (PERFC-03). Messages are appended in practice; reactions, answers and
 *  waiting flags mutate rows already there. A row that went away, or a field that was removed, is sent as the whole
 *  chat instead: a delta cannot express either. New rows keep their built order; the screen re-sorts them by `at`,
 *  as chatBuild does. */
export function chatDelta(base: Message[] | undefined, next: Message[], through: number): ChatDelta | null {
  if (!base) return null
  const old = new Map(base.map((m) => [m.id, m]))
  const ids = new Set(next.map((m) => m.id))
  if (base.some((m) => !ids.has(m.id))) return null
  const added = next.filter((m) => !old.has(m.id))
  const changed: ChatChange[] = []
  for (const m of next) {
    const before = old.get(m.id)
    if (!before) continue
    const patch = patchOf(before, m)
    if (patch === null) return null
    if (patch) changed.push({ id: m.id, patch })
  }
  return { added, changed, through }
}

export class Chats {
  private tails = new Map<string, LogTail>()
  private events = new Map<string, LogEvent[]>()
  /** where each reply and usage is in its chat's events, by kind and id: a reply read in two pieces replaces the first */
  private where = new Map<string, Map<string, number>>()
  /** chats whose logs are still being read in the background */
  private reading = new Set<string>()
  /** when the operator last opened each chat, and the logs it read: the memory sweep's LRU and its rewind list */
  private lastRead = new Map<string, number>()
  private logFiles = new Map<string, string[]>()
  /** chats whose events were dropped: background pulls leave their logs alone until a chat() reads them again */
  private cold = new Set<string>()
  /** a chat's logs were read in the background to their end: what it shows changed */
  onRead?: (key: string) => void
  private logs = new Map<string, ChatLog>()
  private menus = new Map<string, ScreenMenu>()
  private menuAt = new Map<string, number>()
  private shown = new Map<string, Shown>()
  private jobLogs = new JobLogs()
  private threadLogs = new Map<string, string>()
  private jobsSeen = new Map<string, string>()
  /** latest event-log timestamp that closes open cards per chat revision, so `asks`, `openQuestion` and `needs` avoid rescanning */
  private eventCloses = new Map<string, { rev: number; len: number; lastAt: number; at: number }>()
  /** every change to Shepherdr's own log, so a post or an answer rebuilds a chat built from it */
  private logRevs = new Map<string, number>()
  /** the built messages and their close times, held until the events, the log or the menu move: the costly pass is
   *  repeated on every 'chat' emit, GET /api/chat, needs() and syncAsks otherwise */
  private chatCache = new Map<string, { sig: string; msgs: Message[]; closedAt: number[] }>()
  /** the chat last sent to screens per key, and the sequence it went out with (PERFC-03): the base the next push is
   *  diffed against. Kept here beside chatCache so a cold eviction or a rewind sends a full chat again. */
  private sentMessages = new Map<string, Message[]>()
  private chatThrough = new Map<string, number>()
  /** how many times a chat's messages were built; a test reads it to prove an unchanged chat is built once */
  chatBuilds = 0

  /** total events and idle time the sweep works to; a test lowers both */
  maxEvents = MAX_EVENTS
  idleMs = EVICT_IDLE

  constructor(
    private agents: Agents,
    private nameOf: (key: string) => string,
    private user: () => string,
    /** who a message from another agent says it is, as this machine can name it (live/source.ts: our own name for it) */
    private whoOf: (p: FromAgent) => Peer = (p) => ({ name: p.name }),
    /** the chats the screen keeps open: never evict one that is watched (live/source.ts) */
    private watched: (key: string) => boolean = () => false,
  ) {}

  /* ---------- Shepherdr's own log per chat ---------- */

  log(key: string): ChatLog {
    let l = this.logs.get(key)
    if (!l) {
      l = readJson<ChatLog>(`chatlog/${safe(key)}.json`, { posted: [], answers: {} })
      this.logs.set(key, l)
    }
    return l
  }

  saveLog(key: string) {
    writeJson(`chatlog/${safe(key)}.json`, this.log(key))
  }

  /** Shepherdr's own log changed: anything built from it must be built again */
  private touchLog(key: string) {
    this.logRevs.set(key, (this.logRevs.get(key) ?? 0) + 1)
  }

  /** a deleted task's chat: its log goes, and all that was read of it */
  forget(key: string) {
    for (const m of [
      this.tails,
      this.events,
      this.where,
      this.reading,
      this.logs,
      this.menus,
      this.menuAt,
      this.shown,
      this.revs,
      this.acts,
      this.eventCloses,
      this.logRevs,
      this.chatCache,
      this.lastRead,
      this.logFiles,
    ])
      m.delete(key)
    this.cold.delete(key)
    rmSync(join(HOME, 'chatlog', `${safe(key)}.json`), { force: true })
  }

  /** told of each new post: the chat has something new (unread.ts) */
  onPost?: (key: string) => void

  post(key: string, p: Omit<Posted, 'at'> & { at?: number }) {
    const l = this.log(key)
    const i = l.posted.findIndex((x) => x.id === p.id)
    const item = { at: Date.now(), ...p }
    if (i >= 0) l.posted[i] = { ...l.posted[i], ...item, at: l.posted[i].at }
    else l.posted.push(item)
    this.touchLog(key)
    this.saveLog(key)
    if (i < 0 && !p.who) this.onPost?.(key)
  }

  /** a page posted before artifacts: now the artifact with its id */
  repostPage(key: string, id: string) {
    const l = this.log(key)
    const p = l.posted.find((x) => x.id === `page:${id}`) as (Posted & { page?: unknown }) | undefined
    if (!p) return
    delete p.page
    p.artifact = { id, v: 1 }
    this.touchLog(key)
    this.saveLog(key)
  }

  /** other: the words typed on the card in place of a pick; space: answered on its copy in that space's chat; dismissed:
   *  closed without an answer, the words saying the person declined it */
  answer(key: string, qid: string, choice: number, other?: string, space?: string, dismissed?: true) {
    const l = this.log(key)
    l.answers[qid] = choice
    if (other || space || dismissed) (l.said ??= {})[qid] = { text: other, space, dismissed }
    this.touchLog(key)
    this.saveLog(key)
  }

  /** a reply to the agent's plain question went from its copy in a space's chat: the reply says so */
  repliedFrom(key: string, reply: string, space: string) {
    ;(this.log(key).said ??= {})[`reply:${reply}`] = { space }
    this.touchLog(key)
    this.saveLog(key)
  }

  /** where a question answered on its copy in a space's chat says it was answered, with a link there */
  answeredIn = (space: string): Question['elsewhere'] => ({ label: 'Answered in', chat: space, name: `${this.nameOf(space)} chat` })

  /** a card closed without an answer, on its copy in that space's chat */
  dismissedIn = (space: string): Question['elsewhere'] => ({ label: 'Dismissed in', chat: space, name: `${this.nameOf(space)} chat` })

  /** a message you send answers the choice cards still open in that chat: they close as answered in words (-1), and
   *  keep those words to quote */
  closeAsks(key: string, text?: string) {
    const l = this.log(key)
    const open = l.posted.filter((p) => p.question?.id.startsWith('ask:') && p.question.sent === undefined && l.answers[p.question.id] === undefined)
    if (!open.length) return false
    for (const p of open) {
      l.answers[p.question!.id] = -1
      ;(l.said ??= {})[p.question!.id] = { text: text?.trim() || undefined, chat: true }
    }
    this.touchLog(key)
    this.saveLog(key)
    return true
  }

  /* ---------- reading the CLI's logs ---------- */

  /** how many times a chat's events changed, and the turns and jobs made from them at that count: they are asked for on
   *  every pass of every watcher, and an unchanged log makes the same ones */
  private revs = new Map<string, number>()
  private acts = new Map<string, { rev: number; act: ReturnType<typeof activityOf> }>()

  private activityFor(key: string) {
    const rev = this.revs.get(key) ?? 0
    const had = this.acts.get(key)
    if (had?.rev === rev) return had.act
    const act = activityOf(this.events.get(key) ?? [])
    this.acts.set(key, { rev, act })
    return act
  }

  /** read new lines of this chat's log files, up to PIECE in all (the rest follows in the background); true when
   *  anything new came. A chat put away by the sweep waits for a chat() to bring its history back: the periodic
   *  passes must not reread hundreds of logs just because their events were dropped */
  pull(key: string, force = false): boolean {
    if (this.cold.has(key)) {
      // an agent that started again, or a chat the screen watches again, must read its log and rebuild: otherwise
      // everything that pulls for it (pollChats, needs, questions) would keep seeing an empty history
      const r = this.agents.record(key)
      if (force || this.watched(key) || (r && !r.finished)) this.cold.delete(key)
      else return false
    }
    const { changed, behind } = this.read(key)
    if (behind) this.readOn(key)
    return changed
  }

  /** put a chat's events away and have its logs read again from their start: a log was replaced under the reader, so what it
   *  said must not join what it said before */
  private startOver(key: string, logs: string[]) {
    this.events.delete(key)
    this.where.delete(key)
    this.acts.delete(key)
    // the revision grows, so a chat built before is built again from the events read now
    this.revs.set(key, (this.revs.get(key) ?? 0) + 1)
    for (const f of logs) this.tails.delete(f)
  }

  /** read a chat's logs on: when one was read again from its start under us, the chat's events are put away and the logs are
   *  read again from their start, in the same pass (each turn of the loop costs a log actually replaced under the reader) */
  private read(key: string): { changed: boolean; behind: boolean } {
    for (;;) {
      const out = this.readOnce(key)
      if (out !== 'again') return out
    }
  }

  private readOnce(key: string): { changed: boolean; behind: boolean } | 'again' {
    const r = this.agents.record(key)
    if (!r) return { changed: false, behind: false }
    this.logFiles.set(key, r.logs)
    let changed = false
    let behind = false
    let left = PIECE
    const all = this.events.get(key) ?? []
    const where = this.where.get(key) ?? new Map<string, number>()
    for (const f of r.logs) {
      if (!existsSync(f)) continue
      let t = this.tails.get(f)
      if (!t) {
        // each by its own CLI's reader: a backup agent's logs follow the first one's
        const reader = readerFor(logKind(f) ?? r.kind)
        if (!reader) continue
        t = new LogTail(f, reader)
        this.tails.set(f, t)
      }
      const was = t.done
      const starts = t.restarts
      const ev = t.read(left)
      // read from its start again under us (agy's and OpenCode's logs are copies of a store, which a newer Shepherdr writes
      // again whole; a log cut or replaced): the chat is built again from its start, never with what it said twice
      if (t.restarts !== starts) {
        this.startOver(key, r.logs)
        return 'again'
      }
      left -= Math.max(0, t.done - was)
      for (const e of ev) {
        // a reply read in two pieces comes again with the same id and the full text: it replaces the first
        const id = e.kind === 'agent' || e.kind === 'usage' ? `${e.kind}:${e.id}` : undefined
        const i = id === undefined ? undefined : where.get(id)
        if (i !== undefined) all[i] = e
        else {
          if (id !== undefined) where.set(id, all.length)
          all.push(e)
        }
        changed = true
      }
      // the next log once this one is read to its end: the chat keeps its order
      if ((behind = t.behind || left <= 0)) break
    }
    if (changed) {
      this.events.set(key, all)
      this.where.set(key, where)
      this.revs.set(key, (this.revs.get(key) ?? 0) + 1)
      // the first load starts the idle window: a chat pulled a moment ago is not one nobody read for hours
      if (!this.lastRead.has(key)) this.lastRead.set(key, Date.now())
    }
    return { changed, behind }
  }

  /** reads the rest of a chat's logs a piece at a time, letting the server answer between pieces; told once at the end */
  private readOn(key: string) {
    if (this.reading.has(key)) return
    this.reading.add(key)
    const step = () => {
      if (!this.reading.has(key)) return
      if (this.read(key).behind) return void setTimeout(step, 0)
      this.reading.delete(key)
      this.onRead?.(key)
    }
    setTimeout(step, 0)
  }

  /* ---------- keeping the parsed history bounded (PERFS-07) ---------- */

  /** the operator opened this chat (a GET /api/chat or a 'chat' emit through source.chat): keep its events through
   *  a sweep, and let a chat put away earlier rebuild its history now */
  seen(key: string) {
    this.lastRead.set(key, Date.now())
    this.cold.delete(key)
  }

  /** the events held for each chat and their estimated bytes, biggest holder first: the audit's measure */
  memory(): { events: number; bytes: number; holders: { key: string; events: number; bytes: number }[] } {
    const holders = [...this.events].map(([key, ev]) => ({ key, events: ev.length, bytes: JSON.stringify(ev).length }))
    holders.sort((a, b) => b.bytes - a.bytes)
    return { events: holders.reduce((n, h) => n + h.events, 0), bytes: holders.reduce((n, h) => n + h.bytes, 0), holders }
  }

  /** put the parsed history of idle chats away, oldest read first, until none is idle or the total is under the cap.
   *  Returns what it dropped and what is left; the next chat() reads a dropped chat's logs from their start again */
  sweep(): { evicted: number; events: number } {
    const keys = [...this.events.keys()].filter((key) => this.canEvict(key)).sort((a, b) => (this.lastRead.get(a) ?? 0) - (this.lastRead.get(b) ?? 0))
    let events = 0
    for (const ev of this.events.values()) events += ev.length
    let evicted = 0
    for (const key of keys) {
      const n = this.events.get(key)?.length ?? 0
      if (n === 0) continue
      if (Date.now() - (this.lastRead.get(key) ?? 0) < this.idleMs && events <= this.maxEvents) break
      this.evict(key)
      events -= n
      evicted++
    }
    return { evicted, events }
  }

  /** a chat whose events may be put away: not watched or being read, no live agent, nothing waiting on you */
  private canEvict(key: string): boolean {
    if (this.watched(key) || this.reading.has(key)) return false
    const st = this.agents.status(key)
    if (st === 'working' || st === 'blocked') return false
    const r = this.agents.record(key)
    if (r && !r.finished) return false
    if (this.menus.has(key) || this.startScreens.has(key) || this.commandMenus.has(key)) return false
    if (this.logs.has(key) && this.openPostedCached(key)) return false
    return !this.openQuestionCached(key)
  }

  /** drop the events and their indexes, rewind the logs so a chat() rebuilds the whole history, and leave the chat
   *  cold for background pulls: a sweep must not spend the next pass rereading the logs it just put away */
  private evict(key: string) {
    const logs = this.agents.record(key)?.logs ?? this.logFiles.get(key) ?? []
    for (const m of [this.events, this.where, this.acts, this.eventCloses, this.chatCache, this.sentMessages]) m.delete(key)
    this.revs.set(key, (this.revs.get(key) ?? 0) + 1)
    for (const f of logs) this.tails.get(f)?.restart()
    this.cold.add(key)
  }

  /** tokens this chat's agent has used, across all its sessions */
  tokens(key: string): number {
    this.pull(key)
    return (this.events.get(key) ?? []).reduce((n, e) => n + (e.kind === 'usage' ? e.tokens : 0), 0)
  }

  /** what the agent last said, plain */
  lastReply(key: string): string | undefined {
    this.pull(key)
    const ev = this.events.get(key) ?? []
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i]
      if (e.kind === 'agent') return agentLines(stripHidden(e.text)).text
    }
    return undefined
  }

  /** the newest thing in the chat from its agent (a reply you will see, its question) or Shepherdr (a card, an
   *  artifact): when it came, its words, and whether it is a card about a task (whose own alert tells of it) */
  newest(key: string): { at: number; text?: string; card?: boolean } | undefined {
    this.pull(key)
    const ev = this.events.get(key) ?? []
    const e = ev.findLast((x) => (x.kind === 'agent' && agentLines(stripHidden(x.text)).text) || x.kind === 'question')
    const p = this.log(key).posted.findLast((x) => !x.who && !x.pilot)
    const reply = e && { at: e.at, text: e.kind === 'agent' ? agentLines(stripHidden(e.text)).text : undefined }
    const posted = p && { at: p.at, text: p.card?.text ?? p.text ?? p.question?.title, card: !!p.card }
    return !reply || (posted && posted.at > reply.at) ? posted : reply
  }

  /** in a turn the agent started itself, has its reply begun on its screen, not as a hidden <no-reply> (or older [[...]])? Read about
   *  once a second, until it has; true when that changes what the chat shows */
  async readReply(key: string): Promise<boolean> {
    const r = this.agents.record(key)
    const turn = turnOf(this.events.get(key) ?? [], this.agents.sentLately(key))
    if (!r || this.agents.status(key) !== 'working' || turn.kind !== 'own') {
      const had = this.shown.get(key)?.on ?? false
      this.shown.delete(key)
      return had
    }
    const was = this.shown.get(key)
    const s: Shown = was && was.turn === turn.id ? was : { turn: turn.id!, on: false, at: 0 }
    this.shown.set(key, s)
    // a little under the poll's second, so a late tick never skips a read
    if (s.on || Date.now() - s.at < 900) return false
    s.at = Date.now()
    const info = this.agents.info(key)
    if (!info) return false
    Object.assign(s, sawReply(s, replyOnScreen(r.kind, await herdr.visible(info.pane_id).catch(() => ''))))
    return s.on
  }

  /** A blocked agent's terminal menu, one a slash command opened, or the startup screen a start stopped on, read from
   *  its screen (refreshed at most every 2s). */
  async readMenu(key: string, force = false): Promise<boolean> {
    const st = this.agents.status(key)
    const starting = this.startScreens.has(key)
    if (!force && (st === 'working' || st === 'gone') && !this.commandMenus.has(key)) {
      const had = this.menus.delete(key)
      this.startScreens.delete(key)
      return had
    }
    const last = this.menuAt.get(key) ?? 0
    if (!force && Date.now() - last < 2000) return false
    this.menuAt.set(key, Date.now())
    const info = this.agents.info(key)
    if (!info) return false
    const text = await herdr.visible(info.pane_id)
    // Some herdr versions call startup checkbox menus idle. Require a live menu footer before parsing those.
    const waiting = /(?:enter.*(?:confirm|select|continue)|space to select.*esc to reject|\[y\/n\]|\(y\/n\))/i.test(text.trimEnd().split('\n').slice(-3).join('\n'))
    const parsed = st === 'blocked' || this.commandMenus.has(key) || starting || waiting ? parseMenu(text) : null
    let m: ScreenMenu | null = parsed ? { ...parsed, screen: parsed.screen ?? text.trim(), all: text } : null
    // a startup screen it read no choices in is still the same card while it rests: its words, and Open terminal
    const was = this.menus.get(key)
    if (!m && starting && was?.screen && sameScreen(was.screen, text)) m = was
    if (!m && st === 'blocked' && text.trim()) m = { title: 'The terminal is waiting for you', choices: [], cursor: 0, screen: text.trim(), all: text }
    const before = JSON.stringify(this.menus.get(key) ?? null)
    if (m) this.menus.set(key, m)
    else {
      this.menus.delete(key)
      // the startup screen moved on (or went): the card with it, and the next screen is read as a card of its own
      this.startScreens.delete(key)
    }
    // the command's menu is answered: what you wrote meanwhile goes in
    if (!m && this.commandMenus.delete(key)) void this.agents.deliver(key)
    return before !== JSON.stringify(this.menus.get(key) ?? null)
  }

  /** menus a slash command opened that herdr doesn't see as blocking the agent: shown as a card all the same, and what
   *  you write waits for them like for any menu */
  private commandMenus = new Set<string>()

  /** starts that stopped on a screen of their own (start.ts): their screen is a card like a menu's, and the task waits on
   *  you until it moves on */
  private startScreens = new Set<string>()

  /** a slash command opened a menu: read it as a card; true when there is one */
  async commandMenu(key: string) {
    this.commandMenus.add(key)
    await this.readMenu(key, true).catch(() => false)
    if (!this.menus.has(key)) this.commandMenus.delete(key)
    return this.menus.has(key)
  }

  /** a start stopped on a screen of its own: what it shows is a card, from now on read as one whenever it is read
   *  again (its words alone, with no choices, still a card: Open terminal is the way on); true when it changed */
  showStartMenu(key: string, menu: ScreenMenu): boolean {
    this.startScreens.add(key)
    const had = this.menus.get(key)
    // the same card, though a spinner or a timer on it moved: nothing changed for the human
    if (had && menuId(key, had) === menuId(key, menu)) return false
    this.menus.set(key, menu)
    return true
  }

  /** its screen moved on and nothing there is a card any more (its brief went in after all); true when one was up */
  clearStartMenu(key: string) {
    const had = this.startScreens.delete(key)
    if (had) this.menus.delete(key)
    return had
  }

  /** a card of a start stopped on its screen is up: the task waits on you for it */
  startMenuUp(key: string) {
    return this.startScreens.has(key) && this.menus.has(key)
  }

  /** a menu a slash command opened is up */
  commandMenuUp(key: string) {
    return this.commandMenus.has(key) && this.menus.has(key)
  }

  menu(key: string) {
    return this.menus.get(key)
  }

  /** latest timestamp in the CLI's log of a message that closes open cards (human words or another agent's relay),
   *  cached per log revision and event tail so repeated checks never rescan thousands of events */
  private lastEventClose(key: string): number {
    const ev = this.events.get(key) ?? []
    const rev = this.revs.get(key) ?? 0
    const len = ev.length
    const lastAt = len ? ev[len - 1]!.at : 0
    const had = this.eventCloses.get(key)
    if (had && had.rev === rev && had.len === len && had.lastAt === lastAt) return had.at
    let at = 0
    for (const e of ev) {
      if ((e.kind === 'peer' || (e.kind === 'user' && wordsOf(e.text))) && e.at > at) at = e.at
    }
    this.eventCloses.set(key, { rev, len, lastAt, at })
    return at
  }

  /** latest closing timestamp across both the CLI's log and Shepherdr's own `you` posts */
  private lastClose(key: string): number {
    let since = this.lastEventClose(key)
    for (const p of this.log(key).posted) if (p.who === 'you' && p.at > since) since = p.at
    return since
  }

  /** true while background chunks of this chat's log are still being read */
  isReading(key: string): boolean {
    return this.reading.has(key)
  }

  /** the question the CLI asks with its own tool, still open: nothing reached the agent after it */
  openQuestion(key: string): { id: string; at: number; items: { question: string; options: { label: string }[]; multiSelect: boolean }[] } | undefined {
    this.pull(key)
    return this.openQuestionCached(key)
  }

  /** the same question from the events already read, without pulling the logs: the sweep asks this of many chats */
  private openQuestionCached(key: string): { id: string; at: number; items: { question: string; options: { label: string }[]; multiSelect: boolean }[] } | undefined {
    const ev = this.events.get(key) ?? []
    const closeAt = this.lastEventClose(key)
    let answered: Set<string> | undefined
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i]
      // a message that carries the human's words reached it after the question (typed as its answer, their notes on a
      // page, another agent's relay): as far as this chat knows, that question is answered, whatever its tool result says.
      // Shepherdr's own hidden news is no answer, though it arrives as a line of the human's
      if (e.kind !== 'question' || e.at < closeAt) continue
      answered ??= new Set(ev.filter((x) => x.kind === 'answered').map((x) => x.id))
      if (answered.has(e.id)) continue
      return { id: e.id, at: e.at, items: e.items }
    }
    return undefined
  }

  /** a plan or choice card the agent posted since you last wrote to it, still unanswered */
  openCard(key: string): 'plan' | 'ask' | undefined {
    const id = this.openPosted(key)?.question?.id
    return id?.startsWith('plan:') ? 'plan' : id?.startsWith('ask:') ? 'ask' : undefined
  }

  /** that card's question, as the agent wrote it */
  openCardTitle(key: string): string | undefined {
    return this.openPosted(key)?.question?.title
  }

  /** the coordinator's open `ask:` card, read from the raw log and events so `asks()` can use the one card-closing rule
   *  without building the screen chat — `chat()` asks for the chat's name, which calls `asks()` back */
  openAskId(key: string): string | undefined {
    const id = this.openPosted(key)?.question?.id
    return id?.startsWith('ask:') ? id : undefined
  }

  /** a needs-you card or question, with when it was asked: the one it waits on now, if any */
  askAt(key: string): number | undefined {
    const posted = this.openPosted(key)
    if (posted) return posted.at
    return this.openQuestion(key)?.at
  }
  /** whether what it waits on now was asked in the turn running: one asked before this turn began no longer makes a
   *  working agent wait on you (the turn's start and end are in its log; with no turn marks at all, what it asks stands) */
  asksInTurn(key: string): boolean {
    const at = this.askAt(key)
    if (at === undefined) return false
    this.pull(key)
    const ev = this.events.get(key) ?? []
    const start = ev.findLastIndex((e) => e.kind === 'turn-start')
    if (start < 0) return true
    if (ev.findLastIndex((e) => e.kind === 'turn-end') > start) return false
    return at >= ev[start].at
  }

  /** the posted card it waits on now, with when it was posted */
  private openPosted(key: string): Posted | undefined {
    this.pull(key)
    return this.openPostedCached(key)
  }

  /** the same card from the log already loaded, without pulling the logs: the sweep asks this of many chats */
  private openPostedCached(key: string): Posted | undefined {
    const l = this.log(key)
    // the one rule for a card and a CLI's own question alike (openQuestion): the human's words after it, hidden notes
    // included but never Shepherdr's own hidden news, or another agent's relay the agent takes as its prompt. Anything
    // else that reached it (the agent's own words, another card's answer, Shepherdr's news) leaves it waiting.
    const since = this.lastClose(key)
    for (let i = l.posted.length - 1; i >= 0; i--) {
      const p = l.posted[i]
      const q = p.question
      if (p.at <= since) continue
      if (!q || q.sent !== undefined || l.answers[q.id] !== undefined) continue
      if (q.id.startsWith('plan:') || q.id.startsWith('ask:')) return p
    }
    return undefined
  }

  /**
   * The open question cards, from the raw log and events without building the whole screen chat. What Needs you, its
   * alert command and the doctor read every few seconds: on a busy home a full `chat()` builds hundreds of messages,
   * replies, activity and jobs for each of a dozen chats and held the loop for seconds (`tellWaits` in stall.ts).
   * The card list is the same one `openCards(chat())` gives: cards the log or events carry, still unanswered and with no
   * word of yours (or another agent's) after them — a card posted with no words rides the first free agent reply of its
   * turn and closes as of it, exactly as the screen's rows do (`hostAt` here walks the same log rows `hostFor` does:
   * an agent row only when chat() shows one, a card's own words, rows that already ask, hosts taken in posted order); a
   * terminal menu where there is no CLI question. The residue: a logged command matched to the log's own line can move
   * a row of yours a moment earlier than its post, so a card between the two can close here a tick sooner than the
   * screen closes it. The screen still calls `chat()` for the chat the person looks at, so nothing there changes.
   */
  openCardsQuick(key: string): (Message & { question: Question })[] {
    this.pull(key)
    const ev = this.events.get(key) ?? []
    const l = this.log(key)
    // the same closure times chat() carries in Chat.closedAt — lastClose is cached per log revision, so repeated looks
    // never rescan thousands of events: hidden notes and app answers are no visible rows
    const lastClose = this.lastClose(key)
    const closed = (at: number) => at < lastClose
    // a text-less posted card rides the agent reply of its turn (chat(): hostFor): only then are the raw rows needed
    const riders = l.posted.some((p) => p.question && !p.text && !p.card?.aside && !p.card?.id.startsWith('advice-note:'))
    // the raw rows hostFor walks in chat(): the agent's words (a row only when chat() shows one: agentLines of the
    // stripped text, and a card's own words), the rows that already ask (a CLI question, or the reply a card posted
    // before this one rides — a card's own question never reaches its row there), and the lines of yours or another
    // agent's that break its search
    const rows = riders
      ? [
          ...l.posted
            .filter((p) => !p.files?.length)
            .map((p) => ({ at: p.at, agent: p.who !== 'you', text: p.who !== 'you' ? (p.card ? (cardMessage(p.card, p.at).text ?? '') : (p.text ?? '')) : '', asks: !!p.question && !p.card })),
          ...ev
            .filter((e) => e.kind === 'agent' || e.kind === 'peer' || e.kind === 'question' || (e.kind === 'user' && yours(e.text)))
            .map((e) => ({ at: e.at, agent: e.kind === 'agent' || e.kind === 'question', text: e.kind === 'agent' ? (agentLines(stripHidden(e.text)).text ?? '') : '', asks: e.kind === 'question' })),
        ].sort((a, b) => a.at - b.at)
      : []
    // the closure times themselves, for the `until` that cuts a host search at the first thing that answers
    const closedAt = riders
      ? [...ev.filter((e) => e.kind === 'peer' || (e.kind === 'user' && wordsOf(e.text))).map((e) => e.at), ...l.posted.filter((p) => p.who === 'you').map((p) => p.at)].sort((a, b) => a - b)
      : []
    const taken = new Set<number>()
    const hostAt = (at: number, until: number | undefined) => {
      for (const r of rows) {
        if (r.at < at - 1000) continue
        if (until !== undefined && r.at >= until) return undefined
        if (!r.agent) return undefined
        if (r.asks || taken.has(r.at)) continue
        if (r.text) {
          taken.add(r.at)
          return r.at
        }
      }
      return undefined
    }
    const out: (Message & { question: Question })[] = []
    let answered: Set<string> | undefined
    const questions = ev.filter((e): e is Extract<LogEvent, { kind: 'question' }> => e.kind === 'question')
    for (const e of ev) if (e.kind === 'answered') (answered ??= new Set<string>()).add(e.id)
    for (const e of questions) {
      e.items.forEach((it, i) => {
        const qid = e.items.length > 1 ? `${e.id}:${i}` : e.id
        // a picked or terminal-answered question is not open in the screen's chat either (its `sent` is set there)
        if (l.answers[qid] !== undefined || answered?.has(e.id) || closed(e.at + i)) return
        out.push({
          id: `${e.id}#${i}`,
          who: 'agent',
          at: e.at + i,
          question: { id: qid, title: it.question, kind: 'Question', choices: it.options, multi: it.multiSelect, other: it.allowCustom, to: this.nameOf(key) },
        })
      })
    }
    for (const p of l.posted) {
      if (!p.question) continue
      // the same two skips openCards gives a note beside the questions and an advisor's own note
      if (p.card?.aside || p.card?.id.startsWith('advice-note:')) continue
      const q = withAnswer(p.question, l, this.answeredIn)
      // no words of its own: it rides the first free agent reply of its turn (chat(): hostFor) and takes that row,
      // answered or not, exactly as chat() takes it — a card posted next within that second must not land on it
      const at = p.text ? p.at : (hostAt(p.at, nextClose(closedAt, p.at)) ?? p.at)
      if (q.sent !== undefined || closed(at)) continue
      out.push({ ...p, who: 'agent', at, question: q })
    }
    const menu = this.menus.get(key)
    if (menu && !this.openQuestion(key)) {
      const id = menuId(key, menu)
      const kind = this.agents.record(key)?.kind ?? 'claude'
      out.push({
        id,
        who: 'agent',
        at: Date.now(),
        question: {
          id,
          title: menu.title,
          screen: menu.screen,
          terminal: true,
          noNote: true,
          multi: menu.multi,
          reject: menu.reject,
          kind: 'Form',
          choices: menu.choices.map((label, i) => ({ label, description: menu.descriptions?.[i] })),
          to: this.nameOf(key),
          asks: `${CLI_NAME[kind] ?? kind} asks`,
          noDismiss: this.startScreens.has(key) || !menu.choices.length || undefined,
        },
      })
    }
    return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  }

  /** what cut off the agent's last turn (its provider failed), when nothing began since; never one from before it last
   *  started (started again, or a backup agent that took over, whose own log has nothing yet) */
  cutOff(key: string): Cut | undefined {
    this.pull(key)
    const ev = this.events.get(key) ?? []
    const e = ev.findLast((e) => e.kind === 'error' || e.kind === 'turn-start' || e.kind === 'user')
    if (e?.kind !== 'error' || e.at < (this.agents.record(key)?.started ?? 0)) return undefined
    return { id: e.id, at: e.at, text: e.text, code: e.code, status: e.status, ...(e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}) }
  }

  /** its log shows a turn that ended after this time */
  endedSince(key: string, at: number): boolean {
    this.pull(key)
    return (this.events.get(key) ?? []).some((e) => e.kind === 'turn-end' && e.at > at)
  }

  /** its log shows a turn since this time: a start became an agent at work, whatever its screen says */
  begunSince(key: string, at: number): boolean {
    this.pull(key)
    return (this.events.get(key) ?? []).some((e) => e.at >= at && (e.kind === 'turn-start' || e.kind === 'user' || e.kind === 'peer' || e.kind === 'agent' || e.kind === 'turn-end'))
  }

  /**
   * What you or a coordinator wrote to this agent that it hasn't read yet: still waiting to go in, or typed in since its
   * turn began and not in its log since (Claude Code takes text typed mid-turn at its next step). Reactions and
   * Shepherdr's own hidden lines aside.
   */
  unseen(key: string): OutItem[] {
    this.pull(key)
    const ev = this.events.get(key) ?? []
    const start = ev.findLast((e) => e.kind === 'turn-start')?.at ?? 0
    // the same words (a long paste may be kept as "[Pasted text #1]"), in its log since about when they went in
    const flat = (t: string) => stripHidden(t).replace(/\s+/g, ' ').trim()
    const same = (a: string, b: string) => a.startsWith(b.slice(0, 40)) || b.startsWith(a.slice(0, 40)) || /\[Pasted text #\d/.test(a)
    const read = (o: OutItem) => ev.some((e) => e.kind === 'user' && e.at >= o.at - 5000 && same(flat(e.text), flat(o.text)))
    const mine = (o: OutItem) => !o.reaction && yours(o.text)
    return [...this.agents.waiting(key).filter(mine), ...this.agents.typedSince(key, start).filter((o) => mine(o) && !read(o))]
  }

  /**
   * What its CLI still holds in its own queue, by the id the screen gave each: what you sent since its turn began and
   * its log hasn't taken yet (Claude Code reads those at its next step, or now with its own Ctrl+Enter). Only while it
   * works: a turn over means what it queued goes in on its own.
   */
  inQueue(key: string): string[] {
    if (this.agents.status(key) !== 'working') return []
    const holding = new Set(this.agents.waiting(key).map((o) => o.cid))
    return this.unseen(key).flatMap((o) => (o.cid && !holding.has(o.cid) ? [o.cid] : []))
  }

  /* ---------- what it does: its steps, and its work in the background ---------- */

  /**
   * What it started in the background that still runs, each with what it does now: what its log started and didn't
   * say is over, and the headless agents it runs. Nothing once it is gone; with Claude Code, nothing once its turn is
   * over and its session says nothing runs (a log may miss an end).
   */
  jobs(key: string, act = this.activityFor(key)): JobRec[] {
    const st = this.agents.status(key)
    if (st === 'gone') return []
    const r = this.agents.record(key)
    let list = act.jobs.map((j) => ({ ...j }))
    if (r?.kind === 'claude' && st !== 'working' && st !== 'blocked' && !this.agents.stillRuns(key)) list = []
    const heads = this.agents.procs.list(key).map((h) => headlessJob(h, r?.logs ?? []))
    // a headless agent run as a background shell is the agent, once
    if (heads.length) list = list.filter((j) => j.kind !== 'shell' || !/\b(codex (exec|e)|(claude|pi)\b.* (-p|--print))\b/.test(j.title))
    list.push(...heads)
    for (const j of list) {
      if (j.kind === 'agent' && !j.log && r?.kind === 'codex') {
        const f = this.threadLogs.get(j.id) ?? codexThreadLog(j.id)
        if (f) this.threadLogs.set(j.id, (j.log = f))
      }
      if (j.log) j.more = 'steps'
      j.now = j.log ? this.jobLogs.now(j.log) : j.output ? lastLine(j.output) : undefined
    }
    return list
  }

  /** what runs in the background changed since it was last asked (a pass of the watched chats): a job came or went,
   *  or one does something else now */
  jobsChanged(key: string): boolean {
    this.pull(key)
    const sig = JSON.stringify(this.jobs(key).map((j) => [j.id, j.now]))
    if (this.jobsSeen.get(key) === sig) return false
    this.jobsSeen.set(key, sig)
    return true
  }

  /** what the screen opens: a turn's steps, a step's raw output, a background job's own steps or output */
  activity(a: ActivityAsk): ActivityAnswer {
    this.pull(a.chat)
    const act = this.activityFor(a.chat)
    const turns = [...act.turns, ...(act.open ? [act.open] : [])]
    if (a.what === 'turn') {
      const t = turns.find((x) => x.id === a.id)
      if (!t) return { error: 'That turn is no longer in its log.' }
      return { steps: t.steps.slice(-300).map(shownStep), more: t.steps.length > 300 ? t.steps.length - 300 : undefined }
    }
    if (a.what === 'output') {
      const s = turns.flatMap((t) => t.steps).find((x) => x.id === a.id)
      const out = s?.where && outputAt(s.where, s.id)
      return out === undefined || out === '' ? { error: s?.where ? 'It printed nothing.' : 'Its output is not in its log.' } : cutOutput(out)
    }
    const j = this.jobs(a.chat, act).find((x) => x.id === a.id)
    if (!j) return { error: 'That is over now.' }
    if (j.log) return this.jobLogs.steps(j.log)
    const tail = j.output && tailOf(j.output)
    return tail === undefined || tail === '' ? { error: 'Nothing to show for it yet.' } : cutOutput(tail)
  }

  /* ---------- the chat as the screen draws it ---------- */

  /** a message from another agent as the chat draws it (one per envelope: a task told twice while it was held heard two),
   *  naming the sender it declared and nothing this machine vouches for */
  private peerRows(msgs: Message[], id: string, at: number, froms: FromAgent[], newSession?: boolean, more: Partial<Message> = {}) {
    // an envelope with nothing in it is no message: a row with a sender and no words says nothing
    const said = froms.filter((f) => f.text)
    said.forEach((f, i) => {
      const mid = said.length === 1 ? id : `${id}:peer${i}`
      msgs.push({ id: mid, who: 'peer', at, text: f.text, peer: this.whoOf(f), newSession: !i && newSession ? true : undefined, ...more })
    })
  }

  /** what the built messages depend on: any of these moving makes the next chat() build them again. The event count
   *  and last time are there as well as the revision, so a log changed behind the reader's back cannot serve a stale
   *  build; the rest are the log's own changes, the menu, the agent's name and what a screen sent with an id. */
  private chatSig(key: string, from: string, user: string): string {
    const ev = this.events.get(key) ?? []
    const menu = this.menus.get(key)
    return [
      this.revs.get(key) ?? 0,
      ev.length,
      ev.length ? ev[ev.length - 1]!.at : 0,
      this.logRevs.get(key) ?? 0,
      from,
      user,
      menu ? menuId(key, menu) : '',
      this.startScreens.has(key) ? 1 : 0,
      this.agents.sentLately(key).length,
    ].join('|')
  }

  chat(key: string): Chat {
    // showing a chat again rebuilds the history the sweep put away, from its logs read from the start
    this.cold.delete(key)
    this.pull(key, true)
    const r = this.agents.record(key)
    const kind = r?.kind ?? 'claude'
    const user = this.user()
    const from = this.nameOf(key)
    const ev = this.events.get(key) ?? []
    const l = this.log(key)
    const { msgs: built, closedAt } = this.chatBuild(key, from, user)
    // the queue, a menu and a reply linked from a space change without the built log: they go on a copy of the array,
    // and a message a decoration touches is copied first, so what chatBuild cached stays the same for the next reader
    const msgs = built.slice()
    // what waits to go in, and why: the first in line holds the rest
    const queue = this.agents.waiting(key)
    const waitsFor = queue.length ? this.agents.holdOf(key, queue[0]) : undefined
    for (const o of queue) {
      if (o.reaction) {
        const i = msgs.findIndex((x) => x.id === o.reaction!.message)
        if (i >= 0) {
          const m = { ...msgs[i]!, reactions: [...(msgs[i]!.reactions ?? [])] }
          msgs[i] = m
          addRx(m, o.reaction.emoji, 'me', parseUserLine(o.text)?.kind !== 'unreact', true)
        }
      } else {
        // a message from another agent waiting to go in says who sent it here too, exactly as it will in the log
        const froms = fromAgents(stripHidden(o.text))
        if (froms.length) {
          this.peerRows(msgs, o.id, o.at, froms, undefined, { waiting: true, waitsFor })
          continue
        }
        const files: { name: string; path: string }[] = []
        const pr = parseReply(o.text)
        const reply = pr ? replyTo(msgs, pr.to, undefined, pr.line, pr.artifact) : undefined
        let answered: string | undefined
        const text = stripHidden(
          (pr ? [...userLines(pr.text), ...pr.rest] : userLines(o.text))
            .flatMap((ln) => {
              const p = parseUserLine(ln)
              if (p?.kind === 'attach') files.push({ name: p.name, path: p.path })
              const s = p && shownAs(p)
              if (s?.title) answered = s.title
              return p?.kind === 'attach' ? [] : [s ? s.text : ln]
            })
            .join('\n'),
        )
        // what Shepherdr itself sends (instructions, news) never shows as yours
        if (text || answered) msgs.push({ id: o.id, who: 'you', at: o.at, text: text || undefined, answered, waiting: true, waitsFor, cid: o.cid, reply })
        files.forEach((file, i) => msgs.push({ id: `${o.id}:${i}`, who: 'you', at: o.at, file, waiting: true, waitsFor, cid: o.cid, reply: !i && !text ? reply : undefined }))
      }
    }
    // your reply to a plain question, sent from its copy in a space's chat: a link there
    for (const [id, s] of Object.entries(l.said ?? {}))
      if (id.startsWith('reply:') && s.space) {
        const i = msgs.findIndex((x) => x.who === 'you' && x.reply?.id === id.slice('reply:'.length))
        if (i >= 0) {
          const m = { ...msgs[i]! }
          msgs[i] = m
          Object.assign(m, { answered: m.answered ?? 'Answered', elsewhere: this.answeredIn(s.space) })
        }
      }
    // a menu in the terminal shows as a question card, posted by Shepherdr
    const menu = this.menus.get(key)
    if (menu && !this.openQuestion(key)) {
      const waitingAt = msgs.findIndex((m) => m.waiting)
      const card: Message = {
        id: menuId(key, menu),
        who: 'agent',
        at: Date.now(),
        question: {
          id: menuId(key, menu),
          title: menu.title,
          screen: menu.screen,
          terminal: true,
          noNote: true,
          multi: menu.multi,
          reject: menu.reject,
          kind: 'Form',
          choices: menu.choices.map((label, i) => ({ label, description: menu.descriptions?.[i] })),
          to: from,
          asks: `${CLI_NAME[kind] ?? kind} asks`,
          noDismiss: this.startScreens.has(key) || !menu.choices.length || undefined,
        },
      }
      if (waitingAt >= 0) msgs.splice(waitingAt, 0, card)
      else msgs.push(card)
    }
    const st = this.agents.status(key)
    const queued = this.inQueue(key)
    const failed = this.agents.failedLately(key)
    const active = this.agents.info(key)?.agent_session
    const file =
      active?.kind === 'path' ? r?.logs.find((f) => f.endsWith('/' + active.value.split('/').at(-1))) : r?.sessionId ? r.logs.find((f) => f.endsWith(`${r.sessionId}.jsonl`)) : r?.logs.at(-1)
    let runtime = sessionRuntime(ev, file, r?.started ?? 0)
    if (st !== 'working' || !runtime) runtime = this.agents.runtime(key) ?? runtime
    const hook = this.agents.runtimeHook(key)
    if (hook)
      runtime =
        !runtime || hook.at >= runtime.at
          ? { ...(hook.model && runtime?.model && hook.model !== runtime.model ? {} : runtime), ...hook, source: 'hook' }
          : { ...(hook.model && runtime.model && hook.model !== runtime.model ? {} : hook), ...runtime }
    if (runtime?.model) runtime.modelLabel = findModel(kind, runtime.model)?.label
    const act = this.activityFor(key)
    const jobs = this.jobs(key, act).map(({ log: _l, output: _o, ...j }): Job => j)
    // the queue and the menu card are added after chatBuild's sort; sort the final array too, so the full chat and
    // a delta applied by the screen (which re-sorts by `at`) always come out in the same order (PERFC-03)
    msgs.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    return {
      key,
      cli: CLI_NAME[kind] ?? kind,
      agent: r
        ? { runtime, ...launchHarness({ kind: r.kind, model: r.model, effort: r.effort }), ...(findModel(r.kind, r.model) ? { modelLabel: findModel(r.kind, r.model)!.label } : {}) }
        : undefined,
      messages: msgs,
      closedAt,
      failed: failed.length ? failed : undefined,
      unreadable: this.agents.unreadable?.(key),
      working: st === 'working' || undefined,
      queued: queued.length ? queued : undefined,
      // its turn is over, or ended while work it started still runs: a subagent, a shell
      background: (st === 'working' && !this.replying(key, ev)) || !!this.agents.background(key) || undefined,
      finished: (r?.finished && st === 'gone') || undefined,
      live: st === 'working' && act.open ? lineOf(act.open, true) : undefined,
      jobs: jobs.length ? jobs : undefined,
      controls: this.controls(key, kind),
    }
  }

  /** both wire forms of a chat built now (PERFC-03). The full one goes to a screen that starts watching, to one that
   *  just reconnected, and to an older machine on the link path; screens that already hold a base get the delta from
   *  what we last sent. Every call advances the chat's sequence, so a screen can tell a fresh push from an old one. */
  chatUpdate(key: string, full: Chat): { full: ChatEventFull; delta: ChatEventDelta | null } {
    const through = (this.chatThrough.get(key) ?? 0) + 1
    this.chatThrough.set(key, through)
    const changes = chatDelta(this.sentMessages.get(key), full.messages, through)
    this.sentMessages.set(key, full.messages.slice())
    return {
      full: { type: 'chat', chat: full, through },
      delta: changes ? { type: 'chat-delta', chat: { ...full, messages: [] }, ...changes } : null,
    }
  }

  /** the messages of a chat and the times that close its cards, built from the CLI's log and Shepherdr's own until one
   *  of them changes. Parsing, replies, hosts, activity and two sorts make this the chat's costly pass; every screen
   *  emit, GET /api/chat, needs() and syncAsks read the same unchanged chat again. */
  private chatBuild(key: string, from: string, user: string): { msgs: Message[]; closedAt: number[] } {
    const sig = this.chatSig(key, from, user)
    const had = this.chatCache.get(key)
    if (had?.sig === sig) return had
    const ev = this.events.get(key) ?? []
    const l = this.log(key)
    const msgs: Message[] = []
    const answered = new Set(ev.filter((e) => e.kind === 'answered').map((e) => e.id))
    // artifacts join the chat after what the log says: what quotes one waits for them
    const later: (() => void)[] = []
    let joined = false
    // what you sent from a screen gets the screen's id back, so the screen swaps the message it showed at once for it:
    // the same words, read from the log once they went in
    const lately = this.agents.sentLately(key).map((o) => ({ cid: o.cid!, at: o.at, words: words(stripHidden(o.text)) }))
    const cidFor = (text: string, at: number) => {
      const i = lately.findIndex((o) => at >= o.at - 3000 && o.words === words(text))
      return i < 0 ? undefined : lately.splice(i, 1)[0].cid
    }
    // Shepherdr's update cards are messages too, among the rest by time, so a reaction can quote one
    const cards = l.posted.filter((p) => p.card).map((p) => cardMessage(p.card!, p.at))
    // Autopilot's wakes: one quiet line each, at the moment it woke
    const wakes = wakeLines(ev)
    let sessions = 0
    let newSession = false
    for (const e of ev) {
      while (cards.length && (cards[0].at ?? 0) <= e.at) msgs.push(cards.shift()!)
      if (e.kind === 'session') {
        if (sessions++) newSession = true
        continue
      }
      // another agent's message, as its CLI's log marks it: a row of its own naming the sender it declared
      if (e.kind === 'peer') {
        const froms = fromAgents(e.text)
        if (!froms.length) froms.push({ name: 'Another agent', text: e.text })
        this.peerRows(msgs, e.id, e.at, froms, newSession || undefined)
        newSession = false
        continue
      }
      if (e.kind === 'user') {
        const text = stripHidden(e.text)
        // an Autopilot wake's own quiet line, before anything the agent said after it
        const woke = wakes.get(e.id)
        if (woke) msgs.push({ id: `${e.id}:pilot`, who: 'agent', at: woke.at, pilot: woke.line })
        if (!text) continue
        // another agent's message: a row of its own naming the sender it declared (never the human's words)
        const froms = fromAgents(text)
        if (froms.length) {
          this.peerRows(msgs, e.id, e.at, froms, newSession || undefined)
          newSession = false
          continue
        }
        // a reply: its words, then its files; notes from the shared browser show short: each element and its note
        const bn = parseBrowserNotes(text)
        const r = bn ? null : parseReply(text)
        const reply = r ? replyTo(msgs, r.to, undefined, r.line, r.artifact, later, joined) : undefined
        const lines = bn
          ? [`Notes in the browser on ${shortUrl(bn.url)}:`, ...bn.notes.map((n, i) => `${i + 1}. ${n.element}: ${n.note}`), ...bn.rest]
          : r
            ? [...userLines(r.text), ...r.rest]
            : userLines(text)
        const files: { name: string; path: string }[] = []
        const rest: string[] = []
        let answeredTitle: string | undefined
        let consumed = false
        for (const ln of lines) {
          const p = parseUserLine(ln)
          if (!p) {
            rest.push(ln)
            continue
          }
          if (p.kind === 'attach') files.push({ name: p.name, path: p.path })
          else if (p.kind === 'react' || p.kind === 'unreact') {
            const { artifact: a, emoji, kind } = p
            if (a) later.push(() => addRx(artifactPost(msgs, a.id, a.v), emoji, 'me', kind === 'react'))
            else addRx(findQuoted(msgs, p.to, p.path), p.emoji, 'me', p.kind === 'react')
            consumed = true
          } else {
            const s = shownAs(p)!
            answeredTitle = s.title ?? answeredTitle
            rest.push(s.text)
          }
        }
        const body = rest.join('\n').trim()
        if (consumed && !body && !files.length) continue
        const cid = answeredTitle ? undefined : cidFor(text, e.at)
        if (body || answeredTitle) msgs.push({ id: e.id, who: 'you', at: e.at, text: body || undefined, answered: answeredTitle, cid, newSession: newSession || undefined, reply })
        // each file is a message of its own, right after the text (the first one keeps the message's own id, and a
        // reply with no words)
        files.forEach((file, i) =>
          msgs.push({
            id: i || body || answeredTitle ? `${e.id}:${i}` : e.id,
            who: 'you',
            at: e.at,
            file,
            cid,
            newSession: (!i && !body && !answeredTitle && newSession) || undefined,
            reply: !i && !body && !answeredTitle ? reply : undefined,
          }),
        )
        newSession = false
        continue
      }
      if (e.kind === 'agent') {
        const { text, reactions, reply } = agentLines(stripHidden(e.text))
        for (const x of reactions) addRx(findQuoted(msgs, x.to, x.path), x.emoji, 'them', true)
        if (!text) continue
        msgs.push({ id: e.id, who: 'agent', at: e.at, text, newSession: newSession || undefined, reply: reply ? replyTo(msgs, reply.to, reply.path) : undefined })
        newSession = false
        continue
      }
      if (e.kind === 'question') {
        e.items.forEach((it, i) => {
          const qid = e.items.length > 1 ? `${e.id}:${i}` : e.id
          const sent = l.answers[qid] ?? (answered.has(e.id) ? -1 : undefined)
          // not picked here and no words typed on the card: answered in the terminal
          const said = sent === -1 ? l.said?.[qid]?.text : undefined
          const dismissed = sent === -1 ? l.said?.[qid]?.dismissed : undefined
          const space = l.said?.[qid]?.space
          msgs.push({
            id: `${e.id}#${i}`,
            who: 'agent',
            at: e.at + i,
            question: {
              id: qid,
              title: it.question,
              kind: 'Question',
              choices: it.options,
              multi: it.multiSelect,
              other: it.allowCustom,
              to: from,
              sent: sent === undefined ? undefined : sent,
              said,
              via: sent === -1 && !said && !dismissed ? 'terminal' : undefined,
              dismissed,
              elsewhere: space ? this.answeredIn(space) : undefined,
            },
          })
        })
      }
    }
    msgs.push(...cards)
    msgs.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    // the card-closing rule from the raw log, for openCards and hostFor: hidden notes and app answers are no rows in `messages`
    const closedAt = [...ev.filter((e) => e.kind === 'peer' || (e.kind === 'user' && wordsOf(e.text))).map((e) => e.at), ...l.posted.filter((p) => p.who === 'you').map((p) => p.at)].sort(
      (a, b) => a - b,
    )
    // what else Shepherdr posted: a question or artifact joins the agent's reply of that turn
    const echoed = new Set<Message>()
    /** the replies an artifact came with: one each */
    const hosting = new Set<Message>()
    for (const p of l.posted) {
      if (p.card) continue
      // a picture or a video the agent sent (shepherdr attach): its words, then each file a message of its own, at one
      // time so pictures sent together lie side by side, as the person's do
      if (p.files?.length) {
        if (p.text) msgs.push({ id: p.id, who: 'agent', at: p.at, text: p.text })
        p.files.forEach((file, i) => msgs.push({ id: `${p.id}:${i}`, who: 'agent', at: p.at, file }))
        continue
      }
      if (p.who === 'you') {
        // a command as you typed it: once the log has it (by its id, or by its name: /new is /clear to Claude Code), the
        // log's line shows, in your words
        const logged = p.cid
          ? (msgs.find((m) => m.cid === p.cid) ??
            msgs.find((m) => m.who === 'you' && !m.cid && !echoed.has(m) && !!m.text && sameCommand(m.text, p.text ?? '') && Math.abs((m.at ?? 0) - p.at) < 60_000))
          : undefined
        if (logged) {
          echoed.add(logged)
          // at when it went in: Claude Code logs a menu's command once the menu closes
          Object.assign(logged, { text: p.text, cid: p.cid, at: Math.min(logged.at ?? p.at, p.at) })
          continue
        }
        msgs.push({ id: p.id, who: 'you', at: p.at, text: p.text, answered: p.answered, elsewhere: p.elsewhere, cid: p.cid })
        continue
      }
      if (p.secret) {
        msgs.push({ id: p.id, who: 'agent', at: p.at, secret: p.secret })
        continue
      }
      // a heartbeat skipped over nothing: one quiet line, where it came due
      if (p.pilot) {
        msgs.push({ id: p.id, who: 'agent', at: p.at, pilot: p.pilot })
        continue
      }
      const q = p.question ? withAnswer(p.question, l, this.answeredIn) : undefined
      const until = nextClose(closedAt, p.at)
      const host = hostFor(msgs, p.at, p, hosting, until)
      if (host && !p.text) {
        if (q) host.question = q
        // an artifact is a message of its own, just after the words it came with
        if (p.artifact) {
          hosting.add(host)
          msgs.push({ id: p.id, who: 'agent', at: (host.at ?? p.at) + 0.1, artifact: p.artifact })
        }
      } else msgs.push(...apart([{ id: p.id, who: 'agent', at: p.at, text: p.text, question: q, artifact: p.artifact }]))
    }
    // a question that came with them goes after the artifact, as the last thing the chat waits on
    for (const h of hosting) {
      if (!h.question) continue
      msgs.push({ id: `${h.id}:q`, who: 'agent', at: (h.at ?? 0) + 0.2, question: h.question })
      delete h.question
    }
    joined = true
    for (const f of later) f()
    // each turn's steps fold into one line just before its last reply; a turn nobody sees (news it answered with
    // nothing) shows none
    const act = this.activityFor(key)
    for (const t of act.turns) {
      if (!t.steps.length) continue
      const reply = t.reply ? msgs.find((m) => m.id === t.reply) : undefined
      if (!reply && !(t.asked && msgs.some((m) => m.id === t.asked))) continue
      msgs.push({ id: `act:${t.id}`, who: 'agent', at: reply ? (reply.at ?? 0) - 0.5 : t.end, activity: lineOf(t) })
    }
    msgs.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    this.chatBuilds++
    const built = { msgs, closedAt }
    this.chatCache.set(key, { ...built, sig })
    return built
  }

  private replying(key: string, ev: LogEvent[]) {
    const turn = turnOf(ev, this.agents.sentLately(key))
    const s = this.shown.get(key)
    return replying(turn, !!s?.on && s.turn === turn.id, ev)
  }

  private controls(key: string, kind: string): ChatControls {
    // only Claude Code changes model and effort mid-session (/model, /effort); Codex and pi change them only through
    // their own pickers: their menu only adds files
    const c = kind === 'claude' ? modelsOf(kind) : undefined
    const r = this.agents.record(key)
    const on = findModel(kind, r?.model) ?? findModel(kind, c?.default) ?? c?.models[0]
    if (!c || !on) return { models: [], model: 0, efforts: [], effort: 0 }
    // the models it offers, and an older one it was started on (--model claude-opus-4-8) as well
    const models = c.models.some((m) => m.id === on.id) ? c.models : [...c.models, on]
    // the level it runs at: a level this model lacks shows as the nearest it has, as it goes in
    const effort = nearest(on.efforts, r?.effort) ?? on.effort ?? on.efforts[0]
    return { models: models.map((m) => m.label), model: models.indexOf(on), efforts: on.efforts, effort: Math.max(0, on.efforts.indexOf(effort ?? '')) }
  }
}
