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
  // the prompt's mark must be the last thing on the line: `user@host:~$ echo $` has words the person typed after it
  const at = last.search(/[$#%>❯➜]/)
  if (at < 0 || last.slice(at + 1).trim()) return false
  // a bare shell's own prompt, with nothing before it
  if (/^[$#%>]$/.test(last)) return true
  // a prompt names a user, host, folder or arrow (user@host:~$, ~/work ❯); a typed command ending in `>` does not
  return /[@:~/❯➜]/.test(last.slice(0, at))
}
