/** Extra launch flags for a task's agent CLI (upstream SHEP-266, #1222): `--advisor opus` for a Sonnet task, say.
 *
 * The flags a person can ask for are a small, deliberate surface. Two rules keep a launch safe:
 *
 * 1. Only flags the installed CLI really offers are accepted. Each CLI has a table of its flags and their arity,
 *    and the installed CLI's own `--help` is read as well, so a flag newer than the table still works. A CLI that is
 *    not installed here keeps its table (its flags are documented in the table's source comment).
 * 2. A flag Shepherdr sets itself (model, effort, permissions, session, settings, print mode, ...) is refused with
 *    the reason, never passed. Flags are kept one word each (`--advisor=opus`, one `--add-dir=/x` per value), so a
 *    value can never be taken for the first message or a session id by a launch, resume or a crash's recovery.
 *
 * `parse` is the strict, set-time check (a refusal names why). `clean` is the launch-time guard: a settings file
 * edited by hand, or a CLI updated since, drops what no longer passes instead of breaking the launch, and says what
 * it dropped so a caller can tell the person a flag belonged to another CLI.
 */

export type Kind = 'claude' | 'codex' | 'pi' | 'opencode' | 'agy'
export const KINDS: readonly Kind[] = ['claude', 'codex', 'pi', 'opencode', 'agy']
export const NAMES: Record<Kind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'pi',
  opencode: 'OpenCode',
  agy: 'Antigravity (agy)',
}

/** none: a bare flag; one: one value; many: one or more, written once per value; opt: zero or one value. */
type Arity = 'none' | 'one' | 'many' | 'opt'
interface Table {
  bin: string
  /** flags this CLI has, and how many values each takes */
  allowed: Record<string, Arity>
  /** short alias -> long name */
  short: Record<string, string>
  /** flags Shepherdr sets itself, or that would break its launch -> why they are refused */
  refused: Record<string, string>
  /** Codex's `-c key=value` keys Shepherdr sets itself -> why */
  configKeys?: Record<string, string>
}

const SET = (what: string) => `Shepherdr sets ${what} itself: use its own setting or flag instead.`
const PRINT = 'it only works in print mode, and a task agent is interactive.'

/** Claude Code: `claude --help` (the installed version) and https://code.claude.com/docs/en/cli-reference;
 *  --advisor is documented at https://code.claude.com/docs/en/advisor (not in --help). */
