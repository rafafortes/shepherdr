// The shepherdr command's interim channel (UXD-08): the live server sends newline-delimited JSON, one {step} line as
// each step finishes, then the one final {out, code}. Those words go to stderr; stdout stays the answer, so a pipe or
// a shell assignment keeps working. An older helper or the demo answers with one application/json object, read whole.
import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const cli = join(root, 'server', 'cli.ts')

/** run the command to its end: what it printed on each stream, its code, and how long it took */
function run(argv: string[], env: Record<string, string>) {
  return new Promise<{ out: string; err: string; code: number | null; ms: number }>((done) => {
    const at = Date.now()
    const c = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let out = ''
    let err = ''
    c.stdout?.on('data', (d) => (out += d))
    c.stderr?.on('data', (d) => (err += d))
    c.on('close', (code) => done({ out, err, code, ms: Date.now() - at }))
  })
}

/** a server that answers with these ndjson records, one line each */
const streamed = (records: unknown[]) =>
  Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(`${records.map((r) => JSON.stringify(r)).join('\n')}\n`, { headers: { 'content-type': 'application/x-ndjson' } }),
  })

describe('shepherdr interim words', () => {
  test('steps reach stderr as they arrive; stdout holds only the final answer', async () => {
    const server = streamed([
      { step: 'one (one.test): helper put there again, worker started again' },
      { step: 'two (two.test): helper put there again, worker started again' },
      { out: 'one (one.test): done\ntwo (two.test): done\n', code: 0 },
    ])
    try {
      const r = await run([process.execPath, cli, 'doctor'], { SHEPHERDR_URL: `http://127.0.0.1:${server.port}` })
      expect(r.code).toBe(0)
      expect(r.err).toBe('one (one.test): helper put there again, worker started again\ntwo (two.test): helper put there again, worker started again\n')
      expect(r.out).toBe('one (one.test): done\ntwo (two.test): done\n')
    } finally {
      server.stop(true)
    }
  })

  test('a pipe on stdout carries exactly the final record, never a step', async () => {
    const server = streamed([{ step: 'checks: 1 passed, still running' }, { out: "GitHub's checks passed on PR #1 (2).\n", code: 0 }])
    try {
      const url = `http://127.0.0.1:${server.port}`
      const piped = await run(['sh', '-c', `"${process.execPath}" "${cli}" checks SHE-1 | cat`], { SHEPHERDR_URL: url })
      expect(piped.out).toBe("GitHub's checks passed on PR #1 (2).\n")
      expect(piped.err).toContain('checks: 1 passed, still running')
      // a direct call answers the same, with the step still only on stderr
      expect((await run([process.execPath, cli, 'checks', 'SHE-1'], { SHEPHERDR_URL: url })).out).toBe(piped.out)
    } finally {
      server.stop(true)
    }
  })

  test('an older helper or the demo: one application/json object, no steps on stderr', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ out: 'ok\n', code: 3 }) })
    try {
      const r = await run([process.execPath, cli, 'status'], { SHEPHERDR_URL: `http://127.0.0.1:${server.port}` })
      expect(r.code).toBe(3)
      expect(r.out).toBe('ok\n')
      expect(r.err).toBe('')
    } finally {
      server.stop(true)
    }
  })

  test('a stream that goes silent still ends by its bound, with the words it already had', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(`${JSON.stringify({ step: 'checks: still running' })}\n`))
            },
          }),
          { headers: { 'content-type': 'application/x-ndjson' } },
        ),
    })
    try {
      const r = await run([process.execPath, cli, 'checks', 'SHE-1'], { SHEPHERDR_URL: `http://127.0.0.1:${server.port}`, SHEPHERDR_CHECKS_WAIT: '1000' })
      expect(r.code).toBe(1)
      expect(r.err).toContain('checks: still running')
      expect(r.err).toContain('shepherdr checks got no answer from Shepherdr in 1 s')
      expect(r.ms).toBeLessThan(8000)
    } finally {
      server.stop(true)
    }
  })

  test('the /api/cli route streams its steps before the final record', async () => {
    const { startApp } = await import('../server/app.ts')
    const { Emitter } = await import('../server/source.ts')
    const source = Object.assign(new Emitter(), {
      kind: 'live',
      cli: async (_args: string[], _c: unknown, onStep?: (words: string) => void) => {
        onStep?.('one: helper put there again, worker started again')
        onStep?.('two: helper put there again, worker started again')
        return { out: 'final answer\n', code: 0 }
      },
      snapshot: () => ({ name: 'S', host: 'h', places: [], machines: [], tasks: [], automations: {}, asks: {}, settings: [], overrides: {}, user: 'u' }),
      chat: () => undefined,
    })
    const app = startApp({ source: source as never, dist: '/nonexistent', port: 0 })
    try {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/cli`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({ args: ['doctor'] }),
      })
      expect(r.headers.get('content-type')).toContain('application/x-ndjson')
      expect(await r.text()).toBe('{"step":"one: helper put there again, worker started again"}\n{"step":"two: helper put there again, worker started again"}\n{"out":"final answer\\n","code":0}\n')
    } finally {
      app.stop(true)
    }
  })

  test('the /api/cli route gives an error as a final record when the command throws', async () => {
    const { startApp } = await import('../server/app.ts')
    const { Emitter } = await import('../server/source.ts')
    const source = Object.assign(new Emitter(), {
      kind: 'live',
      cli: async () => {
        throw new Error('command broke')
      },
      snapshot: () => ({ name: 'S', host: 'h', places: [], machines: [], tasks: [], automations: {}, asks: {}, settings: [], overrides: {}, user: 'u' }),
      chat: () => undefined,
    })
    const app = startApp({ source: source as never, dist: '/nonexistent', port: 0 })
    try {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/cli`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({ args: ['doctor'] }),
      })
      expect(await r.text()).toBe('{"out":"command broke\\n","code":1}\n')
    } finally {
      app.stop(true)
    }
  })

  test('a caller that does not ask for steps (an older helper) gets one application/json object', async () => {
    const { startApp } = await import('../server/app.ts')
    const { Emitter } = await import('../server/source.ts')
    const source = Object.assign(new Emitter(), {
      kind: 'live',
      cli: async (_args: string[], _c: unknown, onStep?: (words: string) => void) => {
        onStep?.('this step is never sent to a caller that cannot read it')
        return { out: 'ok\n', code: 0 }
      },
      snapshot: () => ({ name: 'S', host: 'h', places: [], machines: [], tasks: [], automations: {}, asks: {}, settings: [], overrides: {}, user: 'u' }),
      chat: () => undefined,
    })
    const app = startApp({ source: source as never, dist: '/nonexistent', port: 0 })
    try {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/cli`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args: ['checks', 'SHE-1'] }) })
      expect(r.headers.get('content-type')).toContain('application/json')
      expect(await r.json()).toEqual({ out: 'ok\n', code: 0 })
    } finally {
      app.stop(true)
    }
  })

  test('a caller that goes away mid-call never stops the command from finishing its work', async () => {
    const { startApp } = await import('../server/app.ts')
    const { Emitter } = await import('../server/source.ts')
    let finished = false
    const source = Object.assign(new Emitter(), {
      kind: 'live',
      cli: async (_args: string[], _c: unknown, onStep?: (words: string) => void) => {
        onStep?.('one: helper put there again, worker started again')
        await Bun.sleep(50)
        // a gone client must not make this throw: doctor goes on to the next machine
        onStep?.('two: helper put there again, worker started again')
        finished = true
        return { out: 'done\n', code: 0 }
      },
      snapshot: () => ({ name: 'S', host: 'h', places: [], machines: [], tasks: [], automations: {}, asks: {}, settings: [], overrides: {}, user: 'u' }),
      chat: () => undefined,
    })
    const app = startApp({ source: source as never, dist: '/nonexistent', port: 0 })
    try {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/cli`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({ args: ['doctor'] }),
        signal: AbortSignal.timeout(10),
      }).catch(() => undefined)
      if (r) await r.text().catch(() => undefined)
      await Bun.sleep(120)
      expect(finished).toBe(true)
    } finally {
      app.stop(true)
    }
  })
})
