// A command whose caller goes away (/api/cli in server/app.ts): the signal a command may read (`ctx.signal`) aborts when its
// command gave up, was interrupted or its connection closed, on both ways the server answers (the one application/json
// object an older helper reads, the ndjson stream the command reads); one that is still waited for is never aborted. What a
// command does with it is the command's (a line hold's reservation: line-hold-cli.test.ts, engine-line-hold.test.ts).
import { afterAll, describe, expect, test } from 'bun:test'
import { startApp } from '../server/app.ts'
import { Emitter, type Source, type SourceEvents } from '../server/source.ts'
import { until } from './engine-world.ts'

/** a source that answers a command when told, and says whether its caller was gone by the time it did */
class Stub extends Emitter<SourceEvents> {
  kind = 'live' as const
  /** every command that came in: its words, and whether the caller has gone */
  calls: { args: string[]; signal?: AbortSignal; answered?: boolean }[] = []
  snapshot() {
    return { name: 'x', host: 'h', places: [], tasks: [], automations: {}, artifacts: [], asks: {}, settings: [], user: 'u' }
  }
  watch() {}
  /** answers the command `go` once it is released; until then it waits, as a line hold waits for the merge in flight */
  release: (() => void)[] = []
  async cli(args: string[], ctx: { signal?: AbortSignal }) {
    const call: Stub['calls'][number] = { args, signal: ctx.signal }
    this.calls.push(call)
    await new Promise<void>((done) => this.release.push(done))
    call.answered = true
    return { out: 'answered\n', code: 0 }
  }
}

const source = new Stub()
const server = startApp({ source: source as unknown as Source, dist: '/nonexistent', port: 0 })
const base = `http://127.0.0.1:${server.port}`
afterAll(() => server.stop(true))

const post = (args: string[], accept: string | undefined, signal?: AbortSignal) =>
  fetch(`${base}/api/cli`, { method: 'POST', headers: { host: `127.0.0.1:${server.port}`, ...(accept ? { accept } : {}) }, body: JSON.stringify({ args }), signal })

describe('a command whose caller goes away', () => {
  for (const [way, accept] of [
    ['the ndjson stream the command reads', 'application/x-ndjson'],
    ['the one object an older helper reads', undefined],
  ] as const) {
    test(`over ${way}: its signal aborts when the connection closes, and not before`, async () => {
      const n = source.calls.length
      const gone = new AbortController()
      const asked = post(['line', 'hold', 'goes'], accept, gone.signal).catch((e: Error) => e)
      await until(() => source.calls.length === n + 1)
      const call = source.calls[n]
      // still waited for: not aborted, however long the command waits
      await Bun.sleep(300)
      expect(call.signal?.aborted).toBe(false)
      gone.abort()
      expect(((await asked) as Error).name).toBe('AbortError')
      await until(() => call.signal?.aborted === true)
      for (const done of source.release.splice(0)) done()
    })

    test(`over ${way}: a command whose caller waits to the end is answered, and its signal was never aborted`, async () => {
      const n = source.calls.length
      const asked = post(['line', 'hold', 'stays'], accept)
      await until(() => source.calls.length === n + 1)
      await Bun.sleep(300)
      const call = source.calls[n]
      expect(call.signal?.aborted).toBe(false)
      for (const done of source.release.splice(0)) done()
      const r = await asked
      expect(await r.text()).toContain('answered')
      expect(call.answered).toBe(true)
      expect(call.signal?.aborted).toBe(false)
    })
  }
})
