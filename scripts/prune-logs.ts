// Prune the log folders the check runner leaves under ~/.cache/shepherdr/check-local. Called by the runner at the end
// of a successful run, after the verdict has been written: a folder belongs to the worktree its name comes from, so a
// worktree that is gone leaves its logs behind forever unless someone clears the whole cache by hand. A worktree may
// also spread its logs over several run folders (`<worktree>.<run>`); only the newest few are worth keeping.
import { readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** the worktree a folder's logs belong to: its name when that worktree is live, or the name before a run's `.9` suffix.
 *  A folder no live worktree claims has no key, so it is the one to prune. Only a numeric suffix counts: a worktree
 *  whose own name ends in `.something` must not be mistaken for a run of the part before it. */
export function keyOf(name: string, live: ReadonlySet<string>): string | undefined {
  if (live.has(name)) return name
  const run = /^(.*)\.\d+$/.exec(name)
  if (run && live.has(run[1])) return run[1]
  return undefined
}

/** remove the folders of worktrees that are gone and all but the newest `keep` run folders of the rest. The current
 *  run's folder is always kept, the shared `verdicts` store and anything else in the cache are left alone, and only
 *  immediate children of `root` are ever removed. Returns the names removed. */
export function prune(root: string, live: readonly string[], current: string, keep: number): string[] {
  // no worktrees to compare against means the caller could not see them: leave everything alone rather than guess
  if (live.length === 0) return []
  const owned = new Set(live)
  const byWorktree = new Map<string, { name: string; mtime: number }[]>()
  const removed: string[] = []
  const drop = (name: string) => {
    rmSync(join(root, name), { recursive: true, force: true })
    removed.push(name)
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'verdicts') continue
    const key = keyOf(entry.name, owned)
    if (!key) {
      if (entry.name !== current) drop(entry.name)
      continue
    }
    const runs = byWorktree.get(key) ?? []
    runs.push({ name: entry.name, mtime: statSync(join(root, entry.name)).mtimeMs })
    byWorktree.set(key, runs)
  }
  for (const runs of byWorktree.values()) {
    runs.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
    const newest = runs.slice(0, Math.max(1, keep))
    // the current run is newest as far as pruning is concerned, even when its mtime lost a race with another folder
    if (!newest.some((r) => r.name === current)) {
      const mine = runs.find((r) => r.name === current)
      if (mine) newest[newest.length - 1] = mine
    }
    const kept = new Set(newest.map((r) => r.name))
    // oldest first: the log names the folders in the order they went
    for (const run of runs.reverse()) if (!kept.has(run.name)) drop(run.name)
  }
  return removed
}

/** the runner's environment, gathered in one place so a test can drive the same entry point */
export function main(env: Record<string, string | undefined> = process.env): string[] {
  const root = env.SHEPHERDR_CHECK_LOG_ROOT ?? join(env.HOME ?? '', '.cache', 'shepherdr', 'check-local')
  const live = (env.SHEPHERDR_CHECK_LIVE ?? '')
    .split('\n')
    .filter(Boolean)
    .map((path) => basename(path))
  const keep = Number(env.SHEPHERDR_CHECK_KEEP ?? 5)
  return prune(root, live, env.SHEPHERDR_CHECK_CURRENT ?? '', Number.isFinite(keep) ? keep : 5)
}

// coverage-exempt: the runner executes this entry point; the tests drive main() and prune() directly
if (import.meta.main) main()
