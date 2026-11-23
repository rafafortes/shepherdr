// Taking a pull request that is already open (#1155, #1234, #1204): the number names it, never the task's branch.
// Every refusal here happens before a push, so a wrong number can never put a task's work onto someone else's
// pull request. Ported from upstream 3.x to 2.0's gh-based lookup; no herdr-core or Tailscale pieces.
import * as G from './git.ts'

/** the answer a task keeps when it takes a pull request */
export interface TakenPr {
  number: number
  url: string
  /** head branch on GitHub, which ready pushes to instead of the task's own branch */
  branch: string
  /** the commit the pull request is at when taken */
  head: string
  base: string
  /** owner/name the pull request was found in */
  repo: string
}

/** the marker on a task record: a taken pull request keeps its number and branch through prOf and merges */
export const takenPrRecord = (taken: TakenPr): TakenPrRecord => ({
  number: taken.number,
  url: taken.url,
  taken: true,
  branch: taken.branch,
  repo: taken.repo,
  headRefOid: taken.head,
})

export interface TakenPrRecord {
  number: number
  url: string
  taken?: boolean
  branch?: string
  repo?: string
  headRefOid?: string
}

/** a task that already holds a pull request, for the ownership check; done tasks let go of theirs */
type Owner = {
  id: string
  pr?: TakenPrRecord
  merged?: boolean
  closed?: boolean
  doneAt?: number
}

const finished = (t: Owner) => !!t.merged || !!t.closed || !!t.doneAt

/** the owner/name in GitHub's URL, checked against the repo gh was asked about */
const sameRepo = (url: string, repo: string) => {
  try {
    return new URL(url).pathname.includes(`/${repo}/pull/`)
  } catch {
    return false
  }
}

/**
 * Resolve `--pr <n>` for one task's repo and base and say whether it is safe to take. A bare `#` and spaces are
 * accepted around the number; anything else is a refusal, as is a fork, a closed pull request, one targeting another
 * base, one on another repo, or one already held by another task (by number or by head branch). gh itself refuses a
 * number that is not in this repo, so the URL is a second guard, not the lookup.
 */
export async function resolveTakenPr(o: { g: G.GitHub; cwd: string; number: string; base: string; tasks: readonly Owner[]; self?: string }): Promise<TakenPr> {
  const raw = o.number.trim().replace(/^#/, '')
  if (!/^\d+$/.test(raw)) throw new Error(`--pr takes a pull request's number, like 42; not ${JSON.stringify(o.number)}.`)
  const n = Number(raw)
  const { pr, err } = await G.viewPrToTake(o.g, o.cwd, n)
  if (!pr?.number) throw new Error(`Could not find pull request #${n} in ${o.g.host}/${o.g.repo}: ${err || 'no answer from GitHub'}.`)
  if (pr.state !== 'OPEN') throw new Error(`Pull request #${n} is ${String(pr.state || 'not open').toLowerCase()}: only an open one can be taken.`)
  if (pr.isCrossRepository) throw new Error(`Pull request #${n} comes from a fork: Shepherdr cannot push to its branch. Leave --pr out so the task opens its own.`)
  if (!sameRepo(pr.url, o.g.repo)) throw new Error(`Pull request #${n} is not in ${o.g.host}/${o.g.repo} (${pr.url}): it cannot be taken here.`)
  if (pr.baseRefName !== o.base)
    throw new Error(`Pull request #${n} merges into ${pr.baseRefName}, but this task merges into ${o.base}: take it with --base ${pr.baseRefName}, or change the pull request's base on GitHub.`)
  if (!pr.headRefName) throw new Error(`Pull request #${n} has no head branch on GitHub: it cannot be taken.`)
  const other = o.tasks.find((t) => t.id !== o.self && !finished(t) && t.pr && ((t.pr.number === pr.number && (t.pr.repo ?? o.g.repo) === o.g.repo) || (t.pr.taken && t.pr.branch === pr.headRefName)))
  if (other) throw new Error(`Pull request #${n} (branch ${pr.headRefName}) is already ${other.id}'s: let it go there first, or take another.`)
  return { number: pr.number, url: pr.url, branch: pr.headRefName, head: pr.headRefOid, base: pr.baseRefName, repo: o.g.repo }
}
