// The reviewer's prompt is Shepherdr's own (SHE-183): one template in the repo, filled when a round is counted and
// written under the task's temp folder, so all five reviewer CLIs and a subagent get the same words and never a pasted
// diff. This file pins the template's key lines and the fill/write path; review-run-cli.test.ts shows each CLI's round
// reading the file, and review-reviewer.test.ts shows the round's answer naming it.
import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fillReviewerPrompt, focusWords, lastReviewedOf, mergeBaseOf, REVIEWER_TEMPLATE, reviewerPromptFile, reviewerPromptPath, rulesIn, writeReviewerPrompt } from '../server/live/reviewer-prompt.ts'
import { tmp } from './tmp.ts'

describe('the template Shepherdr owns', () => {
  test('its key lines say what every reviewer must do and write', () => {
    const t = readFileSync(REVIEWER_TEMPLATE, 'utf8')
    expect(t).toContain('Read only: never edit files, commit or push')
    expect(t).toContain('git diff {{MERGE_BASE}}...HEAD')
    expect(t).toContain('git log --oneline {{MERGE_BASE}}..HEAD')
    expect(t).toContain("This round's focus")
    expect(t).toContain('{{FOCUS}}')
    expect(t).toContain('Never a diff pasted into this prompt or your answer')
    expect(t).toContain('{{RULES}}')
    expect(t).toContain("critical (breaks or loses people's work)")
    expect(t).toContain('major (a user would hit it, or it proves a')
    expect(t).toContain('claim false), minor (rarely hit) or trivial (style)')
    expect(t).toContain('<tag> <file>:<line>: <what is wrong>')
    expect(t).toContain('Fix: <what to do instead>')
    expect(t).toContain('Not run in my sandbox:')
    expect(t).toContain('Shepherdr feedback:')
    expect(t).toContain('No praise, no summary of the diff')
    expect(t).toContain('LAST plain message')
    expect(t).toContain('never a plan to approve')
    expect(t).toContain('start no other agents')
    expect(t).toContain('{{PRIVACY}}')
  })

  const facts = {
    id: 'RV-9',
    round: 2,
    title: 'Reviewed change',
    brief: 'Add b.txt.',
    base: 'main',
    mergeBase: 'abc123',
    worktree: '/work/tree',
    privacy: 'PRIVATE from default: (none)',
  }

  test('every placeholder is filled: task, brief, diff commands, rules, privacy', () => {
    const p = fillReviewerPrompt({ ...facts, rules: ['/work/tree/AGENTS.md'] })
    expect(p).toContain('Task: RV-9 - Reviewed change')
    expect(p).toContain('Review round: 2')
    expect(p).toContain('Add b.txt.')
    expect(p).toContain('git diff abc123...HEAD')
    expect(p).toContain('- /work/tree/AGENTS.md')
    expect(p).toContain('PRIVATE from default: (none)')
    expect(p).not.toContain('{{')
  })

  test('a later round names both the whole change and what changed since the last reviewed commit', () => {
    const first = fillReviewerPrompt({ ...facts, round: 1 })
    expect(first).toContain('First round: review the whole change above.')
    const later = fillReviewerPrompt({ ...facts, round: 2, since: 'abc123def456' })
    expect(later).toContain('git diff abc123def456..HEAD')
    expect(later).toContain('git log --oneline abc123def456..HEAD')
    expect(later).toContain('git diff abc123...HEAD') // the whole change stays for context
    expect(later).not.toContain('{{')
    expect(focusWords('abc123def456', 2)).toContain('Round after an earlier one')
    // a later round whose reviewed commit a rebase left behind has no range to name: it says so, never "First round"
    expect(focusWords(undefined, 3)).toContain('Round 3: the commit the last round reviewed is no longer on this branch')
    expect(focusWords(undefined, 1)).toBe('First round: review the whole change above.')
  })

  test('with no rule files it says so, and an unfilled placeholder is a loud failure', () => {
    expect(fillReviewerPrompt(facts)).toContain('No AGENTS.md, CLAUDE.md or REVIEW.md at the root of this worktree.')
    expect(() => fillReviewerPrompt(facts, 'Task {{TASK_ID}} {{OTHER}}')).toThrow('unfilled placeholder: {{OTHER}}')
  })

  test('placeholder-looking text in the brief is content, not a gap in the template', () => {
    const p = fillReviewerPrompt({ ...facts, brief: 'render `{{BRIEF}}` in the page' })
    expect(p).toContain('render `{{BRIEF}}` in the page')
  })

  test('the round writes its prompt under the task temp folder and names the same path', () => {
    const file = writeReviewerPrompt({ ...facts, template: 'Task {{TASK_ID}} round {{ROUND}}: {{BRIEF}}' })
    expect(file).toBe(reviewerPromptFile('RV-9', 2))
    expect(file).toBe(reviewerPromptPath('RV-9', 2))
    expect(readFileSync(file, 'utf8')).toBe('Task RV-9 round 2: Add b.txt.')
  })
})

describe('the change is read by reference, not pasted', () => {
  test('the merge base prefers origin/<base>, then the local base, then the base name with no repo', () => {
    const repo = tmp('review-prompt-repo')
    mkdirSync(repo, { recursive: true })
    execSync('git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init', { cwd: repo, shell: '/bin/sh' })
    const first = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
    execSync(`git update-ref refs/remotes/origin/main ${first}`, { cwd: repo, shell: '/bin/sh' })
    execSync('git checkout -qb work && echo work > work.txt && git add -A && git commit -qm work', { cwd: repo, shell: '/bin/sh' })
    expect(mergeBaseOf(repo, 'main')).toBe(first)
    // without the remote ref the local base answers the same
    execSync('git update-ref -d refs/remotes/origin/main', { cwd: repo, shell: '/bin/sh' })
    expect(mergeBaseOf(repo, 'main')).toBe(first)
    // a worktree with no git still gets a prompt, with the base name and the command to resolve it
    expect(mergeBaseOf(tmp('review-prompt-no-repo'), 'main')).toBe('main')
    expect(mergeBaseOf('', 'main')).toBe('main')
  })

  test('the last reviewed commit is the newest one still on the branch', () => {
    const dir = tmp('review-prompt-ancestor')
    mkdirSync(dir, { recursive: true })
    execSync('git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init', { cwd: dir, shell: '/bin/sh' })
    const a = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()
    execSync('echo more >> README.md && git commit -qam more', { cwd: dir, shell: '/bin/sh' })
    const b = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()
    execSync('echo last >> README.md && git commit -qam last', { cwd: dir, shell: '/bin/sh' })
    const c = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()
    expect(lastReviewedOf([{ commit: a }, { commit: b }], dir, c)).toEqual({ commit: b })
    expect(lastReviewedOf([{ commit: a }], dir, a)).toEqual({ commit: a })
    // a commit a rebase left behind is no longer an ancestor: no old round is named
    expect(lastReviewedOf([{ commit: '0'.repeat(40) }], dir, c)).toBeUndefined()
    expect(lastReviewedOf([{ commit: a }], '', c)).toBeUndefined()
  })

  test('only the rule files the worktree has are pointed at', () => {
    const repo = tmp('review-prompt-rules')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'AGENTS.md'), 'rules')
    writeFileSync(join(repo, 'REVIEW.md'), 'review')
    expect(rulesIn(repo)).toEqual([join(repo, 'AGENTS.md'), join(repo, 'REVIEW.md')])
    expect(rulesIn('')).toEqual([])
  })
})
