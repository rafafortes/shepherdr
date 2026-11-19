// The docs step (audit 2026-11-18, QG-09): a broken relative markdown link fails naming the file and target, a renamed
// `shepherdr` verb in skill/ fails naming the line, while the real tree's links and commands pass. These drive the real
// module over fixture trees under /tmp; the verb list comes from the CLI's own HELP, so a fixture cannot make up verbs.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commandMentions, docFiles, helpVerbs, isKnown, linkExists, linkTargets, main, runDocs } from '../scripts/checks/docs.ts'
import { tmp } from './tmp.ts'

/** a fixture tree with docs/, skill/, README.md, AGENTS.md; optional planted broken link, stale verb and upstream page */
function tree(plant?: { link?: string; verb?: string; upstream?: boolean }) {
  const dir = tmp('checks-docs')
  mkdirSync(join(dir, 'docs'), { recursive: true })
  mkdirSync(join(dir, 'skill', 'shepherdr'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# Fixture\n\n[Guide](docs/guide.md)\n')
  writeFileSync(join(dir, 'AGENTS.md'), '# Agents\n\n[Guide](docs/guide.md)\n')
  writeFileSync(join(dir, 'docs', 'guide.md'), '# Guide\n\nSee [settings](settings.md#models).\n')
  writeFileSync(join(dir, 'docs', 'settings.md'), '# Settings\n')
  writeFileSync(join(dir, 'skill', 'shepherdr', 'SKILL.md'), '# Skill\n\nUse `shepherdr task review-more SHE-89` and `shepherdr checks SHE-89`.\n')
  if (plant?.link) writeFileSync(join(dir, 'docs', 'broken.md'), `# Broken\n\n[target](${plant.link})\n`)
  if (plant?.verb) writeFileSync(join(dir, 'skill', 'shepherdr', 'BAD.md'), `# Bad\n\nRun \`shepherdr ${plant.verb}\`.\n`)
  if (plant?.upstream) writeFileSync(join(dir, 'docs', 'upstream-ledger.md'), '# Ledger\n\nupstream had `shepherdr whisper`\n')
  return dir
}

describe('relative link targets', () => {
  test('keeps repo-relative links, drops schemes, anchors, absolute paths and a link title', () => {
    const text = '[a](settings.md#models "Settings") [b](https://example.com) [c](#top) [d](/abs/path.png) [e](task:SHE-12) [f](space:p:vm:gtm) [g](../skill/shepherdr/SKILL.md) ![h](img.png)'
    expect(linkTargets(text)).toEqual(['settings.md#models', '../skill/shepherdr/SKILL.md', 'img.png'])
  })

  test('resolves relative to the file, stripping anchors and URI escapes; a missing file fails', () => {
    const root = tree()
    expect(linkExists(root, 'docs/guide.md', 'settings.md#models')).toBe(true)
    expect(linkExists(root, 'README.md', 'docs/guide.md')).toBe(true)
    expect(linkExists(root, 'skill/shepherdr/SKILL.md', '../shepherdr/SKILL.md')).toBe(true)
    expect(linkExists(root, 'docs/guide.md', 'gone.md')).toBe(false)
    expect(linkExists(root, 'docs/guide.md', 'a%20file.md')).toBe(false)
    expect(linkExists(root, 'docs/guide.md', '#only-anchor')).toBe(true)
    expect(linkExists(root, 'docs/guide.md', '%zz')).toBe(false) // a malformed escape stays as written; no such file
  })
})

describe('the command verb list', () => {
  test('reads the commands the CLI help lists, including help and the old project alias', () => {
    const v = helpVerbs()
    expect(v.commands.has('task review-more')).toBe(true)
    expect(v.commands.has('checks')).toBe(true)
    expect(v.commands.has('help')).toBe(true)
    expect(v.groups.has('task')).toBe(true)
    expect(v.groups.has('project')).toBe(true)
  })

  test('a small help string: two-space description column, | alternatives and a placeholder-only line', () => {
    const v = helpVerbs('shepherdr: a tool\n  shepherdr task add "<title>"    add one\n  shepherdr automation pause|resume|run "<name>"  change one\n  shepherdr <id>                  not a command\n')
    expect(v.commands.has('task add')).toBe(true)
    expect(v.commands.get('task add')).toEqual({ takesArg: true })
    expect(v.commands.has('automation pause')).toBe(true)
    expect(v.commands.has('automation resume')).toBe(true)
    expect(v.commands.has('automation run')).toBe(true)
    expect([...v.commands.keys()]).not.toContain('<id>')
  })

  test('a mention is a known command, a bare group, or a command plus its argument', () => {
    const v = helpVerbs()
    expect(isKnown(['task', 'review-more'], v)).toBe(true)
    expect(isKnown(['profile', 'save', 'day'], v)).toBe(true) // day is the name argument
    expect(isKnown(['automation'], v)).toBe(true) // a category reference
    expect(isKnown(['project'], v)).toBe(true)
    expect(isKnown(['task', 'review-mor'], v)).toBe(false)
    expect(isKnown(['cheque'], v)).toBe(false)
  })
})

describe('command mentions in prose', () => {
  test('finds inline code, line starts and line-wrapped spans, not noun uses of the word', () => {
    const text =
      'the shepherdr skill and eliasstravik/shepherdr without OK\n' +
      'Use `shepherdr task review-more SHE-89` here.\n' +
      '- `shepherdr task\n  review-more SHE-89` wraps.\n' +
      'shepherdr checks SHE-89\n' +
      'Run `shepherdr <id>`.\n'
    expect(commandMentions(text).map((m) => m.seq.join(' '))).toEqual(['task review-more', 'task review-more', 'checks'])
    expect(commandMentions(text)[0]!.line).toBe(2)
  })
})

describe('the whole step', () => {
  test('the fixture tree passes with a note; the files it reads are the markdown ones', () => {
    const root = tree()
    const notes: string[] = []
    expect(runDocs({ root, note: (n) => notes.push(n) })).toBe(0)
    expect(notes.join('\n')).toContain('relative links')
    const files = docFiles(root).map((f) => f.slice(root.length + 1))
    expect(files).toContain('README.md')
    expect(files).toContain('AGENTS.md')
    expect(files).toContain('docs/guide.md')
    expect(files).toContain('skill/shepherdr/SKILL.md')
  })

  test('a tree with no docs folders or top-level markdown still passes', () => {
    const dir = tmp('checks-docs-empty')
    expect(docFiles(dir)).toEqual([])
    expect(runDocs({ root: dir })).toBe(0)
  })

  test('a broken relative link fails, naming the file and target', () => {
    const root = tree({ link: 'missing.md' })
    const lines: string[] = []
    expect(runDocs({ root, log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('docs/broken.md: broken relative link: missing.md')
  })

  test('a renamed verb in skill/ fails, naming the file and line', () => {
    const root = tree({ verb: 'task review-mor SHE-89' })
    const lines: string[] = []
    expect(runDocs({ root, log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('skill/shepherdr/BAD.md:3: unknown shepherdr command: shepherdr task review-mor')
  })

  test('upstream pages quote foreign verbs without failing', () => {
    const root = tree({ upstream: true })
    expect(runDocs({ root })).toBe(0)
  })

  test('the runner entry point reads its environment, writes its note and fails on a broken link', () => {
    const clean = tree()
    const planted = tree({ link: 'missing.md' })
    const note = join(clean, 'note.txt')
    expect(main({ SHEPHERDR_CHECK_ROOT: clean, SHEPHERDR_CHECK_NOTE: note })).toBe(0)
    expect(readFileSync(note, 'utf8')).toContain('relative links')
    expect(main({ SHEPHERDR_CHECK_ROOT: planted })).toBe(1)
  })
})
