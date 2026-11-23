// The whole flow of extra CLI flags (upstream SHEP-266): the Settings row per CLI, --flags and --set flags= on task
// add, validated against the CLI that will run, the brief's Agent line, and a space's default a task can override.
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('flags-flow')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
process.env.SHEPHERDR_OPENCODE_DB = join(process.env.SHEPHERDR_HOME, 'no-opencode.db')
delete process.env.SHEPHERDR_MAIN

const { LiveSource } = await import('../server/live/source.ts')
const { CATALOG, refuse, Settings, setForTask } = await import('../server/live/settings.ts')
const { settingsBlock } = await import('../server/live/prompts.ts')
const { restartHint, sameHarness } = await import('../server/live/restart.ts')

/** a value a test needs: fail with a name rather than tell TypeScript to trust a missing one */
function need<T>(x: T | undefined, why: string): T {
  if (x === undefined) throw new Error(why)
  return x
}

const src = new LiveSource()
afterAll(() => src.stop())

const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'
const run = (cmd: string, cwd: string) => execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8', timeout: 30_000 }).trim()
const dir = tmp('flags-flow-repo')
run(REPO, dir)
const REPO_NAME = (await src.places.add(dir, 'flags-space')).name

const ways = { review: true, mustFix: 'minor', rounds: 3, merge: 'on its own', waitChecks: false }

/** add a task and return its record (or the refusal, with no record) */
async function add(...args: string[]) {
  const r = await src.cli(['task', 'add', 'Flagged', '--desc', 'work', '--space', REPO_NAME, ...args], {})
  if (r.code) return { out: r.out, t: undefined }
  const id = need(r.out.match(/([A-Z]+-\d+)/)?.[1], 'an id in the add answer')
  return { out: r.out, t: src.engine.task(id) }
}

describe('the space rows and the strict check at save time', () => {
  test('one text row per CLI, in the Tasks group, with the flag check on save', () => {
    const rows = need(
      CATALOG.find((s) => s.name === 'Agents'),
      'the Agents section',
    ).rows
    for (const kind of ['claude', 'codex', 'pi', 'opencode', 'agy']) {
      const row = need(
        rows.find((r) => r.key === `tasks.${kind}_flags`),
        `${kind} flags row`,
      )
      expect(row.text).toBe(true)
      expect(row.group).toBe('Tasks')
      expect(row.label).toContain('flags')
    }
    expect(refuse('tasks.claude_flags', '--advisor opus')).toBeUndefined()
    expect(refuse('tasks.claude_flags', '--model opus')).toContain("can't be an extra flag")
    expect(refuse('tasks.pi_flags', '--thinking high')).toContain('Shepherdr sets the effort')
    expect(refuse('tasks.opencode_flags', '--session abc')).toContain('session')
    expect(refuse('tasks.agy_flags', '--print')).toContain('interactive')
    expect(refuse('tasks.codex_flags', '--advisor opus')).toContain('has no --advisor flag')
    expect(refuse('tasks.claude_flags', 'none')).toBeUndefined()
  })

  test('the nearest level wins and a hand-edited value never breaks a launch', () => {
    const s = new Settings({ everywhere: {}, machine: { 'tasks.claude_flags': '--verbose' }, spaces: { sp1: { 'tasks.claude_flags': '--advisor opus' } } })
    expect(s.flags('claude', 'sp1')).toEqual(['--advisor=opus'])
    expect(s.flags('claude')).toEqual(['--verbose'])
    expect(s.flags('pi')).toEqual([])
    // a hand-edited row with a flag that is no longer valid is dropped at load, so a launch can never break on it
    const junk = new Settings({ everywhere: {}, machine: {}, spaces: { sp1: { 'tasks.claude_flags': '--model=opus --advisor=opus a prompt' } } })
    expect(junk.flags('claude', 'sp1')).toEqual([])
    expect(s.set('tasks.claude_flags', '--print', { space: 'sp1' }).ok).toBe(false)
    expect(s.get('tasks.claude_flags', 'sp1')).toBe('--advisor opus')
  })

  test('--set flags=... is the same option by another name', () => {
    expect(setForTask('flags=--advisor opus')).toEqual({ flag: 'flags', value: '--advisor opus' })
    expect(setForTask('extra-flags=--verbose')).toEqual({ flag: 'flags', value: '--verbose' })
  })
})

