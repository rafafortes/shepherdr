// Where each CLI keeps an agent's log file. Homes follow the CLIs' own settings: CLAUDE_CONFIG_DIR, CODEX_HOME,
// PI_CODING_AGENT_DIR (tests point these at fixtures).
import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { home } from '../../store.ts'
import { swallow } from '../debug.ts'
import { conversationLog } from '../agy.ts'
import { mirrorSession, newestSession, opencodeLogPath } from '../opencode.ts'

const env = (k: string) => process.env[k] || undefined

export const claudeHome = () => env('CLAUDE_CONFIG_DIR') ?? join(homedir(), '.claude')
export const codexHome = () => env('CODEX_HOME') ?? join(homedir(), '.codex')
export const piHome = () => env('PI_CODING_AGENT_DIR') ?? join(homedir(), '.pi', 'agent')

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/[/\\]+$/, '') : p)

/** A CLI's log folder is derived from a cwd. Shepherdr remembers the path a space was added with, but the CLI runs in
 *  the real path when that one is a symlink (a renamed repo leaves a link at the old name). One folder is never enough:
 *  the remembered path and its real path are two different folders to a CLI's log. */
export type LogCwd = string | string[]

/** The candidate cwds in preference order: the live agent's own cwd first when herdr knows it, then each given path's
 *  real path before the path itself (where the CLI writes is where the link resolves), deduped. A path that cannot be
 *  resolved still stands on its own, so a folder that does not exist here leaves the look going. */
export function cwdCandidates(remembered: LogCwd, live?: string | null): string[] {
  const out: string[] = []
  const add = (p?: string | null) => {
    if (typeof p !== 'string' || !p.trim()) return
    const c = trimSlash(p.trim())
    try {
      const real = trimSlash(realpathSync(c))
      if (real && !out.includes(real)) out.push(real)
    } catch {
      /* a path that is gone (or is not a link) still stands below */
    }
    if (c && !out.includes(c)) out.push(c)
  }
  add(live)
  for (const c of Array.isArray(remembered) ? remembered : [remembered]) add(c)
  return out
}

const cwds = (cwd: LogCwd): string[] => cwdCandidates(cwd)

/** newest .jsonl in the first candidate folder that has one changed at or after sinceMs; later folders are only looked
 *  in when the preferred one has no log, so old sessions from a link's former name are never read into this chat */
function newestLog(dirs: string | string[], reader: string, sinceMs = 0): string | undefined {
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    let best: { f: string; m: number } | undefined
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const f = join(dir, n)
      try {
        const m = statSync(f).mtimeMs
        if (m >= sinceMs && (!best || m > best.m)) best = { f, m }
      } catch (e) { swallow('log stat', e, reader, f) }
    }
    if (best) return best.f
  }
  return undefined
}

/* ---------- Claude Code ---------- */

// Claude Code names a project folder after its cwd with every character but letters and digits turned into '-';
// long names are cut at 200 characters and get a hash on the end
const MAX_NAME = 200

/** the project folder for a cwd */
export function claudeProjectDir(cwd: string): string {
  const root = join(claudeHome(), 'projects')
  const name = trimSlash(cwd).replace(/[^a-zA-Z0-9]/g, '-')
  const dir = join(root, name)
  if (name.length <= MAX_NAME || existsSync(dir)) return dir
  try {
    const hit = readdirSync(root).find((n) => n.startsWith(name.slice(0, MAX_NAME)))
    if (hit) return join(root, hit)
  } catch (e) { swallow('claude project dirs', e, 'claude', root) }
  return dir
}

/** every candidate project folder for a cwd (a remembered path and its real path are two) */
export function claudeProjectDirs(cwd: LogCwd): string[] {
  const dirs: string[] = []
  for (const c of cwds(cwd)) {
    const d = claudeProjectDir(c)
    if (!dirs.includes(d)) dirs.push(d)
  }
  return dirs
}

/** the log of a known session: the first candidate folder that holds it, else the first folder's path (where the CLI
 *  will write it). The same session in both folders is still one log. */
export function claudeLogPath(cwd: LogCwd, sessionId: string): string {
  const dirs = claudeProjectDirs(cwd)
  for (const d of dirs) {
    const f = join(d, `${sessionId}.jsonl`)
    if (existsSync(f)) return f
  }
  return join(dirs[0] ?? claudeProjectDir(typeof cwd === 'string' ? cwd : (cwd[0] ?? '')), `${sessionId}.jsonl`)
}

/** the newest Claude Code session log for this cwd, changed at or after sinceMs */
export const findClaudeLog = (cwd: LogCwd, sinceMs?: number) => newestLog(claudeProjectDirs(cwd), 'claude', sinceMs)

/* ---------- Codex ---------- */

/** the first line of a file (Codex's session_meta is ~20KB: it carries the system prompt) */
function firstLine(f: string, max = 1 << 20): string | undefined {
  let fd: number
  try {
    fd = openSync(f, 'r')
  } catch {
    return undefined
  }
  try {
    let text = ''
    const buf = Buffer.alloc(64 << 10)
    for (let pos = 0; pos < max; ) {
      const got = readSync(fd, buf, 0, buf.length, pos)
      if (got <= 0) break
      const nl = buf.subarray(0, got).indexOf(10)
      if (nl !== -1) return text + buf.toString('utf8', 0, nl)
      text += buf.toString('utf8', 0, got)
      pos += got
    }
    return undefined
  } finally {
    closeSync(fd)
  }
}

