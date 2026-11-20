// Only task worktrees Shepherdr made are trusted here. A human-picked space always keeps its CLI's first-run prompt.
// mfs routes config reads and atomic replacement to the worker's machine over SSH, just like its other own files.
// pi has no trust file for us to write: its task worktrees are trusted at launch with its own one-shot --approve flag
// (see taskWorktreeKey and agents.ts args()). agy is trusted the same way at launch (--settings), and opencode has no
// trust dialog. None of them has any of its own settings written here.
import { dirname, join } from 'node:path'
import { BOX, boxHome } from './box.ts'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from './mfs.ts'

/** The agents Shepherdr starts in a worktree it made: a task's `<id>/Agent` and its reviewer's `<id>/Reviewer`. A
 *  coordinator on a space the human picked has a place id with no '/', and keeps its CLI's own first-run prompt.
 *  This is the condition the header promises; the launch args use it for pi, where no trust file is written. */
export const taskWorktreeKey = (key: string) => key.includes('/')

/** Preserve every other setting and project. Refuse TOML shapes we cannot edit without changing their meaning. */
export function codexTrust(text: string, path: string): string {
  const parsed = Bun.TOML.parse(text) as { projects?: Record<string, { trust_level?: string }> }
  const header = `[projects.${JSON.stringify(path)}]`
  if (!parsed.projects?.[path]) {
    if (parsed.projects && !/^\s*\[\s*projects(?:\s*\]|\s*\.)/m.test(text)) throw new Error('Cannot safely extend this Codex projects table')
    const out = `${text.trimEnd()}\n\n${header}\ntrust_level = "trusted"\n`
    Bun.TOML.parse(out)
    return out
  }
  const lines = text.split('\n')
  let first = -1,
    end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^\s*\[\s*projects\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\]\s*(?:#.*)?$/)
    if (h) {
      const key = h[1].startsWith('"') ? JSON.parse(h[1]) : h[1].slice(1, -1)
      if (key === path) {
        first = i
        continue
      }
    }
    if (first >= 0 && /^\s*\[/.test(lines[i])) {
      end = i
      break
    }
  }
  if (first < 0) throw new Error('Cannot safely edit this Codex projects table')
  const at = lines.findIndex((l, i) => i > first && i < end && /^\s*trust_level\s*=/.test(l))
  if (at >= 0) lines[at] = 'trust_level = "trusted"'
  else lines.splice(first + 1, 0, 'trust_level = "trusted"')
  const out = lines.join('\n')
  Bun.TOML.parse(out)
  return out
}

export function trustWorktree(path: string, kind: string, env: Record<string, string> = {}) {
  // claude and codex keep a trust file we write; pi (--approve), agy (--settings) and opencode (no dialog) are trusted
  // at launch instead, so there is nothing to write here. Only task worktrees Shepherdr made reach this call.
  if (kind !== 'claude' && kind !== 'codex') return
  const ownEnv = BOX ? env : { ...process.env, ...env }
  if (process.env.NODE_ENV === 'test' && !(kind === 'claude' ? ownEnv.CLAUDE_CONFIG_DIR : ownEnv.CODEX_HOME)) return
  const file = kind === 'claude' ? join(ownEnv.CLAUDE_CONFIG_DIR || boxHome(), '.claude.json') : join(ownEnv.CODEX_HOME || join(boxHome(), '.codex'), 'config.toml')
  let tmp: string | undefined
  try {
    path = realpathSync(path)
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    let out: string
    if (kind === 'claude') {
      const config = text ? JSON.parse(text) : {}
      config.projects ??= {}
      config.projects[path] = { ...config.projects[path], hasTrustDialogAccepted: true }
      out = `${JSON.stringify(config, null, 2)}\n`
    } else out = codexTrust(text, path)
    if (out === text) return
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    tmp = `${file}.shepherdr-${process.pid}-${Date.now()}`
    writeFileSync(tmp, out, { mode: 0o600 })
    renameSync(tmp, file)
  } catch (e) {
    // A config we cannot update stays untouched: its trust prompt will be shown in the chat instead.
    console.warn(`shepherdr: could not trust task worktree ${path}: ${(e as Error).message}`)
  } finally {
    if (tmp) rmSync(tmp, { force: true })
  }
}
