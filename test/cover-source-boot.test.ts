// The live source started as the server starts it, outside tests: it also sets going what a test never wants on its
// own (the shared browsers' sweeps, the way back to a primary model ten minutes on, the advisor, the machine's health,
// revivals and the watch on starts), and its link to the other machines looks for the ones saved in herdr. That look
// is a stand-in here, so no herdr is run and no machine is reached; the server is stopped before any first look of its
// own is due.
import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const home = tmp('cover-boot')
process.env.SHEPHERDR_HOME = home
process.env.HERDR_SOCKET_PATH = join(home, 'no-herdr.sock')
// the quota read at start looks at the home's Claude Code folder: a test's own, never the human's (it finds none here)
process.env.HOME = join(home, 'user-home')
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.SHEPHERDR_MAIN
// No CLI of this machine runs here: herdr (asked which agents it starts), agent-browser (asked its version) and claude (the
// quota read at start, which must never run the human's own Claude Code) are stand-ins that answer nothing. Bun looks a command up in the PATH this process started with unless it is given an
// environment, so each command this process starts is given this one.
const standIns = tmp('cover-boot-bin')
for (const n of ['herdr', 'agent-browser', 'claude']) writeFileSync(join(standIns, n), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
process.env.PATH = `${standIns}:${process.env.PATH}`
process.env.SHEPHERDR_AGENT_BROWSER = join(standIns, 'agent-browser')
{
  type Opts = { env?: Record<string, string | undefined> } | undefined
  const withEnv = (a: unknown, o?: Opts) => (Array.isArray(a) ? [a, { ...o, env: o?.env ?? process.env }] : [{ ...(a as object), env: (a as Opts)?.env ?? process.env }])
  const [spawn, spawnSync] = [Bun.spawn, Bun.spawnSync] as unknown as ((...x: unknown[]) => unknown)[]
  Bun.spawn = ((a: unknown, o?: Opts) => spawn(...withEnv(a, o))) as typeof Bun.spawn
  Bun.spawnSync = ((a: unknown, o?: Opts) => spawnSync(...withEnv(a, o))) as typeof Bun.spawnSync
}
const { LiveSource } = await import('../server/live/source.ts')
const { Machines } = await import('../server/live/machines.ts')

describe('started as the server starts it', () => {
  test('it sets its watches going, the way back ten minutes on, and looks for the saved machines; stopped, it leaves none behind', async () => {
    const env = process.env.NODE_ENV
    const sync = Machines.prototype.sync
    let synced = 0
    Machines.prototype.sync = async () => void synced++
    // what it sets going later, by how long it waits: the way back's first look is ten minutes on
    const later = new Map<number, () => void>()
    const setTimeout_ = globalThis.setTimeout
    globalThis.setTimeout = ((f: () => void, ms?: number, ...a: unknown[]) => (later.set(ms ?? 0, f), setTimeout_(f, ms, ...a))) as typeof setTimeout
    process.env.NODE_ENV = 'production'
    let src: InstanceType<typeof LiveSource> | undefined
    try {
      src = new LiveSource()
      process.env.NODE_ENV = env
      globalThis.setTimeout = setTimeout_
      expect(synced).toBe(1)
      const timers = (src as unknown as { timers: unknown[] }).timers
      // a test's own server sets six of them; this one the rest too
      expect(timers.length).toBeGreaterThanOrEqual(14)
      // ten minutes on: the way back looks once, and then every minute
      const n = timers.length
      let looked = 0
      src.watchReturns = (async () => void looked++) as never
      later.get(10 * 60_000)!()
      expect(looked).toBe(1)
      expect(timers.length).toBe(n + 1)
    } finally {
      globalThis.setTimeout = setTimeout_
      process.env.NODE_ENV = env
      src?.stop()
      Machines.prototype.sync = sync
    }
  })
})
