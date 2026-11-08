// Which login every Claude Code Shepherdr starts signs in with: the human's own claude.ai subscription (Settings →
// Agents → Claude Code login: subscription, the default, and exactly what Shepherdr did before this setting existed) or
// an Anthropic API key kept in Shepherdr's secrets (secrets.ts, ANTHROPIC_API_KEY). With the key, each Claude Code gets
// a settings file of its own (`--settings`) that names an apiKeyHelper: Claude Code runs that command when it needs the
// key, so the key sits in no launch argument, no environment an agent's tools inherit, no chat, no log and no brief.
// The helper is one small script of Shepherdr's that prints ANTHROPIC_API_KEY from the first level of the secret's
// chain that has it, and nothing else. An agent running as this machine's user can still run that command, or read
// the vault file itself: owner-only files are what protect it, and that is also Shepherdr's limit (docs/secrets.md).
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { boxDir, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from './mfs.ts'

/** the setting: Settings → Agents → Claude Code login */
export const LOGIN_KEY = 'claude.login'

/** its values: the subscription as you are signed in, or an Anthropic API key from Shepherdr's secrets */
export const LOGINS = ['subscription', 'api'] as const
export type Login = (typeof LOGINS)[number]

/** the secret the API key login reads, at the levels every other secret comes from */
export const API_KEY_NAME = 'ANTHROPIC_API_KEY'

/** why picking the API key login is refused when there is no key to use */
export const NEEDS_KEY = `Picking the API key login needs the key first: keep ${API_KEY_NAME} in Shepherdr's secrets for this level (in your own terminal: shepherdr secret set ${API_KEY_NAME} < file, or Settings → Secrets), then pick it.`

/** a login as it is kept: anything else is the subscription, so a warning never becomes a login of its own */
export const loginOf = (value: string): Login => (value === 'api' ? 'api' : 'subscription')

/** a login in words: "the Claude subscription", "an Anthropic API key" */
export const loginWords = (login: Login) => (login === 'api' ? 'an Anthropic API key' : 'the Claude subscription')

/** where Shepherdr's Claude Code settings files live, with the hooks' (agents.ts HOOKS_DIR) */
export const hooksDir = join(boxDir(), 'hooks')

/** the script Claude Code's apiKeyHelper runs; the levels of the secret come as arguments, its home first */
const KEY_HELPER = `// Written by Shepherdr: the key Claude Code's apiKeyHelper asks for (claude-login.ts).
const { readFileSync } = require('node:fs')
const [home, ...chain] = process.argv.slice(2)
try {
  const all = JSON.parse(readFileSync(home + '/vault.json', 'utf8'))
  for (const level of chain) {
    const kept = all[level] && all[level]['${API_KEY_NAME}']
    if (kept && typeof kept.value === 'string' && kept.value) {
      process.stdout.write(kept.value + '\\n')
      process.exit(0)
    }
  }
} catch {}
process.stderr.write('Shepherdr: no ${API_KEY_NAME} in its secrets for this agent.\\n')
process.exit(1)
`

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** a file replaced whole and only when it changed: other Claude Codes may be reading it */
function put(file: string, text: string, mode?: number) {
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}`
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode })
  renameSync(tmp, file)
}

/** the command Claude Code runs to get the key: the script, and the vault's home and the levels to look it up at, most
 *  specific first. Nothing in it is the key itself: the script reads the vault when Claude Code asks */
export function keyHelper(home: string, chain: string[], runtime = process.execPath): string {
  const file = join(hooksDir, 'claude-key.cjs')
  put(file, KEY_HELPER, 0o700)
  return [runtime, file, home, ...chain].map(q).join(' ')
}

/** the settings file a headless Claude Code review in a place runs with (an empty object: nothing added) */
export const reviewSettingsPath = (place: string) =>
  join(hooksDir, `review-${place.replace(/[^A-Za-z0-9_.-]+/g, '-')}-${createHash('sha256').update(place).digest('hex').slice(0, 8)}.settings.json`)

/** that file, written and returned by its path: the same apiKeyHelper a coordinator gets, so a headless review signs in
 *  exactly as its space does, or nothing added at all for the subscription login. It follows Settings, not the brief:
 *  a brief written before a switch still runs with the login Settings give its space now. */
export function reviewSettings(place: string, helper?: string): string {
  const file = reviewSettingsPath(place)
  put(file, JSON.stringify(helper ? { apiKeyHelper: helper } : {}, null, 2))
  return file
}