const CLAUDE: Table = {
  bin: 'claude',
  allowed: {
    '--add-dir': 'many',
    '--advisor': 'one',
    '--agent': 'one',
    '--agents': 'one',
    '--allow-dangerously-skip-permissions': 'none',
    '--allowedTools': 'many',
    '--allowed-tools': 'many',
    '--append-system-prompt': 'one',
    '--append-system-prompt-file': 'one',
    '--autocompact': 'one',
    '--ax-screen-reader': 'none',
    '--bare': 'none',
    '--betas': 'many',
    '--brief': 'none',
    '--channels': 'many',
    '--chrome': 'none',
    '--debug': 'opt',
    '--debug-file': 'one',
    '--disable-slash-commands': 'none',
    '--disallowedTools': 'many',
    '--disallowed-tools': 'many',
    '--exclude-dynamic-system-prompt-sections': 'none',
    '--fallback-model': 'one',
    '--file': 'many',
    '--ide': 'none',
    '--mcp-config': 'many',
    '--name': 'one',
    '--no-chrome': 'none',
    '--plugin-dir': 'one',
    '--plugin-url': 'one',
    '--prompt-suggestions': 'opt',
    '--remote-control': 'opt',
    '--rc': 'opt',
    '--remote-control-session-name-prefix': 'one',
    '--restricted': 'none',
    '--safe-mode': 'none',
    '--setting-sources': 'one',
    '--strict-mcp-config': 'none',
    '--system-prompt-snapshot': 'one',
    '--teammate-mode': 'one',
    '--tools': 'many',
    '--verbose': 'none',
  },
  short: {
    '-n': '--name',
    '-d': '--debug',
    '-c': '--continue',
    '-r': '--resume',
    '-p': '--print',
    '-w': '--worktree',
    '-h': '--help',
    '-v': '--version',
  },
  refused: {
    '--model': SET('the model'),
    '--effort': SET('the effort'),
    '--settings': SET('the hooks settings file (yours stay untouched)'),
    '--append-system-prompt': SET('the task instructions'),
    '--append-system-prompt-file': SET('the task instructions'),
    '--system-prompt': SET('the system prompt'),
    '--system-prompt-file': SET('the system prompt'),
    '--permission-mode': SET('the permission mode from Settings'),
    '--dangerously-skip-permissions': SET('the permission mode from Settings'),
    '--resume': "Shepherdr resumes the task's own session itself",
    '--continue': "Shepherdr resumes the task's own session itself",
    '--session-id': "Shepherdr resumes the task's own session itself",
    '--fork-session': "Shepherdr resumes the task's own session itself",
    '--from-pr': "Shepherdr resumes the task's own session itself",
    '--teleport': 'the agent works here, not in a cloud session',
    '--print': 'a task agent is interactive (it would answer once and exit)',
    '--bg': 'the agent must stay in its own terminal',
    '--background': 'the agent must stay in its own terminal',
    '--desktop': 'the agent must stay in its own terminal',
    '--cloud': 'the agent works here, not in a cloud session',
    '--remote': 'the agent works here, not in a cloud session',
    '--environment': 'the agent works here, not in a cloud session',
    '--correlation-id': 'it is for cloud sessions (--environment)',
    '--metadata': 'it is for cloud sessions (--environment)',
    '--ref': 'it is for cloud sessions (--environment)',
    '--exec': 'it runs a background job (--bg), not an agent',
    '--worktree': 'Shepherdr gives each task its own worktree already',
    '--tmux': 'Shepherdr gives each task its own worktree already',
    '--init-only': 'it exits before the agent starts',
    '--version': 'it exits before the agent starts',
    '--help': 'it exits before the agent starts',
    '--output-format': PRINT,
    '--input-format': PRINT,
    '--json-schema': PRINT,
    '--max-budget-usd': PRINT,
    '--max-turns': PRINT,
    '--no-session-persistence': PRINT,
    '--forward-subagent-text': PRINT,
    '--include-partial-messages': PRINT,
    '--include-hook-events': PRINT,
    '--replay-user-messages': PRINT,
    '--append-subagent-system-prompt': PRINT,
    '--append-subagent-system-prompt-file': PRINT,
    '--init': PRINT,
    '--maintenance': PRINT,
    '--permission-prompts': PRINT,
    '--permission-prompt-tool': PRINT,
  },
}

/** Codex: `codex --help` and `codex resume --help` (0.163.0, as recorded upstream; Codex is not installed on this
 *  host, so its table comes from that documented reference and its flags are tested without a live binary). */
const CODEX: Table = {
  bin: 'codex',
  allowed: {
    '--config': 'many',
    '--enable': 'one',
    '--disable': 'one',
    '--strict-config': 'none',
    '--image': 'many',
    '--oss': 'none',
    '--local-provider': 'one',
    '--profile': 'one',
    '--dangerously-bypass-hook-trust': 'none',
    '--add-dir': 'one',
    '--search': 'none',
    '--no-alt-screen': 'none',
  },
  short: {
    '-c': '--config',
    '-i': '--image',
    '-p': '--profile',
    '-m': '--model',
    '-s': '--sandbox',
    '-a': '--ask-for-approval',
    '-C': '--cd',
    '-h': '--help',
    '-V': '--version',
  },
  refused: {
    '--model': SET('the model'),
    '--sandbox': SET('the sandbox and approvals from Settings'),
    '--ask-for-approval': SET('the sandbox and approvals from Settings'),
    '--dangerously-bypass-approvals-and-sandbox': SET('the sandbox and approvals from Settings'),
    '--approve-for-me': SET('the sandbox and approvals from Settings'),
    '--full-auto': SET('the sandbox and approvals from Settings'),
    '--no-daemon': 'Shepherdr passes it already',
    '--remote': 'a task agent runs on its own app server (--no-daemon)',
    '--remote-auth-token-env': 'a task agent runs on its own app server (--no-daemon)',
    '--cd': "Shepherdr starts the agent in the task's folder",
    '--worktree': 'Shepherdr gives each task its own worktree already',
    '--last': "Shepherdr resumes the task's own session itself",
    '--all': "Shepherdr resumes the task's own session itself",
    '--include-non-interactive': "Shepherdr resumes the task's own session itself",
    '--help': 'it exits before the agent starts',
    '--version': 'it exits before the agent starts',
  },
  configKeys: {
    model: SET('the model'),
    model_reasoning_effort: SET('the effort'),
    service_tier: SET('the speed from Settings'),
    sandbox_mode: SET('the sandbox and approvals from Settings'),
    approval_policy: SET('the sandbox and approvals from Settings'),
    projects: "Shepherdr trusts the task's folder itself",
    hooks: "Shepherdr sets the chat's question card's hook itself",
  },
}

