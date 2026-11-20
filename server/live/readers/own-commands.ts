// The Shepherdr command an agent Shepherdr started may run without a permission prompt: this launch's exact command
// path, verb by verb.
//
// Upstream 2.1 (server/core/own-commands.ts, ca9629cf) writes Claude Code Bash rules for it. A Bash rule matches a whole
// command line by prefix, so a rule for `<path> status` also lets `<path> status; echo hi` through, and with it any
// verb, `secret run` included (measured on Claude Code 2.1.318). Here the decision is a PreToolUse hook instead, written
// into the same settings file (readers/hooks.ts): it parses the call and allows exactly one plain call of that path with
// one of the verbs below. `secret run` (it runs any program), `secret env` (it writes a file), a verb that isn't
// listed, and a command line with anything else in it keep their prompt.

import { CLI_VERBS } from '../args.ts'

/** CLI verbs deliberately kept behind a card: they write outside Shepherdr, run another program, name a verb that is
 *  gone, or are an old alias. `secret elevenlabs` writes a secret, so it stays out along with `secret run` and
 *  `secret env`. This list and the allowed one below are pinned to CLI_VERBS by test/own-verbs.test.ts: adding a verb
 *  to command() without placing it in one of them fails that test. */
export const CARDED_VERBS = ['project', 'mode', 'restart', 'attach', 'render', 'preview', 'profile', 'doctor', 'secret'] as const

/** the allowed one-word verbs, in the order the generated hook has always written them; kept here for that byte-exact
 *  output and filtered to the verbs still in CLI_VERBS. test/own-verbs.test.ts pins both lists to CLI_VERBS. */
const ALLOWED = [
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
] as const

/** the verbs that never ask, as the CLI spells them (two words where the CLI takes two). `done` is `ready`'s older
 *  name, still taken. The two-word pairs are the only verbs the CLI spells as two words. */
export const OWN_VERBS: string[] = ['help', ...ALLOWED.filter((v) => CLI_VERBS.includes(v)), 'secret list', 'secret ask']

/**
 * Whether a guard's command is only this launch's own Shepherdr command: one plain call of exactly `command`, with one
 * of `own` as its first words, either bare or in the launch prompt's own `SHEPHERDR_CHAT="<chat>"` form.
 *
 * Self-contained: the hook script carries this function's source (`deciderScript`).
 */
export function ownCall(text: unknown, command: string, chat: string | undefined, own: string[]): boolean {
  if (typeof text !== 'string') return false
  // One plain word: no expansion, redirect, separator or line break can sit outside a quote, or $ and ` inside one.
  const WORD = /(?:[\w@%+=:,./-]+|'[^']*'|"(?:[^"\\$`]|\\["\\])*")+/y
  const unquote = (word: string) => word.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_all: string, one?: string, two?: string) => one ?? two!.replace(/\\(.)/g, '$1'))
  const line = text.trim()
  const words: string[] = []
  for (let at = 0; at < line.length; ) {
    if (line[at] === ' ' || line[at] === '\t') {
      at++
      continue
    }
    WORD.lastIndex = at
    const word = WORD.exec(line)
    if (!word) return false
    words.push(word[0])
    at = WORD.lastIndex
  }
  // the launch prompt's form, and only this launch's identity in it: its name must be unquoted, so a word a shell would
  // run as a command (`"SHEPHERDR_CHAT=…"` is one, quotes and all) never matches
  const PREFIX = 'SHEPHERDR_CHAT='
  const value = /^(?:[\w@%+=:,./~-]+|'[^']*'|"(?:[^"\\$`]|\\["\\])*")$/
  const named = (word: string) => word.startsWith(PREFIX) && value.test(word.slice(PREFIX.length)) && unquote(word) === PREFIX + chat
  const first = chat && named(words[0] ?? '') ? 1 : 0
  if (unquote(words[first] ?? '') !== command) return false
  const verb = words.slice(first + 1).map(unquote)
  return own.some((allowed) => {
    const parts = allowed.split(' ')
    return parts.every((part, i) => verb[i] === part)
  })
}

/** the hook Claude Code runs before a Bash call: reads it on stdin, allows this launch's own command, says nothing else.
 *  Its arguments are the command path and this launch's chat identity */
