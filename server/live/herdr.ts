import { LinkBackoff } from './recovery.ts'
// herdr's socket API: newline-delimited JSON over a Unix socket. One request per connection (herdr closes it after
// the reply); a subscription keeps its connection open and streams events. On another machine (box.ts) the same JSON
// goes through herdr's own remote bridge (herdr --session <s> remote-api-bridge over SSH), one bridge per connection.
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BOX, script, sshArgs } from './box.ts'

export function socketPath() {
  return process.env.HERDR_SOCKET_PATH ?? process.env.HERDR_SOCKET ?? join(homedir(), '.config', 'herdr', 'herdr.sock')
}

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HerdrError'
  }
}

/** a connection herdr closed, or a reply it did not give in time, after the connection was made: herdr is there and a
 *  call tried again most likely goes through (a server that stalls sends its request late, and herdr drops the
 *  connection: "timed out reading api request"). Not herdr down (`unreachable`), nor herdr saying no. */
export const PASSING = ['dropped', 'timeout', 'closed']

/** whether a failure is such a passing one */
export const isPassing = (e: unknown) => e instanceof HerdrError && PASSING.includes(e.code)

/** how long a call waits before each try again after a passing failure: about 0.5 s, 1 s, 2 s. SHEPHERDR_HERDR_RETRY_MS
 *  says others (a comma list; the tests make them short), and an empty list is no retry, which is what it is on another
 *  machine's bridge (box.ts): a connection that closes there is a link that failed, which its own backoff (recovery.ts) handles */
export const retryDelays = (): number[] => {
  const v = process.env.SHEPHERDR_HERDR_RETRY_MS
  return BOX ? [] : v === undefined ? [500, 1000, 2000] : v.split(',').filter(Boolean).map(Number)
}

/** how long a start waits before each try again when herdr keeps dropping its calls: about 90 s in all (3 s, 6 s, 12 s, 24 s,
 *  45 s). SHEPHERDR_START_RETRY_MS says others, as for retryDelays. None on another machine's bridge (box.ts): a connection that closes there is a link that failed, which its own backoff (recovery.ts) handles */
export const startDelays = (): number[] => {
  const v = process.env.SHEPHERDR_START_RETRY_MS
  return BOX ? [] : v === undefined ? [3000, 6000, 12_000, 24_000, 45_000] : v.split(',').filter(Boolean).map(Number)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** `f`, and again after each delay while it fails in a passing way (isPassing): its last failure when they are used up.
 *  Anything else fails at once */
export async function retrying<T>(f: () => Promise<T>, delays: number[] = retryDelays()): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f()
    } catch (e) {
      if (!isPassing(e) || i >= delays.length) throw e
      await sleep(delays[i])
    }
  }
}

let n = 0

/** a connection to herdr's API: its socket here, or a bridge to the other machine's */
interface Conn {
  write(s: string): void
  destroy(): void
  on(e: 'connect', f: () => void): void
  on(e: 'data', f: (d: Buffer) => void): void
  on(e: 'error' | 'close', f: (e?: Error) => void): void
}

