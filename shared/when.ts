// When a scheduled task starts, in plain words: `task add --at "tomorrow 9:00"` (a date, a day word, a clock, noon,
// midnight...) or `--in "6h"` / "1h 30m" / "2 days", one or the other, and how people read them back: "Starts Fri 9:00
// (in 6h)", "in 45m". Times are wall-clock times in the zone Settings sets (time.zone, Everywhere); a time already
// passed is refused. Nothing here reads a clock of its own: `now` comes in, so what it says can be tested.
const AT_HOW =
  'Write a time like "2026-11-06 09:00", "tomorrow 9:00", "fri 8:15", "today 18:00" or "18:00" (in the time zone Settings sets).'
const IN_HOW = 'Write a span like "6h", "90m", "2 days", "6 hours" or "1h 30m".'
const UNITS: Record<string, number> = {
  m: 1, min: 1, mins: 1, minute: 1, minutes: 1,
  h: 60, hr: 60, hrs: 60, hour: 60, hours: 60,
  d: 1440, day: 1440, days: 1440,
  w: 10080, wk: 10080, week: 10080, weeks: 10080,
}
const DAY = 86_400_000
const MINUTE = 60_000
const pad = (n: number) => String(n).padStart(2, '0')
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** an instant as the wall clock in a zone shows it, as a Date whose UTC fields are that wall clock */
export function wall(at: number, zone: string): Date {
  const f = formatter(zone)
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)]))
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second))
}

// one formatter per zone: a task waiting for a time reads its zone on every snapshot
const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(zone: string) {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formatters.set(zone, f)
  }
  return f
}

/** the instant a wall-clock time (a Date's UTC fields) is in a zone; a time the clocks skip is the one an hour later */
export function instant(w: Date, zone: string): number {
  const guess = w.getTime()
  const off = wall(guess, zone).getTime() - guess
  let at = guess - off
  const off2 = wall(at, zone).getTime() - at
  if (off2 !== off) at = guess - off2
  return at
}

/** a clock time in words: "9:00", "18.30", "9am", "9:30 pm", "noon", "midnight" */
export function parseClock(text: string): { h: number; m: number } {
  const t = text.trim().toLowerCase()
  const how = `Unknown time "${text.trim()}". ${AT_HOW}`
  if (t === 'noon' || t === 'midday') return { h: 12, m: 0 }
  if (t === 'midnight') return { h: 0, m: 0 }
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(t)
  // a bare number is no clock time: 9 could be anything, "9:00" says it
  if (!m || (m[2] === undefined && m[3] === undefined)) throw new Error(how)
  let h = Number(m[1])
  const mi = Number(m[2] ?? 0)
  const ap = (m[3] ?? '').replace(/\./g, '')
  if (ap) {
    if (h < 1 || h > 12) throw new Error(how)
    h = (h % 12) + (ap === 'pm' ? 12 : 0)
  }
  if (h > 23 || mi > 59) throw new Error(how)
  return { h, m: mi }
}

/** days ahead of today for a day word ("today" 0, "tomorrow" 1, "fri" the next Friday's, today's when it is Friday),
 *  or undefined for a word that isn't a day */
export function dayOf(word: string, weekday: number): number | undefined {
  const w = word.trim().toLowerCase().replace(/^(next|this) /, '')
  if (w === 'today' || w === 'tonight') return 0
  if (w === 'tomorrow' || w === 'tmrw' || w === 'tmr') return 1
  const i = DAYS.findIndex((n) => (w.length >= 2 && n.startsWith(w)) || w === n.slice(0, 3) || w === `${n.slice(0, 3)}s` || w === n.slice(0, 4))
  return i < 0 ? undefined : (i - weekday + 7) % 7
}

/**
 * A moment from plain words, strictly (anything else is refused with how to write one), in a zone: "2026-11-06 09:00",
 * "tomorrow 9:00", "fri 8:15" (the next Friday, today if still to come), "today 18:00", "18:00" (today, else
 * tomorrow). A full date may be in the past; a day word may not.
 */
