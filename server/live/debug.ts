// Parser paths swallow errors on purpose: a CLI changing its log or config format must not take the server down.
// Quiet by default, but not invisible: each one is counted for its reader, and `shepherdr doctor` says so; with
// SHEPHERDR_DEBUG set, each one is also written as one line. Only a fixed reason, an error's kind and a file's name
// go into that line: never a chat line, a model's answer or a secret.

import { basename } from 'node:path'

/** swallowed parser errors since this server started, by reader */
const ignored = new Map<string, number>()

/** count one swallowed error for `reader` and, when SHEPHERDR_DEBUG is set, log one line about it. `why` is a fixed
 *  reason and `file` a name: neither carries a chat line or a secret, and the error's message is never written. */
export function swallow(why: string, e: unknown, reader: string, file?: string): undefined {
  ignored.set(reader, (ignored.get(reader) ?? 0) + 1)
  if (process.env.SHEPHERDR_DEBUG) {
    const kind = e instanceof Error ? e.name : typeof e
    console.error(`shepherdr: ${why} ignored: ${kind}${file ? ` (${basename(file)})` : ''}`)
  }
  return undefined
}

/** what `shepherdr doctor` says: one line per reader that ignored something, nothing when none did */
export function swallowedReport(): string[] {
  return [...ignored]
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reader, n]) => `The ${reader} reader ignored ${n} line${n === 1 ? '' : 's'} it could not read since this server started; set SHEPHERDR_DEBUG=1 to log each one.`)
}

/** for tests: start the counts over */
export function resetSwallowed() {
  ignored.clear()
}
