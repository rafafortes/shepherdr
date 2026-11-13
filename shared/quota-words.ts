// A quota figure in words, for the screen (Settings → Models → Summary) and the summary's warnings (server): a window's
// share used, its count against its cap, what is left of a count with no cap, an age, and a count in thousands and
// millions. Pure, so the server's tests read the same words the screen shows.
import type { QuotaWindow } from './types.ts'

/** tokens in words: 1.2M, 340k, 980 */
export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)

/** a window's share used, in percent: its own, or its count against its cap (none for a count with no cap) */
export const shareOf = (w: QuotaWindow): number | undefined => w.usedPct ?? (w.used !== undefined && w.cap ? (w.used / w.cap) * 100 : undefined)

/** a window's usage in words: its share used, else its count against its cap, its count, or what is left of a count with no cap */
export function windowWords(w: QuotaWindow): string {
  const share = shareOf(w)
  if (share !== undefined) return `${Math.round(share)}% used`
  if (w.used !== undefined && w.cap) return `${tokens(w.used)} of ${tokens(w.cap)}`
  if (w.used !== undefined) return `${tokens(w.used)} used`
  if (w.left !== undefined) return `${tokens(w.left)} left`
  return ''
}

/** a moment as an age in words: "just now", "7 min ago", "2 h ago" */
export function ageWords(at: number, now: number): string {
  const min = Math.round((now - at) / 60_000)
  if (min < 1) return 'just now'
  return min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`
}
