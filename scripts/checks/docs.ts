// Check after scripts (audit 2026-11-18, QG-09): two cheap consistency checks the gate lacked. Every relative markdown
// link in docs/, README.md, AGENTS.md and skill/ must resolve, and every `shepherdr <verb>` instruction in docs/ and
// skill/ must be a command shepherdr help actually lists, so a renamed verb can no longer leave stale orders that task
// agents obey. External URLs are never fetched: only repo-relative links are checked. The verb list is read from the
// same HELP constant the CLI returns (server/live/args.ts), so the check and the command cannot drift apart.
// The runner discovers the executable shim scripts/checks/18-docs; the logic and its fixture tests live here.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { HELP } from '../../server/live/args.ts'

export type Options = { root: string; log?: (line: string) => void; note?: (line: string) => void }

/** files whose `shepherdr` verbs quote upstream's commands as their subject, not instructions for our agents
 *  (the language rule's "quoted sources stay verbatim"); the two upstream pages record what another line does */
export const QUOTED = new Set(['docs/upstream.md', 'docs/upstream-ledger.md'])

/** the repo-relative targets of markdown links; schemes (http, task:, space:…), anchors and absolute paths are skipped */
export function linkTargets(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\]\(([^)]*)\)/g)) {
    const target = m[1].trim().split(/\s/)[0]
    if (!target || target.startsWith('#') || target.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue
    out.push(target)
  }
  return out
}

/** whether a relative link target resolves to a file, relative to the file that holds it; anchors and escapes handled */
export function linkExists(root: string, file: string, target: string): boolean {
  let path = target.split('#')[0]
  try {
    path = decodeURIComponent(path)
  } catch {
    /* a literal % in a file name: look it up as written */
  }
  if (!path) return true
  return existsSync(resolve(root, dirname(file), path))
}

type Tok = { text: string; arg: boolean }
/** the words after `shepherdr ` in HELP: leading command words, then the first argument marker (a placeholder, flag…) */
function tokens(rest: string): Tok[] {
  const out: Tok[] = []
  const re = /^(\s+)|^([a-z][a-z0-9-]*)(?=\||\s|$)|^(\S)/g
  let idx = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(rest.slice(idx)))) {
    idx += m[0].length
    if (m[2]) out.push({ text: m[2], arg: false })
    else if (m[3]) {
      out.push({ text: m[3], arg: true })
      break
    }
    re.lastIndex = 0
  }
  return out
}

/** expand HELP's `pause|resume|run|remove` alternatives into one command per spelling */
function expand(line: string): string[] {
  const m = line.match(/\b[a-z]+(?:\|[a-z]+)+\b/)
  if (!m) return [line]
  const at = m.index ?? 0
  return m[0].split('|').flatMap((alt) => expand(`${line.slice(0, at)}${alt}${line.slice(at + m[0].length)}`))
}

export type Verbs = { commands: Map<string, { takesArg: boolean }>; groups: Set<string> }

/** the commands HELP lists, each with whether it is followed by an argument, and the groups that need a subcommand */
export function helpVerbs(help: string = HELP): Verbs {
  const commands = new Map<string, { takesArg: boolean }>()
  for (const raw of help.split('\n')) {
    const line = raw.replace(/^\s*/, '')
    if (!line.startsWith('shepherdr ')) continue
    for (const ex of expand(line)) {
      // HELP pads the command column with two or more spaces before its English description: cut there
      const cut = ex.search(/ {2,}/)
      const part = cut > 0 ? ex.slice(0, cut) : ex
      const ts = tokens(part.slice('shepherdr '.length))
      const seq = ts
        .filter((t) => !t.arg)
        .map((t) => t.text)
        .join(' ')
      if (!seq) continue
      const takesArg = ts.some((t) => t.arg)
      const prev = commands.get(seq)
      commands.set(seq, { takesArg: (prev?.takesArg ?? false) || takesArg })
    }
  }
  commands.set('help', { takesArg: false }) // the verb that prints HELP, handled before the switch (source.ts)
  const groups = new Set([...commands.keys()].map((k) => k.split(' ')[0]).filter((k) => k !== 'help'))
  groups.add('project') // old alias for space, still accepted by the CLI but not spelled out in HELP
  return { commands, groups }
}

