// How the live link to the server comes back. A phone back from the background finds its socket dead, sometimes
// still looking open, and its network can take a moment to wake: the link is tried again at once and then more and
// more slowly, a try that hangs is given up, and the top line says the link is gone only once it has been gone a while.

/** wait before the next try after `tries` failed ones in a row: at once, then 0.5 s, 1 s, 2 s, then every 3 s */
export const retryIn = (tries: number) => (tries <= 0 ? 0 : Math.min(3000, 500 * 2 ** (tries - 1)))

/** a socket not open by then is given up and tried again (a waking network can hold a try for many seconds) */
export const OPEN_WITHIN = 4000

/** back on screen, an open socket must answer a ping this fast or it is replaced (one the phone killed asleep) */
export const PONG_WITHIN = 1500

/** the top line says the link is gone only after this long without it: a quick reconnect shows nothing */
export const SAY_LOST_AFTER = 3000

import { buildId } from '@shared/build.ts'
import { prune, settle } from './outbox.ts'
import { mayReload } from './reload.ts'
import { chatIn, drafts, emit, fromOldPin, getState, keep, panelTerm, patchState, putOutbox, setUI, stayOnShown, visibleChats } from './kernel.ts'
import type { Chat, ChatEventDelta, ChatEventFull, Message, ServerEvent, TermScreen } from '@shared/types.ts'

/* ---------- server link ---------- */

let ws: WebSocket | null = null
let watched = ''

/** the per-boot proof of this page's own writes, handed to it over its socket (SEC-04). Empty until the first socket
 *  message; setting writes before then are refused with the Settings-page words rather than silently accepted. */
let writeCapability = ''

/** when the link to the server last came back: a restarted server may not know its other machines for a moment */
let linkedAt = 0

/** the capability the socket handed this boot, for the action poster in kernel.ts */
export const capabilityOf = () => writeCapability

/** when the link last came back, for the space lookup in kernel.ts */
export const lastLinked = () => linkedAt

// One live socket to the server (the backoff above says how it comes back). The screen keeps what it last showed meanwhile.
let tries = 0
let retrying: ReturnType<typeof setTimeout> | null = null
let opening: ReturnType<typeof setTimeout> | null = null
let pinging: ReturnType<typeof setTimeout> | null = null
let saying: ReturnType<typeof setTimeout> | null = null
let downSince: number | null = null
/** the outbox was cleared of what a loading screen drops */
let pruned = false
let tried = 0

/** The frequent pushes a hidden tab keeps back: one chat per key and one terminal (PERFC-07). Snapshots never come
 *  here: the alerts plugin reads the wait count from them to keep the badge and the window title right while the tab
 *  is away, and the service worker owns its own path. Keeping only the latest of each bounds the memory a tab that
 *  stays hidden for days can hold. */
const deferredChats = new Map<string, ChatEventFull>()
let deferredTerm: Extract<ServerEvent, { type: 'terminal' }> | null = null
/** the sequence of the last chat push applied per key (PERFC-03): a delta older than this was already applied, so it
 *  must not change the chat twice. */
const chatSeq = new Map<string, number>()

/** Fold a delta into a chat the client already holds (PERFC-03). New rows keep their built order until the re-sort by
 *  `at`, as on the server; the current non-message fields ride along in `msg.chat`. */
function applyDelta(base: Chat, msg: ChatEventDelta): Chat {
  const messages = base.messages.slice()
  for (const m of msg.added) messages.push(m)
  for (const { id, patch } of msg.changed) {
    const at = messages.findIndex((x) => x.id === id)
    const found = messages[at]
    if (found) messages[at] = { ...found, ...patch }
  } // coverage-exempt: exercised in test/link.test.ts; coverage maps leave this closing brace unattributed
  // chatBuild sorts the log's rows by `at`, then chat() puts a terminal menu ahead of the queued sends behind it.
  // Mirror that order here: by `at` among log rows, with the menu and the waiting rows kept after them (PERFC-03).
  const rank = (m: Message) => (m.question?.terminal ? 1 : m.waiting ? 2 : 0)
  messages.sort((a, b) => rank(a) - rank(b) || (a.at ?? 0) - (b.at ?? 0))
  // the delta's chat is the whole current chat with an empty message array: take every field from it, so a field
  // that went away (working, live, jobs…) goes away here too, not lingers from the base
  return { ...msg.chat, messages }
} // coverage-exempt: exercised in test/link.test.ts; coverage maps leave this closing brace unattributed

/** hold back the latest chat per key and one terminal while the document is hidden (PERFC-07). A delta is folded into
 *  the chat we are already holding for that key, so waking applies one complete chat, in order, not a stale base that
 *  would roll the delta back. */
function defer(msg: ServerEvent): boolean {
  if (msg.type === 'terminal') {
    deferredTerm = msg
    return true
  }
  if (msg.type !== 'chat' && msg.type !== 'chat-delta') return false
  if ('added' in msg) {
    const key = msg.chat.key
    // with no full buffered, fold into the chat the tab already holds, so the delta is not lost while it is away
    const held = deferredChats.get(key)?.chat ?? ((chatSeq.get(key) ?? -1) < msg.through ? getState().chats[key] : undefined)
    if (held) deferredChats.set(key, { type: 'chat', chat: applyDelta(held, msg), through: msg.through })
    return true
  } // coverage-exempt: exercised in test/link.test.ts; coverage maps leave this closing brace unattributed
  deferredChats.set(msg.chat.key, msg)
  return true
}

