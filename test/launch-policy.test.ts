// A proof server keeps its own files and its own herdr: its home follows SHEPHERDR_HOME (credentials included), and it
// starts no agent unless it is told to (docs/develop.md, skill/shepherdr-agent). These are its three rules.
import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const proof = mkdtempSync(join(tmpdir(), 'shep-proof-home-'))
process.env.SHEPHERDR_HOME = proof
// nothing here reaches a real herdr, even where a launch gets past the rule
process.env.HERDR_SOCKET_PATH = join(proof, 'no-herdr.sock')

const { REAL_HOME, launchesAgents, skippedLaunch } = await import('../server/live/launch-policy.ts')
const { agentEnv } = await import('../server/live/box.ts')
const { HOME, home } = await import('../server/store.ts')
const { Agents } = await import('../server/live/agents.ts')
const { herdr } = await import('../server/live/herdr.ts')
const { ROOT } = await import('../server/root.ts')

const withEnv = <T>(vars: Record<string, string | undefined>, f: () => T): T => {
  const kept = Object.entries(vars).map(([k]) => [k, process.env[k]] as const)
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  try {
    return f()
  } finally {
    for (const [k, v] of kept) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
}

const spec = (key: string) => ({ key, name: `shep-proof-${key.replace(/\W/g, '')}`, kind: 'claude', cwd: proof, workspace: 'proof', first: 'Go.' })

describe('a server with a home of its own', () => {
  test('starts agents only when it is asked to, when it is a worker for another machine, or at the real home', () => {
    expect(withEnv({ SHEPHERDR_HOME: proof, SHEPHERDR_LAUNCH_AGENTS: undefined, SHEPHERDR_BOX: undefined }, launchesAgents)).toBe(false)
    expect(withEnv({ SHEPHERDR_HOME: proof, SHEPHERDR_LAUNCH_AGENTS: '1', SHEPHERDR_BOX: undefined }, launchesAgents)).toBe(true)
    expect(withEnv({ SHEPHERDR_HOME: REAL_HOME, SHEPHERDR_LAUNCH_AGENTS: undefined, SHEPHERDR_BOX: undefined }, launchesAgents)).toBe(true)
    // a worker for another machine starts agents there: its own home is under its main server's, not the real one
    const worker = { SHEPHERDR_HOME: join(HOME, 'machines', 'laptop'), SHEPHERDR_LAUNCH_AGENTS: undefined }
    expect(withEnv({ ...worker, SHEPHERDR_BOX: '{}', SHEPHERDR_MAIN_HOME: REAL_HOME }, launchesAgents)).toBe(true)
    // a proof server's own worker is no way around the rule
    expect(withEnv({ ...worker, SHEPHERDR_BOX: '{}', SHEPHERDR_MAIN_HOME: proof }, launchesAgents)).toBe(false)
    // nor is a home moved elsewhere, whose server says the yes itself (its workers inherit it)
    expect(withEnv({ ...worker, SHEPHERDR_BOX: undefined, SHEPHERDR_MAIN_HOME: undefined }, launchesAgents)).toBe(false)
    expect(withEnv({ SHEPHERDR_HOME: join(HOME, 'machines', 'laptop'), SHEPHERDR_LAUNCH_AGENTS: '1', SHEPHERDR_BOX: '{}', SHEPHERDR_MAIN_HOME: '/srv/shepherdr' }, launchesAgents)).toBe(true)
  })

  test('refuses a launch, says why in its log, and starts nothing', async () => {
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    // a launch waits on timers of its own, which a test does not need
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    const a = new Agents()
    try {
      await withEnv({ SHEPHERDR_HOME: proof, SHEPHERDR_LAUNCH_AGENTS: undefined, SHEPHERDR_BOX: undefined }, async () => {
        await expect(a.ensure(spec('LP-1/Agent'))).rejects.toThrow(/LP-1\/Agent not started/)
        expect(start).not.toHaveBeenCalled()
        const said = logged.mock.calls.map((c) => (c as string[]).join(' ')).join('\n')
        expect(said).toContain(skippedLaunch('LP-1/Agent'))
        expect(said).toContain('SHEPHERDR_LAUNCH_AGENTS=1')
      })
      await withEnv({ SHEPHERDR_HOME: proof, SHEPHERDR_LAUNCH_AGENTS: undefined, SHEPHERDR_BOX: undefined }, async () => {
        // a restart and a relaunch refuse too, before a turn is stopped or a pane closed, and they say why
        const close = spyOn(herdr, 'closePane').mockResolvedValue(undefined as never)
        const seen = spyOn(herdr, 'processInfo').mockRejectedValue(new Error('no herdr here') as never)
        try {
          await expect(a.restart(spec('LP-4/Agent'))).rejects.toThrow(/not started/)
          await expect(a.relaunch('LP-4/Agent', true, async () => 'started')).rejects.toThrow(/not started/)
          expect(close).not.toHaveBeenCalled()
          // and no route is bound for one either: nothing written, nothing read back from herdr
          const bind = (r: ReturnType<typeof spec>) => (a as unknown as { bindRoute(r: unknown, pane: string): Promise<void> }).bindRoute(r, 'fake-pane')
          await bind(spec('LP-4/Agent'))
          expect(seen).not.toHaveBeenCalled()
        } finally {
          close.mockRestore()
          seen.mockRestore()
        }
      })
      await withEnv({ SHEPHERDR_HOME: proof, SHEPHERDR_LAUNCH_AGENTS: '1', SHEPHERDR_BOX: undefined }, async () => {
        // asked to: it goes on to herdr (a socket that isn't there), so the rule is what stood in the way before
        Object.assign(a, { refresh: async () => undefined, bindRoute: async () => undefined, queue: () => undefined, paneFor: async () => 'fake-pane' })
        await a.ensure(spec('LP-2/Agent')).catch(() => undefined)
        expect(start).toHaveBeenCalled()
      })
    } finally {
      a.stop()
      start.mockRestore()
      logged.mockRestore()
      timer.mockRestore()
    }
  })

  test('keeps its agents credentials in its own home, where the helper writes them', () => {
    const credentialFile = withEnv({ SHEPHERDR_HOME: proof, SHEPHERDR_LAUNCH_AGENTS: undefined }, () => agentEnv('LP-3/Agent', ROOT).SHEPHERDR_SECRET_FILE)
    expect(home()).toBe(proof)
    expect(credentialFile).toStartWith(join(proof, 'helper', 'credentials', ''))
    // the name helper/route.pl accepts: a uuid
    expect(credentialFile.split('/').pop()).toMatch(/^[a-f0-9-]{36}$/)
    expect(credentialFile).not.toStartWith(join(REAL_HOME, 'helper'))

    const bind = (file: string, shepherdrHome = proof) =>
      Bun.spawnSync(['perl', join(ROOT, 'helper', 'route.pl'), '--bind', String(process.pid)], {
        // the helper is a machine's own: its HOME there, and the Shepherdr home SHEPHERDR_HOME moves
        env: { ...process.env, HOME: proof, SHEPHERDR_HOME: shepherdrHome },
        stdin: Buffer.from(JSON.stringify({ chat: 'LP-3/Agent', cwd: proof, url: 'http://127.0.0.1:1', capability: undefined, credentialFile: file })),
      })
    const written = bind(credentialFile)
    expect(written.stderr.toString()).toBe('')
    expect(written.exitCode).toBe(0)
    expect(existsSync(credentialFile)).toBe(true)
    expect(statSync(credentialFile).mode & 0o777).toBe(0o600)
    // the same home written another way (node's join normalizes it, so the helper must agree), and never the real one
    for (const written of [`${proof}/`, `${proof}//`, `${proof}/./`]) expect(bind(credentialFile, written).exitCode).toBe(0)
    const outside = join(proof, 'elsewhere', credentialFile.split('/').pop()!)
    expect(bind(outside).exitCode).not.toBe(0)
    expect(bind(join(REAL_HOME, 'helper', 'credentials', credentialFile.split('/').pop()!)).exitCode).not.toBe(0)
  })
})
