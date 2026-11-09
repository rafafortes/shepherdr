// Restarting an agent on a CLI, model and effort: a coordinator, or a task's agent. The same CLI resumes its session;
// another one takes over from it with the role's prompt and what was said and done so far (prompts.ts restartLine).
// What the restart sheet offers (restartInfo) and the calm hint a chat shows once Settings say something else than
// what its agent runs on (restartHint) come from here.
import type { Message, RestartCli, RestartHint, RestartInfo } from '../../shared/types.ts'
import { effortFor, effortsOf, findModel, modelArg, modelsOf } from './models.ts'
import { picksOf } from './model-picks.ts'
import { orderByPicks } from '../../shared/picks.ts'
import { chatProblem } from './readers/index.ts'
import { CLI_NAME } from './settings.ts'
import type { Harness } from './engine/engine.ts'

export type { Harness }

const name = (kind: string) => CLI_NAME[kind] ?? kind

/** a model as compared: its id, '' for the CLI's own */
const modelOf = (h: Harness) => (!h.model || h.model === 'default' ? '' : (findModel(h.kind, h.model)?.id ?? h.model))
/** an effort as compared: the level its model takes, '' for the CLI's own */
const effortOf = (h: Harness) => (!h.effort || h.effort === 'default' ? '' : (effortFor(h.kind, h.effort, modelOf(h) || undefined) ?? h.effort.toLowerCase()))

export const sameHarness = (a: Harness, b: Harness) => a.kind === b.kind && modelOf(a) === modelOf(b) && effortOf(a) === effortOf(b)

