// Settings → Models → Quotas, the live source's side: Refresh quotas is an action; Command Code's key comes from Shepherdr's
// own Secrets (never from another tool's file, never in a reason, a figure or an alert); a switch in Settings turns its read
// off; a window at the warning share alerts, to the home chat. The Claude read and Command Code's fetch are the test's own.
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('quotas-source')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { Vault } = await import('../server/live/secrets.ts')
const { placeId } = await import('../server/live/places.ts')
const { HOUR } = await import('../server/live/usage-ledger.ts')
const { SECRET } = await import('../server/live/command-code-quota.ts')

const src = new LiveSource()
afterAll(() => src.stop())
// no test reads the human's Claude Code: each test that needs one gives its own answer (claude below)
src.claudeRead = async () => ({ hint: 'not read in tests' })

const KEY = 'cc-live-test-key-9876'
const NOW = Date.now()
/** the Claude read a test gives: its windows, as /usage would have them */
const claude = (usedPct: number) => async () => ({ figure: { windows: [{ name: '5 h', usedPct, resetAt: NOW + 2 * HOUR }], source: "from Claude Code's /usage", at: NOW } })
/** a fake Command Code API: whoami and credits, and every request it was asked (for the key's header) */
function commandFetch() {
  const asked: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    asked.push(`${url.pathname} ${(init?.headers as Record<string, string>).Authorization}`)
    const body = url.pathname === '/alpha/whoami' ? { org: { id: 'o' } } : { windowLimits: { weekly: { used: 1, cap: 4 } } }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, asked }
}
/** the alerts a window sent, as titles, tags and where they go */
function alerts() {
  const got: { title: string; tag?: string; from: string; go?: { place: string }; body: string }[] = []
  src.alert = ((a: { title: string; tag?: string; from: string; go?: { place: string }; body: string }) => got.push(a)) as never
  return got
}
/** the vault a test keeps its Secrets in: its own folder, with the names given at the Everywhere level */
const vaultWith = (secrets: Record<string, string>) => new Vault(tmp('quotas-vault'), { all: Object.fromEntries(Object.entries(secrets).map(([k, value]) => [k, { value, at: NOW }])) })

