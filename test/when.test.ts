// --at / --in in plain words, in the time zone Settings sets, and how they read back (shared/when.ts).
import { describe, expect, test } from 'bun:test'
import { clockWords, instant, parseAt, parseIn, span, startsLine, startsWords, whenFrom } from '../shared/when.ts'

const ZONE = 'America/Sao_Paulo'
/** a fixed now: Friday 6 November 2026, 10:00 in Sao Paulo (UTC-3) */
const NOW = instant(new Date(Date.UTC(2026, 10, 6, 10, 0)), ZONE)
const at = (y: number, mo: number, d: number, h: number, mi = 0) => instant(new Date(Date.UTC(y, mo - 1, d, h, mi)), ZONE)

describe('a time in plain words', () => {
  test('a full date and a time of day, in the time zone Settings sets', () => {
    expect(parseAt('2026-11-07 09:00', ZONE, NOW)).toBe(at(2026, 11, 7, 9))
    expect(parseAt('2026-11-07 9:00', ZONE, NOW)).toBe(at(2026, 11, 7, 9))
    expect(parseAt('2026-11-07 at 9:00', ZONE, NOW)).toBe(at(2026, 11, 7, 9))
    expect(parseAt('2026-11-07, 21:30', ZONE, NOW)).toBe(at(2026, 11, 7, 21, 30))
    // 9:00 in Sao Paulo is three hours behind UTC
    expect(parseAt('2026-11-07 09:00', ZONE, NOW)).toBe(Date.UTC(2026, 10, 7, 12, 0))
    expect(() => parseAt('2026-11-07', ZONE, NOW)).toThrow('Give a time of day too')
    expect(() => parseAt('2026-02-30 09:00', ZONE, NOW)).toThrow('No such date')
  })

  test('a day word and a clock: tomorrow, today, tonight, the next Friday', () => {
    expect(parseAt('tomorrow 9:00', ZONE, NOW)).toBe(at(2026, 11, 7, 9))
    expect(parseAt('today 18:00', ZONE, NOW)).toBe(at(2026, 11, 6, 18))
    expect(parseAt('tonight 8pm', ZONE, NOW)).toBe(at(2026, 11, 6, 20))
    // a Friday: today's when still to come, next week's once it has passed
    expect(parseAt('fri 18:00', ZONE, NOW)).toBe(at(2026, 11, 6, 18))
    expect(parseAt('friday 8:15', ZONE, NOW)).toBe(at(2026, 11, 13, 8, 15))
    expect(parseAt('next fri 8:15', ZONE, NOW)).toBe(at(2026, 11, 13, 8, 15))
    expect(() => parseAt('today 9:00', ZONE, NOW)).toThrow('today has passed')
    expect(() => parseAt('someday 9:00', ZONE, NOW)).toThrow('Unknown day')
    expect(() => parseAt('tomorrow', ZONE, NOW)).toThrow('Give a time of day too')
  })

  test('a clock alone is today, or tomorrow once today has passed: 9am, noon, midnight', () => {
    expect(parseAt('18:00', ZONE, NOW)).toBe(at(2026, 11, 6, 18))
    expect(parseAt('9:00', ZONE, NOW)).toBe(at(2026, 11, 7, 9))
    expect(parseAt('9am', ZONE, NOW)).toBe(at(2026, 11, 7, 9))
    expect(parseAt('9:30 pm', ZONE, NOW)).toBe(at(2026, 11, 6, 21, 30))
    expect(parseAt('noon', ZONE, NOW)).toBe(at(2026, 11, 6, 12))
    expect(parseAt('midnight', ZONE, NOW)).toBe(at(2026, 11, 7, 0))
    expect(() => parseAt('9', ZONE, NOW)).toThrow('Unknown time')
    expect(() => parseAt('25:00', ZONE, NOW)).toThrow('Unknown time')
    expect(() => parseAt('', ZONE, NOW)).toThrow('Say when')
  })
})

describe('a span from now', () => {
  test('6h, 90m, 2 days, 1h 30m', () => {
    expect(parseIn('6h')).toBe(6 * 3_600_000)
    expect(parseIn('90m')).toBe(90 * 60_000)
    expect(parseIn('2 days')).toBe(2 * 86_400_000)
    expect(parseIn('6 hours')).toBe(6 * 3_600_000)
    expect(parseIn('1h 30m')).toBe(90 * 60_000)
    expect(parseIn('in 6 hours')).toBe(6 * 3_600_000)
    expect(parseIn('1h')).toBe(3_600_000)
    expect(() => parseIn('6')).toThrow('Unknown span')
    expect(() => parseIn('6x')).toThrow('Unknown span')
    expect(() => parseIn('soon')).toThrow('Unknown span')
  })
})

describe('--at and --in together', () => {
  test('one or the other, a time already passed refused, a span typed as a time read from now', () => {
    expect(whenFrom(undefined, '6h', ZONE, NOW)).toBe(NOW + 6 * 3_600_000)
    expect(whenFrom('tomorrow 9:00', undefined, ZONE, NOW)).toBe(at(2026, 11, 7, 9))
    // "6h" (or "in 2 days") in the field a time goes in is a span from now
    expect(whenFrom('6h', undefined, ZONE, NOW)).toBe(NOW + 6 * 3_600_000)
    expect(whenFrom('in 2 days', undefined, ZONE, NOW)).toBe(NOW + 2 * 86_400_000)
    expect(() => whenFrom('tomorrow 9:00', '6h', ZONE, NOW)).toThrow('not both')
    expect(() => whenFrom('today 9:00', undefined, ZONE, NOW)).toThrow('has passed')
    expect(() => whenFrom(undefined, undefined, ZONE, NOW)).toThrow('Say when')
    // a span or a date the calendar can't hold, or a typo with too many digits, is refused where it is read
    expect(() => whenFrom(undefined, '99999999999 days', ZONE, NOW)).toThrow('too far ahead')
    expect(() => whenFrom('9999-12-31 09:00', undefined, ZONE, NOW)).toThrow('too far ahead')
  })
})

describe('in words', () => {
  test('a countdown as people read it', () => {
    expect(span(45 * 60_000)).toBe('45m')
    expect(span(6 * 3_600_000)).toBe('6h')
    expect(span(90 * 60_000)).toBe('1h 30m')
    expect(span(23 * 3_600_000)).toBe('23h')
    expect(span(2 * 86_400_000)).toBe('2d')
    expect(span(30_000)).toBe('1m')
  })

  test('when it starts: Today, Tomorrow, a weekday, or a date', () => {
    expect(clockWords(at(2026, 11, 6, 18), NOW, ZONE)).toBe('Today 18:00')
    expect(clockWords(at(2026, 11, 7, 9), NOW, ZONE)).toBe('Tomorrow 9:00')
    expect(clockWords(at(2026, 11, 9, 8), NOW, ZONE)).toBe('Mon 8:00')
    // a week ahead is a date: "Fri" alone would not say which Friday
    expect(clockWords(at(2026, 11, 13, 8, 15), NOW, ZONE)).toBe('Nov 13 8:15')
    expect(clockWords(at(2026, 11, 20, 9), NOW, ZONE)).toBe('Nov 20 9:00')
    expect(startsWords(at(2026, 11, 7, 9), NOW, ZONE)).toBe('Starts Tomorrow 9:00 (in 23h)')
    expect(startsLine(at(2026, 11, 7, 9), NOW, ZONE)).toBe('Starts Tomorrow 9:00')
    expect(startsWords(NOW - 1000, NOW, ZONE)).toBe('Starts now')
  })
})
