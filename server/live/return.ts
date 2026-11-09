// A model's provider can run out for good: out of allowance, signed out, a model that is not there, a provider that
// refuses it. The backup agent takes that role's agent over (engine.ts cantGoOn, source.ts coordinatorCantGoOn) and it
// stays there: going back was always a manual restart, so nothing ever noticed the primary answering again. This
// remembers, per role and space, what ran out and what took over, and asks the primary now and then whether it answers:
// a card in the chats still on the backup, and an alert. Never a switch — no setting is written, no agent restarted, no
// model chosen on its own.
//
// It is kept across a restart (returns.json, like retries.json) and it is this machine's own: a machine never asks
// another machine's models, and a CLI Shepherdr has no silent one-shot for is never asked at all.
import { tmpdir } from 'node:os'
import { readJson, writeJson } from '../store.ts'
import { fitHarness, harnessWords, type Harness } from './restart.ts'
import { CLI_NAME } from './settings.ts'

/** the roles a backup takes over from: a task's agent, a space's coordinator, the reviewer a brief names (whose backup
 *  is the backup reviewer, reviewer.fallback) */
export type ReturnRole = 'task' | 'coordinator' | 'reviewer'

/** a role's primary that ran out, and what took its agents over */
export interface Outage {
  role: ReturnRole
  /** the space it happened in, by the name it was added under ('~' for a home space); '' when there is none */
  space: string
  /** the harness Settings named as the primary when the backup went in, and the one that took over */
  primary: Harness
  to: Harness
  /** the provider's reason, in words ("out of allowance until 5pm") */
  why: string
  at: number
  /** probes since, when the last one ran, and when the next may: the wait doubles with each failure */
  tries?: number
  probed?: number
  due?: number
  /** the primary answered, when: nothing more is asked or posted for this one */
  back?: number
}

/** how long after a takeover its primary is first asked, and how far the wait doubles while it keeps failing */
export const FIRST_WAIT = 30 * 60_000
export const LONGEST_WAIT = 4 * 3_600_000
/** how long one probe may take before it is killed: a provider that answers answers at once */
export const PROBE_TIMEOUT = 45_000
/** a fifth either side of the wait, so two roles rarely fall due together (when they do, the probes are taken one by one) */
const JITTER = 0.2

/** the one line a probe asks: the shortest that proves the provider answers */
const ASK = 'Reply with only the two letters: ok'
/** the little a probe's CLI is told to be: no coding assistant's prompt, nothing to explore, one word out */
const JUST_ASK = 'You answer a health check with exactly: ok'
/** Claude Code's tools, denied: a probe reads a line of its own answer and touches nothing */
const NO_TOOLS = 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit,WebFetch,WebSearch,Task'

const name = (kind: string) => CLI_NAME[kind] ?? kind

/**
 * A CLI's own one-shot for a probe — the shortest call that proves its provider answers: no tools, no MCP servers, no
 * session kept, its own coding-assistant prompt left out (Claude Code and pi), and nothing for a CLI Shepherdr knows no
 * such call for (those are never asked: it cannot prove them quietly). Codex is run in its read-only sandbox on its own
 * config, and takes an effort there in that config, not as a flag, so a probe asks it on its own.
 */
export function oneShot(h: Harness): string[] | undefined {
  const model = h.model && h.model !== 'default' ? h.model : undefined
  const effort = h.effort && h.effort !== 'default' ? h.effort : undefined
  if (h.kind === 'claude')
    return [
      'claude',
      '-p',
      '--no-session-persistence',
      // the person's own MCP servers and settings stay out: an unattended probe starts nothing
      '--strict-mcp-config',
      '--restricted',
      '--system-prompt',
      JUST_ASK,
      '--disallowedTools',
      NO_TOOLS,
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
    ]
  if (h.kind === 'codex') return ['codex', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', ...(model ? ['--model', model] : []), ASK]
  if (h.kind === 'pi')
    return [
      'pi',
      '-p',
      '--no-tools',
      '--no-session',
      '--no-mcp',
      '--no-skills',
      // extensions stay on: a provider one of them adds (a pi package) is one of the person's primaries
      '--no-context-files',
      '--system-prompt',
      JUST_ASK,
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--thinking', effort] : []),
      ASK,
    ]
  return undefined
}

/** a CLI Shepherdr can ask silently */
export const canProbe = (kind: string) => !!oneShot({ kind })

export interface Probe {
  /** its provider answered */
  ok: boolean
  /** the CLI's own words, for the log only: nothing of it ever reaches a chat */
  said: string
}

/**
 * Ask one harness one trivial thing: whether its provider answers. It is nobody's turn: no chat line, no herdr pane, no
 * session kept, no agent's secret, no tool, and a hard timeout. Its failure is silent (the caller only backs off).
 */
export async function probeHarness(h: Harness, timeoutMs = PROBE_TIMEOUT): Promise<Probe> {
  // the demo world is a fiction of its own: it never asks a real provider anything
  if (process.env.SHEPHERDR_SOURCE === 'demo') return { ok: false, said: 'the demo world never probes' }
  const cmd = oneShot(h)
  if (!cmd) return { ok: false, said: `no silent one-shot for ${h.kind}` }
  if (!Bun.which(cmd[0])) return { ok: false, said: `${cmd[0]} isn't installed on this machine` }
  // a probe is nobody's turn: nothing of a chat, a pane or a secret goes with it
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:SHEPHERDR_|HERDR_)/.test(k))) as Record<string, string>
  const start = () =>
    Bun.spawn(cmd, {
      cwd: tmpdir(),
      // Claude Code takes its prompt on stdin (its tool list is a variadic argument), the others as the last word
      stdin: cmd[0] === 'claude' ? Buffer.from(ASK) : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    })
  let p: ReturnType<typeof start>
  try {
    p = start()
  } catch (e) {
    return { ok: false, said: (e as Error).message }
  }
  // the timeout is the whole call's, not only the CLI's own life: a grandchild holding its pipes open must not keep the
  // watch waiting (and so never dead)
  let late: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => p.kill(9), timeoutMs)
  const gaveUp = new Promise<undefined>((r) => {
    late = setTimeout(() => r(undefined), timeoutMs + 2_000)
  })
  try {
    const read = (async () => {
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
      return { out, err, code: await p.exited }
    })()
    const got = await Promise.race([read.catch((e: Error) => ({ failed: e })), gaveUp])
    if (!got) return { ok: false, said: 'timed out' }
    if ('failed' in got) return { ok: false, said: got.failed.message }
    return { ok: got.code === 0, said: `${got.out}${got.err}`.replace(/\s+/g, ' ').trim().slice(0, 200) }
  } catch (e) {
    return { ok: false, said: (e as Error).message }
  } finally {
    clearTimeout(timer)
    clearTimeout(late)
  }
}

