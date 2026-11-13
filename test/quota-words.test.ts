// A quota figure in words (shared/quota-words.ts), the same words the screen and the summary's warnings show: a window's
// share, its count against a cap, what is left of a count with none, an age, and a count in thousands and millions.
import { describe, expect, test } from 'bun:test'
import { ageWords, shareOf, tokens, windowWords } from '../shared/quota-words.ts'

describe('a window in words', () => {
  test('its share used, the share of its count against its cap, or a cap of none: no share', () => {
    expect(shareOf({ name: '5 h', usedPct: 62 })).toBe(62)
    expect(shareOf({ name: 'Team', used: 30, cap: 120 })).toBe(25)
    expect(shareOf({ name: 'Team', used: 3, cap: 0 })).toBeUndefined()
    expect(shareOf({ name: 'Credits', left: 9 })).toBeUndefined()
  })

  test('the share in words first; then a count against its cap, a count alone, and what is left of a count with no cap', () => {
    expect(windowWords({ name: '5 h', usedPct: 62.4 })).toBe('62% used')
    expect(windowWords({ name: 'Team', used: 30_000, cap: 120_000 })).toBe('25% used')
    expect(windowWords({ name: 'Team', used: 3, cap: 0 })).toBe('3 used')
    expect(windowWords({ name: 'Team', used: 1_200_000, cap: 0 })).toBe('1.2M used')
    expect(windowWords({ name: 'Team', used: 90, cap: 0 })).toBe('90 used')
    expect(windowWords({ name: 'Credits', left: 125_000 })).toBe('125k left')
    expect(windowWords({ name: 'Nothing' })).toBe('')
  })

  test('a count in thousands and millions, and a count under a thousand as it is', () => {
    expect(tokens(980)).toBe('980')
    expect(tokens(340_400)).toBe('340k')
    expect(tokens(1_249_999)).toBe('1.2M')
  })
})

describe('an age in words', () => {
  const now = Date.UTC(2026, 10, 13, 9)
  test('just now under a minute, then minutes, then hours', () => {
    expect(ageWords(now - 20_000, now)).toBe('just now')
    expect(ageWords(now - 7 * 60_000, now)).toBe('7 min ago')
    expect(ageWords(now - 150 * 60_000, now)).toBe('3 h ago')
  })
})
