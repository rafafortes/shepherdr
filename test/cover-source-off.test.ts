// The live source with the Browser and Voice plugins turned off (Settings → Plugins): no shared browsers, and a call
// that says why instead of ringing. The plugin list is generated for the whole checkout, so this file turns those two
// off for its own process only, at the one place the server asks.
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('cover-off')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
// No CLI of this machine runs here: herdr (asked which agents it starts) and agent-browser (asked its version) are
// stand-ins that answer nothing. Bun looks a command up in the PATH this process started with unless it is given an
// environment, so each command this process starts is given this one.
const standIns = tmp('cover-off-bin')
for (const n of ['herdr', 'agent-browser']) writeFileSync(join(standIns, n), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
process.env.PATH = `${standIns}:${process.env.PATH}`
process.env.SHEPHERDR_AGENT_BROWSER = join(standIns, 'agent-browser')
{
  type Opts = { env?: Record<string, string | undefined> } | undefined
  const withEnv = (a: unknown, o?: Opts) => (Array.isArray(a) ? [a, { ...o, env: o?.env ?? process.env }] : [{ ...(a as object), env: (a as Opts)?.env ?? process.env }])
  const [spawn, spawnSync] = [Bun.spawn, Bun.spawnSync] as unknown as ((...x: unknown[]) => unknown)[]
  Bun.spawn = ((a: unknown, o?: Opts) => spawn(...withEnv(a, o))) as typeof Bun.spawn
  Bun.spawnSync = ((a: unknown, o?: Opts) => spawnSync(...withEnv(a, o))) as typeof Bun.spawnSync
}
const plugins = await import('../server/plugins.ts')
const has = plugins.has
mock.module('../server/plugins.ts', () => ({ ...plugins, has: (name: string) => name !== 'browser' && name !== 'voice' && has(name) }))
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')

const src = new LiveSource()
afterAll(() => src.stop())

describe('with the Browser and Voice plugins off', () => {
  test('no task has a shared browser, and its panel says the plugin is off', () => {
    expect(src.browsers).toBeNull()
    const out: string[] = []
    src.engine.tasks.push({ id: 'OFF-1', project: 'p:here:x' } as never)
    src.browser('OFF-1', { send: (d: string) => out.push(d), close: () => undefined } as never)
    expect(JSON.parse(out[0]).message).toBe('The browser is not in the plugin list.')
  })

  test('a voice call says Voice is not in the plugin list, and takes nothing', () => {
    const out: string[] = []
    const call = src.voice(placeId.home(), { send: (d) => out.push(String(d)), close: () => undefined })
    call.audio(new ArrayBuffer(2))
    call.end()
    expect(out.map((m) => JSON.parse(m))).toEqual([{ type: 'error', message: 'Voice is not in the plugin list.' }])
  })
})
