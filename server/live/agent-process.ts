// The CLI as herdr/ps sees it: a native binary, or npm's node/bun entry point.
export function isAgentProcess(kind: string, argv: string[] = []) {
  const name = (s: string) => s.split('/').pop() ?? ''
  if (name(argv[0] ?? '') === kind) return true
  if (!/^(node|bun)(?:\.exe)?$/.test(name(argv[0] ?? ''))) return false
  const entry = argv[1] ?? ''
  if (name(entry) === kind || name(entry) === `${kind}.js`) return true
  const packages: Record<string, string> = { pi: '/pi-coding-agent/', claude: '/claude-code/', codex: '/@openai/codex/' }
  return !!packages[kind] && entry.includes(packages[kind]) && /\.(?:m?js|cjs)$/.test(entry)
}

/**
 * A shell screen whose last line is its prompt and nothing typed after it: the only old pane safe to close when a new
 * run takes over. A word after the prompt may be the person's unfinished command, so it is left for them. `visible`
 * returns text with ANSI stripped; the marks cover bash, zsh, fish and the common custom prompts.
 */
export function barePrompt(text: string) {
  const last = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  if (!last) return false
  // a bare shell's own prompt, with nothing before it
  if (/^[$#%>]$/.test(last)) return true
  // a prompt names a user, host, folder or arrow (user@host:~$, ~/work ❯). A typed command that happens to end in a
  // redirection (`echo hi >`) is not one, and neither is any other line without that shape
  if (!/[@:~/❯➜]/.test(last)) return false
  return /(?:[$#%>]|❯|➜)$/.test(last) && !/\s[<>|&]$/.test(last)
}
