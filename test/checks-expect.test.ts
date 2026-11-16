// #1044/#1018: "no checks yet" is not "none set up". The repo's workflows at HEAD say whether checks will come
// (git.ts: workflowExpect, prWorkflowExpect, noneIsUnknown), read by checksOf in engine.ts; a merge never decides on
// the first unknown. These are the pure rules; the five end-to-end cases are with the engine in engine-merge.test.ts.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChecksExpect } from '../server/live/engine/git.ts'
import { hasPrWorkflows, noneIsUnknown, prWorkflowExpect, workflowExpect } from '../server/live/engine/git.ts'
import { landingLine } from '../server/live/engine/engine.ts'
import { sh } from './engine-world.ts'
import { tmp } from './tmp.ts'

/** a git repo whose HEAD holds these workflow files, or none at all */
function repoWith(workflows: Record<string, string> | null) {
  const dir = tmp('expect')
  sh('git init -q -b main', dir)
  if (workflows) {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    for (const [name, text] of Object.entries(workflows)) writeFileSync(join(dir, '.github', 'workflows', name), text)
  }
  sh('git add -A', dir)
  sh('git -c user.name=CI -c user.email=ci@localhost commit -qm ci --allow-empty', dir)
  return dir
}

describe('what one workflow says about a pull request (workflowExpect)', () => {
  const cases: [string, string, ChecksExpect][] = [
    ['an unfiltered pull_request runs on every one', 'on:\n  pull_request:\njobs: {}', 'yes'],
    ['pull_request_target counts too', 'on:\n  pull_request_target:\njobs: {}', 'yes'],
    ['a list on one line', 'on: [push, pull_request]\njobs: {}', 'yes'],
    ['a quoted key is still pull_request', "on:\n  'pull_request':\njobs: {}", 'yes'],
    ['a comment and a job below on: are not events', '# hi\non:\n  pull_request:\njobs:\n  x:\n    runs-on: ubuntu-latest', 'yes'],
    ['a paths filter may leave it out', 'on:\n  pull_request:\n    paths:\n      - backend/**\njobs: {}', 'maybe'],
    ['paths-ignore and branches both filter it', 'on:\n  pull_request:\n    paths-ignore: [docs/**]\n    branches: [main]\njobs: {}', 'maybe'],
    ['branches alone filters it', 'on:\n  pull_request:\n    branches: [main]\njobs: {}', 'maybe'],
    ['an inline filtered event', 'on:\n  pull_request: { paths: [docs/**] }\njobs: {}', 'maybe'],
    ['push and dispatch run on their own refs, not on a pull request', 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\njobs: {}', 'none'],
    ['a list with push but no pull request says none', 'on: [push, workflow_dispatch]\njobs: {}', 'none'],
    ['workflow_dispatch never runs on one', 'on: workflow_dispatch\njobs: {}', 'none'],
    ['on under a job is not the top-level on:', 'jobs:\n  x:\n    on: pull_request', 'none'],
    ['no workflows at all', '', 'none'],
  ]
  for (const [name, text, want] of cases) test(name, () => expect(workflowExpect(text)).toBe(want))
})

describe('what a repo says about a pull request (prWorkflowExpect)', () => {
  test('no workflows: no checks configured, and hasPrWorkflows agrees', async () => {
    const dir = repoWith(null)
    expect(await prWorkflowExpect(dir)).toBe('none')
    expect(await hasPrWorkflows(dir)).toBe(false)
  })
  test('an unfiltered workflow says checks will come', async () => {
    const dir = repoWith({ 'ci.yml': 'on:\n  pull_request:\n' })
    expect(await prWorkflowExpect(dir)).toBe('yes')
    expect(await hasPrWorkflows(dir)).toBe(true)
  })
  test('a paths-filtered workflow says maybe, not none: this is the filter we used to ignore', async () => {
    const dir = repoWith({ 'ci.yml': 'on:\n  pull_request:\n    paths:\n      - backend/**\n' })
    expect(await prWorkflowExpect(dir)).toBe('maybe')
    expect(await hasPrWorkflows(dir)).toBe(true)
  })
  test('one unfiltered workflow wins over filtered and push-only ones', async () => {
    const dir = repoWith({ 'a.yml': 'on:\n  pull_request:\n    paths: [docs/**]\n', 'b.yml': 'on:\n  push:\n' })
    expect(await prWorkflowExpect(dir)).toBe('maybe')
    writeFileSync(join(dir, '.github', 'workflows', 'c.yml'), 'on:\n  pull_request:\n')
    sh('git add -A && git commit -qm more', dir)
    expect(await prWorkflowExpect(dir)).toBe('yes')
  })
})

describe('GitHub reporting no checks is not the repo having none (noneIsUnknown)', () => {
  test('a repo with no workflows is still none, waited or not', () => {
    expect(noneIsUnknown('none', false).state).toBe('none')
    expect(noneIsUnknown('none', true).state).toBe('none')
  })
  test('a workflow that runs on every pull request is never none, even after the window', () => {
    expect(noneIsUnknown('yes', false)).toMatchObject({ state: 'unknown', expect: 'yes' })
    expect(noneIsUnknown('yes', true)).toMatchObject({ state: 'unknown', expect: 'yes' })
  })
  test('a filtered workflow is not decided on the first read, but may be after the window', () => {
    expect(noneIsUnknown('maybe', false)).toMatchObject({ state: 'unknown', expect: 'maybe' })
    expect(noneIsUnknown('maybe', true).state).toBe('none')
  })
})

describe("the task's row while checks have not started", () => {
  test('says why instead of a bare "Checks running"', () => {
    const at = Date.now()
    expect(landingLine({ step: 'checks', at, why: 'Checks not started yet' })).toBe('Checks not started yet')
    expect(landingLine({ step: 'checks', at, due: at + 5 * 60_000 })).toBe('Checks running · ~5m')
  })
})