export function parseAt(text: string, zone: string, now = Date.now()): number {
  const t = (text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/(^| )at (?=\d|noon|midnight)/g, '$1')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) throw new Error(`Say when. ${AT_HOW}`)
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](.+))?$/.exec(t)
  if (full) {
    const y = Number(full[1])
    const mo = Number(full[2])
    const d = Number(full[3])
    if (!full[4]) throw new Error(`Give a time of day too, like "${full[1]}-${pad(mo)}-${pad(d)} 09:00".`)
    const { h, m } = parseClock(full[4])
    const day = new Date(Date.UTC(y, mo - 1, d))
    if (day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) throw new Error(`No such date: ${text.trim()}`)
    return instant(new Date(Date.UTC(y, mo - 1, d, h, m)), zone)
  }
  const m = /^(?:((?:next |this )?[a-z]+) )?(.+)$/.exec(t)!
  const dayWord = m[1]
  const clock = m[2]
  const w = wall(now, zone)
  const weekday = (w.getUTCDay() + 6) % 7
  if (!dayWord && dayOf(t, weekday) !== undefined) throw new Error(`Give a time of day too, like "${t} 9:00". ${AT_HOW}`)
  const ahead = dayWord ? dayOf(dayWord, weekday) : undefined
  if (dayWord && ahead === undefined) throw new Error(`Unknown day "${dayWord}". ${AT_HOW}`)
  const { h, m: mi } = parseClock(clock)
  const base = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() + (ahead ?? 0), h, mi)
  const at = instant(new Date(base), zone)
  if (dayWord === 'today' || dayWord === 'tonight') {
    if (at <= now) throw new Error(`${clock} today has passed. ${AT_HOW}`)
    return at
  }
  if (dayWord) return at > now ? at : instant(new Date(base + 7 * DAY), zone)
  return at > now ? at : instant(new Date(base + DAY), zone)
}

/** a span from now in plain words, strictly: "6h", "90m", "2 days", "6 hours", "1h 30m", "in 6 hours" */
export function parseIn(text: string): number {
  const t = (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/^in /, '').replace(/ and /g, ' ').replace(/,/g, ' ').trim()
  if (!t) throw new Error(`Say how long from now. ${IN_HOW}`)
  let total = 0
  let pos = 0
  const re = /\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*/g
  for (let m = re.exec(t); m; m = re.exec(t)) {
    if (m.index !== pos || !(m[2] in UNITS)) throw new Error(`Unknown span "${text.trim()}". ${IN_HOW}`)
    total += Number(m[1]) * UNITS[m[2]]
    pos = m.index + m[0].length
  }
  if (pos !== t.length || total <= 0) throw new Error(`Unknown span "${text.trim()}". ${IN_HOW}`)
  return Math.round(total * MINUTE)
}

/** --at / --in to a moment (ms), in a zone: both at once and a moment already passed are refused. A span typed where a
 *  time goes ("6h", "in 2 days") is read as from now. */
export function whenFrom(at: string | undefined, within: string | undefined, zone: string, now = Date.now()): number {
  if (at !== undefined && within !== undefined) throw new Error('Give --at or --in, not both.')
  if (within !== undefined) return now + parseIn(within)
  if (at === undefined) throw new Error(`Say when. ${AT_HOW}`)
  let ms: number
  try {
    ms = parseAt(at, zone, now)
  } catch (e) {
    try {
      return now + parseIn(at)
    } catch {
      throw new Error(`${(e as Error).message} Or a span from now, like "6h" or "in 2 days".`)
    }
  }
  if (ms <= now) throw new Error(`${at.trim()} has passed. ${AT_HOW}`)
  return ms
}

/** a span as people read a countdown: "45m", "6h", "6h 30m", "2d" */
export function span(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / MINUTE))
  if (m < 60) return `${Math.max(1, m)}m`
  if (m < 1440) {
    const h = Math.floor(m / 60)
    const r = m % 60
    return `${h}h${r && h < 10 ? ` ${r}m` : ''}`
  }
  return `${Math.round(m / 1440)}d`
}

/** a moment as people read it from today: "Today 18:00", "Tomorrow 9:00", "Fri 9:00", "Nov 20 9:00" */
export function clockWords(at: number, now: number, zone: string): string {
  const d = wall(at, zone)
  const n = wall(now, zone)
  const hm = `${d.getUTCHours()}:${pad(d.getUTCMinutes())}`
  const days = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())) / DAY)
  if (days === 0) return `Today ${hm}`
  if (days === 1) return `Tomorrow ${hm}`
  if (days > 1 && days < 7) return `${WEEK[d.getUTCDay()]} ${hm}`
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${hm}`
}

/** "Starts Tomorrow 9:00 (in 6h)", or "Starts now" once its time has come */
export function startsWords(at: number, now: number, zone: string): string {
  return at <= now ? 'Starts now' : `Starts ${clockWords(at, now, zone)} (in ${span(at - now)})`
}

/** "Starts Tomorrow 9:00": a list row's line, its countdown counted by the screen as it passes */
export function startsLine(at: number, now: number, zone: string): string {
  return at <= now ? 'Starts now' : `Starts ${clockWords(at, now, zone)}`
}
