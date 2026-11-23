// biome-ignore-all lint/style/noNonNullAssertion: the merge code is moved here from engine.ts as it stood (SHE-159),
// biome-ignore-all lint/complexity/noCommaOperator: so that a reviewer can diff the move with git diff --color-moved: its
// biome-ignore-all lint/style/useConst: non-null assertions, comma operators, assignments in expressions and `let`s that
// biome-ignore-all lint/suspicious/noAssignInExpressions: could be constants are the file's own style there, not a fix of this task's.
//
// The merges: a task's work into its base, and what GitHub says about it on the way. Shepherdr squash-merges a
// task's branch into its base, here or on GitHub through the task's pull request, at the commit this machine has;
// waits for, or reads, GitHub's checks on that pull request, and tells the agent about them (a failure, a review, a
// comment); keeps one merge at a time per repo, with the others in line, and the space's merge train; tells the agent
// when the merge it asked for went on past its deadline and how it ended; and watches main after merges, telling its
// coordinator once a run there fails. Kept apart from engine.ts, which holds the tasks' own life (adding, starting,
// status, reviews) and hands this module what it reads of it (MergeHost), so a change to merge rules touches one file.
import { existsSync } from '../mfs.ts'
import { hidden, type Agents } from '../agents.ts'
import { prNewsLine, splitBrief } from '../prompts.ts'
import { placeId, type Places, type Space } from '../places.ts'
import { CLI_NAME, type Settings } from '../settings.ts'
import type { Chats } from '../chats.ts'
import { ended, type Engine, type Landing, type TaskRec } from './engine.ts'
import * as G from './git.ts'

/** one line of the server's log about a merge train's decision: what it decided and why, never a file's contents */
export const trainLog = (line: string) => console.error(`shepherdr: ${line}`)

/** how long shepherdr checks waits for GitHub's checks at most, and how often it looks */
const CHECKS_WAIT = 9 * 60_000
const CHECKS_EVERY = 10_000
/** checks a repo's workflows will start may take this long to show on a pull request just pushed */
const CHECKS_SHOW = 90_000

/** main's checks on GitHub are watched this long after a task merged through its pull request */
const MAIN_WATCH = 3 * 3_600_000

/** the failed checks at a commit, as one key: the same failure is told once */
const failKey = (head: string, c: G.PrChecks) =>
  `${head}:${c.failed
    .map((f) => f.name)
    .sort()
    .join(',')}`

/** what someone wrote, as quoted to an agent: indented, and cut when long */
const quote = (s: string, max = 1500) =>
  (s.length > max ? `${s.slice(0, max)}…` : s)
    .split('\n')
    .map((l) => `    ${l}`.trimEnd())
    .join('\n')

const COMMENT: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', COMMENTED: 'Review' }

/** now, as GitHub writes times (to the second): what is compared with them */
export const ghNow = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

/** a pull request's footer, as the agent's CLI signs its work */
const SIGNED: Record<string, string> = { claude: '🤖 Generated with [Claude Code](https://claude.com/claude-code)', codex: '🤖 Generated with [Codex](https://openai.com/codex)' }

/** the marks around the part of a pull request's description Shepherdr writes; a later ready replaces only that part,
 *  keeping whatever a person added around it on GitHub (SHE-193). */
export const PR_BODY_START = '<!-- shepherdr -->'
export const PR_BODY_END = '<!-- /shepherdr -->'

/** A mark quoted in the summary, facts or brief is escaped: the only real marks in a body must be ours, or the next
 *  ready would close the block at the quoted one and leave a second copy of the rest behind. */
const escapeMarks = (s: string) => s.replaceAll(PR_BODY_START, '&lt;!-- shepherdr --&gt;').replaceAll(PR_BODY_END, '&lt;!-- /shepherdr --&gt;')

/** The description a ready makes of the one on GitHub: our marked part replaced, the words around it kept. An older,
 *  unmarked body is rewritten whole, as before: without marks there is no way to tell our words from a person's.
 *  `undefined` means leave it alone: with only one mark the block is broken and rewriting would erase a person's notes. */
export function described(current: string | undefined, want: string): string | undefined {
  const body = current ?? ''
  const a = body.indexOf(PR_BODY_START)
  const b = body.indexOf(PR_BODY_END)
  if (a < 0 && b < 0) return want
  const end = a < 0 ? -1 : body.indexOf(PR_BODY_END, a + PR_BODY_START.length)
  if (end < 0) return undefined
  return body.slice(0, a) + want + body.slice(end + PR_BODY_END.length)
}

export interface MergeHost {
  /** the tasks as the engine holds them now */
  tasks(): TaskRec[]
  agents: Agents
  chats: Chats
  places: Places
  settings: Settings
  /** how long shepherdr merge may take before it answers that it isn't through yet (the engine's, a test shortens it) */
  mergeDeadline: number
  /** the merge's catch-up fetch, shorter than the caller's deadline (the engine's, a test shortens it) */
  mergeFetchMs: number
  /** the engine's events (source.ts listens: news, a card, a task gone) */
  emit: Engine['emit']
  saveNow(): void
  /** what is held for the store goes to disk first, before a restart's merges wait (the engine's flush) */
  flush(): void
  writeFailed(e: unknown): void
  /** the task's row and place, as its record says now */
  settle(t: TaskRec): void
  proj(t: TaskRec): Space
  nameOf(t: TaskRec): string | undefined
  /** the key of its agent's chat */
  key(t: TaskRec): string
  req(id: string): TaskRec
  /** main's failing commit on GitHub, per repo, until main is green again: told once, and kept in tasks.json */
  red(path: string): string | undefined
  setRed(path: string, sha: string): void
  clearRed(path: string): void
  /** what starts its agent when it hears news and has none running (the engine's own starter) */
  starter(t: TaskRec): () => Promise<unknown>
  sendBack(t: TaskRec, text: string): Promise<void>
  /** a merged task's place put away: agent, space, worktree and branch */
  cleanup(t: TaskRec): Promise<unknown>
  /** its work is in its base already, merged on GitHub or by hand: why, or null */
  mergedAlready(t: TaskRec): Promise<string | null>
  /** why its final commit is not reviewed and the merge must wait, or undefined (the engine's review gate) */
  reviewGate(t: TaskRec): Promise<string | undefined>
  /** the space's merge gate (merge.gate), run on the branch as it would go in (the engine's own gate) */
  gate(
    t: TaskRec,
    repo: string,
    space: string,
    wt: string,
    on?: string,
    refresh?: () => Promise<void>,
  ): Promise<{ ok: true; line?: string; at?: string } | { ok: false; error: string; stopped?: true }>
  /** others in line behind it go in with it on one gate run (the engine's own train) */
  train(t: TaskRec, p: Space, wt: string): Promise<{ ok: boolean; error?: string; note?: string } | undefined>
  /** how many merges a space's train takes at most (merge.train) */
  trainSize(space: string): number
}

/**
 * The checks an automatic merge counts: only the ones GitHub says the base branch requires, so a red or still-running
 * optional check cannot hold a merge GitHub would allow (#1221). When GitHub cannot name any (no protection, a
 * permission error, an unreadable answer) or names none of the reported ones, every check counts: a required one must
 * never be taken for optional. By-hand `shepherdr checks` and "after GitHub checks" never call this: they stay strict.
 */
