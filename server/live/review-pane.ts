// A review round the human can watch (SHE-182): the round's reviewer starts interactive and read-only in a new tab of
// the task's herdr worktree space, beside the task's agent. Shepherdr sends it the prompt, waits in the foreground for its
// findings, reads them from the reviewer's *own* CLI log (the readers Shepherdr already uses for its agents, never the
// screen), and closes the pane. A pane that cannot open, or a CLI that will not start, is the one reason to fall back to
// the headless line (prompts.ts reviewRunLine) — the pane is not a silent replacement for a review.
import { existsSync, readFileSync } from 'node:fs'
import { herdr } from './herdr.ts'
import { REVIEW_TIMEOUT, reviewerPaneArgs, type Reviewer } from './prompts.ts'
import { claudeLogPath, findLog } from './readers/find.ts'
import { LogTail, readerFor } from './readers/index.ts'
import type { LogEvent } from './readers/types.ts'

/** the herdr calls the pane round makes; the real `herdr` is the default, tests pass a fake with the same shape */
export interface PaneHerdr {
  workspaces(): Promise<{ workspace_id: string; label: string }[]>
  createTab(workspace_id: string, label: string, cwd: string, env?: Record<string, string>): Promise<{ root_pane: { pane_id: string } }>
  start(name: string, kind: string, pane_id: string, args?: string[]): Promise<unknown>
  prompt(target: string, text: string): Promise<unknown>
  visible(pane_id: string): Promise<string>
  paneKeys(pane_id: string, keys: string[]): Promise<unknown>
  closePane(pane_id: string): Promise<unknown>
}

/** what the round needs from the world; the sleep and clock are injectable so a test does not wait 15 minutes */
export interface RoundDeps {
  h?: PaneHerdr
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  timeout?: number
  poll?: number
  /** where to look for the reviewer's transcript; defaults to the CLI's own log, found by cwd and start time */
  findings?: (kind: string, cwd: string, since: number, session?: string) => Promise<{ text: string; done: boolean }>
  onStep?: (words: string) => void
}

export interface RoundResult {
  /** the pane that was opened, when there was one; the caller closes it on fallback too */
  pane?: string
  args?: string[]
  /** the reviewer's last plain message */
  findings: string
  /** the turn was cut by the timeout or a provider error: findings are partial, marked as such for the task agent */
  cutShort?: boolean
  /** why a pane could not be used: the caller prints the headless line and leaves the round for `--done` */
  failed?: string
}

/** the names herdr accepts: [a-z][a-z0-9_-]{0,31}; a round's reviewer is named after its task and role */
const paneName = (id: string) => `shep-${id.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}-review`

/** the startup screens Shepherdr answers itself, as it does for its own launches (SHE-134): never left waiting */
const DIALOG = /trust this folder|do you trust|trust the authors|allow external imports|external (claude|md) import|yes,? i trust/i

async function answerStartup(h: PaneHerdr, pane: string, sleep: (ms: number) => Promise<void>) {
  for (let i = 0; i < 8; i++) {
    const screen = await h.visible(pane).catch(() => '')
    if (!DIALOG.test(screen)) return
    await h.paneKeys(pane, ['enter']).catch(() => undefined)
    await sleep(400)
  }
}

/** the last plain message of a CLI log: its reader's `agent` events, latest text per id, in write order. `done` is its
 *  end-of-turn marker — all five readers emit one. A timeout reads whatever is there, so a cut round keeps its findings
 *  (SHE-180's rule) instead of starting over. */
export async function readFindings(kind: string, cwd: string, since: number, session?: string): Promise<{ text: string; done: boolean }> {
  const reader = readerFor(kind)
  if (!reader) return { text: '', done: false }
  const file = kind === 'claude' && session ? claudeLogPath(cwd, session) : findLog(kind, cwd, since)
  if (!file || !existsSync(file)) return { text: '', done: false }
  const events: LogEvent[] = new LogTail(file, reader).readAll()
  let text = ''
  let done = false
  for (const e of events) {
    if (e.kind === 'agent') text = e.text
    else if (e.kind === 'turn-end') done = true
    else if (e.kind === 'error') done = true
  }
  return { text: text.trim(), done }
}

