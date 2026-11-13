// Command Code's plan windows and credits, for Settings → Models → Quotas. The read is the minimal one of the MIT package
// pi-commandcode-provider (src/quota.ts, Copyright (c) 2025 Pat Woz, MIT License): GET /alpha/whoami, then
// /alpha/billing/credits, with the API key as a bearer token, a 15 s deadline for the whole read. The package's usage
// summary and subscription are left out (the screen needs neither). A part the API leaves out is left out, never zero.
// The key comes from Shepherdr's own Secrets (COMMANDCODE_API_KEY, the caller passes it in), goes to that API and nowhere
// else: no reason, figure or log of this module holds it.
import type { QuotaFigure, QuotaWindow } from '../../shared/types.ts'
import type { Reading } from './plan-limits.ts'

/** the Secrets name of the key, and the words that ask for it */
export const SECRET = 'COMMANDCODE_API_KEY'
export const API = 'https://api.commandcode.ai'
/** the whole read, all its requests together (the package's own limit) */
export const TIMEOUT_MS = 15_000

interface Options {
  fetch?: typeof fetch
  timeoutMs?: number
}

class Late extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/** a refill moment as the API gives it: a number or a date, in seconds or milliseconds (the package's own rule) */
function moment(v: unknown): number | undefined {
  let t: number | undefined
  if (typeof v === 'number') t = v
  else if (typeof v === 'string' && v.trim()) t = /^\d+$/.test(v.trim()) ? Number(v.trim()) : Date.parse(v.trim())
  if (t === undefined || !Number.isFinite(t) || t < 0) return undefined
  return t >= 1e12 ? t : t * 1000
}

/** the window the API gives under its name: fiveHour is the 5 h window, weekly the week. A window with nothing in it is left out */
function windowsOf(limits: unknown): QuotaWindow[] {
  if (!isRecord(limits)) return []
  const out: QuotaWindow[] = []
  for (const [key, name] of [
    ['fiveHour', '5 h'],
    ['weekly', 'Week'],
  ] as const) {
    const w = limits[key]
    if (!isRecord(w)) continue
    const used = count(w.used)
    const cap = count(w.cap)
    if (used === undefined || cap === undefined || (used === 0 && cap === 0)) continue
    const resetAt = moment(w.resetAt)
    out.push({ name, used, cap, usedPct: cap ? (used / cap) * 100 : 100, ...(resetAt !== undefined ? { resetAt } : {}) })
  }
  return out
}

/** one read of the account's windows and credits. `key` undefined: nothing is read, and the hint says what to add */
export async function readCommandCode(key: string | undefined, now: () => number = Date.now, options: Options = {}): Promise<Reading> {
  if (!key) return { hint: `Add ${SECRET} in Settings → Secrets to read Command Code's quota.` }
  const doFetch = options.fetch ?? fetch
  const limit = options.timeoutMs ?? TIMEOUT_MS
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort()
      reject(new Late())
    }, limit)
  })
  // a read that ends first leaves the deadline unawaited: that is no failure
  deadline.catch(() => undefined)
  // a request: its status and what its JSON says, or a status of 0 when it could not be reached
  const get = async (path: string, params: Record<string, string> = {}): Promise<{ status: number; body?: unknown }> => {
    const query = new URLSearchParams(params).toString()
    try {
      const res = await Promise.race([doFetch(`${API}${path}${query ? `?${query}` : ''}`, { method: 'GET', headers: { accept: 'application/json', Authorization: `Bearer ${key}` }, signal: ctl.signal }), deadline])
      if (!res.ok) return { status: res.status }
      return { status: res.status, body: await Promise.race([res.json().catch(() => undefined), deadline]) }
    } catch (e) {
      if (e instanceof Late) throw e
      return { status: 0 }
    }
  }
  try {
    const who = await get('/alpha/whoami')
    if (who.status === 401 || who.status === 403) return { reason: `Command Code rejected the key (${who.status}): check ${SECRET} in Settings → Secrets.` }
    if (who.status === 0) return { reason: 'Could not reach Command Code.' }
    if (who.status !== 200 || !isRecord(who.body)) return { reason: `Command Code answered ${who.status} to its account check.` }
    const org = isRecord(who.body.org) ? who.body.org : undefined
    const orgId = org && typeof org.id === 'string' && org.id ? org.id : undefined
    const credits = await get('/alpha/billing/credits', orgId ? { orgId } : {})
    if (credits.status === 401 || credits.status === 403) return { reason: `Command Code rejected the key (${credits.status}): check ${SECRET} in Settings → Secrets.` }
    const body = isRecord(credits.body) ? credits.body : undefined
    const windows = windowsOf(body?.windowLimits)
    const c = body && isRecord(body.credits) ? body.credits : undefined
    const left = c ? [c.monthlyCredits, c.purchasedCredits, c.freeCredits].map(count).filter((x): x is number => x !== undefined) : []
    if (left.length) windows.push({ name: 'Credits', left: left.reduce((a, b) => a + b, 0) })
    if (!windows.length) return { reason: 'Command Code returned no usage figures for the account.' }
    const figure: QuotaFigure = { windows, source: "from Command Code's API", at: now() }
    return { figure }
  } catch {
    // only the deadline gets here: every request's own failure is an answer above
    return { reason: `Command Code did not answer within ${limit / 1000} s.` }
  } finally {
    clearTimeout(timer)
  }
}
