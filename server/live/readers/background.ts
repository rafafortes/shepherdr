// Work an agent started in the background that outlives its turn, and wakes it when it ends: a turn that ends while one
// runs is a pause, not a question.
// Claude Code runs subagents, shells and monitors in the background and wakes the agent when one finishes or reports. It
// says so itself in its session file (~/.claude/sessions/<pid>.json): "busy" while a background agent runs, "shell"
// while only shells or monitors do, "idle" once nothing does. Its screen says so too, and is read when there is no
// session file: "✻ Waiting for 1 background agent to finish", "✻ … · done 10:04 PM · 1 shell, 1 monitor still running",
// the footer's "· 2 shells ·" and a row per subagent below it. Antigravity (agy) runs its long commands in the background
// too, and its screen shows them below the input box (agyScreenBackground).
// OpenCode (2.3) keeps its background shells under a pty daemon of its own (opencode-pty, a child of its server): each is
// a `/bin/sh -c <command>` whose environment carries the agent's SHEPHERDR_CHAT, and its footer counts them ("↓ 1 shell",
// "↓ 1 subagent · 2 shells"). It wakes the agent when one ends ("↳ Shell finished · cd … && tools/changed-check.sh"), so
// a shell still running is a pause as well (Procs.shells).
// Codex keeps a command running past its turn (a process with a session id in its output, its code mode's cell), but is
// never woken by it, and pi 1.5.2 has no background shell at all (its bash tool is one command it waits on; only a herdr
// child it spawned wakes it, through pi-herdr's delivery, which is not read here): their turn's end waits on you.
// A shell that ends (a test run, a review) wakes it, however long it takes; one that serves or watches (a dev server it
// left for you to look at) never does. Claude Code's hooks name each shell's command, which tells them apart (hooks.ts);
// OpenCode's are told apart by the command its daemon runs (servesCommand).
// A shell that runs a headless reviewer of another CLI (codex exec, claude -p: a task agent's own reviewer) wakes it like a
// subagent, however long it takes: it is found by its command and its SHEPHERDR_CHAT (/proc, or ps), and counts as one.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { claudeHome } from './find.ts'

/** what still runs: a subagent (maybe with shells of its own), shells and monitors (a test run, a review: they end and
 *  wake it), or only servers (a dev server, a preview, a watcher: they never end, its hooks tell them by their words) */
export type Background = 'agents' | 'shells' | 'servers'

/** a session file's status, as background work */
export function sessionBackground(status: string | undefined): Background | undefined {
  return status === 'busy' ? 'agents' : status === 'shell' ? 'shells' : undefined
}

const RULE = /^\s*─{20,}\s*$/

/** the screen of a Claude Code whose turn ended, as background work: what its input box and footer say */
export function screenBackground(screen: string): Background | undefined {
  const lines = screen.split('\n').map((l) => l.trimEnd())
  // the input box is two rules around the prompt; the footer and a row per running agent come after it
  const rules = lines.flatMap((l, i) => (RULE.test(l) ? [i] : []))
  if (rules.length < 2) return undefined
  const [top, bottom] = rules.slice(-2)
  const above = lines.slice(0, top).filter((l) => l.trim()).at(-1) ?? ''
  const [footer = '', ...rows] = lines.slice(bottom + 1).filter((l) => l.trim())
  if (/Waiting for \d+ background agents? to finish/.test(above) || rows.some((r) => /^\s*[◯○●◉]\s+(?!main\s*$)\S/.test(r))) return 'agents'
  if (/·.*\bstill running\s*$/.test(above) || /(^|·)\s*\d+ (shells?|monitors?)\b/.test(footer)) return 'shells'
  return undefined
}

/** a row of agy's background commands below its input box: "● [06:57:43] <command> running" */
const AGY_ROW = /^\s*● \[\d{2}:\d{2}:\d{2}\] /

/** the screen of an agy whose turn ended, as background work: its footer's task count, or its rows of background commands
 *  below the input box, which agy draws between the box and another rule above the footer (the footer then reads
 *  "· 2 task(s)"; with none, its footer has no count and there are no rows). A row above the box is the chat's own */