export type Mention = { line: number; seq: string[] }

/** command-looking `shepherdr …` mentions: in inline code or at the start of a line (after a list marker); line-wrapped
 *  spans are joined. Prose uses of the word ("the shepherdr skill", "eliasstravik/shepherdr") are not mentions. */
export function commandMentions(text: string): Mention[] {
  const out: Mention[] = []
  const re = /(?:`|(?:^|\n)[ \t]*(?:[-*+>]|\d+\.)?[ \t]*?)shepherdr\s+([^`]*)/g
  for (const m of text.matchAll(re)) {
    const seq = tokens(m[1])
      .filter((t) => !t.arg)
      .map((t) => t.text)
    if (!seq.length) continue
    // count to `shepherdr`, not the match's start: the line-start branch of the regex consumes the preceding newline
    const at = m.index + m[0].indexOf('shepherdr')
    out.push({ line: text.slice(0, at).split('\n').length, seq })
  }
  return out
}

/** a mention is known if it is a command, a bare command group (a category reference), or a command plus its argument */
export function isKnown(seq: string[], verbs: Verbs): boolean {
  if (seq.length === 1 && verbs.groups.has(seq[0])) return true
  if (verbs.commands.has(seq.join(' '))) return true
  for (let n = seq.length - 1; n >= 1; n--) {
    const cmd = verbs.commands.get(seq.slice(0, n).join(' '))
    if (cmd) return cmd.takesArg
  }
  return false
}

/** the markdown files this check reads, relative to the root */
export function docFiles(root: string): string[] {
  const out: string[] = []
  for (const name of ['README.md', 'AGENTS.md']) {
    const p = join(root, name)
    if (existsSync(p)) out.push(p)
  }
  for (const dir of ['docs', 'skill']) {
    const base = join(root, dir)
    if (!existsSync(base)) continue
    const walk = (d: string) => {
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (n.endsWith('.md')) out.push(p)
      }
    }
    walk(base)
  }
  return out
}

/** resolve every relative link and check every command in <root>: 0 on a clean tree, non-zero naming each bad one */
export function runDocs(o: Options): number {
  const verbs = helpVerbs()
  let links = 0
  let commands = 0
  let bad = 0
  for (const file of docFiles(o.root)) {
    const rel = relative(o.root, file)
    const text = readFileSync(file, 'utf8')
    for (const target of linkTargets(text)) {
      links++
      if (!linkExists(o.root, rel, target)) {
        o.log?.(`${rel}: broken relative link: ${target}`)
        bad++
      }
    }
    if (QUOTED.has(rel)) continue
    for (const { line, seq } of commandMentions(text)) {
      commands++
      if (!isKnown(seq, verbs)) {
        o.log?.(`${rel}:${line}: unknown shepherdr command: shepherdr ${seq.join(' ')}`)
        bad++
      }
    }
  }
  if (bad) {
    o.log?.(`docs: ${bad} bad link${bad === 1 ? '' : 's'} or command${bad === 1 ? '' : 's'}`)
    return 1
  }
  o.note?.(`docs: ${links} relative links, ${commands} commands checked`)
  return 0
}

/** the runner's environment, gathered in one place so a test can drive the same entry point */
export function main(env: Record<string, string | undefined> = process.env): number {
  const root = env.SHEPHERDR_CHECK_ROOT ?? join(import.meta.dir, '..', '..')
  const write = (file: string | undefined, text: string) => {
    if (file) writeFileSync(file, `${text}\n`)
  }
  return runDocs({
    root,
    log: (line) => console.log(line),
    note: (line) => write(env.SHEPHERDR_CHECK_NOTE, line),
  })
}

// coverage-exempt: the runner executes this entry point; the tests drive main() and runDocs() directly
if (import.meta.main) process.exit(main())