function open(path: string): Conn {
  if (!BOX || path !== socketPath()) return connect(path)
  const p = Bun.spawn(sshArgs(BOX.target, script(BOX, [BOX.herdr, '--session', BOX.session, 'remote-api-bridge']), { extra: ['-o', 'ControlPath=none'] }), { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  const fns: Record<string, ((x?: unknown) => void)[]> = { connect: [], data: [], error: [], close: [] }
  const fire = (e: string, x?: unknown) => fns[e].forEach((f) => f(x))
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    fire('close')
  }
  queueMicrotask(() => fire('connect'))
  ;(async () => {
    try {
      const r = p.stdout.getReader()
      for (;;) {
        const { done, value } = await r.read()
        if (done) break
        fire('data', Buffer.from(value))
      }
    } catch (e) {
      fire('error', e)
    }
    close()
  })()
  p.exited.then(close)
  return {
    write: (s) => {
      try {
        p.stdin.write(s)
        p.stdin.flush()
      } catch (e) {
        fire('error', e as Error)
      }
    },
    destroy: () => {
      closed = true
      try {
        p.kill()
      } catch {
        /* gone already */
      }
    },
    on: (e: string, f: (x?: never) => void) => void fns[e].push(f as (x?: unknown) => void),
  } as Conn
}

/** herdr's socket refused the connection or is not there: herdr is down or restarting. A connection that was made and
 *  then reset (ECONNRESET, EPIPE) is herdr closing it, not herdr down: see `PASSING` */
const gone = (e: Error & { code?: string }) => ['ECONNREFUSED', 'ENOENT'].includes(e.code ?? '') || /ECONNREFUSED|ENOENT/.test(e.message)

/** what only reads: asked again after a passing failure, whatever it was asked of. A call that changes something is
 *  asked again only where it can be told whether the first try took effect (the herdr object below); ping is a health
 *  look that wants the first answer */
const READS = new Set(['agent.list', 'agent.get', 'workspace.list', 'pane.list', 'pane.read', 'pane.layout', 'pane.process_info'])

/** one call to herdr, and one more after each short wait while it fails in a passing way when it only reads */
export async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000, path = socketPath()): Promise<T> {
  return READS.has(method) ? retrying(() => once<T>(method, params, timeoutMs, path)) : once<T>(method, params, timeoutMs, path)
}


/** a call to herdr, tried once: what a failure says tells herdr down from a connection herdr closed */
export async function once<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000, path = socketPath()): Promise<T> {
  const id = `shep-${Date.now().toString(36)}-${++n}`
  return new Promise<T>((resolve, reject) => {
    let buf = ''
    let done = false
    const sock = open(path)
    const finish = (f: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      f()
    }
    const timer = setTimeout(() => finish(() => reject(new HerdrError('timeout', `herdr ${method} timed out`))), timeoutMs)
    sock.on('connect', () => sock.write(`${JSON.stringify({ id, method, params })}\n`))
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        const f = JSON.parse(line) as { id?: string; result?: T; error?: { code: string; message: string } }
        if (f.id !== id) continue
        if (f.error) finish(() => reject(new HerdrError(f.error!.code, f.error!.message)))
        else finish(() => resolve(f.result as T))
      }
    })
    // its socket refusing, or gone: herdr stopped or is starting again. Said plainly, never "connect ECONNREFUSED …"
    // a connection reset is herdr closing it (it did not get the request in time, or restarted): a passing failure, said as
    // one, and not the words for herdr down
    sock.on('error', (e) => finish(() => reject(!e || gone(e) ? new HerdrError('unreachable', "herdr isn't answering") : ['ECONNRESET', 'EPIPE'].includes((e as Error & { code?: string }).code ?? '') ? new HerdrError('dropped', `herdr dropped the connection during ${method}`) : new HerdrError('unreachable', e.message))))
    sock.on('close', () => finish(() => reject(new HerdrError('closed', `herdr closed the connection during ${method}`))))
  })
}

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export interface AgentSession {
  source: string
  agent: string
  kind: 'id' | 'path'
  value: string
}

export interface AgentInfo {
  agent: string | null
  agent_status: AgentStatus
  agent_session?: AgentSession | null
  cwd: string | null
  foreground_cwd?: string | null
  name?: string | null
  pane_id: string
  tab_id: string
  workspace_id: string
  title?: string | null
  terminal_title_stripped?: string | null
  interactive_ready?: boolean
  /** herdr has not finished this launch yet: a client asking for it by name completes it (issue #491) */
  launch_pending?: boolean
}

/** what runs in a pane (pane.process_info) */
export interface ProcessInfo {
  shell_pid?: number
  foreground_process_group_id?: number
  foreground_processes?: { argv?: string[]; name?: string; pid?: number }[]
}

/** a workspace's place in a herdr worktree group: a repo's own checkout, or a linked worktree nested under it */
export interface WorktreeOf {
  checkout_path: string
  is_linked_worktree: boolean
  repo_root: string
}

