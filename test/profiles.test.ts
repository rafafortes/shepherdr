// Settings → Models → profiles, the module's side: a profile saves the models (and the limits, when it holds them) at every
// level of this machine, applies the difference all or nothing, keeps undo points, and says what it does in words.
import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agoWords, changeWords, cleanName, keysOf, LIMIT_KEYS, MODEL_KEYS, nameProblem, Profiles, ProfileStore, previewWords, planOf, UNDO_KEEP, waitingPicks, type Change, type Site } from '../server/live/profiles.ts'
import { Settings, type Level } from '../server/live/settings.ts'
import { home } from '../server/store.ts'

const HOST = 'box'
const SPACES = [
  { key: 'gtm', name: 'gtm' },
  { key: 'docs', name: 'Docs site' },
  { key: '~', name: 'home' },
]
type Seed = Partial<{ everywhere: Record<string, string>; machine: Record<string, string>; spaces: Record<string, Record<string, string>> }>

/** a world of its own: this machine's settings (kept in memory), a profile store in memory, and what the writes changed */
function world(seed: Seed = {}, spaces = SPACES) {
  const s = new Settings({ everywhere: {}, machine: {}, spaces: {}, ...seed })
  const store = new ProfileStore(true)
  const written: Change[][] = []
  const site = (): Site => ({ settings: s, machine: { host: HOST, name: 'box' }, spaces })
  const p = new Profiles(store, site, (c) => written.push(c))
  return { s, store, written, site, p }
}
/** a key as one level reads it, its own value only */
const own = (s: Settings, key: string, at: Level) => {
  const pick = s.pick(key, at)
  const kind = at === 'all' ? 'all' : at === 'machine' ? 'machine' : 'space'
  return pick.from === kind ? pick.value : null
}

describe('a profile: what it keeps, at every level', () => {
  test('the models of every role, backups included, at each level: null where the level sets nothing', () => {
    const w = world({ everywhere: { 'task.agent': 'pi', 'task.model': 'opencode-go/deepseek-v4.1-flash' }, machine: { 'task.effort': 'high' }, spaces: { gtm: { 'task.agent': 'Codex' } } })
    const r = w.p.save('day')
    expect(r).toMatchObject({ ok: true, profile: { name: 'day', limits: false } })
    const v = r.profile!.values
    expect(Object.keys(v.all)).toEqual(MODEL_KEYS)
    // 4 roles, 6 slots each, 3 keys a slot
    expect(MODEL_KEYS.length).toBe(72)
    expect(v.all['task.agent']).toBe('pi')
    expect(v.all['task.effort']).toBeNull()
    expect(v.machine['task.agent']).toBeNull()
    expect(v.machine['task.effort']).toBe('high')
    expect(v.spaces.gtm!['task.agent']).toBe('Codex')
    expect(v.spaces.docs!['task.agent']).toBeNull()
    expect(v.spaces['~']!['task.effort']).toBeNull()
    expect(r.profile!.names).toEqual({ gtm: 'gtm', docs: 'Docs site', '~': 'home' })
    // the limits are not in a profile without them
    expect(Object.keys(v.all)).not.toContain('space.maxTasks')
    expect(keysOf(false)).toEqual(MODEL_KEYS)
    expect(keysOf(true)).toEqual([...MODEL_KEYS, ...LIMIT_KEYS])
  })

  test('limits are kept with the models when asked, and only then', () => {
    const w = world({ everywhere: { 'merge.train': '3' }, spaces: { gtm: { 'space.maxTasks': '4' } } })
    const lim = w.p.save('lim', { limits: true }).profile!
    expect(lim.limits).toBe(true)
    expect(lim.values.all['merge.train']).toBe('3')
    expect(lim.values.spaces.gtm!['space.maxTasks']).toBe('4')
    expect(lim.values.spaces.docs!['space.maxTasks']).toBeNull()
    const models = w.p.save('models').profile!
    expect(models.values.all).not.toHaveProperty('merge.train')
  })

  test('the limits a profile holds include the most at once per model, this machine’s or Everywhere’s, and never a space’s', () => {
    expect(LIMIT_KEYS).toContain('models.maxAtOnce')
    const w = world({ everywhere: { 'models.maxAtOnce': 'spark=4' }, machine: { 'models.maxAtOnce': 'radeon=1' } })
    const lim = w.p.save('lim', { limits: true }).profile!
    expect(lim.values.all['models.maxAtOnce']).toBe('spark=4')
    expect(lim.values.machine['models.maxAtOnce']).toBe('radeon=1')
    expect(lim.values.spaces.gtm!['models.maxAtOnce']).toBeNull()
    // the models alone hold none of it
    expect(w.p.save('models').profile!.values.machine).not.toHaveProperty('models.maxAtOnce')
    // applied, the value comes back as saved
    w.s.set('models.maxAtOnce', 'off', 'machine')
    const plan = planOf(w.site(), lim)
    expect(plan.changes).toContainEqual(expect.objectContaining({ key: 'models.maxAtOnce', at: 'machine', now: 'off', then: 'radeon=1' }))
  })

  test('a profile saved while Settings reads an inherited value keeps the inheritance, not a copy of it', () => {
    const w = world({ everywhere: { 'task.agent': 'pi' } })
    const v = w.p.save('inherit').profile!.values
    // the space and this machine read Everywhere's pi, but they set nothing of their own
    expect(v.machine['task.agent']).toBeNull()
    expect(v.spaces.gtm!['task.agent']).toBeNull()
  })
})

