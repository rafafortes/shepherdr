// The version step (audit 2026-11-18, QG-09): bumping only package.json fails, herdr-plugin.toml and plugins.json are
// read independently, and a clean tree passes with a note. These drive the real module over fixture trees under /tmp.
import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { jsonVersion, main, runVersion, tomlVersion } from '../scripts/checks/version.ts'
import { tmp } from './tmp.ts'

/** a fixture tree with a version in both required files, and optionally in plugins.json */
function tree(pkg = '2.0.72', toml = '2.0.72', plugins?: string | null) {
  const dir = tmp('checks-version')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: pkg }))
  writeFileSync(join(dir, 'herdr-plugin.toml'), `# header\nid = "x"\nversion = "${toml}"\nmin_herdr_version = "0.9.0"\n`)
  if (plugins !== undefined && plugins !== null) writeFileSync(join(dir, 'plugins.json'), plugins)
  return dir
}

describe('version fields', () => {
  test('TOML reads the top-level version, not min_herdr_version or a comment', () => {
    expect(tomlVersion('# version = "9.9.9"\nid = "x"\nmin_herdr_version = "0.9.0"\nversion = "2.0.72"\n')).toBe('2.0.72')
    expect(tomlVersion('id = "x"\nmin_herdr_version = "0.9.0"\n')).toBeNull()
  })

  test('JSON reads a string version and ignores absent, non-string and malformed ones', () => {
    expect(jsonVersion('{"version":"2.0.72"}')).toBe('2.0.72')
    expect(jsonVersion('{"name":"x"}')).toBeNull()
    expect(jsonVersion('{"version":3}')).toBeNull()
    expect(jsonVersion('not json')).toBeNull()
  })
})

describe('the whole step', () => {
  test('matching versions pass with a note', () => {
    const notes: string[] = []
    expect(runVersion({ root: tree(), note: (n) => notes.push(n) })).toBe(0)
    expect(notes.join('\n')).toContain('version 2.0.72 agreed by 2 files')
  })

  test('bumping only package.json fails, naming both files and versions', () => {
    const lines: string[] = []
    expect(runVersion({ root: tree('2.0.73', '2.0.72'), log: (l) => lines.push(l) })).toBe(1)
    const out = lines.join('\n')
    expect(out).toContain('package.json: 2.0.73')
    expect(out).toContain('herdr-plugin.toml: 2.0.72')
    expect(out).toContain('version mismatch')
  })

  test('a missing version field fails, naming the file', () => {
    const lines: string[] = []
    expect(runVersion({ root: tree('2.0.72', ''), log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('herdr-plugin.toml: no version field')
  })

  test('plugins.json is checked only when it carries a version', () => {
    expect(runVersion({ root: tree('2.0.72', '2.0.72', '{"plugins":[]}') })).toBe(0)
    const notes: string[] = []
    expect(runVersion({ root: tree('2.0.72', '2.0.72', '{"version":"2.0.72"}'), note: (n) => notes.push(n) })).toBe(0)
    expect(notes.join('\n')).toContain('agreed by 3 files')
    const lines: string[] = []
    expect(runVersion({ root: tree('2.0.72', '2.0.72', '{"version":"2.0.71"}'), log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('plugins.json: 2.0.71')
  })

  test('the runner entry point reads its environment, writes its note and fails on a mismatch', () => {
    const clean = tree()
    const mismatch = tree('2.0.73', '2.0.72')
    const note = join(clean, 'note.txt')
    expect(main({ SHEPHERDR_CHECK_ROOT: clean, SHEPHERDR_CHECK_NOTE: note })).toBe(0)
    expect(readFileSync(note, 'utf8')).toContain('version 2.0.72')
    expect(main({ SHEPHERDR_CHECK_ROOT: mismatch })).toBe(1)
  })
})
