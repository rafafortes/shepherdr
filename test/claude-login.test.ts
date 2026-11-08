// Which login every Claude Code Shepherdr starts signs in with (claude-login.ts): the subscription, exactly as before,
// or an Anthropic API key from Shepherdr's secrets, which each Claude Code gets through a settings file's apiKeyHelper.
// A fake key and a fake script only: no real credential and no real Anthropic request is anywhere near this file.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const { API_KEY_NAME, keyHelper, LOGIN_KEY, loginOf, loginWords, NEEDS_KEY, reviewSettings, reviewSettingsPath } = await import('../server/live/claude-login.ts')
const { hookSettings } = await import('../server/live/readers/hooks.ts')
const { settingsBlock } = await import('../server/live/prompts.ts')
const { loginHint } = await import('../server/live/restart.ts')
const { Agents, HOOKS_DIR } = await import('../server/live/agents.ts')
const { Vault } = await import('../server/live/secrets.ts')
const { Settings } = await import('../server/live/settings.ts')
const { writeJson } = await import('../server/store.ts')

/** a vault of this test's own, in a folder of its own: never the human's */
function vault(kept: Record<string, Record<string, string>> = {}) {
  const home = tmp('claude-login-vault')
  const v = new Vault(home)
  for (const [level, all] of Object.entries(kept)) for (const [name, value] of Object.entries(all)) expect(v.set(level, name, value).ok).toBe(true)
  return { home, v }
}

