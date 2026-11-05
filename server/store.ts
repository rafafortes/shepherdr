// Shepherdr's own small files: what herdr can't tell it (projects, modes, update cards, drafts, push devices).
// One folder, ~/.shepherdr unless SHEPHERDR_HOME says otherwise; each file is plain JSON, written whole.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const HOME = process.env.SHEPHERDR_HOME || (process.env.NODE_ENV === 'test' ? testHome() : join(homedir(), '.shepherdr'))

/** where Shepherdr's own files are now: read on every call, so a test can give each of its worlds a folder of its own
 *  (a test that times out goes on running, and must not reach into the one the next test reads and writes) */
export const home = () => process.env.SHEPHERDR_HOME || HOME

/** under bun test, never the real ~/.shepherdr (however the tests were started): an empty folder of their own */
function testHome() {
  const dir = mkdtempSync(join(tmpdir(), 'shep-test-home-'))
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function readJson<T>(name: string, fallback: T): T {
  const f = join(home(), name)
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : fallback
  } catch {
    return fallback
  }
}

/** secrets (keys, push subscriptions) are readable by you only */
const PRIVATE = new Set(['secrets.json', 'vapid.json', 'push.json'])

export function writeJson(name: string, value: unknown) {
  const f = join(home(), name)
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 })
  const tmp = `${f}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: PRIVATE.has(name) ? 0o600 : 0o644 })
  renameSync(tmp, f)
}
