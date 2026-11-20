import { describe, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { OWN_VERBS, ownCall, ownCommand } from '../server/live/readers/own-commands.ts'
import { hookSettings } from '../server/live/readers/hooks.ts'
import { tmp } from './tmp.ts'

const command = '/opt/shepherdr/bin/shepherdr'
const chat = 'EX-1/Agent'
const own = (text: unknown, path = command, who = chat) => ownCall(text, path, who, OWN_VERBS)
const bash = (text: string) => ({ tool_name: 'Bash', tool_input: { command: text } })

describe("an agent's own shepherdr command", () => {
  test('is allowed bare and in the launch prompt’s form, verb by verb', () => {
    for (const text of [
      `${command} help`,
      `${command} status`,
      `${command} status EX-1 "Half done" --done 50 --left 5m`,
      `${command} ask "Rerun CI?" --choice Yes --choice No`,
      `SHEPHERDR_CHAT="${chat}" ${command} ask "Rerun CI?" --choice Yes --choice No`,
      `SHEPHERDR_CHAT='${chat}' ${command} ready EX-1 --summary 'It works; really' --facts "a \\"b\\" | c"`,
      `${command} todo EX-1`,
      `${command} review EX-1`,
      `${command} merge EX-1`,
      `${command} task add One --brief 'line one\nline two'`,
      `${command} artifact update wk3n board.html --note "bars by week"`,
      `${command} secret list`,
      `${command} secret ask TOKEN --why 'To push'`,
      `  ${command} show  `,
    ])
      expect(own(text)).toBe(true)
  })

  test('takes the two-word verbs as pairs, never a bare or other secret subcommand', () => {
    for (const pair of ['secret list', 'secret ask']) {
      expect(OWN_VERBS).toContain(pair)
      expect(own(`${command} ${pair}`)).toBe(true)
    }
    for (const text of [`${command} secret`, `${command} secret run A -- ls`, `${command} secret env A --file x`, `${command} secret elevenlabs`, `${command} secret listx`])
      expect(own(text)).toBe(false)
  })

  test('is allowed with its path quoted, as a shell needs it', () => {
    const spaced = '/home/me/My Projects/bin/shepherdr'
    expect(own(`'${spaced}' status`, spaced)).toBe(true)
    expect(own(`"${spaced}" status`, spaced)).toBe(true)
    expect(own(`${spaced} status`, spaced)).toBe(false)
    expect(own(`SHEPHERDR_CHAT="${chat}" '${spaced}' status`, spaced)).toBe(true)
  })

  test('is allowed in the launch prompt’s form for a chat with a space in it, and not by any other quoting', () => {
    const who = 'p:host:Letter garden'
    expect(own(`SHEPHERDR_CHAT="${who}" ${command} status`, command, who)).toBe(true)
    // a word the shell would run as a command (its name quoted, so no assignment) is not this launch's form
    expect(own(`"SHEPHERDR_CHAT=${chat}" ${command} status`)).toBe(false)
    expect(own(`SHEPHERDR_CHAT"=${chat}" ${command} status`)).toBe(false)
    // an unquoted assignment is the same thing, and bash runs it as one
    expect(own(`SHEPHERDR_CHAT=${chat} ${command} status`)).toBe(true)
    expect(own(`SHEPHERDR_CHAT="${chat}"${command} status`)).toBe(false)
  })

  test('keeps its card for the verbs that run or write anything, and for one not listed', () => {
    for (const text of [
      `${command} secret run A -- rm -rf /`,
      `${command} secret 'run' A -- rm -rf /`,
      `${command} secret env A --file x`,
      `${command} secret`,
      `${command} secret elevenlabs`,
      `${command} restart EX-1`,
      `${command} mode polylog autopilot`,
      `${command} doctor`,
      `${command} nonsense`,
      command,
    ])
      expect(own(text)).toBe(false)
  })

  test('keeps its card when the line holds anything but that one call', () => {
    for (const text of [
      `${command} ask x; rm -rf /`,
      `${command} ask x && rm y`,
      `${command} ask x | sh`,
      `${command} ask x &`,
      `${command} ask x\nrm y`,
      `${command} ask x > ~/.bashrc`,
      `${command} ask "$(rm y)"`,
      `${command} ask \`rm y\``,
      `${command} ask $HOME`,
      `${command} ask "\`rm y\`"`,
      `${command} ask 'open`,
      `FOO=1 ${command} ask x`,
      `SHEPHERDR_CHAT="OTHER-2/Agent" ${command} ask x`,
      `SHEPHERDR_CHAT="${chat}" ${command} ask x; rm -rf /`,
      `timeout 120 ${command} ask x`,
      `sh -c '${command} ask x'`,
      `${command}-evil ask x`,
      `/other/bin/shepherdr ask x`,
      'shepherdr ask x',
    ])
      expect(own(text)).toBe(false)
    // other paths and another chat: the rules are this launch's, no one else's
    expect(own(`${command} ask x`, '/other/bin/shepherdr')).toBe(false)
    expect(own(`SHEPHERDR_CHAT="POL-1/Agent" ${command} ask x`, command, 'SHE-6/Agent')).toBe(false)
    expect(ownCall(undefined, command, chat, OWN_VERBS)).toBe(false)
  })
})

describe('a Codex permission request for its own shepherdr command', () => {
  // Codex is not installed on this host: the decision is tested directly, with the same words the permission hook reads.
  const ask = (text: unknown, path = command, who = chat, tool: unknown = 'Bash') => ownCommand(path, tool, { command: text }, who, OWN_VERBS)

  test('allows exactly this launch’s own verbs, bare or in the launch prompt’s form', () => {
    for (const text of [
      `${command} help`,
      `${command} status`,
      `${command} status EX-1 "Half done" --done 50 --left 5m`,
      `SHEPHERDR_CHAT="${chat}" ${command} ask "Rerun CI?" --choice Yes --choice No`,
      `SHEPHERDR_CHAT=${chat} ${command} ready EX-1 --summary ok`,
      `SHEPHERDR_CHAT='${chat}' ${command} secret ask TOKEN --why 'To push'`,
      `  ${command} show  `,
    ])
      expect(ask(text)).toBe(true)
  })

  test('takes the two-word verbs as pairs, never the ones that run or write anything', () => {
    for (const pair of ['secret list', 'secret ask']) {
      expect(OWN_VERBS).toContain(pair)
      expect(ask(`${command} ${pair}`)).toBe(true)
    }
    for (const text of [
      `${command} secret`,
      `${command} secret run A -- ls`,
      `${command} secret env A --file x`,
      `${command} secret elevenlabs`,
      `${command} secret listx`,
      `${command} restart EX-1`,
      `${command} doctor`,
      `${command} nonsense`,
      command,
    ])
      expect(ask(text)).toBe(false)
  })

  test('is allowed with its path quoted, as a shell needs it', () => {
    const spaced = '/home/me/My Projects/bin/shepherdr'
    expect(ask(`'${spaced}' status`, spaced)).toBe(true)
    expect(ask(`"${spaced}" status`, spaced)).toBe(true)
    expect(ask(`${spaced} status`, spaced)).toBe(false)
    expect(ask(`SHEPHERDR_CHAT="${chat}" '${spaced}' status`, spaced)).toBe(true)
  })

  test('keeps its card for a compound line, another tool, another path or another chat', () => {
    for (const text of [
      `${command} ask x; rm -rf /`,
      `${command} ask x && rm y`,
      `${command} ask x | sh`,
      `${command} ask x > ~/.bashrc`,
      `${command} ask "$(rm y)"`,
      `${command} ask \`rm y\``,
      `${command} ask $HOME`,
      `FOO=1 ${command} ask x`,
      `SHEPHERDR_CHAT="OTHER-2/Agent" ${command} ask x`,
      `"SHEPHERDR_CHAT=${chat}" ${command} ask x`,
      `timeout 120 ${command} ask x`,
      `sh -c '${command} ask x'`,
      `${command}-evil ask x`,
      `shepherdr ask x`,
    ])
      expect(ask(text), text).toBe(false)
    expect(ask(`${command} ask x`, '/other/bin/shepherdr')).toBe(false)
    expect(ask(`SHEPHERDR_CHAT="SHE-6/Agent" ${command} ask x`, command, chat)).toBe(false)
    expect(ask(`${command} ask x`, command, chat, 'Write')).toBe(false)
    // the shell argv form some tools pass instead of one string: upstream's cmd_allow unwraps ["bash","-lc",cmd]
    expect(ownCommand(command, 'Bash', { command: ['bash', '-lc', `${command} status`] }, chat, OWN_VERBS)).toBe(true)
    expect(ownCommand(command, 'Bash', { command: ['bash', '-lc', `${command} secret run A -- ls`] }, chat, OWN_VERBS)).toBe(false)
    expect(ownCommand(command, 'Bash', { command: ['bash', '-x', `${command} status`] }, chat, OWN_VERBS)).toBe(false)
    expect(ownCommand(command, 'Bash', null, chat, OWN_VERBS)).toBe(false)
    expect(ownCommand(command, 'Bash', {}, chat, OWN_VERBS)).toBe(false)
    expect(ownCommand('', 'Bash', { command: `${command} status` }, chat, OWN_VERBS)).toBe(false)
  })
})

describe('the settings file a launch gets', () => {
  test('carries the hook that allows its own command, and only for a launch that names one', () => {
    const dir = tmp('own')
    try {
      const { settings } = hookSettings(dir, 'shep-ex-1', { command, chat })
      const s = JSON.parse(readFileSync(settings, 'utf8'))
      const groups = s.hooks.PreToolUse as { matcher?: string; hooks: { command: string }[] }[]
      // the recorder first, as before, then the one that decides
      expect(groups).toHaveLength(2)
      expect(groups[0].matcher).toBeUndefined()
      expect(groups[1].matcher).toBe('Bash')
      expect(groups[1].hooks[0].command).toContain(command)
      expect(groups[1].hooks[0].command).toContain(chat)
      // an agent started without one (an older record) keeps its prompt
      expect(JSON.parse(readFileSync(hookSettings(dir, 'bare').settings, 'utf8')).hooks.PreToolUse).toHaveLength(1)
      const spaced = JSON.parse(readFileSync(hookSettings(dir, 'spaced', { command, chat: 'p:host:Letter garden' }).settings, 'utf8'))
      expect(spaced.hooks.PreToolUse[1].hooks[0].command.endsWith(`'p:host:Letter garden'`)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('runs the hook it wrote: it allows that call and leaves every other to the prompt', () => {
    const dir = tmp('own')
    try {
      const { settings } = hookSettings(dir, 'shep-ex-1', { command, chat })
      const s = JSON.parse(readFileSync(settings, 'utf8'))
      const run = (input: unknown) => spawnSync('/bin/sh', ['-c', (s.hooks.PreToolUse[1] as { hooks: { command: string }[] }).hooks[0].command], { input: JSON.stringify(input) })
      const allowed = run(bash(`SHEPHERDR_CHAT="${chat}" ${command} ready EX-1 --summary ok`))
      expect(allowed.status).toBe(0)
      expect(JSON.parse(allowed.stdout.toString()).hookSpecificOutput.permissionDecision).toBe('allow')
      for (const input of [
        bash(`${command} secret run A -- ls`),
        bash(`${command} status; echo hi`),
        bash('ls'),
        bash(`FOO=1 ${command} status`),
        { tool_name: 'Edit', tool_input: { command: `${command} status` } },
        { tool_name: 'Bash', tool_input: {} },
        { tool_name: 'Bash', tool_input: null },
        null,
      ]) {
        const r = run(input)
        expect(r.status).toBe(0)
        expect(r.stdout.toString().trim()).toBe('')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