/** a harness as Shepherdr passes it: a model by its id, a level its model takes; nothing for the CLI's own */
export function fitHarness(h: Harness): Harness {
  const model = modelOf(h) || undefined
  const effort = effortOf(h) || undefined
  return { kind: h.kind, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/** Values actually passed by Agents.args, without inventing a model or effort for a CLI that takes none. */
export function launchHarness(h: Harness): Harness {
  if (!modelsOf(h.kind)) return { kind: h.kind }
  const model = modelArg(h.kind, h.model)
  const effort = effortFor(h.kind, h.effort, h.model)
  return { kind: h.kind, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/** "Codex (GPT-6-Sol, high)", "Claude Code" */
export function harnessWords(h: Harness) {
  const m = modelOf(h)
  const bits = [m ? (findModel(h.kind, m)?.label ?? m) : '', effortOf(h)].filter(Boolean)
  return bits.length ? `${name(h.kind)} (${bits.join(', ')})` : name(h.kind)
}

/**
 * What a chat's hint says, by the first thing that differs: its agent runs on `on`, Settings now say `want`. Nothing
 * while they agree, or while Settings say what they said when it last started on them (`set`): a pick of its own (task
 * add --agent, the + menu's model) is no change of Settings.
 */
export function restartHint(on: Harness, set: Harness | undefined, want: Harness): RestartHint | undefined {
  if (sameHarness(on, want) || (set && sameHarness(set, want))) return undefined
  if (on.kind !== want.kind) return { on: name(on.kind), want: name(want.kind) }
  const label = (h: Harness) => (modelOf(h) ? (findModel(h.kind, modelOf(h))?.label ?? modelOf(h)) : `${name(h.kind)}'s default model`)
  if (modelOf(on) !== modelOf(want)) return { on: label(on), want: label(want) }
  return { on: `${effortOf(on) || 'default'} effort`, want: `${effortOf(want) || 'default'} effort` }
}

/** one place's answer to `restart --all`, as the line it prints says it */
export type RestartAllRow =
  /** started again on `on`; interrupted: it was at work, and that turn was stopped first, as a single restart does */
  | { name: string; state: 'restarted'; on: string; interrupted?: boolean }
  /** left alone: its agent runs on what Settings say now (or never started, so its first start will be on them) */
  | { name: string; state: 'same'; on: string }
  /** it could not be restarted, and the ones after it were still tried */
  | { name: string; state: 'failed'; error: string }

/**
 * `shepherdr restart --all`'s words: one line per space, the failures last and named, the counts, and what it never
 * touches (a task's agent is its own to restart; another machine's places belong to that machine).
 */
export function restartAllWords(rows: RestartAllRow[], otherMachines: string[] = []): string {
  const restarted = rows.filter((r): r is Extract<RestartAllRow, { state: 'restarted' }> => r.state === 'restarted')
  const same = rows.filter((r) => r.state === 'same')
  const failed = rows.filter((r): r is Extract<RestartAllRow, { state: 'failed' }> => r.state === 'failed')
  const tasks = "Tasks are not restarted: a running task's brief was written when it started, and restarting its agent is its own choice (shepherdr restart <id>)."
  const others = otherMachines.length ? `Another machine's spaces are not touched here: ${otherMachines.join(', ')}.` : ''
  const tail = [tasks, others].filter(Boolean)
  if (!restarted.length && !failed.length)
    return [`Nothing new in the Settings of this machine's coordinators (${same.length}): nothing was restarted.`, ...tail].join('\n')
  return [
    ...restarted.map((r) => `${r.name}: restarted on ${r.on}${r.interrupted ? ', its working turn interrupted first' : ''}`),
    ...same.map((r) => `${r.name}: already on ${r.on}, left alone`),
    ...failed.map((r) => `${r.name}: could not restart: ${r.error}`),
    `${restarted.length} restarted, ${same.length} already on it, ${failed.length} failed.`,
    ...tail,
  ].join('\n')
}

/** each CLI the sheet offers: its models (with the levels each takes) where Shepherdr passes them, the human's pinned
 *  ones first and the ones picked last next, then the CLI's own order. An older model it still takes by id stays on
 *  offer while it is pinned or was picked: a pin never drops out of the list it belongs to. picksOfKind: this machine's
 *  picks (model-picks.ts), or the ones of a world of its own (the demo's) */
export function restartClis(kinds: string[], picksOfKind: (kind: string) => { pinned: string[]; recent: string[] } = picksOf): RestartCli[] {
  return kinds.filter((kind) => !chatProblem(kind)).map((kind) => {
    const c = modelsOf(kind)
    if (!c) return { kind, name: name(kind) }
    const picks = picksOfKind(kind)
    const saved = (c.others ?? []).filter((m) => picks.pinned.includes(m.id) || picks.recent.includes(m.id))
    const models = orderByPicks([...c.models, ...saved], picks)
    const listed = new Set(models.map((m) => m.id))
    return {
      kind,
      name: name(kind),
      models: models.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts, defaultEffort: m.effort })),
      efforts: effortsOf(kind),
      defaultModel: c.default,
      defaultEffort: findModel(kind, c.default)?.effort,
      pinned: picks.pinned.filter((id) => listed.has(id)),
      recent: picks.recent.filter((id) => listed.has(id)),
    }
  })
}

/** what the restart sheet shows: what it runs on now, what Settings say (what it restarts with unless changed), the
 *  CLIs it may restart on */
export function restartInfo(o: { role: 'task' | 'coordinator'; space?: string; on: Harness; want: Harness; kinds: string[]; working: boolean; onKnown?: boolean }): RestartInfo {
  const kinds = o.kinds.includes(o.on.kind) ? o.kinds : [o.on.kind, ...o.kinds]
  const clis = restartClis(kinds)
  // Discovery keeps older, still-supported models outside the short picker list. Keep a recognized launch or
  // inherited choice selectable rather than falsely call it unavailable.
  for (const h of [o.on, o.want]) {
    const m = findModel(h.kind, h.model)
    const cli = clis.find((c) => c.kind === h.kind)
    if (m && cli?.models && !cli.models.some((x) => x.id === m.id)) cli.models.push({ id: m.id, label: m.label, efforts: m.efforts, defaultEffort: m.effort })
  }
  const on = launchHarness(o.on)
  return { role: o.role, space: o.space, onKnown: o.onKnown, on, onWords: harnessWords(on), want: fitHarness(o.want), clis, working: o.working }
}

/** a chat's last words, latest last, for an agent taking over: yours, another agent's (named as it declared itself) and
 *  its agent's (as `them`), each cut short; cards and the brief (`skip`) left out */
export function recentChat(messages: Message[], them: string, skip?: string) {
  return messages
    .filter((m) => m.text && !m.card && m.text.trim() !== skip)
    .slice(-12)
    .map((m) => `${m.who === 'you' ? 'Human' : m.peer ? `Another agent (${m.peer.name})` : them}: ${m.text!.length > 400 ? `${m.text!.slice(0, 400)}…` : m.text}`)
    .join('\n\n')
}

/** Reject unsupported choices before restarting or saving anything; never silently round effort. */
export function harnessProblem(h: Harness): string | undefined {
  const problem = chatProblem(h.kind)
  if (problem) return problem
  const c = modelsOf(h.kind)
  const m = h.model && h.model !== 'default' ? h.model : undefined
  if (!c && (m || (h.effort && h.effort !== 'default'))) return `${name(h.kind)} does not support model or effort selection.`
  if (m && c?.models.length && !findModel(h.kind, m)) return `${name(h.kind)} has no available model ${m}. Choose Default or an available model.`
  if (h.effort && h.effort !== 'default' && !effortsOf(h.kind, m).includes(h.effort)) return `${name(h.kind)} does not support ${h.effort} effort on this model.`
}
