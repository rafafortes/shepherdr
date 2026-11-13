// Antigravity's (agy) models as Shepherdr reads them from `agy models`: grouped into base models with their efforts,
// their labels without the effort, the full ids --model takes, the usage key of a model, its row in the summary, and
// the fake `agy` that a failing or hanging list run is checked with (never the real one).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agyIds, agyBaseId, agyFullIds, effortFor, effortsOf, findModel, modelArg, parseAgy, read, readAgy, setModels } from '../server/live/models.ts'
import { keyOf, labelOf, modelsSummary, providerName, type SummaryInput } from '../server/live/models-summary.ts'
import { modelKey, HOUR, UsageLedger } from '../server/live/usage-ledger.ts'
import { Settings } from '../server/live/settings.ts'
import { placeId } from '../server/live/places.ts'
import { tmp } from './tmp.ts'

const NOW = Date.now()
/** what `agy models` printed on the study's machine: a first line, then one id and label per model */
const LISTED = [
  'Fetching available models...',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  'gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)',
].join('\n')

const bin = tmp('agy-models-bin')
const path = process.env.PATH
const savedMode = process.env.FAKE_AGY_MODE
/** a fake `agy` on PATH: `agy models` prints the list, fails or hangs as FAKE_AGY_MODE says */
writeFileSync(
  join(bin, 'agy'),
  `#!/bin/sh
case "$FAKE_AGY_MODE" in
  list) printf '%s\\n' 'Fetching available models...' 'gemini-3.8-flash-low	Gemini 3.8 Flash (Low)' 'gemini-3.8-flash-high	Gemini 3.8 Flash (High)' ;;
  fail) echo 'not signed in' >&2; exit 1 ;;
  hang) exec sleep 30 ;;
esac
`,
)
chmodSync(join(bin, 'agy'), 0o755)

beforeAll(() => {
  setModels('agy', parseAgy(LISTED))
})

afterAll(() => {
  setModels('agy', undefined)
  process.env.PATH = path
  if (savedMode === undefined) delete process.env.FAKE_AGY_MODE
  else process.env.FAKE_AGY_MODE = savedMode
})

