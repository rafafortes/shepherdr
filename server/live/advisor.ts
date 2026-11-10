// The advisor: a question a task's or a coordinator's agent opens for the human — a choice card, the CLI's own question
// tool, or a plain question in words — goes to another model when the human asks for it (Ask the advisor, on its card)
// or by itself once it has waited (Settings → Agents → Advisor → Answers for you after). One headless, read-only run per
// question: it reads the question, the brief, the chat so far and the repository, and answers with a pick or its words,
// why, and whether it is sure. It never answers a permission, a plan, or what only the human decides: those, and anything
// it is unsure of, stay with the human. Its own primary and backup, as every other role has (settings.ts advisor).
import { readJson, writeJson } from '../store.ts'
import { fitHarness, harnessWords, type Harness } from './restart.ts'

/** what the advisor is asked: a choice (a card, or one question of the CLI's own form) or a question in words */
export interface AdviceQuestion {
  kind: 'choice' | 'words'
  title: string
  choices?: { label: string; description?: string }[]
  multi?: boolean
  /** a choice that also takes an answer in words of its own ("Other") */
  other?: boolean
  /** a plan to approve: the advisor may only suggest, never send one by itself */
  plan?: boolean
}

/** what the advisor answered */
export interface Advice {
  /** its pick (one, or several on a multi-choice), or its own words where a choice takes them */
  choice?: number
  choices?: number[]
  other?: string
  /** its answer to a question in words */
  reply?: string
  /** why, in a line or two */
  why: string
  /** it leaves the question to the human: unsure, or one only the human may decide; the words say why */
  human?: string
  /** who answered: the harness, in words ("pi (opencode-go/deepseek-v4.1-flash, high)") */
  by: string
}

/** how long one advisor run may take: it may read the repository before it answers */
export const ADVICE_TIMEOUT = 8 * 60_000

/** what only the human decides, whatever the question says: the advisor leaves these to them */
const HUMANS_ONLY = [
  'a permission to run, read or write something',
  'deleting a task, a branch or files, or losing work',
  'force-pushing, or rewriting history that others have',
  'changing Shepherdr Settings, secrets or credentials',
  "merging past a brief's \"ask me first\"",
  'spending money, buying, or using up a paid plan',
  'anything that touches a live site, production, or other people',
]

