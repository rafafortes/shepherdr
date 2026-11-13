// models.maxAtOnce: the most agents at once per provider or per model on this machine. Its text is parsed and checked
// (shared/model-caps.ts), kept at the machine's level or Everywhere (never a space's), and the entry that caps a model is
// its own model entry, else its provider's (capFor).
import { describe, expect, test } from 'bun:test'
import { capFor, formatMaxAtOnce, levelText, MAX_CAP_ENTRIES, parseMaxAtOnce, providerOfKey, withEntry } from '../shared/model-caps.ts'
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

  test("a space's sub-limit is written from its own text only: a space that sets none copies nothing of the machine's", () => {
    // this machine sets spark=4 and radeon=1; the space sets nothing of its own yet
    const texts = { all: '', machine: 'spark=4, radeon=1', space: '' }
    expect(levelText('space', texts)).toBe('')
    // saving spark=2 for the space writes that entry alone, never the machine's radeon=1 along with it
    expect(withEntry(levelText('space', texts), 'spark', 2)).toBe('spark=2')
    // a space's own entries stay as they are when another one changes, and clearing takes only that one out
    const own = { ...texts, space: 'spark=2, anthropic=1' }
    expect(withEntry(levelText('space', own), 'spark', 3)).toBe('anthropic=1, spark=3')
    expect(withEntry(levelText('space', own), 'spark')).toBe('anthropic=1')
    // the machine's own write still starts from Everywhere's entries while the machine sets none
    expect(levelText('machine', { all: 'radeon=1', machine: '', space: '' })).toBe('radeon=1')
    // an unreadable text keeps none of its entries: the write sets only the one it was given
    expect(withEntry('not a cap', 'spark', 2)).toBe('spark=2')
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
  test('its row sits in the Space section, at Everywhere, this machine and each space: the machine total and a space sub-limit', () => {
    const s = fresh()
    const section = (level: string) => s.sections([], [], null, 'host', ['web']).find((x) => x.level === level && x.name === 'Space')
    for (const level of ['all', 'm:host', 'p:host:web']) expect(section(level)?.rows.find((r) => r.key === 'models.maxAtOnce')).toMatchObject({ label: 'Most at once per model or provider', value: 'off', text: true })
    expect(s.set('models.maxAtOnce', 'spark=4', { space: 'web' }).ok).toBe(true)
  })

  test("a space's own value is its sub-limit: the machine's total is read at the machine, and neither replaces the other", () => {
    const s = fresh()
    expect(s.set('models.maxAtOnce', 'spark=4', 'machine').ok).toBe(true)
    // a space without its own value reads the machine's (the same entries: the total holds for it)
    expect(s.maxAtOnce('web')).toEqual([{ pattern: 'spark', max: 4 }])
    expect(s.set('models.maxAtOnce', 'spark=2', { space: 'web' }).ok).toBe(true)
    expect(s.maxAtOnce('web')).toEqual([{ pattern: 'spark', max: 2 }])
    expect(s.maxAtOnce()).toEqual([{ pattern: 'spark', max: 4 }])
    expect(s.maxAtOnce('api')).toEqual([{ pattern: 'spark', max: 4 }])
    // off at the space: no sub-limit of its own, and the machine's total still holds for it
    expect(s.set('models.maxAtOnce', 'off', { space: 'web' }).ok).toBe(true)
    expect(s.maxAtOnce('web')).toEqual([])
    expect(s.maxAtOnce()).toEqual([{ pattern: 'spark', max: 4 }])
    // a reset takes the space's own value away, back to the machine's
    expect(s.set('models.maxAtOnce', null, { space: 'web' }).ok).toBe(true)
    expect(s.maxAtOnce('web')).toEqual([{ pattern: 'spark', max: 4 }])
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