/** a role's own key: the harness each role's agents start with is Settings' own pair, read per space */
export const keyOf = (role: ReturnRole, space: string) => `${role}:${space}`

/**
 * What ran out, per role and space, until its primary answers again. Written by a lasting takeover (never by one that
 * retries could have waited out), read by the watch that probes.
 */
export class Returns {
  private data = readJson<Record<string, Outage>>('returns.json', {})
  /** ask a harness's CLI one trivial thing (a test puts its own here) */
  probe: (h: Harness, timeoutMs?: number) => Promise<Probe> = probeHarness

  list(): Outage[] {
    return Object.values(this.data)
  }

  get(role: ReturnRole, space: string): Outage | undefined {
    return this.data[keyOf(role, space)]
  }

  /** a backup took that role's agent over for a reason waiting can't fix: from now on, until it answers, its primary is
   *  asked now and then whether it is back. A new takeover starts a new count */
  note(o: Pick<Outage, 'role' | 'space' | 'primary' | 'to' | 'why' | 'at'>) {
    this.data[keyOf(o.role, o.space)] = { ...o, primary: fitHarness(o.primary), to: fitHarness(o.to), tries: 0, due: o.at + wait(0) }
    this.save()
  }

  /** its provider answered: nothing more is asked or posted for it (a new takeover notes it again) */
  answered(role: ReturnRole, space: string, at = Date.now()) {
    const o = this.get(role, space)
    if (!o) return
    o.back = at
    o.due = undefined
    this.save()
  }

  /** what it would come back to, set again while it has not answered yet (no new card by that alone) */
  retarget(role: ReturnRole, space: string, primary: Harness) {
    const o = this.get(role, space)
    if (!o || o.back) return
    o.primary = fitHarness(primary)
    this.save()
  }

  /** it didn't answer: it is asked again later, the wait doubling until the longest one */
  failed(role: ReturnRole, space: string, at = Date.now()) {
    const o = this.get(role, space)
    if (!o) return
    o.tries = (o.tries ?? 0) + 1
    o.probed = at
    o.due = at + wait(o.tries)
    this.save()
  }

  /** nothing is on that backup any more (or the human set the watch off): there is nothing to come back to */
  forget(role: ReturnRole, space: string) {
    const k = keyOf(role, space)
    if (!(k in this.data)) return
    delete this.data[k]
    this.save()
  }

  save() {
    writeJson('returns.json', this.data)
  }
}

/** how long until the next probe after `tries` failures: doubling from the first wait, up to the longest, a fifth of it
 *  either way at random */
export function wait(tries: number, random = Math.random()): number {
  const base = Math.min(FIRST_WAIT * 2 ** Math.max(0, tries), LONGEST_WAIT)
  return Math.round(base * (1 - JITTER + random * 2 * JITTER))
}

/**
 * What a chat's card says when its primary answers again: the role in plain words and the way back for it, and nothing
 * else. A task and a coordinator go back with a restart; a reviewer, which Shepherdr never starts, with its Settings
 * key. `space` is the space's name, `task` the task's id.
 */
export function backCard(o: { role: ReturnRole; primary: Harness; to: Harness; task?: string; space?: string }): string {
  const back = `The primary model answers again: ${harnessWords(o.primary)}.`
  if (o.role === 'task') return `${back} ${o.task} still runs on its backup (${name(o.to.kind)}): restart it to go back — shepherdr restart ${o.task}, or ⋯ → Restart agent in its chat. Nothing was switched.`
  if (o.role === 'coordinator') return `${back} ${o.space}'s coordinator still runs on its backup (${name(o.to.kind)}): restart it to go back — shepherdr restart ${o.space}, or ⋯ → Restart agent in its chat. Nothing was switched.`
  const model = o.primary.model && o.primary.model !== 'default' ? o.primary.model : 'default'
  // the space's own, never Everywhere's: a plain set would change every space's reviewer
  const where = o.space ? ` --space ${o.space}` : ''
  return `${back} Reviews still fall back to ${name(o.to.kind)} (the backup reviewer: reviewer.fallback on reviewer.fallbackModel), and nothing switches by itself: go back with shepherdr set reviewer.model ${model}${where} (Settings → How tasks work → Reviewer → Model).`
}
