// Settings → Models, the server's side: the table read in one go (rows are levels, columns are each role's slots), each
// value with where it comes from, the backups' chains, the words of a cell, and the demo's read of the same table.
import { describe, expect, test } from 'bun:test'
import { modelsMatrix, matrixSlots, wordsOf } from '../server/live/models-matrix.ts'
import { Settings } from '../server/live/settings.ts'
import { DemoWorld } from '../server/demo/world.ts'
import { setModels } from '../server/live/models.ts'
import type { ModelsMatrix } from '../shared/types.ts'

const HOST = 'box'
const fresh = (seed: Partial<{ everywhere: Record<string, string>; machine: Record<string, string>; spaces: Record<string, Record<string, string>> }> = {}) =>
  new Settings({ everywhere: {}, machine: {}, spaces: {}, ...seed })
const SPACES = [
  { key: 'gtm', name: 'gtm' },
  { key: 'docs', name: 'Docs site' },
]
const matrix = (s: Settings, spaces = SPACES) => modelsMatrix(s, { host: HOST, name: 'box' }, spaces)
const row = (m: ModelsMatrix, id: string) => m.rows.find((r) => r.id === id)!

describe('the models matrix: slots and rows', () => {
  test('each role has its primary and five backups, in the keys Settings writes them to', () => {
    const slots = matrixSlots()
    expect(slots.map((x) => x.id)).toEqual(
      ['task', 'coordinator', 'reviewer', 'advisor'].flatMap((r) => [0, 1, 2, 3, 4, 5].map((n) => `${r}.${n}`)),
    )
    const task = slots.filter((x) => x.role === 'task')
    expect(task.map((x) => x.name)).toEqual(['Primary', 'Backup 1', 'Backup 2', 'Backup 3', 'Backup 4', 'Backup 5'])
    expect(task[0]).toMatchObject({ title: 'Tasks', cli: 'task.agent', model: 'task.model', effort: 'task.effort', n: 0 })
    expect(task[1]).toMatchObject({ cli: 'task.fallback', model: 'backup.model', effort: 'backup.effort', clis: ['off', 'Claude Code', 'Codex', 'pi', 'OpenCode'] })
    expect(task[2]).toMatchObject({ cli: 'task.fallback2', model: 'task.fallback2Model', effort: 'task.fallback2Effort' })
    expect(slots.find((x) => x.id === 'coordinator.1')).toMatchObject({ cli: 'coordinator.fallback', model: 'coordinator.fallbackModel' })
    expect(slots.find((x) => x.id === 'reviewer.0')).toMatchObject({ cli: 'reviewer.agent', clis: ['Codex', 'Claude Code', 'pi', 'OpenCode'] })
    expect(slots.find((x) => x.id === 'advisor.0')!.clis).toEqual(['off', 'Codex', 'Claude Code', 'pi', 'OpenCode'])
  })

  test('rows are Everywhere, this machine and each space; the home space only when it sets one of these keys', () => {
    const m = matrix(fresh())
    expect(m.machine).toEqual({ id: `m:${HOST}`, name: 'box' })
    expect(m.rows.map((r) => [r.id, r.name, r.kind])).toEqual([
      ['all', 'Everywhere', 'all'],
      [`m:${HOST}`, 'box', 'machine'],
      [`p:${HOST}:gtm`, 'gtm', 'space'],
      [`p:${HOST}:docs`, 'Docs site', 'space'],
    ])
    expect(m.plain).toEqual([
      { key: 'space.maxTasks', title: 'Max tasks', num: { min: 1, max: 200, off: true } },
      { key: 'merge.train', title: 'Merge train', options: ['off', '2', '3', '4', '5'] },
    ])
    // the home space sets one of them: its row comes, named as the sidebar names it
    const home = matrix(fresh({ spaces: { '~': { 'space.maxTasks': '2' } } }), [{ key: '~', name: 'home' }, ...SPACES])
    expect(home.rows.map((r) => r.id)).toContain(`p:${HOST}:~`)
    expect(row(home, `p:${HOST}:~`).name).toBe('home')
  })

  test('every value says where it comes from: its own level strong, one above it faint, the default last', () => {
    const s = fresh({ everywhere: { 'task.agent': 'Codex', 'task.model': 'gpt-6-sol', 'merge.train': '3' }, machine: { 'task.effort': 'high', 'space.maxTasks': '4' }, spaces: { gtm: { 'task.model': 'Opus 5.5', 'space.maxTasks': '1' } } })
    const m = matrix(s)
    const all = row(m, 'all').values
    expect(all['task.agent']).toEqual({ value: 'Codex', from: 'all', set: true })
    expect(all['task.effort']).toEqual({ value: 'default', from: 'default', set: false })
    const machine = row(m, `m:${HOST}`).values
    expect(machine['task.agent']).toEqual({ value: 'Codex', from: 'all', set: false })
    expect(machine['task.effort']).toEqual({ value: 'high', from: 'machine', set: true })
    expect(machine['space.maxTasks']).toEqual({ value: '4', from: 'machine', set: true })
    const gtm = row(m, `p:${HOST}:gtm`).values
    expect(gtm['task.model']).toEqual({ value: 'Opus 5.5', from: 'space', set: true })
    expect(gtm['task.effort']).toEqual({ value: 'high', from: 'machine', set: false })
    expect(gtm['merge.train']).toEqual({ value: '3', from: 'all', set: false })
    // a space with nothing of its own reads what the levels above it set
    const docs = row(m, `p:${HOST}:docs`).values
    expect(docs['task.agent']).toEqual({ value: 'Codex', from: 'all', set: false })
    expect(docs['space.maxTasks']).toEqual({ value: '4', from: 'machine', set: false })
  })

  test('a cell says in words what its slot runs on, and whether any of its keys is set in that row', () => {
    const s = fresh({ everywhere: { 'task.agent': 'pi', 'task.model': 'opencode-go/deepseek-v4.1-flash', 'task.effort': 'high' }, spaces: { gtm: { 'task.effort': 'low' } } })
    const m = matrix(s)
    expect(row(m, 'all').cells['task.0']).toEqual({ words: 'pi · opencode-go/deepseek-v4.1-flash · high', set: true, from: 'all' })
    expect(row(m, `p:${HOST}:gtm`).cells['task.0']).toEqual({ words: 'pi · opencode-go/deepseek-v4.1-flash · low', set: true, from: 'all' })
    expect(row(m, `p:${HOST}:docs`).cells['task.0']).toEqual({ words: 'pi · opencode-go/deepseek-v4.1-flash · high', set: false, from: 'all' })
    // Backup 1 is Codex by default, Backup 2 off: off reads "off" and is not set anywhere
    expect(row(m, 'all').cells['task.1']).toEqual({ words: 'Codex', set: false, from: 'default' })
    expect(row(m, 'all').cells['task.2']).toEqual({ words: 'off', set: false, from: 'default' })
  })

  test('a backup chain: an off in a space takes that backup out there only, the next one stays as Everywhere set it', () => {
    const s = fresh({ everywhere: { 'task.fallback2': 'pi', 'task.fallback2Model': 'opencode-go/deepseek-v4.1-flash' }, spaces: { gtm: { 'task.fallback': 'off' } } })
    const m = matrix(s)
    expect(row(m, `p:${HOST}:gtm`).cells['task.1']).toEqual({ words: 'off', set: true, from: 'space' })
    expect(row(m, `p:${HOST}:gtm`).cells['task.2']).toEqual({ words: 'pi · opencode-go/deepseek-v4.1-flash', set: false, from: 'all' })
    expect(row(m, 'all').cells['task.2']!.words).toBe('pi · opencode-go/deepseek-v4.1-flash')
    expect(row(m, `m:${HOST}`).values['task.fallback2']).toEqual({ value: 'pi', from: 'all', set: false })
  })

  test("the coordinators' backup model reads the tasks' backup's while it is at default, and says so", () => {
    const s = fresh({ everywhere: { 'backup.model': 'opencode-go/deepseek-v4.1-flash', 'coordinator.fallback': 'pi' } })
    const m = matrix(s)
    const cell = row(m, 'all').values['coordinator.fallbackModel']!
    expect(cell).toEqual({ value: 'opencode-go/deepseek-v4.1-flash', from: 'all', set: false, follows: 'backup.model' })
    // set in Everywhere itself, the row that sets it: strong
    expect(row(m, 'all').cells['coordinator.1']).toEqual({ words: 'pi · opencode-go/deepseek-v4.1-flash', set: true, from: 'all' })
    expect(row(m, `p:${HOST}:gtm`).cells['coordinator.1']).toEqual({ words: 'pi · opencode-go/deepseek-v4.1-flash', set: false, from: 'all' })
  })

  test('the model labels and CLI names the screen compares against its lists', () => {
    setModels('claude', undefined)
    const m = matrix(fresh({ everywhere: { 'task.agent': 'claude', 'task.model': 'claude-opus-5-5', 'reviewer.agent': 'pi' } }))
    expect(row(m, 'all').values['task.agent']!.value).toBe('Claude Code')
    expect(row(m, 'all').values['task.model']!.value).toBe('Opus 5.5')
    expect(row(m, 'all').cells['task.0']!.words).toBe('Claude Code · Opus 5.5')
    // a value that is no model the CLI has stays as written
    expect(row(m, 'all').values['reviewer.model']!.value).toBe('default')
    const odd = matrix(fresh({ everywhere: { 'task.agent': 'Codex', 'task.model': 'gpt-old' } }))
    expect(row(odd, 'all').values['task.model']!.value).toBe('gpt-old')
  })
})