export interface WorkspaceInfo {
  workspace_id: string
  label: string
  focused?: boolean
  tab_count?: number
  pane_count?: number
  worktree?: WorktreeOf
}

export interface PaneInfo {
  pane_id: string
  workspace_id: string
  tab_id?: string
  cwd?: string | null
  foreground_cwd?: string | null
}

/** the workspace a worktree's space nests under, or the repo folder herdr finds (or opens) one for */
export type WorktreeFrom = { workspace_id: string } | { cwd: string }

/** what herdr gives back when it creates or opens a worktree workspace */
export interface WorktreeSpace {
  workspace: WorkspaceInfo
  root_pane: { pane_id: string }
  worktree?: { path: string }
  already_open?: boolean
}


/**
 * A call that changes something, asked again after a passing failure (see PASSING) only once `took` has looked at what
 * the first try may have done: it gives that effect when it is there (the workspace, the tab, the agent), and the call
 * is not made again. So a retry never makes a second workspace, tab, agent or message. When `took` can't look (herdr
 * still drops it) or throws, the call fails as it did.
 */
async function changing<T>(attempt: () => Promise<T>, took: () => Promise<T | undefined>, delays: number[] = retryDelays()): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt()
    } catch (e) {
      if (!isPassing(e) || i >= delays.length) throw e
      await sleep(delays[i])
      let done: T | undefined
      try {
        done = await took()
      } catch {
        throw e
      }
      if (done !== undefined) return done
    }
  }
}

const NOT_FOUND = /not[_ ]found/i

/** text as the screen shows it, to look for what was typed: no blanks, since the screen wraps lines where it likes */
const squeeze = (t: string) => t.replace(/\s+/g, '')

/** what a prompt that may not have gone in is looked for on: the pane's last lines. The text is only looked for when it is
 *  short: a long paste is shown folded by some CLIs ("[Pasted text +20 lines]"), so it cannot be told from one that never came */
const SEEN_LINES = 80
const SEEN_MAX = 500