describe('apply: the difference, all of it or nothing, and what restores exactly', () => {
  test('a round trip at all levels: after changes everywhere, apply writes back exactly what was saved, nulls included', () => {
    const w = world({ everywhere: { 'task.agent': 'pi', 'task.model': 'opencode-go/deepseek-v4.1-flash', 'task.effort': 'high' }, machine: { 'task.effort': 'low' }, spaces: { gtm: { 'task.agent': 'Codex', 'space.maxTasks': '4' } } })
    w.p.save('night', { limits: true })
    const saved = structuredClone(w.store.f.profiles[0]!.values)
    // day changes: everything moves, a space sets what it did not, another drops what it had
    w.s.set('task.agent', 'Claude Code', 'all')
    w.s.set('task.effort', null, 'machine')
    w.s.set('task.agent', 'pi', { space: 'gtm' })
    w.s.set('task.agent', 'Codex', { space: 'docs' })
    w.s.set('space.maxTasks', null, { space: 'gtm' })
    const before = w.p.preview('night')
    expect(before.ok).toBe(true)
    expect(before.changes.map((c) => `${c.where}|${c.label}|${c.now ?? 'not set'}->${c.then ?? 'not set'}`)).toEqual([
      'Everywhere|Tasks · Primary · Agent|Claude Code->pi',
      'box|Tasks · Primary · Effort|not set->low',
      'gtm|Tasks · Primary · Agent|pi->Codex',
      'gtm|Max tasks|not set->4',
      'Docs site|Tasks · Primary · Agent|Codex->not set',
    ])
    const r = w.p.apply('night')
    expect(r).toMatchObject({ ok: true, name: 'night', refused: [], skipped: [], added: [] })
    expect(r.changes.length).toBe(before.changes.length)
    // the same values as saved, at every level and every key of the profile
    const now = w.p.preview('night')
    expect(now.changes).toEqual([])
    for (const k of MODEL_KEYS) {
      expect(own(w.s, k, 'all')).toBe(saved.all[k]!)
      expect(own(w.s, k, 'machine')).toBe(saved.machine[k]!)
      expect(own(w.s, k, { space: 'gtm' })).toBe(saved.spaces.gtm![k]!)
      expect(own(w.s, k, { space: 'docs' })).toBe(saved.spaces.docs![k]!)
    }
    expect(own(w.s, 'space.maxTasks', { space: 'gtm' })).toBe('4')
    // what it wrote is handed back with its levels, for the waiting tasks
    expect(w.written.at(-1)!.length).toBe(before.changes.length)
  })

  test('the changes come in order: a key after its CLI, at the level they are set', () => {
    const w = world()
    w.p.save('empty')
    expect(w.s.set('task.agent', 'pi', 'all')).toEqual({ ok: true })
    expect(w.s.set('task.model', 'opencode-go/deepseek-v4.1-flash', 'all')).toEqual({ ok: true })
    expect(w.p.preview('empty').changes.map((c) => c.key)).toEqual(['task.agent', 'task.model'])
    expect(w.p.preview('empty').changes.map((c) => c.place)).toEqual(['all', 'all'])
  })

  test('apply refuses as a whole: a refused setting stops every write, and nothing changes', () => {
    const w = world({ everywhere: { 'task.agent': 'pi' } })
    w.p.save('bad')
    w.s.set('task.agent', 'Claude Code', 'all')
    w.s.set('task.effort', 'high', 'all')
    // a value no setting takes (a model id with a "!"): the profile is broken, the apply says so
    w.store.f.profiles[0]!.values.all['task.model'] = 'bad!'
    w.store.f.profiles[0]!.values.machine['task.model'] = 'bad?'
    const preview = w.p.preview('bad')
    expect(preview.changes.length).toBeGreaterThan(0)
    expect(preview.refused.map((x) => [x.where, x.key])).toEqual([
      ['Everywhere', 'task.model'],
      ['box', 'task.model'],
    ])
    const r = w.p.apply('bad')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Nothing was applied: 2 settings would be refused.')
    expect(r.refused.length).toBe(2)
    expect(r.changes).toEqual([])
    // the agent that would have changed still reads Claude Code, nothing undone or kept
    expect(own(w.s, 'task.agent', 'all')).toBe('Claude Code')
    expect(own(w.s, 'task.effort', 'all')).toBe('high')
    expect(w.store.f.undo).toEqual([])
    expect(w.store.f.last).toBeUndefined()
    expect(w.written).toEqual([])
  })

  test('a refused setting with one refusal says it in the singular', () => {
    const w = world({ everywhere: { 'task.agent': 'pi' } })
    w.p.save('one')
    w.store.f.profiles[0]!.values.all['task.model'] = 'bad!'
    expect(w.p.apply('one').error).toBe('Nothing was applied: 1 setting would be refused.')
  })

  test('a space added since the save is left as it is; a space removed is skipped, by the name it had', () => {
    const w = world({ spaces: { gtm: { 'task.agent': 'pi' } } })
    w.p.save('then')
    // now: gtm, a new space news, home; docs (saved) is gone
    const now: Site = { settings: w.s, machine: { host: HOST, name: 'box' }, spaces: [{ key: 'gtm', name: 'gtm' }, { key: 'news', name: 'news' }, { key: '~', name: 'home' }] }
    const p = new Profiles(w.store, () => now, () => undefined)
    w.s.set('task.agent', 'Codex', { space: 'news' })
    w.s.set('task.agent', 'Claude Code', { space: 'gtm' })
    const pre = p.preview('then')
    expect(pre.added).toEqual(['news'])
    expect(pre.skipped).toEqual(['Docs site'])
    expect(pre.changes.map((c) => c.where)).toEqual(['gtm'])
    // applied: gtm goes back to the saved pi, news keeps its own, docs is not there to touch
    expect(p.apply('then').ok).toBe(true)
    expect(own(w.s, 'task.agent', { space: 'news' })).toBe('Codex')
    expect(own(w.s, 'task.agent', { space: 'gtm' })).toBe('pi')
  })

  test('planOf names what it leaves out, and skips a saved space by its key when it has no name of its own', () => {
    const plan = planOf({ settings: new Settings({ everywhere: {}, machine: {}, spaces: {} }), machine: { host: HOST, name: 'box' }, spaces: [{ key: 'a', name: 'A' }] }, { limits: false, names: {}, values: { all: {}, machine: {}, spaces: { gone: {} } } })
    expect(plan).toEqual({ changes: [], skipped: ['gone'], added: ['A'] })
  })
})