describe('the models matrix: what each CLI takes', () => {
  test('a catalog per CLI of the table: its models (ids and labels) with the efforts each takes, and its own levels', () => {
    const m = matrix(fresh())
    const codex = m.catalog.Codex!
    expect(codex.known).toBe(true)
    expect(codex.models.map((x) => x.id)).toContain('gpt-6-sol')
    expect(codex.models.find((x) => x.id === 'gpt-6-sol')!.efforts).toContain('high')
    expect(codex.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].filter((l) => codex.efforts.includes(l)))
    expect(m.catalog['Claude Code']!.models.map((x) => x.label)).toContain('Opus 5.5')
    // pi lists its models only once asked: until then any id goes, and the catalog says so
    expect(m.catalog.pi).toEqual({ known: false, models: [], efforts: expect.arrayContaining(['low', 'high']) })
  })
})

describe('the words of a cell', () => {
  test('CLI, model and effort in words; default and off are left out', () => {
    expect(wordsOf('Codex', 'default', 'default')).toBe('Codex')
    expect(wordsOf('Claude Code', 'default', 'high')).toBe('Claude Code · high')
    expect(wordsOf('pi', 'opencode-go/deepseek-v4.1-flash', 'high')).toBe('pi · opencode-go/deepseek-v4.1-flash · high')
    expect(wordsOf('off', 'opencode-go/deepseek-v4.1-flash', 'high')).toBe('off')
    expect(wordsOf('Codex', 'gpt-6-sol', 'xhigh')).toBe('Codex · GPT-6-Sol · xhigh')
  })
})

describe('the demo world reads the same table', () => {
  test('models-matrix: its machine and spaces, with the demo levels, and a write at a space shows in its row', async () => {
    const world = new DemoWorld()
    const m = (await world.act({ type: 'models-matrix' })) as ModelsMatrix
    expect(m.machine.name).toBe('vm-str')
    expect(m.rows.map((r) => r.id)).toEqual(['all', 'm:vm-str', 'p:vm-str:gtm', 'p:vm-str:herdr-projects'])
    expect(row(m, 'p:vm-str:gtm').values['task.agent']).toEqual({ value: 'Codex', from: 'space', set: true })
    expect(await world.act({ type: 'setting', key: 'task.agent', value: 'pi', place: 'p:vm-str:herdr-projects' })).toMatchObject({ ok: true })
    const after = (await world.act({ type: 'models-matrix' })) as ModelsMatrix
    // its machine's effort (high) still applies: the cell reads the whole of it
    expect(row(after, 'p:vm-str:herdr-projects').cells['task.0']!.words).toBe('pi · high')
    expect(row(after, 'p:vm-str:herdr-projects').values['task.agent']).toEqual({ value: 'pi', from: 'space', set: true })
  })
})
