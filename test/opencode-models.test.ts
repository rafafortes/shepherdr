// OpenCode's model keys and providers, where its calls and quotas land: its default model, the names it shows, the local
// servers it has, its models in words, and the Go plan's estimate that counts the calls of both CLIs (pi's and OpenCode's
// calls of one provider are one plan). Its calls are read from its own log copies by usage-feed (opencode-usage.test.ts).
import { describe, expect, test } from 'bun:test'
import { keyOf, labelOf, LOCAL, modelsSummary, providerName, type SummaryInput } from '../server/live/models-summary.ts'
import { opencodeList, setModels } from '../server/live/models.ts'
import { opencodeEstimate } from '../server/live/quota-estimate.ts'
import { modelKey, HOUR, UsageLedger } from '../server/live/usage-ledger.ts'
import { Settings } from '../server/live/settings.ts'
import { placeId } from '../server/live/places.ts'
import { sameHarness } from '../server/live/restart.ts'
import { tmp } from './tmp.ts'

const NOW = Date.now()
const GO = 'opencode-go/deepseek-v4.1-flash'
const ZEN = 'opencode/minimax-m3.1-flash-free'
const NV = 'nvidia/z-ai/glm-5.3-flash'

/** OpenCode's list as its models are kept, with the model it starts on */
const listed = (def?: string) =>
  opencodeList(
    [
      { id: GO, label: GO, efforts: ['high'] },
      { id: ZEN, label: ZEN, efforts: [] },
      { id: NV, label: NV, efforts: [] },
    ],
    def,
  )

describe('OpenCode: its default model is the key of a model the CLI does not name', () => {
  test("a task or coordinator with OpenCode's own default counts on the model it starts on, not on a provider's unknown", () => {
    setModels('opencode', listed(GO))
    try {
      expect(keyOf('opencode')).toBe(GO)
      expect(keyOf('opencode', 'default')).toBe(GO)
      // a model it lists is kept as it is: its key is its provider's
      expect(keyOf('opencode', NV)).toBe(NV)
      expect(keyOf('opencode', ZEN)).toBe(ZEN)
    } finally {
      setModels('opencode', undefined)
    }
  })

  test('without a default OpenCode names, its own is unknown under its name (never another provider)', () => {
    setModels('opencode', listed())
    try {
      expect(keyOf('opencode')).toBe('opencode/unknown')
      expect(labelOf('opencode/unknown')).toBe('OpenCode default')
    } finally {
      setModels('opencode', undefined)
    }
  })

  test('a model keeps its provider as OpenCode writes it: the usage of a call is the key of its model, slashes and all', () => {
    expect(modelKey('opencode', NV)).toBe(NV)
    expect(modelKey('opencode', 'opencode-go/deepseek-v4.1-flash')).toBe(modelKey('pi', GO))
  })
})

describe('OpenCode: the names of its providers and models', () => {
  test('the providers OpenCode adds have their names; a provider with none shows its id', () => {
    expect(providerName('opencode')).toBe('OpenCode Zen (free)')
    expect(providerName('nvidia')).toBe('NVIDIA API')
    expect(providerName('opencode-go')).toBe('OpenCode Go')
    expect(providerName('someone-new')).toBe('someone-new')
  })

  test("OpenCode's local servers are local: no quota is warned about for them; a cloud provider is not", () => {
    expect(LOCAL.has('lmstudio')).toBe(true)
    expect(LOCAL.has('ollama')).toBe(true)
    expect(providerName('ollama')).toBe('Ollama (local)')
    expect(LOCAL.has('nvidia')).toBe(false)
    expect(LOCAL.has('opencode')).toBe(false)
  })

  test("a model OpenCode lists is named as its list says, under its provider's row; one it does not list keeps its id", () => {
    setModels('opencode', listed(GO))
    try {
      expect(labelOf(GO)).toBe('deepseek-v4.1-flash')
      expect(labelOf(ZEN)).toBe('minimax-m3.1-flash-free')
      // not in OpenCode's list (nor pi's): its own id, under its provider
      expect(labelOf('nvidia/z-ai/glm-9')).toBe('z-ai/glm-9')
      // Claude Code's and Codex's words are their own, whatever OpenCode lists under their names
      expect(labelOf('anthropic/claude-opus-5-5')).toBe('Opus 5.5')
    } finally {
      setModels('opencode', undefined)
    }
  })
})