/**
 * Open the round's reviewer in a pane, send it the prompt, wait for its findings and close the pane. Every failure to
 * open or start it is reported as `failed` with nothing else done: a review that could not run must be said, never
 * passed off as one that found nothing. On a timeout the pane is closed and whatever the reviewer had written comes
 * back marked `cutShort`.
 */
export async function runReviewInPane(
  o: {
    id: string
    round: number
    reviewer: Reviewer
    cwd: string
    workspace: string
    prompt: string
    env: Record<string, string>
    trust?: (cwd: string, kind: string, env: Record<string, string>) => void
    prepare?: (kind: string, chat: string, reviewer: Reviewer) => Promise<{ session?: string; sessionId?: string; extra?: string[] }>
  } & RoundDeps,
): Promise<RoundResult> {
  const h = o.h ?? herdr
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const timeout = o.timeout ?? REVIEW_TIMEOUT
  const poll = o.poll ?? 1000
  const start = o.now?.() ?? Date.now()
  const kind = o.reviewer.kind
  const chat = `${o.id}/Reviewer`
  let pane: string | undefined
  let name: string | undefined
  const step = (s: string) => o.onStep?.(s)

  try {
    // a task's worktree has a herdr space of its own; its agent's tab is one tab in it, the reviewer's another. A space
    // that closed with its agent's last pane is reopened by the task's own launch path before a round can be counted.
    const ws = (await h.workspaces()).find((w) => w.label === o.workspace)
    if (!ws) throw new Error(`${o.workspace} has no herdr space: its task's agent pane is not open`)
    pane = (await h.createTab(ws.workspace_id, `${o.id} reviewer`, o.cwd, o.env)).root_pane.pane_id
    name = paneName(o.id)
    o.trust?.(o.cwd, kind, o.env)
    const prepared = (await o.prepare?.(kind, chat, o.reviewer)) ?? {}
    const args = [...reviewerPaneArgs(o.reviewer, prepared), ...(prepared.extra ?? [])]
    await h.start(name, kind, pane, args)
    await answerStartup(h, pane, sleep)
    step(`Review round ${o.round} running in a pane: ${o.id} reviewer (${kind}).`)
    await h.prompt(name, o.prompt)

    const read = o.findings ?? readFindings
    let text = ''
    let done = false
    const until = start + timeout
    for (;;) {
      const got = await read(kind, o.cwd, start - 2000, prepared.sessionId ?? prepared.session)
      text = got.text || text
      done = got.done
      if (done && text) break
      if ((o.now?.() ?? Date.now()) >= until) {
        step(`Review round ${o.round}'s pane timed out after ${Math.round(timeout / 1000)} s; keeping what it wrote so far.`)
        return { pane, args, findings: text, cutShort: true }
      }
      await sleep(poll)
    }
    return { pane, args, findings: text }
  } catch (e) {
    return { pane, findings: '', failed: (e as Error).message || String(e) }
  } finally {
    if (pane) await h.closePane(pane).catch(() => undefined)
  }
}

/** a reviewer's prompt: Shepherdr's own reminders are added to the short prompt file the task agent wrote, so every
 *  CLI sees the same severity tags and the same "last plain message" rule, whatever the round's harness. */
export function reviewerPrompt(base: string, o: { id: string; round: number; privacy: string }): string {
  return [
    base.trim(),
    `You are ${o.id}'s reviewer, round ${o.round}. Read only: never edit, commit or push. Read the change yourself with git diff <merge-base>...HEAD, git log and the files; the brief and the base are below in the prompt above.`,
    "Report what this change broke, left undone or added beyond the brief, each with proof and tagged critical (breaks or loses users' work), major (a user would hit it, or it proves a claim false), minor (rarely hit) or trivial (style).",
    'Write your findings as your LAST plain message: never a plan to approve, never a question, never a summary that ends the task. Start no other agents. Say "no findings" plainly when there are none.',
    o.privacy,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** caller's convenience: a short prompt file the task agent wrote, read by reference (never pasted into a shell word) */
export function readPromptFile(path: string): string {
  if (!existsSync(path)) throw new Error(`No prompt file ${path}; write the reviewer's short prompt to a file first`)
  return readFileSync(path, 'utf8')
}
