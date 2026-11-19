// What an agent's pane leaves running after it closes: an MCP server, that server's puppeteer Chrome, a dev or proof
// server the task started. Closing the CLI kills only the pane's foreground child; its grandchildren are reparented
// to init and keep holding memory for days (RES-03). Two halves:
//   1. On close, capture what runs under the pane's shell before herdr closes it, then end what survived the close.
//   2. Hourly, find what escaped earlier and name it in `shepherdr doctor` with a ready kill line. Auto-ending the
//      proof-marked ones is off until the operator answers the open question; everything else is report-only.
//
// Linux reads a parent, command, working directory and environment from /proc/<pid>. Without /proc (macOS) `ps
// -axo pid=,ppid=,command=` gives the parent and command only: no cwd, no environment, so the sweep cannot recognise
// proof homes or removed worktrees there; the close reap still works from ancestry alone. Both readers are injected
// here and tested with stand-in tables.
//
// Never touched: a process of another user (the Linux reader filters by uid), Shepherdr's own agent-browser Chrome of
// a live task (browser.ts sweeps those), a process that cannot be tied to the closing pane's shell or to one of
// Shepherdr's own worktrees/proof homes.
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** one process and as much as the platform tells about it. `ppid` is what ties it to a pane's shell. */
export interface Row {
  pid: number
  ppid: number
  cmd: string
  cwd: string
  /** SHEPHERDR_HOME from its environment, where the environment can be read */
  home?: string
  /** the process's uid, where the platform tells it */
  uid?: number
}

/** where a process table comes from; injected in tests so nothing here reads the operator's processes to be tested */
export interface Source {
  platform: string
  pids(): string[]
  read(path: string): string
  link(path: string): string
  selfUid(): number | null
  /** macOS: `ps -axo pid=,ppid=,command=` */
  ps(): string
  now(): number
}

/** the machine's own process table */
export const systemSource: Source = {
  platform: process.platform,
  pids: () => (process.platform === 'linux' ? readdirSync('/proc').filter((n) => /^\d+$/.test(n)) : []),
  read: (p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return ''
    }
  },
  link: (p) => {
    try {
      return readlinkSync(p)
    } catch {
      return ''
    }
  },
  selfUid: () => process.getuid?.() ?? null,
  // coverage-exempt: this host is Linux; the macOS reader is tested with a stand-in `ps` table below
  ps: () => Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,command='], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString(),
  now: () => Date.now(),
}

/** one /proc entry as a row, or null when it is gone or belongs to another user */
export function rowFromProc(pid: number, s: Source): Row | null {
  const stat = s.read(`/proc/${pid}/stat`)
  if (!stat) return null
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const ppid = Number(f[1])
  if (!Number.isFinite(ppid) || ppid < 0) return null
  const uid = Number(/^Uid:\s*(\d+)/m.exec(s.read(`/proc/${pid}/status`))?.[1])
  const me = s.selfUid()
  if (me !== null && Number.isFinite(uid) && uid !== me) return null
  const home = s
    .read(`/proc/${pid}/environ`)
    .split('\0')
    .find((v) => v.startsWith('SHEPHERDR_HOME='))
    ?.slice('SHEPHERDR_HOME='.length)
  return {
    pid,
    ppid,
    cmd: s.read(`/proc/${pid}/cmdline`).split('\0').filter(Boolean).join(' '),
    cwd: s.link(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, ''),
    ...(home ? { home } : {}),
    ...(Number.isFinite(uid) ? { uid } : {}),
  }
}

/** the Linux reader: one read of the process table, then each entry of ours */
export function rowsFromProc(s: Source): Row[] {
  const out: Row[] = []
  for (const name of s.pids()) {
    const r = rowFromProc(Number(name), s)
    if (r) out.push(r)
  }
  return out
}

/** the macOS reader: `ps -axo pid=,ppid=,command=` gives ancestry and the command, not cwd or environment */
export function rowsFromPs(s: Source): Row[] {
  const out: Row[] = []
  for (const line of s.ps().split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3], cwd: '' })
  }
  return out
}

/** the process table, whatever this platform gives */
export function readRows(s: Source): Row[] {
  return s.platform === 'linux' ? rowsFromProc(s) : rowsFromPs(s)
}

/** only what a close needs: parent and command, to walk the shell's tree and leave shared browsers out. No cwd or
 *  environment reads, and no uid read: anything under our own shell is ours, and this runs on every agent finish on a
 *  host with thousands of processes (two reads each, against the hourly sweep's five). */
