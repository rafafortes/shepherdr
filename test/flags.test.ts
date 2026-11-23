// Extra launch flags (upstream SHEP-266, #1222): only flags the chosen CLI really has, none Shepherdr sets itself,
// kept one word each so a launch, a resume, a switch, a restart and a crash's recovery pass them unchanged. The five
// CLIs Shepherdr drives each get their own table and their own cases; the installed --help is injected with setHelp so
// these tests never need a CLI on PATH (Codex is not installed on this host at all).
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KINDS, cleanFlags, cleanFlagsLine, flagWords, parseFlags, setHelp } from '../server/live/flags.ts'
import { tmp } from './tmp.ts'

afterEach(() => {
  for (const kind of KINDS) setHelp(kind)
})

describe('the strict check, one case per CLI', () => {
  test('Claude Code: values become one word each, including repeats and a value with a space', () => {
    expect(parseFlags('claude', '--advisor opus')).toEqual(['--advisor=opus'])
    expect(parseFlags('claude', ['-n', 'my task', '--add-dir', '/a', '/b c', '--debug', '--verbose'])).toEqual(['--name=my task', '--add-dir=/a', '--add-dir=/b c', '--debug', '--verbose'])
  })

  test('Codex: short aliases, repeated -c keys and image flags are kept whole', () => {
    expect(parseFlags('codex', '-c model_verbosity=high -i a.png --search')).toEqual(['--config=model_verbosity=high', '--image=a.png', '--search'])
  })

  test('a backslash keeps a space inside one value', () => {
    expect(parseFlags('claude', '--name=my\\ task')).toEqual(['--name=my task'])
  })

  test('a whole short name wins over a split, and an attached value stays with its flag', () => {
    expect(parseFlags('pi', ['-ne'])).toEqual(['--no-extensions'])
    expect(parseFlags('pi', ['-nfoo'])).toEqual(['--name=foo'])
    expect(() => parseFlags('pi', ['-na'])).toThrow('trusts a worktree')
  })

  test('pi: its own flags, never a model, session or print flag', () => {
    expect(parseFlags('pi', "--name 'my task' --no-mcp --tools Bash,Edit --verbose")).toEqual(['--name=my task', '--no-mcp', '--tools=Bash,Edit', '--verbose'])
  })

  test("OpenCode: its two useful extras pass; the TUI's own flags do not", () => {
    expect(parseFlags('opencode', '--log-level debug --print-logs')).toEqual(['--log-level=debug', '--print-logs'])
  })

  test('Antigravity (agy): its repeatable and bare flags pass', () => {
    expect(parseFlags('agy', "--add-dir /a /b --log-file '/tmp/my log' --disable-slash-commands")).toEqual(['--add-dir=/a', '--add-dir=/b', '--log-file=/tmp/my log', '--disable-slash-commands'])
  })

  test("a flag newer than the tables passes when that CLI's own --help lists it", () => {
    setHelp('claude', 'Options:\n  --brand-new <thing>   Something new\n  -z, --zap             Zap\n')
    expect(parseFlags('claude', ['--brand-new', 'x', '--zap'])).toEqual(['--brand-new=x', '--zap'])
    setHelp('pi', 'Options:\n  --future-switch   A new pi flag\n')
    expect(parseFlags('pi', '--future-switch')).toEqual(['--future-switch'])
  })

  test('a CLI that prints --help to stderr still contributes its newer flags', () => {
    const bin = tmp('flags-stderr-bin')
    const script = join(bin, 'agy')
    writeFileSync(script, '#!/bin/sh\nprintf "  --future-thing <value>   A new flag\\n" >&2\n')
    chmodSync(script, 0o755)
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path ?? ''}`
    setHelp('agy')
    try {
      expect(parseFlags('agy', '--future-thing x')).toEqual(['--future-thing=x'])
    } finally {
      process.env.PATH = path
      setHelp('agy')
    }
  })

  test('a CLI that is missing or silent still uses its table', () => {
    setHelp('codex', '')
    expect(parseFlags('codex', '--search')).toEqual(['--search'])
    expect(() => parseFlags('codex', '--advisor opus')).toThrow('Codex has no --advisor flag')
  })
})

describe('what is refused, and why', () => {
  test('Claude Code: what Shepherdr sets itself, print-only flags and bad words', () => {
    const refused: [string, string][] = [
      ['--model opus', 'use its own setting or flag instead'],
      ['--effort high', 'Shepherdr sets the effort itself'],
      ['--resume', "resumes the task's own session"],
      ['-p', 'interactive'],
      ['--permission-mode plan', 'permission mode from Settings'],
      ['--settings {}', 'hooks settings file'],
      ['--output-format json', 'print mode'],
      ['--worktree', 'own worktree'],
      ['--bare', 'hooks'],
      ['--safe-mode', 'hooks'],
      ['--restricted', 'Bash'],
      ['--advisor', '--advisor needs a value'],
      ['--verbose=1', 'takes no value'],
      ['--no-such-flag', 'has no --no-such-flag flag'],
      ['hello', "isn't a flag"],
      ["'unclosed", 'unclosed quote'],
    ]
    for (const [words, why] of refused) expect(() => parseFlags('claude', words)).toThrow(why)
  })

  test('Codex: model, sandbox, session and -c keys Shepherdr sets', () => {
    for (const [words, why] of [
      ['-m o3', 'Shepherdr sets the model'],
      ['-c model_reasoning_effort=high', 'use its own setting or flag instead'],
      ['-c service_tier=fast', 'speed from Settings'],
      ['-c shell_environment_policy.inherit=none', 'tool environment'],
      ['--full-auto', 'sandbox and approvals from Settings'],
      ['--advisor opus', 'Codex has no --advisor flag'],
      ['--no-daemon', 'Shepherdr passes it already'],
      ['-C /x', "task's folder"],
    ] as [string, string][])
      expect(() => parseFlags('codex', words)).toThrow(why)
  })

  test('pi: model, thinking, session, permissions and secrets', () => {
    for (const words of ['--model x', '--thinking high', '--session abc', '--session-dir /x', '--approve', '-p', '--api-key SECRET']) expect(() => parseFlags('pi', words)).toThrow()
    expect(() => parseFlags('pi', '--session-dir /x')).toThrow('own folder')
  })

  test('OpenCode: session, server, permissions and prompt', () => {
    for (const words of ['--session abc', '--auto', '--standalone', '--prompt hi', '--wizard']) expect(() => parseFlags('opencode', words)).toThrow()
  })

  test('Antigravity (agy): model, effort, session, print and mode', () => {
    for (const words of ['--model x', '--effort high', '--conversation abc', '--print', '--mode plan', '--settings {}']) expect(() => parseFlags('agy', words)).toThrow()
  })

  test('the CLI named must be one Shepherdr starts', () => {
    expect(() => parseFlags('gemini', '--search')).toThrow('not gemini')
  })
})

describe('launch-time guard, display and recovery', () => {
  test('cleanFlags drops what no longer passes and says what it dropped', () => {
    expect(cleanFlags('claude', ['--model=opus', '--advisor=opus', 'a prompt', '--verbose'])).toEqual({
      keep: ['--advisor=opus', '--verbose'],
      dropped: ['--model=opus', 'a prompt'],
    })
    // a flag left over from another CLI is dropped the same way: a switch never passes Claude's to Codex
    expect(cleanFlags('codex', ['--advisor=opus', '--search'])).toEqual({ keep: ['--search'], dropped: ['--advisor=opus'] })
  })

  test('cleanFlagsLine keeps the flags of a stored line that still pass', () => {
    expect(cleanFlagsLine('claude', '')).toEqual([])
    expect(cleanFlagsLine('claude', '--advisor opus')).toEqual(['--advisor=opus'])
    expect(cleanFlagsLine('claude', '--model=opus --advisor=opus a prompt')).toEqual(['--advisor=opus'])
    expect(cleanFlagsLine('codex', '--advisor=opus --search')).toEqual(['--search'])
  })

  test('flagWords quotes only where a shell needs it, for the brief', () => {
    expect(flagWords(['--advisor=opus', '--name=a b'])).toBe("--advisor=opus '--name=a b'")
    expect(flagWords([])).toBe('')
  })
})
