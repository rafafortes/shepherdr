// The server prunes the helper's routes folder of dead processes' files: at the first refresh after it starts that reaches herdr, and every ten minutes after. A server that binds no routes (a proof home) prunes none.
//
// Every CLI: the pass is the helper's `--prune`, which looks at a pid and its start stamp and at no CLI's name, so one
// test serves claude, codex, pi, opencode and agy alike (route-prune.test.ts runs the helper itself).
import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const home = tmp('route-prune-server')
mkdirSync(join(home, 'hooks'), { recursive: true })
// this agent's own launch provisioned a secret file; a proof must not carry it into a route
delete process.env.SHEPHERDR_SECRET_FILE
process.env.HOME = home
process.env.SHEPHERDR_HOME = home
process.env.HERDR_SOCKET_PATH = join(home, 'no-herdr.sock')
process.env.SHEPHERDR_LAUNCH_AGENTS = '1'

const { Agents } = await import('../server/live/agents.ts')
const { herdr } = await import('../server/live/herdr.ts')
const routes = join(home, '.shepherdr', 'helper', 'routes')

/** a route file for a process that is gone: this one's pid, which no process holds */
const stale = (pid: number) => {
  mkdirSync(routes, { recursive: true })
  const file = join(routes, `${pid}.json`)
  writeFileSync(file, JSON.stringify({ stamp: '1', chat: 'DEAD-1/Agent', cwd: home }))
  return file
}

const until = async (f: () => boolean, ms = 5000) => {
  for (const t0 = Date.now(); !f(); await Bun.sleep(10)) if (Date.now() - t0 > ms) throw new Error('timed out')
}

type Pruner = { pruneAt: number; refresh: () => Promise<void> }

describe('the server prunes dead routes', () => {
  test('at the first refresh that reaches herdr, then not again within ten minutes', async () => {
    const first = stale(4_000_001)
    const agents = spyOn(herdr, 'agents').mockResolvedValue([])
    try {
      const a = new Agents() as unknown as Pruner
      await a.refresh()
      await until(() => !existsSync(first))
      // a file that dies after it: this pass is not due again yet
      const second = stale(4_000_002)
      await a.refresh()
      await Bun.sleep(300)
      expect(existsSync(second)).toBe(true)
      // due again
      a.pruneAt = Date.now() - 11 * 60_000
      await a.refresh()
      await until(() => !existsSync(second))
    } finally {
      agents.mockRestore()
    }
  })

  test('a live process’s route stays', async () => {
    const owner = Bun.spawn(['/bin/sleep', '30'])
    try {
      const bound = Bun.spawnSync(['perl', join(import.meta.dir, '..', 'helper', 'route.pl'), '--bind', String(owner.pid), JSON.stringify({ chat: 'LIVE-2/Agent', cwd: home })], {
        env: { ...process.env, HOME: home },
      })
      expect(bound.exitCode).toBe(0)
      const dead = stale(4_000_003)
      const agents = spyOn(herdr, 'agents').mockResolvedValue([])
      try {
        const a = new Agents() as unknown as Pruner
        await a.refresh()
        await until(() => !existsSync(dead))
        expect(existsSync(join(routes, `${owner.pid}.json`))).toBe(true)
      } finally {
        agents.mockRestore()
      }
    } finally {
      owner.kill()
    }
  })

  test('a server that may start no agent prunes nothing', async () => {
    const file = stale(4_000_004)
    const agents = spyOn(herdr, 'agents').mockResolvedValue([])
    process.env.SHEPHERDR_LAUNCH_AGENTS = '0'
    try {
      const a = new Agents() as unknown as Pruner
      await a.refresh()
      await Bun.sleep(300)
      expect(existsSync(file)).toBe(true)
    } finally {
      process.env.SHEPHERDR_LAUNCH_AGENTS = '1'
      agents.mockRestore()
    }
  })
})
