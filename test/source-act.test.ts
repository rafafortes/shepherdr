// A write of a setting the shell runs (alerts.command and its kind, SEC-04) needs the screen's own per-boot proof.
// The proof is minted by the live source, handed to the screen over its socket, and copied from the request header into
// the action by the server; the shepherdr command writes settings directly and keeps working for the operator.
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const home = tmp('source-act')
process.env.SHEPHERDR_HOME = home
process.env.HERDR_SOCKET_PATH = join(home, 'no-herdr.sock')
process.env.SHEPHERDR_OPENCODE_DB = join(home, 'no-opencode.db')
delete process.env.SHEPHERDR_MAIN

const { LiveSource } = await import('../server/live/source.ts')
const { startApp } = await import('../server/app.ts')
const { readJson } = await import('../server/store.ts')

const src = new LiveSource()
const app = startApp({ source: src, dist: '/nonexistent', port: 0 })
const base = `http://127.0.0.1:${app.port}`
afterAll(() => {
  app.stop(true)
  src.stop()
})

const stored = () => readJson<{ everywhere?: Record<string, string>; machine?: Record<string, string> }>('settings.json', {})
const refused = (r: unknown) => expect(r).toMatchObject({ ok: false, error: expect.stringContaining('Settings') })

describe("executable settings need the screen's own proof", () => {
  test('source.act refuses a command without the capability and keeps settings.json as it was', async () => {
    expect(stored().everywhere?.['alerts.command']).toBeUndefined()
    refused(await src.act({ type: 'setting', key: 'alerts.command', value: 'echo pwned' }))
    expect(stored().everywhere?.['alerts.command']).toBeUndefined()
    expect(src.settings.get('alerts.command')).toBe('off')
  })

  test('the same write with the capability the screen got still works', async () => {
    expect(await src.act({ type: 'setting', key: 'alerts.command', value: 'echo allowed', capability: src.writeCapability })).toEqual({ ok: true })
    expect(stored().everywhere?.['alerts.command']).toBe('echo allowed')
    // a wrong proof is no proof
    refused(await src.act({ type: 'setting', key: 'alerts.command', value: 'echo wrong', capability: '0'.repeat(64) }))
    expect(stored().everywhere?.['alerts.command']).toBe('echo allowed')
    expect(await src.act({ type: 'setting', key: 'alerts.command', value: null, capability: src.writeCapability })).toEqual({ ok: true })
  })

  test('a non-executable key still writes through act with no capability', async () => {
    expect(await src.act({ type: 'setting', key: 'review.rounds', value: '3' })).toEqual({ ok: true })
    expect(src.settings.get('review.rounds')).toBe('3 rounds')
    expect(await src.act({ type: 'setting', key: 'review.rounds', value: null })).toEqual({ ok: true })
  })

  test('a POST to /api/action must carry a real proof, in the header the screen uses', async () => {
    const post = (headers: Record<string, string>, body: Record<string, unknown> = {}) =>
      fetch(`${base}/api/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shepherdr': '1', ...headers },
        body: JSON.stringify({ type: 'setting', key: 'alerts.doneCommand', value: 'echo done', ...body }),
      }).then((r) => r.json())

    refused(await post({}))
    expect(stored().everywhere?.['alerts.doneCommand']).toBeUndefined()
    refused(await post({ 'x-shepherdr-capability': '0'.repeat(64) }))
    expect(stored().everywhere?.['alerts.doneCommand']).toBeUndefined()
    expect(await post({ 'x-shepherdr-capability': src.writeCapability })).toEqual({ ok: true })
    expect(stored().everywhere?.['alerts.doneCommand']).toBe('echo done')
    expect(await src.act({ type: 'setting', key: 'alerts.doneCommand', value: null, capability: src.writeCapability })).toEqual({ ok: true })
  })

  test('the /api/cli route refuses an executable key from a browser page but not from a local shell', async () => {
    const cli = (headers: Record<string, string>) =>
      fetch(`${base}/api/cli`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shepherdr': '1', ...headers },
        body: JSON.stringify({ args: ['set', 'alerts.command', 'echo cli-http'] }),
      }).then((r) => r.json())
    const host = `127.0.0.1:${app.port}`
    const page = await cli({ origin: `http://${host}`, 'sec-fetch-site': 'same-origin' })
    expect(page.code).toBe(1)
    expect(page.out).toContain('Set it in Settings')
    expect(stored().everywhere?.['alerts.command']).toBeUndefined()
    // no Origin: a shell (or the alert installer) keeps working
    expect(await cli({})).toMatchObject({ code: 0 })
    expect(stored().everywhere?.['alerts.command']).toBe('echo cli-http')
    expect(await src.cli(['unset', 'alerts.command'], { local: true })).toMatchObject({ code: 0 })
  })

  test('a write to another machine is gated here before it is forwarded there', async () => {
    const realPeers = src.peers
    const forwarded: unknown[] = []
    try {
      src.peers = {
        ownerOfAction: () => ({ placeholder: true }),
        act: async (_l: unknown, a: unknown) => {
          forwarded.push(a)
          return { ok: true }
        },
      } as never
      refused(await src.act({ type: 'setting', key: 'alerts.command', value: 'echo remote', place: 'm:other' }))
      expect(forwarded).toEqual([])
      expect(stored().everywhere?.['alerts.command']).toBeUndefined()
      expect(await src.act({ type: 'setting', key: 'alerts.command', value: 'echo remote', place: 'm:other', capability: src.writeCapability })).toEqual({ ok: true })
      expect(forwarded).toHaveLength(1)
    } finally {
      src.peers = realPeers
    }
  })

  test('a page cannot plant a per-task merge gate with task add --set either', async () => {
    const page = await src.cli(['task', 'add', 'A task', '--set', 'merge.gate=echo pwned'], { local: false })
    expect(page.code).toBe(1)
    expect(page.out).toContain('Set it in Settings')
    // a local shell gets past this gate (the rest of task add may still need a space set up)
    const local = await src.cli(['task', 'add', 'A task', '--set', 'merge.gate=echo safe'], { local: true })
    expect(local.out).not.toContain('Set it in Settings')
  })

  test('a worker accepts a forwarded write only with the main proof it learned over its link', async () => {
    const mainProof = 'f'.repeat(64)
    src.setMainProof(mainProof)
    try {
      refused(await src.act({ type: 'setting', key: 'alerts.command', value: 'echo forged' }))
      expect(await src.act({ type: 'setting', key: 'alerts.command', value: 'echo from-main', capability: mainProof })).toEqual({ ok: true })
      expect(stored().everywhere?.['alerts.command']).toBe('echo from-main')
      expect(await src.act({ type: 'setting', key: 'alerts.command', value: null, capability: src.writeCapability })).toEqual({ ok: true })
    } finally {
      src.setMainProof('')
    }
  })

  test('the screen gets that proof once over its own socket', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/api/ws`)
    try {
      const got = await new Promise<string | undefined>((done, fail) => {
        const timer = setTimeout(() => fail(new Error('no capability on the socket')), 4000)
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data)) as { type: string; capability?: string }
          if (msg.type !== 'capability') return
          clearTimeout(timer)
          done(msg.capability)
        }
        ws.onerror = () => {
          clearTimeout(timer)
          fail(new Error('the socket failed'))
        }
      })
      expect(got).toBe(src.writeCapability)
      expect(got).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      ws.close()
    }
  })

  test("a local shepherdr command still sets an executable key: it is the operator's tool (the lead's bound)", async () => {
    const r = await src.cli(['set', 'alerts.command', 'echo cli'], { local: true })
    expect(r.code).toBe(0)
    expect(src.settings.get('alerts.command')).toBe('echo cli')
    expect(stored().everywhere?.['alerts.command']).toBe('echo cli')
    expect((await src.cli(['unset', 'alerts.command'], { local: true })).code).toBe(0)
  })

  test('a page that got past same-site cannot use /api/cli to set one either, but can still set ordinary keys', async () => {
    const page = await src.cli(['set', 'alerts.command', 'echo page'], { local: false })
    expect(page.code).toBe(1)
    expect(page.out).toContain('Set it in Settings')
    expect(src.settings.get('alerts.command')).toBe('off')
    // a non-executable key keeps working from the command, with or without a local caller
    expect((await src.cli(['set', 'brief.review', 'off'], { local: false })).code).toBe(0)
    expect(src.settings.get('brief.review')).toBe('off')
    expect((await src.cli(['unset', 'brief.review'], { local: false })).code).toBe(0)
  })
})