/** the run's prompt: who it answers for, the rules, the context, the question, and the one line it ends with */
export function advisorPrompt(o: { question: AdviceQuestion; asker: string; brief?: string; chat: string; folder: string; human?: string }): string {
  const q = o.question
  const who = o.human ?? 'the human'
  const choices = (q.choices ?? []).map((c, i) => `${i + 1}. ${c.label}${c.description ? ` — ${c.description}` : ''}`).join('\n')
  const shape =
    q.kind === 'choice'
      ? `{"decide": "advisor" or "human", ${q.multi ? '"choices": [numbers of the options you pick]' : '"choice": the number of the option you pick'}${q.other ? ', "other": "your own answer in words, instead of a pick, only if no option fits"' : ''}, "why": "one or two short sentences", "sure": true or false}`
      : '{"decide": "advisor" or "human", "reply": "your answer, in the words the agent should read", "why": "one or two short sentences", "sure": true or false}'
  return [
    `You are the advisor of ${who}, who supervises coding agents in Shepherdr and does not always know enough to decide. ${o.asker} is waiting for ${who}'s answer to the question below. Answer it as an expert would, in ${who}'s interest: read the brief, the chat and the repository in ${o.folder} (read only — never edit, write, commit or run anything that changes something) and decide what is best for the work.`,
    `Leave the question to ${who} ("decide": "human") when you are not sure, or when the answer would decide any of: ${HUMANS_ONLY.join('; ')}. Say why in "why".`,
    o.brief ? `The brief:\n${o.brief}` : '',
    o.chat ? `The chat so far, latest last:\n\n${o.chat}` : '',
    q.kind === 'choice' ? `The question: ${q.title}${q.plan ? ' (a plan to approve)' : ''}\nThe options:\n${choices}${q.multi ? '\nMore than one may be picked.' : ''}` : `The question, in the agent's own words:\n${q.title}`,
    `End your answer with one line of JSON and nothing after it: ${shape}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** NO_TOOLS of a Claude Code advisor: it reads the repository, and touches nothing */
const NO_CHANGE = 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task'

/**
 * A CLI's read-only one-shot for the advisor: reading tools only, no session kept, no MCP servers; nothing for a CLI
 * Shepherdr knows no such run for. Claude Code takes the prompt on stdin (its tool lists are variadic), the others as
 * the last word.
 */
export function adviceArgs(h: Harness, prompt: string): { cmd: string[]; stdin?: string } | undefined {
  const model = h.model && h.model !== 'default' ? h.model : undefined
  const effort = h.effort && h.effort !== 'default' ? h.effort : undefined
  if (h.kind === 'claude')
    return {
      cmd: ['claude', '-p', '--no-session-persistence', '--strict-mcp-config', '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', NO_CHANGE, ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])],
      stdin: prompt,
    }
  if (h.kind === 'pi') return { cmd: ['pi', '-p', '--no-session', '--no-mcp', '--no-skills', '--tools', 'read,grep,find,ls', ...(model ? ['--model', model] : []), ...(effort ? ['--thinking', effort] : []), prompt] }
  if (h.kind === 'codex') return { cmd: ['codex', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', ...(model ? ['--model', model] : []), prompt] }
  return undefined
}

/** a CLI Shepherdr can run as an advisor */
export const canAdvise = (kind: string) => !!adviceArgs({ kind }, '')

/**
 * Run one advisor: its CLI, read only, in the folder of the work, with a hard timeout over the whole call (a grandchild
 * holding its pipes open never keeps it waiting). Nobody's turn: no chat line, no herdr pane, no agent's secret.
 */
export async function runAdvisor(h: Harness, prompt: string, cwd: string, timeoutMs = ADVICE_TIMEOUT): Promise<{ ok: boolean; out: string }> {
  // the demo world is a fiction of its own: it never asks a real model anything
  if (process.env.SHEPHERDR_SOURCE === 'demo') return { ok: false, out: 'the demo world has no advisor' }
  const a = adviceArgs(h, prompt)
  if (!a) return { ok: false, out: `no advisor run for ${h.kind}` }
  if (!Bun.which(a.cmd[0])) return { ok: false, out: `${a.cmd[0]} isn't installed on this machine` }
  // nobody's turn: nothing of a chat, a pane or a secret goes with it, and no shepherdr command runs as an agent
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:SHEPHERDR_|HERDR_)/.test(k))) as Record<string, string>
  let p: ReturnType<typeof Bun.spawn>
  try {
    p = Bun.spawn(a.cmd, { cwd, stdin: a.stdin !== undefined ? Buffer.from(a.stdin) : 'ignore', stdout: 'pipe', stderr: 'pipe', env })
  } catch (e) {
    return { ok: false, out: (e as Error).message }
  }
  let late: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => p.kill(9), timeoutMs)
  const gaveUp = new Promise<undefined>((r) => {
    late = setTimeout(() => r(undefined), timeoutMs + 2_000)
  })
  try {
    const read = (async () => {
      const [out, err] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text()])
      return { out, err, code: await p.exited }
    })()
    const got = await Promise.race([read.catch((e: Error) => ({ failed: e })), gaveUp])
    if (!got) return { ok: false, out: 'timed out' }
    if ('failed' in got) return { ok: false, out: got.failed.message }
    return { ok: got.code === 0, out: got.code === 0 ? got.out : `${got.out}${got.err}`.slice(-2000) }
  } finally {
    clearTimeout(timer)
    clearTimeout(late)
  }
}

/** the last JSON object of the run's words: what it decided. Nothing when it wrote none, or one that makes no sense for
 *  this question (a pick out of range, words on a choice that takes none) */