export function readTree(s: Source): Row[] {
  if (s.platform !== 'linux') return rowsFromPs(s)
  const out: Row[] = []
  for (const name of s.pids()) {
    const stat = s.read(`/proc/${name}/stat`)
    if (!stat) continue
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ppid = Number(f[1])
    if (!Number.isFinite(ppid) || ppid < 0) continue
    out.push({ pid: Number(name), ppid, cmd: s.read(`/proc/${name}/cmdline`).split('\0').filter(Boolean).join(' '), cwd: '' })
  }
  return out
}

/** every process that runs under shellPid now, the shell itself left out (herdr closes that one) */
export function descendants(rows: Row[], shellPid: number): number[] {
  if (!shellPid || shellPid <= 1) return []
  const kids = new Map<number, number[]>()
  for (const r of rows) if (r.ppid > 1) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid])
  const out: number[] = []
  const seen = new Set([shellPid])
  const queue = [shellPid]
  while (queue.length) {
    const p = queue.shift()!
    for (const c of kids.get(p) ?? [])
      if (!seen.has(c)) {
        seen.add(c)
        out.push(c)
        queue.push(c)
      }
  }
  return out
}

/** agent-browser starts a task's shared Chrome with `--user-data-dir=<profiles>/browser/<task id>`. It belongs to
 *  browser.ts's sweep: a live task's browser must never be ended here. Puppeteer's /tmp profiles do not match. */
export const isAgentBrowser = (cmd: string) => /--user-data-dir=\S*\/browser\/[A-Za-z0-9]+-\d+/.test(cmd)

/** what runs under the pane's shell now and is ours to end when the pane closes. A shared browser is left out with
 *  everything under it: its zygote and crashpad children have no profile flag of their own, and browser.ts owns them. */
export function capture(rows: Row[], shellPid: number): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const caught = descendants(rows, shellPid)
  const excluded = new Set(caught.filter((pid) => isAgentBrowser(byPid.get(pid)?.cmd ?? '')))
  for (;;) {
    const more = caught.filter((pid) => !excluded.has(pid) && excluded.has(byPid.get(pid)?.ppid ?? -1))
    if (!more.length) break
    for (const pid of more) excluded.add(pid)
  }
  return caught.filter((pid) => !excluded.has(pid) && pid !== process.pid)
}

/** how a process is signalled and watched; injected in tests, real ones below */
export interface EndDeps {
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): void
  alive(pid: number): boolean
  wait(ms: number): Promise<void>
}

export const endDeps: EndDeps = {
  signal: (pid, sig) => {
    try {
      process.kill(pid, sig)
    } catch {
      /* gone already */
    }
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  wait: (ms) => Bun.sleep(ms),
}

/** ask the survivors to end, then insist. The short waits keep a pane close from hanging the server. Returns any
 *  that still run, so a caller can name what it could not end. */
export async function end(pids: number[], d: EndDeps, graceMs = 1200): Promise<number[]> {
  let left = pids.filter((p) => p > 1 && p !== process.pid && d.alive(p))
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
    if (!left.length) break
    for (const pid of left) d.signal(pid, sig)
    await d.wait(sig === 'SIGTERM' ? graceMs : 50)
    left = left.filter(d.alive)
  }
  return left
}

/* ---------- what already escaped ---------- */

export type Kind = 'proof' | 'worktree'

export interface Finding {
  pid: number
  cmd: string
  cwd: string
  home?: string
  kind: Kind
  /** why it was found, for the doctor line */
  why: string
  /** the ready command the human can paste */
  kill: string
}

export interface ScanOpts {
  /** where Shepherdr's task worktrees live: ~/.herdr/worktrees/<repo>/<task> */
  worktrees: string
  /** whether a path still exists: a worktree Shepherdr put away is gone */
  exists: (path: string) => boolean
}

export const scanOpts: ScanOpts = { worktrees: join(homedir(), '.herdr', 'worktrees'), exists: existsSync }

/** a SHEPHERDR_HOME under /tmp is the marker a proof server's gate gives it (launch-policy.ts, docs/develop.md) */
export const proofHome = (home: string | undefined) => !!home && home.startsWith('/tmp/')

/** a cwd under ~/.herdr/worktrees/<repo>/<task>, and the worktree folder itself */
function worktreeRoot(cwd: string, o: ScanOpts): string | undefined {
  if (!cwd.startsWith(`${o.worktrees}/`)) return undefined
  const [repo, task] = cwd.slice(o.worktrees.length + 1).split('/')
  return repo && task ? join(o.worktrees, repo, task) : undefined
}

/** a cwd under ~/.herdr/worktrees/<repo>/<task> whose worktree folder no longer exists */
export function removedWorktree(cwd: string, o: ScanOpts): boolean {
  const plain = cwd.replace(/ \(deleted\)$/, '')
  const root = worktreeRoot(plain, o)
  return !!root && (plain === root || plain.startsWith(`${root}/`)) && !o.exists(root)
}

