// A review round runs in a herdr pane (SHE-182): one verb, five CLIs, each with its own read-only launch words, the
// reviewer's final message read from its own log, the pane closed on done and on a cut, and headless as the fallback
// when a pane cannot open. The herdr here is a fake with the PaneHerdr shape; the transcript is a real Claude log read
// by the same reader a task's chat uses.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { opencodeLogPath } from '../server/live/opencode.ts'
import { reviewerPaneArgs } from '../server/live/prompts.ts'
import { claudeLogPath, piSessionDir } from '../server/live/readers/find.ts'
import { readFindings, reviewerPrompt, runReviewInPane, type PaneHerdr } from '../server/live/review-pane.ts'
import { home } from '../server/store.ts'
import { tmp } from './tmp.ts'

const KINDS = ['claude', 'codex', 'pi', 'opencode', 'agy']
const envSince = process.env.CLAUDE_CONFIG_DIR
afterEach(() => {
  if (envSince === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = envSince
})

describe('the interactive pane launch is read-only for every reviewer CLI', () => {
  test('claude: plan mode, edit tools refused, model and effort in the pane', () => {
    expect(reviewerPaneArgs({ kind: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }, { sessionId: 's1' })).toEqual([
      '--session-id',
      's1',
      '--permission-mode',
      'plan',
      '--model',
      'claude-sonnet-5-5',
      '--effort',
      'high',
      '--disallowedTools',
      'Edit,Write,NotebookEdit',
    ])
  })

  test('codex: its documented read-only sandbox and effort setting (unverified here: not installed)', () => {
    expect(reviewerPaneArgs({ kind: 'codex', model: 'gpt-5.5', effort: 'high' })).toEqual(['--sandbox', 'read-only', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort="high"'])
  })

  test('pi: no permission system, so a read-tool allowlist plus bash for git, and no trust dialog left up', () => {
    const a = reviewerPaneArgs({ kind: 'pi', model: 'opencode-go/deepseek-v4.1-flash' }, { sessionId: 's2' })
    expect(a).toContain('--approve')
    expect(a).toContain('--no-mcp')
    expect(a).toContain('--tools')
    expect(a[a.indexOf('--tools') + 1]).toBe('read,grep,find,ls,bash')
    expect(a).toContain('--model')
    expect(a).not.toContain('edit')
  })

  test('opencode: the prepared session carries the model, effort and denied edit/write; no TUI flag does', () => {
    expect(reviewerPaneArgs({ kind: 'opencode', model: 'opencode/hy4-flash-free', effort: 'high' }, { session: 'ses-1' })).toEqual(['--standalone', '--session', 'ses-1'])
  })

  test('agy: plan mode is its read-only mode, the worktree is trusted for this session, and effort stays in the id', () => {
    const args = reviewerPaneArgs({ kind: 'agy', model: 'gemini-4-hydrogen-high', effort: 'high' }, { cwd: '/work/tree', modelId: 'gemini-4-hydrogen-high' })
    expect(args).toEqual(['--mode', 'plan', '--settings', JSON.stringify({ trustedWorkspaces: ['/work/tree'] }), '--model', 'gemini-4-hydrogen-high'])
    expect(args).not.toContain('--effort')
  })
})

describe("the reviewer's prompt and its own log", () => {
  test('one prompt for every CLI: the tags, the last plain message and the privacy handoff', () => {
    const p = reviewerPrompt('Brief and base are here. Run git diff <merge-base>...HEAD.', { id: 'SHE-9', round: 2, privacy: 'PRIVATE from default: (none)' })
    expect(p).toContain('git diff <merge-base>...HEAD')
    expect(p).toContain('critical')
    expect(p).toContain('minor')
    expect(p).toContain('LAST plain message')
    expect(p).toContain('never a plan to approve')
    expect(p).toContain('PRIVATE from default')
  })

  test('the findings come from the reviewer transcript, not the screen: last message, done on turn end', async () => {
    const dir = tmp('review-log')
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
    const cwd = join(dir, 'worktree')
    const session = 'ses-reviewer-1'
    const file = claudeLogPath(cwd, session)
    mkdirSync(dirname(file), { recursive: true })
    const line = (o: object) => `${JSON.stringify({ sessionId: session, timestamp: '2026-01-01T00:00:00Z', ...o })}\n`
    writeFileSync(
      file,
      line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'review this change' } }) +
        line({ type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'an early thought' }], stop_reason: 'tool_use', usage: {} } }) +
        line({
          type: 'assistant',
          uuid: 'a2',
          message: { id: 'm2', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'major: it drops the user work' }], stop_reason: 'end_turn', usage: {} },
        }) +
        line({ type: 'result', uuid: 'r1', subtype: 'success' }),
    )
    expect(await readFindings('claude', cwd, 0, session)).toMatchObject({ text: 'major: it drops the user work', done: true })
  })

  test('pi and opencode read the named session, never the newest log in the worktree', async () => {
    const saved = process.env.SHEPHERDR_HOME
    const dir = tmp('review-sessions')
    process.env.SHEPHERDR_HOME = join(dir, 'home')
    const cwd = join(dir, 'worktree')
    const session = 'reviewer-session-9'
    const piDir = piSessionDir(cwd)
    mkdirSync(piDir, { recursive: true })
    const piFile = join(piDir, `2026-01-01T00-00-00-000Z_${session}.jsonl`)
    writeFileSync(piFile, '{"type":"session","id":"reviewer-session-9"}\n')
    expect((await readFindings('pi', cwd, 0, session)).file).toBe(piFile)
    const ocFile = opencodeLogPath(home(), session)
    mkdirSync(dirname(ocFile), { recursive: true })
    writeFileSync(ocFile, '{"type":"session","id":"ses_reviewer-session-9"}\n')
    expect((await readFindings('opencode', cwd, 0, session)).file).toBe(ocFile)
    if (saved === undefined) delete process.env.SHEPHERDR_HOME
    else process.env.SHEPHERDR_HOME = saved
  })

  test('a log already there is excluded for the CLIs that name their own session', async () => {
    const saved = process.env.SHEPHERDR_HOME
    const dir = tmp('review-exclude')
    process.env.SHEPHERDR_HOME = join(dir, 'home')
    const cwd = join(dir, 'worktree')
    const other = opencodeLogPath(home(), 'task-agent-session')
    mkdirSync(dirname(other), { recursive: true })
    writeFileSync(other, '{"type":"session","id":"ses_task-agent-session"}\n')
    expect((await readFindings('opencode', cwd, 0, undefined, other)).text).toBe('')
    if (saved === undefined) delete process.env.SHEPHERDR_HOME
    else process.env.SHEPHERDR_HOME = saved
  })
})

