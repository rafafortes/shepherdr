// A review round runs in a herdr pane (SHE-182): one verb, five CLIs, each with its own read-only launch words, the
// reviewer's final message read from its own log, the pane closed on done and on a cut, and headless as the fallback
// when a pane cannot open. The herdr here is a fake with the PaneHerdr shape; the transcript is a real Claude log read
// by the same reader a task's chat uses.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HerdrError } from '../server/live/herdr.ts'
import { sendWhenReady, startInPane } from '../server/live/pane-agent.ts'
import { opencodeDb, opencodeLogPath } from '../server/live/opencode.ts'
import { reviewerPaneArgs } from '../server/live/prompts.ts'
import { claudeLogPath, piSessionDir } from '../server/live/readers/find.ts'
import { readFindings, runReviewInPane, type PaneHerdr } from '../server/live/review-pane.ts'
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

  test('agy: its plan prefix, the permission bypass for read-only commands, session trust and deny rules, effort in the id', () => {
    const args = reviewerPaneArgs({ kind: 'agy', model: 'gemini-4-hydrogen-high', effort: 'high' }, { cwd: '/work/tree', modelId: 'gemini-4-hydrogen-high' })
    expect(args).toEqual([
      '--mode',
      'plan',
      '--dangerously-skip-permissions',
      '--settings',
      JSON.stringify({
        trustedWorkspaces: ['/work/tree'],
        permissions: { deny: ['write_file(.)', 'read_url(*)', 'execute_url(*)', 'download_url(*)', 'mcp(*)'] },
      }),
      '--model',
      'gemini-4-hydrogen-high',
    ])
    expect(args).not.toContain('--effort')
  })

  test('every CLI has permission words that keep its reviewer read only (agy denied writes even with its bypass)', () => {
    expect(reviewerPaneArgs({ kind: 'claude' })).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--disallowedTools', 'Edit,Write,NotebookEdit']))
    expect(reviewerPaneArgs({ kind: 'codex' })).toEqual(expect.arrayContaining(['--sandbox', 'read-only']))
    const pi = reviewerPaneArgs({ kind: 'pi' })
    expect(pi).toContain('--tools')
    expect(pi[pi.indexOf('--tools') + 1]).toBe('read,grep,find,ls,bash')
    // OpenCode carries its permissions in the prepared session, not in a TUI flag (checked in its own test above)
    expect(reviewerPaneArgs({ kind: 'opencode' }, { session: 's1' })).toEqual(['--standalone', '--session', 's1'])
    const agy = reviewerPaneArgs({ kind: 'agy' })
    expect(agy).toEqual(expect.arrayContaining(['--mode', 'plan', '--dangerously-skip-permissions', '--settings']))
    const settings = JSON.parse(String(agy[agy.indexOf('--settings') + 1]))
    expect(settings.permissions.deny).toEqual(['write_file(.)', 'read_url(*)', 'execute_url(*)', 'download_url(*)', 'mcp(*)'])
  })
})

