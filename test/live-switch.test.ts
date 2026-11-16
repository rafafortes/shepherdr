// A running agent's model and effort change in place, proved by its own chat (SHE-45). Fake CLI worlds stand in for
// the panes: each CLI's commands, what its log would report, and the rollback when a step does not take.
import { describe, expect, test } from 'bun:test'
import { DemoWorld } from '../server/demo/world.ts'
import { VM } from '../server/demo/data.ts'
import { Agents } from '../server/live/agents.ts'
import {
  CLAUDE_SETTINGS, claudeRestore, claudeSteps, codexEffortRow, codexModelRow, codexPicker, codexRows, liveChanges, liveOK,
  moveTo, piSteps, switchLive, type ChatState, type SwitchIO,
} from '../server/live/live-switch.ts'

const MODELS = `  Select Model and Effort
  1. GPT-6.1-Sol           Latest workhorse model for coding
  2. GPT-6-Astra           Frontier intelligence
› 5. GPT-6-Luna (current)  Fast and affordable
  enter select · esc back`
const LEVELS = `  Select Reasoning Level for GPT-6.1-Sol
  1. Low (default)         Fast responses
  2. Medium                Balances speed and depth
› 4. Extra high (current)  Deep reasoning
  5. More reasoning…       Max and Ultra consume limits
  enter default · s session · esc back`
const DEEP = `  Advanced Reasoning
  1. Max                   Deepest
› 2. Ultra                 Deeper still
  enter default · s session · esc back`
const DONE = '• Model changed to gpt-6.1-sol medium for this session only\n› Ask Codex to do anything'

class FakeTerm {
  screen = ''
  chatState: ChatState = {}
  sent: string[] = []
  keys: string[] = []
  onSend?: (text: string, t: FakeTerm) => void
  onKey?: (key: string, t: FakeTerm) => void
  files: Record<string, string> = {}
  io: SwitchIO = {
    send: async (text) => { this.sent.push(text); this.onSend?.(text, this) },
    keys: async (...k) => { this.keys.push(...k); for (const key of k) this.onKey?.(key, this) },
    screen: async () => this.screen,
    chat: async () => ({ ...this.chatState }),
    sleep: async () => {},
    readFile: async (rel) => this.files[rel] ?? null,
    writeFile: async (rel, text) => { this.files[rel] = text },
  }
}

describe('which CLI can switch in place', () => {
  test('Claude Code, Codex and pi have their own mid-session switch', () => {
    // claude --help + its local-command-stdout log lines; pi 1.5.2's built-in slash commands (/model, /thinking);
    // Codex 0.163's /model picker (upstream 45d7e850). The host's help and logs were checked (SHE-45).
    for (const kind of ['claude', 'codex', 'pi']) expect(liveOK(kind)).toBe(true)
  })
  test('OpenCode and agy have model/effort only as start flags, so they keep the restart', () => {
    // `opencode --help` / `opencode run --help`: --model is a start flag, no in-session command. `agy --help`:
    // --model and --effort are start flags; no in-session switch. Neither CLI's log has a switch line to read back.
    for (const kind of ['opencode', 'agy']) expect(liveOK(kind)).toBe(false)
    expect(liveOK('cursor')).toBe(false)
  })
})

describe('what changes', () => {
  test('a new model restates its level; a level alone stays alone', () => {
    const from = { kind: 'claude', model: 'claude-opus-5-5', effort: 'high' }
    expect(liveChanges(from, { ...from, effort: 'low' })).toEqual({ effort: 'low' })
    expect(liveChanges(from, { ...from, model: 'claude-sonnet-5-5' })).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' })
    expect(liveChanges(from, from)).toEqual({})
    expect(liveChanges(from, { ...from, model: '' })).toEqual({ model: '', effort: 'high' })
  })
  test('the commands each CLI takes, always with a concrete value', () => {
    expect(claudeSteps({ model: 'claude-opus-5-5', effort: 'high' }).map((s) => s.text)).toEqual(['/model claude-opus-5-5', '/effort high'])
    expect(claudeSteps({ effort: 'medium' }).map((s) => s.text)).toEqual(['/effort medium'])
    expect(piSteps({ model: 'spark/qwen', effort: 'high' }).map((s) => s.text)).toEqual(['/model spark/qwen', '/thinking high'])
    expect(piSteps({ model: 'spark/qwen' }).map((s) => s.text)).toEqual(['/model spark/qwen'])
  })
})