/** Apply one server message to the store. The live socket and the wake flush both go through here, so a chat held
 *  back while hidden runs through the same settle/expire steps, in the same order, as one that arrived on screen.
 *  Returns whether the store changed and a redraw is owed. */
function apply(msg: ServerEvent): boolean {
  // A snapshot whose revision the server did not advance says what we already drew: keep the object so every
  // picker keeps its identity and React skips the tree. The 30-second heartbeat is one of these (PERFC-01).
  let changed = true
  if (msg.type === 'snapshot') {
    const snap = msg.snapshot
    const before = getState()
    changed = !before.snap || snap.rev === undefined || snap.rev !== before.snap.rev
    if (changed) patchState({ snap })
    stayOnShown()
    fromOldPin(snap)
    // once loaded, the first snapshot with every machine in reach says which chats are gone (one connecting or out
    // of reach may not list its chats yet: then none is dropped); later ones don't, so a failed one left open a day
    // keeps its Retry
    if (!pruned && snap.machines.every((m) => !m.connecting && m.status !== 'off')) {
      putOutbox(prune(before.outbox, Date.now(), chatIn(snap)))
      pruned = true
    }
    // those steps can change state of their own (a place gone, an outbox pruned) without going through setUI: a
    // redraw is still owed for them even when the snapshot's revision did not move (PERFC-01)
    if (getState() !== before) changed = true
  } else if (msg.type === 'chat' || msg.type === 'chat-delta') {
    const key = msg.chat.key
    let chat: Chat
    if ('added' in msg) {
      // a delta needs the full chat we got when we started watching. Without one, or when the sequence says we
      // already applied it, wait for the next full chat rather than patch blind.
      const base = getState().chats[key]
      if (!base || (chatSeq.get(key) ?? -1) >= msg.through) return false
      chat = applyDelta(base, msg)
      chatSeq.set(key, msg.through)
    } else {
      chat = msg.chat
      chatSeq.set(key, msg.through ?? 0)
    }
    patchState({ chats: { ...getState().chats, [key]: chat } })
    putOutbox(settle(getState().outbox, chat))
  } else if (msg.type === 'terminal') patchState({ terms: { ...getState().terms, [msg.chat]: { ansi: msg.ansi, cols: msg.cols, rows: msg.rows } } })
  else if (msg.type === 'update') patchState({ update: msg.update })
  else if (msg.type === 'build' && BUILD && msg.id && msg.id !== BUILD) reloadSoon()
  if (msg.type === 'snapshot') watchVisible()
  return changed
}

/** back on screen: apply what the hidden tab kept, through the same path as a live push, in one redraw (PERFC-07).
 *  Clear the buffer before applying so a message that arrives on the now-live socket is not mistaken for a held one. */
function flushDeferred() {
  if (!deferredChats.size && !deferredTerm) return
  const chats = [...deferredChats.values()]
  const term = deferredTerm
  deferredChats.clear()
  deferredTerm = null
  let changed = false
  for (const chat of chats) changed = apply(chat) || changed
  if (term) changed = apply(term) || changed
  if (changed) emit()
}

export function connect() {
  if (retrying) clearTimeout(retrying)
  retrying = null
  const url = new URL('api/ws', location.href)
  url.protocol = url.protocol.replace('http', 'ws')
  const sock = new WebSocket(url)
  ws = sock
  tried = Date.now()
  opening = setTimeout(() => drop(sock), OPEN_WITHIN)
  sock.onopen = () => {
    if (opening) clearTimeout(opening)
    linkedAt = Date.now()
    tries = 0
    downSince = null
    if (saying) clearTimeout(saying)
    saying = null
    watched = ''
    if (getState().ui.offline) setUI({ offline: null })
    watchVisible()
  }
  sock.onmessage = (ev) => {
    if (pinging) clearTimeout(pinging)
    pinging = null
    const msg = JSON.parse(ev.data) as ServerEvent
    if (msg.type === 'pong') return
    if (msg.type === 'capability') {
      writeCapability = msg.capability
      return
    }
    // A hidden tab keeps applying snapshots (the badge and the service worker need them) but holds back the frequent
    // chat and terminal pushes: keep only the latest of each and apply them together on wake (PERFC-07).
    if (document.visibilityState !== 'visible' && defer(msg)) return
    if (apply(msg)) emit()
  }
  sock.onclose = () => drop(sock)
}

/** this socket is done (closed, never opened, or silent): try again, and say the link is gone if it stays gone */
function drop(sock: WebSocket) {
  if (sock !== ws) return
  forget()
  downSince ??= Date.now()
  saying ??= sayLater()
  retrying = setTimeout(connect, retryIn(tries++))
}

