// The one persistent log of the live server, its supervisor and the machine workers. Every line goes through here so
// it carries an ISO date-time and the file stays bounded: one previous generation is kept when it grows past LOG_CAP.
// The console.* call sites are left alone; install() swaps console's methods at the process edges instead, and the
// fd the plugin hands the supervisor keeps anything the runtime writes outside console.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { format } from 'node:util'

/** rotate above this many bytes: a server that stays up for weeks still rotates, not only at start */
export const LOG_CAP = 10 * 1024 * 1024

/** where the log is: the plugin's state folder for the server, a machine's own home for its worker */
export function logFile(home = process.env.SHEPHERDR_HOME ?? join(homedir(), '.shepherdr'), state = process.env.HERDR_PLUGIN_STATE_DIR, box = process.env.SHEPHERDR_BOX): string {
  return box ? join(home, 'worker.log') : join(state ?? join(home, 'run'), 'server.log')
}

/** one ISO date-time in front of every physical line, including each line of a multi-line message */
export function stamp(line: string, at = new Date()): string {
  const when = at.toISOString()
  const text = line.endsWith('\n') ? line.slice(0, -1) : line
  return text
    .split('\n')
    .map((l) => `${when} ${l}\n`)
    .join('')
}

/** the human's secrets and chat text never reach the log: keys, tokens and their values are taken out */
export function redact(line: string): string {
  return line.replace(/\b(bearer)\s+\S+/gi, '$1 [redacted]').replace(/\b(token|password|passwd|secret|api[-_ ]?key|authorization)\b(\s*[:=]\s*)("[^"]*"|\S+)/gi, '$1$2[redacted]')
}

/** keep one previous generation; a log under the cap (or one not there yet) is left alone */
export function rotate(path: string, cap = LOG_CAP): boolean {
  try {
    if (statSync(path).size <= cap) return false
  } catch {
    return false
  }
  try {
    renameSync(path, `${path}.1`)
    return true
  } catch {
    return false
  }
}

/** rotate when needed, then append one prefixed line. Opening on each write means a rotation made here or at start is
 *  picked up at once by the supervisor and the server, neither of which holds an fd to a file renamed away. */
export function write(path: string, args: unknown[], at = new Date(), cap = LOG_CAP): void {
  try {
    const line = redact((format as (...a: unknown[]) => string)(...args))
    rotate(path, cap)
    // a proof server's home need not have a run folder yet; the plugin makes it for the live one
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, stamp(line, at))
  } catch {
    // logging never brings the server down
  }
}

type Levels = 'log' | 'info' | 'warn' | 'error' | 'debug'
type Sink = Record<Levels, (...args: unknown[]) => void>

/** the only place console is changed: the supervisor and the server each call this once, so no call site moves. Tests
 *  keep their own console and output; the returned function puts a sink back as it was. */
export function install(path = logFile(), target: object = console): () => void {
  const sink = target as Sink
  const levels: Levels[] = ['log', 'info', 'warn', 'error', 'debug']
  const before = Object.fromEntries(levels.map((l) => [l, sink[l]])) as Sink
  if (process.env.NODE_ENV === 'test') return () => {}
  for (const l of levels) sink[l] = (...args: unknown[]) => write(path, args)
  return () => {
    for (const l of levels) sink[l] = before[l]
  }
}