describe('OpenCode Go: the calls of both CLIs are one plan', () => {
  test("pi's and OpenCode's calls of opencode-go land under one key, so one estimate counts both", () => {
    const dir = tmp('opencode-plan')
    const l = new UsageLedger(dir, true)
    // a pi call and an OpenCode call of the same model, both an hour ago
    l.count('T-1/Agent', modelKey('pi', GO), { id: 'pi-1', at: NOW - HOUR, tokens: 300, cost: 0.2 }, NOW)
    l.count('T-2/Agent', modelKey('opencode', GO), { id: 'oc-1', at: NOW - HOUR, tokens: 700, cost: 0.5 }, NOW)
    // an OpenCode Zen call is not the Go plan's
    l.count('T-2/Agent', modelKey('opencode', ZEN), { id: 'zen-1', at: NOW - HOUR, tokens: 9999 }, NOW)
    const est = opencodeEstimate(l, NOW)!
    expect(est.windows.find((w) => w.name === '5 h')).toMatchObject({ used: 1000, cost: 0.7 })
    expect(est.windows.find((w) => w.name === 'Week')).toMatchObject({ used: 1000 })
  })

  test('a provider OpenCode adds (Zen, NVIDIA) gets a row of its own with its models, and no quota', () => {
    const dir = tmp('opencode-rows')
    const l = new UsageLedger(dir, true)
    l.count('T-1/Agent', modelKey('opencode', ZEN), { id: 'z1', at: NOW - HOUR, tokens: 50 }, NOW)
    l.count('T-1/Agent', modelKey('opencode', NV), { id: 'n1', at: NOW - HOUR, tokens: 80 }, NOW)
    setModels('opencode', listed(GO))
    try {
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
      const sum = modelsSummary(input)
      const zen = sum.providers.find((p) => p.provider === 'opencode')!
      expect(zen).toMatchObject({ name: 'OpenCode Zen (free)', local: false })
      expect(zen.models.map((m) => m.label)).toEqual(['minimax-m3.1-flash-free'])
      expect(zen.quota).toBeUndefined()
      expect(sum.providers.find((p) => p.provider === 'nvidia')).toMatchObject({ name: 'NVIDIA API' })
    } finally {
      setModels('opencode', undefined)
    }
  })
})

describe('OpenCode: its model and variant are kept, compared and written like the others', () => {
  test('a Settings write takes an OpenCode model by its id and a variant its model has; another model or level is refused, and it says what fits', () => {
    setModels('opencode', listed(GO))
    try {
      const s = new Settings()
      expect(s.set('task.agent', 'OpenCode').ok).toBe(true)
      expect(s.set('task.model', GO).ok).toBe(true)
      expect(s.set('task.effort', 'high').ok).toBe(true)
      expect(s.set('task.effort', 'low')).toMatchObject({ ok: false, error: expect.stringContaining('takes default · high') })
      expect(s.set('task.model', 'opencode/nope')).toMatchObject({ ok: false, error: expect.stringContaining('OpenCode has no model opencode/nope') })
      // the models with no variant take no effort at all
      expect(s.set('task.model', ZEN).ok).toBe(true)
      expect(s.set('task.effort', 'high')).toMatchObject({ ok: false, error: expect.stringContaining('has no effort levels') })
    } finally {
      setModels('opencode', undefined)
    }
  })

  test('two OpenCode harnesses are the same when their model and variant are: a default level is the model without one', () => {
    setModels('opencode', listed(GO))
    try {
      expect(sameHarness({ kind: 'opencode', model: GO, effort: 'high' }, { kind: 'opencode', model: GO, effort: 'high' })).toBe(true)
      expect(sameHarness({ kind: 'opencode', model: GO }, { kind: 'opencode', model: GO, effort: 'default' })).toBe(true)
      expect(sameHarness({ kind: 'opencode', model: GO, effort: 'high' }, { kind: 'opencode', model: GO })).toBe(false)
      expect(sameHarness({ kind: 'opencode', model: GO }, { kind: 'opencode', model: ZEN })).toBe(false)
      // the same model and variant on Claude Code or pi is another CLI
      expect(sameHarness({ kind: 'opencode', model: GO }, { kind: 'pi', model: GO })).toBe(false)
    } finally {
      setModels('opencode', undefined)
    }
  })
})
