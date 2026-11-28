// The shepherdr command waits for its answer for the whole deadline it was given, however silent the connection is.
// `shepherdr line hold` waits up to 47 minutes for the merge in flight and exchanges no bytes meanwhile; Bun's fetch cuts
// a request whose socket is idle for five minutes (BUN_CONFIG_HTTP_IDLE_TIMEOUT) with the same TimeoutError as an
// AbortSignal.timeout, so the command gave up after about five minutes and told the caller it had waited its full 47
// (2026-11-27). server/cli.ts turns that idle timer off: the call's own deadline is the only limit.
//
// Five minutes is too long for a test, so the spawned command gets the shortest idle timeout the runtime has: Bun rounds
// it up to 4 s steps and cuts a silent request after the rounded time and one step more (8 s in Bun 1.4.4, measured;
// its documentation allows up to two steps more, 12 s). A server that stays silent for 13 s is silent past even that
// bound, so the test does not depend on the measured 8 s holding on a busy host. The file takes about 13 s: the runs
// share one silent window. It is a file of its own so that cli.test.ts, which already takes over 30 s, does not grow.
import { describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const root = join(import.meta.dir, '..')
const cli = join(root, 'server', 'cli.ts')
const perl = spawnSync('perl', ['-MJSON::PP', '-e1']).status === 0

/** how long the server says nothing: past the latest cut of a silent request the runtime's documentation allows (12 s) */
const SILENT = 13_000
/** the shortest idle timeout Bun takes (it rounds up to 4 s); the spawned command gets it as its default */
const SHORT_IDLE = { BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1' }

/** run it to its end: what it printed, its exit code, and how long it took */
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

/** what a silent server saw, and the handler that answers after SILENT unless its caller left first */
function silent() {
  const seen = { asked: 0, left: 0 }
  const handler = (req: Request) =>
    new Promise<Response>((answer) => {
      seen.asked++
      const timer = setTimeout(() => answer(Response.json({ out: 'held\n', code: 0 })), SILENT)
      req.signal.addEventListener('abort', () => {
        seen.left++
        clearTimeout(timer)
      })
    })
  return { seen, handler }
}

describe('a command waits out a connection that stays silent', () => {
  test('line hold and checks (here) and the helper (on another machine) wait through a silence longer than the idle timeout', async () => {
    const here = silent()
    const checks = silent()
    const tunnel = silent()
    const control = silent()
    // idleTimeout 0: the test's servers never cut a silent call themselves
    const http = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: here.handler })
    const other = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: checks.handler })
    const probed = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: control.handler })
    const dir = tmp('cli-silent')
    // main.sock is the tunnel's end on this machine
    const sock = Bun.serve({
      unix: join(dir, 'main.sock'),
      fetch: (req, srv) => {
        srv.timeout(req, 0)
        return tunnel.handler(req)
      },
    })
    try {
      mkdirSync(join(dir, 'bin'))
      copyFileSync(join(root, 'helper', 'shepherdr'), join(dir, 'bin', 'shepherdr'))
      const at = (s: { port?: number }) => ({ SHEPHERDR_URL: `http://127.0.0.1:${s.port}`, ...SHORT_IDLE })
      // the premise: a plain fetch of this runtime, with the same shortened idle timeout, is cut by it while the server is silent
      writeFileSync(
        join(dir, 'probe.ts'),
        "try { await fetch(process.env.URL, { method: 'POST', body: '{}', signal: AbortSignal.timeout(30000) }); console.log('answered') } catch (e) { console.log(e.name) }\n",
      )
      const [hold, check, helper, bare] = await Promise.all([
        run([process.execPath, cli, 'line', 'hold', 'lyvora-app', '--why', 'x'], at(http)),
        run([process.execPath, cli, 'checks', 'SHE-1'], at(other)),
        perl ? run(['perl', join(dir, 'bin', 'shepherdr'), 'line', 'hold', 'lyvora-app', '--why', 'x'], SHORT_IDLE) : Promise.resolve(undefined),
        run([process.execPath, join(dir, 'probe.ts')], { ...SHORT_IDLE, URL: `http://127.0.0.1:${probed.port}/` }),
      ])
      // the premise holds, or this test proves nothing about the command
      expect(bare.out).toBe('TimeoutError\n')
      expect(control.seen.left).toBe(1)
      // the commands waited the silence out and printed the answer; nobody cut the connection
      for (const [r, server] of [
        [hold, here],
        [check, checks],
      ] as const) {
        expect(r.err).toBe('')
        expect(r.out).toBe('held\n')
        expect(r.code).toBe(0)
        expect(r.ms).toBeGreaterThanOrEqual(SILENT - 500)
        expect(server.seen).toEqual({ asked: 1, left: 0 })
      }
      // the helper has no idle timer of its own (a Perl socket and alarm): the same silence, the same answer
      if (helper) {
        expect(helper.err).toBe('')
        expect(helper.out).toBe('held\n')
        expect(helper.code).toBe(0)
        expect(tunnel.seen).toEqual({ asked: 1, left: 0 })
      }
    } finally {
      http.stop(true)
      other.stop(true)
      probed.stop(true)
      sock.stop(true)
    }
  }, 40_000)

  test('a request the runtime cuts before its deadline says how long it really lasted, never the configured wait', async () => {
    const dir = tmp('cli-cut')
    // a fetch that ends early with the TimeoutError an idle timer gives, 1.5 s into a 60 s wait
    const cut = join(dir, 'cut.ts')
    writeFileSync(cut, "globalThis.fetch = (async () => { await Bun.sleep(1500); throw new DOMException('The operation timed out.', 'TimeoutError') }) as unknown as typeof fetch\n")
    const env = { SHEPHERDR_URL: 'http://127.0.0.1:1', SHEPHERDR_LINE_WAIT: '60000', SHEPHERDR_MERGE_WAIT: '60000' }
    const hold = await run([process.execPath, '--preload', cut, cli, 'line', 'hold', 'lyvora-app', '--why', 'x'], env)
    expect(hold.code).toBe(1)
    expect(hold.err).toMatch(/^shepherdr line got no answer from Shepherdr in [1-9] s \(the connection was cut before its limit of 60 s; it may have restarted or stalled\)/)
    expect(hold.err).not.toContain('in 60 s')
    // merge keeps its words and says the same about the cut
    const merge = await run([process.execPath, '--preload', cut, cli, 'merge', 'SHE-9'], env)
    expect(merge.code).toBe(1)
    expect(merge.err).toMatch(/^shepherdr merge SHE-9 got no answer from Shepherdr in [1-9] s \(the connection was cut before its limit of 60 s; it may have restarted\)/)
    expect(merge.err).toContain('run shepherdr merge SHE-9 again')
  })
})
