// What a merge gate run, or a pre-flight run (merge.preflight), leaves behind (engine.runGate, engine.runPreflight): its log,
// kept after it ends, and one line in the ledger beside the logs, `gates/ledger.jsonl` in Shepherdr's home. Both are bounded:
// the newest logs of each space (gate logs and pre-flight logs each their own count, so a cheap check never pushes a gate's
// log out), and a ledger rotated at a size. Nothing here can fail a merge: a ledger that cannot be written is a ledger with
// a line missing.
import * as fs from 'node:fs'
import { basename, join } from 'node:path'

/** how a run ended: its gate passed on what landed, refused it, passed but the base had moved, was stopped (a restart, a
 *  kill, its task going away) with no exit code, or never started */
export type GateEnd = 'passed' | 'refused' | 'moved' | 'stopped' | 'not-started'

/** what a run is: the merge gate, or the cheap pre-flight before it (merge.preflight) */
export type GateKind = 'gate' | 'preflight'

/** what a run is, kept on it when it starts so every place that ends it can write its line */
export interface GateWho {
  /** a pre-flight run; a gate run says nothing */
  kind?: 'preflight'
  /** the space it gates for */
  space?: string
  /** the task whose worktree it runs in: the head, when it gates a train */
  task?: string
  /** the merges it gates, the head's included, when it gates a train */
  members?: string[]
}

/** a run as the ledger needs it: its log's path ('' when it never wrote one), its start, the commit it ran on and the base it ran on */
export interface GateRunInfo extends GateWho {
  log: string
  at: number
  head: string
  tip: string
}

/** one line of the ledger: ids, commits, numbers and the gate's last line only, never a secret of ours */
interface GateEntry {
  started: string
  ended: string
  kind: GateKind
  space: string
  task: string
  members?: string[]
  head: string
  base: string
  seconds: number
  code: number | null
  end: GateEnd
  log: string
  last: string
}

/** how many logs of each space are kept (the newest), of the gate and of the pre-flight each */
export const GATE_LOGS_KEPT = 200
/** how large the ledger grows before it is rotated to `ledger.jsonl.1` (the old one there goes), in bytes */
export const GATE_LEDGER_MAX = 1_000_000
/** the longest gate line the ledger keeps */
const LAST_MAX = 200

/** a space's name as a file name part: lower case letters, digits, `_` and `-`, so no space can break the shell line a run goes by */
export const gateSlug = (space: string) =>
  space
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'space'

/** the files of a run, without their extension: `<space>.<task>-<start>-<random>` (no space part for a run that has none);
 *  a pre-flight run's name ends in `.pre`, so its logs are told from a gate's by name */
export const gateName = (space: string | undefined, task: string, start: number, rand: string, kind?: 'preflight') =>
  `${space ? `${gateSlug(space)}.` : ''}${task}-${start}-${rand}${kind === 'preflight' ? '.pre' : ''}`

/** a log this code wrote, in a gate folder: its space's slug (none for a run made without one), when it started, and whether
 *  it is a pre-flight's */
const GATE_LOG = /^(?:(?<slug>[a-z0-9_-]+)\.)?[A-Za-z0-9_-]+-(?<start>\d{13})-[0-9a-f]{8}(?<pre>\.pre)?\.log$/

/** the last line a gate printed, as the ledger keeps it: no control characters, at most LAST_MAX long */
export const lastLine = (out: string) =>
  (
    out
      .split('\n')
      .filter((l) => l.trim())
      .at(-1) ?? ''
  )
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to drop them
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, LAST_MAX)

/**
 * The newest `keep` logs of one space and one kind stay; the older ones go. Only files named as startGate names a log (and
 * with this space's slug and this kind) are ever removed, never the ledger, an exit file or whatever else is in the folder;
 * a log of a run going on is skipped. Returns how many it removed.
 */
export function pruneGateLogs(dir: string, slug: string, keep: number, live: Iterable<string> = [], kind: GateKind = 'gate'): number {
  const going = new Set([...live].map((p) => basename(p)))
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  const mine = names
    .flatMap((name) => {
      const m = GATE_LOG.exec(name)
      return m && (m.groups?.slug ?? '') === slug && (m.groups?.pre ? 'preflight' : 'gate') === kind ? [{ name, start: Number(m.groups?.start) }] : []
    })
    .sort((a, b) => b.start - a.start || (a.name < b.name ? 1 : -1))
  let removed = 0
  for (const { name } of mine.slice(Math.max(0, keep))) {
    if (going.has(name)) continue
    try {
      fs.rmSync(join(dir, name), { force: true })
      removed++
    } catch {
      /* it went away, or is not ours to remove: the next run prunes again */
    }
  }
  return removed
}

/**
 * A gate folder's ledger: one line a run, appended to `<dir>/ledger.jsonl` (rotated to `ledger.jsonl.1` first when a line
 * would take it past `max`), and the space's old logs pruned. A run is written once, however many places end it: its log
 * (or, with none, its start, task and end) names it. Nothing here throws: an unwritable ledger loses a line, not a merge.
 */
export class GateLedger {
  /** how many logs each space keeps (the newest) */
  keep = GATE_LOGS_KEPT
  /** the ledger's size at which it is rotated, in bytes */
  max = GATE_LEDGER_MAX
  /** the logs (paths) of the runs going on now: never pruned */
  live: () => Iterable<string> = () => []
  /** the runs written already */
  private written = new Set<string>()

  constructor(readonly dir: string) {}

  /** words kept as a log: a run with no process of ours to write one (a worker machine's) gets its words here. Its path, or
   *  '' when they could not be written */
  keepOutput(name: string, out: string) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const path = join(this.dir, `${name}.log`)
      fs.writeFileSync(path, out)
      return path
    } catch {
      return ''
    }
  }

  /** one run's line, once it ended `end`: `ran` is what it printed and returned, when it ended with a code */
  record(run: GateRunInfo, end: GateEnd, ran?: { code: number; out: string }, now = Date.now()) {
    const log = run.log && fs.existsSync(run.log) ? basename(run.log) : ''
    const key = log || `${run.at}:${run.task ?? ''}:${end}`
    if (this.written.has(key)) return
    this.written.add(key)
    // a bound of its own: a long server run never grows this by more than a short string a run
    if (this.written.size > 5000) for (const k of [...this.written].slice(0, 2500)) this.written.delete(k)
    const kind: GateKind = run.kind ?? 'gate'
    const entry: GateEntry = {
      started: new Date(run.at).toISOString(),
      ended: new Date(now).toISOString(),
      kind,
      space: run.space ?? '',
      task: run.task ?? '',
      ...(run.members?.length ? { members: run.members } : {}),
      head: run.head,
      base: run.tip,
      seconds: Math.round(Math.max(0, now - run.at) / 100) / 10,
      code: ran && ran.code >= 0 ? ran.code : null,
      end,
      log,
      last: lastLine(ran?.out ?? ''),
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const ledger = join(this.dir, 'ledger.jsonl')
      const line = `${JSON.stringify(entry)}\n`
      const size = fs.existsSync(ledger) ? fs.statSync(ledger).size : 0
      if (size > 0 && size + line.length > this.max) fs.renameSync(ledger, `${ledger}.1`)
      fs.appendFileSync(ledger, line)
      pruneGateLogs(this.dir, (log && GATE_LOG.exec(log)?.groups?.slug) || (run.space ? gateSlug(run.space) : ''), this.keep, this.live(), kind)
    } catch {
      /* the ledger is bookkeeping: a merge never fails over it */
    }
  }
}