describe('undo: puts back what the last apply changed, where it still reads as the apply left it', () => {
  test('undo restores the values an apply changed, and the last apply goes back to the one before', () => {
    const w = world({ everywhere: { 'task.agent': 'Claude Code', 'task.model': 'opus' } })
    w.p.save('night')
    w.p.save('day')
    w.store.f.profiles[0]!.values.all['task.agent'] = 'pi'
    w.store.f.profiles[0]!.values.all['task.model'] = 'opencode-go/deepseek-v4.1-flash'
    w.p.apply('day')
    expect(own(w.s, 'task.agent', 'all')).toBe('Claude Code')
    w.p.apply('night')
    expect(own(w.s, 'task.agent', 'all')).toBe('pi')
    expect(w.p.view().last?.name).toBe('night')
    const u = w.p.undo()
    expect(u).toMatchObject({ ok: true, name: 'night', kept: [] })
    expect(u.changes.map((c) => c.key)).toEqual(['task.agent', 'task.model'])
    expect(own(w.s, 'task.agent', 'all')).toBe('Claude Code')
    expect(own(w.s, 'task.model', 'all')).toBe('opus')
    // the last apply is the one before: day
    expect(w.p.view().last?.name).toBe('day')
    expect(w.p.view().undo?.name).toBe('day')
    expect(w.written.length).toBe(3)
  })

  test('an undo point is labelled with the profile and when it was made', () => {
    const w = world()
    w.p.save('night')
    w.p.apply('night', Date.UTC(2026, 10, 13, 4, 5))
    const label = w.p.view().undo!.label
    expect(label.startsWith('Before night, 13 Nov')).toBe(true)
    expect(label).toMatch(/\d\d:\d\d$/)
  })

  test('a setting changed since the apply is left as it is, and the undo says so', () => {
    const w = world({ everywhere: { 'task.agent': 'Claude Code' } })
    w.p.save('night')
    w.store.f.profiles[0]!.values.all['task.agent'] = 'pi'
    w.p.apply('night')
    // changed by hand after the apply: undo must not put the Claude Code back over it
    w.s.set('task.agent', 'Codex', 'all')
    w.s.set('task.effort', 'low', 'machine')
    const u = w.p.undo()
    expect(u.ok).toBe(true)
    expect(u.changes).toEqual([])
    expect(u.kept).toEqual(['Tasks · Primary · Agent (Everywhere)'])
    expect(own(w.s, 'task.agent', 'all')).toBe('Codex')
  })

  test('a space removed since the apply has nothing to undo there', () => {
    const w = world({ spaces: { gtm: { 'task.agent': 'Codex' } } })
    w.p.save('night')
    w.store.f.profiles[0]!.values.spaces.gtm!['task.agent'] = 'pi'
    w.p.apply('night')
    const shown = new Profiles(w.store, () => ({ ...w.site(), spaces: [{ key: 'docs', name: 'Docs site' }] }), () => undefined)
    const u = shown.undo()
    expect(u).toMatchObject({ ok: true, changes: [], kept: [] })
  })

  test('an undo a setting refuses is not made, and the point stays', () => {
    const w = world({ everywhere: { 'task.agent': 'Claude Code' } })
    w.p.save('night')
    w.store.f.profiles[0]!.values.all['task.agent'] = 'pi'
    w.p.apply('night')
    w.store.f.undo[0]!.changes[0]!.before = 'bad!'
    const u = w.p.undo()
    expect(u.ok).toBe(false)
    expect(u.error).toBe('Nothing was undone: 1 setting would be refused.')
    expect(u.refused.length).toBe(1)
    expect(w.store.f.undo.length).toBe(1)
  })

  test('there is nothing to undo before any apply', () => {
    const w = world()
    expect(w.p.undo()).toEqual({ ok: false, error: 'Nothing to undo: no profile has been applied.', changes: [], kept: [], refused: [] })
    expect(w.p.view().undo).toBeUndefined()
  })

  test('only the last few apply points are kept', () => {
    const w = world({ everywhere: { 'task.agent': 'pi' } })
    w.p.save('a')
    w.p.save('b')
    w.store.f.profiles[1]!.values.all['task.agent'] = 'Codex'
    for (let i = 0; i < UNDO_KEEP + 2; i++) w.p.apply(i % 2 ? 'a' : 'b')
    expect(w.store.f.undo.length).toBe(UNDO_KEEP)
    // and each undo steps back one of them
    expect(w.p.undo().ok).toBe(true)
    expect(w.store.f.undo.length).toBe(UNDO_KEEP - 1)
  })

  test('an undo that has nothing to put back (a point an apply left empty) only takes its point away', () => {
    const w = world({ everywhere: { 'task.agent': 'pi' } })
    w.p.save('same')
    w.p.apply('same')
    expect(w.store.f.undo.length).toBe(1)
    expect(w.p.undo()).toMatchObject({ ok: true, changes: [] })
    expect(w.store.f.undo.length).toBe(0)
    expect(w.store.f.last).toBeUndefined()
  })
})

