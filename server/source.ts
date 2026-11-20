// A source fills the view model and carries out actions. The live source reads herdr and the CLIs' logs; the demo
// source holds the prototype's fictional world, for side-by-side review and tests.
import type { Action, ActivityAnswer, ActivityAsk, AddSpace, Alert, Chat, ChatEventDelta, ChatEventFull, Folders, Snapshot, TermScreen, WorktreeAsk } from '../shared/types.ts'

export type SourceEvents = {
  /** something changed: the next snapshot gets a new revision */
  snapshot: []
  /** the 30-second refresh: send a snapshot, but keep the revision when nothing in it changed */
  heartbeat: []
  chat: [key: string]
  alert: [alert: Alert]
  terminal: [key: string, screen: TermScreen]
  /** a worker's news for the main machine's home space, which keeps every machine's overview */
  news: [n: Overview]
}

/** one piece of another machine's news, as the main machine's home space hears it: its place and one line */
export interface Overview {
  place: string
  line: string
  kind: 'added' | 'ready' | 'need' | 'done' | 'red' | 'stalled' | 'health'
  about?: Record<string, string>
}

export class Emitter<E extends Record<string, unknown[]>> {
  private fns: { [K in keyof E]?: ((...a: E[K]) => void)[] } = {}
  on<K extends keyof E>(ev: K, fn: (...a: E[K]) => void) {
    ;(this.fns[ev] ??= []).push(fn)
    return () => {
      this.fns[ev] = this.fns[ev]!.filter((f) => f !== fn)
    }
  }
  emit<K extends keyof E>(ev: K, ...a: E[K]) {
    for (const f of this.fns[ev] ?? []) f(...a)
  }
}

/** what a snapshot says, without the number the server gave it */
const withoutRev = (snap: Snapshot) => {
  const { rev: _previous, ...body } = snap
  return JSON.stringify(body)
}

/** A snapshot's revision (PERFC-01). A change emit advances it, even one whose effect is read through an action
 *  rather than the snapshot (a profile changed, say). The 30-second heartbeat instead keeps the number when the bytes
 *  are the same, so a screen that has not changed anything keeps the object it drew and redraws nothing. The first
 *  number comes from the clock, so a screen that kept a snapshot across a server restart cannot mistake the next
 *  process's early numbers for the ones it already drew. */
export class SnapshotRevisions {
  private rev = Date.now()
  private last: Snapshot | null = null
  private lastBytes: string | null = null
  /** a change: the next snapshot gets a new number. Nothing is serialized here: the server already has the object. */
  changed(snap: Snapshot): Snapshot {
    this.rev++
    this.last = snap
    this.lastBytes = null // worked out at the next refresh, not on every change
    return { ...snap, rev: this.rev }
  }
  /** a refresh: same bytes, same number; different bytes, a change the emit sites did not have to name. This is the
   *  half-minute heartbeat, so it is the only place that pays for a comparison. */
  refresh(snap: Snapshot): Snapshot {
    const bytes = withoutRev(snap)
    if (this.lastBytes === null) this.lastBytes = this.last ? withoutRev(this.last) : ''
    if (bytes !== this.lastBytes) {
      this.last = snap
      this.lastBytes = bytes
      this.rev++
    }
    return { ...snap, rev: this.rev }
  }
}

export interface Source extends Emitter<SourceEvents> {
  readonly kind: 'live' | 'demo'
  /** the screen's per-boot proof of its own writes (SEC-04), handed to it over the live socket. The demo source has
   *  none: its writes carry no gate. */
  readonly writeCapability?: string
  /** the live source's event loop watch: the server times what it holds the loop with by name (stall.ts) */
  readonly stall?: import('./live/stall.ts').StallWatch
  /** the published names this app answers to (app.hosts); read fresh so a change needs no restart */
  hosts?(): string[]
  snapshot(): Snapshot
  /** Owning agent status, for chat readers such as voice. */
  chatStatus?(key: string): string
  chat(key: string): Chat | undefined
  /** both wire forms of a chat built now (PERFC-03): a delta from the last push for screens that hold a base, and
   *  the full form for a first watch, a reconnect or an older link peer. A source with no base (the demo world)
   *  leaves this out, and its chats keep going whole. */
  chatUpdate?(key: string, full: Chat): { full: ChatEventFull; delta: ChatEventDelta | null }
  act(a: Action): Promise<unknown>
  /** an artifact's page, data and what it sent, at a version (its latest when none) */
  artifact(id: string, v?: number): Promise<{ html: string; data?: unknown; sent?: string } | undefined>
  /** the check's picture of an artifact's latest version, for the list */
  artifactThumb(id: string, dark: boolean): Promise<Blob | null>
  /** which chats and terminal are on someone's screen: read them while they are */
  watch(chats: string[], terms: string[]): void
  /** the signal stops a peer copy when the uploader's connection goes away while it is being forwarded */
  upload(chat: string, name: string, data: Uint8Array, signal?: AbortSignal): Promise<string>
  /** talk to type: a recording, written down on this machine (whisper.cpp), its words back; throws with words for the
   *  screen when it can't (no whisper.cpp, no model, nothing said). It stops when the screen goes away (signal) */
  dictate?(audio: Blob, signal?: AbortSignal): Promise<string>
  /** a file attached in a chat, by the path its chat line gives; only those, never anything else on the machine */
  attachment(chat: string, path: string): Promise<Blob | null>
  /** a tile's small copy of a picture (thumb) or a still of a video (poster), from the same file and only that file;
   *  null when it isn't worth one or the machine can't make it, and the screen shows the file itself */
  media?(chat: string, path: string, want: 'thumb' | 'poster'): Promise<Blob | null>
  /** a machine's folders, for adding a project: only folders in the human's home on it */
  folders?(machine: string, path: string): Promise<Folders>
  /** add a project from the sidebar, as `shepherdr project add` does (made a new repo first with create); its place */
  addSpace?(req: AddSpace): Promise<{ place: string }>
  /** a task's worktree, read only, for its side panel: its files, a file, its diff against its base, a file's diff,
   *  its pull request. Never anything outside that worktree. */
  worktree?(ask: WorktreeAsk): Promise<unknown>
  /** a chat's activity: a turn's steps, a step's raw output, a background job's steps or output */
  activity?(ask: ActivityAsk): Promise<ActivityAnswer>
  /** a voice call's audio bridge (live) */
  voice?(chat: string, ws: { send(d: ArrayBuffer | string): void; close(): void }): { audio(d: ArrayBuffer): void; end(): void }
  /** a Browser panel's link to a task's shared browser (live, with the browser plugin) */
  browser?(task: string, ws: { send(d: string): void; close(): void; buffered?(): number }): { message(d: string): void; end(): void }
  /** before it stops: what must not be cut halfway (a merge) finishes; true when it waited for something */
  drain?(): Promise<boolean>
  stop?(): void
}
