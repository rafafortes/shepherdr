// A Claude Code on the API key login runs headless: one `claude -p` per turn, never the interactive TUI. Anthropic's
// API credits pay for headless runs (the Agent SDK and `claude -p` with an API key), while interactive Claude Code on a
// key is billed to purchased credits (https://support.claude.com/en/articles/17154008). So such an agent is a small
// runner (scripts/claude-headless.ts) in its herdr pane: it takes each message Shepherdr hands it as the next turn,
// `claude -p --resume <its session>` with the same settings file, model, effort and instructions the interactive one
// would have, and shows the turn in the pane. Its session log is the one the interactive CLI would write, so the chat
// reads it as before, and a restart on the other login resumes the same session.
//
// The runner and Shepherdr share one folder per agent (its name): spec.json (what to run), inbox/ (one file per
// message, oldest first) and state.json (the runner's pid, whether a turn runs, the last turn's error).
import { join } from 'node:path'
import { boxDir, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from './mfs.ts'

/** the permission mode a headless turn runs in: no prompt can be answered, so Claude Code's auto mode decides */
export const HEADLESS_MODE = 'auto'

/** what the runner runs: claude's arguments without the session ones (it adds --session-id the first time, --resume
 *  after), the session, where its log is, and the environment Shepherdr gives its agents */
export interface HeadlessSpec {
  claude: string
  args: string[]
  sessionId: string
  log: string
  cwd: string
  env: Record<string, string>
}

/** what the runner says of itself */
export interface HeadlessState {
  pid: number
  /** a turn runs now */
  working: boolean
  /** the claude process of that turn */
  child?: number
  /** turns run since it started */
  turns: number
  /** why the last turn failed, in claude's words */
  error?: string
  at: number
}

/** its folder */
export const headlessDir = (name: string) => join(boxDir(), 'headless', name.replace(/[^A-Za-z0-9_.-]+/g, '-'))

/** the runner's spec, written before it starts (and again at each start: a restart may change model or effort) */
export function writeSpec(name: string, spec: HeadlessSpec) {
  const dir = headlessDir(name)
  mkdirSync(join(dir, 'inbox'), { recursive: true })
  // a run of its own: an earlier runner's state is not this one's
  writeAtomic(join(dir, 'state.json'), '')
  writeAtomic(join(dir, 'spec.json'), JSON.stringify(spec, null, 2))
  return dir
}

let seq = 0
/** one message, the next turn after those already waiting */
export function writeInbox(name: string, text: string) {
  const dir = join(headlessDir(name), 'inbox')
  mkdirSync(dir, { recursive: true })
  writeAtomic(join(dir, `${Date.now().toString().padStart(15, '0')}-${String(seq++ % 1e6).padStart(6, '0')}.txt`), text)
}

/** messages not taken yet */
export function inboxCount(name: string) {
  try {
    return readdirSync(join(headlessDir(name), 'inbox')).filter((f) => f.endsWith('.txt')).length
  } catch {
    return 0
  }
}

/** what the runner last said of itself, while its process lives; nothing when it is gone or never started */
export function readState(name: string, alive = isAlive): HeadlessState | undefined {
  try {
    const s = JSON.parse(readFileSync(join(headlessDir(name), 'state.json'), 'utf8')) as HeadlessState
    return s?.pid && alive(s.pid) ? s : undefined
  } catch {
    return undefined
  }
}

export function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** the runner's turn stopped, as Esc stops an interactive one: the runner passes it to claude as an interrupt */
export function interruptTurn(name: string) {
  const s = readState(name)
  if (!s) return false
  try {
    process.kill(s.pid, 'SIGUSR2')
    return true
  } catch {
    return false
  }
}

/** the line typed into its pane: the runner, under Shepherdr's own runtime */
export function runnerCommand(root: string, name: string, runtime = process.execPath) {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return `exec ${q(runtime)} ${q(join(root, 'scripts', 'claude-headless.ts'))} ${q(headlessDir(name))}`
}

/** claude's arguments without its session ones: the runner chooses those turn by turn */
export function withoutSession(args: string[]) {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume' || args[i] === '--session-id') i++
    else out.push(args[i])
  }
  return out
}

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

export const exists = existsSync