/** pi: the installed `pi --help`. pi has no permission system and keeps its session by id, so the refused list is
 *  mostly models, session and print mode. Extensions may add their own flags, which --help then lists. */
const PI: Table = {
  bin: 'pi',
  allowed: {
    '--session-dir': 'one',
    '--name': 'one',
    '--models': 'one',
    '--no-tools': 'none',
    '--no-builtin-tools': 'none',
    '--tools': 'one',
    '--exclude-tools': 'one',
    '--extension': 'one',
    '--no-extensions': 'none',
    '--no-mcp': 'none',
    '--skill': 'one',
    '--no-skills': 'none',
    '--prompt-template': 'one',
    '--no-prompt-templates': 'none',
    '--theme': 'one',
    '--use-theme': 'one',
    '--no-themes': 'none',
    '--no-context-files': 'none',
    '--verbose': 'none',
    '--tui-mode': 'one',
    '--offline': 'none',
  },
  short: {
    '-p': '--print',
    '-r': '--resume',
    '-c': '--continue',
    '-a': '--approve',
    '-n': '--name',
    '-nt': '--no-tools',
    '-nbt': '--no-builtin-tools',
    '-t': '--tools',
    '-xt': '--exclude-tools',
    '-e': '--extension',
    '-ne': '--no-extensions',
    '-ns': '--no-skills',
    '-np': '--no-prompt-templates',
    '-nc': '--no-context-files',
    '-na': '--no-approve',
  },
  refused: {
    '--model': SET('the model'),
    '--provider': SET('the model provider'),
    '--api-key': 'it is a secret: put it in pi’s own auth, not a launch flag',
    '--system-prompt': SET('the system prompt'),
    '--append-system-prompt': SET('the task instructions'),
    '--thinking': SET('the effort'),
    '--mode': "it is pi's output mode, not the agent's mode",
    '--session': "Shepherdr resumes the task's own session itself",
    '--session-id': "Shepherdr resumes the task's own session itself",
    '--resume': "Shepherdr resumes the task's own session itself",
    '--continue': "Shepherdr resumes the task's own session itself",
    '--fork': "Shepherdr resumes the task's own session itself",
    '--no-session': "Shepherdr keeps the task's session",
    '--approve': 'Shepherdr trusts a worktree for this run itself',
    '--no-approve': 'Shepherdr trusts a worktree for this run itself',
    '--print': 'a task agent is interactive (it would answer once and exit)',
    '--export': PRINT,
    '--list-models': 'it lists models and exits',
    '--help': 'it exits before the agent starts',
    '--version': 'it exits before the agent starts',
  },
}

/** OpenCode: the installed `opencode --help`. Its TUI takes very few flags (the model and effort live in its
 *  session), so the useful extras are its log-level and print-logs flags. The rest are what Shepherdr sets. */
const OPENCODE: Table = {
  bin: 'opencode',
  allowed: { '--log-level': 'one', '--print-logs': 'none' },
  short: { '-s': '--session', '-c': '--continue', '-h': '--help', '-v': '--version' },
  refused: {
    '--standalone': SET('the private server'),
    '--server': SET('the private server'),
    '--session': "Shepherdr resumes the task's own session itself",
    '--continue': "Shepherdr resumes the task's own session itself",
    '--auto': SET('the permission mode from Settings'),
    '--prompt': 'the first message is sent into the pane, not typed as a flag',
    '--wizard': 'it opens the setup wizard',
    '--completions': 'it prints a completion script and exits',
    '--help': 'it exits before the agent starts',
    '--version': 'it exits before the agent starts',
  },
}

/** agy: the installed `agy --help` (Antigravity CLI; Go's flag package). A Go flag's arity is not in --help, so the
 *  table carries it. The refused list covers print mode, cloud sessions and what Shepherdr sets at launch. */
