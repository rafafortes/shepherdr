// space.priority, the space's own place in this machine's queue: a whole number from 1, off by default, set only at a
// space. Its row, what it refuses, where shepherdr show reads it from, and the accessor the engine orders by (settings.ts).
import { describe, expect, test } from 'bun:test'
import { Settings } from '../server/live/settings.ts'

const fresh = () => new Settings({ everywhere: {}, machine: {}, spaces: {} })

/** a value as a hand-edited settings.json could keep it: the app itself refuses one written through it, so the accessor
 *  must never read a number out of something that is not one */
const stored = (space: string, value: string) => {
  const s = fresh()
  ;(s as unknown as { d: { spaces: Record<string, Record<string, string>> } }).d.spaces[space] = { 'space.priority': value }
  return s
}
const row = (s: Settings, level: string) => s.sections([], [], null, 'host', ['web']).find((x) => x.level === level && x.name === 'Space')?.rows.find((r) => r.key === 'space.priority')

describe('a space’s priority in the queue (space.priority)', () => {
  test('its row sits in the Space section of this machine’s spaces only, off by default, with the whole-number range', () => {
    const s = fresh()
    const sections = s.sections([], [], null, 'host', ['web'])
    expect(row(s, 'p:host:web')).toMatchObject({ label: 'Priority order of this space', value: 'off', num: { min: 1, max: 200, off: true } })
    // a space's own setting: no Everywhere or machine page offers it, while the other Space rows stay on all three
    expect(row(s, 'all')).toBeUndefined()
    expect(row(s, 'm:host')).toBeUndefined()
    for (const level of ['all', 'm:host', 'p:host:web']) expect(sections.find((x) => x.level === level && x.name === 'Space')?.rows.map((r) => r.key)).toContain('space.maxTasks')
    expect(s.set('space.priority', '2', 'all').ok).toBe(false)
    expect(s.set('space.priority', '2', 'machine').ok).toBe(false)
    expect(s.set('space.priority', '2', 'all').error).toContain('--space NAME')
  })

  test('accepts off and a whole number from 1 to 200; 0, a negative, a fraction and a word name the range', () => {
    const s = fresh()
    for (const ok of ['off', '1', '6', '200', ' 6 ']) expect(s.set('space.priority', ok, { space: 'web' }).ok).toBe(true)
    for (const bad of ['0', '-1', '2.5', '201', 'lots']) {
      const r = s.set('space.priority', bad, { space: 'web' })
      expect(r.ok).toBe(false)
      expect(r.error).toContain('Write a number from 1 to 200 (whole), or off.')
    }
    // a value at one space is its own; another space keeps its own (nothing here) and is not given a default
    expect(s.set('space.priority', '6', { space: 'web' }).ok).toBe(true)
    expect(s.pick('space.priority', { space: 'web' })).toEqual({ value: '6', from: 'space' })
    expect(s.pick('space.priority', { space: 'api' })).toEqual({ value: 'off', from: 'default' })
    expect(s.spacePriority('web')).toBe(6)
    expect(s.spacePriority('api')).toBeNull()
    expect(s.set('space.priority', 'off', { space: 'web' }).ok).toBe(true)
    expect(s.spacePriority('web')).toBeNull()
    expect(s.set('space.priority', null, { space: 'web' }).ok).toBe(true)
    expect(s.pick('space.priority', { space: 'web' })).toEqual({ value: 'off', from: 'default' })
  })

  test('shepherdr show lists it at the space with where it comes from, and not at the machine', () => {
    const s = fresh()
    s.set('space.priority', '1', { space: 'web' })
    const space = s.lines('web', 'host')
    expect(space).toContain('space.priority')
    expect(space).toContain('1  (this space)')
    // show lists every key with where it comes from; at the machine it reads its default, not a space's value
    expect(s.lines(undefined, 'host')).toMatch(/space\.priority\s+off\s+\(default\)/)
    s.set('space.priority', null, { space: 'web' })
    expect(s.lines('web', 'host')).toContain('off  (default)')
  })

  test('a value no longer readable reads as off, never as a priority', () => {
    const s = new Settings({ everywhere: {}, machine: {}, spaces: { web: { 'space.priority': 'lots' } } })
    expect(s.spacePriority('web')).toBeNull()
  })

  test('only a whole number from 1 to 200 is a place: "3abc", "0", "-1", "1.5", "201" and an empty value are none', () => {
    // the parse is strict about what a hand-edited file may hold, never reading a number out of the start of a word
    for (const bad of ['3abc', '0', '-1', '1.5', '201', '999', '', '  ', '1e3', '+2', 'off']) expect(stored('web', bad).spacePriority('web')).toBeNull()
    for (const [value, n] of [['1', 1], ['6', 6], ['200', 200], ['007', 7], [' 3 ', 3]] as const) expect(stored('web', value).spacePriority('web')).toBe(n)
  })
})