describe("agy's list: grouped into base models, each effort its own id", () => {
  test('the efforts of a base model are its suffixes in rank order; the label loses its "(Effort)" part', () => {
    const c = parseAgy(LISTED)!
    expect(c.models.map((m) => m.id)).toEqual(['gemini-3.8-flash', 'gemini-4-hydrogen', 'claude-opus-5-5', 'gpt-oss-120b', 'gemini-pro-orchestrator-g1-pro'])
    expect(c.models[0]).toEqual({ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] })
    expect(c.models[1]).toEqual({ id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', efforts: ['xhigh'] })
    // an id with no effort is a model of its own, its own label kept (its parentheses are no effort)
    expect(c.models[4]).toEqual({ id: 'gemini-pro-orchestrator-g1-pro', label: 'Orchestrator (Argon)', efforts: [] })
    expect(c.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(c.others).toBeUndefined()
  })

  test('the full ids are the base with each effort, or the id itself when it has none', () => {
    const c = parseAgy(LISTED)!
    expect(agyFullIds(c.models[0]!)).toEqual(['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'])
    expect(agyFullIds(c.models[4]!)).toEqual(['gemini-pro-orchestrator-g1-pro'])
    expect(agyBaseId('gemini-3.8-flash-low')).toBe('gemini-3.8-flash')
    expect(agyBaseId('gemini-3.8-flash')).toBe('gemini-3.8-flash')
  })

  test('nothing when the output names no model: a failed run, a line with no tab, an empty id', () => {
    expect(parseAgy('')).toBeUndefined()
    expect(parseAgy('Fetching available models...\nno tab here\n\tno id')).toBeUndefined()
    // a model listed twice with one effort says it once
    expect(parseAgy('a-low\tA (Low)\na-low\tA (Low)')!.models[0]!.efforts).toEqual(['low'])
  })

  test('a list run by the CLI itself: its lines read, a run that fails or runs past its limit says nothing', async () => {
    process.env.PATH = `${bin}:${path}`
    try {
      process.env.FAKE_AGY_MODE = 'list'
      expect((await readAgy())!.models.map((m) => m.id)).toEqual(['gemini-3.8-flash'])
      process.env.FAKE_AGY_MODE = 'fail'
      expect(await readAgy()).toBeUndefined()
      process.env.FAKE_AGY_MODE = 'hang'
      const at = Date.now()
      expect(await readAgy(200)).toBeUndefined()
      expect(Date.now() - at).toBeLessThan(5_000)
    } finally {
      process.env.PATH = path
    }
  }, 15_000)

  test("the CLI's list is read as its kind's list (the cache takes it, as it does for every CLI)", async () => {
    process.env.PATH = `${bin}:${path}`
    try {
      process.env.FAKE_AGY_MODE = 'list'
      expect((await read('agy'))!.models.map((m) => m.id)).toEqual(['gemini-3.8-flash'])
    } finally {
      process.env.PATH = path
    }
  })

  test('no agy on PATH: the list run fails, and the caller keeps the table', async () => {
    const empty = tmp('agy-models-none')
    rmSync(empty, { recursive: true, force: true })
    mkdirSync(empty, { recursive: true })
    process.env.PATH = empty
    try {
      await expect(readAgy()).rejects.toThrow()
    } finally {
      process.env.PATH = path
    }
  })
})

describe("agy's models in the menus and in its ids", () => {
  test('a model is found by its base id, its label, and a full id (with that effort)', () => {
    expect(findModel('agy', 'gemini-3.8-flash')?.efforts).toEqual(['low', 'medium', 'high'])
    expect(findModel('agy', 'Gemini 3.8 Flash')?.id).toBe('gemini-3.8-flash')
    expect(findModel('agy', 'gemini-3.8-flash-high')?.id).toBe('gemini-3.8-flash')
    expect(findModel('agy', 'gemini-3.8-flash-extra')).toBeUndefined()
  })

  test('a full id keeps its effort for --model; a base model is given as it is', () => {
    expect(agyIds()).toEqual(['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high', 'gemini-4-hydrogen-xhigh', 'claude-opus-5-5-high', 'gpt-oss-120b-medium', 'gemini-pro-orchestrator-g1-pro'])
    expect(modelArg('agy', 'gemini-3.8-flash-high')).toBe('gemini-3.8-flash-high')
    expect(modelArg('agy', 'gemini-3.8-flash')).toBe('gemini-3.8-flash')
    expect(modelArg('agy', 'Gemini 3.8 Flash')).toBe('gemini-3.8-flash')
    expect(modelArg('agy', 'gemini-9')).toBe('gemini-9')
    expect(modelArg('agy', 'default')).toBeUndefined()
  })

  test("the effort is the model's own levels, the nearest one it has when asked for another", () => {
    expect(effortsOf('agy', 'gemini-3.8-flash-high')).toEqual(['low', 'medium', 'high'])
    expect(effortsOf('agy', 'gpt-oss-120b')).toEqual(['medium'])
    expect(effortFor('agy', 'high', 'gemini-3.8-flash')).toBe('high')
    expect(effortFor('agy', 'xhigh', 'gemini-3.8-flash')).toBe('high')
    expect(effortFor('agy', 'max', 'gemini-4-hydrogen')).toBe('xhigh')
  })

  test('a CLI that lists nothing takes any id and no effort: nothing is refused', () => {
    setModels('agy', undefined)
    try {
      expect(agyIds()).toEqual([])
      expect(modelArg('agy', 'gemini-3.8-flash-low')).toBe('gemini-3.8-flash-low')
    } finally {
      setModels('agy', parseAgy(LISTED))
    }
  })
})

describe("agy's usage keys and summary rows", () => {
  test('a usage key is the model without its effort, under agy: the same model at any effort is one row', () => {
    expect(modelKey('agy', 'gemini-3.8-flash-low')).toBe('agy/gemini-3.8-flash')
    expect(modelKey('agy', 'gemini-3.8-flash')).toBe('agy/gemini-3.8-flash')
    expect(modelKey('agy')).toBe('agy/unknown')
    expect(keyOf('agy', 'gemini-3.8-flash-high')).toBe('agy/gemini-3.8-flash')
    expect(keyOf('agy')).toBe('agy/unknown')
  })

  test('the model in words is its name in the list; a model it does not name is the CLI default', () => {
    expect(providerName('agy')).toBe('Antigravity')
    expect(labelOf('agy/gemini-3.8-flash')).toBe('Gemini 3.8 Flash')
    expect(labelOf('agy/gemini-9')).toBe('gemini-9')
    expect(labelOf('agy/unknown')).toBe('Antigravity default')
  })

  test("an agy model's row shows its provider by name, with its models and its usage", () => {
    const dir = tmp('agy-summary')
    const l = new UsageLedger(dir, true)
    l.count('T-1/Agent', modelKey('agy', 'gemini-3.8-flash-high'), { id: 'a1', at: NOW - HOUR, tokens: 500 }, NOW)
    const input: SummaryInput = {
      now: NOW,
      settings: new Settings({ everywhere: {}, machine: {}, spaces: {} }),
      host: 'box',
      spaces: [{ key: '~', name: 'home' }],
      rows: [placeId.machine('box')],
      usage: l,
      agents: [],
      tasks: [],
      watch: [],
    }
    const row = modelsSummary(input).providers.find((p) => p.provider === 'agy')!
    expect(row).toMatchObject({ name: 'Antigravity', local: false })
    // a used provider lists the models in use; the rest it offers are the row of a provider nothing uses yet
    expect(row.models.map((m) => m.label)).toEqual(['Gemini 3.8 Flash'])
    expect(row.quota).toBeUndefined()
    input.usage = new UsageLedger(tmp('agy-summary-idle'), true)
    const idle = modelsSummary(input).providers.find((p) => p.provider === 'agy')!
    expect(idle.models.map((m) => m.label)).toEqual(['Gemini 3.8 Flash', 'Gemini 4 Hydrogen', 'Claude Opus 5.5', 'GPT-OSS 120B', 'Orchestrator (Argon)'])
  })
})