const AGY: Table = {
  bin: 'agy',
  allowed: {
    '--add-dir': 'many',
    '--agent': 'one',
    '--disable-slash-commands': 'none',
    '--log-file': 'one',
  },
  short: { '-c': '--continue', '-i': '--prompt-interactive', '-p': '--print' },
  refused: {
    '--model': SET('the model'),
    '--effort': SET('the model effort'),
    '--settings': SET('the worktree trust settings'),
    '--conversation': "Shepherdr resumes the task's own session itself",
    '--continue': "Shepherdr resumes the task's own session itself",
    '--dangerously-skip-permissions': SET('the permission mode from Settings'),
    '--mode': "Shepherdr uses it for a reviewer's read-only run",
    '--print': 'a task agent is interactive (it would answer once and exit)',
    '--prompt': 'the first message is sent into the pane, not typed as a flag',
    '--prompt-interactive': 'it runs a single prompt and exits',
    '--input-format': PRINT,
    '--output-format': PRINT,
    '--json-schema': PRINT,
    '--print-timeout': PRINT,
    '--remote-agent': 'the agent works here, not in a cloud session',
    '--remote-control': 'the agent works here, not in a cloud session',
    '--new-project': "Shepherdr uses the task's own folder",
    '--project': "Shepherdr uses the task's own folder",
    '--sandbox': "Shepherdr sets the sandbox from Settings' permission mode",
    '--help': 'it exits before the agent starts',
    '--version': 'it exits before the agent starts',
  },
}

const TABLES: Record<Kind, Table> = { claude: CLAUDE, codex: CODEX, pi: PI, opencode: OPENCODE, agy: AGY }

const isKind = (k: string): k is Kind => Object.hasOwn(TABLES, k)

/** a cached `--help` per CLI. A test can set one with `setHelp(kind, text)` so no binary is needed. */
const helps = new Map<string, string>()

/** install a help page for a CLI (tests, or a caller that already read it); `undefined` clears the cache. */
export function setHelp(kind: string, text?: string) {
  if (text === undefined) helps.delete(kind)
  else helps.set(kind, text)
}

/** read a CLI's --help once, quietly, with a ceiling. A CLI that is missing or says nothing yields ''. */
function helpOf(kind: Kind): string {
  const hit = helps.get(kind)
  if (hit !== undefined) return hit
  let text = ''
  try {
    const p = Bun.spawnSync([TABLES[kind].bin, '--help'], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 10_000 })
    text = new TextDecoder().decode(p.stdout)
  } catch {
    // a CLI that isn't installed, or that can't be started here: its table still stands
  }
  helps.set(kind, text)
  return text
}

/** the long flags a CLI's own --help lists. Formats differ: claude/pi use `  --flag <value>` and `  -x, --flag`,
 *  opencode uses `  --flag, -x string`, agy uses Go's bare `  --flag`. Only long names are kept; arity for a flag
 *  that is new since the table is inferred from the help line. */
function helpFlags(text: string): Record<string, Arity> {
  const out: Record<string, Arity> = {}
  for (const line of text.split('\n')) {
    if (!/^\s{1,10}-{1,2}[\w]/.test(line)) continue
    const names: string[] = []
    let arity: Arity = 'none'
    for (const m of line.matchAll(/--([\w-]+)/g)) names.push(`--${m[1]}`)
    if (!names.length) continue
    const after = line.replace(/^\s*(?:-{1,2}[\w-]+,?\s+)*-{1,2}[\w-]+/, '')
    if (/<[^>]*\.\.\.[^>]*>|\.\.\./.test(after)) arity = 'many'
    else if (/<[^>]+>|\bstring\b|\bint\b/.test(after)) arity = 'one'
    else if (/\[[^\]]+\]/.test(after)) arity = 'opt'
    for (const n of names) out[n] = arity
  }
  return out
}

/** a shell-like split: quotes and backslashes keep a value with spaces in one word. An unclosed quote is a refusal. */
function splitWords(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | undefined
  let had = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      had = true
      continue
    }
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i]
      had = true
      continue
    }
    if (/\s/.test(c)) {
      if (had || cur) {
        out.push(cur)
        cur = ''
        had = false
      }
      continue
    }
    cur += c
    had = true
  }
  if (quote) throw new Error('Those flags have an unclosed quote.')
  if (had || cur) out.push(cur)
  return out
}

/** parse and normalize `given` (a shell line, or a list of words) for `kind`. A refusal throws with why.
 *  Each flag is one word: `--advisor opus` -> `--advisor=opus`, a repeated flag one word per value. */