export function onlyRequired(c: G.PrChecks, required: string[] | undefined): G.PrChecks | undefined {
  if (!required?.length || !c.checks?.length) return undefined
  const checks = c.checks.filter((x) => required.includes(x.name))
  if (!checks.length || checks.length === c.checks.length) return undefined
  const failed = checks.filter((x) => x.bucket === 'fail' || x.bucket === 'cancel').map((x) => ({ name: x.name, link: x.link || undefined }))
  return {
    state: failed.length ? 'fail' : checks.some((x) => x.bucket === 'pending') ? 'pending' : 'pass',
    passed: checks.filter((x) => x.bucket === 'pass').length,
    failed,
    checks,
  }
}

/** the same rule, read through gh when there's something unsettled to decide about (an all-green PR asks nothing more) */
export async function autoChecks(g: G.GitHub, cwd: string, n: number, c: G.PrChecks): Promise<G.PrChecks> {
  if (c.state !== 'fail' && c.state !== 'pending') return c
  return onlyRequired(c, await G.requiredChecks(g, cwd, n)) ?? c
}

export class MergeRunner {
  /** one merge at a time per repo: each one's main checkout is shared. The engine reads it too: a task being deleted
   *  waits for its repo's merge first (deleteTask) */
  readonly merging = new Map<string, Promise<unknown>>()
  /** merges whose caller heard by the deadline that they go on: their agent is told how each went (tellMerge) */
  readonly lateFor = new Set<string>()
  /** each task's merge while it runs: the engine's line and its trains read it, to know a merge is in flight */
  readonly landings = new Map<string, Promise<{ ok: boolean; error?: string; note?: string }>>()
  /** the task whose merge runs in each repo now: one asked meanwhile waits behind it (merge) */
  private mergingNow = new Map<string, string>()
  /** stopping: no merge starts */
  private closing = false
  /** how long GitHub's checks took lately, per repo, and when that was asked */
  private took = new Map<string, { ms?: number; at: number }>()
  /** a look at done tasks' pull requests is under way */
  private watching = false
  /** a look at main's checks is under way */
  private watchingMain = false

  constructor(private e: MergeHost) {}

  /* ---------- GitHub: pull requests ---------- */

  /**
   * The project's GitHub repo when gh is logged in to its host, read live: a repo may gain its remote after it was
   * added. Each form of origin is tried (as git rewrites it, as written) for one gh is logged in to. None: the task
   * merges here. Logged in but GitHub not answering throws: that never falls back to merging here.
   */
  async hub(p: Space): Promise<G.GitHub | null> {
    const was = p.github
    await this.e.places.recheckGithub(p)
    if (p.github !== was) this.e.emit('changed')
    let down: string | undefined
    for (const g of await G.githubs(p.path)) {
      const l = await G.ghLogin(g, p.path)
      if (l.state === 'yes') return g
      if (l.state === 'down') down ??= `${g.host}: ${l.said}`
    }
    if (down) throw new Error(`gh can't reach GitHub now (${down}). Nothing was done: try again in a while, or see gh auth status.`)
    return null
  }

  /** A pull request is found by its task's id, so its title starts with it, as our squash-merge commits do
   *  ("SHE-12: …"). A title that already names the id is not made to name it twice. Set only when the pull request
   *  opens: a title the human edited by hand is never renamed afterwards. */
  private prTitle(t: TaskRec) {
    const title = (t.title || '').trim().replace(/\s+/g, ' ')
    const id = t.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const rest = title.replace(new RegExp(`^${id}\\b[\\s:-]*`, 'i'), '').trim()
    return `${t.id}: ${rest || t.id}`
  }

  /** The pull request's words: its task's id, the summary, the proof (the facts the task reported) and the brief's
   *  gist, so a reviewer reads what changed first and can still see what was asked. The brief stays reachable here:
   *  it lives with the task in Shepherdr too. Between the marks, so a later ready rewrites only this part and keeps
   *  a person's words around it; the title is touched only when the pull request opens, so a hand-edited one is left alone. */
  private prBody(t: TaskRec) {
    const kind = this.e.agents.record(this.e.key(t))?.kind ?? t.agent?.kind ?? this.e.settings.harness('task', this.e.nameOf(t)).kind
    // the coordinator's words, not the default way of working Shepherdr ended the brief with
    const brief = (splitBrief(t.desc)[0] || t.title).trim()
    const gist = brief.length > 700 ? `${brief.slice(0, 700).replace(/\s+\S*$/, '')} …` : brief
    const inner = [
      `Task: ${t.id}`,
      `## Summary\n\n${t.said || 'Work in progress: the summary comes when the task is done.'}`,
      ...(t.facts ? [`## Proof\n\n${t.facts}`] : []),
      `**Brief** (what was asked)\n\n${gist
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n')}`,
      SIGNED[kind] ?? `🤖 Generated with ${CLI_NAME[kind] ?? kind}`,
    ].join('\n\n')
    return [PR_BODY_START, escapeMarks(inner), PR_BODY_END].join('\n\n')
  }

  /** Rewrite the description GitHub has now, keeping any words a person added around our marked part. A body GitHub
   *  won't show is left alone: rewriting blind would erase what we could not read. */
  private async editPrBody(t: TaskRec, g: G.GitHub, cwd: string, n: number) {
    const current = await G.viewPr(g, cwd, n)
    if (!current) return trainLog(`${t.id}: pull request description not updated: GitHub did not show it`)
    const next = described(current.body, this.prBody(t))
    if (!next) return trainLog(`${t.id}: pull request description not updated: its Shepherdr marks are incomplete`)
    await G.editPr(g, cwd, n, next)
  }

  /** its pull request as GitHub has it now: the one recorded, else the branch's own (one opened by hand) */
  async prOf(t: TaskRec, g: G.GitHub, cwd: string) {
    const known = t.pr ? await G.viewPr(g, cwd, t.pr.number) : null
    // one closed on GitHub is no longer its pull request: the branch may have another, or a fix-forward branch may
    // carry its exact tip. The worktree's head is findPr's fallback when no pull request answers to the branch name.
    const live = known && known.state !== 'CLOSED' ? known : null
    const pr = live ?? (await G.findPr(g, cwd, t.branch!, (await G.git(cwd, 'rev-parse', 'HEAD')).out))
    if ((pr?.number ?? null) !== (t.pr?.number ?? null) && (pr || known?.state === 'CLOSED')) {
      t.pr = pr ? { number: pr.number, url: pr.url } : undefined
      this.e.saveNow()
    }
    return pr
  }

  async readyForReview(t: TaskRec, hub?: G.GitHub) {
    const p = this.e.proj(t)
    const g = hub ?? (await this.hub(p))
    if (!g || !t.pr) return
    await this.editPrBody(t, g, p.path, t.pr.number)
    await G.readyPr(g, p.path, t.pr.number)
  }
  /** a merge that went on past its caller's deadline is through: its agent hears how it went, and wakes on it */
  private tellMerge(t: TaskRec, r: { ok: boolean; error?: string; note?: string }) {
    const words = r.ok ? `Your merge went in${r.note ? ` (${r.note})` : ''}: ${t.id} is merged. Nothing more to do for it: end your turn.` : `Your merge didn't go in: ${r.error}`
    void this.e.agents.send(this.e.key(t), hidden(words, 'merge')).catch(() => undefined)
  }
  /** a merge commit's words: the task and its title, what its agent said it did, its facts, then the lines after */
  mergeMessage(t: TaskRec, ...after: (string | undefined)[]) {
    return [`${t.id}: ${t.title}`, t.said, t.facts && `Facts: ${t.facts}`, ...after].filter(Boolean).join('\n\n')
  }

