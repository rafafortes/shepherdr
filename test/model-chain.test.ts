// A role's model chain is rewritten as one scoped write: a move carries each CLI with its own model and effort, an insert
// starts on the chosen CLI, and a refused entry leaves every position as it was.
import { describe, expect, test } from 'bun:test'
import { effortFor, findModel, knowsModels } from '../server/live/models.ts'
import { chainPairs, kindOf, Settings } from '../server/live/settings.ts'

const fresh = (seed: Partial<{ everywhere: Record<string, string>; machine: Record<string, string>; spaces: Record<string, Record<string, string>> }> = {}) =>
  new Settings({ everywhere: {}, machine: {}, spaces: {}, ...seed })
const mixed = () =>
  fresh({
    everywhere: {
      'task.agent': 'Claude Code',
      'task.model': 'claude-opus-5-5',
      'task.effort': 'high',
      'task.fallback': 'Codex',
      'backup.model': 'gpt-6-sol',
      'backup.effort': 'xhigh',
      'task.fallback2': 'pi',
      'task.fallback2Model': 'opencode-go/deepseek-v4.1-flash',
      'task.fallback2Effort': 'medium',
      'task.fallback3': 'OpenCode',
      'task.fallback3Model': 'opencode-go/hungerg-free',
      'task.fallback3Effort': 'default',
      'task.fallback4': 'Antigravity',
      'task.fallback4Model': 'gemini-4-hydrogen',
      'task.fallback4Effort': 'default',
    },
  })
const chain = (s: Settings, role: 'task' | 'coordinator' | 'reviewer' | 'advisor' = 'task', space?: string) => s.chainAt(role, space ? { space } : 'all')

describe('a model chain moves and inserts whole entries', () => {
  test('a mixed chain keeps every CLI with its own model and effort when an entry moves to Primary', () => {
    const s = mixed()
    const before = chain(s)
    expect(s.moveChain('task', 4, 0, 'all')).toEqual({ ok: true })
    expect(chain(s)).toEqual([before[4], before[0], before[1], before[2], before[3], before[5]])
    for (const entry of chain(s)) {
      const kind = kindOf(entry.cli)
      if (!kind) continue
      if (knowsModels(kind) && entry.model !== 'default') expect(findModel(kind, entry.model)).toBeDefined()
      if (entry.effort !== 'default') expect(effortFor(kind, entry.effort, entry.model === 'default' ? undefined : entry.model)).toBeDefined()
    }
    expect(s.harness('task')).toMatchObject({ kind: 'agy', model: 'gemini-4-hydrogen' })
  })

  test('the Primary can move down, and the entries below it shift up together', () => {
    const s = mixed()
    const before = chain(s)
    expect(s.moveChain('task', 0, 2, 'all')).toEqual({ ok: true })
    expect(chain(s)).toEqual([before[1], before[2], before[0], before[3], before[4], before[5]])
  })

  test('Insert above adds a default entry on the chosen CLI at that position and shifts the rest down', () => {
    const s = mixed()
    const before = chain(s)
    expect(s.insertChain('task', 1, 'OpenCode', 'all')).toEqual({ ok: true })
    expect(chain(s)).toEqual([before[0], { cli: 'OpenCode', model: 'default', effort: 'default' }, ...before.slice(1, 5)])
  })

  test('a moved coordinator backup carries the model and effort it was reading from the tasks backup', () => {
    const s = fresh({ everywhere: { 'backup.model': 'gpt-6-sol', 'backup.effort': 'xhigh', 'coordinator.fallback': 'pi' } })
    const before = chain(s, 'coordinator')
    expect(before[1]).toEqual({ cli: 'pi', model: 'gpt-6-sol', effort: 'xhigh' })
    expect(s.moveChain('coordinator', 1, 2, 'all')).toEqual({ ok: true })
    expect(chain(s, 'coordinator')[2]).toEqual(before[1])
  })
})

describe('a model chain writes only the scope being edited', () => {
  test('a space move materializes its whole effective chain there and leaves Everywhere, the machine and another space alone', () => {
    const s = mixed()
    s.set('task.effort', 'low', 'machine')
    s.set('task.model', 'claude-sonnet-5-5', { space: 'gtm' })
    const everywhere = s.everywhere()
    const other = chain(s, 'task', 'docs')
    const before = chain(s, 'task', 'gtm')
    expect(s.moveChain('task', 3, 0, { space: 'gtm' })).toEqual({ ok: true })
    expect(s.everywhere()).toEqual(everywhere)
    expect(s.pick('task.effort', 'machine')).toEqual({ value: 'low', from: 'machine' })
    expect(chain(s, 'task', 'docs')).toEqual(other)
    expect(chain(s, 'task', 'gtm')).toEqual([before[3], before[0], before[1], before[2], before[4], before[5]])
    for (const pair of chainPairs('task')) expect(s.pick(pair.cli, { space: 'gtm' }).from).toBe('space')
  })

  test('a refused move writes no key, and a full chain refuses an insert', () => {
    const s = fresh({ everywhere: { 'task.agent': 'Claude Code', 'task.fallback': 'off' } })
    const before = chain(s)
    expect(s.moveChain('task', 1, 0, 'all')).toMatchObject({ ok: false })
    expect(chain(s)).toEqual(before)
    expect(s.moveChain('task', -1, 0, 'all')).toEqual({ ok: false, error: 'Choose two positions in this chain.' })
    expect(s.insertChain('task', 6, 'pi', 'all')).toEqual({ ok: false, error: 'Choose a position in this chain.' })

    const full = mixed()
    full.set('task.fallback5', 'Claude Code', 'all')
    const fullBefore = chain(full)
    expect(full.insertChain('task', 1, 'pi', 'all')).toEqual({ ok: false, error: 'This chain already has a primary and five backups.' })
    expect(chain(full)).toEqual(fullBefore)
  })
})
