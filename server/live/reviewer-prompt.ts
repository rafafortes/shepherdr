// The reviewer's prompt belongs to Shepherdr, not to the task agent writing it by hand (SHE-183): a template in the
// repo, filled in when a round is counted with the task, its brief, the base and merge-base, the repo's rule files and
// the wording every reviewer CLI must see, then written under the task's $SHEPHERDR_TMP. One prompt for all five
// reviewer CLIs and for the subagent fallback; the diff is read by reference, never pasted inline (SHE-180).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureTaskTmp, taskTmpDir } from './task-tmp.ts'

/** the template beside this server file, in the checkout the code runs from (a release, a worktree, or a gate run whose
 *  SHEPHERDR_ROOT names the live install): ROOT would point at that other install, which has no template yet. */
export const REVIEWER_TEMPLATE = join(import.meta.dir, '..', '..', 'skill', 'shepherdr-reviewer', 'PROMPT.md')

/** the rule files a reviewer is pointed at, when the worktree has them */
export const RULES = ['AGENTS.md', 'CLAUDE.md', 'REVIEW.md']

/** where a round's prompt is written: the agent's own TMPDIR, named so the round's file survives the next count */
export const reviewerPromptPath = (id: string, round: number) => join(taskTmpDir(id), `reviewer-${id}-${round}.md`)
export const reviewerPromptFile = (id: string, round: number) => {
  ensureTaskTmp(id)
  return reviewerPromptPath(id, round)
}

/** the merge base, read synchronously so a round can write its prompt as it is counted (including a wake-up round).
 *  Prefers origin/<base> as mergeBase() does; a worktree with no git falls back to the base name, and the prompt still
 *  carries the command to resolve it. */
export function mergeBaseOf(wt: string, base: string): string {
  if (!wt) return base
  for (const ref of [`origin/${base}`, base]) {
    if (spawnSync('git', ['-C', wt, 'rev-parse', '--verify', '--quiet', ref], { stdio: 'ignore' }).status === 0) {
      const mb = spawnSync('git', ['-C', wt, 'merge-base', ref, 'HEAD'], { encoding: 'utf8' })
      return mb.status === 0 && mb.stdout.trim() ? mb.stdout.trim() : ref
    }
  }
  return base
}

/** the rule files that exist at the worktree's root, with their absolute paths */
export function rulesIn(wt: string): string[] {
  return wt ? RULES.filter((f) => existsSync(join(wt, f))).map((f) => join(wt, f)) : []
}

export interface PromptFacts {
  id: string
  round: number
  title: string
  brief: string
  base: string
  mergeBase: string
  worktree: string
  privacy: string
  rules?: string[]
}

/** fill the template with one round's facts. Pure: the template is passed in so a test can pin its key lines and a
 *  missing placeholder is a loud failure, not a prompt with a gap in it. */
export function fillReviewerPrompt(o: PromptFacts, template = readFileSync(REVIEWER_TEMPLATE, 'utf8')): string {
  const rules = o.rules?.length ? `Read these repo rules before judging anything:\n${o.rules.map((f) => `- ${f}`).join('\n')}` : `No AGENTS.md, CLAUDE.md or REVIEW.md at the root of this worktree.`
  const words: Record<string, string> = {
    TASK_ID: o.id,
    TASK_TITLE: o.title,
    ROUND: String(o.round),
    BRIEF: o.brief.trim(),
    BASE: o.base,
    MERGE_BASE: o.mergeBase,
    WORKTREE: o.worktree,
    RULES: rules,
    PRIVACY: o.privacy.trim(),
  }
  // Look for unfilled keys in the *template*, never in the filled text: a brief about Handlebars may itself say
  // `{{BRIEF}}`, which is content, not a gap in the template.
  const missing = [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).find((key) => key !== undefined && !(key in words))
  if (missing) throw new Error(`The reviewer prompt template has an unfilled placeholder: {{${missing}}}`)
  return template.replace(/\{\{(\w+)\}\}/g, (_whole, key: string) => words[key] ?? _whole)
}

/** write the round's prompt under the task's temp folder and name the file; called where the round is counted */
export function writeReviewerPrompt(o: Omit<PromptFacts, 'mergeBase' | 'rules'> & { mergeBase?: string; rules?: string[]; template?: string }): string {
  const file = reviewerPromptFile(o.id, o.round)
  const text = fillReviewerPrompt(
    {
      ...o,
      mergeBase: o.mergeBase ?? mergeBaseOf(o.worktree, o.base),
      rules: o.rules ?? rulesIn(o.worktree),
    },
    o.template,
  )
  writeFileSync(file, text)
  return file
}
