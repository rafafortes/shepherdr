// The shepherdr verb lists must move together: command()'s switch in source.ts decides what the CLI does, CLI_VERBS in
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
const { CARDED_VERBS, OWN_VERBS, deciderScript, ownDecision } = await import('../server/live/readers/own-commands.ts')
const { Agents } = await import('../server/live/agents.ts')
const { helpVerbs } = await import('../scripts/checks/docs.ts')

/** the case labels of the command() switch, in source order: the behaviour that owns the verb set */
function dispatchVerbs(): string[] {
  const lines = readFileSync(join(import.meta.dir, '..', 'server', 'live', 'source.ts'), 'utf8').split('\n')
  const start = lines.indexOf('    switch (a0) {')
  expect(start).toBeGreaterThan(-1)
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line === '    }') break
    const m = /^\s{6}case '([a-z]+)':/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

const command = '/opt/shepherdr/bin/shepherdr'
const chat = 'SHE-128/Agent'
const bash = (text: string) => ({ tool_name: 'Bash', tool_input: { command: text } })

describe('the shepherdr verb lists', () => {
  test('command() and CLI_VERBS handle exactly the same verbs', () => {
    expect(dispatchVerbs()).toEqual([...CLI_VERBS])
  })

  test('every own verb is handled by command(), and every non-carded CLI verb is own', () => {
    const dispatch = dispatchVerbs()
    const ownWords = OWN_VERBS.filter((v) => !v.includes(' '))
    expect(ownWords[0]).toBe('help') // handled just before the switch
    for (const v of ownWords.slice(1)) expect(dispatch).toContain(v)
    const uncarded = CLI_VERBS.filter((v) => !(CARDED_VERBS as readonly string[]).includes(v))
    expect([...ownWords.slice(1)].sort()).toEqual([...uncarded].sort())
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

  test('claude: the generated hook still embeds the list and allows only those calls', () => {
    expect(deciderScript()).toContain(`const OWN = ${JSON.stringify(OWN_VERBS)}`)
    for (const verb of OWN_VERBS) expect(ownDecision(command, chat, bash(`${command} ${verb}`))).toContain('"permissionDecision":"allow"')
    for (const verb of CARDED_VERBS) expect(ownDecision(command, chat, bash(`${command} ${verb}`))).toBeUndefined()
  })
})

describe('how each CLI reaches the own-verb list', () => {
  const agents = new Agents()
  afterAll(() => agents.stop())
  const rec = (kind: string) => ({ key: 'own-verbs', name: 'own-verbs', kind, cwd: '/', workspace: 'w', logs: [], started: 0, access: 'full' as const }) as never

  test('claude uses a generated hook; codex, agy, opencode and pi do not consult it', () => {
    // claude is the only CLI with a permission card here, and the only one given a PreToolUse decider
    const claude = agents.args(rec('claude'), false)
    expect(claude[0]).toBe('--settings')
    const groups = JSON.parse(readFileSync(claude[1], 'utf8')).hooks.PreToolUse
    expect(groups[1].matcher).toBe('Bash')
    // codex: approvals bypassed, no hook
    expect(agents.args(rec('codex'), false)).toContain('--dangerously-bypass-approvals-and-sandbox')
    // agy: its own bypass flag
    expect(agents.args(rec('agy'), false)).toContain('--dangerously-skip-permissions')
    // opencode: --auto; its ask-only permissions live on the session (opencode.ts), not in ownCall
    expect(agents.args(rec('opencode'), false)).toContain('--auto')
    // pi: no permission flag at all; it never asks
    expect(agents.args(rec('pi'), false)).toEqual([])
  })
})
