// models.maxAtOnce: the most agents at once per provider or per model on this machine. Its text is parsed and checked
// (shared/model-caps.ts), kept at the machine's level or Everywhere (never a space's), and the entry that caps a model is
// its own model entry, else its provider's (capFor).
import { describe, expect, test } from 'bun:test'
import { capFor, formatMaxAtOnce, MAX_CAP_ENTRIES, parseMaxAtOnce, providerOfKey } from '../shared/model-caps.ts'
import { Settings } from '../server/live/settings.ts'

const fresh = () => new Settings({ everywhere: {}, machine: {}, spaces: {} })

describe('the text of models.maxAtOnce', () => {
  test('parses providers and model keys, lowercased, in the order written', () => {
    expect(parseMaxAtOnce('spark=4, radeon=1')).toEqual({ ok: true, entries: [{ pattern: 'spark', max: 4 }, { pattern: 'radeon', max: 1 }] })
    expect(parseMaxAtOnce(' Spark = 4 ,anthropic/Claude-Opus-5-5=2 ,commandcode/deepseek/deepseek-v4.1-flash=3')).toEqual({
      ok: true,
      entries: [
        { pattern: 'spark', max: 4 },
        { pattern: 'anthropic/claude-opus-5-5', max: 2 },
        { pattern: 'commandcode/deepseek/deepseek-v4.1-flash', max: 3 },
      ],
    })
  })

  test('empty and off are no entries', () => {
    expect(parseMaxAtOnce('')).toEqual({ ok: true, entries: [] })
    expect(parseMaxAtOnce('  OFF ')).toEqual({ ok: true, entries: [] })
  })

  test('refuses what it cannot read, each with the words to fix it', () => {
    const hint = 'Write provider=number or model=number'
    const bad = [
      ['spark', 'spark is no provider or model'],
      ['spark=', 'spark needs a whole number from 1 to 200, not "nothing"'],
      ['spark=0', 'spark needs a whole number from 1 to 200, not "0"'],
      ['spark=201', 'spark needs a whole number'],
      ['spark=2.5', 'spark needs a whole number'],
      ['spark=four', 'spark needs a whole number'],
      ['spark=2,,radeon=1', 'An entry is empty'],
      ['=2', 'is no provider or model'],
      ['Bad Name=2', 'is no provider or model'],
      ['spark=2, spark=3', 'spark is set twice'],
    ] as const
    for (const [text, words] of bad) {
      const r = parseMaxAtOnce(text)
      expect(r.ok).toBe(false)
      expect(r.ok ? '' : r.error).toContain(words)
      expect(r.ok ? '' : r.error).toContain(hint)
    }
    const many = Array.from({ length: MAX_CAP_ENTRIES + 1 }, (_, i) => `p${i}=1`).join(', ')
    expect(parseMaxAtOnce(many)).toMatchObject({ ok: false, error: expect.stringContaining(`At most ${MAX_CAP_ENTRIES} entries`) })
  })

  test('formats entries back to the text it reads', () => {
    expect(formatMaxAtOnce([{ pattern: 'spark', max: 4 }, { pattern: 'radeon', max: 1 }])).toBe('spark=4, radeon=1')
    expect(formatMaxAtOnce([])).toBe('')
  })

  test('a model key names its provider; a model entry caps its model, else its provider caps it', () => {
    expect(providerOfKey('spark/qwen3.8-flash')).toBe('spark')
    expect(providerOfKey('pi')).toBe('pi')
    const entries = [{ pattern: 'spark', max: 4 }, { pattern: 'spark/qwen3.8-flash', max: 2 }, { pattern: 'anthropic/claude-opus-5-5', max: 1 }]
    expect(capFor(entries, 'spark/qwen3.8-flash')).toEqual({ pattern: 'spark/qwen3.8-flash', max: 2 })
    expect(capFor(entries, 'spark/other')).toEqual({ pattern: 'spark', max: 4 })
    expect(capFor(entries, 'Spark/Other')).toEqual({ pattern: 'spark', max: 4 })
    expect(capFor(entries, 'anthropic/claude-sonnet')).toBeUndefined()
    expect(capFor(entries, 'anthropic/claude-opus-5-5')).toEqual({ pattern: 'anthropic/claude-opus-5-5', max: 1 })
    // a provider's entry never matches a model of another provider with the same name
    expect(capFor([{ pattern: 'spark', max: 1 }], 'radeon/spark')).toBeUndefined()
  })
})

describe('models.maxAtOnce in Settings', () => {
  test('its row sits in the Machine section at Everywhere and this machine, and never at a space', () => {
    const s = fresh()
    const section = (level: string) => s.sections([], [], null, 'host', ['web']).find((x) => x.level === level && x.name === 'Machine')
    for (const level of ['all', 'm:host']) expect(section(level)?.rows.find((r) => r.key === 'models.maxAtOnce')).toMatchObject({ label: 'Max at once per model or provider', value: 'off', text: true })
    expect(section('p:host:web')).toBeUndefined()
    expect(s.set('models.maxAtOnce', 'spark=4', { space: 'web' }).ok).toBe(false)
  })

  test('is set and read at Everywhere or this machine; the most specific wins; off clears it', () => {
    const s = fresh()
    expect(s.maxAtOnce()).toEqual([])
    expect(s.set('models.maxAtOnce', 'spark=4', 'all').ok).toBe(true)
    expect(s.maxAtOnce()).toEqual([{ pattern: 'spark', max: 4 }])
    expect(s.set('models.maxAtOnce', 'radeon=1 ,spark/qwen3.8=2', 'machine').ok).toBe(true)
    expect(s.pick('models.maxAtOnce', 'machine')).toEqual({ value: 'radeon=1, spark/qwen3.8=2', from: 'machine' })
    expect(s.maxAtOnce()).toEqual([{ pattern: 'radeon', max: 1 }, { pattern: 'spark/qwen3.8', max: 2 }])
    // off at this machine is no cap here, whatever Everywhere says; a reset takes it back to Everywhere's
    expect(s.set('models.maxAtOnce', 'off', 'machine').ok).toBe(true)
    expect(s.maxAtOnce()).toEqual([])
    expect(s.set('models.maxAtOnce', null, 'machine').ok).toBe(true)
    expect(s.maxAtOnce()).toEqual([{ pattern: 'spark', max: 4 }])
    expect(s.set('models.maxAtOnce', null, 'all').ok).toBe(true)
    expect(s.maxAtOnce()).toEqual([])
  })

  test('a refused value is said with its fix and nothing is written', () => {
    const s = fresh()
    const r = s.set('models.maxAtOnce', 'spark=0', 'all')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('spark needs a whole number from 1 to 200')
    expect(s.pick('models.maxAtOnce', 'all').from).toBe('default')
  })

  test('the lines Shepherdr shows print the value as kept', () => {
    const s = fresh()
    s.set('models.maxAtOnce', 'Spark=4', 'machine')
    expect(s.lines(undefined, 'host')).toContain('models.maxAtOnce           spark=4  (host)')
  })
})
