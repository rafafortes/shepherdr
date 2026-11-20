// Codex's launch flags and the Codex half of the own-command allow. Codex is not installed on this host: no real CLI is
// started, herdr.start is spied on, and the permission hook it would run is exercised directly as a shell command.
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentRecord, Spec } from '../server/live/agents.ts'
import { ROOT } from '../server/root.ts'
import { tmp } from './tmp.ts'

const { Agents } = await import('../server/live/agents.ts')
const { herdr } = await import('../server/live/herdr.ts')
const { codexPermissionHook } = await import('../server/live/readers/hooks.ts')

const dir = tmp('codex-launch')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** an Agents server that starts nothing real: herdr.start is the spy's, refresh and routing are no-ops */
function harness() {
  const a = new Agents()
  Object.assign(a, {
    refresh: async () => undefined,
    bindRoute: async () => undefined,
    queue: () => undefined,
  })
  return { a }
}

const key = 'SHE-137/Agent'
// agentEnv takes ROOT (which a merge gate may point at the installed checkout), so derive the path the same way
const command = join(ROOT, 'bin', 'shepherdr')
const base = (o: Partial<Spec> = {}): Spec =>
  ({
    key,
    name: 'shep-codex-test',
    kind: 'codex',
    cwd: dir,
    workspace: 'test',
    access: 'full',
    pane: async () => 'fake-pane',
    ...o,
  }) as Spec

const HOOK = 'hooks.PermissionRequest='

describe('a Codex launch’s permission flags', () => {
  test('a task agent (full) bypasses approvals and needs no permission hook', () => {
    const h = harness()
    try {
      const args = h.a.args({ ...base({ access: 'full' }), logs: [], started: 0 } as unknown as AgentRecord, false)
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox')
      expect(args.some((a) => a.startsWith(HOOK))).toBe(false)
    } finally {
      h.a.stop()
    }
  })

  test('an ask launch keeps its approvals and gets a hook for this launch’s own verbs', () => {
    const h = harness()
    try {
      const args = h.a.args({ ...base({ access: 'ask' }), logs: [], started: 0 } as unknown as AgentRecord, false)
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
      const at = args.findIndex((a) => a.startsWith(HOOK))
      expect(at).toBeGreaterThan(0)
      expect(args[at - 1]).toBe('-c')
      expect(args[at]).toContain('PermissionRequest')
      expect(args[at]).toContain(command)
    } finally {
      h.a.stop()
    }
  })

  test('what reaches herdr.start is the same flag set: no stand-in CLI is launched', async () => {
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    const asking = harness()
    const full = harness()
    try {
      await asking.a.ensure(base({ access: 'ask', first: 'first' }))
      const args = (start.mock.calls[0] as unknown as unknown[])[3] as string[]
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
      expect(args.some((a) => a.startsWith(HOOK))).toBe(true)
      start.mockClear()
      await full.a.ensure(base({ key: 'SHE-138/Agent', name: 'shep-codex-full', access: 'full', first: 'again' }))
      const bypass = (start.mock.calls[0] as unknown as unknown[])[3] as string[]
      expect(bypass).toContain('--dangerously-bypass-approvals-and-sandbox')
      expect(bypass.some((a) => a.startsWith(HOOK))).toBe(false)
    } finally {
      asking.a.stop()
      full.a.stop()
      start.mockRestore()
      timer.mockRestore()
    }
  })
})

describe('the Codex permission hook a launch gets', () => {
  const hook = codexPermissionHook(dir, 'shep-codex-test', command, key)
  if (!hook) throw new Error('no Codex permission hook on this machine')
  const parts = hook
  const value = parts[1]
  const extracted = /command=("(?:[^"\\]|\\.)*"),timeout=10/.exec(value)
  if (!extracted) throw new Error(`no hook command in ${value}`)
  const run = JSON.parse(extracted[1]) as string
  const ask = (input: unknown) => spawnSync('/bin/sh', ['-c', run], { input: JSON.stringify(input) })
  const request = (text: string, tool = 'Bash') => ({ hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: { command: text } })

  test('allows only this launch’s own command, verb by verb', () => {
    const allowed = ask(request(`SHEPHERDR_CHAT="${key}" ${command} ready SHE-137 --summary ok`))
    expect(allowed.status).toBe(0)
    expect(JSON.parse(allowed.stdout.toString()).hookSpecificOutput).toEqual({ hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } })
    const bare = ask(request(`${command} status`))
    expect(JSON.parse(bare.stdout.toString()).hookSpecificOutput.decision).toEqual({ behavior: 'allow' })
  })

  test('says nothing for another command, another verb, another tool or another event', () => {
    for (const input of [
      request(`${command} secret run A -- ls`),
      request(`${command} status; echo hi`),
      request(`SHEPHERDR_CHAT="OTHER-1/Agent" ${command} status`),
      request(`${command} status`, 'Write'),
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `${command} status` } },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} },
      null,
    ]) {
      const r = ask(input)
      expect(r.status).toBe(0)
      expect(r.stdout.toString().trim()).toBe('')
    }
  })
})