describe('the bar: which profile the settings match, and Custom once they match none', () => {
  test('a profile applied is the one in force, Custom once anything changes, and a profile that matches is named', () => {
    const w = world({ everywhere: { 'task.agent': 'pi' } })
    expect(w.p.view().active).toBe('Custom')
    w.p.save('night')
    expect(w.p.view().active).toBe('night')
    w.s.set('task.agent', 'Claude Code', 'all')
    expect(w.p.view().active).toBe('Custom')
    expect(w.p.view().profiles.map((x) => x.name)).toEqual(['night'])
    w.p.apply('night')
    expect(w.p.view().active).toBe('night')
    expect(w.p.view().last).toMatchObject({ name: 'night' })
    // a profile that matches the settings is the one in force, even when it is not the one applied last
    w.s.set('task.agent', 'Claude Code', 'all')
    w.p.save('claude')
    w.s.set('task.agent', 'pi', 'all')
    expect(w.p.view()).toMatchObject({ active: 'night', last: { name: 'night' } })
    w.s.set('task.agent', 'Claude Code', 'all')
    expect(w.p.view().active).toBe('claude')
  })

  test('a profile applied and then changed is shown with its time: Custom, and the last apply still there', () => {
    const w = world({ everywhere: { 'task.agent': 'pi' } })
    w.p.save('night')
    w.p.apply('night')
    // a key night does not hold changes nothing about it
    w.s.set('space.maxTasks', '2', { space: 'gtm' })
    expect(w.p.view().active).toBe('night')
    w.s.set('task.agent', 'Codex', 'all')
    expect(w.p.view()).toMatchObject({ active: 'Custom', last: { name: 'night' } })
  })

  test('a last apply whose profile was deleted is not shown', () => {
    const w = world()
    w.p.save('gone')
    w.p.apply('gone')
    w.store.f.last = { name: 'ghost', at: 1 }
    expect(w.p.view().last).toBeUndefined()
    expect(w.p.view().active).toBe('gone')
  })
})

