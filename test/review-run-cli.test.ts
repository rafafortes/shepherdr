// `shepherdr review <id> --run` at the command boundary: counts the round, prints the pane's findings on stdout, frees
// the reviewer itself, marks a cut-short round, and refuses a missing prompt without burning a round. The pane runner
// is mocked here; its own five-CLI tests are in review-pane.test.ts.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const calls: { opts?: Record<string, unknown>; steps: string[] } = { steps: [] }
let next: { findings: string; cutShort?: boolean; failed?: string; pane?: string } = { findings: 'major: the pane works' }
mock.module('../server/live/review-pane.ts', () => ({
  reviewerPrompt: (base: string) => base,
  readPromptFile: (path: string) => {
    if (!existsSync(path)) throw new Error(`No prompt file ${path}`)
    return 'Brief, base, rules, tags.'
  },
  runReviewInPane: async (opts: Record<string, unknown>) => {
    calls.opts = opts
    ;(opts.onStep as (s: string) => void)?.(`Review round 1 running in a pane: RV-CLI reviewer (claude).`)
    return next
  },
}))

process.env.SHEPHERDR_HOME = tmp('review-run-cli')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')

let src: InstanceType<typeof LiveSource>
let n = 0
let space: string
beforeEach(async () => {
  calls.opts = undefined
  calls.steps = []
  next = { findings: 'major: the pane works' }
  if (src) src.stop()
  process.env.SHEPHERDR_HOME = tmp(`review-run-cli-${++n}`)
  src = new LiveSource()
  src.engine.installed = () => true
  src.settings.set('models.maxAtOnce', null, 'machine')
  const dir = tmp('review-run-repo')
  execSync('git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init', { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, `runcli-${n}`)
  space = placeId.space(p.name)
})
afterAll(() => src?.stop())

function task() {
  const id = `RC-${++n}`
  src.engine.tasks.push({
    id,
    project: space,
    base: 'main',
    title: 'Paned review',
    desc: 'Add b.txt.',
    by: 'test',
    created: Date.now(),
    updated: Date.now(),
    told: 'work',
    worktree: tmp(`runcli-wt-${n}`),
    agent: { kind: 'claude' },
    reviewer: { kind: 'claude' },
  } as never)
  return (
    src.engine.task(id) ??
    (() => {
      throw new Error(`task ${id} was not added`)
    })()
  )
}

const promptFile = () => {
  const dir = tmp(`runcli-prompt-${++n}`)
  const f = join(dir, 'prompt.md')
  mkdirSync(dir, { recursive: true })
  writeFileSync(f, 'brief')
  return f
}

describe('shepherdr review --run', () => {
  test('a pane round prints its findings, frees the reviewer and posts a card while it runs', async () => {
    const t = task()
    const r = await src.cli(['review', t.id, '--run', promptFile()], { chat: `${t.id}/Agent` }, (s) => calls.steps.push(s))
    expect(r.code).toBe(0)
    expect(r.out).toContain('major: the pane works')
    expect(r.out).toContain('ran in a herdr pane')
    expect(r.out).toContain('its pane is closed and its reviewer is free')
    expect(t.reviews).toBe(1)
    expect(src.engine.runs().filter((x) => x.role === 'reviewer')).toHaveLength(0)
    expect(calls.opts).toMatchObject({ id: t.id, round: 1, cwd: t.worktree, workspace: `${t.id} Paned review` })
    // the running card is replaced by the finished one, with the same id: no stale "running" line in the chat
    const cards = src.chats.log(`${t.id}/Agent`).posted.filter((p) => p.card?.id === `review-pane:${t.id}:1`)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.card?.text).toContain('finished in its reviewer pane')
    expect(calls.steps.join('\n')).toContain('running in a pane')
  })

  test('a cut-short round says its findings are partial', async () => {
    const t = task()
    next = { findings: 'minor: unfinished thought', cutShort: true, pane: 'w1:p2' }
    const r = await src.cli(['review', t.id, '--run', promptFile()], { chat: `${t.id}/Agent` })
    expect(r.out).toContain('Cut short at the 900 s timeout')
    expect(r.out).toContain('minor: unfinished thought')
    expect(t.reviews).toBe(1)
  })

  test('the setup callback gives codex its tool environment and does not pass agy a conflicting effort', async () => {
    const t = task()
    await src.cli(['review', t.id, '--run', promptFile()], { chat: `${t.id}/Agent` })
    const prepare = calls.opts?.prepare as ((k: string, c: string, r: { kind: string; model?: string; effort?: string }) => Promise<Record<string, unknown>>) | undefined
    if (!prepare) throw new Error('the round had no setup callback')
    const codex = await prepare('codex', `${t.id}/Reviewer`, { kind: 'codex', model: 'gpt-5.5', effort: 'high' })
    const policy = (codex.extra as string[])[1]
    expect(codex.extra).toMatchObject(['-c', expect.stringContaining('shell_environment_policy.set=')])
    expect(String(policy)).toContain('SHEPHERDR_CHAT')
    const agy = await prepare('agy', `${t.id}/Reviewer`, { kind: 'agy' })
    expect(agy.modelId).toBeUndefined()
    expect(typeof agy.sessionId).toBe('string')
    // a named model is resolved to the id agy takes for it and its effort, never as a conflicting --effort pair
    const named = await prepare('agy', `${t.id}/Reviewer`, { kind: 'agy', model: 'gemini-4-hydrogen', effort: 'high' })
    expect(typeof named.modelId).toBe('string')
  })

  test('a missing prompt file refuses before a round is counted', async () => {
    const t = task()
    const r = await src.cli(['review', t.id, '--run', join(tmp('missing-prompt'), 'none.md')], { chat: `${t.id}/Agent` })
    expect(r.code).toBe(1)
    expect(r.out).toContain('No prompt file')
    expect(t.reviews).toBeUndefined()
  })
})
