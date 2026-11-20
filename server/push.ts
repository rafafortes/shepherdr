// Push alerts to installed web apps (Web Push with this server's own VAPID keys).
import webpush from 'web-push'
import { pushPayload } from '../shared/alerts.ts'
import type { Alert } from '../shared/types.ts'
import { readJson, writeJson } from './store.ts'

export const DEFAULT_PUSH_CONTACT = 'https://github.com/eliasstravik/shepherdr'

/** Reject local or malformed contacts before web-push signs anything. Existing keys stay unchanged. */
export function pushContact(value = process.env.SHEPHERDR_PUSH_CONTACT): string {
  try {
    const url = new URL(value ?? '')
    if (url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.') && !/^(localhost|127\.|0\.|\[)/i.test(url.hostname) && !url.hostname.endsWith('.localhost'))
      return url.href
    if (url.protocol === 'mailto:' && /^[^\s@/?#]+@[^\s@/?#]+\.[^\s@/?#]+$/.test(url.pathname) && !url.search && !url.hash && !url.pathname.endsWith('.localhost')) return url.href
  } catch {}
  return DEFAULT_PUSH_CONTACT
}

const MAX_FAILS = 10
const STALE_MS = 30 * 24 * 60 * 60 * 1000

/** lastOk and fails are absent until a subscription's first delivery: `at` is the age baseline until then. */
type Sub = { sub: webpush.PushSubscription; device: string; at: number; lastOk?: number; fails?: number }

export class Push {
  readonly publicKey: string
  private subs: Sub[]
  private failures = new Map<Sub, string>()
  private attempts = new WeakMap<Sub, number>()
  private vapid: { subject: string; publicKey: string; privateKey: string }
  constructor(
    contact = process.env.SHEPHERDR_PUSH_CONTACT,
    private deliver = webpush.sendNotification.bind(webpush),
  ) {
    let keys = readJson<{ publicKey: string; privateKey: string } | null>('vapid.json', null)
    if (!keys) {
      keys = webpush.generateVAPIDKeys()
      writeJson('vapid.json', keys)
    }
    this.publicKey = keys.publicKey
    this.vapid = { subject: pushContact(contact), ...keys }
    this.subs = readJson<Sub[]>('push.json', [])
  }
  get devices() {
    return this.subs.map((s) => s.device)
  }
  /** No endpoints, keys, raw provider text or browser user agents leave this class. */
  warnings(name: (device: string) => string) {
    return this.subs.flatMap((s, i) => {
      const failure = this.failures.get(s)
      return failure ? [`Device ${i + 1} (${name(s.device)}): ${failure}`] : []
    })
  }
  subscribe(sub: webpush.PushSubscription, device: string) {
    for (const s of this.subs) if (s.sub.endpoint === sub.endpoint) this.failures.delete(s)
    this.subs = this.subs.filter((s) => s.sub.endpoint !== sub.endpoint)
    this.subs.push({ sub, device, at: Date.now() })
    writeJson('push.json', this.subs)
  }
  /** a device the browser has unsubscribed: it gets nothing more */
  unsubscribe(endpoint: string) {
    const before = this.subs.length
    this.subs = this.subs.filter((s) => s.sub.endpoint !== endpoint)
    if (this.subs.length !== before) writeJson('push.json', this.subs)
  }
  /** skip: subscriptions whose app is on screen right now; waits: what waits on you now (the icon's count, and what
   *  older alerts may stay) */
  async send(a: Alert, skip: Set<string> = new Set(), waits: { count: number; tags: string[] } = { count: 0, tags: [] }) {
    const body = JSON.stringify(pushPayload(a, waits))
    const gone = new Map<Sub, number>()
    const to = this.subs.filter((s) => !skip.has(s.sub.endpoint))
    let changed = false
    await Promise.all(
      to.map(async (s) => {
        const attempt = (this.attempts.get(s) ?? 0) + 1
        this.attempts.set(s, attempt)
        try {
          await this.deliver(s.sub, body, { TTL: 3600, urgency: 'high', vapidDetails: this.vapid })
          if (this.attempts.get(s) === attempt) {
            this.failures.delete(s)
            s.lastOk = Date.now()
            s.fails = 0
            changed = true
          }
        } catch (error) {
          if (!this.subs.includes(s) || this.attempts.get(s) !== attempt) return
          const status = (error as { statusCode?: unknown } | null)?.statusCode
          if (status === 404 || status === 410) {
            gone.set(s, attempt)
            this.failures.delete(s)
          } else {
            const failure =
              typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? `Push service rejected the alert (HTTP ${status}).` : 'Could not reach the push service.'
            if (this.failures.get(s) !== failure) console.warn(`Push alert failed: ${failure}`)
            this.failures.set(s, failure)
            s.fails = (s.fails ?? 0) + 1
            changed = true
          }
        }
      }),
    )
    const now = Date.now()
    const before = this.subs.length
    this.subs = this.subs.filter((s) => {
      if (gone.has(s) && gone.get(s) === this.attempts.get(s)) return false
      if ((s.fails ?? 0) >= MAX_FAILS) {
        console.warn(`Dropping push device: ${MAX_FAILS} deliveries failed in a row.`)
        this.failures.delete(s)
        return false
      }
      // a device left on screen is skipped on purpose: it sees the alerts in the app, so no delivery means nothing
      if (to.includes(s) && now - (s.lastOk ?? s.at) > STALE_MS) {
        console.warn('Dropping push device: no alert succeeded in 30 days.')
        this.failures.delete(s)
        return false
      }
      return true
    })
    if (this.subs.length !== before || changed) writeJson('push.json', this.subs)
  }
}
