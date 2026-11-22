// `shepherdr review <id> --run` at the command boundary: counts the round, prints the pane's findings on stdout, frees
// the reviewer itself, marks a cut-short round, and refuses a missing prompt without burning a round. The pane runner
// is mocked here; its own five-CLI tests are in review-pane.test.ts.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const calls: { opts?: Record<string, unknown>; steps: string[] } = { steps: [] }
let next: { findings: string; cutShort?: boolean; failed?: string; error?: string; pane?: string } = { findings: 'major: the pane works' }
mock.module('../server/live/review-pane.ts', () => ({
  readPromptFile: (path: string) => {
    if (!existsSync(path)) throw new Error(`No prompt file ${path}`)
    return readFileSync(path, 'utf8')
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
    const r = await src.cli(['review', t.id, '--run'], { chat: `${t.id}/Agent` }, (s) => calls.steps.push(s))
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
    const r = await src.cli(['review', t.id, '--run'], { chat: `${t.id}/Agent` })
    expect(r.out).toContain('Cut short at the 900 s timeout')
    expect(r.out).toContain('minor: unfinished thought')
    expect(t.reviews).toBe(1)
  })

  test('a pane round records the commit it reviewed, and one that errored with nothing written records none', async () => {
    const withRepo = () => {
      const t = task()
      const wt = t.worktree as string
      mkdirSync(wt, { recursive: true })
      execSync('git init -q -b main && git config user.email t@t && git config user.name T && echo hi > a.txt && git add -A && git commit -qm init', { cwd: wt, shell: '/bin/sh' })
      return { t, head: execSync('git rev-parse HEAD', { cwd: wt, encoding: 'utf8' }).trim() }
    }
    const first = withRepo()
    expect((await src.cli(['review', first.t.id, '--run'], { chat: `${first.t.id}/Agent` })).code).toBe(0)
    expect(first.t.reviewed).toMatchObject([{ round: 1, commit: first.head }])

    // a provider error with no words written: the reviewer is freed, and no commit is recorded as reviewed
    const second = withRepo()
    next = { findings: '', error: '402 Insufficient funds' }
    const r = await src.cli(['review', second.t.id, '--run'], { chat: `${second.t.id}/Agent` })
    expect(r.code).toBe(0)
    expect(r.out).toContain('it wrote no findings before the error')
    expect(r.out).toContain('not recorded as a review')
    expect(second.t.reviewed).toBeUndefined()
    expect(src.engine.runs().filter((x) => x.role === 'reviewer')).toHaveLength(0)
  })

  test('a reviewer error keeps partial findings, marks them cut short and posts an error card', async () => {
    const t = task()
    next = { findings: 'Let me read the diff', error: '402 Insufficient funds', cutShort: true }
    const r = await src.cli(['review', t.id, '--run'], { chat: `${t.id}/Agent` })
    expect(r.out).toContain('The reviewer gave an error (402 Insufficient funds)')
    expect(r.out).toContain('these are its partial findings')
    expect(r.out).toContain('Let me read the diff')
    const cards = src.chats.log(`${t.id}/Agent`).posted.filter((p) => p.card?.id === `review-pane:${t.id}:1`)
    expect(cards[0]?.card?.text).toContain('ended early: its reviewer gave an error')
    // an error still frees the reviewer, so the round does not hold a slot
    expect(src.engine.runs().filter((x) => x.role === 'reviewer')).toHaveLength(0)
  })

  test('the setup callback gives codex its tool environment and does not pass agy a conflicting effort', async () => {
    const t = task()
    await src.cli(['review', t.id, '--run'], { chat: `${t.id}/Agent` })
    const prepare = calls.opts?.prepare as ((k: string, c: string, r: { kind: string; model?: string; effort?: string }) => Promise<Record<string, unknown>>) | undefined
    if (!prepare) throw new Error('the round had no setup callback')
    const codex = await prepare('codex', `${t.id}/Reviewer`, { kind: 'codex', model: 'gpt-5.5', effort: 'high' })
    const policy = (codex.extra as string[])[1]
    expect(codex.extra).toMatchObject(['-c', expect.stringContaining('shell_environment_policy.set=')])
    expect(String(policy)).toContain('SHEPHERDR_CHAT')
    // claude and pi fall through to the plain session id
    const claude = await prepare('claude', `${t.id}/Reviewer`, { kind: 'claude' })
    expect(typeof claude.sessionId).toBe('string')
    const agy = await prepare('agy', `${t.id}/Reviewer`, { kind: 'agy' })
    expect(agy.modelId).toBeUndefined()
    expect(typeof agy.sessionId).toBe('string')
    // a named model is resolved to the id agy takes for it and its effort, never as a conflicting --effort pair
    const named = await prepare('agy', `${t.id}/Reviewer`, { kind: 'agy', model: 'gemini-4-hydrogen', effort: 'high' })
    expect(typeof named.modelId).toBe('string')
  })

  test("a foreign prompt file is ignored: the round gets Shepherdr's prompt instead", async () => {
    const t = task()
    const r = await src.cli(['review', t.id, '--run', join(tmp('missing-prompt'), 'none.md')], { chat: `${t.id}/Agent` })
    expect(r.code).toBe(0)
    expect(t.reviews).toBe(1)
    expect(calls.opts?.prompt).toContain(`Task: ${t.id}`)
    expect(calls.opts?.prompt).not.toContain('No prompt file')
  })

  test('--run with no file uses the prompt Shepherdr wrote, counts one round and names the file', async () => {
    const t = task()
    const r = await src.cli(['review', t.id, '--run'], { chat: `${t.id}/Agent` })
    expect(r.code).toBe(0)
    expect(t.reviews).toBe(1)
    expect(r.out).toContain(`reviewer-${t.id}-1.md`)
    const prompt = calls.opts?.prompt as string
    expect(prompt).toContain(`Task: ${t.id}`)
    expect(prompt).toContain('Paned review')
    expect(prompt).toContain('git diff main...HEAD')
    expect(prompt).toContain('Shepherdr feedback:')
    expect(prompt).toContain('Not run in my sandbox:')
    expect(prompt).not.toContain('diff --git')
  })

  test('a round asked for with plain review passes its named file to --run and is not counted twice', async () => {
    const t = task()
    const asked = await src.cli(['review', t.id], { chat: `${t.id}/Agent` })
    expect(asked.code).toBe(0)
    const named = new RegExp(`shepherdr review ${t.id} --run (\\S*reviewer-${t.id}-1\\.md)`).exec(asked.out)?.[1]
    if (!named) throw new Error('the round answer did not name a prompt file')
    const r = await src.cli(['review', t.id, '--run', named], { chat: `${t.id}/Agent` })
    expect(r.code).toBe(0)
    expect(t.reviews).toBe(1)
    expect(calls.opts?.prompt as string).toContain(`Task: ${t.id}`)
    expect(asked.out).toContain('write no prompt of your own')
  })

  test('a brief with a Settings block gives the reviewer only the coordinator words', async () => {
    const t = task()
    t.desc = `${t.desc}\n\nSettings: (from shepherdr show; where the brief above says otherwise, it wins)\n- Reviewer: a headless Codex or a Codex subagent. Each round, run \`shepherdr review ${t.id}\` first`
    const r = await src.cli(['review', t.id, '--run'], { chat: `${t.id}/Agent` })
    expect(r.code).toBe(0)
    const prompt = calls.opts?.prompt as string
    expect(prompt).toContain('Add b.txt.')
    expect(prompt).not.toContain('Settings:')
    expect(prompt).not.toContain('a headless Codex')
  })

  test('--run with a stale prompt file while a round is open counts a fresh round and sends its prompt', async () => {
    const t = task()
    expect((await src.cli(['review', t.id], { chat: `${t.id}/Agent` })).code).toBe(0)
    expect(t.reviews).toBe(1)
    const r = await src.cli(['review', t.id, '--run', promptFile()], { chat: `${t.id}/Agent` })
    expect(r.code).toBe(0)
    expect(t.reviews).toBe(2)
    // never the stale file's 'brief': the fresh round's own file, with the right round number
    expect(calls.opts?.prompt).toContain('Review round: 2')
    expect(calls.opts?.prompt).toContain(`Task: ${t.id}`)
  })

  for (const kind of ['claude', 'codex', 'pi', 'opencode', 'agy']) {
    test(`${kind}: the pane round gets the same Shepherdr-written prompt file`, async () => {
      const t = task()
      t.reviewer = { kind }
      const r = await src.cli(['review', t.id, '--run'], { chat: `${t.id}/Agent` })
      expect(r.code).toBe(0)
      expect(calls.opts).toMatchObject({ id: t.id, reviewer: { kind } })
      const prompt = calls.opts?.prompt as string
      expect(prompt).toContain(`Task: ${t.id}`)
      expect(prompt).toContain("critical (breaks or loses people's work)")
      expect(prompt).toContain('No praise, no summary of the diff')
      expect(prompt).toContain('LAST plain message')
    })
  }
})
