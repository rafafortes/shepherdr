// The runner (scripts/check-local.sh) keeps the lock, the logs, the verdict and the browser probe, and discovers the
// checks it runs by sorted file name under scripts/checks/. These tests run the real runner against a fixture repo of
// its own with fake checks: adding a check must need no edit to a shared list, and one failure must stop the run.
// The pattern is test/check-workflow.test.ts's: a git repo made in /tmp, driven by the file's own commands.
import { describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmp } from './tmp.ts'

const root = join(import.meta.dir, '..')
const runner = join(root, 'scripts', 'check-local.sh')

/** a fake check: it records that it ran, then does whatever the test gives it and exits with its status */
const check = (extra = '', exit = 0) => `#!/usr/bin/env bash
set -uo pipefail
echo "$SHEPHERDR_CHECK_NAME" >> "$SHEPHERDR_CHECK_ROOT/calls.txt"
${extra}
exit ${exit}
`

/** a fixture repo holding a copy of the real runner, the given checks, a stand-in browser probe and a HOME of its own */
function fixture(checks: Record<string, string>, branch = 'herdr-tui') {
  const dir = tmp('checks-runner')
  const home = join(dir, 'home')
  mkdirSync(join(dir, 'scripts', 'checks'), { recursive: true })
  mkdirSync(home, { recursive: true })
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    return r.stdout.toString().trim()
  }
  git('init', '-q', '-b', branch)
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  git('add', '-A')
  git('-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-qm', 'init')
  copyFileSync(runner, join(dir, 'scripts', 'check-local.sh'))
  writeFileSync(join(dir, 'scripts', 'check-browsers.ts'), "console.log('chromium: ok (fixture)')\nconsole.log('webkit: ok (fixture)')\n")
  for (const [name, body] of Object.entries(checks)) {
    const file = join(dir, 'scripts', 'checks', name)
    writeFileSync(file, body)
    chmodSync(file, 0o755)
  }
  const logs = join(home, '.cache', 'shepherdr', 'check-local', basename(dir))
  return {
    dir,
    logs,
    run: () => {
      const r = Bun.spawnSync(['bash', join(dir, 'scripts', 'check-local.sh')], {
        cwd: dir,
        env: { ...process.env, HOME: home, SHEPHERDR_CHECK_WAIT: '5', SHEPHERDR_CHECK_STEP_TIMEOUT: '30' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode }
    },
    calls: () => (existsSync(join(dir, 'calls.txt')) ? readFileSync(join(dir, 'calls.txt'), 'utf8').trim().split('\n').filter(Boolean) : []),
    verdict: () => readFileSync(join(logs, 'verdict.txt'), 'utf8'),
  }
}

describe('the discovered checks', () => {
  test('run in sorted file-name order, whatever order the files were made, with the shared context in the environment', () => {
    const f = fixture({ '30-three': check(), '10-one': check(), '20-two': check() })
    const r = f.run()
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(f.calls()).toEqual(['one', 'two', 'three'])
    expect(r.out).toMatch(/1\/3 one ok \([^)]*\)/)
    expect(r.out).toMatch(/2\/3 two ok \([^)]*\)/)
    expect(r.out).toMatch(/3\/3 three ok \([^)]*\)/)
    // the runner passes its context by environment, and gives each check a log of its own
    for (const name of ['one', 'two', 'three']) expect(existsSync(join(f.logs, `${name}.log`))).toBe(true)
  })

  test('stop at the first failure: no later check, and no older run\'s notes', () => {
    const f = fixture({ '10-one': check(), '20-two': check('', 1), '30-three': check() })
    // a run that stopped before the tests must not report skips from an earlier run's tests.log
    mkdirSync(f.logs, { recursive: true })
    writeFileSync(join(f.logs, 'tests.log'), '(skip) old skipped test\n')
    const r = f.run()
    expect(f.calls()).toEqual(['one', 'two'])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/2\/3 two FAILED \([^)]*\)/)
    expect(r.out).toMatch(/FAILED in [^:]*: two/)
    expect(r.out).not.toContain('old skipped test')
    expect(f.verdict()).toContain('FAILED in')
  })

  test('a failed first check exits before the browser probe, as when dependencies cannot install', () => {
    const f = fixture({ '10-one': check('', 1), '20-two': check() })
    expect(f.run().code).toBe(1)
    expect(f.calls()).toEqual(['one'])
    expect(existsSync(join(f.logs, 'browsers.log')), 'no probe without dependencies').toBe(false)
  })

  test("a check's note goes on its own line, and a skip reason says skipped instead of ok", () => {
    const note = `printf 'Ran 7 tests across 2 files\\n' > "$SHEPHERDR_CHECK_NOTE"`
    const skip = `printf 'the tool is missing\\n' > "$SHEPHERDR_CHECK_SKIP"`
    const f = fixture({ '10-one': check(note), '20-two': check(skip), '30-three': check() })
    const r = f.run()
    expect(r.code).toBe(0)
    expect(f.calls()).toEqual(['one', 'two', 'three'])
    expect(r.out).toMatch(/1\/3 one ok \([^)]*\) Ran 7 tests across 2 files/)
    expect(r.out).toContain('2/3 two skipped: the tool is missing')
    // the verdict says which part did not run, as it does for a browser that could not start
    expect(r.out).toContain('PASSED in ')
    expect(r.out).toContain('with parts of it not run:')
    expect(r.out).toContain('  ! two: the tool is missing')
  })

  test('only the default branch gets the record and map flags a baseline needs', () => {
    const envBody = `printf 'record=%s map=%s\\n' "$SHEPHERDR_CHECK_RECORD" "$SHEPHERDR_CHECK_MAP" >> "$SHEPHERDR_CHECK_ROOT/flags.txt"`
    for (const [branch, want] of [
      ['herdr-tui', 'record= map='],
      ['main', 'record=1 map=1'],
    ]) {
      const f = fixture({ '10-one': check(envBody) }, branch)
      expect(f.run().code).toBe(0)
      expect(readFileSync(join(f.dir, 'flags.txt'), 'utf8').trim()).toBe(want)
    }
  })
})