  /** a GitHub remote gh can't use (not logged in): main is pushed as it is here, and the note says how that went */
  async pushBase(p: Space, base: string, note?: string) {
    if (!p.github) return note
    const push = await G.git(p.path, 'push', '--quiet', 'origin', base)
    // pushing the base is not a task branch: keep git's own one line, whatever refused it
    const pushed = push.ok ? `pushed ${base} to GitHub` : `could not push ${base} to GitHub: ${G.pushWords(push).split('\n')[0]}`
    return note ? `${note}; ${pushed}` : pushed
  }

  /** a task's merge gate command, its own --set first, then its space's; nothing while it is off */
  gateOf(t: TaskRec, space = this.e.nameOf(t)) {
    const cmd = (t.set?.['merge.gate'] ?? this.e.settings.get('merge.gate', space)).trim()
    return cmd && cmd.toLowerCase() !== 'off' ? cmd : undefined
  }

  /** a push a hook refused, in the agent's tool output and on this task's own row (#963): the hook's last lines,
   *  stdout included, with any value it printed redacted. Nothing here reaches another task's chat or row. */
  private pushFailed(t: TaskRec, branch: string, push: G.Run): string {
    const { text, row } = G.pushRefusal(branch, push)
    t.mergeStop = row
    this.e.settle(t)
    return text
  }

