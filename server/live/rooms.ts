// What the restart sheet shows beside each CLI and model it offers: whether one more agent fits there now under Settings →
// Limits (models.maxAtOnce), for the chat it is opened for, and what runs there and how much of its provider's quota is
// used. The same decision the engine makes for a start (choose.ts), with the chat's own run left out, so a model the sheet
// says has room is one a start there takes. Pure: the live source and the demo hand it what runs now, the limits and the
// quota figures.
import type { QuotaFigure, RestartCli, RestartRoom } from '../../shared/types.ts'
import { providerOfKey, type MaxEntry } from '../../shared/model-caps.ts'
import { patternWords } from '../../shared/harness.ts'
import { shareOf } from '../../shared/quota-words.ts'
import { capWords, choose, covers, roomLeft, type Run } from './engine/choose.ts'
import { keyOf } from './models-summary.ts'

export interface RoomInput {
  /** the chat's space (its key, ~ for home): its own sub-limits count its runs */
  space: string
  /** what runs on this machine now, the chat's own run left out (engine.runs(except)) */
  runs: Run[]
  /** models.maxAtOnce at this machine, and as read at the chat's space */
  machine: MaxEntry[]
  own: MaxEntry[]
  /** whether a model key's provider is out now (engine.outNow) */
  out?: (key: string) => { until?: string } | undefined
  /** a provider's quota figure, as the summary has it (models-summary.ts) */
  quota?: (provider: string) => QuotaFigure | undefined
  /** the share (%) at which a quota window warns (quota.alertAt); 100 when it is off */
  alertAt?: number
  /** a space the way it shows */
  shown?: (space: string) => string
}

/** what runs under an entry or on a provider, in words: the tasks by id, then the other roles by count
 *  ("POL-313, POL-314 and 1 coordinator") */
export function runsWords(runs: Run[]): string {
  const ids = runs.filter((r) => r.role === 'task' && r.id).map((r) => r.id!)
  const others = (['task', 'coordinator', 'reviewer', 'advisor'] as const).flatMap((role) => {
    const n = runs.filter((r) => r.role === role && (role !== 'task' || !r.id)).length
    if (!n) return []
    const name = role === 'task' ? 'task' : role === 'coordinator' ? 'coordinator' : `${role} run`
    return [`${n} ${name}${n === 1 ? '' : 's'}`]
  })
  const all = [...ids, ...others]
  return all.length > 1 ? `${all.slice(0, -1).join(', ')} and ${all.at(-1)}` : (all[0] ?? '')
}

/** a provider's quota in words, its windows' shares used ("5 h 48% · Week 34%", "(estimate)" after an estimate's), and
 *  the windows at or past the warning share */
function quotaOf(q: QuotaFigure | undefined, alertAt: number) {
  const shares = (q?.windows ?? []).flatMap((w) => {
    const share = shareOf(w)
    return share === undefined ? [] : [{ name: w.name, share: Math.round(share) }]
  })
  const words = shares.length ? `${shares.map((s) => `${s.name} ${s.share}%`).join(' · ')}${q?.estimate ? ' (estimate)' : ''}` : ''
  return { words, high: shares.filter((s) => s.share >= alertAt) }
}

/** whether one more agent fits on a model key now, for the chat the input is for: the engine's own choice over that one
 *  key (choose.ts), with its numbers and what runs there in words */
export function roomOf(key: string, i: RoomInput): RestartRoom {
  const r = roomIn(key, i)
  // a line of its own: it starts as a sentence does (codex → Codex, pi · spark → Pi · spark)
  return { ...r, words: r.words.charAt(0).toUpperCase() + r.words.slice(1) }
}

function roomIn(key: string, i: RoomInput): RestartRoom {
  const out = i.out?.(key)
  const c = choose<null>({ space: i.space, options: [{ harness: null, key, ...(out ? { out } : {}) }], runs: i.runs, machine: i.machine, own: i.own })
  const provider = providerOfKey(key.toLowerCase())
  const q = quotaOf(i.quota?.(provider), i.alertAt ?? 100)
  const quota = q.words ? { quota: q.words } : {}
  const high = q.high.map((s) => `${s.name} ${s.share}%`).join(' · ')
  const warn = q.high.length ? { warn: true as const } : {}
  const on = (pattern: string, scope: 'machine' | 'space') => i.runs.filter((r) => covers(pattern, r.key) && (scope === 'machine' || r.space === i.space))
  const where = (scope: 'machine' | 'space') => (scope === 'space' ? ` in ${(i.shown ?? ((s) => s))(i.space)}` : '')
  if ('wait' in c) {
    const b = c.wait[0]!
    const now = b.cap && b.why === 'full' ? runsWords(on(b.name, b.cap.scope)) : ''
    // short enough for a row: a time today needs no day, and its quota is in its line below (what holds it is said)
    const short = b.why === 'out' ? `Out${b.until ? ` until ${b.until.replace(/^Today /, '')}` : ''}` : b.why === 'blocked' ? 'Blocked' : `Full ${b.cap!.count} of ${b.cap!.max}`
    return { state: b.why, short, ...warn, words: `${capWords(b, i.shown)}${now ? `: ${now}` : ''}.`, ...quota }
  }
  const tight = roomLeft({ space: i.space, options: [], runs: i.runs, machine: i.machine, own: i.own }, key)
  if (tight) {
    const now = runsWords(on(tight.pattern, tight.scope))
    const left = tight.max - tight.count
    const short = `${tight.count} of ${tight.max}`
    return { state: 'room', short: high ? `${short} · ${high}` : short, ...warn, words: `${patternWords(tight.pattern)}${where(tight.scope)}: ${tight.count} of ${tight.max} at once now${now ? ` (${now})` : ''}; ${left === 1 ? 'one more fits' : `${left} more fit`}.`, ...quota }
  }
  const running = i.runs.filter((r) => providerOfKey(r.key.toLowerCase()) === provider)
  const now = runsWords(running)
  const short = running.length ? `${running.length} running` : ''
  // no limit: its row says what runs; a line below only to carry its quota (the sheet stays short)
  const words = q.words ? `No limit on ${patternWords(provider)}; ${now ? `${now} ${running.length === 1 ? 'runs' : 'run'} on it now` : 'nothing runs on it now'}.` : ''
  return { state: 'room', short: high ? [short, high].filter(Boolean).join(' · ') : short, ...warn, words, ...quota }
}

/** the restart sheet's CLIs with the room of each model they offer, and of each CLI's own default (what Default starts on) */
export function withRooms(clis: RestartCli[], i: RoomInput): RestartCli[] {
  return clis.map((c) => ({
    ...c,
    room: roomOf(keyOf(c.kind, c.defaultModel), i),
    ...(c.models ? { models: c.models.map((m) => ({ ...m, room: roomOf(keyOf(c.kind, m.id), i) })) } : {}),
  }))
}
