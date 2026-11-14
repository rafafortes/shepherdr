// opencode.models in every list a machine shows: the Models summary (Other providers included), the Limits page's + column
// and the Models table's catalog. The menus offer the models the setting keeps; a model that it filters out still shows
// where it has a cap or is in use, and is still usable by id (it stays in the others, never in a list of choices).
import { describe, expect, test } from 'bun:test'
import { modelKey } from '../server/live/usage-ledger.ts'
import { modelsSummary, type SummaryInput } from '../server/live/models-summary.ts'
import { entryPatterns, knownOf } from '../server/live/limits-view.ts'
import { modelsMatrix } from '../server/live/models-matrix.ts'
import { opencodeList, scopeOpencodeText, setModels, setOpencodeScope } from '../server/live/models.ts'
import { placeId } from '../server/live/places.ts'
import { Settings } from '../server/live/settings.ts'
import { UsageLedger } from '../server/live/usage-ledger.ts'
import { tmp } from './tmp.ts'

const NOW = Date.now()
const HOST = 'box'
const SPACES = [{ key: '~', name: 'home' }]
const FREE = 'opencode/minimax-m3.1-flash-free'
const PAID = 'opencode/zen-paid'
const GO_FREE = 'opencode-go/longcat-2.5-free'
const GO_PAID = 'opencode-go/deepseek-v4'
const NV = 'nvidia/z-ai/glm-5.3-flash'
/** the key OpenCode's model id runs under (its harness and provider in front) */
const KEY = (id: string) => modelKey('opencode', id)

const list = opencodeList([
  { id: FREE, label: FREE, efforts: [] },
  { id: PAID, label: PAID, efforts: [] },
  { id: GO_FREE, label: GO_FREE, efforts: [] },
  { id: GO_PAID, label: GO_PAID, efforts: [] },
  { id: NV, label: NV, efforts: [] },
])

function summaryOf(machine: Record<string, string>) {
  const s = new Settings({ everywhere: {}, machine, spaces: {} })
  // as the server reads it: the cap patterns of the machine and its spaces, the providers and models they name
  const capped = entryPatterns(s, ['~'])
  const input: SummaryInput = { now: NOW, settings: s, host: HOST, spaces: SPACES, rows: [placeId.machine(HOST)], usage: new UsageLedger(tmp('opencode-scope-lists'), true), agents: [], tasks: [], watch: [], capped }
  return { s, sum: modelsSummary(input), input }
}

describe('opencode.models in the lists a machine shows', () => {
  test("Other providers and their models follow the setting; a model with a cap shows where it is filtered out, and its provider is in use", () => {
    setModels('opencode', list)
    try {
      scopeOpencodeText('*-free')
      const { sum } = summaryOf({ 'models.maxAtOnce': `${KEY(PAID)}=2` })
      // nvidia has nothing the setting keeps and nothing uses: not listed at all
      expect(sum.providers.map((p) => p.provider)).not.toContain('opencode.nvidia')
      // in use (its cap), the provider lists the models in use: the capped one with its cap, not the free one nothing runs on
      const zen = sum.providers.find((p) => p.provider === 'opencode.opencode')!
      expect(zen.models.map((m) => m.key)).toEqual([KEY(PAID)])
      expect(zen.models[0]!.atOnce.own).toEqual({ pattern: KEY(PAID), max: 2, from: 'machine' })
      expect(zen.idle).toBe(false)
      // the same setting with no cap: the provider is idle, and lists the models the setting keeps, the free one only
      const idle = summaryOf({}).sum.providers.find((p) => p.provider === 'opencode.opencode')!
      expect(idle.idle).toBe(true)
      expect(idle.models.map((m) => m.key)).toEqual([KEY(FREE)])
      // a provider with only the free model left in scope is idle, and lists only that model
      const go = sum.providers.find((p) => p.provider === 'opencode.opencode-go')!
      expect(go.idle).toBe(true)
      expect(go.models.map((m) => m.key)).toEqual([KEY(GO_FREE)])
    } finally {
      scopeOpencodeText('all')
      setModels('opencode', undefined)
    }
  })

  test("the + column and the Models catalog offer the models the setting keeps, plus the capped one; the others are not offered", () => {
    setModels('opencode', list)
    try {
      scopeOpencodeText('*-free')
      const { sum, s } = summaryOf({ 'models.maxAtOnce': `${KEY(PAID)}=2` })
      const matrix = modelsMatrix(s, { host: HOST, name: 'box' }, SPACES)
      const offered = Object.values(matrix.catalog).flatMap((c) => c.models.map((m) => m.id))
      expect(offered).toContain(FREE)
      expect(offered).toContain(GO_FREE)
      expect(offered).not.toContain(GO_PAID)
      expect(offered).not.toContain(NV)
      const known = knownOf(matrix, sum).map((k) => k.pattern)
      expect(known).toContain(KEY(PAID))
      expect(known).toContain(KEY(FREE))
      expect(known).not.toContain(KEY(GO_PAID))
      expect(known).not.toContain(KEY(NV))
      expect(known).not.toContain('opencode.nvidia')
    } finally {
      scopeOpencodeText('all')
      setModels('opencode', undefined)
    }
  })

  test('with the setting at all, every model OpenCode lists is listed and nothing changes', () => {
    setModels('opencode', list)
    try {
      scopeOpencodeText('all')
      const { sum } = summaryOf({})
      expect(sum.providers.find((p) => p.provider === 'opencode.nvidia')!.models.map((m) => m.key)).toEqual([KEY(NV)])
      expect(sum.providers.find((p) => p.provider === 'opencode.opencode')!.models.map((m) => m.key)).toEqual([KEY(FREE), KEY(PAID)])
    } finally {
      setOpencodeScope(undefined)
      setModels('opencode', undefined)
    }
  })
})