/** what the helper script prints, run as Claude Code runs it: with a runtime, the vault's home and the levels */
function ask(chain: string[], home: string) {
  const r = spawnSync('/bin/sh', ['-c', keyHelper(home, chain)], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}

describe('the key helper Claude Code runs', () => {
  test('prints the key of the first level of the chain that has one, and nothing else', () => {
    const { home, v } = vault({ all: { [API_KEY_NAME]: 'sk-ant-fake-everywhere', OTHER_KEY: 'sk-other' }, 'm:one': { [API_KEY_NAME]: 'sk-ant-fake-machine' }, 'p:one:work': { [API_KEY_NAME]: 'sk-ant-fake-space' } })
    expect(ask(['p:one:work', 'm:one', 'all'], home).out).toBe('sk-ant-fake-space')
    expect(ask(['m:one', 'all'], home).out).toBe('sk-ant-fake-machine')
    expect(ask(['p:one:other', 'm:two', 'all'], home).out).toBe('sk-ant-fake-everywhere')
    // nothing it can be asked for but that one name, and nothing where no level of its chain has it
    const empty = tmp('claude-login-empty')
    expect(ask(['p:two:work'], empty)).toMatchObject({ code: 1, out: '' })
    expect(ask(['p:two:work'], empty).err).toContain(API_KEY_NAME)
    expect(v.pick([API_KEY_NAME], ['p:one:work']).found[API_KEY_NAME].level).toBe('p:one:work')
  })

  test('leaves the settings file exactly as it was without a login of its own', () => {
    // the subscription: today's byte-for-byte file, no apiKeyHelper key at all
    const dir = tmp('hooks-login')
    const plain = JSON.parse(readFileSync(hookSettings(dir, 'shep-x').settings, 'utf8'))
    expect(Object.keys(plain)).toEqual(['hooks'])
    const { home } = vault({ all: { [API_KEY_NAME]: 'sk-ant-fake-key' } })
    const withKey = JSON.parse(readFileSync(hookSettings(dir, 'shep-x', { apiKeyHelper: keyHelper(home, ['all']) }).settings, 'utf8'))
    expect(Object.keys(withKey)).toEqual(['hooks', 'apiKeyHelper'])
    // the command names the script, the vault home and the levels, never the key
    expect(withKey.apiKeyHelper).toContain(join(HOOKS_DIR, 'claude-key.cjs'))
    expect(withKey.apiKeyHelper).toContain("'all'")
    expect(withKey.apiKeyHelper).not.toContain('sk-ant-fake-key')
    expect(withKey.hooks).toEqual(plain.hooks)
  })
})

describe('the login setting', () => {
  test('is the subscription unless the human picks the key, and refuses the key with none kept', () => {
    writeJson('settings.json', { everywhere: {}, machine: {}, spaces: {} })
    const s = new Settings()
    expect(s.login()).toBe('subscription')
    expect(loginOf('api')).toBe('api')
    expect(loginOf('nonsense')).toBe('subscription')
    // without a vault to ask (a world of its own) nothing is refused
    expect(s.set(LOGIN_KEY, 'api')).toEqual({ ok: true })
    expect(s.login()).toBe('api')
    s.set(LOGIN_KEY, null)
    // with one: the key has to be there first, at this level or one above it
    s.apiKeyAt = (l) => l === 'machine'
    expect(s.set(LOGIN_KEY, 'api')).toMatchObject({ ok: false, error: NEEDS_KEY })
    expect(s.set(LOGIN_KEY, 'api', 'machine')).toEqual({ ok: true })
    expect(s.login()).toBe('api')
    // every level of its own, the most specific winning
    s.apiKeyAt = (l) => l === 'all'
    expect(s.set(LOGIN_KEY, 'api', { space: 'work' })).toMatchObject({ ok: false })
    s.apiKeyAt = () => true
    expect(s.set(LOGIN_KEY, 'api', { space: 'work' }).ok).toBe(true)
    expect(s.login('work')).toBe('api')
    expect(s.pick(LOGIN_KEY, { space: 'work' }).from).toBe('space')
    // an unset level goes back to the one above
    s.set(LOGIN_KEY, null, { space: 'work' })
    expect(s.login('work')).toBe('api')
    expect(loginWords('api')).toBe('an Anthropic API key')
    expect(loginWords('subscription')).toBe('the Claude subscription')
  })

  test('reaches a new brief as one line, with the command a headless review runs with', () => {
    const ways = { review: true, mustFix: 'major', rounds: 3, merge: 'on its own', waitChecks: false }
    const file = reviewSettingsPath('p:one:work')
    const subscription = settingsBlock('SHE-1', { ways, login: { login: 'subscription', settings: file } })
    expect(subscription).toContain('Login: the Claude subscription, the claude.ai login you use.')
    expect(subscription).toContain(`claude -p --settings ${file} "<prompt>" < /dev/null`)
    const api = settingsBlock('SHE-1', { ways, login: { login: 'api', settings: file } })
    expect(api).toContain(`Login: an Anthropic API key from Shepherdr's secrets (${API_KEY_NAME}), never the subscription.`)
    expect(api).toContain(`claude -p --settings ${file}`)
    // a brief from before the setting simply has no line
    expect(settingsBlock('SHE-1', { ways })).not.toContain('Login:')
  })

  test('writes a review settings file that follows the login, and hands nothing else to a review', () => {
    const { home } = vault({ 'p:one:work': { [API_KEY_NAME]: 'sk-ant-fake-review' } })
    const file = reviewSettings('p:one:work', keyHelper(home, ['p:one:work', 'm:one', 'all']))
    expect(file).toBe(reviewSettingsPath('p:one:work'))
    const api = JSON.parse(readFileSync(file, 'utf8'))
    expect(Object.keys(api)).toEqual(['apiKeyHelper'])
    expect(api.apiKeyHelper).not.toContain('sk-ant-fake-review')
    // switched back to the subscription: the same file, nothing added, so a brief written for the key still runs
    expect(reviewSettings('p:one:work')).toBe(file)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
    rmSync(file, { force: true })
    // two places whose names read alike never share a file (each would carry the other's chain)
    expect(reviewSettingsPath('p:one:my app')).not.toBe(reviewSettingsPath('p:one:my-app'))
  })
})

describe('a Claude Code Shepherdr starts', () => {
  const rec = (o: Record<string, unknown>) => ({ key: 'p:one:work', name: 'test-claude', kind: 'claude', cwd: '/unused', workspace: 'w', logs: [], started: 0, ...o })
  const { home, v } = vault({ 'p:one:work': { [API_KEY_NAME]: 'sk-ant-fake-agent' } })

  test('runs with the subscription exactly as before, its settings file unchanged', () => {
    const a = new Agents()
    try {
      const args = a.args(rec({}), false)
      expect(args.slice(0, 2)).toEqual(['--settings', join(HOOKS_DIR, 'test-claude.settings.json')])
      const file = JSON.parse(readFileSync(args[1]!, 'utf8'))
      expect(Object.keys(file)).toEqual(['hooks'])
    } finally {
      a.stop()
    }
  })

  test('signs in with the key through its settings file, and stops when the key is gone', () => {
    const a = new Agents()
    a.secretScope = () => ['p:one:work', 'm:one', 'all']
    // source.ts answers this from the vault, and nothing where the key is not kept
    a.apiKeyHelper = (chain) => (v.pick([API_KEY_NAME], chain).missing.length ? undefined : keyHelper(home, chain))
    try {
      const args = a.args(rec({ login: 'api' }), false)
      const file = JSON.parse(readFileSync(args[1]!, 'utf8'))
      expect(Object.keys(file)).toEqual(['hooks', 'apiKeyHelper'])
      expect(ask(['p:one:work', 'm:one', 'all'], home).out).toBe('sk-ant-fake-agent')
      // no key at any level: nothing is launched, and the reason is plain
      rmSync(join(home, 'vault.json'), { force: true })
      expect(() => a.args(rec({ login: 'api' }), false)).toThrow(/ANTHROPIC_API_KEY/)
    } finally {
      a.stop()
    }
  })

  test('a login that differs from Settings is offered like a model change', () => {
    expect(loginHint('subscription', 'subscription')).toBeUndefined()
    expect(loginHint('api', 'subscription')).toEqual({ on: 'an Anthropic API key', want: 'the Claude subscription' })
  })
})

describe('a vault of its own', () => {
  test('the helper reads only the name it was written for', () => {
    const { home, v } = vault({ all: { [API_KEY_NAME]: 'sk-ant-fake-one' } })
    expect(existsSync(join(home, 'vault.json'))).toBe(true)
    expect(v.names()).toMatchObject({ all: [{ name: API_KEY_NAME }] })
    expect(ask(['all'], home).out).toBe('sk-ant-fake-one')
  })
})
