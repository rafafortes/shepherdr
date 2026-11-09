// A repo's stable id (SHE-37, from upstream's SHEP-141): a space keeps the folder it was added with, so renaming or
// moving the repo would lose its space, its tasks and their chat. Each repo is given an id of its own in its own
// .git/config (`shepherdr.id`: never committed, and shared with its worktrees), and the space records it, so the repo
// found at another folder is that space again.
//
// Only a repo's own checkout gets one: a worktree's .git is a file and its config is its repo's, and a folder reached
// through a symlink is the repo it points at, never a repo of its own (see `own` below).
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { lstatSync, realpathSync } from '../mfs.ts'
import { git, topLevel } from './git.ts'

/** the key, in a repo's own .git/config: Shepherdr's, never read or written by anything else */
export const REPO_ID = 'shepherdr.id'

export interface RepoIdentity {
  /** its top folder, as git writes it (through a symlink, the folder it points at) */
  top: string
  /** the real path of the .git it shares with its worktrees: two visible paths onto one repo have the same one */
  gitDir: string | null
  /** `.git` is a folder of its own: a worktree's is a file, and a folder a symlink reaches is not a second repo */
  own: boolean
  /** the id in its own .git/config, when it has one (read only where it is its own) */
  id: string | null
}

/** what a folder is, repo-wise; null when it is not a git repository (or is gone) */
export async function repoIdentity(path: string): Promise<RepoIdentity | null> {
  const top = await topLevel(path)
  if (!top) return null
  const common = await git(top, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  let gitDir: string | null = null
  if (common.ok && common.out) {
    try {
      gitDir = realpathSync(common.out)
    } catch {
      gitDir = null
    }
  }
  let own = false
  try {
    own = lstatSync(join(top, '.git')).isDirectory()
  } catch {
    own = false
  }
  return { top, gitDir, own, id: own ? await repoId(top) : null }
}

/** the id in the repo's own .git/config, or null (a worktree reads its repo's, so only ask a checkout's own folder) */
export async function repoId(path: string): Promise<string | null> {
  const r = await git(path, 'config', '--local', '--get', REPO_ID)
  return r.ok && r.out.trim() ? r.out.trim() : null
}

/**
 * The repo's identity, given an id when it has none yet. Only its own checkout is written to: a worktree, a folder
 * reached through a symlink and a plain folder are left exactly as they are, and so is a repo whose config can't be
 * written.
 */
export async function ensureRepoId(path: string): Promise<RepoIdentity | null> {
  const ident = await repoIdentity(path)
  if (!ident || !ident.own || ident.id) return ident
  const made = randomUUID()
  const r = await git(ident.top, 'config', '--local', REPO_ID, made)
  return { ...ident, id: r.ok ? made : null }
}