export const herdr = {
  ping: () => rpc<{ version?: string; protocol?: number }>('ping', {}, 3000),
  agents: () => rpc<{ agents: AgentInfo[] }>('agent.list').then((r) => r.agents),
  agent: (target: string) => rpc<{ agent: AgentInfo }>('agent.get', { target }).then((r) => r.agent),
  workspaces: () => rpc<{ workspaces: WorkspaceInfo[] }>('workspace.list').then((r) => r.workspaces),
  createWorkspace: async (label: string, cwd: string, env: Record<string, string> = {}) => {
    const had = new Set((await herdr.workspaces().catch(() => [])).map((w) => w.workspace_id))
    return changing(
      () => once<{ workspace: WorkspaceInfo; root_pane: { pane_id: string } }>('workspace.create', { label, cwd, env, focus: false }),
      async () => {
        const ws = (await herdr.workspaces()).find((w) => w.label === label && !had.has(w.workspace_id))
        const pane = ws && (await herdr.panes(ws.workspace_id))[0]
        return ws && pane ? { workspace: ws, root_pane: { pane_id: pane.pane_id } } : undefined
      },
    )
  },
  renameWorkspace: (workspace_id: string, label: string) => retrying(() => once('workspace.rename', { workspace_id, label })),
  createTab: async (workspace_id: string, label: string, cwd: string, env: Record<string, string> = {}) => {
    const had = new Set((await herdr.panes(workspace_id).catch(() => [])).map((p) => p.pane_id))
    return changing(
      () => once<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>('tab.create', { workspace_id, label, cwd, env, focus: false }),
      async () => {
        const pane = (await herdr.panes(workspace_id)).find((p) => !had.has(p.pane_id) && (p.cwd === cwd || p.foreground_cwd === cwd))
        return pane ? { tab: { tab_id: pane.tab_id ?? '' }, root_pane: { pane_id: pane.pane_id } } : undefined
      },
    )
  },
  start: (name: string, kind: string, pane_id: string, args: string[] = []) =>
    changing(
      () => once<{ agent: AgentInfo }>('agent.start', { name, kind, pane_id, args, timeout_ms: 60_000 }, 70_000),
      async () => {
        const agent = await herdr.agent(name).catch((e) => {
          if (e instanceof HerdrError && (NOT_FOUND.test(e.code) || NOT_FOUND.test(e.message))) return undefined
          throw e
        })
        return agent?.pane_id === pane_id ? { agent } : undefined
      },
    ),
  prompt: (target: string, text: string) =>
    changing(
      () => once('agent.prompt', { target, text }, 20_000),
      async () => {
        if (text.length > SEEN_MAX) throw new Error('too long to tell')
        const agent = await herdr.agent(target)
        const seen = squeeze(await herdr.read(agent.pane_id, 'text', SEEN_LINES))
        return seen.includes(squeeze(text)) ? {} : undefined
      },
    ),
  sendKeys: (target: string, keys: string[]) => rpc('agent.send_keys', { target, keys }),
  paneKeys: (pane_id: string, keys: string[]) => rpc('pane.send_keys', { pane_id, keys }),
  paneText: (pane_id: string, text: string) => rpc('pane.send_text', { pane_id, text }),
  read: (pane_id: string, format: 'ansi' | 'text' = 'ansi', lines = 200) =>
    rpc<{ read?: { text: string }; text?: string }>('pane.read', { pane_id, source: 'recent', format, lines, strip_ansi: format !== 'ansi' }).then((r) => r.read?.text ?? r.text ?? ''),
  /** what the pane shows right now, plain: unlike a deep read it never scrolls a working agent's view */
  visible: (pane_id: string) =>
    rpc<{ read?: { text: string }; text?: string }>('pane.read', { pane_id, source: 'visible', format: 'text', strip_ansi: true }).then((r) => r.read?.text ?? r.text ?? ''),
  /** a pane's size in cells */
  size: (pane_id: string) =>
    rpc<{ layout: { panes: { pane_id: string; rect: { width: number; height: number } }[] } }>('pane.layout', { pane_id }).then((r) => {
      const rect = r.layout.panes.find((p) => p.pane_id === pane_id)?.rect
      return rect ? { cols: rect.width, rows: rect.height } : null
    }),
  panes: (workspace_id: string) => rpc<{ panes: PaneInfo[] }>('pane.list', { workspace_id }).then((r) => r.panes),
  /** what runs in a pane: its shell, and the processes in its foreground with their command lines */
  processInfo: (pane_id: string) =>
    rpc<{ process_info: ProcessInfo }>('pane.process_info', { pane_id }).then((r) => r.process_info),
  /** the shell sits at its prompt: nothing runs in the foreground */
  paneIdle: (pane_id: string) =>
    rpc<{ process_info: { shell_pid?: number; foreground_process_group_id?: number } }>('pane.process_info', { pane_id }).then(
      (r) => !!r.process_info.shell_pid && r.process_info.foreground_process_group_id === r.process_info.shell_pid,
    ),
  /** a checkout on a new (or existing) branch, opened as a workspace nested under `from`: the repo's own workspace, or
   *  the one herdr finds (or opens) for the repo's folder. path: where (herdr picks one when it is left out) */
  worktreeCreate: async (from: WorktreeFrom, branch: string, base: string, label: string, path?: string) => {
    const had = new Set((await herdr.workspaces().catch(() => [])).map((w) => w.workspace_id))
    return changing(
      () => once<WorktreeSpace>('worktree.create', { ...from, branch, base, label, ...(path ? { path } : {}), focus: false }, 120_000),
      async () => {
        const ws = (await herdr.workspaces()).find((w) => !had.has(w.workspace_id) && w.label === label && w.worktree?.is_linked_worktree && (!path || w.worktree.checkout_path === path))
        const pane = ws && (await herdr.panes(ws.workspace_id))[0]
        return ws && pane ? { workspace: ws, root_pane: { pane_id: pane.pane_id }, worktree: { path: ws.worktree!.checkout_path } } : undefined
      },
    )
  },
  /** an existing checkout as a workspace nested under `from` (the one already open, if it is) */
  worktreeOpen: (from: WorktreeFrom, path: string, label: string) => retrying(() => once<WorktreeSpace>('worktree.open', { ...from, path, label, focus: false }, 60_000)),
  /** git worktree remove of a linked worktree's workspace, which closes it; never forced, never the branch */
  worktreeRemove: (workspace_id: string, force = false) => rpc('worktree.remove', { workspace_id, force }, 120_000),
  /** closed again after a passing failure: a pane that is gone by then was closed by the first try */
  closePane: async (pane_id: string) => {
    let again = false
    return changing(
      () =>
        once('pane.close', { pane_id }).catch((e) => {
          if (again && e instanceof HerdrError && (NOT_FOUND.test(e.code) || NOT_FOUND.test(e.message))) return {}
          again = true
          throw e
        }),
      async () => undefined,
    )
  },
  closeWorkspace: (workspace_id: string) => rpc('workspace.close', { workspace_id }),
  notify: (title: string, body: string) => rpc('notification.show', { title, body }).catch(() => undefined),
}