export function agyScreenBackground(screen: string): Background | undefined {
  const lines = screen.split('\n').map((l) => l.trimEnd())
  const rules = lines.flatMap((l, i) => (RULE.test(l) ? [i] : []))
  if (rules.length < 2) return undefined
  const footer = lines.filter((l) => l.trim()).at(-1) ?? ''
  const tasks = /·\s*(\d+) task\(s\)/.exec(footer)
  if (tasks && Number(tasks[1]) >= 1) return 'shells'
  // the input box: the last prompt line ("> …") with a rule right above it
  const box = lines.findLastIndex((l, i) => /^\s*>/.test(l) && RULE.test(lines[i - 1] ?? ''))
  return box >= 0 && lines.slice(box + 1).some((l) => AGY_ROW.test(l)) ? 'shells' : undefined
}

interface SessionFile {
  pid: number
  sessionId?: string
  cwd?: string
  status?: string
  updatedAt?: number
  /** "interactive" for one in a terminal */
  kind?: string
}

/** the Claude Code that wrote it still runs: its pid is there and, where /proc says when it started, is the same
 *  process, not a new one that got a dead one's pid */
const alive = (pid: number, procStart?: string) => {
  try {
    process.kill(pid, 0)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  if (!procStart) return true
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19] === procStart
  } catch {
    return true
  }
}

/** a session file is read at most this often */
const FRESH_MS = 1000
/** the folder is looked through again for one not found, at most this often */
const RESCAN_MS = 5000

/** Claude Code's session files: which belongs to an agent, and what it says now */
export class ClaudeSessions {
  private files = new Map<string, string>()
  private read = new Map<string, { at: number; s: SessionFile | null }>()
  private scanAt = 0

  constructor(private dir = () => join(claudeHome(), 'sessions')) {}

  private load(f: string, now: number): SessionFile | null {
    const c = this.read.get(f)
    if (c && now - c.at < FRESH_MS) return c.s
    let s: SessionFile | null = null
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'))
      if (j && typeof j.pid === 'number' && alive(j.pid, typeof j.procStart === 'string' ? j.procStart : undefined)) s = j
    } catch {
      /* gone, or half written */
    }
    this.read.set(f, { at: now, s })
    return s
  }

  /** every session file, by "id:<session id>" and by "cwd:<folder>" (the newest there), looked through again at most
   *  every RESCAN_MS */
  private scan(now: number) {
    if (now - this.scanAt < RESCAN_MS) return
    this.scanAt = now
    this.files.clear()
    const newest = new Map<string, number>()
    let names: string[] = []
    try {
      names = readdirSync(this.dir()).filter((n) => /^\d+\.json$/.test(n))
    } catch {
      /* no sessions folder */
    }
    for (const n of names) {
      const f = join(this.dir(), n)
      const s = this.load(f, now)
      if (!s || (s.kind && s.kind !== 'interactive')) continue
      if (s.sessionId) this.files.set(`id:${s.sessionId}`, f)
      if (s.cwd && (s.updatedAt ?? 0) >= (newest.get(s.cwd) ?? -1)) {
        newest.set(s.cwd, s.updatedAt ?? 0)
        this.files.set(`cwd:${s.cwd}`, f)
      }
    }
  }

  /** the session file of the Claude Code with this session id, else the newest one running in any candidate folder
   *  (a remembered path and its real path name the same folder to a symlinked space) */
  private find(sessionId: string | undefined, cwd: string | string[], now: number): SessionFile | null {
    const cwds = Array.isArray(cwd) ? cwd : [cwd]
    const look = () => {
      for (const k of [sessionId && `id:${sessionId}`, ...cwds.map((c) => `cwd:${c}`)]) {
        const f = k && this.files.get(k)
        const s = f && this.load(f, now)
        if (s && (s.sessionId === sessionId || (s.cwd && cwds.includes(s.cwd)))) return s
      }
      return null
    }
    const s = look()
    if (s) return s
    this.scan(now)
    return look()
  }

  /** what its session file says now ("busy", "shell", "idle", …), or nothing when there is none */
  status(sessionId: string | undefined, cwd: string | string[], now = Date.now()): string | undefined {
    const s = this.find(sessionId, cwd, now)
    return s ? (s.status ?? 'idle') : undefined
  }
}

/** a headless one-shot of a CLI, as a task agent may run a reviewer: codex exec, claude -p, pi -p, opencode run, agy -p */
export function headless(argv: string[]): boolean {
  const bin = (i: number) => argv[i]?.split('/').at(-1) ?? ''
  // node, bun and the like run the CLI's script: look past them
  const at = /^(node|bun|deno)$/.test(bin(0)) ? 1 : 0
  const cli = bin(at).replace(/\.(js|mjs|cjs)$/, '')
  const rest = argv.slice(at + 1)
  if (cli === 'codex') return rest[0] === 'exec' || rest[0] === 'e'
  if (cli === 'claude' || cli === 'pi') return rest.includes('-p') || rest.includes('--print')
  if (cli === 'opencode') return rest[0] === 'run'
  if (cli === 'agy') return rest.includes('-p') || rest.includes('--print') || rest.includes('--prompt')
  return false
}

