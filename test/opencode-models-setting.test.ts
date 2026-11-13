// opencode.models, the Settings row of the OpenCode models the menus offer: its section and levels, what it accepts
// (refuse), and that a value at this machine or Everywhere reaches models.ts (scopeOpencode). A seeded Settings (the demo's,
// a dry run's copy) never sets the live scope.
import { describe, expect, test } from 'bun:test'
import { CATALOG, refuse, Settings } from '../server/live/settings.ts'
import { modelsOf, setModels, opencodeList } from '../server/live/models.ts'
import { writeJson } from '../server/store.ts'

const list = opencodeList([
  { id: 'opencode/minimax-m3.1-flash-free', label: 'MiniMax', efforts: [] },
  { id: 'opencode/zen-paid', label: 'Zen', efforts: [] },
  { id: 'opencode-go/longcat-2.5-free', label: 'Longcat', efforts: [] },
])
const ids = () => modelsOf('opencode')!.models.map((m) => m.id)

describe('the OpenCode models setting (opencode.models)', () => {
  test("its row sits in the OpenCode section, all by default, set Everywhere or for one machine but not a space", () => {
    const section = CATALOG.find((x) => x.name === 'OpenCode')!
    expect(section.levels).toEqual(['all', 'machine'])
    expect(section.rows).toEqual([expect.objectContaining({ key: 'opencode.models', value: 'all', text: true })])
    const s = new Settings({ everywhere: {}, machine: {}, spaces: {} })
    expect(s.pick('opencode.models')).toEqual({ value: 'all', from: 'default' })
    expect(s.set('opencode.models', '*-free', { space: 'web' }).ok).toBe(false)
  })

  test('refuses what no glob on a model id needs; accepts patterns, comma or space lists, all and empty', () => {
    for (const ok of ['*-free', 'opencode/*-free, opencode-go/longcat-*', 'a b', 'all', '', 'nvidia/z-ai/glm-5.3-flash']) expect(refuse('opencode.models', ok)).toBeUndefined()
    for (const bad of ['all, *-free', 'x:high', 'a$b', 'a(b)', '"quoted"']) expect(refuse('opencode.models', bad)).toBeDefined()
    expect(refuse('opencode.models', 'x$')).toContain('not a model pattern')
  })

  test("a value set Everywhere or for this machine scopes OpenCode's menus; unset or all lists every model again", () => {
    setModels('opencode', list)
    const s = new Settings({ everywhere: {}, machine: {}, spaces: {} })
    try {
      // a seeded world never sets the live scope
      expect(ids().length).toBe(3)
      const live = new Settings()
      live.set('opencode.models', '*-free', 'all')
      expect(ids()).toEqual(['opencode/minimax-m3.1-flash-free', 'opencode-go/longcat-2.5-free'])
      // this machine's own value wins over Everywhere's
      expect(live.set('opencode.models', 'opencode/*', 'machine').ok).toBe(true)
      expect(ids()).toEqual(['opencode/minimax-m3.1-flash-free', 'opencode/zen-paid'])
      expect(live.set('opencode.models', null, 'machine').ok).toBe(true)
      expect(ids()).toEqual(['opencode/minimax-m3.1-flash-free', 'opencode-go/longcat-2.5-free'])
      expect(live.set('opencode.models', 'all', 'all').ok).toBe(true)
      expect(ids().length).toBe(3)
      // a seeded world's value is its own
      expect(s.set('opencode.models', '*-free', 'all').ok).toBe(true)
      expect(ids().length).toBe(3)
    } finally {
      setModels('opencode', undefined)
    }
  })

  test('the value of a file reaches the scope when Settings loads (also the old one-level file), and when another machine adopts Everywhere', () => {
    setModels('opencode', list)
    try {
      writeJson('settings.json', { everywhere: { 'opencode.models': '*-free' } })
      expect(new Settings().get('opencode.models')).toBe('*-free')
      expect(ids()).toEqual(['opencode/minimax-m3.1-flash-free', 'opencode-go/longcat-2.5-free'])
      writeJson('settings.json', { all: { 'opencode.models': 'opencode/*' } })
      new Settings()
      expect(ids()).toEqual(['opencode/minimax-m3.1-flash-free', 'opencode/zen-paid'])
      const worker = new Settings()
      expect(worker.adopt({ 'opencode.models': 'opencode-go/*' })).toBe(true)
      expect(ids()).toEqual(['opencode-go/longcat-2.5-free'])
    } finally {
      setModels('opencode', undefined)
      writeJson('settings.json', {})
    }
  })
})