describe("Claude Code's saved defaults", () => {
  test('only the keys the command touched go back; anything written meanwhile stays', () => {
    const before = JSON.stringify({ theme: 'dark', modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } }, null, 2)
    const now = JSON.stringify({ theme: 'light', model: 'claude-sonnet-5-5', modelSettings: { 'claude-opus-5-5': {}, 'claude-sonnet-5-5': { effortLevel: 'low' } } }, null, 2)
    expect(JSON.parse(claudeRestore(before, now)!)).toEqual({ theme: 'light', modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } })
    expect(claudeRestore(before, before)).toBeNull()
    expect(claudeRestore('{', '{}')).toBeNull()
  })

  test('a switch puts them back after the command saved them', async () => {
    const t = new FakeTerm()
    const before = JSON.stringify({ theme: 'dark' }, null, 2)
    t.files[CLAUDE_SETTINGS] = before
    t.onSend = (text, t) => {
      if (text.startsWith('/model')) {
        t.chatState.model = 'claude-sonnet-5-5'
        t.files[CLAUDE_SETTINGS] = JSON.stringify({ theme: 'dark', model: 'claude-sonnet-5-5' })
      }
      if (text.startsWith('/effort')) {
        t.chatState.effort = 'low'
        t.files[CLAUDE_SETTINGS] = JSON.stringify({ theme: 'dark', model: 'claude-sonnet-5-5', effortLevel: 'low' })
      }
    }
    await switchLive(t.io, 'claude', { kind: 'claude', model: 'claude-opus-5-5', effort: 'high' }, { kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })
    expect(JSON.parse(t.files[CLAUDE_SETTINGS]!)).toEqual({ theme: 'dark' })
    expect(t.chatState).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
  })
})