export function parseFlags(kind: string, given: string | string[], help?: string): string[] {
  if (!isKind(kind)) throw new Error(`Extra flags are for ${KINDS.join(', ')}, not ${kind}.`)
  const table = TABLES[kind]
  const words = typeof given === 'string' ? splitWords(given) : (given ?? []).map(String)
  const fromHelp = helpFlags(help ?? helpOf(kind))
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (!w.startsWith('-') || w === '-' || w === '--') {
      throw new Error(`${JSON.stringify(w)} isn't a flag: extra flags are flags of ${NAMES[kind]}, each with its value (not a prompt or command).`)
    }
    let [name, eq, val] = [w.split('=')[0], w.includes('='), w.slice(w.indexOf('=') + 1)]
    if (!name.startsWith('--')) {
      if (name.length > 2 && !eq) {
        val = name.slice(2)
        name = name.slice(0, 2)
      }
      name = table.short[name] ?? name
    }
    const why = table.refused[name]
    if (why) throw new Error(`${name} can't be an extra flag: ${why}`)
    const arity = table.allowed[name] ?? fromHelp[name]
    if (!arity) throw new Error(`${NAMES[kind]} has no ${name} flag (see \`${table.bin} --help\`).`)
    if (arity === 'none') {
      if (eq) throw new Error(`${name} takes no value.`)
      out.push(name)
      continue
    }
    const vals = eq ? [val] : []
    if (!eq && i + 1 < words.length && !words[i + 1].startsWith('-')) vals.push(words[++i])
    while (arity === 'many' && i + 1 < words.length && !words[i + 1].startsWith('-')) vals.push(words[++i])
    if ((arity === 'one' || arity === 'many') && (!vals.length || vals.some((v) => v === ''))) {
      throw new Error(`${name} needs a value, like ${name} <value>.`)
    }
    if (arity === 'opt' && !vals.length) {
      out.push(name)
      continue
    }
    for (const v of vals) {
      if (kind === 'codex' && name === '--config') {
        const key = v.split(/[.=]/, 1)[0].trim()
        if (!v.includes('=') || !key) throw new Error('--config takes key=value, like -c model_verbosity="high".')
        const set = table.configKeys?.[key]
        if (set) throw new Error(`-c ${key} can't be an extra flag: ${set}`)
      }
      out.push(`${name}=${v}`)
    }
  }
  return out
}

/** the flags of `given` that still pass, with those that don't (a settings file edited by hand, a CLI updated since,
 *  a flag left over from a switch to another CLI). A launch never breaks on one of them, and the caller can say what
 *  was dropped. */
export function cleanFlags(kind: string, given: string[], help?: string): { keep: string[]; dropped: string[] } {
  const keep: string[] = []
  const dropped: string[] = []
  for (const w of given ?? []) {
    try {
      keep.push(...parseFlags(kind, [String(w)], help))
    } catch {
      dropped.push(String(w))
    }
  }
  return { keep, dropped }
}

/** a whole settings line as flags, keeping what still passes when the rest is hand-edited junk: unlike `parse`, a
 *  launch or a stored row never breaks on one bad flag. */
export function cleanFlagsLine(kind: string, line: string): string[] {
  if (!line.trim()) return []
  try {
    return parseFlags(kind, line)
  } catch {
    const out: string[] = []
    for (const w of line.trim().split(/\s+/)) {
      try {
        out.push(...parseFlags(kind, [w]))
      } catch {
        // one bad flag drops only itself
      }
    }
    return out
  }
}

/** the flags as one shell line, quoted only where a shell needs it: for the brief's Agent line. */
export function flagWords(flags: string[]): string {
  return (flags ?? []).map((w) => (/^[\w@%+=:,./-]+$/.test(String(w)) ? String(w) : `'${String(w).replace(/'/g, "'\\''")}'`)).join(' ')
}

/** the extra flags already in an agent's argv (those parseFlags keeps as written), for a chat's model button and for
 *  a restart. Shepherdr's own flags are all in the refused table, so they never come back as extra. */
export function extraFlags(kind: string, argv: string[]): string[] {
  if (!isKind(kind)) return []
  const table = TABLES[kind]
  const out: string[] = []
  for (const a of argv ?? []) {
    const w = String(a)
    if (!w.startsWith('--')) continue
    const name = w.split('=')[0]
    if (!w.includes('=') && table.allowed[name] !== 'none') continue
    if (Object.hasOwn(table.refused, name)) continue
    if (kind === 'codex' && name === '--config') {
      const key = (w.split('=')[1] ?? '').split(/[.=]/)[0]
      if (Object.hasOwn(table.configKeys ?? {}, key)) continue
    }
    if (Object.hasOwn(table.allowed, name) || /^--[\w-]+=\S/.test(w)) out.push(w)
  }
  return out
}
