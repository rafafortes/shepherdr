// Run before the tests in every checkout (bunfig.toml): a fresh worktree, or one whose lockfile moved since its last
// install, gets its dependencies and plugin registries first, and plain bun test goes the fast way (scripts/test.ts).
import { afterAll } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeRegistries } from '../scripts/build-plugins.ts'
import { setTaskTmpBase } from '../server/live/task-tmp.ts'
import { once } from './once.ts'
import { cleanup, sweep, tmp } from './tmp.ts'

// Tests never touch the Shepherdr that runs on this machine: its data folder, its server and its chats. A test file
// that wants a home of its own sets one before it imports the store; until then, and in every file that doesn't,
// it is a fresh empty folder (bun test without --parallel shares the store between files). test/tmp.ts removes it with
// the rest when the file's tests end; a run killed before that leaves its sweep to the next one, which scripts/test.ts
// does once for a whole run and a file run by hand does here.
if (!process.env.SHEPHERDR_TEST_RUN) sweep()
const home = tmp('test-home')
process.env.SHEPHERDR_HOME = home
// task agents' TMPDIR/SHEPHERDR_TMP: their own folder under a base this test process owns, removed with the rest
const taskBase = tmp('task-tmp')
setTaskTmpBase(() => taskBase)
// doctor's check-log size line (server/live/resources.ts) measures this folder; a test that runs doctor without
// injecting its own reader must see the test's copy, never the operator's
process.env.SHEPHERDR_CHECK_LOG_ROOT = join(home, '.cache', 'shepherdr', 'check-local')
// agy's store (~/.gemini/antigravity-cli) is never read by a test: a folder under the test's home that does not exist
process.env.SHEPHERDR_AGY_HOME = join(home, 'no-agy-home')
// Nor may a test reach the host's OpenCode (or any CLI that follows XDG) data and configs: each gets this file's own
// home, which test/tmp.ts removes with the rest. A test that wants a fixture points these at one of its own folders and
// restores them afterwards; the default is never ~/.local/share/opencode, ~/.config/opencode or the host's XDG dirs.
process.env.SHEPHERDR_OPENCODE_DB = join(home, 'opencode', 'opencode.db')
process.env.XDG_DATA_HOME = join(home, 'xdg-data')
process.env.XDG_CONFIG_HOME = join(home, 'xdg-config')
// bun starts every test file in a worker of its own and ends it without running what is registered on the process: the
// folders go when its last test does, failing or not (a run that ends any other way keeps the sweep as its net)
afterAll(cleanup)
// Tests are a server with a home of its own that does start agents: a fake herdr, or something spied on (launch-policy.ts)
process.env.SHEPHERDR_LAUNCH_AGENTS = '1'
// The server prunes the helper's routes folder, which route.pl finds under the real $HOME, not under a test's home: a test that
// wants the prune says so itself (test/route-prune-server.test.ts)
process.env.SHEPHERDR_PRUNE_ROUTES = '0'
// Nor do they reach the herdr of the machine they run on, or say they are panes of it: the socket is a path that isn't
// there (a test that wants a herdr listens on one of its own, as test/launch-pending.test.ts does), and no inherited
// pane, tab or workspace id says otherwise.
process.env.HERDR_SOCKET_PATH = join(home, 'no-herdr.sock')
// herdr dropping a call is tried again after a wait (server/live/herdr.ts): short here, so a test that meets one does not sit
// through the seconds a real start waits
process.env.SHEPHERDR_HERDR_RETRY_MS = '5,5,5'
process.env.SHEPHERDR_START_RETRY_MS = '5,5,5'
// HERDR_PLUGIN_STATE_DIR is the live plugin's own folder when this suite is started from inside Shepherdr (the merge gate
// starts it that way): a test that asserts the supervisor's server.log path, or writes there, must see its own home, never
// ~/.local/state/herdr/plugins/herdr-projects. test/prepare.test.ts sets it for the children it starts, on purpose.
for (const k of ['SHEPHERDR_URL', 'SHEPHERDR_CHAT', 'HERDR_SOCKET', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PLUGIN_STATE_DIR']) delete process.env[k]

// What this file sets above reaches every child too. Bun.spawn and Bun.spawnSync hand a child the environment the
// process started with, not process.env as changed since (Bun 1.4.4): a command the code under test starts with no env of
// its own would get this machine's Shepherdr home and herdr socket, and look itself up in the PATH a test can't change.
// Such a start gets process.env as it is now; one that passes its own env keeps it.
for (const name of ['spawn', 'spawnSync'] as const) {
  const started = Bun[name] as (cmd: unknown, opts?: Record<string, unknown>) => unknown
  Object.assign(Bun, {
    [name]: (cmd: unknown, opts?: Record<string, unknown>) =>
      Array.isArray(cmd)
        ? started(cmd, opts && 'env' in opts ? opts : { ...opts, env: { ...process.env } })
        : started('env' in (cmd as object) ? cmd : { ...(cmd as object), env: { ...process.env } }),
  })
}

const root = join(import.meta.dir, '..')
const modules = join(root, 'node_modules')
const stamp = join(modules, '.shepherdr-deps')
const want = createHash('sha256')
  .update(['bun.lock', 'package.json'].map((f) => readFileSync(join(root, f), 'utf8')).join('\0'))
  .digest('hex')

mkdirSync(modules, { recursive: true })
await once(
  join(modules, '.shepherdr-deps.lock'),
  () => existsSync(stamp) && readFileSync(stamp, 'utf8') === want,
  () => {
    const r = Bun.spawnSync([process.execPath, 'install', '--frozen-lockfile'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (!r.success) throw new Error(`bun install failed:\n${r.stderr.toString()}`)
    writeFileSync(stamp, want)
  },
)

writeRegistries()

/** how this bun was started: bun test runs the preload in the process the command started */
function command(): string[] {
  try {
    return readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean)
  } catch {
    const r = Bun.spawnSync(['ps', '-o', 'args=', '-p', String(process.pid)], { stdout: 'pipe' })
    return r.stdout.toString().trim().split(/\s+/)
  }
}

// Plain bun test runs the files one at a time in one process, where they share what they import (the store, the
// settings): slow, and one file's leftovers can fail another. It runs as bun run test instead, the files in parallel,
// each on its own. --parallel, --isolate and the runner's own workers run as asked.
const cmd = command()
const at = cmd.indexOf('test')
if (!process.env.SHEPHERDR_TEST_RUNNER && at > 0 && !cmd.some((a) => /^--(parallel|isolate|test-worker)\b/.test(a))) {
  console.log('bun test runs as bun run test here: the files in parallel, each on its own (AGENTS.md).')
  const r = Bun.spawnSync([process.execPath, join(root, 'scripts', 'test.ts'), ...cmd.slice(at + 1)], { cwd: process.cwd(), stdio: ['inherit', 'inherit', 'inherit'] })
  process.exit(r.exitCode ?? 1)
}

// a test file's process stopped by hand, by a check's timeout or by the harness goes with its folders; scripts/test.ts
// never loads this file, so its own handlers, which kill the tests and the browser, are the ones that run there
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.on(signal, () => {
    cleanup()
    process.exit(1)
  })