describe('Claude Code: typed and read back from its chat', () => {
  test('model then effort, each confirmed by the log before it moves on', async () => {
    const t = new FakeTerm()
    t.onSend = (text, t) => {
      if (text === '/model claude-sonnet-5-5') t.chatState.model = 'claude-sonnet-5-5'
      if (text === '/effort low') t.chatState.effort = 'low'
    }
    const changed = await switchLive(t.io, 'claude', { kind: 'claude', model: 'claude-opus-5-5', effort: 'high' }, { kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })
    expect(changed).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
    expect(t.sent).toEqual(['/model claude-sonnet-5-5', '/effort low'])
    expect(t.chatState).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
  })

  test('its own answer is the proof: a written command the chat does not report fails', async () => {
    const t = new FakeTerm()
    await expect(switchLive(t.io, 'claude', { kind: 'claude', effort: 'high' }, { kind: 'claude', effort: 'low' })).rejects.toThrow('/effort didn\'t take')
    expect(t.sent).toEqual(['/effort low', '/effort high'])
  })

  test('a refusal in the terminal says why, without waiting for a chat answer', async () => {
    const t = new FakeTerm()
    t.onSend = () => { t.screen = 'Invalid effort: pick one of low, medium, high' }
    await expect(switchLive(t.io, 'claude', { kind: 'claude', effort: 'high' }, { kind: 'claude', effort: 'ultra' })).rejects.toThrow('Invalid effort')
  })

  test('a half-applied switch is put back on the model and effort it started on, each read back', async () => {
    const t = new FakeTerm()
    t.chatState = { model: 'claude-opus-5-5', effort: 'high' }
    t.onSend = (text, t) => {
      if (text === '/model claude-sonnet-5-5') t.chatState.model = 'claude-sonnet-5-5'
      if (text === '/effort low') t.screen = 'Invalid effort: no such level'
      if (text === '/model claude-opus-5-5') t.chatState.model = 'claude-opus-5-5'
    }
    await expect(switchLive(t.io, 'claude', { kind: 'claude', model: 'claude-opus-5-5', effort: 'high' }, { kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })).rejects.toThrow('Invalid effort')
    // both fields are re-stated: a level a model switch may have moved on its own is restored too
    expect(t.sent).toEqual(['/model claude-sonnet-5-5', '/effort low', '/model claude-opus-5-5', '/effort high'])
    expect(t.chatState).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })

  test('an unnamed value is never guessed: a default target, or an unreported start, is refused before typing', async () => {
    const t = new FakeTerm()
    t.chatState = { model: 'claude-sonnet-5-5', effort: 'high' }
    t.onSend = () => { t.chatState.model = 'claude-opus-5-5' }
    await expect(switchLive(t.io, 'claude', { kind: 'claude', model: 'claude-opus-5-5', effort: 'high' }, { kind: 'claude', model: '', effort: 'high' })).rejects.toThrow("CLI's own default")
    await expect(switchLive(t.io, 'claude', { kind: 'claude', model: '', effort: 'high' }, { kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })).rejects.toThrow('not reported')
    expect(t.sent).toEqual([])
  })

  test('a failed rollback says which field it could not put back', async () => {
    const t = new FakeTerm()
    t.chatState = { model: 'claude-opus-5-5', effort: 'high' }
    t.onSend = (text, t) => {
      if (text === '/model claude-sonnet-5-5') t.chatState.model = 'claude-sonnet-5-5'
      if (text === '/effort low' || text === '/model claude-opus-5-5') t.screen = 'Invalid: the CLI would not take it'
    }
    await expect(switchLive(t.io, 'claude', { kind: 'claude', model: 'claude-opus-5-5', effort: 'high' }, { kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })).rejects.toThrow('could not be put back on model')
  })

  test('pi: when the effort step fails, both fields are put back, not just the model', async () => {
    const t = new FakeTerm()
    t.chatState = { model: 'spark/qwen', effort: 'high' }
    t.onSend = (text, t) => {
      if (text === '/model commandcode/deepseek') t.chatState.model = 'commandcode/deepseek'
      if (text === '/thinking low') t.screen = 'unknown thinking level'
      if (text === '/model spark/qwen') t.chatState.model = 'spark/qwen'
      if (text === '/thinking high') t.chatState.effort = 'high'
    }
    await expect(switchLive(t.io, 'pi', { kind: 'pi', model: 'spark/qwen', effort: 'high' }, { kind: 'pi', model: 'commandcode/deepseek', effort: 'low' })).rejects.toThrow('unknown')
    expect(t.sent).toEqual(['/model commandcode/deepseek', '/thinking low', '/model spark/qwen', '/thinking high'])
    expect(t.chatState).toEqual({ model: 'spark/qwen', effort: 'high' })
  })

  test('pi: model and thinking level both taken, read from its own chat', async () => {
    const t = new FakeTerm()
    t.onSend = (text, t) => {
      if (text.startsWith('/model ')) t.chatState.model = text.slice(7)
      if (text.startsWith('/thinking ')) t.chatState.effort = text.slice(10)
    }
    await switchLive(t.io, 'pi', { kind: 'pi', model: 'spark/qwen', effort: 'high' }, { kind: 'pi', model: 'commandcode/deepseek', effort: 'low' })
    expect(t.sent).toEqual(['/model commandcode/deepseek', '/thinking low'])
    expect(t.chatState).toEqual({ model: 'commandcode/deepseek', effort: 'low' })
  })
})