describe('the brief and the restart hint name the flags', () => {
  test('the Agent line names the extra flags, one word each', () => {
    const brief = settingsBlock('SHE-1', {
      ways,
      agent: { kind: 'claude', model: 'sonnet', effort: 'high', flags: ['--advisor=opus'] },
    })
    expect(brief).toContain('Agent: Claude Code (model sonnet, high effort, extra flags --advisor=opus)')
  })

  test('a flags row does not change which worker an agent is on', () => {
    src.settings.set('tasks.claude_flags', '--advisor opus', { space: REPO_NAME })
    const h = src.settings.harness('task', REPO_NAME)
    expect(sameHarness({ kind: h.kind }, h)).toBe(true)
    // coordinators never take a task's flags: their harness has no flags slot at all
    expect(src.settings.harness('coordinator', REPO_NAME).flags).toBeUndefined()
    src.settings.set('tasks.claude_flags', null, { space: REPO_NAME })
  })

  test('a change of flags is a restart change, not a no-op', () => {
    const on = { kind: 'claude', flags: ['--advisor=opus'] }
    const want = { kind: 'claude', flags: ['--verbose'] }
    expect(restartHint(on, undefined, want)).toEqual({ on: '--advisor=opus', want: '--verbose' })
    expect(restartHint(on, undefined, { kind: 'claude', flags: ['--advisor=opus'] })).toBeUndefined()
  })
})