export type HerdrEvent = { event: string; data: Record<string, unknown> }

/**
 * Keeps one subscription open and reopens it whenever it closes (herdr closes a subscriber that falls behind).
 * Callers re-read state from a snapshot after `onOpen`, so nothing missed in between stays missed.
 */
export class Subscription {
  private sock: Conn | null = null
  private stopped = false
  private retry?: ReturnType<typeof setTimeout>
  private handshake?: ReturnType<typeof setTimeout>
  private recovery = new LinkBackoff()
  private wanted: Record<string, unknown>[] = []
  constructor(
    private onEvent: (e: HerdrEvent) => void,
    private onOpen: () => void = () => undefined,
    private connect: () => Conn = () => open(socketPath()),
  ) {}

  set(subs: Record<string, unknown>[]) {
    const same = JSON.stringify(subs) === JSON.stringify(this.wanted)
    this.wanted = subs
    if (!same) this.reopen()
  }

  private reopen() {
    if (this.retry) clearTimeout(this.retry)
    if (this.handshake) clearTimeout(this.handshake)
    const previous = this.sock
    this.sock = null
    previous?.destroy()
    if (this.stopped || !this.wanted.length) return
    let sock: Conn
    try { sock = this.connect() } catch {
      this.retry = setTimeout(() => this.reopen(), this.recovery.fail())
      return
    }
    this.sock = sock
    let buf = ''
    let opened = false
    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ id: `sub-${++n}`, method: 'events.subscribe', params: { subscriptions: this.wanted } })}\n`)
      // SSH spawn is not a successful bridge connection; wait for an actual frame.
    })
    sock.on('data', (d) => {
      if (this.sock !== sock || this.stopped) return
      buf += d.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try {
          const f = JSON.parse(line)
          if (f.error) { again(); return }
          if (!opened && ('result' in f || f.event)) {
            opened = true
            if (this.handshake) clearTimeout(this.handshake)
            this.recovery.success()
            this.onOpen()
          }
          if (f.event) this.onEvent(f as HerdrEvent)
        } catch {
          /* a frame we can't read */
        }
      }
    })
    const again = () => {
      if (this.sock !== sock || this.stopped) return
      this.sock = null
      if (this.handshake) clearTimeout(this.handshake)
      sock.destroy()
      this.retry = setTimeout(() => this.sock === null && this.reopen(), this.recovery.fail())
    }
    this.handshake = setTimeout(again, 15_000)
    sock.on('error', again)
    sock.on('close', again)
  }

  stop() {
    this.stopped = true
    if (this.handshake) clearTimeout(this.handshake)
    if (this.retry) clearTimeout(this.retry)
    this.sock?.destroy()
    this.sock = null
  }
}