describe('the names, saving over, renaming and deleting', () => {
  test('a name is one line of at most 40 characters, not Custom, and not taken', () => {
    const w = world()
    expect(w.p.save('   ')).toEqual({ ok: false, error: 'Give the profile a name.' })
    expect(w.p.save('x'.repeat(41)).error).toBe('Use at most 40 characters.')
    expect(w.p.save('Custom').error).toMatch(/^Custom is what the bar says/)
    expect(w.p.save('bad\u0001name').error).toBe('Use letters, numbers and spaces.')
    expect(w.p.save('  late   night ').profile!.name).toBe('late night')
    expect(w.p.save('LATE NIGHT')).toMatchObject({ ok: false, exists: true, error: 'late night is a profile already.' })
    expect(cleanName('  a \t b ')).toBe('a b')
    expect(nameProblem('ok', w.store.f)).toBeUndefined()
  })

  test('saving over a name asks first (exists), and replaces it with force', () => {
    const w = world({ everywhere: { 'task.agent': 'pi' } })
    w.p.save('night')
    w.p.apply('night')
    w.s.set('task.agent', 'Codex', 'all')
    const again = w.p.save('night')
    expect(again).toMatchObject({ ok: false, exists: true })
    const replaced = w.p.save('night', { force: true, limits: true })
    expect(replaced).toMatchObject({ ok: true, profile: { limits: true } })
    expect(w.store.f.profiles.length).toBe(1)
    expect(w.store.f.profiles[0]!.values.all['task.agent']).toBe('Codex')
    // a replaced profile has not been applied since it was saved
    expect(w.store.f.profiles[0]!.applied).toBeUndefined()
  })

  test('rename moves the name the last apply carries; a name taken is refused; the same name in other case is fine', () => {
    const w = world()
    w.p.save('night')
    w.p.save('day')
    w.p.apply('night')
    expect(w.p.rename('night', 'day')).toEqual({ ok: false, error: 'day is a profile already.' })
    expect(w.p.rename('nope', 'x')).toEqual({ ok: false, error: 'No profile called nope.' })
    expect(w.p.rename('night', 'Night')).toEqual({ ok: true })
    expect(w.store.f.last?.name).toBe('Night')
    expect(w.p.view().active).toBe('Night')
  })

  test('delete drops the profile and the last apply that named it', () => {
    const w = world()
    w.p.save('night')
    w.p.apply('night')
    expect(w.p.remove('nope')).toEqual({ ok: false, error: 'No profile called nope.' })
    expect(w.p.remove('NIGHT')).toEqual({ ok: true })
    expect(w.store.f.profiles).toEqual([])
    expect(w.store.f.last).toBeUndefined()
    expect(w.p.view()).toMatchObject({ active: 'Custom', profiles: [] })
  })

  test('a name that is not there is said so by each verb', () => {
    const w = world()
    expect(w.p.preview('x')).toEqual({ ok: false, error: 'No profile called x.', changes: [], refused: [], skipped: [], added: [] })
    expect(w.p.apply('x').error).toBe('No profile called x.')
    expect(() => w.p.show('x')).toThrow('No profile called x.')
  })
})