describe('the check files themselves', () => {
  test('one executable per step, each running its own command', () => {
    const dir = join(root, 'scripts', 'checks')
    // a .ts module beside the checks is not a check; a check without its executable bit would still be discovered
    expect(statSync(join(dir, 'secrets.ts')).mode & 0o111, 'secrets.ts is a module, not a check').toBe(0)
    expect(statSync(join(dir, 'scripts.ts')).mode & 0o111, 'scripts.ts is a module, not a check').toBe(0)
    const names = readdirSync(dir).filter((n) => !n.endsWith('.ts')).sort()
    expect(names).toEqual(['10-dependencies', '15-secrets', '17-scripts', '18-docs', '19-version', '20-types', '21-language', '30-tests', '40-coverage', '50-build'])
    const text = Object.fromEntries(names.map((n) => [n, readFileSync(join(dir, n), 'utf8')])) as Record<string, string>
    expect(text['10-dependencies']).toContain('bun install --frozen-lockfile')
    expect(text['15-secrets']).toContain('scripts/checks/secrets.ts')
    expect(text['17-scripts']).toContain('scripts/checks/scripts.ts')
    expect(text['18-docs']).toContain('scripts/checks/docs.ts')
    expect(text['19-version']).toContain('scripts/checks/version.ts')
    expect(text['20-types']).toContain('bun run typecheck')
    expect(text['21-language']).toContain('scripts/checks/language.ts')
    expect(text['30-tests']).toContain('scripts/test.ts')
    expect(text['30-tests']).toContain('--force')
    expect(text['30-tests']).toContain('SHEPHERDR_CHECK_MAP')
    expect(text['40-coverage']).toContain('scripts/coverage.ts')
    expect(text['40-coverage']).toContain('SHEPHERDR_CHECK_RECORD')
    expect(text['50-build']).toContain('bun run build')
    for (const name of names) expect(statSync(join(dir, name)).mode & 0o111, name).toBeTruthy()
  })

  test('a check run on its own finds the repo root, two folders up from scripts/checks/', () => {
    const dir = tmp('checks-standalone')
    const bin = join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    const stub = join(bin, 'bun')
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
    chmodSync(stub, 0o755)
    for (const [name, script] of [['30-tests', 'scripts/test.ts'], ['40-coverage', 'scripts/coverage.ts']]) {
      const r = Bun.spawnSync(['bash', join(root, 'scripts', 'checks', name)], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(r.exitCode, r.stderr.toString()).toBe(0)
      expect(r.stdout.toString()).toContain(join(root, script))
      expect(r.stdout.toString()).not.toContain(join(root, 'scripts', script))
    }
  })
})
