// Shepherdr's own small files: what herdr can't tell it (projects, modes, update cards, drafts, push devices).
// One folder, ~/.shepherdr unless SHEPHERDR_HOME says otherwise; each file is plain JSON, written whole.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const HOME = process.env.SHEPHERDR_HOME || (process.env.NODE_ENV === 'test' ? testHome() : join(homedir(), '.shepherdr'))

/** where Shepherdr's own files are now. HOME is where it started and stays for what is set up once at start; whoever
 *  keeps files while it runs takes this once, when it is made, and passes it as `dir`: a test gives each of its tests a
 *  folder of its own that way, since a test that times out goes on running and must not reach into the next one's. */
export const home = () => process.env.SHEPHERDR_HOME || HOME

/** under bun test, never the real ~/.shepherdr (however the tests were started): an empty folder of their own, named
 *  after the run and the process that made it as every test folder is (test/tmp.ts), so a run that was killed leaves
 *  one the next one can tell is stale and take */
function testHome() {
  const run = process.env.SHEPHERDR_TEST_RUN || String(process.pid)
  const dir = mkdtempSync(join(tmpdir(), `shep-test-home-${run}-${process.pid}-`))
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function readJson<T>(name: string, fallback: T, dir = home()): T {
  const f = join(dir, name)
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : fallback
  } catch {
    return fallback
  }
}

/** secrets (keys, push subscriptions) are readable by you only */
const PRIVATE = new Set(['secrets.json', 'vapid.json', 'push.json'])

export function writeJson(name: string, value: unknown, dir = home()) {
  const f = join(dir, name)
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 })
  const tmp = `${f}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: PRIVATE.has(name) ? 0o600 : 0o644 })
  renameSync(tmp, f)
}
