// Settings → Models → Quotas: Command Code's account windows and credits (command-code-quota.ts), read with a fake fetch:
// a full answer, a partial one (a part missing is missing, never zero), a rejected key, an unreachable or slow API, and no
// key at all, which asks for it and makes no request. The key is never in a reason or a figure.
import { describe, expect, test } from 'bun:test'
import { readCommandCode } from '../server/live/command-code-quota.ts'

const KEY = 'cc-test-key-0123456789'
const NOW = Date.UTC(2026, 10, 13, 9)
const WHO = { org: { id: 'org-1', login: 'acme' } }
const CREDITS = {
  credits: { monthlyCredits: 100, purchasedCredits: 20, freeCredits: 5 },
  windowLimits: { fiveHour: { used: 30, cap: 120, resetAt: '2026-11-13T15:00:00Z' }, weekly: { used: 400, cap: 1000, resetAt: 1794600000 } },
}

type Answer = { status: number; body?: unknown } | 'hang' | 'unreachable'
/** a fake fetch: the answer of each path (the query left out), and every request it was asked */
function fakeFetch(routes: Record<string, Answer>) {
  const asked: { url: string; auth?: string }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    asked.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization })
    const path = new URL(url).pathname
    const a = routes[path]
    if (a === 'hang') return new Promise<Response>(() => undefined)
    if (a === 'unreachable' || a === undefined) throw new TypeError('fetch failed')
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status })
  }) as unknown as typeof fetch
  return { fetchImpl, asked }
}

describe('no key: nothing is read, and the screen asks for the key', () => {
  test('without a key the hint names the Secret, and no request is made', async () => {
    const { fetchImpl, asked } = fakeFetch({})
    expect(await readCommandCode(undefined, () => NOW, { fetch: fetchImpl })).toEqual({ hint: "Add COMMANDCODE_API_KEY in Settings → Secrets to read Command Code's quota." })
    expect(asked).toEqual([])
  })
})

describe('a read with the key', () => {
  test('the account is checked, then the credits with its org; the windows and the credits are the figure, the key sent as a bearer token only', async () => {
    const { fetchImpl, asked } = fakeFetch({ '/alpha/whoami': { status: 200, body: WHO }, '/alpha/billing/credits': { status: 200, body: CREDITS } })
    const got = await readCommandCode(KEY, () => NOW, { fetch: fetchImpl })
    expect(got).toEqual({
      figure: {
        windows: [
          { name: '5 h', used: 30, cap: 120, usedPct: 25, resetAt: Date.parse('2026-11-13T15:00:00Z') },
          { name: 'Week', used: 400, cap: 1000, usedPct: 40, resetAt: 1794600000_000 },
          { name: 'Credits', left: 125 },
        ],
        source: "from Command Code's API",
        at: NOW,
      },
    })
    expect(asked.map((r) => new URL(r.url).pathname)).toEqual(['/alpha/whoami', '/alpha/billing/credits'])
    expect(new URL(asked[1]!.url).searchParams.get('orgId')).toBe('org-1')
    expect(asked.every((r) => r.auth === `Bearer ${KEY}`)).toBe(true)
    expect(JSON.stringify(got)).not.toContain(KEY)
  })

  test('a window with no cap is left out, one with nothing in it too; a refill word that is no moment is none; a moment in milliseconds is kept', async () => {
    const body = {
      windowLimits: {
        fiveHour: { used: 0, cap: 0 },
        weekly: { used: 3, cap: 10, resetAt: 'soon' },
      },
    }
    const { fetchImpl } = fakeFetch({ '/alpha/whoami': { status: 200, body: { user: { userName: 'me' } } }, '/alpha/billing/credits': { status: 200, body } })
    expect(await readCommandCode(KEY, () => NOW, { fetch: fetchImpl })).toEqual({ figure: { windows: [{ name: 'Week', used: 3, cap: 10, usedPct: 30 }], source: "from Command Code's API", at: NOW } })
    const ms = { windowLimits: { weekly: { used: 1, cap: 4, resetAt: 1794600000_000 }, fiveHour: { used: 5, cap: 0, resetAt: -5 } } }
    const { fetchImpl: second, asked } = fakeFetch({ '/alpha/whoami': { status: 200, body: { user: { userName: 'me' } } }, '/alpha/billing/credits': { status: 200, body: ms } })
    const got = await readCommandCode(KEY, () => NOW, { fetch: second })
    expect(got).toEqual({ figure: { windows: [{ name: '5 h', used: 5, cap: 0, usedPct: 100 }, { name: 'Week', used: 1, cap: 4, usedPct: 25, resetAt: 1794600000_000 }], source: "from Command Code's API", at: NOW } })
    // no org: the credits are asked without one
    expect(new URL(asked[1]!.url).search).toBe('')
  })

  test('credits that are partly there give what they have; a count that is no number, or no credits at all, give none', async () => {
    const some = { credits: { monthlyCredits: 7, purchasedCredits: 'x' } }
    const { fetchImpl } = fakeFetch({ '/alpha/whoami': { status: 200, body: WHO }, '/alpha/billing/credits': { status: 200, body: some } })
    expect(await readCommandCode(KEY, () => NOW, { fetch: fetchImpl })).toEqual({ figure: { windows: [{ name: 'Credits', left: 7 }], source: "from Command Code's API", at: NOW } })
    const none = { credits: 'x', windowLimits: 'x' }
    const again = fakeFetch({ '/alpha/whoami': { status: 200, body: WHO }, '/alpha/billing/credits': { status: 200, body: none } })
    expect(await readCommandCode(KEY, () => NOW, { fetch: again.fetchImpl })).toEqual({ reason: 'Command Code returned no usage figures for the account.' })
  })

  test('a moment as a text number, a date, or nothing: the figure keeps what it can', async () => {
    const body = { windowLimits: { fiveHour: { used: 1, cap: 2, resetAt: '1794600000' }, weekly: { used: 1, cap: 2, resetAt: '' } } }
    const { fetchImpl } = fakeFetch({ '/alpha/whoami': { status: 200, body: WHO }, '/alpha/billing/credits': { status: 200, body } })
    const got = await readCommandCode(KEY, () => NOW, { fetch: fetchImpl })
    expect(got).toMatchObject({ figure: { windows: [{ name: '5 h', resetAt: 1794600000_000 }, { name: 'Week' }] } })
    expect(got).not.toMatchObject({ figure: { windows: [{ name: 'Week', resetAt: expect.anything() }] } })
  })
})