export const deciderScript = () => `// Written by Shepherdr: lets a launch run its own Shepherdr command without a prompt (readers/own-commands.ts).
const OWN = ${JSON.stringify(OWN_VERBS)}
const ownCall = ${ownCall.toString()}
const command = process.argv[2]
const chat = process.argv[3] || undefined
let s = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (s += c))
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(s)
    if (input?.tool_name !== 'Bash') return
    if (!ownCall(input?.tool_input?.command, command, chat, OWN)) return
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'This launch’s own Shepherdr command' } }))
  } catch {}
})
`

/**
 * The Codex half of SHEP-23 (upstream ca9629cf's server/core/own-commands.ts): whether a Codex PermissionRequest is
 * only this launch's own Shepherdr command, with the same verbs the Claude hook allows. Codex names the call in
 * `tool_name`/`tool_input.command`; the optional `chat` accepts the launch prompt's `SHEPHERDR_CHAT` form 2.0 uses,
 * which upstream (a different command shape) had no need for. Self-contained: the Codex hook script carries this
 * function's source, so its word parser is copied from ownCall rather than shared with it.
 */
export function ownCommand(command: string, tool: unknown, input: unknown, chat?: string, own: string[] = OWN_VERBS): boolean {
  if (tool !== 'Bash' || typeof command !== 'string' || !command) return false
  const text = (input as { command?: unknown } | null | undefined)?.command
  if (typeof text !== 'string') return false
  // One plain word: no expansion, redirect, separator or line break can sit outside a quote, or $ and ` inside one.
  const WORD = /(?:[\w@%+=:,./-]+|'[^']*'|"(?:[^"\\$`]|\\["\\])*")+/y
  const unquote = (word: string) => word.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_all: string, one?: string, two?: string) => one ?? (two ?? '').replace(/\\(.)/g, '$1'))
  const line = text.trim()
  const words: string[] = []
  for (let at = 0; at < line.length; ) {
    if (line[at] === ' ' || line[at] === '\t') {
      at++
      continue
    }
    WORD.lastIndex = at
    const word = WORD.exec(line)
    if (!word) return false
    words.push(word[0])
    at = WORD.lastIndex
  }
  const PREFIX = 'SHEPHERDR_CHAT='
  const value = /^(?:[\w@%+=:,./~-]+|'[^']*'|"(?:[^"\\$`]|\\["\\])*")$/
  const named = (word: string) => word.startsWith(PREFIX) && value.test(word.slice(PREFIX.length)) && unquote(word) === PREFIX + chat
  const first = chat && named(words[0] ?? '') ? 1 : 0
  if (unquote(words[first] ?? '') !== command) return false
  const verb = words.slice(first + 1).map(unquote)
  return own.some((allowed) => {
    const parts = allowed.split(' ')
    return parts.every((part, i) => verb[i] === part)
  })
}

/**
 * The hook a Codex launch runs on PermissionRequest: allows exactly this launch's own command, says nothing about
 * anything else so Codex shows its own prompt. Codex's hook answer has the same shape as Claude's (upstream's
 * helper/core-hook.ts). This fork has no core-side permission mailbox: the decision is made here, in the launch's
 * own hook, which is why it needs the exact command path and chat identity as arguments.
 */
export const codexDeciderScript = () => `// Written by Shepherdr: lets a Codex launch run its own Shepherdr command without a prompt (readers/own-commands.ts).
const OWN_VERBS = ${JSON.stringify(OWN_VERBS)}
const ownCommand = ${ownCommand.toString()}
const command = process.argv[2]
const chat = process.argv[3] || undefined
let s = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (s += c))
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(s)
    if (input?.hook_event_name !== 'PermissionRequest') return
    if (!ownCommand(command, input?.tool_name, input?.tool_input, chat, OWN_VERBS)) return
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }))
  } catch {}
})
`

/** OpenCode's shell permission rules for one launch, appended after its broad ask rule (the last match wins). Its
 *  wildcards are whole-value, so each own verb gets its own rule ending in ` *` (which also matches the verb alone):
 *  a bare path, a verb not listed (`secret run`, `secret env`) and a compound line still ask. The `SHEPHERDR_CHAT=*`
 *  form covers the launch prompt's assignment, whichever way the agent quotes its value. */
export const ownShellRules = (command: string): { action: string; resource: string; effect: string }[] =>
  OWN_VERBS.flatMap((verb) => [
    { action: 'shell', resource: `${command} ${verb} *`, effect: 'allow' },
    { action: 'shell', resource: `SHEPHERDR_CHAT=* ${command} ${verb} *`, effect: 'allow' },
  ])
