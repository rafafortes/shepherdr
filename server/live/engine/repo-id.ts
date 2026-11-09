// A repo's stable id (SHE-37, from upstream's SHEP-141): a space keeps the folder it was added with, so renaming or
// moving the repo would lose its space, its tasks and their chat. Each repo is given an id of its own in its own
// .git/config (`shepherdr.id`: never committed, and shared with its worktrees), and the space records it, so the repo
// found at another folder is that space again.
//
// Only a repo's own checkout gets one: a worktree's .git is a file and its config is its repo's, and a folder reached
// through a symlink is the repo it points at, never a repo of its own (see `own` below).
import { randomUUID } from 'node:crypto'
import { realpathSync } from '../mfs.ts'
import { git, topLevel } from './git.ts'

/** the key, in a repo's own .git/config: Shepherdr's, never read or written by anything else */
export const REPO_ID = 'shepherdr.id'

export interface RepoIdentity {
  /** its top folder, as git writes it (through a symlink, the folder it points at) */
  top: string
  /** the real path of the .git it shares with its worktrees: two visible paths onto one repo have the same one */
  gitDir: string | null
  /** the .git of this checkout is the repo's own: a worktree's is another folder under it, so its config is its
   *  repo's and it is no repo of its own (a submodule and a `--separate-git-dir` checkout are: their .git folder is
   *  their own repo's) */
  own: boolean
  /** the id in its own .git/config, when it has one (read only where it is its own) */
  id: string | null
}

/** what a folder is, repo-wise; null when it is not a git repository (or is gone) */
export async function repoIdentity(path: string): Promise<RepoIdentity | null> {
  const top = await topLevel(path)
  if (!top) return null
  const [common, here] = await Promise.all([
    git(top, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    git(top, 'rev-parse', '--path-format=absolute', '--git-dir'),
  ])
  const real = (r: { ok: boolean; out: string }) => {
    if (!r.ok || !r.out) return null
    try {
      return realpathSync(r.out)
    } catch {
      return null
    }
  }
  const gitDir = real(common)
  // a worktree's .git points into a worktrees/ folder of its repo's, and everything there is that repo's: its config,
  // its id, its tasks. Any other checkout (.git a folder, a file of a submodule, or of a separate git dir) is its own.
  const own = !!gitDir && gitDir === real(here)
  return { top, gitDir, own, id: own ? await repoId(top) : null }
}

/** the id in the repo's own .git/config, or null (a worktree reads its repo's, so only ask a checkout's own folder) */
export async function repoId(path: string): Promise<string | null> {
  const r = await git(path, 'config', '--local', '--get', REPO_ID)
  return r.ok && r.out.trim() ? r.out.trim() : null
}

/**
 * The repo's identity, given an id when it has none yet. Only a repo's own checkout is written to: a worktree is left
 * exactly as it is (its .git/config is its repo's), and so is a plain folder and a repo whose config can't be written.
 */
export async function ensureRepoId(path: string): Promise<RepoIdentity | null> {
  const ident = await repoIdentity(path)
  if (!ident || !ident.own || ident.id) return ident
  return { ...ident, id: (await writeRepoId(ident.top)) ?? null }
}

/**
 * A new id for a repo that already carries one — a copy of a space's repo keeps the id in the .git/config it was
 * copied with, and two repos with one id could not be told apart. Only its own checkout is written to, as above.
 */
export async function freshRepoId(path: string): Promise<RepoIdentity | null> {
  const ident = await repoIdentity(path)
  if (!ident || !ident.own) return ident
  return { ...ident, id: (await writeRepoId(ident.top)) ?? null }
}

async function writeRepoId(top: string): Promise<string | null> {
  const made = randomUUID()
  const r = await git(top, 'config', '--local', REPO_ID, made)
  return r.ok ? made : null
}