const ymd = (d: Date, utc: boolean) =>
  utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate()]

/** the day folders a session started since sinceMs can be in: today, yesterday and sinceMs's day, local and UTC */
function codexDayDirs(sinceMs?: number): string[] {
  const now = Date.now()
  const times = [now, now - 86_400_000]
  if (sinceMs) times.push(sinceMs)
  const dirs = new Set<string>()
  for (const t of times) {
    for (const utc of [false, true]) {
      const [y, m, d] = ymd(new Date(t), utc)
      dirs.add(join(codexHome(), 'sessions', String(y), String(m).padStart(2, '0'), String(d).padStart(2, '0')))
    }
  }
  return [...dirs]
}

/** the newest Codex rollout started in this cwd and changed at or after sinceMs (subagents' rollouts are left out).
 *  session_meta names the folder it started in: match it against every candidate, the link and the real path. */
export function findCodexLog(cwd: LogCwd, sinceMs = 0): string | undefined {
  const wants = new Set(cwds(cwd))
  const files: { f: string; m: number }[] = []
  for (const dir of codexDayDirs(sinceMs)) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.startsWith('rollout-') || !n.endsWith('.jsonl')) continue
      const f = join(dir, n)
      try {
        const m = statSync(f).mtimeMs
        if (m >= sinceMs) files.push({ f, m })
      } catch (e) { swallow('codex log stat', e, 'codex', f) }
    }
  }
  files.sort((a, b) => b.m - a.m)
  for (const { f } of files) {
    let meta: any
    try {
      meta = JSON.parse(firstLine(f) ?? '')
    } catch {
      continue
    }
    const p = meta?.type === 'session_meta' ? meta.payload : undefined
    if (!p || typeof p.cwd !== 'string' || !wants.has(trimSlash(p.cwd))) continue
    if (p.thread_source === 'subagent' || (p.source && typeof p.source === 'object' && 'subagent' in p.source)) continue
    return f
  }
  return undefined
}

/* ---------- pi ---------- */

/** pi names a session folder "--<cwd without its leading slash, / \ and : turned into ->--" */
export function piSessionDir(cwd: string): string {
  const name = `--${trimSlash(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(piHome(), 'sessions', name)
}

/** every candidate session folder for a cwd */
export function piSessionDirs(cwd: LogCwd): string[] {
  const dirs: string[] = []
  for (const c of cwds(cwd)) {
    const d = piSessionDir(c)
    if (!dirs.includes(d)) dirs.push(d)
  }
  return dirs
}

/** the newest pi session log for this cwd, changed at or after sinceMs */
export const findPiLog = (cwd: LogCwd, sinceMs?: number) => newestLog(piSessionDirs(cwd), 'pi', sinceMs)

/* ---------- OpenCode ---------- */

/** the newest top-level OpenCode session of this folder (its database says), mirrored into Shepherdr's home as a log;
 *  changed at or after sinceMs. The preferred folder with a session wins; discovery never throws: a database or a
 *  mirror that fails leaves the look going on to the next folder. */
export function findOpencodeLog(cwd: LogCwd, sinceMs?: number): string | undefined {
  for (const c of cwds(cwd)) {
    let id: string | undefined
    try {
      id = newestSession(trimSlash(c.trim()), sinceMs)
    } catch {
      continue
    }
    if (!id) continue
    const file = opencodeLogPath(home(), id)
    try {
      mirrorSession(id, file)
    } catch (e) { swallow('opencode log mirror', e, 'opencode', file) }
    return file
  }
  return undefined
}

/* ---------- Antigravity CLI (agy) ---------- */

/** the newest conversation of this folder in agy's store, mirrored into Shepherdr's home as a log (agy.ts conversationLog);
 *  changed at or after sinceMs. The preferred folder with a conversation wins; a missing or unreadable store leaves
 *  the look going on, never a throw. */
export function findAgyLog(cwd: LogCwd, sinceMs?: number): string | undefined {
  for (const c of cwds(cwd)) {
    const file = conversationLog(trimSlash(c), sinceMs)
    if (file) return file
  }
  return undefined
}

/** Runtime log discovery, also used to decide which kinds can supply chat. */
export const LOG_FINDERS: Record<string, (cwd: LogCwd, sinceMs?: number) => string | undefined> = {
  claude: findClaudeLog,
  codex: findCodexLog,
  pi: findPiLog,
  opencode: findOpencodeLog,
  agy: findAgyLog,
}

/** the newest log of this CLI for this cwd (or any of its candidate cwds) */
export function findLog(cli: string, cwd: LogCwd, sinceMs?: number): string | undefined {
  return Object.hasOwn(LOG_FINDERS, cli) ? LOG_FINDERS[cli](cwd, sinceMs) : undefined
}

/** which CLI wrote this log, by where it lies: an agent a backup took over from has logs of two CLIs */
export function logKind(file: string): string | undefined {
  const under = (dir: string) => file.startsWith(`${trimSlash(dir)}/`)
  if (under(join(claudeHome(), 'projects'))) return 'claude'
  if (under(join(codexHome(), 'sessions'))) return 'codex'
  if (under(join(piHome(), 'sessions'))) return 'pi'
  if (under(join(home(), 'opencode'))) return 'opencode'
  if (under(join(home(), 'agy'))) return 'agy'
  return undefined
}