/** a herdr that records what a round asked of it and finds nothing on its own */
function fake() {
  const calls: {
    tab?: [string, string, string, Record<string, string> | undefined]
    start?: [string, string, string, string[] | undefined]
    prompt?: [string, string]
    keys: string[][]
    closed: string[]
    visible: string[]
  } = {
    keys: [],
    closed: [],
    visible: [],
  }
  const h: PaneHerdr = {
    workspaces: async () => [{ workspace_id: 'w1', label: 'SHE-9 a task' }],
    createTab: async (ws, label, cwd, env) => {
      calls.tab = [ws, label, cwd, env]
      return { root_pane: { pane_id: 'w1:p9' } }
    },
    start: async (name, kind, pane, args) => {
      calls.start = [name, kind, pane, args]
    },
    prompt: async (name, text) => {
      calls.prompt = [name, text]
    },
    visible: async () => calls.visible.shift() ?? '',
    paneKeys: async (_pane, keys) => {
      calls.keys.push(keys)
    },
    closePane: async (pane) => {
      calls.closed.push(pane)
    },
  }
  return { h, calls }
}

const base = {
  id: 'SHE-9',
  round: 1,
  cwd: '/work/tree',
  workspace: 'SHE-9 a task',
  prompt: 'Review this, write your findings as your last plain message.',
  env: { SHEPHERDR_CHAT: 'SHE-9/Reviewer' },
  sleep: async () => undefined,
  poll: 1,
}

