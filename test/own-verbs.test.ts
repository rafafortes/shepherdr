// The shepherdr verb lists must move together: command()'s switch in cli-commands.ts decides what the CLI does, CLI_VERBS in
// args.ts is the list the help page and docs check use, and OWN_VERBS decides which calls an agent runs without a
// permission card. Here they are pinned to one another, along with how that answer reaches every CLI Shepherdr starts.
import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('own-verbs')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN

const { CLI_VERBS } = await import('../server/live/args.ts')
const { CARDED_VERBS, OWN_VERBS, deciderScript } = await import('../server/live/readers/own-commands.ts')
const { Agents } = await import('../server/live/agents.ts')
const { helpVerbs } = await import('../scripts/checks/docs.ts')

/** the case labels of the command() switch, in source order: the behaviour that owns the verb set */
function dispatchVerbs(): string[] {
  const lines = readFileSync(join(import.meta.dir, '..', 'server', 'live', 'cli-commands.ts'), 'utf8').split('\n')
  const start = lines.indexOf('    switch (a0) {')
  expect(start).toBeGreaterThan(-1)
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line === '    }') break
    const m = /^\s{6}case '([a-z0-9-]+)':/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

describe('the shepherdr verb lists', () => {
  test('command() and CLI_VERBS handle exactly the same verbs', () => {
    expect(dispatchVerbs()).toEqual([...CLI_VERBS])
    // help is the one own verb handled before the switch rather than as a case in it
    expect(readFileSync(join(import.meta.dir, '..', 'server', 'live', 'cli-commands.ts'), 'utf8')).toContain("if (a0 === 'help') return helpTopic(a1)")
  })

  test('every own verb is handled by command(), and every non-carded CLI verb is own', () => {
    const dispatch = dispatchVerbs()
    const ownWords = OWN_VERBS.filter((v) => !v.includes(' '))
    expect(ownWords[0]).toBe('help') // handled just before the switch
    for (const v of ownWords.slice(1)) expect(dispatch).toContain(v)
    const uncarded = CLI_VERBS.filter((v) => !(CARDED_VERBS as readonly string[]).includes(v))
    expect([...ownWords.slice(1)].sort()).toEqual([...uncarded].sort())
    for (const v of CARDED_VERBS) expect(CLI_VERBS as readonly string[]).toContain(v)
    expect(new Set(CARDED_VERBS).size).toBe(CARDED_VERBS.length)
    expect(new Set(OWN_VERBS).size).toBe(OWN_VERBS.length)
    // the only two-word own commands name the one CLI verb whose other subcommands keep a card
    expect(OWN_VERBS.filter((v) => v.includes(' '))).toEqual(['secret list', 'secret ask'])
    for (const pair of ['secret list', 'secret ask']) {
      const verb = pair.split(' ')[0]
      expect(dispatch).toContain(verb)
      expect(CARDED_VERBS as readonly string[]).toContain(verb)
    }
  })

  test('HELP lists no verb outside CLI_VERBS, and spells out every verb but the aliases', () => {
    const groups = helpVerbs().groups
    for (const verb of groups) expect(CLI_VERBS as readonly string[]).toContain(verb)
    // project, done, render and preview are aliases or gone verbs, named in cli-help.test.ts instead of HELP
    for (const verb of CLI_VERBS.filter((v) => !['project', 'done', 'render', 'preview'].includes(v))) expect(groups).toContain(verb)
  })

  test('claude: the generated hook still embeds the exact list', () => {
    // the literal the hook has written since SHE-6, in order: moving a verb changes the generated file
    expect(OWN_VERBS).toEqual([
      'help',
      'show',
      'models',
      'set',
      'unset',
      'alert',
      'space',
      'task',
      'status',
      'review',
      'ask',
      'plan',
      'pr',
      'checks',
      'ready',
      'done',
      'merge',
      'heartbeat',
      'automation',
      'todo',
      'artifact',
      'secret list',
      'secret ask',
    ])
    expect(deciderScript()).toContain(`const OWN = ${JSON.stringify(OWN_VERBS)}`)
  })
})

describe('how each CLI reaches the own-verb list', () => {
  const agents = new Agents()
  afterAll(() => agents.stop())
  const rec = (kind: string, access: 'full' | 'ask' = 'full') => ({ key: 'own-verbs', name: 'own-verbs', kind, cwd: '/', workspace: 'w', logs: [], started: 0, access }) as never

  /** the PreToolUse decider claude gets for its own shepherdr calls, whichever access mode it starts in */
  const claudeHook = (access: 'full' | 'ask'): string => {
    const args = agents.args(rec('claude', access), false)
    expect(args[0]).toBe('--settings')
    const groups = JSON.parse(readFileSync(args[1], 'utf8')).hooks.PreToolUse
    expect(groups[1].matcher).toBe('Bash')
    expect(groups[1].hooks[0].command).toContain('allow.cjs')
    return groups[1].hooks[0].command
  }

  test('claude uses a generated hook; codex, agy, opencode and pi do not consult it', () => {
    // claude is the only CLI with a permission card here, and the only one given a PreToolUse decider
    claudeHook('full')
    // codex: full access bypasses approvals and needs no hook; an ask launch gets the PermissionRequest hook instead
    expect(agents.args(rec('codex'), false)).toContain('--dangerously-bypass-approvals-and-sandbox')
    // agy: its own bypass flag
    expect(agents.args(rec('agy'), false)).toContain('--dangerously-skip-permissions')
    // opencode: --auto; its ask-only permissions live on the session (opencode.ts), not in ownCall
    expect(agents.args(rec('opencode'), false)).toContain('--auto')
    // pi: no permission flag at all; it never asks
    expect(agents.args(rec('pi'), false)).toEqual([])
  })

  test('in ask mode those CLIs raise their own card, with the own verbs allowed their own way', () => {
    // codex and agy keep their CLI's approvals when asked; opencode's ask rules are on its session, not in ownCall
    // (codex allows OWN_VERBS through its hook, opencode through the session rules; neither uses the Claude decider)
    expect(agents.args(rec('codex', 'ask'), false)).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(agents.args(rec('agy', 'ask'), false)).not.toContain('--dangerously-skip-permissions')
    expect(agents.args(rec('opencode', 'ask'), false)).not.toContain('--auto')
    expect(agents.args(rec('pi', 'ask'), false)).toEqual([])
    // claude keeps the very own-command decider in both modes: that hook is the only carrier of OWN_VERBS
    expect(claudeHook('ask')).toBe(claudeHook('full'))
  })
})