  /**
   * #1194: ready, pr and merge publish the task branch's tip, never whatever HEAD happens to name. A worktree switched
   * to another branch would push that branch's commit as the task's, so refuse before anything goes out, naming the
   * branch in front, the task's own branch and the way back. A detached HEAD at the task branch's own tip is a check
   * run (a gate detaches there), so it is allowed. A merge reattaches any detached worktree to its branch before this
   * runs (as it always has, so a dead gate's stack top does not block it); ready and pr refuse a detached commit that
   * is not the task branch's own tip.
   */
  async branchGuard(t: TaskRec): Promise<string | undefined> {
    // no worktree, or one put away: there is no branch in front to publish, as elsewhere in done and markReady
    if (!t.worktree || !t.branch || !existsSync(t.worktree)) return undefined
    const here = await G.git(t.worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD')
    if (here.ok) {
      if (here.out === t.branch) return undefined
    } else {
      const at = await G.git(t.worktree, 'rev-parse', 'HEAD')
      const own = await G.git(t.worktree, 'rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`)
      if (at.ok && own.ok && at.out === own.out) return undefined
    }
    const inFront = here.ok ? here.out : `a detached commit (${(await G.git(t.worktree, 'rev-parse', '--short', 'HEAD')).out})`
    const pr = t.pr ? ` (its pull request is #${t.pr.number})` : ''
    return `HEAD is on ${inFront}, not on ${t.id}'s branch ${t.branch}${pr}: shepherdr pushes and opens only ${t.branch}. Move the work to ${t.branch} (git switch ${t.branch}, then merge or cherry-pick it), or, for another pull request, open it yourself and ask your coordinator for a task to track it.`
  }

  /** push the task's branch as it is committed, to GitHub: forced, since it is rebased on main and only its agent's */
  private async push(t: TaskRec) {
    const sha = (await G.git(t.worktree!, 'rev-parse', 'HEAD')).out
    const r = await G.git(t.worktree!, 'push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${t.branch}`)
    if (r.ok) {
      t.pushed = { sha, at: Date.now() }
      // a push that works again clears the refusal it left on this task's row, without touching a gate's own note
      if (t.mergeStop?.startsWith('Could not push ')) {
        t.mergeStop = undefined
        this.e.settle(t)
      }
      this.e.saveNow()
    }
    return r
  }

  /** a GitHub step that could not reach GitHub says so, and did nothing */
  private async onGitHub<T extends { ok: boolean }>(f: () => Promise<T>, failed: (why: string) => T): Promise<T> {
    try {
      return await f()
    } catch (e) {
      return failed((e as Error).message)
    }
  }

  /**
   * shepherdr pr: push the branch and open its pull request (a draft until the agent reports done), or bring the open
   * one up to the branch. Its title names the task's id; its body is the summary, the proof and the brief's gist.
   */
  openPr(id: string): Promise<{ ok: boolean; text: string }> {
    return this.onGitHub(
      () => this.openPrNow(this.e.req(id)),
      (text) => ({ ok: false, text }),
    )
  }

  private async openPrNow(t: TaskRec): Promise<{ ok: boolean; text: string }> {
    if (ended(t)) return { ok: false, text: `${t.id} is Done already (${t.closed ? 'nothing to merge' : 'merged'}).` }
    if (!t.worktree || !t.branch || !t.base) return { ok: false, text: `${t.id} has no branch yet.` }
    const wrong = await this.branchGuard(t)
    if (wrong) return { ok: false, text: wrong }
    const p = this.e.proj(t)
    const g = await this.hub(p)
    if (!g)
      return {
        ok: true,
        text: `No pull request: ${this.e.places.shownName(p.name)} has no GitHub remote, or gh isn't logged in to it (gh auth status). shepherdr merge ${t.id} squash-merges it here.`,
      }
    if ((await G.aheadCount(t.worktree, t.base)) === 0) return { ok: false, text: `${t.id} has no commits yet: commit your work, then run shepherdr pr ${t.id} again.` }
    const dirty = await G.dirty(t.worktree)
    const pushed = await this.push(t)
    if (!pushed.ok) return { ok: false, text: this.pushFailed(t, t.branch, pushed) }
    let pr = await this.prOf(t, g, t.worktree)
    if (pr && pr.baseRefName !== t.base) return { ok: false, text: `PR #${pr.number} targets ${pr.baseRefName}, but ${t.id} targets ${t.base}. Correct the pull request target on GitHub first.` }
    let opened = false
    if (pr?.state === 'MERGED') return { ok: false, text: `PR #${pr.number} is merged on GitHub already: run shepherdr merge ${t.id} to mark it merged and clean up.` }
    if (!pr) {
      const o = await G.openPr(g, t.worktree, { branch: t.branch, base: t.base, title: this.prTitle(t), body: this.prBody(t), draft: !t.reported })
      if ('error' in o) return { ok: false, text: `Pushed ${t.branch}, but GitHub did not open a pull request: ${o.error}` }
      t.pr = { number: o.number, url: o.url }
      this.e.saveNow()
      opened = true
    } else if (t.reported) await this.readyForReview(t, g)
    const head = (await G.git(t.worktree, 'rev-parse', '--short', 'HEAD')).out
    return {
      ok: true,
      text: `${opened ? `Opened PR #${t.pr!.number}${t.reported ? '' : ' as a draft'}` : `Pushed to PR #${t.pr!.number}`} at ${head}: ${t.pr!.url}${dirty ? '\nUncommitted changes are not in it: commit them and run shepherdr pr again.' : ''}\n${(t.waitChecks ?? this.e.settings.ways(p.name).waitChecks) ? `Next: shepherdr checks ${t.id} waits for all of GitHub's checks (run it with a long timeout, up to 10 minutes).` : `Merging waits only for checks your base branch requires; shepherdr checks ${t.id} waits for all of them.`}`,
    }
  }

  /**
   * GitHub's checks on the task's pull request, waited for while they run (up to `waitMs`). GitHub saying "no checks"
   * is only none when the repo has no workflow that could run on the pull request (#1044/#1018): a just-pushed commit
   * shows none for a moment, which is waited out and never taken as passed. An unfiltered PR workflow keeps waiting
   * (never a none-decided merge); a paths/branches-filtered one is not decided on the first read, but after the same
   * 90 s is taken as not applying to this change. GitHub not answering three times running is said, not waited on.
   */
  private async checksOf(t: TaskRec, g: G.GitHub, n: number, waitMs: number, onStep?: (words: string) => void): Promise<G.PrChecks> {
    const t0 = Date.now()
    const head = (await G.git(t.worktree!, 'rev-parse', 'HEAD')).out
    const expect = await G.prWorkflowExpect(t.worktree!)
    let errors = 0
    for (;;) {
      const c = await G.prChecks(g, t.worktree!, n)
      // one interim line per poll: the command's step channel, never its answer (UXD-08)
      onStep?.(
        `checks: ${c.state === 'unknown' ? 'waiting for GitHub to report checks' : c.state === 'error' ? 'could not read GitHub, trying again' : c.state === 'none' ? 'no checks reported yet' : `${c.passed} passed${c.failed.length ? `, ${c.failed.length} failed` : ''}${c.state === 'pending' ? ', still running' : ''}`}`,
      )
      errors = c.state === 'error' ? errors + 1 : 0
      const waited = t.pushed?.sha !== head || Date.now() - t.pushed.at >= CHECKS_SHOW
      const verdict = c.state === 'none' && expect !== 'none' ? G.noneIsUnknown(expect, waited) : c
      if (verdict.state === 'pass' || verdict.state === 'fail' || verdict.state === 'none') return verdict
      if (errors >= 3) return c
      if (verdict.state === 'unknown' && waited) return verdict
      if (Date.now() - t0 + CHECKS_EVERY > waitMs) return verdict
      await Bun.sleep(CHECKS_EVERY)
    }
  }

  /** a ready task's next step into main (Merging), or none: Ready again, or back at work */
  land(t: TaskRec, step?: Landing['step'], due?: number, more?: Partial<Landing>) {
    if (!t.reported || ended(t)) return
    t.landing = step ? { step, at: Date.now(), due, ...more } : undefined
    this.e.saveNow()
    this.e.settle(t)
  }

  /** when GitHub's checks at `head` should be through: from when it was pushed, as long as they took lately */
  private async checksDue(t: TaskRec, p: Space, g: G.GitHub, head: string) {
    let took = this.took.get(p.path)
    if (!took || Date.now() - took.at > 30 * 60_000) {
      took = { ms: await G.checksTook(g, p.path).catch(() => undefined), at: Date.now() }
      this.took.set(p.path, took)
    }
    if (took.ms === undefined) return undefined
    return (t.pushed?.sha === head ? t.pushed.at : Date.now()) + took.ms
  }

  /** why a still-unreported check is waited for, in the answer and the task's row (#1044/#1018) */
  private checksWhy(expect?: G.ChecksExpect) {
    return expect === 'maybe' ? 'a workflow with paths or branches filters may still run on this change' : 'the repo has a workflow that runs on pull requests'
  }

  /** which of GitHub's checks failed, and where to see why */
  private checksFailed(n: number, c: G.PrChecks) {
    const link = c.failed.find((f) => f.link)?.link
    return `GitHub's checks failed on PR #${n}: ${c.failed.map((f) => f.name).join(', ')}.${link ? ` See ${link} (gh run view --log-failed shows why).` : ''}`
  }

  private fixIt = (t: TaskRec) => `Fix it, commit, push with shepherdr pr ${t.id}, wait with shepherdr checks ${t.id}, then run shepherdr merge ${t.id} again.`

  /** shepherdr checks: wait for GitHub's checks on the task's pull request, at the commit this machine has */
  checks(id: string, waitMs = CHECKS_WAIT, onStep?: (words: string) => void): Promise<{ ok: boolean; text: string }> {
    return this.onGitHub(
      () => this.checksNow(this.e.req(id), waitMs, onStep),
      (text) => ({ ok: false, text }),
    )
  }

  private async checksNow(t: TaskRec, waitMs: number, onStep?: (words: string) => void): Promise<{ ok: boolean; text: string }> {
    if (!t.worktree || !t.branch) return { ok: false, text: `${t.id} has no branch yet.` }
    const p = this.e.proj(t)
    const g = await this.hub(p)
    if (!g) return { ok: true, text: `No GitHub checks: ${this.e.places.shownName(p.name)} has no GitHub remote, or gh isn't logged in to it. Run the project's own checks here.` }
    const pr = await this.prOf(t, g, t.worktree)
    if (!pr) return { ok: false, text: `${t.id} has no pull request yet: shepherdr pr ${t.id} pushes the branch and opens one.` }
    const head = (await G.git(t.worktree, 'rev-parse', 'HEAD')).out
    if (pr.headRefOid !== head) return { ok: false, text: `PR #${pr.number} is not at your commit (${head.slice(0, 7)}): push it with shepherdr pr ${t.id} first.` }
    // on its way into main (a merge waits for them): the row says they run, then what comes next
    if (t.landing) this.land(t, 'checks', await this.checksDue(t, p, g, head))
    const c = await this.checksOf(t, g, pr.number, waitMs, onStep)
    if (c.state === 'unknown') {
      if (t.landing) this.land(t, 'checks', await this.checksDue(t, p, g, head), { why: 'Checks not started yet' })
      return {
        ok: false,
        text: `No checks are reported on PR #${pr.number} yet, but ${this.checksWhy(c.expect)}: waiting for them to start, not merging. Run shepherdr checks ${t.id} again; if that workflow cannot run on this pull request, merge it by hand on GitHub.`,
      }
    }
    if (t.landing && c.state !== 'pending') this.land(t, c.state === 'pass' || c.state === 'none' ? 'merge' : undefined)
    if (c.state === 'fail') {
      this.toldFailed(t, head, c)
      return { ok: false, text: `${this.checksFailed(pr.number, c)} ${this.fixIt(t)}` }
    }
    if (c.state === 'pending') return { ok: false, text: `GitHub's checks still run on PR #${pr.number}: run shepherdr checks ${t.id} again.` }
    if (c.state === 'error') return { ok: false, text: `Could not read GitHub's checks on PR #${pr.number}: ${c.error}` }
    return { ok: true, text: c.state === 'none' ? `PR #${pr.number} has no checks on GitHub: nothing to wait for.` : `GitHub's checks passed on PR #${pr.number} (${c.passed}).` }
  }

  /**
   * News on done tasks' pull requests: checks that failed, and what someone wrote on it (a review, a comment) since its
   * agent reported done. Its agent hears each once, in <shepherdr> tags, which wakes it; what to do about it is its own
   * call (the shepherdr-agent skill). Only an agent at rest is told: one at work, or at a prompt, hears it next time.
   * A pull request merged on GitHub by hand ends the task here (Done, merged), whatever its checks say.
   */
  async watchPrs() {
    if (this.watching) return
    this.watching = true
    try {
      const hubs = new Map<string, G.GitHub | null>()
      for (const t of this.e.tasks().filter((t) => t.reported && t.pr && t.worktree && !ended(t) && !t.archived && !t.stopped)) {
        if (['working', 'blocked'].includes(this.e.agents.status(this.e.key(t)))) continue
        const p = this.e.places.space(t.project)
        if (!p || !existsSync(t.worktree!)) continue
        if (!hubs.has(p.path)) hubs.set(p.path, await this.hub(p).catch(() => null))
        const g = hubs.get(p.path)
        if (g) await this.watchPr(t, g).catch(() => undefined)
      }
    } finally {
      this.watching = false
    }
  }

  private async watchPr(t: TaskRec, g: G.GitHub) {
    const pr = await this.prOf(t, g, t.worktree!)
    // merged on GitHub by hand (a squash merge leaves its commits out of the base): Done as ready would, and no turn of
    // its own to be cut: a task on its way in (Merging) is its merge's own to mark
    if (pr?.state === 'MERGED') {
      if (t.landing) return
      const why = await this.e.mergedAlready(t).catch(() => null)
      if (why) await this.mergedOnGitHub(t, this.e.proj(t), why, 20_000).catch(() => undefined)
      return
    }
    if (pr?.state !== 'OPEN') return
    const w = (t.watch ??= { since: ghNow() })
    const news: string[] = []
    const what: string[] = []
    // an automatic merge hears only about checks its base requires: a red optional check neither takes the task out
    // of Ready nor stops the merge; a strict "after checks" task still hears about all of them
    const p = this.e.proj(t)
    const read = await G.prChecks(g, t.worktree!, pr.number)
    const c = (t.waitChecks ?? this.e.settings.ways(p.name).waitChecks) ? read : await autoChecks(g, t.worktree!, pr.number, read)
    const failed = c.state === 'fail' ? failKey(pr.headRefOid, c) : c.state === 'pass' ? undefined : w.failed
    if (c.state === 'fail' && failed !== w.failed) {
      for (const f of c.failed) {
        const log = f.link ? await G.failedLog(g, t.worktree!, f.link) : undefined
        news.push(`- Check failed: ${f.name}${f.link ? ` (${f.link})` : ''}${log ? `. Its log ends:\n${quote(log)}` : ''}`)
      }
      what.push(`${c.failed.map((f) => f.name).join(', ')} failed`)
    }
    const all = await G.prComments(g, t.worktree!, pr.number)
    const seen = new Set(w.seen)
    // an approval or a review with no words of its own (it only carries its line comments) is no news
    const fresh = (all ?? []).filter((x) => !seen.has(x.id) && x.at >= w.since && (x.body || x.state === 'CHANGES_REQUESTED'))
    for (const x of fresh) news.push(`- ${x.state ? (COMMENT[x.state] ?? 'Review') : 'Comment'} by ${x.who}${x.where ? ` on ${x.where}` : ''} (${x.url}):\n${quote(x.body || '(no words)')}`)
    if (fresh.length) what.push(fresh.length === 1 ? 'a new comment' : `${fresh.length} new comments`)
    // put to work, or at a prompt, while GitHub was asked: it hears all this next time
    if (news.length && ['working', 'blocked'].includes(this.e.agents.status(this.e.key(t)))) return
    w.failed = failed
    if (all) w.seen = all.map((x) => x.id)
    this.e.saveNow()
    if (!news.length) return this.nudgeToMerge(t, pr.number, c)
    const id = `pr:${t.id}:${Date.now()}`
    this.e.chats.post(this.e.key(t), { id, card: { id, task: t.id, status: 'work', text: `woken: ${what.join(' and ')} on PR #${pr.number}`, pr: t.pr } })
    await this.e.sendBack(t, hidden(prNewsLine(t.id, t.pr!, news), 'github', { task: t.id, pr: String(t.pr!.number) }))
  }

  /**
   * On its way into main, its agent at rest with nothing left running to wake it, and GitHub's checks through: it is
   * told once to merge, so it never shows Merging while nothing happens.
   */
  private async nudgeToMerge(t: TaskRec, n: number, c: G.PrChecks) {
    const key = this.e.key(t)
    if (!t.landing || t.landing.nudged || (c.state !== 'pass' && c.state !== 'none') || this.e.agents.background(key)) return
    t.landing.nudged = true
    this.e.saveNow()
    const text = `GitHub's checks passed on PR #${n}: merge ${t.id} now (shepherdr merge ${t.id}), as your brief says.`
    await this.e.agents.send(key, hidden(text, 'github', { task: t.id, pr: String(n) }), { ensure: this.e.starter(t) }).catch(() => undefined)
  }

  /**
   * GitHub's checks on main after merges, which a task merges without waiting for (Settings), or that merged cleanly
   * but clash: once a run on main fails, its coordinator hears it once, with the run and the tasks merged since main
   * was last green. What follows (a fix task) is its call. Looked at while a task merged through its pull request
   * lately, or main is red, until it is green again.
   */
  async watchMains() {
    if (this.watchingMain) return
    this.watchingMain = true
    try {
      for (const p of this.e.places.spaces) await this.watchMain(p).catch(() => undefined)
    } finally {
      this.watchingMain = false
    }
  }

  private async watchMain(p: Space) {
    const red = this.e.red(p.path)
    const lately = Date.now() - MAIN_WATCH
    if (!red && !this.e.tasks().some((t) => t.merged && t.pr && (t.doneAt ?? 0) > lately && this.e.places.space(t.project) === p)) return
    const g = await this.hub(p).catch(() => null)
    const runs = g && (await G.branchRuns(g, p.path, p.base))
    // the newest commit on main its runs have a verdict on
    const i = runs ? runs.findIndex((r) => r.state !== 'pending') : -1
    if (!g || !runs || i < 0) return
    const now = runs[i]
    if (now.state === 'pass') {
      if (red) this.e.clearRed(p.path)
      if (red) this.e.saveNow()
      return
    }
    // told once while it stays red, whatever else merges meanwhile
    if (red) return
    this.e.setRed(p.path, now.sha)
    this.e.saveNow()
    const green = runs.slice(i + 1).find((r) => r.state === 'pass')?.sha
    await G.git(p.path, 'fetch', '--quiet', 'origin', p.base)
    const log = await G.git(p.path, 'log', '--format=%s', '-n', '20', green ? `${green}..${now.sha}` : `${now.sha}^!`)
    const merged = log.ok ? log.out.split('\n').filter(Boolean) : []
    const f = now.failed[0]
    const tail = await G.failedLog(g, p.path, f.link)
    const ids = merged.map((m) => m.match(/^([A-Z][A-Z0-9]*-\d+):/)?.[1]).filter((x): x is string => !!x)
    this.e.emit(
      'news',
      placeId.space(p.name),
      [
        `${p.base} went red on GitHub at ${now.sha.slice(0, 7)}: ${now.failed.map((x) => `${x.name} failed (${x.link})`).join(', ')}.`,
        `Merged since it was last green${green ? ` (${green.slice(0, 7)})` : ''}: ${merged.length ? merged.join('; ') : 'none Shepherdr can tell'}.`,
        tail ? `Its log ends:\n${quote(tail)}` : '',
        'A fix-forward task follows if you decide so: its brief names the failing run and these merges',
      ]
        .filter(Boolean)
        .join('\n'),
      'red',
      { task: ids[0] ?? '', event: 'main-red' },
      { red: p.base, text: `went red: ${now.failed.map((x) => x.name).join(', ')} failed` },
    )
  }

  /** checks that failed at a commit were told to the agent (shepherdr checks, merge): watching won't tell it again */
  private toldFailed(t: TaskRec, head: string, c: G.PrChecks) {
    t.watch = { ...t.watch, since: t.watch?.since ?? ghNow(), failed: failKey(head, c) }
    this.e.saveNow()
  }

  /* ---------- merging ---------- */

  /**
   * Rebase the task's branch on main, squash-merge it into main and mark it merged: through its pull request on a
   * GitHub repo gh is logged in to, else here. Its agent and worktree are put away once the agent's turn ends (it may
   * be the one asking). A conflict or failed checks stop it with what to do. Anyone but the task's own agent waits
   * until that agent's turn has ended, so no half-done work goes in.
   */
  merge(id: string, opts: { self?: boolean } = {}): Promise<{ ok: boolean; error?: string; note?: string }> {
    const t = this.e.req(id)
    if (this.closing) return Promise.resolve({ ok: false, error: `Shepherdr is restarting: nothing was merged. Run shepherdr merge ${t.id} again in a minute.` })
    // asked again while its merge still runs: the same one is waited for, never a second beside it
    let run = this.landings.get(t.id)
    // its own agent asking to merge says its work is ready, as shepherdr done does: one written to since it reported (a
    // coordinator's "rebase on main and merge") is on its way into main, and its row, its place in line and a restart
    // say so; never Needs you while its agent waits, as told, for how it went
    if (!run && opts.self && !t.reported && !ended(t)) {
      t.reported = true
      this.e.saveNow()
    }
    if (!run) {
      const repo = this.e.places.space(t.project)?.path ?? ''
      // in line behind another merge into its repo: its row says whose, and whether that one runs the gate
      const ahead = this.mergingNow.get(repo)
      if (ahead && ahead !== t.id && t.reported && !ended(t)) {
        t.landing = { step: 'queue', at: Date.now(), behind: ahead, gate: this.gateOf(t) !== undefined }
        this.e.saveNow()
        this.e.settle(t)
      }
      const now = (this.merging.get(repo) ?? Promise.resolve())
        .then(() => {
          this.mergingNow.set(repo, t.id)
          this.inLineBehind(repo, t)
          return this.onGitHub(
            () => this.mergeNow(t, !!opts.self),
            (error) => ({ ok: false, error: `Can't merge ${t.id}: ${error}` }),
          )
        })
        .finally(() => this.mergingNow.get(repo) === t.id && this.mergingNow.delete(repo))
        // stopped short with nothing more to wait for (failed checks, GitHub refused): Ready again, or back at work
        .then((r) => (!r.ok && (t.landing?.step === 'merge' || t.landing?.step === 'gate' || t.landing?.step === 'queue') && this.land(t), r))
        // its caller heard by the deadline that it goes on: its agent hears now how it went, and wakes on it
        .then((r) => (this.lateFor.delete(t.id) && this.tellMerge(t, r), r))
      run = now
      this.landings.set(t.id, now)
      const tail = now.catch(() => undefined)
      tail.then(() => this.landings.get(t.id) === now && this.landings.delete(t.id))
      // the next merge into this repo waits until this one is really through, however long: two at once would write
      // over each other's main. Its caller still hears by the deadline
      this.merging.set(repo, tail)
      tail.then(() => this.merging.get(repo) === tail && this.merging.delete(repo))
    }
    // its caller hears by the deadline, whatever hangs on the way (git, gh, GitHub): never a command that waits on and
    // on until the agent's shell moves it to the background, where its answer is lost. The merge itself goes on.
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<{ ok: boolean; error: string }>((done) => {
      timer = setTimeout(() => {
        this.lateFor.add(t.id)
        const l = t.landing
        const where =
          l?.step === 'queue' && l.train
            ? `goes in with ${l.train}'s merge train (its gate runs)`
            : l?.step === 'queue'
              ? `waits in line behind ${l.behind}'s${l.gate ? ' (one merge gate at a time)' : ''}`
              : l?.step === 'gate'
                ? 'is in its gate: its merge gate still runs'
                : `isn't through after ${Math.round(this.e.mergeDeadline / 1000)} s (git or GitHub is slow)`
        done({
          ok: false,
          error: `${t.id}'s merge ${where}. Shepherdr goes on with it and tells you here how it went (merged, or what stopped it): end your turn now, without polling or sleeping. A shepherdr merge ${t.id} meanwhile only waits for this one.`,
        })
      }, this.e.mergeDeadline)
    })
    return Promise.race([run, late]).finally(() => clearTimeout(timer))
  }

  /** `t`'s merge into `repo` takes its turn: each merge still in line there now waits behind it, and its row says so */
  private inLineBehind(repo: string, t: TaskRec) {
    let moved = false
    for (const x of this.e.tasks()) {
      if (x === t || x.landing?.step !== 'queue' || x.landing.behind === t.id || (this.e.places.space(x.project)?.path ?? '') !== repo) continue
      x.landing = { ...x.landing, behind: t.id }
      this.e.settle(x)
      moved = true
    }
    if (moved) this.e.saveNow()
  }

  /**
   * Shepherdr stops (an update restarts it, as one right after a merge into its own repo does): the merges on their
   * way finish first, at most their deadline, so none is cut halfway (merged on GitHub, never marked, its agent never
   * told) and each caller gets its answer. No new one starts meanwhile. True when there was one to wait for.
   */
  async drain(): Promise<boolean> {
    this.closing = true
    // SIGTERM/SIGINT reach here before stop(): everything held by a saveSoon timer is on disk first
    try {
      this.e.flush()
    } catch (e) {
      this.e.writeFailed(e)
    }
    const on = [...this.landings.values()]
    if (!on.length) return false
    await Promise.race([Promise.allSettled(on), Bun.sleep(this.e.mergeDeadline)])
    return true
  }

  private async mergeNow(t: TaskRec, self: boolean): Promise<{ ok: boolean; error?: string; note?: string }> {
    // one a merge train took along went in on that train's gate: its own turn only says so
    if (t.merged) return t.train ? { ok: true, note: `it went in with ${t.train}'s merge train` } : { ok: false, error: `${t.id} is already merged` }
    if (t.closed) return { ok: false, error: `${t.id} is Done: it had nothing to merge` }
    if (!t.worktree || !t.branch || !t.base) return { ok: false, error: `${t.id} has no branch yet` }
    if (!self && this.e.agents.status(this.e.key(t)) === 'working')
      return { ok: false, error: `${t.id}'s agent is working: wait for its turn to end, or ask it to merge (shepherdr task tell ${t.id} "merge it").` }
    // a late note from you or a coordinator, not read yet, may change what goes in
    if (this.e.chats.unseen(this.e.key(t)).length)
      return {
        ok: false,
        error: self ? 'You have a new message in your chat: read and handle it, then merge again.' : `${t.id}'s agent has a new message it hasn't read yet: let it handle that first.`,
      }
    // asked by you or a coordinator, with its agent at rest: going in, it is on its way into main as one reported is
    if (!t.reported) t.reported = true
    this.land(t, 'merge')
    t.mergeStop = undefined
    const p = this.e.proj(t)
    const wt = t.worktree
    // main here first catches up with the remote's, so the branch is rebased on what main really is. Bound the fetch
    // well under the caller's deadline: an answerless remote must free this repo's place in the queue with words
    // about it, not leave every later merge here waiting behind this one
    const up = await G.catchUp(p.path, t.base, 'then merge again', this.e.mergeFetchMs)
    if (!up.ok) return { ok: false, error: `Can't merge ${t.id}: ${up.err}` }
    // a timed-out fetch is offline, not a refusal: the merge goes on from the base as it is here, but the agent and
    // the row are told, just as the GitHub path's note says main there was not brought up
    const stale = up.err ? `${t.base} here was not brought up to the remote: ${up.err}` : undefined
    // a train's gate left it at the top of its stack (Shepherdr stopped while it ran): back on its branch first,
    // before the guard, so a dead gate's detached commit is not mistaken for another branch's work (#1194)
    if (!(await G.git(wt, 'branch', '--show-current')).out) await G.git(wt, 'checkout', '--quiet', t.branch)
    const wrong = await this.branchGuard(t)
    if (wrong) return { ok: false, error: wrong }
    await G.commitAll(wt, `${t.id}: ${t.title}`)
    // the commit that would go in must be one a review round was recorded on (a clean base merge needs none)
    const unreviewed = await this.e.reviewGate(t)
    if (unreviewed) return { ok: false, error: `Can't merge ${t.id}: ${unreviewed}` }
    const g = await this.hub(p)
    if (g) return this.mergeOnGitHub(t, p, g, self)
    // its pull request is open, but gh can't use GitHub here now: it is never merged around it
    if (t.pr) return { ok: false, error: `Can't merge ${t.id}: its PR #${t.pr.number} is on GitHub, but gh isn't signed in to it here (gh auth login), so nothing was merged.` }
    // nothing ahead of main and no work ever made here; work merged by a merge commit (a pull request) is behind it too
    if ((await G.aheadCount(wt, t.base)) === 0 && !(await G.workedOn(wt, t.branch))) return { ok: false, error: `${t.id} has no changes to merge` }
    let note: string | undefined
    // merged already, by hand or as its pull request on GitHub (squashed, or with a merge commit), even with main
    // moved on since: it only needs marking
    if (await G.landed(wt, 'HEAD', t.base)) note = `it was in ${t.base} already`
    else {
      const rb = await G.rebase(wt, t.base)
      if (!rb.ok) {
        this.land(t, 'rebase')
        return { ok: false, error: `Conflict with ${t.base}: rebase ${t.branch} on ${t.base} by hand, commit, then run shepherdr merge ${t.id} again.` }
      }
      // others in line behind it go in with it on one gate run, when its space takes merge trains
      const train = await this.e.train(t, p, wt)
      if (train) return train
      // the space's merge gate, on the branch as it would go in: its last line goes into the commit
      const gate = await this.e.gate(t, p.path, p.name, wt)
      // its turn alone is over once its gate ran to its end, however that ended: it may ride a train again
      if (t.alone && !(!gate.ok && gate.stopped)) {
        t.alone = undefined
        this.e.saveNow()
      }
      if (!gate.ok) return { ok: false, error: gate.error }
      const m = await G.mergeHere(p.path, t.branch, t.base, this.mergeMessage(t, gate.line), true)
      if (!m.ok) {
        // mergeHere marks a conflict with its own prefix, so a file name (conflicts.md) is never taken for one
        const conflict = m.err.startsWith('conflict:')
        if (conflict) this.land(t, 'rebase')
        // mergeHere already says what stopped it, in words that name the file when git refused to write over one
        return { ok: false, error: conflict ? `Conflict with ${t.base}` : m.err || m.out || `${t.id}'s merge did not go through` }
      }
      t.squash = (await G.git(p.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${t.base}`)).out || undefined
    }
    return this.markMerged(t, await this.pushBase(p, t.base, [note, stale].filter(Boolean).join('; ') || undefined))
  }

  /**
   * Through the pull request, as herdr-projects lands one: the branch pushed as it is, rebased on GitHub's main only
   * when it conflicts with it (its pull request opened if the agent didn't), GitHub's checks passed at exactly that
   * commit, then squash-merged on GitHub only while its head is still that commit, its branch there deleted, and main here brought up to GitHub's (which
   * is what Shepherdr's own update watches). Failed checks go back to the agent. Its space's merge gate, when it has one,
   * runs here before anything is pushed: the branch on GitHub's base as it is now, the gate on that very commit, and
   * the merge only while the base is still the one it ran on.
   */
  private async mergeOnGitHub(t: TaskRec, p: Space, g: G.GitHub, self: boolean): Promise<{ ok: boolean; error?: string; note?: string }> {
    const wt = t.worktree!
    const base = `origin/${t.base}`
    if (!(await G.git(p.path, 'rev-parse', '--verify', '--quiet', base)).ok) return { ok: false, error: `GitHub has no ${t.base} yet: push it once (git push origin ${t.base}), then merge again.` }
    // main here holds commits GitHub lacks: merging on GitHub would split the two, so they go up first, by you
    const ahead = Number((await G.git(p.path, 'rev-list', '--count', `${base}..${t.base}`)).out || 0)
    if (ahead)
      return {
        ok: false,
        error: `${t.base} here has ${ahead} commit${ahead === 1 ? '' : 's'} GitHub lacks: push ${t.base} (git push origin ${t.base}) or move them off it, then merge ${t.id} again. Nothing was merged.`,
      }
    let pr = await this.prOf(t, g, wt)
    if (pr && pr.baseRefName !== t.base)
      return { ok: false, error: `PR #${pr.number} targets ${pr.baseRefName}, but ${t.id} targets ${t.base}. Correct the pull request target on GitHub first. Nothing was merged.` }
    // merged on GitHub already (by hand, or a merge whose answer was lost): it only needs main here and marking
    if (pr?.state === 'MERGED') return this.mergedOnGitHub(t, p, `PR #${pr.number} was merged on GitHub already`)
    if ((await G.aheadCount(wt, t.base!)) === 0) return { ok: false, error: `${t.id} has no changes to merge` }
    // GitHub's base as it is now: what the gate checks, and what the merge must not have moved past
    const refreshBase = async () => void (await G.git(p.path, 'fetch', '--quiet', 'origin', t.base!))
    // its space's merge gate (merge.gate), where it has one: nothing is pushed, or merged, that did not pass it
    const cmd = this.gateOf(t, p.name)
    // Without a merge gate, GitHub squash-merges a branch behind main as it is: rebasing it would make a new commit, and
    // all its checks run again (again each time main moves meanwhile). Only a real conflict is rebased here; a clash
    // that merges cleanly but breaks is caught by the checks on main. With a gate the branch goes onto the base as it
    // is now even when it moved without a conflict, since what the gate checks is what will land.
    const conflict = !(await G.mergesCleanly(wt, base, 'HEAD'))
    const behind = !!cmd && !conflict && !(await G.git(wt, 'merge-base', '--is-ancestor', base, 'HEAD')).ok
    let rebased: 'conflict' | 'gate' | undefined
    if (conflict || behind) {
      const rb = await G.rebase(wt, base)
      if (!rb.ok) {
        this.land(t, 'rebase')
        return { ok: false, error: `Conflict with ${t.base}: rebase ${t.branch} on ${base} by hand, commit, push with shepherdr pr ${t.id}, then run shepherdr merge ${t.id} again.` }
      }
      rebased = conflict ? 'conflict' : 'gate'
    }
    // main has this work already (merged another way): its pull request would change nothing
    if (await G.landed(wt, 'HEAD', base)) {
      // closed, with its branch there
      const closed = pr ? (await G.closePr(g, wt, pr.number, `Closed by Shepherdr: ${t.base} has this work already.`)).ok : false
      if (closed) await G.git(p.path, 'push', '--quiet', 'origin', '--delete', t.branch!)
      return this.mergedOnGitHub(t, p, `it was in ${t.base} already${pr ? (closed ? `; closed PR #${pr.number}` : `; could not close PR #${pr.number}: close it on GitHub`) : ''}`)
    }
    // the gate, on the commit that will land, in the task's worktree: a run of its own, detached as it is for a merge
    // made here, found again after a restart
    let gate: { line?: string; at?: string } | undefined
    if (cmd) {
      // a merge train is for merges made here only (docs/tasks.md): one set on this space is not a train, and says so
      if (this.e.trainSize(p.name) > 1) trainLog(`${t.id}'s merge goes alone: ${p.name} merges through a pull request, and a merge train is for merges made here`)
      const ran = await this.e.gate(t, p.path, p.name, wt, base, refreshBase)
      if (!ran.ok) return { ok: false, error: ran.error }
      gate = ran
      this.land(t, 'merge')
    }
    const head = (await G.git(wt, 'rev-parse', 'HEAD')).out
    // what the messages below say about the branch being rebased here: for a conflict, or for its merge gate
    const whyRebased = rebased === 'gate' ? `, rebased on ${t.base} for its merge gate` : rebased ? `, rebased on ${t.base} for a conflict` : ''
    const pushing = !pr || pr.headRefOid !== head
    if (pushing) {
      const push = await this.push(t)
      if (!push.ok) return { ok: false, error: this.pushFailed(t, t.branch!, push) }
    }
    if (!pr) {
      const o = await G.openPr(g, wt, { branch: t.branch!, base: t.base!, title: this.prTitle(t), body: this.prBody(t), draft: false })
      if ('error' in o) return { ok: false, error: `GitHub did not open a pull request for ${t.branch}: ${o.error}` }
      t.pr = { number: o.number, url: o.url }
      this.e.saveNow()
    } else {
      // its words carry the summary, whether or not the agent reported done before
      if (t.said) await this.editPrBody(t, g, wt, pr.number)
      if (pr.isDraft) await G.readyPr(g, wt, pr.number)
    }
    const n = t.pr!.number
    const wait = t.waitChecks ?? this.e.settings.ways(p.name).waitChecks
    // not waited for (Settings): its own quick checks passed, and GitHub's run on, here and then on main
    // (watchMain); only a failure GitHub already shows at this very commit stops it. "No checks" on a just-pushed
    // pull request is not "none configured" (#1044/#1018): give the repo's workflows the same 90 s Shepherdr always
    // gives them before deciding, so no merge goes through on an unknown.
    const now = wait ? undefined : await G.prChecks(g, wt, n)
    // "on its own" counts only the checks GitHub's base requires; "after checks" and shepherdr checks stay strict
    const counted = now && !wait ? await autoChecks(g, wt, n, now) : now
    let c: G.PrChecks
    if (wait) c = await this.checksOf(t, g, n, 0)
    // checksOf reads the same workflows once: with none it either returns none (no workflow, or a filtered one
    // that did not apply) or waits the 90 s out and refuses while the checks are still unknown
    else if (counted?.state === 'none') c = await this.checksOf(t, g, n, CHECKS_SHOW)
    else c = counted?.state === 'fail' || counted?.state === 'pending' ? counted : { state: 'pass' as const, passed: 0, failed: [] }
    if (c.state === 'unknown') {
      if (t.landing) this.land(t, 'checks', await this.checksDue(t, p, g, head), { why: 'Checks not started yet' })
      return {
        ok: false,
        error: `GitHub has not reported checks on PR #${n}${pushing ? ` (just pushed${whyRebased})` : ''} yet, but ${this.checksWhy(c.expect)}: waiting for them to start, not merging. Run shepherdr checks ${t.id} again; if that workflow cannot run on this pull request, merge it by hand on GitHub.`,
      }
    }
    if (c.state === 'pending') {
      this.land(t, 'checks', await this.checksDue(t, p, g, head))
      return {
        ok: false,
        error: `GitHub's checks are running on PR #${n}${pushing ? ` (just pushed${whyRebased})` : ''}: wait for them with shepherdr checks ${t.id}, then run shepherdr merge ${t.id} again.`,
      }
    }
    if (c.state === 'error') return { ok: false, error: `Could not read GitHub's checks on PR #${n}: ${c.error}. Nothing was merged.` }
    if (c.state === 'fail') {
      const why = this.checksFailed(n, c)
      if (self) {
        this.toldFailed(t, head, c)
        return { ok: false, error: `${why} ${this.fixIt(t)}` }
      }
      this.toldFailed(t, head, c)
      await this.e.sendBack(t, `${why} ${this.fixIt(t)}`)
      return { ok: false, error: `${why} Sent back to ${t.id}'s agent to fix.` }
    }
    // its gate ran on a branch on GitHub's base as it was then: a base that moved since is no merge, the gate is for
    // the base it will land on
    if (gate) {
      await refreshBase()
      if ((await G.git(p.path, 'rev-parse', '--verify', '--quiet', base)).out !== gate.at) {
        return {
          ok: false,
          error: `${t.base} moved on GitHub after ${t.id}'s merge gate ran: nothing was merged, since the gate checks the branch on the base it will land on. Run shepherdr merge ${t.id} again, and the gate runs again on the new ${t.base}.`,
        }
      }
    }
    const m = await G.mergePr(g, wt, n, head, `${t.id}: ${t.title} (#${n})`, [t.said, t.facts && `Facts: ${t.facts}`, gate?.line].filter(Boolean).join('\n\n'))
    if ((await G.viewPr(g, wt, n))?.state !== 'MERGED') {
      const said = (m.err || m.out || 'it did not say why').split('\n')[0]
      // main moved on GitHub since it was fetched: merging again rebases it if it now conflicts (Merging meanwhile)
      if (/conflict|not mergeable/i.test(said)) this.land(t, 'rebase')
      return {
        ok: false,
        error: /conflict|not mergeable/i.test(said)
          ? `Conflict with ${t.base} on GitHub: run shepherdr merge ${t.id} again, which rebases ${t.branch} on ${base} (or rebase it by hand, push with shepherdr pr ${t.id}, then merge again).`
          : `GitHub did not merge PR #${n}: ${said}`,
      }
    }
    await G.git(p.path, 'push', '--quiet', 'origin', '--delete', t.branch!)
    return this.mergedOnGitHub(t, p, `merged PR #${n} on GitHub${wait ? '' : counted !== now ? ', waiting only for required checks' : ', not waiting for its checks'}`)
  }

  /**
   * main here comes up to GitHub's, so the merge is here too (and Shepherdr's own update sees it), then it is marked.
   * `fetchMs` bounds the catch-up's fetch: `ready` and the watch call this with no deadline of their own around it, so
   * a remote that does not answer leaves main here as it is, said in the note, rather than holding them. The merge
   * path passes its own shorter bound for the same reason, and says so in its note too.
   */
  async mergedOnGitHub(t: TaskRec, p: Space, note: string, fetchMs?: number) {
    const up = await G.catchUp(p.path, t.base!, `then run git pull in ${t.base} here`, fetchMs)
    const stale = !up.ok ? up.err : up.err ? `${t.base} here was not brought up to GitHub's: ${up.err}` : undefined
    return this.markMerged(t, stale ? `${note}; ${stale}` : note)
  }

  async markMerged(t: TaskRec, note?: string) {
    t.merged = true
    t.doneAt = Date.now()
    t.reported = true
    t.landing = undefined
    t.trouble = undefined
    t.stopped = undefined
    this.e.settle(t)
    this.e.emit('gone', t, true)
    if (this.e.agents.status(this.e.key(t)) !== 'working') await this.e.cleanup(t)
    return { ok: true, note }
  }
}
