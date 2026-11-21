// Preload isolation (SHE-182): every test file runs in its own worker with a home of its own. Prove that the agent CLI
// data paths preload sets are per-file temp dirs, never the host's real OpenCode/agy files, so no test can overwrite the
// operator's database the way a review-pane test fixture once did.
import { describe, expect, test } from 'bun:test'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { agyHome } from '../server/live/agy.ts'
import { opencodeConfigDir, opencodeDataDir, opencodeDb } from '../server/live/opencode.ts'

const env = (key: string): string => {
  const value = process.env[key]
  if (value === undefined) throw new Error(`${key} is not set by preload`)
  return value
}

describe('preload keeps agent CLI data in per-file temp dirs', () => {
  test('OpenCode DB, its XDG folders and the agy store are set under this test shep folder, never the host data', () => {
    const paths = {
      db: env('SHEPHERDR_OPENCODE_DB'),
      data: env('XDG_DATA_HOME'),
      config: env('XDG_CONFIG_HOME'),
      agy: env('SHEPHERDR_AGY_HOME'),
    }
    const prefix = join(tmpdir(), 'shep-')
    for (const [key, value] of Object.entries(paths)) expect(value.startsWith(prefix), `${key}=${value}`).toBe(true)
    expect(opencodeDb()).toBe(paths.db)
    expect(opencodeDataDir()).toBe(join(paths.data, 'opencode'))
    expect(opencodeConfigDir()).toBe(join(paths.config, 'opencode'))
    expect(agyHome()).toBe(paths.agy)
    expect(opencodeDb()).not.toBe(join(homedir(), '.local', 'share', 'opencode', 'opencode.db'))
    expect(opencodeDataDir()).not.toBe(join(homedir(), '.local', 'share', 'opencode'))
    expect(opencodeConfigDir()).not.toBe(join(homedir(), '.config', 'opencode'))
    expect(agyHome()).not.toBe(join(homedir(), '.gemini', 'antigravity-cli'))
  })
})