describe('Codex: its picker, read off the screen and confirmed by the chat', () => {
  test('the newest picker and its numbered rows', () => {
    expect(codexPicker(MODELS)).toBe('model')
    expect(codexPicker(LEVELS)).toBe('effort')
    expect(codexPicker(DEEP)).toBe('more')
    expect(codexPicker(DONE)).toBeNull()
    expect(codexPicker('')).toBeNull()
    expect(codexRows('')).toEqual([]) // no picker on an empty screen
    const rows = codexRows(MODELS)
    expect(rows.find((r) => r.sel)).toMatchObject({ n: 5, label: 'GPT-6-Luna', current: true })
    expect(codexRows(LEVELS).find((r) => r.dflt)).toMatchObject({ n: 1, label: 'Low' })
  })

  test('a model by id or label, the default when unnamed; a level, or the deeper list', () => {
    const rows = codexRows(MODELS)
    expect(codexModelRow(rows, 'gpt-6.1-sol', 'GPT-6.1-Sol')?.n).toBe(1)
    expect(codexModelRow(rows, 'gpt-6.1-terra')).toBeNull()
    expect(codexModelRow(rows)?.n).toBe(5)
    const levels = codexRows(LEVELS)
    const medium = codexEffortRow(levels, 'medium')
    const dflt = codexEffortRow(levels, '')
    expect(medium && medium !== 'more' ? medium.n : undefined).toBe(2)
    expect(dflt && dflt !== 'more' ? dflt.n : undefined).toBe(1)
    expect(codexEffortRow(levels, 'ultra')).toBe('more')
    expect(codexEffortRow(levels, 'impossible')).toBe('more')
    expect(codexEffortRow(codexRows(LEVELS.replace(/  5\. More reasoning….*\n/, '')), 'impossible')).toBeNull()
    expect(moveTo(rows, 3)).toEqual(['up', 'up'])
    expect(moveTo([], 3)).toEqual([])
  })

  test('model then level for this session only (`s`, never Enter)', async () => {
    const t = new FakeTerm()
    t.screen = MODELS
    t.onKey = (k, t) => {
      if (k === 'enter') t.screen = LEVELS
      if (k === 's') { t.screen = DONE; t.chatState = { model: 'gpt-6.1-sol', effort: 'medium' } }
    }
    await switchLive(t.io, 'codex', { kind: 'codex', model: 'gpt-6-luna', effort: 'high' }, { kind: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }, { 'gpt-6.1-sol': 'GPT-6.1-Sol' })
    expect(t.sent).toEqual(['/model'])
    expect(t.keys).toEqual(['up', 'up', 'up', 'up', 'enter', 'up', 'up', 's'])
    expect(t.chatState).toEqual({ model: 'gpt-6.1-sol', effort: 'medium' })
  })

  test('a level behind More reasoning is chosen in the deeper picker', async () => {
    const t = new FakeTerm()
    t.screen = MODELS
    t.onKey = (k, t) => {
      if (k === 'enter' && codexPicker(t.screen) === 'model') t.screen = LEVELS
      else if (k === 'enter' && codexPicker(t.screen) === 'effort') t.screen = DEEP
      else if (k === 's') { t.screen = DONE; t.chatState = { model: 'gpt-6.1-sol', effort: 'ultra' } }
    }
    await switchLive(t.io, 'codex', { kind: 'codex', model: 'gpt-6-luna', effort: 'high' }, { kind: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' }, { 'gpt-6.1-sol': 'GPT-6.1-Sol' })
    expect(t.keys.slice(-1)).toEqual(['s'])
    expect(t.chatState.effort).toBe('ultra')
  })

  test('a model missing from its list is refused and put back', async () => {
    const t = new FakeTerm()
    t.screen = MODELS
    t.chatState = { model: 'gpt-6-luna', effort: 'high' }
    t.onSend = (text, t) => { if (t.sent.filter((x) => x === text).length === 1) t.screen = MODELS }
    t.onKey = (k, t) => { if (k === 'esc') t.screen = DONE }
    await expect(switchLive(t.io, 'codex', { kind: 'codex', model: 'gpt-6-luna', effort: 'high' }, { kind: 'codex', model: 'gpt-9-new', effort: 'high' })).rejects.toThrow("isn't in Codex's list")
  })

  test('a level it does not offer closes the picker and puts the model back', async () => {
    const t = new FakeTerm()
    t.screen = MODELS
    t.chatState = { model: 'gpt-6-luna', effort: 'high' }
    t.onSend = () => { t.screen = MODELS }
    t.onKey = (k, t) => {
      if (k === 'enter') t.screen = LEVELS.replace(/  5\. More reasoning….*\n/, '')
      else if (k === 'esc') t.screen = DONE
    }
    await expect(switchLive(t.io, 'codex', { kind: 'codex', model: 'gpt-6-luna', effort: 'high' }, { kind: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' }, { 'gpt-6.1-sol': 'GPT-6.1-Sol' })).rejects.toThrow("doesn't offer")
  })

  test('a failed switch whose rollback took reports the original failure, not a mix', async () => {
    const GOOD = LEVELS.replace('› 4. Extra high (current)', '  3. High (default)').replace('  1. Low (default)', '  1. Low')
    const BAD = LEVELS.replace(/  5\. More reasoning….*\n/, '')
    const t = new FakeTerm()
    t.screen = MODELS
    t.chatState = { model: 'gpt-6-luna', effort: 'high' }
    let sends = 0
    t.onSend = () => { sends++; t.screen = MODELS }
    t.onKey = (k, t) => {
      if (k === 'enter' && codexPicker(t.screen) === 'model') t.screen = sends === 1 ? BAD : GOOD
      else if (k === 's') t.chatState = { model: sends === 1 ? 'gpt-6.1-sol' : 'gpt-6-luna', effort: sends === 1 ? 'medium' : 'high' }
      else if (k === 'esc') t.screen = DONE
    }
    await expect(switchLive(t.io, 'codex', { kind: 'codex', model: 'gpt-6-luna', effort: 'high' }, { kind: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' }, { 'gpt-6.1-sol': 'GPT-6.1-Sol' })).rejects.toThrow("doesn't offer")
    expect(t.chatState).toEqual({ model: 'gpt-6-luna', effort: 'high' })
    expect(t.sent).toEqual(['/model', '/model'])
  })

  test('no picker, or no answer in the chat, is never taken as a success', async () => {
    const silent = new FakeTerm()
    await expect(switchLive(silent.io, 'codex', { kind: 'codex', model: 'gpt-6-luna', effort: 'high' }, { kind: 'codex', model: 'gpt-6.1-sol', effort: 'high' })).rejects.toThrow("didn't open its model list")

    const t = new FakeTerm()
    t.screen = MODELS
    t.onKey = (k, t) => { if (k === 'enter') t.screen = LEVELS; if (k === 's') t.screen = DONE }
    await expect(switchLive(t.io, 'codex', { kind: 'codex', model: 'gpt-6-luna', effort: 'high' }, { kind: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }, { 'gpt-6.1-sol': 'GPT-6.1-Sol' })).rejects.toThrow("didn't confirm")
  })
})

describe('the launch record', () => {
  test('a live switch moves what it runs on, not what Settings asked for', () => {
    const a = new Agents()
    const key = 'LS-1/Agent'
    const set = { kind: 'claude', model: 'claude-opus-5-5', effort: 'high' }
    a.records[key] = { key, name: 'ls-1', kind: 'claude', cwd: '/x', workspace: 'w', logs: [], started: 0, model: 'claude-opus-5-5', effort: 'high', set } as never
    let told = 0
    a.on('logs', () => told++)
    a.switched(key, { model: 'claude-sonnet-5-5' })
    expect(a.records[key]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', set })
    expect(told).toBe(1)
    a.switched(key, { model: '', effort: 'low' })
    expect(a.records[key]!.model).toBeUndefined()
    expect(a.records[key]!.effort).toBe('low')
    a.switched('not-here', { effort: 'high' }) // no record: nothing to move
    expect(told).toBe(2)
  })
})

describe('the chat after a switch', () => {
  test('it shows the new model from the CLI, with no restart card', async () => {
    const w = new DemoWorld()
    const cards = () => w.chat(VM)!.messages.filter((m) => m.card?.restart).length
    const before = cards()
    const r = await w.act({ type: 'live-switch', chat: VM, kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })
    expect(r).toMatchObject({ ok: true, live: true })
    expect(w.chat(VM)!.agent?.runtime).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' })
    expect(cards()).toBe(before)
  })

  test('a CLI with no switch falls back to the restart, card and all', async () => {
    const w = new DemoWorld()
    const cards = () => w.chat(VM)!.messages.filter((m) => m.card?.restart).length
    const before = cards()
    const r = await w.act({ type: 'live-switch', chat: VM, kind: 'opencode', model: 'a-local-model' })
    expect(r).toMatchObject({ ok: true, live: false })
    expect(cards()).toBe(before + 1)
  })
})

describe('a CLI with no switch', () => {
  test('switchLive refuses it, so the caller keeps the restart path', async () => {
    const t = new FakeTerm()
    await expect(switchLive(t.io, 'opencode', { kind: 'opencode', model: 'a' }, { kind: 'opencode', model: 'b' })).rejects.toThrow('no in-session model switch')
    expect(t.sent).toEqual([])
  })
  test('nothing to change types nothing', async () => {
    const t = new FakeTerm()
    expect(await switchLive(t.io, 'claude', { kind: 'claude', model: 'x' }, { kind: 'claude', model: 'x' })).toEqual({})
    expect(t.sent).toEqual([])
  })
})
