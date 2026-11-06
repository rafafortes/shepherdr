// The human's pinned and recent models: the order a model list shows them in, the file they are kept in, and what the
// restart sheet and Settings list offer.
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { NO_PICKS, orderByPicks, parsePicks, pickKey, picksIn, RECENT, withPin, withRecent } from '../shared/picks.ts'
import { home, readJson, writeJson } from '../server/store.ts'
import { PICKS_FILE, picksOf, pinModel, rememberModel, setPicks } from '../server/live/model-picks.ts'
import { setModels } from '../server/live/models.ts'
import { restartClis } from '../server/live/restart.ts'
import { agentRow, Settings } from '../server/live/settings.ts'

const PI = { models: ['alpha/one', 'alpha/two', 'beta/three', 'beta/four', 'gamma/five', 'delta/six', 'epsilon/seven', 'zeta/eight', 'eta/nine', 'theta/ten'].map((id) => ({ id, label: id, efforts: ['low', 'high'] })), efforts: ['off', 'low', 'high'] }
/** nothing pinned or picked, in the file and the memory of it */
const clear = () => {
  writeJson(PICKS_FILE, NO_PICKS, home())
  setPicks(NO_PICKS)
}

describe('the picks in a model list', () => {
  test('junk is dropped, recent picks are capped and each key is kept once', () => {
    expect(parsePicks(undefined)).toEqual(NO_PICKS)
    expect(parsePicks({ pinned: ['pi:a', 'nonsense', 3], recent: ['pi:b', 'pi:b'] })).toEqual({ pinned: ['pi:a'], recent: ['pi:b'] })
    const many = Array.from({ length: RECENT + 3 }, (_, i) => `claude:m${i}`)
    expect(parsePicks({ recent: many }).recent).toHaveLength(RECENT)
  })

  test('a pin says the state it wants, a pick goes first among the recent ones and stays once', () => {
    const pin = withPin(NO_PICKS, 'pi:alpha/one', true)
    expect(pin.pinned).toEqual(['pi:alpha/one'])
    // the same again changes nothing, however often it is replayed
    expect(withPin(pin, 'pi:alpha/one', true).pinned).toEqual(['pi:alpha/one'])
    expect(withPin(pin, 'pi:alpha/one', false).pinned).toEqual([])
    let p = withRecent(NO_PICKS, 'pi:alpha/one')
    p = withRecent(p, 'pi:beta/three')
    p = withRecent(p, 'pi:alpha/one')
    expect(p.recent).toEqual(['pi:alpha/one', 'pi:beta/three'])
    expect(picksIn(p, 'pi')).toEqual({ pinned: [], recent: ['alpha/one', 'beta/three'] })
    expect(picksIn(p, 'claude')).toEqual({ pinned: [], recent: [] })
  })

  test('each CLI keeps its own recent picks', () => {
    let p = NO_PICKS
    for (const id of ['a/1', 'a/2', 'a/3', 'a/4', 'a/5']) p = withRecent(p, pickKey('pi', id))
    p = withRecent(withRecent(p, pickKey('claude', 'm1')), pickKey('claude', 'm2'))
    expect(picksIn(p, 'pi').recent).toEqual(['a/5', 'a/4', 'a/3', 'a/2', 'a/1'])
    expect(picksIn(p, 'claude').recent).toEqual(['m2', 'm1'])
  })

  test('pinned first in their pin order, then the recent ones, then the CLI’s own order', () => {
    const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]
    expect(orderByPicks(models, { pinned: ['d', 'a'], recent: ['e', 'c'] }).map((m) => m.id)).toEqual(['d', 'a', 'e', 'c', 'b'])
    expect(orderByPicks(models, NO_PICKS).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('where the picks are kept', () => {
  test('a file of their own in Shepherdr’s folder, read back after a pin and a pick', () => {
    clear()
    expect(picksOf('pi')).toEqual({ pinned: [], recent: [] })
    pinModel('pi', 'alpha/one', true)
    rememberModel('pi', 'beta/four')
    rememberModel('pi', 'default')
    expect(existsSync(join(home(), PICKS_FILE))).toBe(true)
    expect(readJson(PICKS_FILE, {}, home())).toEqual({ pinned: [pickKey('pi', 'alpha/one')], recent: [pickKey('pi', 'beta/four')] })
    expect(picksOf('pi')).toEqual({ pinned: ['alpha/one'], recent: ['beta/four'] })
    pinModel('pi', 'alpha/one', false)
    expect(picksOf('pi').pinned).toEqual([])
    clear()
  })
})

describe('what a model list offers', () => {
  test('the restart sheet: every model the CLI reports, pinned first, then the recent ones, marked for the screen', () => {
    clear()
    setModels('pi', PI)
    try {
      pinModel('pi', 'beta/three', true)
      rememberModel('pi', 'gamma/five')
      const pi = restartClis(['pi']).find((c) => c.kind === 'pi')!
      expect(pi.models!.map((m) => m.id)).toEqual(['beta/three', 'gamma/five', 'alpha/one', 'alpha/two', 'beta/four', 'delta/six', 'epsilon/seven', 'zeta/eight', 'eta/nine', 'theta/ten'])
      expect(pi.pinned).toEqual(['beta/three'])
      expect(pi.recent).toEqual(['gamma/five'])
    } finally {
      setModels('pi', undefined)
      clear()
    }
  })

  test('an older model a CLI still takes by id stays on offer while it is pinned', () => {
    clear()
    // Claude Code's catalog keeps the newest of each family in the list, the rest as older, still-taken ids
    const older = { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: ['low', 'high'] }
    setModels('claude', { models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'high'], effort: 'medium' }], others: [older], efforts: ['low', 'high'], default: 'claude-opus-5-5' })
    try {
      pinModel('claude', older.id, true)
      const claude = restartClis(['claude']).find((c) => c.kind === 'claude')!
      expect(claude.models!.at(0)).toMatchObject({ id: older.id, label: 'Haiku 4.5' })
      expect(claude.pinned).toEqual([older.id])
      // Settings' rows offer it too, so a pinned model is never missing from one list and present in the other
      const get = (key: string) => (key === 'task.agent' ? 'claude' : 'default')
      expect(agentRow({ label: 'Model', key: 'task.model', value: 'default' }, get).options).toContain('Haiku 4.5')
      setPicks(NO_PICKS)
      const plain = restartClis(['claude']).find((c) => c.kind === 'claude')!
      expect(plain.models!.some((m) => m.id === older.id)).toBe(false)
    } finally {
      setModels('claude', undefined)
      clear()
    }
  })

  test('a model chosen in Settings is one of the picks from then on', () => {
    clear()
    const s = new Settings()
    s.set('task.model', 'Opus 5.5')
    expect(picksOf('claude')).toEqual({ pinned: [], recent: ['claude-opus-5-5'] })
    // its own default is no pick at all
    s.set('task.model', 'default')
    expect(picksOf('claude').recent).toEqual(['claude-opus-5-5'])
    s.set('task.model', null)
    clear()
  })

  test('a model a CLI stops reporting keeps its pin in the file, out of the list until it is reported again', () => {
    clear()
    setModels('pi', PI)
    try {
      pinModel('pi', 'zeta/eight', true)
      const fewer = { ...PI, models: PI.models.filter((m) => m.id !== 'zeta/eight') }
      setModels('pi', fewer)
      const pi = restartClis(['pi']).find((c) => c.kind === 'pi')!
      expect(pi.models!.some((m) => m.id === 'zeta/eight')).toBe(false)
      expect(pi.pinned).toEqual([])
      expect(picksOf('pi').pinned).toEqual(['zeta/eight'])
      // its provider reports it again: the pin is back
      setModels('pi', PI)
      expect(restartClis(['pi']).find((c) => c.kind === 'pi')!.pinned).toEqual(['zeta/eight'])
    } finally {
      setModels('pi', undefined)
      clear()
    }
  })

  test('a seeded world (the demo’s) neither reads this machine’s picks nor writes them', () => {
    clear()
    const machine = new Settings()
    machine.set('task.model', 'Opus 5.5')
    expect(picksOf('claude').recent).toEqual(['claude-opus-5-5'])
    // a demo's Settings is its own world: its picks stay in memory, so this machine's file is untouched
    const demo = new Settings({ everywhere: {}, machine: {}, spaces: {} })
    demo.set('task.model', 'Sonnet 5.5')
    expect(picksOf('claude').recent).toEqual(['claude-opus-5-5'])
    machine.set('task.model', null)
    clear()
  })

  test('Settings’ model rows hold Default first, then the pinned models, then the recent ones', () => {
    clear()
    setModels('pi', PI)
    try {
      pinModel('pi', 'beta/three', true)
      rememberModel('pi', 'gamma/five')
      const get = (key: string) => (key === 'task.agent' ? 'pi' : 'default')
      const row = agentRow({ label: 'Model', key: 'task.model', value: 'default' }, get)
      expect(row.options!.slice(0, 3)).toEqual(['default', 'beta/three', 'gamma/five'])
      expect(row.options).toHaveLength(PI.models.length + 1)
      // in their own order, and each found by its id as well as its name
      expect(row.ordered).toBe(true)
      expect(row.ids!['gamma/five']).toBe('gamma/five')
    } finally {
      setModels('pi', undefined)
      clear()
    }
  })
})
