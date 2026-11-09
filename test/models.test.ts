// Each CLI's models and effort levels, as read from the CLI itself (models.ts): what its output looks like here
import { describe, expect, test } from 'bun:test'
import { utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { effortFor, findModel, helpLevels, modelsOf, nearest, parseClaude, parseCodex, parsePi, piEnabled, scopePi, setModels } from '../server/live/models.ts'
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
})
