// Each CLI's models and effort levels, as read from the CLI itself (models.ts): what its output looks like here
import { describe, expect, test } from 'bun:test'
import { chmodSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { offers, agyFrom, claudeFrom, codexFrom, effortFor, effortsOf, findModel, helpLevels, installOf, knowsModels, modelArg, modelsOf, nearest, opencodeFrom, opencodeList, parseClaude, parseCodex, parsePi, piEnabled, piFrom, read, scopeModels, scopeOpencodeText, scopePatterns, scopePi, setModels, setOpencodeScope, stillHolds } from '../server/live/models.ts'
import { opencodeConfigDir, opencodeDataDir } from '../server/live/opencode.ts'
import { tmp } from './tmp.ts'

describe('reading what each CLI takes', () => {
  test("Claude Code's catalog: the newest of each family, its levels by capability, older ones by id", () => {
    const grep = [
      '{id:"claude-haiku-4-5",family:"haiku",display_name:"Haiku 4.5"',
      'capabilities:["context_management"]',
      '{id:"claude-haiku-5-5",family:"haiku",display_name:"Haiku 5.5"',
      'capabilities:["effort","max_effort","xhigh_effort"]',
      'default_effort:"medium"',
      '{id:"claude-sonnet-4-6",family:"sonnet",display_name:"Sonnet 4.6"',
      'capabilities:["effort","max_effort"]',
      '{id:"claude-opus-5-5",family:"opus",display_name:"Opus 5.5"',
      'capabilities:["effort","max_effort","xhigh_effort"]',
      'default_effort:"medium"',
      '{id:"claude-fable-5-1",family:"fable",display_name:"Fable 5.1"',
      'capabilities:["effort","xhigh_effort"]',
      'default_effort:"high"',
      // another catalog's later in the file: not a model's
      'capabilities:["web_search"]',
      'default_effort:"xhigh"',
    ].join('\n')
    const help = '  --effort <level>                      Effort level for the current session\n                                        (low, medium, high, xhigh, max)\n'
    const c = parseClaude(grep, help)!
    expect(c.models.map((m) => [m.label, m.efforts.join(' '), m.effort])).toEqual([
      ['Fable 5.1', 'low medium high xhigh', 'high'],
      ['Opus 5.5', 'low medium high xhigh max', 'medium'],
      ['Sonnet 4.6', 'low medium high max', undefined],
      ['Haiku 5.5', 'low medium high xhigh max', 'medium'],
    ])
    expect(c.others!.map((m) => [m.id, m.efforts])).toEqual([['claude-haiku-4-5', []]])
    expect(c.default).toBe('claude-opus-5-5')
    expect(parseClaude('', help)).toBeUndefined()
  })
  test("Codex's catalog: the models its picker lists, hidden ones still taken, levels lowest first", () => {
    const json = JSON.stringify({
      models: [
        { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'ultra' }, { effort: 'low' }, { effort: 'high' }] },
        { slug: 'auto-review', display_name: 'Auto Review', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
      ],
    })
    const c = parseCodex(json)!
    expect(c.models).toEqual([{ id: 'gpt-6-sol', label: 'GPT-6-Sol', efforts: ['low', 'high', 'ultra'] }])
    expect(c.others!.map((m) => m.id)).toEqual(['auto-review'])
    expect(c.efforts).toEqual(['low', 'high', 'ultra'])
    expect(parseCodex('not json')).toBeUndefined()
  })
  test("pi's list: provider/model ids and names, levels only where it thinks", () => {
    const list = ['provider  model            context  thinking  images', 'openai    gpt-6@x          1M       yes       yes', 'anthro    claude@x         1M       no        yes', 'other     gpt-6@x          1M       yes       no'].join('\n')
    const help = '  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh, max\n'
    expect(helpLevels(help, '--thinking')).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    const c = parsePi(list, help)!
    expect(c.models.map((m) => [m.id, m.label, m.efforts.length])).toEqual([
      ['openai/gpt-6@x', 'openai/gpt-6@x', 7],
      ['anthro/claude@x', 'anthro/claude@x', 0],
      ['other/gpt-6@x', 'other/gpt-6@x', 7],
    ])
    setModels('pi', c)
    try {
      expect(findModel('pi', 'claude@x')?.id).toBe('anthro/claude@x')
      // a model that doesn't think gets no level
      expect(effortFor('pi', 'high', 'claude@x')).toBeUndefined()
      expect(effortFor('pi', 'ultra', 'openai/gpt-6@x')).toBe('max')
    } finally {
      setModels('pi', undefined)
    }
  })
  test("pi's enabledModels scope its list, in their order, the rest kept by id", () => {
    const m = (id: string) => ({ id, label: id, efforts: [] })
    const c = { models: ['anthropic/claude-opus-5-5', 'anthropic/claude-haiku-4-5', 'commandcode/deepseek/v4', 'openrouter/deepseek/v4', 'spark/qwen'].map(m), efforts: [] }
    const s = scopePi(c, ['spark/qwen', 'ANTHROPIC/claude-opus-*:high', 'deepseek/v4', 'nothing/here'])
    expect(s.models.map((x) => x.id)).toEqual(['spark/qwen', 'anthropic/claude-opus-5-5', 'commandcode/deepseek/v4', 'openrouter/deepseek/v4'])
    expect(s.others!.map((x) => x.id)).toEqual(['anthropic/claude-haiku-4-5'])
    // no settings, or none of them matching: the whole list
    expect(scopePi(c, undefined)).toBe(c)
    expect(scopePi(c, ['nothing/here'])).toBe(c)
    const dir = tmp('pi-settings')
    const was = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = dir
    try {
      expect(piEnabled()).toBeUndefined()
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledModels: ['spark/qwen', 3, ''] }))
      expect(piEnabled()).toEqual(['spark/qwen'])
      setModels('pi', c)
      expect(findModel('pi', 'claude-haiku-4-5')?.id).toBe('anthropic/claude-haiku-4-5')
      // a list read before names had their provider gets it too
      setModels('pi', { models: [{ id: 'spark/qwen', label: 'qwen', efforts: [] }], efforts: [] })
      expect(modelsOf('pi')!.models.map((x) => x.label)).toEqual(['spark/qwen'])
    } finally {
      setModels('pi', undefined)
      if (was === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = was
    }
  })
  test("pi's list is asked again as soon as its models.json, its logins or its settings change, and every few hours anyway", () => {
    const dir = tmp('pi-from')
    const models = join(dir, 'models.json')
    // no files yet: a pi with nothing of its own
    const none = piFrom(dir)
    expect(none).toBe('models.json@0 auth.json@0 settings.json@0')
    writeFileSync(models, '{"providers":{}}')
    utimesSync(models, new Date(), new Date(1_800_000_000_000))
    const one = piFrom(dir)
    expect(one).not.toBe(none)
    // looked at again with nothing changed: the same
    expect(piFrom(dir)).toBe(one)
    // a model added to a provider (the Spark's new resident)
    utimesSync(models, new Date(), new Date(1_800_000_060_000))
    const two = piFrom(dir)
    expect(two).not.toBe(one)
    // a new login
    writeFileSync(join(dir, 'auth.json'), '{}')
    expect(piFrom(dir)).not.toBe(two)
    // a model added to its enabledModels: OpenRouter's models are listed only once named there
    const login = piFrom(dir)
    writeFileSync(join(dir, 'settings.json'), '{"enabledModels":["openrouter/thinkingmachines/inkling-2-small:free"]}')
    expect(piFrom(dir)).not.toBe(login)
    const kept = { models: [{ id: 'spark/qwen', label: 'spark/qwen', efforts: [] }], efforts: [], from: two, at: 1_000 }
    expect(stillHolds('pi', kept, two, 2_000)).toBe(true)
    expect(stillHolds('pi', kept, piFrom(dir), 2_000)).toBe(false)
    // one kept before pi's files were looked at holds nothing: it is asked again once
    expect(stillHolds('pi', { ...kept, from: undefined }, two, 2_000)).toBe(false)
    expect(stillHolds('pi', kept, two, 1_000 + 6 * 3_600_000)).toBe(false)
    // claude by its install alone; none kept holds nothing
    expect(stillHolds('claude', { ...kept, from: 'bin@1' }, 'bin@1', 1e15)).toBe(true)
    expect(stillHolds('claude', { ...kept, from: 'bin@1' }, 'bin@2', 2_000)).toBe(false)
    expect(stillHolds('pi', undefined, two)).toBe(false)
  })
  test("Codex's list is asked again as soon as its config or its install changes, and every few hours anyway", () => {
    const dir = tmp('codex-from')
    const config = join(dir, 'config.toml')
    const none = codexFrom(dir, '@0')
    expect(none).toBe('config.toml@0 @0')
    // a config written (a model provider or a profile added)
    writeFileSync(config, 'model = "gpt-6"')
    utimesSync(config, new Date(), new Date(1_800_000_000_000))
    const one = codexFrom(dir, '@0')
    expect(one).not.toBe(none)
    expect(codexFrom(dir, '@0')).toBe(one)
    utimesSync(config, new Date(), new Date(1_800_000_060_000))
    const two = codexFrom(dir, '@0')
    expect(two).not.toBe(one)
    // a new install
    const newer = codexFrom(dir, '/opt/codex@5')
    expect(newer).not.toBe(two)
    const kept = { models: [{ id: 'gpt-6', label: 'gpt-6', efforts: [] }], efforts: [], from: two, at: 1_000 }
    expect(stillHolds('codex', kept, two, 2_000)).toBe(true)
    expect(stillHolds('codex', kept, newer, 2_000)).toBe(false)
    expect(stillHolds('codex', { ...kept, from: undefined }, two, 2_000)).toBe(false)
    expect(stillHolds('codex', kept, two, 1_000 + 6 * 3_600_000)).toBe(false)
  })
  test("OpenCode's list is asked again as soon as its config, its logins or its install changes, and every few hours anyway", () => {
    const config = tmp('opencode-config')
    const data = tmp('opencode-data')
    const none = opencodeFrom(config, data, '@0')
    expect(none).toBe('opencode.json@0 opencode.jsonc@0 auth.json@0 @0')
    // a provider added to its config
    writeFileSync(join(config, 'opencode.jsonc'), '{}')
    utimesSync(join(config, 'opencode.jsonc'), new Date(), new Date(1_800_000_000_000))
    const one = opencodeFrom(config, data, '@0')
    expect(one).not.toBe(none)
    expect(opencodeFrom(config, data, '@0')).toBe(one)
    utimesSync(join(config, 'opencode.jsonc'), new Date(), new Date(1_800_000_060_000))
    const two = opencodeFrom(config, data, '@0')
    expect(two).not.toBe(one)
    // a new login
    writeFileSync(join(data, 'auth.json'), '{}')
    const login = opencodeFrom(config, data, '@0')
    expect(login).not.toBe(two)
    // a new install
    const newer = opencodeFrom(config, data, '/opt/opencode@5')
    expect(newer).not.toBe(login)
    const kept = { models: [{ id: 'nvidia/z-ai/glm', label: 'glm', efforts: [] }], efforts: [], from: login, at: 1_000 }
    expect(stillHolds('opencode', kept, login, 2_000)).toBe(true)
    expect(stillHolds('opencode', kept, newer, 2_000)).toBe(false)
    expect(stillHolds('opencode', kept, login, 1_000 + 6 * 3_600_000)).toBe(false)
  })
  test("Antigravity's list is asked again as soon as its settings or its install change, and every few hours anyway", () => {
    const dir = tmp('agy-from')
    const settings = join(dir, 'settings.json')
    const none = agyFrom(dir, '@0')
    expect(none).toBe('settings.json@0 @0')
    // a custom model added to its settings
    writeFileSync(settings, '{"customModels":[]}')
    utimesSync(settings, new Date(), new Date(1_800_000_000_000))
    const one = agyFrom(dir, '@0')
    expect(one).not.toBe(none)
    expect(agyFrom(dir, '@0')).toBe(one)
    utimesSync(settings, new Date(), new Date(1_800_000_060_000))
    const two = agyFrom(dir, '@0')
    expect(two).not.toBe(one)
    // a new install
    const newer = agyFrom(dir, '/opt/agy@5')
    expect(newer).not.toBe(two)
    const kept = { models: [{ id: 'gemini-3.8-flash', label: 'gemini', efforts: [] }], efforts: [], from: two, at: 1_000 }
    expect(stillHolds('agy', kept, two, 2_000)).toBe(true)
    expect(stillHolds('agy', kept, newer, 2_000)).toBe(false)
    expect(stillHolds('agy', { ...kept, from: undefined }, two, 2_000)).toBe(false)
    expect(stillHolds('agy', kept, two, 1_000 + 6 * 3_600_000)).toBe(false)
  })
  test("an install is its path and when it changed (@0 when there is none); claude's is undefined when there is none", () => {
    expect(installOf('sh')).toMatch(/^\/.+@[\d.]+$/)
    expect(installOf('shepherdr-no-such-cli')).toBe('@0')
    expect(claudeFrom('@0')).toBeUndefined()
    expect(claudeFrom('/opt/claude@5')).toBe('/opt/claude@5')
  })
  test("OpenCode's folders follow XDG_CONFIG_HOME and XDG_DATA_HOME, or ~/.config and ~/.local/share", () => {
    const was = [process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME]
    try {
      process.env.XDG_CONFIG_HOME = tmp('xdg-config')
      process.env.XDG_DATA_HOME = tmp('xdg-data')
      expect(opencodeConfigDir()).toBe(join(process.env.XDG_CONFIG_HOME, 'opencode'))
      expect(opencodeDataDir()).toBe(join(process.env.XDG_DATA_HOME, 'opencode'))
    } finally {
      if (was[0] === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = was[0]
      if (was[1] === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = was[1]
    }
    expect(opencodeConfigDir()).toMatch(/[/\\]opencode$/)
  })

  test("pi's scoped list is kept while neither its list nor its enabledModels change", () => {
    // a snapshot asks for pi's models thousands of times (each place's restart hint): scoping them every time made it
    // take seconds, and the screen never loaded
    const m = (id: string) => ({ id, label: id, efforts: [] })
    const c = { models: ['spark/qwen', 'openrouter/deepseek/v4'].map(m), efforts: [] }
    const dir = tmp('pi-scope-kept')
    const file = join(dir, 'settings.json')
    const was = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = dir
    try {
      writeFileSync(file, JSON.stringify({ enabledModels: ['deepseek/*'] }))
      setModels('pi', c)
      const first = modelsOf('pi')!
      expect(first.models.map((x) => x.id)).toEqual(['openrouter/deepseek/v4'])
      // asked again with nothing changed: the very same list, not scoped again
      expect(modelsOf('pi')).toBe(first)
      // its enabledModels changed: scoped again
      writeFileSync(file, JSON.stringify({ enabledModels: ['spark/*'] }))
      utimesSync(file, new Date(), new Date(Date.now() + 5000))
      expect(modelsOf('pi')!.models.map((x) => x.id)).toEqual(['spark/qwen'])
      // a new list from the CLI: scoped again
      setModels('pi', { ...c, models: [...c.models, m('spark/other')] })
      expect(modelsOf('pi')!.models.map((x) => x.id)).toEqual(['spark/qwen', 'spark/other'])
    } finally {
      setModels('pi', undefined)
      if (was === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = was
    }
  })
  test('a level a model lacks becomes the nearest it has, a tie going lower', () => {
    expect(nearest(['low', 'medium', 'high'], 'max')).toBe('high')
    expect(nearest(['low', 'high'], 'medium')).toBe('low')
    expect(nearest(['off', 'low'], 'none')).toBe('off')
    expect(nearest(['low'], 'nonsense')).toBeUndefined()
    expect(nearest(['low'], 'default')).toBeUndefined()
    // aliases name a family's newest
    expect(findModel('claude', 'sonnet')?.id).toBe('claude-sonnet-5-5')
    expect(findModel('claude', 'HAIKU 5.5')?.id).toBe('claude-haiku-5-5')
  })

  test('a level with no rank is taken only as it is written; the nearest is picked among the ranked ones', () => {
    expect(nearest(['thinking', 'high'], 'thinking')).toBe('thinking')
    expect(nearest(['thinking', 'high'], 'low')).toBe('high')
    expect(nearest(['none', 'thinking'], 'low')).toBe('none')
    expect(nearest(['low', 'thinking'], 'medium')).toBe('low')
    expect(nearest(['thinking', 'default'], 'high')).toBeUndefined()
    expect(nearest(['thinking', 'default'], 'thinking')).toBe('thinking')
    expect(nearest(['thinking'], 'max')).toBeUndefined()
    // a level that has no rank asks for nothing nearer
    expect(nearest(['low', 'high'], 'thinking')).toBeUndefined()
  })
})

describe('OpenCode: its own models and variants', () => {
  test('its enabled models with their variants as efforts; the levels of all of them, ranked ones first', async () => {
    const dir = tmp('models-opencode')
    const bin = join(dir, 'opencode')
    const data = [
      { id: 'minimax-m3.1-flash-free', providerID: 'opencode', name: 'MiniMax M3.1 Flash', variants: [{ id: 'high' }, { id: 'thinking' }, { id: 'none' }], enabled: true },
      { id: 'z-ai/glm-5.3-flash', providerID: 'nvidia', name: 'GLM 5.3 Flash', variants: [{ id: 'default' }, { id: 'low' }], enabled: true },
      { id: 'old', providerID: 'opencode', name: 'Old', variants: [{ id: 'max' }], enabled: false },
    ]
    // a stand-in for `opencode api --standalone model.list` (and model.default): prints the answer and nothing else
    writeFileSync(bin, `#!/bin/sh
case "$*" in
  *model.default*) printf '%s' '${JSON.stringify({ data: data[0] })}' ;;
  *) printf '%s' '${JSON.stringify({ data })}' ;;
esac
`)
    chmodSync(bin, 0o755)
    const saved = process.env.SHEPHERDR_OPENCODE_BIN
    process.env.SHEPHERDR_OPENCODE_BIN = bin
    try {
      // the models are named as the CLI takes them, provider first (as pi names its own), grouped by provider
      expect(await read('opencode')).toEqual({
        models: [
          { id: 'nvidia/z-ai/glm-5.3-flash', label: 'nvidia/z-ai/glm-5.3-flash', efforts: ['default', 'low'] },
          { id: 'opencode/minimax-m3.1-flash-free', label: 'opencode/minimax-m3.1-flash-free', efforts: ['high', 'thinking', 'none'] },
        ],
        efforts: ['none', 'low', 'high', 'default', 'thinking'],
        default: 'opencode/minimax-m3.1-flash-free',
      })
    } finally {
      if (saved === undefined) delete process.env.SHEPHERDR_OPENCODE_BIN
      else process.env.SHEPHERDR_OPENCODE_BIN = saved
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a model takes its own variants as its efforts, found by id or name; a model with none takes none', () => {
    setModels('opencode', opencodeList([
      { id: 'opencode/m', label: 'M', efforts: ['thinking', 'high'] },
      { id: 'nvidia/g', label: 'G', efforts: [] },
    ]))
    try {
      expect(effortsOf('opencode', 'opencode/m')).toEqual(['thinking', 'high'])
      expect(effortsOf('opencode', 'M')).toEqual(['thinking', 'high'])
      expect(effortsOf('opencode', 'nvidia/g')).toEqual([])
      expect(findModel('opencode', 'opencode/m')?.id).toBe('opencode/m')
      expect(effortFor('opencode', 'thinking', 'opencode/m')).toBe('thinking')
      expect(effortFor('opencode', 'low', 'opencode/m')).toBe('high')
      expect(knowsModels('opencode')).toBe(true)
    } finally {
      setModels('opencode', undefined)
    }
  })

  test('nothing is listed until OpenCode is asked (no models, no levels); its list holds for six hours, and no pi scoping applies', () => {
    expect(modelsOf('opencode')).toEqual({ models: [], efforts: [] })
    expect(knowsModels('opencode')).toBe(false)
    const now = Date.now()
    const c = { ...opencodeList([{ id: 'opencode/m', label: 'M', efforts: ['high'] }]), at: now }
    expect(stillHolds('opencode', c, undefined, now + 3_600_000)).toBe(true)
    expect(stillHolds('opencode', c, undefined, now + 7 * 3_600_000)).toBe(false)
    // a list kept before its files were looked at holds nothing: asked again once
    expect(stillHolds('opencode', c, 'anything', now)).toBe(false)
  })
})

describe("OpenCode's models scoped by opencode.models", () => {
  const m = (id: string) => ({ id, label: id, efforts: [] })
  const c = { models: ['opencode/minimax-m3.1-flash-free', 'opencode/zen-paid', 'opencode-go/longcat-2.5-free', 'opencode-go/deepseek-v4', 'nvidia/z-ai/glm-5.3-flash'].map(m), efforts: [] }

  test('scopeModels keeps the patterns matches in their order, the rest by id; all, empty and no match keep the list', () => {
    const s = scopeModels(c, ['*-free'])
    expect(s.models.map((x) => x.id)).toEqual(['opencode/minimax-m3.1-flash-free', 'opencode-go/longcat-2.5-free'])
    expect(s.others!.map((x) => x.id)).toEqual(['opencode/zen-paid', 'opencode-go/deepseek-v4', 'nvidia/z-ai/glm-5.3-flash'])
    // a pattern on provider/model, and the order of the patterns
    expect(scopeModels(c, ['opencode-go/*', 'OPENCODE/*-FREE']).models.map((x) => x.id)).toEqual(['opencode-go/longcat-2.5-free', 'opencode-go/deepseek-v4', 'opencode/minimax-m3.1-flash-free'])
    // a nvidia model is found by its model alone (a `*` does not cross the slash of its own vendor)
    expect(scopeModels(c, ['z-ai/glm-*']).models.map((x) => x.id)).toEqual(['nvidia/z-ai/glm-5.3-flash'])
    expect(scopeModels(c, undefined)).toBe(c)
    expect(scopeModels(c, [])).toBe(c)
    expect(scopeModels(c, ['nothing/here'])).toBe(c)
  })

  test('scopePatterns reads the text: commas or spaces, any case; all or empty is every model; junk is refused', () => {
    expect(scopePatterns('*-free')).toEqual(['*-free'])
    expect(scopePatterns(' opencode/*-free ,  OpenCode-Go/longcat-* ')).toEqual(['opencode/*-free', 'opencode-go/longcat-*'])
    expect(scopePatterns('a b,c')).toEqual(['a', 'b', 'c'])
    expect(scopePatterns('all')).toBeUndefined()
    expect(scopePatterns(' ')).toBeUndefined()
    expect(() => scopePatterns('all, *-free')).toThrow('Write all on its own')
    expect(() => scopePatterns('x:high')).toThrow('not a model pattern')
    expect(() => scopePatterns('a$b')).toThrow('not a model pattern')
  })

  test("modelsOf('opencode') follows setOpencodeScope, kept while the list and the patterns hold; the others stay found by id", () => {
    setModels('opencode', { ...c, efforts: [] })
    try {
      expect(modelsOf('opencode')!.models.map((x) => x.id)).toEqual(c.models.map((x) => x.id))
      setOpencodeScope(scopePatterns('*-free'))
      const first = modelsOf('opencode')!
      expect(first.models.map((x) => x.id)).toEqual(['opencode/minimax-m3.1-flash-free', 'opencode-go/longcat-2.5-free'])
      // asked again with nothing changed: the very same list
      expect(modelsOf('opencode')).toBe(first)
      // typed by id, the model outside the menus is still found, and its efforts too
      expect(findModel('opencode', 'opencode-go/deepseek-v4')?.id).toBe('opencode-go/deepseek-v4')
      expect(modelArg('opencode', 'opencode/zen-paid')).toBe('opencode/zen-paid')
      expect(effortsOf('opencode', 'opencode/zen-paid')).toEqual([])
      // no pattern matching: every model again
      setOpencodeScope(scopePatterns('nothing/*'))
      expect(modelsOf('opencode')!.models.length).toBe(c.models.length)
      // all: every model
      setOpencodeScope(undefined)
      expect(modelsOf('opencode')!.models.length).toBe(c.models.length)
    } finally {
      setOpencodeScope(undefined)
      setModels('opencode', undefined)
    }
  })

  test('a junk opencode.models text is logged once and lists every model, never stops the server', () => {
    setModels('opencode', { ...c, efforts: [] })
    const logged: unknown[][] = []
    const was = console.error
    console.error = (...a: unknown[]) => logged.push(a)
    try {
      scopeOpencodeText('*-free, a:b')
      expect(logged).toEqual([['shepherdr: opencode.models ignored: a:b is not a model pattern: use letters, digits, . - _ / and the wildcards * ?']])
      expect(modelsOf('opencode')!.models.length).toBe(c.models.length)
      scopeOpencodeText('*-free')
      expect(logged.length).toBe(1)
      expect(modelsOf('opencode')!.models.length).toBe(2)
    } finally {
      console.error = was
      setOpencodeScope(undefined)
      setModels('opencode', undefined)
    }
  })
})

describe('which harnesses offer a provider', () => {
  test('offers: pi and OpenCode, by their own lists (not scoped), those with a model of the provider', () => {
    setModels('pi', { models: [{ id: 'spark/qwen3', label: 'qwen3', efforts: [] }, { id: 'anthropic/claude-opus-5-5', label: 'x', efforts: [] }], efforts: [] })
    setModels('opencode', { models: [{ id: 'opencode/minimax-m3', label: 'm', efforts: [] }, { id: 'anthropic/claude-haiku-5-5', label: 'h', efforts: [] }], efforts: [] })
    try {
      expect(offers('spark')).toEqual(['pi'])
      expect(offers('anthropic')).toEqual(['pi', 'opencode'])
      expect(offers('opencode')).toEqual(['opencode'])
      expect(offers('openai')).toEqual([])
    } finally {
      setModels('pi', undefined)
      setModels('opencode', undefined)
    }
  })
})