describe('a round in a pane', () => {
  for (const kind of KINDS) {
    test(`${kind}: opens a tab beside the task, starts read-only, sends the prompt, reads the log, closes the pane`, async () => {
      const { h, calls } = fake()
      const steps: string[] = []
      const got = await runReviewInPane({
        ...base,
        h,
        reviewer: { kind, model: 'm', effort: 'high' },
        onStep: (s) => steps.push(s),
        findings: async () => ({ text: 'major: it broke the build', done: true }),
      })
      expect(got.findings).toBe('major: it broke the build')
      expect(got.failed).toBeUndefined()
      expect(calls.tab).toEqual(['w1', 'SHE-9 reviewer', '/work/tree', { SHEPHERDR_CHAT: 'SHE-9/Reviewer' }])
      expect(calls.start?.[0]).toBe('shep-she-9-review')
      expect(calls.start?.[1]).toBe(kind)
      expect(calls.start?.[2]).toBe('w1:p9')
      expect(got.args).toEqual(calls.start?.[3])
      expect(got.args?.length).toBeGreaterThan(0)
      expect(calls.prompt).toEqual(['shep-she-9-review', base.prompt])
      expect(calls.closed).toEqual(['w1:p9'])
      expect(steps.join('\n')).toContain('Review round 1 running in a pane')
    })
  }

  test('a startup dialog is answered by Shepherdr, never left waiting', async () => {
    const { h, calls } = fake()
    calls.visible.push('Trust this folder?', '')
    const got = await runReviewInPane({ ...base, h, reviewer: { kind: 'claude' }, findings: async () => ({ text: 'no findings', done: true }) })
    expect(got.findings).toBe('no findings')
    expect(calls.keys).toEqual([['enter']])
  })

  test('on a timeout the pane closes and the partial findings come back marked cut short', async () => {
    const { h, calls } = fake()
    const steps: string[] = []
    const got = await runReviewInPane({
      ...base,
      h,
      reviewer: { kind: 'claude' },
      now: (() => {
        let n = 0
        return () => (n++ === 0 ? 1000 : 1000 + 900_001)
      })(),
      timeout: 900_000,
      onStep: (s) => steps.push(s),
      findings: async () => ({ text: 'major: unfinished but useful', done: false }),
    })
    expect(got.findings).toBe('major: unfinished but useful')
    expect(got.cutShort).toBe(true)
    expect(calls.closed).toEqual(['w1:p9'])
    expect(steps.join('\n')).toContain('timed out')
  })

  test('a long round keeps the CLI stream alive with an interim line each minute', async () => {
    const { h } = fake()
    const steps: string[] = []
    let clock = 0
    const got = await runReviewInPane({
      ...base,
      h,
      reviewer: { kind: 'claude' },
      now: () => clock,
      sleep: async () => {
        clock += 30_000
      },
      timeout: 900_000,
      onStep: (s) => steps.push(s),
      findings: async () => ({ text: '', done: false }),
    })
    expect(got.cutShort).toBe(true)
    expect(steps.filter((s) => s.includes('still running in')).length).toBeGreaterThan(1)
    expect(steps.join('\n')).toContain('timed out')
  })

  test('no herdr space for the task: nothing starts, the round reports a fallback with no pane', async () => {
    const { h, calls } = fake()
    h.workspaces = async () => []
    const got = await runReviewInPane({ ...base, h, reviewer: { kind: 'claude' } })
    expect(got.failed).toContain('no herdr space')
    expect(got.pane).toBeUndefined()
    expect(calls.start).toBeUndefined()
    expect(calls.closed).toEqual([])
  })

  test('a CLI that will not start interactively is a fallback too, and the pane it opened still closes', async () => {
    const { h, calls } = fake()
    h.start = async () => {
      throw new Error('agent_not_ready')
    }
    const got = await runReviewInPane({ ...base, h, reviewer: { kind: 'claude' } })
    expect(got.failed).toContain('agent_not_ready')
    expect(calls.closed).toEqual(['w1:p9'])
  })
})