/** a cwd under a worktree that is still there belongs to a live task: its proof server and its tests are not orphans,
 *  and must never be reported or ended (even if the proof mark would otherwise catch them) */
export function liveWorktree(cwd: string, o: ScanOpts): boolean {
  const root = worktreeRoot(cwd.replace(/ \(deleted\)$/, ''), o)
  return !!root && o.exists(root)
}

/** the executable a command runs, not its arguments: a task's server often names its worktree in an argument, and
 *  `~/.herdr/worktrees/...` would otherwise look like the herdr daemon */
const exe = (cmd: string) => (cmd.split(/\s+/)[0] ?? '').split('/').at(-1) ?? ''
const HERDR_EXE = /^herdr(?:-[a-z0-9-]+)?$/i

/** a process whose ancestry reaches the herdr daemon runs in a live pane: an agent, a shell, a helper or a server it
 *  started. Even when its worktree has since gone, it is a live task's and is never a finding or a kill candidate. */
export function underHerdr(pid: number, byPid: Map<number, Row>): boolean {
  let p = pid
  for (let i = 0; i < 64; i++) {
    const row = byPid.get(p)
    if (!row) return false
    if (HERDR_EXE.test(exe(row.cmd))) return true
    if (row.ppid <= 1) return false
    p = row.ppid
  }
  return false
}

/** processes of finished tasks that still run: proof homes and cwds under removed worktrees. Nothing is ended here. */
export function scan(rows: Row[], o: ScanOpts = scanOpts): Finding[] {
  const out: Finding[] = []
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  for (const r of rows) {
    if (r.pid <= 1 || r.pid === process.pid || isAgentBrowser(r.cmd) || underHerdr(r.pid, byPid)) continue
    const cwd = r.cwd.replace(/ \(deleted\)$/, '')
    if (liveWorktree(cwd, o)) continue // a live task's work: never a finding, never a kill candidate
    const proof = proofHome(r.home)
    const gone = removedWorktree(cwd, o)
    if (!proof && !gone) continue
    const why = proof && gone ? `SHEPHERDR_HOME ${r.home} and cwd in a removed worktree ${cwd}` : proof ? `SHEPHERDR_HOME ${r.home}` : `cwd in a removed worktree ${cwd}`
    out.push({ pid: r.pid, cmd: r.cmd, cwd, ...(r.home ? { home: r.home } : {}), kind: proof ? 'proof' : 'worktree', why, kill: `kill -TERM ${r.pid}` })
  }
  return out
}

/** only proof-marked ones are even candidates for auto-ending, and that is off until the operator decides */
export const proofPids = (found: Finding[]) => found.filter((f) => f.kind === 'proof').map((f) => f.pid)

/** how many a doctor line or the news names before "and N more": a phone's screen, and one kill command, stay short */
export const SHOWN = 8

/** the doctor's resource lines: a header with one ready command, then each process with its reason. None when clean.
 *  The kill line names only proof-marked pids, the ones that may ever be ended; a report-only one keeps its own line.
 *  Both are from the last hourly look, so a pid may have gone (or been reused) since. */
export function lines(found: Finding[]): string[] {
  if (!found.length) return []
  const proof = proofPids(found)
  const ready = (proof.length ? proof : found.slice(0, 1).map((f) => f.pid)).slice(0, SHOWN)
  const more = ready.length < (proof.length || 1) ? ` (first ${SHOWN})` : ''
  const shown = found
    .slice(0, SHOWN)
    .map((f) => `  pid ${f.pid}: ${f.cmd.slice(0, 90) || '(no command)'} — ${f.why}; end it: ${f.kill}${f.kind === 'proof' ? ' (proof-marked; auto-end is off until the operator decides)' : ''}`)
  if (found.length > SHOWN) shown.push(`  ... and ${found.length - SHOWN} more (not shown; each keeps its own ready kill line in the sweep)`)
  return [`Orphaned processes (RES-03): ${found.length} found at the last hourly look. End ${proof.length ? 'the proof-marked ones' : 'one'} with: kill -TERM ${ready.join(' ')}${more}`, ...shown]
}

/** the news when the set changes: each one named, capped, with the ready command */
export function newsLine(found: Finding[], ended: number[]): string {
  const names = found.slice(0, SHOWN).map((f) => `pid ${f.pid} (${f.cmd.slice(0, 60) || 'process'})`)
  const more = found.length > SHOWN ? ` and ${found.length - SHOWN} more` : ''
  const said = ended.length ? `Ended ${ended.length} proof-marked: ${ended.slice(0, SHOWN).join(', ')}${more}. ` : ''
  return `${said}Orphans of finished tasks still running: ${names.join(', ')}${more}. End one with kill -TERM <pid>.`
}
