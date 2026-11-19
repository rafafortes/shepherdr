// Check after docs (audit 2026-11-18, QG-09): AGENTS.md requires package.json and herdr-plugin.toml to carry the same
// version, but the release bump edits them by hand in two separate places — the exact moment a forgotten bump ships a
// mismatch that breaks plugin installs. This fails when they disagree, and also when plugins.json carries a version of
// its own that disagrees. It is text-only and reads no network. The runner discovers the executable shim
// scripts/checks/19-version; the logic and its fixture tests live here.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Options = { root: string; log?: (line: string) => void; note?: (line: string) => void }

/** the top-level `version = "…"` of a TOML file; `min_herdr_version` and commented lines are not it */
export function tomlVersion(text: string): string | null {
  const m = text.match(/^\s*version\s*=\s*"([^"]+)"/m)
  return m ? m[1] : null
}

/** the `version` field of a JSON file, or null when it is absent or the file is not JSON */
export function jsonVersion(text: string): string | null {
  try {
    const j = JSON.parse(text) as { version?: unknown }
    return typeof j.version === 'string' ? j.version : null
  } catch {
    return null
  }
}

/** check the versions in <root>: 0 when every file that carries one agrees, non-zero naming the disagreement */
export function runVersion(o: Options): number {
  const read = (file: string) => readFileSync(join(o.root, file), 'utf8')
  const required: [string, string | null][] = [
    ['package.json', jsonVersion(read('package.json'))],
    ['herdr-plugin.toml', tomlVersion(read('herdr-plugin.toml'))],
  ]
  const found = [...required]
  // plugins.json carries no version today; if a release adds one, it must agree with the other two
  if (existsSync(join(o.root, 'plugins.json'))) {
    const v = jsonVersion(read('plugins.json'))
    if (v !== null) found.push(['plugins.json', v])
  }
  const missing = required.filter(([, v]) => !v)
  if (missing.length) {
    for (const [file] of missing) o.log?.(`${file}: no version field`)
    return 1
  }
  const agreed = found.every(([, v]) => v === found[0][1])
  if (!agreed) {
    for (const [file, v] of found) o.log?.(`${file}: ${v}`)
    o.log?.('version mismatch: every file that carries a version must agree')
    return 1
  }
  o.note?.(`version ${found[0][1]} agreed by ${found.length} files`)
  return 0
}

/** the runner's environment, gathered in one place so a test can drive the same entry point */
export function main(env: Record<string, string | undefined> = process.env): number {
  const root = env.SHEPHERDR_CHECK_ROOT ?? join(import.meta.dir, '..', '..')
  const write = (file: string | undefined, text: string) => {
    if (file) writeFileSync(file, `${text}\n`)
  }
  return runVersion({
    root,
    log: (line) => console.log(line),
    note: (line) => write(env.SHEPHERDR_CHECK_NOTE, line),
  })
}

// coverage-exempt: the runner executes this entry point; the tests drive main() and runVersion() directly
if (import.meta.main) process.exit(main())
