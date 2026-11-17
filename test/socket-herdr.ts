// A herdr on a real Unix socket (the protocol server/live/herdr.ts speaks: one JSON request per connection, one reply),
// that keeps its state like the real one and can be told to fail the way a loaded one does: to close a connection with no
// reply ("api connection failed: timed out reading api request"), before it does what was asked or after, to answer late,
// or to be gone. Every request it gets is kept, to count what a retry sent.
import { createServer, type Server, type Socket } from 'node:net'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

export type Failure =
  /** closed on the request, nothing done */
  | 'drop'
  /** done, then closed with no reply: the first try took effect and its answer is lost */
  | 'drop-after'
  /** a reset instead of a close (ECONNRESET) */
  | 'reset'
  /** nothing, ever (our own timeout) */
  | 'hang'

interface Pane {
  pane_id: string
  workspace_id: string
  tab_id: string
  cwd: string
  text: string
}
interface Space {
  workspace_id: string
  label: string
  worktree?: { checkout_path: string; is_linked_worktree: boolean; repo_root: string }
}
interface Agent {
  name: string
  pane_id: string
  agent: string
  agent_status: string
}

export function socketHerdr() {
  const dir = tmp('socket-herdr')
  const path = join(dir, 'herdr.sock')
  let n = 0
  const spaces: Space[] = []
  const panes: Pane[] = []
  const agents: Agent[] = []
  /** every request, in order */
  const requests: { method: string; params: Record<string, unknown> }[] = []
  /** failures to give the next requests of a method, one each */
  const failures = new Map<string, Failure[]>()
  const sockets = new Set<Socket>()
  let server: Server | undefined

  const pane = (workspace_id: string, cwd: string) => {
    const p: Pane = { pane_id: `${workspace_id}:p${++n}`, workspace_id, tab_id: `${workspace_id}:t${n}`, cwd, text: '' }
    panes.push(p)
    return p
  }
  const space = (label: string, cwd: string, worktree?: Space['worktree']) => {
    const w: Space = { workspace_id: `w${++n}`, label, worktree }
    spaces.push(w)
    return { workspace: w, root_pane: { pane_id: pane(w.workspace_id, cwd).pane_id } }
  }

  /** what the method does: its result, or an error that herdr gives */
  const act = (method: string, p: Record<string, any>): { result?: unknown; error?: { code: string; message: string } } => {
    const no = (code: string, message: string) => ({ error: { code, message } })
    switch (method) {
      case 'ping':
        return { result: { version: 'fake', protocol: 1 } }
      case 'workspace.list':
        return { result: { workspaces: spaces.map((w) => ({ ...w })) } }
      case 'pane.list':
        return { result: { panes: panes.filter((x) => x.workspace_id === p.workspace_id).map(({ text, ...x }) => x) } }
      case 'workspace.create':
        return { result: space(p.label, p.cwd) }
      case 'worktree.create': {
        const at = p.path ?? join(dir, p.branch)
        return { result: { ...space(p.label, at, { checkout_path: at, is_linked_worktree: true, repo_root: p.cwd ?? dir }), worktree: { path: at } } }
      }
      case 'tab.create': {
        if (!spaces.some((w) => w.workspace_id === p.workspace_id)) return no('workspace_not_found', 'no such workspace')
        const x = pane(p.workspace_id, p.cwd)
        return { result: { tab: { tab_id: x.tab_id }, root_pane: { pane_id: x.pane_id } } }
      }
      case 'agent.start': {
        if (!panes.some((x) => x.pane_id === p.pane_id)) return no('pane_not_found', 'pane not found')
        const a: Agent = { name: p.name, pane_id: p.pane_id, agent: p.kind, agent_status: 'idle' }
        agents.push(a)
        return { result: { agent: a } }
      }
      case 'agent.get': {
        const a = agents.find((x) => x.name === p.target || x.pane_id === p.target)
        return a ? { result: { agent: a } } : no('agent_not_found', `agent target ${p.target} not found`)
      }
      case 'agent.list':
        return { result: { agents } }
      case 'agent.prompt': {
        const a = agents.find((x) => x.name === p.target)
        if (!a) return no('agent_not_found', `agent target ${p.target} not found`)
        const x = panes.find((q) => q.pane_id === a.pane_id)!
        x.text += `${p.text}\n`
        return { result: {} }
      }
      case 'pane.read': {
        const x = panes.find((q) => q.pane_id === p.pane_id)
        return x ? { result: { read: { text: x.text } } } : no('pane_not_found', 'pane not found')
      }
      case 'pane.process_info':
        return { result: { process_info: {} } }
      case 'workspace.rename': {
        const w = spaces.find((x) => x.workspace_id === p.workspace_id)
        if (w) w.label = p.label
        return { result: {} }
      }
      case 'pane.close': {
        const i = panes.findIndex((q) => q.pane_id === p.pane_id)
        if (i < 0) return no('pane_not_found', 'pane not found')
        panes.splice(i, 1)
        return { result: {} }
      }
      default:
        return no('unknown_method', method)
    }
  }

  const serve = (c: Socket) => {
    sockets.add(c)
    c.on('close', () => sockets.delete(c))
    c.on('error', () => undefined)
    let buf = ''
    c.on('data', (d) => {
      buf += d.toString()
      const i = buf.indexOf('\n')
      if (i < 0) return
      const req = JSON.parse(buf.slice(0, i)) as { id: string; method: string; params?: Record<string, unknown> }
      buf = buf.slice(i + 1)
      // a subscription stays open and quiet: nothing here changes without being asked
      if (req.method === 'events.subscribe') return void c.write(`${JSON.stringify({ id: req.id, result: { type: 'subscription_started' } })}\n`)
      requests.push({ method: req.method, params: req.params ?? {} })
      const f = failures.get(req.method)?.shift()
      if (f === 'drop') return void c.destroy()
      if (f === 'reset') return void ((c as Socket & { resetAndDestroy?: () => void }).resetAndDestroy ? (c as Socket & { resetAndDestroy: () => void }).resetAndDestroy() : c.destroy())
      if (f === 'hang') return
      const done = act(req.method, (req.params ?? {}) as Record<string, any>)
      if (f === 'drop-after') return void c.destroy()
      c.write(`${JSON.stringify({ id: req.id, ...done })}\n`)
      c.end()
    })
  }

  return {
    path,
    spaces,
    panes,
    agents,
    requests,
    count: (method: string) => requests.filter((r) => r.method === method).length,
    /** the next requests of `method` fail this way, one each */
    fail: (method: string, ...how: Failure[]) => failures.set(method, [...(failures.get(method) ?? []), ...how]),
    /** a workspace, as one made before the test */
    space,
    pane,
    listen: () =>
      new Promise<void>((resolve) => {
        rmSync(path, { force: true })
        server = createServer(serve).listen(path, resolve)
      }),
    /** herdr goes away: its socket is not there any more */
    stop: () => {
      for (const c of sockets) c.destroy()
      server?.close()
      server = undefined
      rmSync(path, { force: true })
    },
  }
}
