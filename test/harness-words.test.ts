// The harness's names in the screens: a provider outside its group reads "<harness> · <provider>", a pattern with a dot reads the
// same way, and the providers group under their harness in a fixed order, a single-account CLI's own row with no heading.
import { describe, expect, test } from 'bun:test'
import { harnessGroups, inHarness, patternWords } from '../shared/harness.ts'

describe('a provider named outside its harness group', () => {
  test('reads "harness · provider", and a single-account CLI reads its own name alone', () => {
    expect(inHarness('pi', 'Spark (local)')).toBe('pi · Spark (local)')
    expect(inHarness('OpenCode', 'OpenCode Go')).toBe('OpenCode · OpenCode Go')
    expect(inHarness('Claude Code', 'Claude Code')).toBe('Claude Code')
  })

  test('a pattern with a dot after its harness reads as " · " (pi.spark → pi · spark), and a model key keeps its model', () => {
    expect(patternWords('pi.spark')).toBe('pi · spark')
    expect(patternWords('pi.spark/qwen3.8-flash-next-mlx4-mtp-tensorfold')).toBe('pi · spark/qwen3.8-flash-next-mlx4-mtp-tensorfold')
    expect(patternWords('pi.commandcode/deepseek/deepseek-v4.1-flash')).toBe('pi · commandcode/deepseek/deepseek-v4.1-flash')
    expect(patternWords('opencode.opencode-go')).toBe('opencode · opencode-go')
  })

  test('a pattern with no harness part is unchanged: a single-account CLI, a bare provider, a model without a dot before its slash', () => {
    expect(patternWords('claude/claude-opus-5-5')).toBe('claude/claude-opus-5-5')
    expect(patternWords('spark')).toBe('spark')
    expect(patternWords('pi')).toBe('pi')
    expect(patternWords('codex/gpt-6.1')).toBe('codex/gpt-6.1')
  })
})

describe('providers grouped under their harness', () => {
  const p = (harness: string, harnessName: string, name: string) => ({ harness, harnessName, name })

  test('the groups come in the fixed order, a harness with no provider has no group, and any other harness follows', () => {
    const list = [p('pi', 'pi', 'Spark (local)'), p('opencode', 'OpenCode', 'OpenCode Go'), p('zed', 'Zed', 'Zed AI'), p('claude', 'Claude Code', 'Claude Code'), p('pi', 'pi', 'OpenCode Go')]
    const groups = harnessGroups(list)
    expect(groups.map((g) => g.harness)).toEqual(['claude', 'pi', 'opencode', 'zed'])
    expect(groups.map((g) => g.name)).toEqual(['Claude Code', 'pi', 'OpenCode', 'Zed'])
    expect(groups.map((g) => g.single)).toEqual([true, false, false, false])
    expect(groups[1]!.list.map((x) => x.name)).toEqual(['Spark (local)', 'OpenCode Go'])
  })

  test('a single-account harness is its own group (no heading), and an empty list has no groups', () => {
    expect(harnessGroups([p('codex', 'Codex', 'Codex')]).map((g) => [g.harness, g.single])).toEqual([['codex', true]])
    expect(harnessGroups([])).toEqual([])
  })
})