/** a shell that serves or watches (a dev server, a preview, tail -f) never ends to wake the agent it runs under: a
 *  "server", by what its command says */
export const servesCommand = (command: string) =>
  /\b(npm|pnpm|yarn|bun)( run)? (dev|start|serve|preview)\b|\b(vite|next|astro|nuxt|remix|wrangler|vercel|netlify) dev\b|\bvite( preview)?\s*($|[;&|])|http\.server|\b(uvicorn|gunicorn|flask run|rails s(erver)?)\b|\bnpx serve\b|--(watch|hot)\b|\btail -[fF]\b|sleep infinity/.test(command)

/** a shell a CLI runs a command with: `/bin/sh -c <command>`, as OpenCode's pty daemon starts its background shells (a
 *  login or interactive one, `-lc` or `-ic`, runs a command just the same) */
export const shellCommand = (argv: string[]) => /^(ba|z|da)?sh$/.test(argv[0]?.split('/').at(-1) ?? '') && argv.some((w) => /^-[a-z]*c[a-z]*$/.test(w))

/** /proc is read again at most this often */
const PROC_MS = 2000
/** how long a process is read again each pass before it is taken as the plain one it looks like */
const PLAIN_FOR = 30_000

/**
 * The processes of this machine that matter to the chats: the headless reviewers one runs (a reviewer of another CLI is
 * a shell to Claude Code, but it will wake the agent once it ends, like a subagent, however long it takes), and the
 * background shells OpenCode keeps under its pty daemon (they wake it too). A process's environment says whose it is
 * (SHEPHERDR_CHAT, which every agent Shepherdr starts has, and its shells after it): read from /proc, or where there is
 * none (macOS) from `ps -E`, which prints each command with its environment after it.
 */
/** a headless CLI that runs: its words, since when, and its process (where /proc tells) */
export interface Headless {
  argv: string[]
  at: number
  pid?: number
}

export class Procs {
  private at = 0
  private chats = new Map<string, Headless[]>()
  /** OpenCode's background shells now, by chat: the commands its pty daemon still runs for it */
  private running = new Map<string, string[][]>()
  /** the processes known to be one of those, by pid, so each is not looked at again to find out */
  private tracked = new Map<string, { chat: string; argv: string[] }>()
  /** the pids of OpenCode's pty daemons: their children are those shells (they live as long as the agent) */
  private daemons = new Set<string>()
  /** when each was first seen, where nothing says when it started (ps) */
  private first = new Map<string, number>()

  constructor(
    private proc = '/proc',
    private ps = () => Bun.spawnSync(['ps', '-axwwE', '-o', 'command='], { stdout: 'pipe', stderr: 'ignore', timeout: 3000 }).stdout.toString(),
  ) {}

  runs(chat: string, now = Date.now()): boolean {
    return this.list(chat, now).length > 0
  }

  /** the headless CLIs this chat's agent runs now */
  list(chat: string, now = Date.now()): Headless[] {
    if (now - this.at >= PROC_MS) {
      this.at = now
      this.chats = this.scan(now)
    }
    return this.chats.get(chat) ?? []
  }

  /** the commands a chat's OpenCode still runs after its turn, under its own pty daemon: work that wakes it when it ends */
  shells(chat: string, now = Date.now()): string[][] {
    this.list(chat, now)
    return this.running.get(chat) ?? []
  }

  private add<T>(found: Map<string, T[]>, chat: string, what: T) {
    const list = found.get(chat) ?? []
    list.push(what)
    found.set(chat, list)
  }

  /** a process's command line, or nothing when it is gone (a zombie's is empty) */
  private argv(pid: string): string[] {
    try {
      return readFileSync(join(this.proc, pid, 'cmdline'), 'utf8').split('\0').filter(Boolean)
    } catch {
      return []
    }
  }

  /** the chat a process works for: the SHEPHERDR_CHAT its environment carries (every agent Shepherdr starts has one,
   *  and its shells after it) */
  private chatOf(pid: string): string | undefined {
    try {
      return readFileSync(join(this.proc, pid, 'environ'), 'utf8').split('\0').find((v) => v.startsWith(CHAT))?.slice(CHAT.length) || undefined
    } catch {
      return undefined
    }
  }