describe("the reviewer's own log", () => {
  test('an unknown CLI still gets a model flag when it has one', () => {
    expect(reviewerPaneArgs({ kind: 'other', model: 'm' })).toEqual(['--model', 'm'])
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

  test('a missing pi session folder and a broken OpenCode mirror are empty reads, not throws', async () => {
    const saved = process.env.SHEPHERDR_HOME
    const savedDb = process.env.SHEPHERDR_OPENCODE_DB
    const dir = tmp('review-broken')
    process.env.SHEPHERDR_HOME = join(dir, 'home')
    // the broken database goes to a path of this test's own: never let a test write ~/.local/share/opencode
    const db = join(dir, 'broken-opencode.db')
    process.env.SHEPHERDR_OPENCODE_DB = db
    const cwd = join(dir, 'worktree')
    expect((await readFindings('pi', cwd, 0, 'not-there-yet')).text).toBe('')
    const ocFile = opencodeLogPath(home(), 'broken-session')
    mkdirSync(dirname(ocFile), { recursive: true })
    writeFileSync(ocFile, '{"type":"session","id":"ses_broken-session"}\n')
    expect(opencodeDb()).toBe(db)
    mkdirSync(dirname(db), { recursive: true })
    writeFileSync(db, 'not a database')
    expect((await readFindings('opencode', cwd, 0, 'broken-session')).text).toBe('')
    if (saved === undefined) delete process.env.SHEPHERDR_HOME
    else process.env.SHEPHERDR_HOME = saved
    if (savedDb === undefined) delete process.env.SHEPHERDR_OPENCODE_DB
    else process.env.SHEPHERDR_OPENCODE_DB = savedDb
  })

  test('a provider error in the reviewer log fails the round instead of waiting for a turn end', async () => {
    const dir = tmp('review-error')
    const savedClaude = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
    const cwd = join(dir, 'worktree')
    const session = 'error-session'
    const file = claudeLogPath(cwd, session)
    mkdirSync(dirname(file), { recursive: true })
    const line = (o: object) => `${JSON.stringify({ sessionId: session, timestamp: '2026-01-01T00:00:00Z', ...o })}\n`
    writeFileSync(
      file,
      line({
        type: 'assistant',
        uuid: 'e1',
        isApiErrorMessage: true,
        error: '402 Insufficient funds',
        message: { id: 'm1', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '402 Insufficient funds' }], usage: {} },
      }),
    )
    expect(await readFindings('claude', cwd, 0, session)).toMatchObject({ done: true, error: '402 Insufficient funds' })
    if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedClaude
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

/**
 * A herdr that records what a round asked of it and finds nothing on its own. It also acts like the real herdr 0.9.5
 * (SHE-187): a tab's shell is not available on the first start, and a launched agent's name is registered only after a
 * client asks for it a couple of times. A round that skips the waits fails here, as it did on the machine.
 */
function fake(o: { notShellOnce?: boolean; registerAfter?: number } = {}) {
  const notShellOnce = o.notShellOnce ?? true
  const registerAfter = o.registerAfter ?? 2
  const calls: {
    tab?: [string, string, string, Record<string, string> | undefined]
    start?: [string, string, string, string[] | undefined]
    prompt?: [string, string]
    keys: string[][]
    closed: string[]
    visible: string[]
    agentAsks: string[]
    startTries: number
    promptTries: number
  } = {
    keys: [],
    closed: [],
    visible: [],
    agentAsks: [],
    startTries: 0,
    promptTries: 0,
  }
  const registered = new Set<string>()
  const h: PaneHerdr = {
    workspaces: async () => [{ workspace_id: 'w1', label: 'SHE-9 a task' }],
    createTab: async (ws, label, cwd, env) => {
      calls.tab = [ws, label, cwd, env]
      return { root_pane: { pane_id: 'w1:p9' } }
    },
    agent: async (target) => {
      calls.agentAsks.push(target)
      if (calls.agentAsks.length >= registerAfter) registered.add(target)
      return {}
    },
    start: async (name, kind, pane, args) => {
      calls.start = [name, kind, pane, args]
      if (++calls.startTries === 1 && notShellOnce) throw new Error(`agent target pane ${pane} is not an available shell`)
    },
    prompt: async (name, text) => {
      calls.prompt = [name, text]
      calls.promptTries++
      if (!registered.has(name)) throw new HerdrError('agent_not_found', `agent ${name} is not an active named agent`)
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

  test('a provider error after some text keeps the partial findings and marks the round cut short', async () => {
    const { h, calls } = fake()
    const got = await runReviewInPane({
      ...base,
      h,
      reviewer: { kind: 'claude' },
      findings: async () => ({ text: 'Let me read the diff', done: true, error: '402 Insufficient funds' }),
    })
    expect(got.failed).toBeUndefined()
    expect(got.findings).toBe('Let me read the diff')
    expect(got.cutShort).toBe(true)
    expect(got.error).toBe('402 Insufficient funds')
    expect(calls.closed).toEqual(['w1:p9'])
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

  for (const kind of KINDS) {
    test(`${kind}: a pane that is not a shell yet and a name herdr registers late still run the round`, async () => {
      const { h, calls } = fake({ notShellOnce: true, registerAfter: 2 })
      const steps: string[] = []
      const got = await runReviewInPane({
        ...base,
        h,
        reviewer: { kind },
        onStep: (s) => steps.push(s),
        findings: async () => ({ text: 'no findings', done: true }),
      })
      expect(got.failed).toBeUndefined()
      expect(got.findings).toBe('no findings')
      expect(calls.startTries).toBe(2)
      expect(calls.promptTries).toBe(2)
      expect(calls.agentAsks.length).toBeGreaterThanOrEqual(2)
      expect(steps.join('\n')).toContain('running in a pane')
      expect(calls.closed).toEqual(['w1:p9'])
    })
  }

  test('a start herdr leaves pending (agent_not_ready) is accepted, not a failed round', async () => {
    const { h, calls } = fake({ notShellOnce: false, registerAfter: 1 })
    let once = true
    const start = h.start
    h.start = async (...a) => {
      const result = await start(...a)
      if (once) {
        once = false
        throw new HerdrError('agent_not_ready', 'agent shep-she-9-review is not an active named agent yet')
      }
      return result
    }
    const got = await runReviewInPane({ ...base, h, reviewer: { kind: 'claude' }, findings: async () => ({ text: 'no findings', done: true }) })
    expect(got.failed).toBeUndefined()
    expect(got.findings).toBe('no findings')
    expect(calls.startTries).toBe(1)
    expect(calls.promptTries).toBe(1)
  })

  test('a slow herdr start keeps the caller stream warm without saying the pane runs', async () => {
    const { h, calls } = fake({ notShellOnce: false, registerAfter: 2 })
    let clock = 0
    const start = h.start
    h.start = async (...a) => {
      if (calls.startTries === 0) clock += 70_000 // one herdr.start call can take 70 s
      return start(...a)
    }
    const steps: string[] = []
    const got = await runReviewInPane({
      ...base,
      h,
      reviewer: { kind: 'claude' },
      now: () => clock,
      onStep: (s) => steps.push(s),
      findings: async () => ({ text: 'no findings', done: true }),
    })
    expect(got.failed).toBeUndefined()
    expect(got.findings).toBe('no findings')
    expect(steps.findIndex((s) => s.includes('still waiting'))).toBeLessThan(steps.findIndex((s) => s.includes('running in a pane')))
  })

  test('a start herdr drops is retried by the reviewer too', async () => {
    const { h, calls } = fake({ notShellOnce: false, registerAfter: 1 })
    const start = h.start
    let once = true
    h.start = async (...a) => {
      if (once) {
        once = false
        throw new HerdrError('closed', 'herdr closed the connection during start')
      }
      return start(...a)
    }
    const got = await runReviewInPane({ ...base, h, reviewer: { kind: 'claude' }, findings: async () => ({ text: 'no findings', done: true }) })
    expect(got.failed).toBeUndefined()
    expect(calls.startTries).toBe(1)
  })

  test('a name that never registers falls back, and never says the pane was running', async () => {
    const { h, calls } = fake({ notShellOnce: false })
    h.prompt = async () => {
      throw new Error('agent shep-she-9-review is not an active named agent')
    }
    const steps: string[] = []
    const got = await runReviewInPane({ ...base, h, reviewer: { kind: 'claude' }, onStep: (s) => steps.push(s) })
    expect(got.failed).toContain('not an active named agent')
    expect(steps.join('\n')).not.toContain('running in a pane')
    expect(calls.agentAsks.length).toBeGreaterThan(1)
    expect(calls.closed).toEqual(['w1:p9'])
  })

  test('a prompt that fails for another reason fails the round at once', async () => {
    const { h, calls } = fake({ notShellOnce: false })
    let tries = 0
    h.prompt = async () => {
      tries++
      throw new Error('the pane went away')
    }
    const got = await runReviewInPane({ ...base, h, reviewer: { kind: 'claude' } })
    expect(got.failed).toBe('the pane went away')
    expect(tries).toBe(1)
    expect(calls.closed).toEqual(['w1:p9'])
  })

  test('a herdr ask that fails does not fail the round', async () => {
    const { h, calls } = fake({ registerAfter: 1 })
    const agent = h.agent
    let once = true
    h.agent = async (target) => {
      if (once) {
        once = false
        throw new Error('herdr dropped the ask')
      }
      return agent(target)
    }
    const got = await runReviewInPane({ ...base, h, reviewer: { kind: 'claude' }, findings: async () => ({ text: 'no findings', done: true }) })
    expect(got.failed).toBeUndefined()
    expect(got.findings).toBe('no findings')
    expect(calls.promptTries).toBe(2)
  })
})

describe('the pane waits are bounded', () => {
  const notNamed = () => ({
    agent: async () => undefined,
    start: async () => undefined,
    prompt: async () => {
      throw new Error('agent x is not an active named agent')
    },
  })

  test('sendWhenReady stops at its wall-clock deadline, not just after a number of tries', async () => {
    let clock = 0
    const a = notNamed()
    let prompts = 0
    a.prompt = async () => {
      prompts++
      throw new Error('agent x is not an active named agent')
    }
    await expect(
      sendWhenReady(a, 'x', 'prompt', {
        now: () => clock,
        sleep: async () => {
          clock += 30_000
        },
        poll: 1,
        forMs: 60_000,
      }),
    ).rejects.toThrow('not an active named agent')
    expect(prompts).toBe(3)
  })

  test('sendWhenReady also stops at its try cap when the clock does not move', async () => {
    const a = notNamed()
    let prompts = 0
    a.prompt = async () => {
      prompts++
      throw new Error('agent x is not an active named agent')
    }
    await expect(sendWhenReady(a, 'x', 'prompt', { now: () => 0, sleep: async () => undefined, poll: 1, tries: 2 })).rejects.toThrow('not an active named agent')
    expect(prompts).toBe(2)
  })

  test('startInPane gives up at its time cap and says why', async () => {
    let clock = 0
    const a = notNamed()
    a.start = async () => {
      throw new Error('agent target pane p is not an available shell')
    }
    const given: string[] = []
    await expect(
      startInPane(a, 'x', 'claude', 'p', [], {
        now: () => clock,
        sleep: async () => {
          clock += 100_000
        },
        forMs: 60_000,
        giveUp: (e) => given.push((e as Error).message),
      }),
    ).rejects.toThrow('not an available shell')
    expect(given).toEqual(['agent target pane p is not an available shell'])
  })
})
