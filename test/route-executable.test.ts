// helper/route.pl decides which processes are agent CLIs by their executable (agent_executable): a native binary by its
// name, an npm entry point by its package. It is loaded here without running its main part (it runs only as a script).
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const ROUTE = join(import.meta.dir, '..', 'helper', 'route.pl')

/** whether route.pl's agent_executable takes this executable and entry point */
function agentExecutable(exe: string, entry = ''): boolean {
  const script = 'my ($file, $exe, $entry) = @ARGV; require $file; print agent_executable($exe, $entry) ? "yes" : "no"'
  const p = Bun.spawnSync(['perl', '-e', script, ROUTE, exe, entry], { stdout: 'pipe', stderr: 'pipe' })
  expect(p.stderr.toString()).toBe('')
  return p.stdout.toString() === 'yes'
}

describe('route.pl: which executables are agent CLIs', () => {
  test('the native binaries of the CLIs, by their name, wherever they are installed', () => {
    expect(agentExecutable('/usr/bin/codex')).toBe(true)
    expect(agentExecutable('/home/u/.local/bin/claude')).toBe(true)
    expect(agentExecutable('pi')).toBe(true)
    expect(agentExecutable('/home/u/.opencode/bin/opencode')).toBe(true)
    expect(agentExecutable('opencode')).toBe(true)
    expect(agentExecutable('/home/u/.local/bin/agy')).toBe(true)
    expect(agentExecutable('agy')).toBe(true)
  })

  test('other programs are not, and an OpenCode-named path inside another name is not', () => {
    expect(agentExecutable('/usr/bin/bash')).toBe(false)
    expect(agentExecutable('/usr/bin/opencode-helper')).toBe(false)
    expect(agentExecutable('/home/u/opencode/bin/tool')).toBe(false)
    expect(agentExecutable('/home/u/agy/bin/tool')).toBe(false)
    expect(agentExecutable('/usr/bin/agy-helper')).toBe(false)
  })

  test('npm entry points still count by their package or file name', () => {
    expect(agentExecutable('/usr/bin/node', '/opt/node_modules/@mariozechner/pi-coding-agent/dist/cli.js')).toBe(true)
    expect(agentExecutable('/usr/bin/node', '/usr/lib/node_modules/@openai/codex/bin/codex.js')).toBe(true)
    expect(agentExecutable('/usr/bin/node', '/some/app.js')).toBe(false)
  })
})