describe('the words: show, list, the preview and the waiting tasks', () => {
  test('show says what a profile sets, at each level, and leaves out what it does not set', () => {
    const w = world({ everywhere: { 'task.agent': 'pi', 'task.model': 'opencode-go/deepseek-v4.1-flash' }, spaces: { gtm: { 'space.maxTasks': '4' } } })
    w.p.save('night', { limits: true })
    w.store.f.profiles[0]!.applied = Date.now() - 2 * 3_600_000
    const words = w.p.show('night')
    expect(words.split('\n')[0]).toMatch(/^night: Models and Limits, saved just now, applied 2h ago$/)
    expect(words).toContain('Everywhere\n  Tasks · Primary · Agent: pi\n  Tasks · Primary · Model: opencode-go/deepseek-v4.1-flash')
    expect(words).toContain('box\n  nothing set here')
    expect(words).toContain('gtm\n  Max tasks: 4')
    expect(words).toContain('Docs site\n  nothing set here')
  })

  test('show marks a saved space that is no longer one', () => {
    const w = world({ spaces: { gtm: { 'task.agent': 'pi' } } })
    w.p.save('night')
    const shown = new Profiles(w.store, () => ({ ...w.site(), spaces: [{ key: 'other', name: 'other' }] }), () => undefined)
    expect(shown.show('night')).toContain('gtm (no longer a space)')
  })

  test('list says which profile is in force, its undo point, and when each was saved or applied', () => {
    const w = world()
    expect(w.p.list()).toBe('No profiles yet. shepherdr profile save <name> keeps the current settings as one.')
    w.p.save('night', { limits: true })
    w.p.save('day')
    w.p.apply('night')
    const text = w.p.list()
    const rows = text.split('\n')
    expect(rows[0]).toMatch(/^night\s+Models and Limits\s+saved just now, applied just now$/)
    expect(rows[1]).toMatch(/^day\s+Models\s+saved just now$/)
    expect(rows[2]).toMatch(/^In force: night\. Undo: Before night, /)
  })

  test('the ago words: just now, minutes, hours, days', () => {
    const now = 10 * 86_400_000
    expect(agoWords(now - 5_000, now)).toBe('just now')
    expect(agoWords(now - 5 * 60_000, now)).toBe('5m ago')
    expect(agoWords(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(agoWords(now - 2 * 86_400_000, now)).toBe('2d ago')
    expect(agoWords(now + 60_000, now)).toBe('just now')
  })

  test('the preview in words: by level, the refusals, the skipped and the left-alone spaces', () => {
    const w = world({ everywhere: { 'task.agent': 'pi' } })
    w.p.save('night')
    w.s.set('task.agent', 'Claude Code', 'all')
    w.store.f.profiles[0]!.values.machine['task.model'] = 'bad!'
    const r = w.p.preview('night')
    const text = previewWords(r)
    expect(text).toContain('night would change 2 settings:')
    expect(text).toContain('Everywhere\n  Tasks · Primary · Agent: Claude Code → pi')
    expect(text).toContain('Refused, so nothing would be applied:\n  box · Tasks · Primary · Model: Write a model id like')
    const quiet = previewWords({ ...r, changes: [], refused: [], skipped: ['gone'], added: ['new'] })
    expect(quiet).toContain('night changes nothing: the settings read as it says.')
    expect(quiet).toContain('Skipped, no longer a space: gone')
    expect(quiet).toContain('Left as it is, added since the save: new')
    expect(changeWords([{ place: 'all', where: 'Everywhere', key: 'x', label: 'L', now: null, then: 'y' }])).toEqual(['Everywhere', '  L: not set → y'])
  })

  test('waiting tasks: one pick per kind and place, the first change of it', () => {
    const at: Level = 'all'
    const c = (key: string, place: string): Change => ({ place, where: 'Everywhere', key, label: key, now: null, then: 'x', at })
    const picks = waitingPicks([c('task.agent', 'all'), c('task.model', 'all'), c('reviewer.agent', 'all'), c('task.agent', 'm:box'), c('merge.train', 'all')])
    expect(picks.map((p) => `${p.kind}|${p.change.key}|${p.change.place}`)).toEqual(['agent|task.agent|all', 'reviewer|reviewer.agent|all', 'agent|task.agent|m:box'])
  })
})

describe('the file: profiles.json in the home, and what a damaged one reads as', () => {
  test('a profile saved is read back by a new store, the last apply and the undo point with it', () => {
    const dir = home()
    const w = new ProfileStore()
    const s = new Settings({ everywhere: { 'task.agent': 'pi' }, machine: {}, spaces: {} })
    const p = new Profiles(w, () => ({ settings: s, machine: { host: HOST, name: 'box' }, spaces: SPACES }), () => undefined)
    p.save('kept')
    p.apply('kept', 1_000)
    const again = new ProfileStore()
    expect(again.f.profiles.map((x) => x.name)).toEqual(['kept'])
    expect(again.f.last).toEqual({ name: 'kept', at: 1_000 })
    expect(again.f.undo.length).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8')).profiles[0].name).toBe('kept')
  })

  test('a damaged profiles.json reads as none, not as a failure', () => {
    writeFileSync(join(home(), 'profiles.json'), '{"profiles": "nope", "undo": 3')
    const store = new ProfileStore()
    expect(store.f).toEqual({ profiles: [], last: undefined, undo: [] })
    writeFileSync(join(home(), 'profiles.json'), JSON.stringify({ profiles: 'x', undo: 'y' }))
    expect(new ProfileStore().f.profiles).toEqual([])
  })
})
