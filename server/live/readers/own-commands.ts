// The Shepherdr command an agent Shepherdr started may run without a permission prompt: this launch's exact command
// path, verb by verb.
//
// Upstream 2.1 (server/core/own-commands.ts, ca9629cf) writes Claude Code Bash rules for it. A Bash rule matches a whole
// command line by prefix, so a rule for `<path> status` also lets `<path> status; echo hi` through, and with it any
// verb, `secret run` included (measured on Claude Code 2.1.318). Here the decision is a PreToolUse hook instead, written
// into the same settings file (readers/hooks.ts): it parses the call and allows exactly one plain call of that path with
// one of the verbs below. `secret run` (it runs any program), `secret env` (it writes a file), a verb that isn't
// listed, and a command line with anything else in it keep their prompt.

/** the verbs that never ask, as the CLI spells them (two words where the CLI takes two). `done` is `ready`'s older
 *  name, still taken; `secret elevenlabs` writes a secret, so it stays out with `secret run` and `secret env` */
export const OWN_VERBS = [
  'help',
  'show',
  'models',
  'set',
  'unset',
  'alert',
  'space',
  'task',
  'status',
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
]

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
  const unquote = (word: string) =>
    word.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_all: string, one?: string, two?: string) => one ?? two!.replace(/\\(.)/g, '$1'))
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

/** what the hook answers on stdout: an allow for this launch's own command, or nothing at all (the prompt as before) */
export function ownDecision(command: string, chat: string | undefined, input: any): string | undefined {
  if (!input || input.tool_name !== 'Bash' || !ownCall(input.tool_input?.command, command, chat, OWN_VERBS)) return undefined
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'This launch’s own Shepherdr command',
    },
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