describe('the answers that are not a figure', () => {
  test('a rejected key says so, and asks for the Secret again', async () => {
    const r401 = fakeFetch({ '/alpha/whoami': { status: 401 } })
    expect(await readCommandCode(KEY, () => NOW, { fetch: r401.fetchImpl })).toEqual({ reason: 'Command Code rejected the key (401): check COMMANDCODE_API_KEY in Settings → Secrets.' })
    const r403 = fakeFetch({ '/alpha/whoami': { status: 200, body: WHO }, '/alpha/billing/credits': { status: 403 } })
    expect(await readCommandCode(KEY, () => NOW, { fetch: r403.fetchImpl })).toEqual({ reason: 'Command Code rejected the key (403): check COMMANDCODE_API_KEY in Settings → Secrets.' })
  })

  test('an account check that fails, answers with no account, or cannot be reached', async () => {
    const down = fakeFetch({ '/alpha/whoami': { status: 500 } })
    expect(await readCommandCode(KEY, () => NOW, { fetch: down.fetchImpl })).toEqual({ reason: 'Command Code answered 500 to its account check.' })
    const text = fakeFetch({ '/alpha/whoami': { status: 200 } })
    expect(await readCommandCode(KEY, () => NOW, { fetch: text.fetchImpl })).toEqual({ reason: 'Command Code answered 200 to its account check.' })
    const off = fakeFetch({ '/alpha/whoami': 'unreachable' })
    expect(await readCommandCode(KEY, () => NOW, { fetch: off.fetchImpl })).toEqual({ reason: 'Could not reach Command Code.' })
  })

  test('a credits request that fails leaves the windows out, and a read with no figure says so', async () => {
    const f = fakeFetch({ '/alpha/whoami': { status: 200, body: WHO }, '/alpha/billing/credits': { status: 500 } })
    expect(await readCommandCode(KEY, () => NOW, { fetch: f.fetchImpl })).toEqual({ reason: 'Command Code returned no usage figures for the account.' })
  })

  test('an answer that is not JSON is no figure', async () => {
    const f = fakeFetch({ '/alpha/whoami': { status: 200, body: WHO }, '/alpha/billing/credits': { status: 200 } })
    expect(await readCommandCode(KEY, () => NOW, { fetch: f.fetchImpl })).toEqual({ reason: 'Command Code returned no usage figures for the account.' })
  })

  test('a read past its deadline gives up with the deadline in its words, the key kept out', async () => {
    const hung = fakeFetch({ '/alpha/whoami': 'hang' })
    const got = await readCommandCode(KEY, () => NOW, { fetch: hung.fetchImpl, timeoutMs: 20 })
    expect(got).toEqual({ reason: 'Command Code did not answer within 0.02 s.' })
    expect(JSON.stringify(got)).not.toContain(KEY)
    // the account answers, the credits never do: the same deadline ends the whole read
    const slow = fakeFetch({ '/alpha/whoami': { status: 200, body: WHO }, '/alpha/billing/credits': 'hang' })
    expect(await readCommandCode(KEY, () => NOW, { fetch: slow.fetchImpl, timeoutMs: 20 })).toEqual({ reason: 'Command Code did not answer within 0.02 s.' })
  })
})