/** let go of the socket, whatever it is doing */
function forget() {
  if (!ws) return
  ws.onopen = ws.onmessage = ws.onclose = null
  ws.close()
  ws = null
  if (opening) clearTimeout(opening)
  if (pinging) clearTimeout(pinging)
  pinging = null
}

/** say the link is gone in a few seconds, unless it is back by then; a timer that slept with the page starts over */
function sayLater(at = Date.now()): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (Date.now() - at > SAY_LOST_AFTER + 1000) saying = sayLater()
    else if (ws?.readyState !== WebSocket.OPEN) setUI({ offline: downSince })
  }, SAY_LOST_AFTER)
}

/** back on screen (or on the network): an open link must answer a ping, any other is tried again at once */
function wake() {
  if (document.visibilityState !== 'visible') return
  // back on screen: what the hidden tab kept goes out through the same path a live push uses, in one redraw, before
  // the link is checked (PERFC-07). A wake while still hidden returns above and leaves the buffer for the real one.
  flushDeferred()
  if (ws?.readyState === WebSocket.OPEN) {
    if (pinging) return
    const sock = ws
    pinging = setTimeout(() => {
      tries = 0
      drop(sock)
    }, PONG_WITHIN)
    return sock.send(JSON.stringify({ type: 'ping' }))
  }
  // back on screen, the link gets a fresh few seconds before the top line says it is gone; a try made while away
  // went out before the network woke and can hang, so it starts over (one just made stays: a phone says it twice)
  if (saying) {
    clearTimeout(saying)
    saying = sayLater()
    if (getState().ui.offline) setUI({ offline: null })
  }
  if (ws && Date.now() - tried < 1000) return
  forget()
  tries = 0
  connect()
}

document.addEventListener('visibilitychange', wake)
addEventListener('pageshow', (e) => (e as PageTransitionEvent).persisted && wake())
addEventListener('online', wake)

let pushEndpoint: string | null = null

/** This device's push subscription (alerts sets it): while the app is on screen, the server sends it no alerts. */
export function setPushEndpoint(endpoint: string | null) {
  pushEndpoint = endpoint
  watchVisible()
}

document.addEventListener('visibilitychange', () => watchVisible())

/** A tab open for days kept the last full chat of every place it ever watched and the last full ANSI screen of every
 *  terminal (PERFC-06). Drop what is no longer on screen, keeping the surviving entries' object identity so the pickers
 *  that already hold them skip a redraw. The outbox stays: settling reads a chat's messages even after it left the
 *  screen. */
function trimCaches(keep: Set<string>) {
  const chats: Record<string, Chat> = {}
  let chatDropped = false
  for (const key of Object.keys(getState().chats)) {
    if (keep.has(key)) chats[key] = getState().chats[key]
    else chatDropped = true
  }
  const terms: Record<string, TermScreen> = {}
  let termDropped = false
  for (const key of Object.keys(getState().terms)) {
    if (keep.has(key)) terms[key] = getState().terms[key]
    else termDropped = true
  }
  if (!chatDropped && !termDropped) return
  patchState({ chats, terms })
}

/** Tell the server the chats (and terminals) now on screen, and whether the app is on screen at all. */
export function watchVisible() {
  const st = getState()
  if (!ws || ws.readyState !== WebSocket.OPEN || !st.snap) return
  const keys = visibleChats(st.ui, st.snap)
  const term = st.ui.term ?? panelTerm(st.ui, st.snap)
  const visible = document.visibilityState === 'visible'
  const next = JSON.stringify({ keys, term, visible, pushEndpoint })
  if (next === watched) return
  watched = next
  // Everything here can be fetched again from the server when it is watched once more; only the outbox's own chats
  // and the open terminal need to stay in memory now (PERFC-06).
  const keep = new Set([...keys, ...st.outbox.map((o) => o.chat)])
  if (term) keep.add(term)
  trimCaches(keep)
  ws.send(JSON.stringify({ type: 'watch', chats: keys, term, visible, push: pushEndpoint }))
}

/* ---------- reloading on a new build ---------- */

// the build this screen is (empty under the dev server: it reloads by itself)
const BUILD = buildId(document.head.innerHTML)
let reloading: ReturnType<typeof setInterval> | null = null
let holds = 0
let typed = 0

addEventListener('input', () => (typed = Date.now()), true)

/** Hold off reloading while something can't be picked up again (an upload on its way). Returns the release. */
export function holdReload() {
  holds++
  let done = false
  return () => {
    if (!done) holds--
    done = true
  }
}

function reloadSoon() {
  if (reloading) return
  const tryNow = () => {
    if (!mayReload(getState().ui, { holds, sinceTyped: Date.now() - typed, focused: document.activeElement })) return
    keep(getState(), drafts)
    // what of itself each part keeps (a chat, how far up it was read)
    dispatchEvent(new Event('shepherdr:reloading'))
    location.reload()
  } // coverage-exempt: exercised in test/link.test.ts; coverage maps leave this closing brace unattributed
  reloading = setInterval(tryNow, 1000)
  tryNow()
} // coverage-exempt: exercised in test/link.test.ts; coverage maps leave this closing brace unattributed
