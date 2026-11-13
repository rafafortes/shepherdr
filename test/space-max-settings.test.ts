// space.maxTasks, the Settings row of a space's own cap on the tasks working at once: its levels, what it accepts, and
// which level wins (settings.ts). A new Settings on a seed keeps no file, so nothing here touches the human's.
import { describe, expect, test } from 'bun:test'
import { Settings } from '../server/live/settings.ts'

const fresh = () => new Settings({ everywhere: {}, machine: {}, spaces: {} })

describe('the space limit on tasks working at once (space.maxTasks)', () => {
  test('its row sits in its own Space section, settable at all three levels, off by default', () => {
    const s = fresh()
    const row = (level: string) => {
      const section = s.sections([], [], null, 'host', ['web']).find((x) => x.level === level && x.name === 'Space')
      return section?.rows.find((r) => r.key === 'space.maxTasks')
    }
    // the Everywhere, machine and space pages all show it
    for (const level of ['all', 'm:host', 'p:host:web']) expect(row(level)).toMatchObject({ label: 'Max tasks of this space working at once', value: 'off' })
    expect(row('p:host:web')).toMatchObject({ value: 'off', num: { min: 0, max: 200, off: true, limit: true } })
    // the machine's own limit stays Everywhere and machine only: a space limit is a space's
    expect(s.sections([], [], null, 'host', ['web']).find((x) => x.level === 'p:host:web' && x.name === 'Machine')).toBeUndefined()
    expect(s.set('machine.maxTasks', '3', { space: 'web' }).ok).toBe(false)
  })

  test('accepts off, 0 (none starts) or a whole number from 1 to 200, and refuses the rest', () => {
    const s = fresh()
    for (const ok of ['off', '0', '1', '6', '200', ' 6 ']) expect(s.set('space.maxTasks', ok, { space: 'web' }).ok).toBe(true)
    for (const bad of ['201', '2.5', 'lots', '-1']) expect(s.set('space.maxTasks', bad, { space: 'web' }).ok).toBe(false)
    expect(s.set('space.maxTasks', '6', { space: 'web' }).ok).toBe(true)
    expect(s.pick('space.maxTasks', { space: 'web' })).toEqual({ value: '6', from: 'space' })
    expect(s.set('space.maxTasks', null, { space: 'web' }).ok).toBe(true)
    expect(s.pick('space.maxTasks', { space: 'web' })).toEqual({ value: 'off', from: 'default' })
  })

  test("the most specific level that sets it wins: a space's own, else its machine's, else Everywhere's, else none", () => {
    const s = fresh()
    expect(s.spaceMax('web')).toBeNull()
    expect(s.set('space.maxTasks', '4', 'all').ok).toBe(true)
    expect([s.spaceMax('web'), s.spaceMax('api')]).toEqual([4, 4])
    expect(s.set('space.maxTasks', '3', 'machine').ok).toBe(true)
    expect([s.spaceMax('web'), s.spaceMax('api')]).toEqual([3, 3])
    expect(s.set('space.maxTasks', '2', { space: 'web' }).ok).toBe(true)
    expect([s.spaceMax('web'), s.spaceMax('api')]).toEqual([2, 3])
    expect(s.get('space.maxTasks', 'api')).toBe('3')
    // off at the space's own level is no cap there, whatever the levels above say
    expect(s.set('space.maxTasks', 'off', { space: 'web' }).ok).toBe(true)
    expect([s.spaceMax('web'), s.spaceMax('api')]).toEqual([null, 3])
    // the levels above are read as they are: off at Everywhere and at the machine, no cap for any space
    s.set('space.maxTasks', 'off', 'machine')
    s.set('space.maxTasks', 'off', 'all')
    expect([s.spaceMax('web'), s.spaceMax('api')]).toEqual([null, null])
  })

  test('the Settings row shows where its value comes from and what a reset goes back to', () => {
    const s = fresh()
    s.set('space.maxTasks', '4', 'all')
    s.set('space.maxTasks', '2', { space: 'web' })
    const row = (level: string) => s.sections([], [], null, 'host', ['web', 'api']).find((x) => x.level === level && x.name === 'Space')!.rows.find((r) => r.key === 'space.maxTasks')!
    expect(row('p:host:web')).toMatchObject({ value: '2', inherits: { value: '4', from: 'Everywhere' } })
    expect(row('p:host:api')).toMatchObject({ value: '4', from: 'Everywhere' })
  })
})

describe('a task count that cannot be read: the row’s default, never a silent 0', () => {
  test('an unreadable space.maxTasks reads as off (no cap), and an unreadable machine.maxTasks as its default of 10', () => {
    const s = new Settings({ everywhere: {}, machine: { 'space.maxTasks': 'lots', 'machine.maxTasks': 'lots' }, spaces: {} })
    expect(s.spaceMax('web')).toBeNull()
    expect(s.machine().max).toBe(10)
  })
})