describe('Refresh quotas, the action', () => {
  test('starts each read that is on and reads Command Code with its key from Secrets, the key sent to the API only', async () => {
    src.claudeRead = claude(62)
    const f = commandFetch()
    src.commandFetch = f.fetchImpl
    src.vault = vaultWith({ [SECRET]: KEY })
    const got = alerts()
    expect(await src.act({ type: 'quota-refresh' })).toEqual({ ok: true, started: ['anthropic', 'commandcode'] })
    await src.quotas.settled()
    expect(src.usage.quota('anthropic')?.windows).toEqual([{ name: '5 h', usedPct: 62, resetAt: NOW + 2 * HOUR }])
    expect(src.usage.quota('commandcode')?.windows).toEqual([{ name: 'Week', used: 1, cap: 4, usedPct: 25 }])
    expect(f.asked).toEqual([`/alpha/whoami Bearer ${KEY}`, `/alpha/billing/credits Bearer ${KEY}`])
    // the key is in no status, no figure and no alert
    expect(JSON.stringify([src.quotas.status('commandcode'), src.quotas.status('anthropic'), src.usage.quota('commandcode'), got])).not.toContain(KEY)
    expect(got).toEqual([])
  })

  test('without the key in Secrets the hint says to add it, and nothing is requested', async () => {
    src.vault = vaultWith({})
    const f = commandFetch()
    src.commandFetch = f.fetchImpl
    await src.act({ type: 'quota-refresh' }) as unknown
    // a minute on: the refresh is allowed again
    src.quotas.refresh(NOW + 61_000)
    await src.quotas.settled()
    expect(src.quotas.status('commandcode').hint).toBe("Add COMMANDCODE_API_KEY in Settings → Secrets to read Command Code's quota.")
    expect(f.asked).toEqual([])
  })

  test('a Secrets file that cannot be read says so, with its path and no secret', async () => {
    const dir = tmp('quotas-bad-vault')
    writeFileSync(join(dir, 'vault.json'), 'not json')
    src.vault = new Vault(dir)
    const f = commandFetch()
    src.commandFetch = f.fetchImpl
    src.quotas.refresh(NOW + 122_000)
    await src.quotas.settled()
    expect(src.quotas.status('commandcode').failed).toMatch(/^Secrets can't be read from .*vault\.json/)
    expect(f.asked).toEqual([])
  })

  test('a switch off in Settings is not read, and the refresh says so when every one is off', async () => {
    src.vault = vaultWith({ [SECRET]: KEY })
    const seen: string[] = []
    src.claudeRead = async () => {
      seen.push('claude')
      return { hint: 'off test' }
    }
    expect(src.settings.set('quota.claude', 'off', 'all')).toEqual({ ok: true })
    expect(src.settings.set('quota.commandcode', 'off', 'all')).toEqual({ ok: true })
    expect(await src.act({ type: 'quota-refresh' })).toEqual({ ok: false, error: 'Every quota read is off: switch one on in Settings → Models → Quotas first.' })
    expect(seen).toEqual([])
    expect(src.quotas.status('anthropic').on).toBe(false)
    expect(src.settings.set('quota.claude', 'on', 'all')).toEqual({ ok: true })
    expect(src.settings.set('quota.commandcode', 'on', 'all')).toEqual({ ok: true })
  })
})

describe('the warning share reaches the alerts', () => {
  test('a window at quota.alertAt alerts to the home chat, once, tagged by its provider and window', async () => {
    const got = alerts()
    expect(src.settings.set('quota.alertAt', '70%', 'all')).toEqual({ ok: true })
    src.claudeRead = claude(75)
    src.quotas.refresh(NOW + 183_000)
    await src.quotas.settled()
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ title: 'Claude Code is at 75%', body: expect.stringMatching(/^5 h window: 25% left, and it refills /), from: 'Shepherdr', tag: 'quota:anthropic:5 h', go: { place: placeId.home() } })
    src.claudeRead = claude(76)
    src.quotas.refresh(NOW + 244_000)
    await src.quotas.settled()
    expect(got).toHaveLength(1)
    expect(src.settings.set('quota.alertAt', 'off', 'all')).toEqual({ ok: true })
  })
})

describe('the summary carries each read as it stands', () => {
  test('a provider with a figure shows it with its read; a window at quota.alertAt is a warning; the key is in none of it', async () => {
    src.vault = vaultWith({ [SECRET]: KEY })
    src.commandFetch = commandFetch().fetchImpl
    // a provider the summary knows (it ran a call this week), so its row carries the read
    src.usage.count('T-7/Agent', 'anthropic/claude-opus-5-5', { id: 'sum-claude', at: NOW - HOUR, tokens: 500 }, NOW)
    expect(src.settings.set('quota.alertAt', '80%', 'all')).toEqual({ ok: true })
    src.claudeRead = claude(91)
    src.quotas.refresh(NOW + 400_000)
    await src.quotas.settled()
    type Sum = { providers: { provider: string; quota?: { windows: { usedPct?: number }[] }; quotaRead?: { on: boolean; tried?: number } }[]; warnings: { id: string; words: string }[] }
    const sum = (await src.act({ type: 'models-summary' })) as Sum
    const row = sum.providers.find((p) => p.provider === 'anthropic')!
    expect(row.quota?.windows[0]).toMatchObject({ usedPct: 91 })
    expect(row.quotaRead).toMatchObject({ on: true, tried: NOW + 400_000 })
    expect(sum.warnings.find((w) => w.id === 'quota:anthropic')?.words).toMatch(/^Claude Code: 5 h is at 91%: 9% left, refills /)
    expect(JSON.stringify(sum)).not.toContain(KEY)
  })
})