export function parseAdvice(out: string, q: AdviceQuestion): Omit<Advice, 'by'> | undefined {
  const objects = [...out.matchAll(/\{[^{}]*\}/g)].map((m) => m[0])
  for (const text of objects.reverse()) {
    let j: { decide?: string; choice?: unknown; choices?: unknown; other?: unknown; reply?: unknown; why?: unknown; sure?: unknown }
    try {
      j = JSON.parse(text)
    } catch {
      continue
    }
    if (!j || typeof j !== 'object' || (j.decide !== 'advisor' && j.decide !== 'human')) continue
    const why = typeof j.why === 'string' && j.why.trim() ? j.why.trim().slice(0, 600) : ''
    // unsure, or the human's to decide: it says why, and answers nothing
    if (j.decide === 'human' || j.sure !== true) return { why, human: why || 'it is not sure' }
    const n = (q.choices ?? []).length
    // a number, or a number written as words of JSON ("2"): an option's, counted from one
    const num = (x: unknown) => (typeof x === 'string' && /^\s*\d+\s*$/.test(x) ? Number(x) : x)
    const pick = (x: unknown) => {
      const v = num(x)
      return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= n ? v - 1 : undefined
    }
    if (q.kind === 'words') {
      const reply = typeof j.reply === 'string' ? j.reply.trim() : ''
      return reply ? { reply: reply.slice(0, 4000), why } : undefined
    }
    // its own words, where the question takes them: with no pick (none, null), or with the pick right after the options
    // (where an "Other" would be)
    const words = typeof j.other === 'string' ? j.other.trim() : ''
    const none = (x: unknown) => x === undefined || x === null || (Array.isArray(x) && !x.length) || num(x) === n + 1
    if (q.other && words && none(j.choice) && none(j.choices)) return { other: words.slice(0, 2000), why, choice: n }
    if (q.multi) {
      const picks = Array.isArray(j.choices) ? j.choices.map(pick) : [pick(j.choice)]
      if (!picks.length || picks.some((x) => x === undefined)) return undefined
      const choices = [...new Set(picks as number[])]
      return { choice: choices[0], choices, why }
    }
    const choice = pick(j.choice)
    return choice === undefined ? undefined : { choice, why }
  }
  return undefined
}

/** the advice in words, as a card says it: the pick's labels, or its words */
export function adviceWords(a: Omit<Advice, 'by'>, q: AdviceQuestion): string {
  if (a.human) return `leaves it to you: ${a.human}`
  if (a.reply) return a.reply
  if (a.other) return a.other
  return (a.choices ?? [a.choice ?? -1]).map((i) => q.choices?.[i]?.label ?? '').filter(Boolean).join(', ')
}

/** one question's advice: asked, answered (and how), or left to the human */
export interface AdviceRec {
  chat: string
  /** the question it answers: a card's id, or `words:<id of the agent's last words>` for a plain question */
  question: string
  at: number
  state: 'asking' | 'suggested' | 'sent' | 'human' | 'failed'
  /** it went by itself (the question had waited), not on the human's word */
  auto?: boolean
  advice?: Advice
  /** the card the advice is shown on in the chat */
  card?: string
}

/** what the advisor was asked, per chat and question, kept across a restart (advice.json): never asked twice */
export class Advices {
  private data = readJson<Record<string, AdviceRec>>('advice.json', {})

  key = (chat: string, question: string) => `${chat}|${question}`

  get(chat: string, question: string): AdviceRec | undefined {
    return this.data[this.key(chat, question)]
  }

  byCard(card: string): AdviceRec | undefined {
    return Object.values(this.data).find((r) => r.card === card)
  }

  set(r: AdviceRec) {
    this.data[this.key(r.chat, r.question)] = r
    // a month of them at most: an old question is never asked again anyway, its card is long answered
    const old = Date.now() - 30 * 86_400_000
    for (const [k, v] of Object.entries(this.data)) if (v.at < old) delete this.data[k]
    writeJson('advice.json', this.data)
  }
}

/** the harness in words, for a card: who answered */
export const advisorWords = (h: Harness) => harnessWords(fitHarness(h))
