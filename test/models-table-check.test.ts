// The hand-kept fallback model table (models.ts TABLE) is checked against the real CLI reads persisted in
// cli-models.json. A stale fallback is a warning, never a failed check; a CLI with no read says nothing.
import { describe, expect, test } from 'bun:test'
import { writeJson } from '../server/store.ts'
import { checkModelTable, tableDiff, TABLE, type CliModels, type Model } from '../server/live/models.ts'
import { tmp } from './tmp.ts'

const m = (id: string): Model => ({ id, label: id, efforts: ['medium'] })
const read = (ids: string[], others: string[] = []): CliModels => ({
  models: ids.map(m),
  ...(others.length ? { others: others.map(m) } : {}),
  efforts: ['medium'],
})
const ids = (kind: string) => TABLE[kind].models.map((x) => x.id)

describe('the fallback model table check', () => {
  test('every harness: where its model list comes from, each in the check', () => {
    // claude and codex: the hand-kept table is the fallback, cross-checked against a stored CLI read
    expect(TABLE.claude.models.length).toBeGreaterThan(0)
    expect(TABLE.codex.models.length).toBeGreaterThan(0)
    // pi, opencode and agy: their lists come only from the CLI's own answer, so they are never compared
    for (const kind of ['pi', 'opencode', 'agy']) expect(TABLE[kind].models).toEqual([])
    const reads: Record<string, CliModels> = {
      pi: read(['openrouter/deepseek-v4.1-flash']),
      opencode: read(['opencode/hy4-flash-free']),
      agy: read(['gemini-4-hydrogen-low']),
    }
    expect(tableDiff(reads)).toEqual([])
  })

  test('a table id absent from the CLI read is named, and a new CLI id is named as unlisted', () => {
    const reads: Record<string, CliModels> = {
      // claude retired the table's first fallback and added one the table doesn't have yet; a retired id it still
      // takes by id (in `others`) is not gone
      claude: { ...read(ids('claude').slice(1)), models: [...ids('claude').slice(1).map(m), m('claude-new-9-9')], others: [m('claude-retired-but-taken')] },
      codex: read(ids('codex').slice(1)), // codex dropped the table's first fallback
    }
    const lines = tableDiff(reads)
    expect(lines).toHaveLength(2)
    const claude = lines.find((l) => l.startsWith('claude:')) ?? ''
    const codex = lines.find((l) => l.startsWith('codex:')) ?? ''
    expect(claude).toContain(ids('claude')[0])
    expect(claude).toContain('no longer lists')
    expect(claude).toContain('claude-new-9-9')
    expect(claude).toContain("doesn't")
    expect(claude).not.toContain('claude-retired-but-taken')
    expect(codex).toContain(ids('codex')[0])
  })

  test('a CLI with no persisted read produces no diff and no warning', () => {
    expect(tableDiff({})).toEqual([])
    expect(tableDiff({ claude: { models: [], efforts: [] } })).toEqual([])
    expect(tableDiff({ codex: read(ids('codex')) })).toEqual([]) // a current table, no drift
  })

  test('the check reads a fixture cli-models.json from a home', () => {
    const dir = tmp('models-table-check')
    writeJson('cli-models.json', { claude: read(ids('claude').slice(1)) }, dir)
    const { warnings, compared } = checkModelTable(dir)
    expect(warnings.join('\n')).toContain(ids('claude')[0])
    expect(compared).toEqual(['claude'])
    expect(checkModelTable(tmp('models-table-check-empty'))).toEqual({ warnings: [], compared: [] })
  })
})
