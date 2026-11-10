// What test/preload.ts promises every test file: it touches neither the Shepherdr nor the herdr of the machine it runs
// on, and neither does a command its code starts (Bun.spawn hands a child the environment the process started with,
// so the preload gives a start with no env of its own process.env as it is now).
import { expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

test("a command the code under test starts gets the test's Shepherdr home and herdr socket, never the machine's", () => {
  expect(process.env.SHEPHERDR_HOME).not.toBe(join(homedir(), '.shepherdr'))
  const said = (cmd: string, opts?: { env?: Record<string, string> }) => Bun.spawnSync(['/bin/sh', '-c', cmd], opts).stdout.toString().trim()
  expect(said('echo "$SHEPHERDR_HOME|$HERDR_SOCKET_PATH|$HERDR_PANE_ID"')).toBe(`${process.env.SHEPHERDR_HOME}|${process.env.HERDR_SOCKET_PATH}|`)
  // set since the process started: still what the child gets
  process.env.PRELOAD_PROBE = 'now'
  expect(said('echo "$PRELOAD_PROBE"')).toBe('now')
  expect(Bun.spawnSync({ cmd: ['/bin/sh', '-c', 'echo "$PRELOAD_PROBE"'] }).stdout.toString().trim()).toBe('now')
  // one that passes its own env keeps it
  expect(said('echo "[$PRELOAD_PROBE]"', { env: { PATH: process.env.PATH! } })).toBe('[]')
  delete process.env.PRELOAD_PROBE
})

test('a command started with Bun.spawn gets it too', async () => {
  const p = Bun.spawn(['/bin/sh', '-c', 'echo "$SHEPHERDR_HOME"'], { stdout: 'pipe' })
  expect((await new Response(p.stdout).text()).trim()).toBe(process.env.SHEPHERDR_HOME!)
})