describe('task add validates against the CLI it runs', () => {
  test('--flags passes and reaches the task and its brief', async () => {
    const { t, out } = await add('--agent', 'claude', '--flags=--advisor opus')
    expect(out).toContain('Flagged')
    expect(need(t, 'the added task').agent?.flags).toEqual(['--advisor=opus'])
    expect(t?.desc).toContain('extra flags --advisor=opus')
  })

  test('--set flags=... does the same', async () => {
    const { t } = await add('--agent', 'claude', '--set', 'flags=--verbose')
    expect(need(t, 'the added task').agent?.flags).toEqual(['--verbose'])
  })

  test('a flag another CLI has, or one Shepherdr sets itself, is refused with why', async () => {
    const a = await add('--agent', 'codex', '--flags=--advisor opus')
    expect(a.out).toContain('has no --advisor flag')
    expect(a.t).toBeUndefined()
    const b = await add('--agent', 'claude', '--flags=--model opus')
    expect(b.out).toContain("can't be an extra flag")
    const c = await add('--agent', 'pi', '--set', 'flags=--thinking high')
    expect(c.out).toContain('Shepherdr sets the effort')
  })

  test('a switch takes the other CLI’s flags, never the old CLI’s', async () => {
    src.settings.set('tasks.claude_flags', '--advisor opus', { space: REPO_NAME })
    src.settings.set('tasks.codex_flags', '--search', { space: REPO_NAME })
    const codex = await add('--agent', 'codex')
    expect(need(codex.t, 'the Codex task').agent?.flags).toEqual(['--search'])
    expect(codex.t?.desc).not.toContain('--advisor=opus')
    src.settings.set('tasks.claude_flags', null, { space: REPO_NAME })
    src.settings.set('tasks.codex_flags', null, { space: REPO_NAME })
  })

  test('a flag is validated against the space’s CLI, not the machine’s', async () => {
    src.settings.set('task.agent', 'codex', { space: REPO_NAME })
    const good = await add('--flags=--search')
    expect(need(good.t, 'the Space Codex task').agent?.kind).toBe('codex')
    expect(good.t?.agent?.flags).toEqual(['--search'])
    const bad = await add('--flags=--advisor opus')
    expect(bad.out).toContain('has no --advisor flag')
    src.settings.set('task.agent', null, { space: REPO_NAME })
  })

  test('a restart on cleared settings clears the flags that were not the task’s own', async () => {
    src.settings.set('tasks.claude_flags', '--advisor opus', { space: REPO_NAME })
    const { t } = await add('--agent', 'claude')
    const id = need(t, 'the task').id
    const key = `${id}/Agent`
    // no herdr here: put the record a real launch would have left back, to see what the restart passes on
    src.agents.restore(key, {
      key,
      name: `shep-${id.toLowerCase()}`,
      kind: 'claude',
      cwd: t?.worktree ?? dir,
      workspace: 'flags-flow',
      flags: t?.agent?.flags,
      logs: [],
      started: Date.now(),
    })
    expect(src.agents.record(key)?.flags).toEqual(['--advisor=opus'])
    src.settings.set('tasks.claude_flags', null, { space: REPO_NAME })
    // a restart's launch: the sheet's harness has no flags, so a cleared Settings row must clear the record's too.
    // herdr is not here, so the start itself fails; the record's flags are set before that, which is what this checks.
    try {
      await (src.engine as unknown as { launch: (t: unknown, first?: unknown, made?: unknown, as?: unknown) => Promise<unknown> }).launch(t, undefined, { path: t?.worktree }, { kind: 'claude' })
    } catch {
      // the start has no pane here; the record's flags were set before that
    }
    expect(src.agents.record(key)?.flags).toEqual([])
  })

  test('a switch to another CLI drops the old flags and says so', async () => {
    const { t } = await add('--agent', 'claude', '--flags=--advisor opus')
    const id = need(t, 'the task').id
    const key = `${id}/Agent`
    // let the add's own (failing) start settle before putting the record back, or it races with this launch
    await Bun.sleep(300)
    src.agents.restore(key, {
      key,
      name: `shep-${id.toLowerCase()}`,
      kind: 'claude',
      cwd: t?.worktree ?? dir,
      workspace: 'flags-flow',
      flags: ['--advisor=opus'],
      logs: [],
      started: Date.now(),
    })
    const info = spyOn(console, 'info').mockImplementation(() => undefined)
    let calls: string[] = []
    try {
      await (src.engine as unknown as { launch: (t: unknown, first?: unknown, made?: unknown, as?: unknown) => Promise<unknown> }).launch(t, undefined, { path: t?.worktree }, { kind: 'codex' })
    } catch {
      // the start has no pane here
    } finally {
      calls = info.mock.calls.map((c) => String(c[0]))
      info.mockRestore()
    }
    expect(src.agents.record(key)?.flags).toEqual([])
    expect(calls.some((c) => c.includes('dropped') && c.includes('--advisor=opus'))).toBe(true)
  })

  test('a space default reaches a task, its own flags replace it, and none clears it', async () => {
    expect(src.settings.set('tasks.claude_flags', '--advisor sonnet', { space: REPO_NAME }).ok).toBe(true)
    const plain = await add('--agent', 'claude')
    expect(need(plain.t, 'a task on the space default').agent?.flags).toEqual(['--advisor=sonnet'])
    const own = await add('--agent', 'claude', '--flags=--verbose')
    expect(need(own.t, 'a task with its own flags').agent?.flags).toEqual(['--verbose'])
    expect(own.t?.desc).not.toContain('--advisor=sonnet')
    const none = await add('--agent', 'claude', '--flags=none')
    expect(need(none.t, 'a task with none').agent?.flags).toEqual([])
    expect(none.t?.desc).not.toContain('extra flags')
    src.settings.set('tasks.claude_flags', null, { space: REPO_NAME })
  })
})