  /** its parent is an OpenCode pty daemon, which is what an OpenCode background shell is a child of */
  private underDaemon(pid: string): boolean {
    let ppid: string
    try {
      ppid = readFileSync(join(this.proc, pid, 'stat'), 'utf8').split(') ').at(-1)!.split(' ')[1] ?? ''
    } catch {
      return false
    }
    if (!ppid || ppid === '0' || ppid === '1') return false
    if (this.daemons.has(ppid)) return true
    const parent = this.argv(ppid)
    if (!parent.some((w) => /(^|\/)opencode-pty$/.test(w)) || !parent.includes('daemon')) return false
    this.daemons.add(ppid)
    return true
  }

  /** the processes seen the last pass that are no headless CLI, and when each was first seen: a process keeps its command
   *  line, so one older than PLAIN_FOR is not read again until it is gone (a busy machine has thousands of them, and this
   *  ran for all of them every pass). A younger one is read again, since a shell that execs a CLI changes it */
  private plain = new Map<string, number>()

  private scan(now: number) {
    let pids: string[]
    try {
      pids = readdirSync(this.proc).filter((n) => /^\d+$/.test(n))
    } catch {
      return this.fromPs()
    }
    const chats = new Map<string, Headless[]>()
    const running = new Map<string, string[][]>()
    const plain = new Map<string, number>()
    // one that ended is forgotten: its pid may come back as another
    const live = new Set(pids)
    for (const pid of [...this.tracked.keys()]) if (!live.has(pid)) this.tracked.delete(pid)
    for (const pid of [...this.daemons]) if (!live.has(pid)) this.daemons.delete(pid)
    // the shells known from before, read again: one still running keeps its command line
    for (const [pid, known] of [...this.tracked]) {
      const argv = this.argv(pid)
      if (!argv.length) {
        this.tracked.delete(pid)
        continue
      }
      known.argv = argv
      this.add(running, known.chat, argv)
    }
    for (const pid of pids) {
      if (this.tracked.has(pid)) continue
      const since = this.plain.get(pid)
      if (since !== undefined && now - since > PLAIN_FOR) {
        plain.set(pid, since)
        continue
      }
      // an empty command line is a process still starting (or a kernel thread): looked at again next pass
      const argv = this.argv(pid)
      if (!argv.length) continue
      const chat = this.chatOf(pid)
      if (headless(argv)) {
        // its folder in /proc is as old as it is; one that ended as the pass read it is left for the next pass
        const st = statSync(join(this.proc, pid), { throwIfNoEntry: false })
        if (chat && st) this.add(chats, chat, { argv, pid: Number(pid), at: st.ctimeMs })
        continue
      }
      // an OpenCode background shell: a command its own pty daemon still runs for this chat
      if (chat && shellCommand(argv) && this.underDaemon(pid)) {
        this.tracked.set(pid, { chat, argv })
        this.add(running, chat, argv)
        continue
      }
      plain.set(pid, since ?? now)
    }
    this.plain = plain
    this.running = running
    return chats
  }

  /** each line is a command and its words, then its environment: split on spaces, which is enough to tell a
   *  headless CLI by its first words and a chat key (which has none) by its variable */
  private fromPs() {
    const chats = new Map<string, Headless[]>()
    const running = new Map<string, string[][]>()
    let out = ''
    try {
      out = this.ps()
    } catch {
      this.running = running
      return chats
    }
    const seen = new Map<string, number>()
    for (const line of out.split('\n')) {
      const words = line.trim().split(/\s+/)
      const chat = words.find((w) => w.startsWith(CHAT))
      if (!chat) continue
      // its words end where its environment starts
      const env = words.findIndex((w) => /^[A-Z_][A-Z0-9_]*=/.test(w))
      const argv = env > 0 ? words.slice(0, env) : words
      const who = chat.slice(CHAT.length)
      // with no /proc to read a process's parent from, any shell carrying the chat is taken as one of its background
      // shells: the daemon it hangs under cannot be told there
      if (shellCommand(argv)) {
        this.add(running, who, argv)
        continue
      }
      if (!headless(argv)) continue
      const k = line.trim()
      seen.set(k, this.first.get(k) ?? Date.now())
      this.add(chats, who, { argv, at: seen.get(k)! })
    }
    this.first = seen
    this.running = running
    return chats
  }
}

const CHAT = 'SHEPHERDR_CHAT='
