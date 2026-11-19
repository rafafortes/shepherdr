// check:local --quick is a task's pre-ready run: incremental types + the tests that reach what changed + the build. It
// never runs the coverage ratchet, records no baseline or screen map, and its verdict is marked QUICK on its first line
// in a file of its own, so a full verdict asked for elsewhere (QG-10) cannot mistake it for one. The full gate still
// runs (the merge gate, the weekly sweep and a release), and a change to a file that can break any test runs the whole
// suite even in a quick run. These tests hold that composition, and the rule the repo's own pages tell a task.
import { describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmp } from './tmp.ts'

const root = join(import.meta.dir, '..')
const runner = join(root, 'scripts', 'check-local.sh')
const notComments = (p: string) => readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n')

describe('what --quick composes', () => {
  test('the runner keeps the lock, cap and timeout, filters coverage and writes a verdict of its own', () => {
    const lines = notComments(runner)
    expect(lines).toContain('for arg in "$@"; do [ "$arg" = --quick ] && quick=1; done')
    expect(lines).toContain('[ "$quick" = 1 ] && V="$logs/verdict-quick.txt"')
    expect(lines).toContain('[ "${file#*-}" = coverage ] || kept+=("$file")')
    expect(lines).toContain('export SHEPHERDR_CHECK_QUICK="$quick"')
    expect(lines).toContain('[ "$quick" = 1 ] && { map_flag=\'\'; record_flag=\'\'; }')
    // the first line says what kind of run it was and what it did not run
    expect(lines).toContain('check:local QUICK')
    expect(lines).toContain('NOT run: the full suite, coverage, screen map and baseline')
    // what it must not change: the lock, the worker cap, the timeout or the exit-code contract
    expect(lines).toContain('exec 9>>"$lock"')
    expect(lines).toContain('export SHEPHERDR_TEST_JOBS="$jobs"')
    expect(lines).toContain('timeout --foreground -k 60 "$step_timeout"')
    expect(lines).toContain('exit 1')
  })

  test('the tests check picks the changed tests in a quick run and the forceful suite otherwise', () => {
    const tests = readFileSync(join(root, 'scripts', 'checks', '30-tests'), 'utf8')
    expect(tests).toContain('SHEPHERDR_CHECK_QUICK')
    expect(tests).toContain('bun "$root/scripts/test.ts" changed --force')
    expect(tests).toContain('--force --cover="$cover"')
    const coverage = readFileSync(join(root, 'scripts', 'checks', '40-coverage'), 'utf8')
    expect(coverage).toContain('--record')
  })

  test('the types are incremental per worktree, under node_modules/.cache', () => {
    const ts = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')) as { compilerOptions: Record<string, string | boolean> }
    expect(ts.compilerOptions.incremental).toBe(true)
    expect(ts.compilerOptions.tsBuildInfoFile).toBe('node_modules/.cache/tsconfig.tsbuildinfo')
  })
})

/** a fixture repo with the real runner and fake checks that record that they ran, like test/checks-runner.test.ts */
function fixture(checks: Record<string, string>, branch = 'herdr-tui') {
  const dir = tmp('checks-quick')
  const home = join(dir, 'home')
  mkdirSync(join(dir, 'scripts', 'checks'), { recursive: true })
  mkdirSync(home, { recursive: true })
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
  }
  git('init', '-q', '-b', branch)
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  git('add', '-A')
  git('-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-qm', 'init')
  copyFileSync(runner, join(dir, 'scripts', 'check-local.sh'))
  writeFileSync(join(dir, 'scripts', 'check-browsers.ts'), "console.log('chromium: ok (fixture)')\nconsole.log('webkit: ok (fixture)')\n")
  for (const [name, body] of Object.entries(checks)) {
    const f = join(dir, 'scripts', 'checks', name)
    writeFileSync(f, `#!/usr/bin/env bash\nset -uo pipefail\necho "$SHEPHERDR_CHECK_NAME $SHEPHERDR_CHECK_QUICK" >> "$SHEPHERDR_CHECK_ROOT/calls.txt"\necho "$SHEPHERDR_CHECK_NAME map=\${SHEPHERDR_CHECK_MAP:-} record=\${SHEPHERDR_CHECK_RECORD:-}" >> "$SHEPHERDR_CHECK_ROOT/flags.txt"\n${body}\nexit 0\n`)
    chmodSync(f, 0o755)
  }
  const logs = join(home, '.cache', 'shepherdr', 'check-local', basename(dir))
  return {
    dir,
    logs,
    run: (quick: boolean) => {
      const r = Bun.spawnSync(['bash', join(dir, 'scripts', 'check-local.sh'), ...(quick ? ['--quick'] : [])], {
        cwd: dir,
        env: { ...process.env, HOME: home, SHEPHERDR_CHECK_WAIT: '5', SHEPHERDR_CHECK_STEP_TIMEOUT: '30' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(r.exitCode, r.stderr.toString()).toBe(0)
      return r.stdout.toString()
    },
    calls: () => (existsSync(join(dir, 'calls.txt')) ? readFileSync(join(dir, 'calls.txt'), 'utf8').trim().split('\n') : []),
    flags: () => (existsSync(join(dir, 'flags.txt')) ? readFileSync(join(dir, 'flags.txt'), 'utf8').trim().split('\n') : []),
    verdict: (file: string) => readFileSync(join(logs, file), 'utf8'),
  }
}

describe('what --quick runs', () => {
  const checks = { '20-types': '', '40-coverage': '', '50-build': '' }

  test('skips coverage, tells the checks it is quick, and marks its own verdict on the first line', () => {
    const f = fixture(checks)
    const out = f.run(true)
    expect(f.calls()).toEqual(['types 1', 'build 1'])
    expect(out).toMatch(/^check:local QUICK · /)
    const lines = f.verdict('verdict-quick.txt').trim().split('\n')
    expect(lines[0]).toContain('QUICK')
    expect(lines[0]).toContain('NOT run: the full suite, coverage, screen map and baseline')
    expect(existsSync(join(f.logs, 'verdict.txt'))).toBe(false)
  })

  test('without the flag the full gate still runs coverage and writes the ordinary verdict', () => {
    const f = fixture(checks)
    const out = f.run(false)
    expect(f.calls()).toEqual(['types 0', 'coverage 0', 'build 0'])
    expect(out).toMatch(/^check:local · /)
    expect(f.verdict('verdict.txt')).toContain('PASSED in')
    expect(f.verdict('verdict.txt')).not.toContain('not a full gate verdict')
  })

  test('on the default branch a quick run clears the map and record flags the full run sets', () => {
    const full = fixture(checks, 'main')
    full.run(false)
    expect(full.flags()[0]).toContain('map=1 record=1')
    const quick = fixture(checks, 'main')
    quick.run(true)
    for (const line of quick.flags()) expect(line).toContain('map= record=')
  })

  test('every quick verdict line says it is not a full gate verdict, in a file of its own', () => {
    const f = fixture(checks)
    f.run(true)
    const v = f.verdict('verdict-quick.txt')
    expect(v.split('\n').filter((l) => l.startsWith('PASSED') || l.startsWith('FAILED')).length).toBeGreaterThan(0)
    for (const l of v.split('\n').filter((l) => l.startsWith('PASSED') || l.startsWith('FAILED'))) expect(l).toContain('not a full gate verdict')
  })
})

/** a page's text with its line breaks taken out, so a rule reads the same however it is wrapped */
const flat = (path: string) => readFileSync(join(root, path), 'utf8').replace(/\s+/g, ' ')

describe('the pre-ready run the repo asks for', () => {
  test('AGENTS.md asks for the quick run before ready, forbids a single worker, and keeps the full check elsewhere', () => {
    const agents = flat('AGENTS.md')
    expect(agents).toContain('A task runs `bun run check:local --quick` before `shepherdr ready`')
    expect(agents).toContain('`SHEPHERDR_TEST_JOBS=1` serializes the suite and is for debugging')
    expect(agents).toContain('The full `bun run check:local` is where nothing may be missed')
    expect(agents).toContain('the weekly sweep, and the coordinator')
  })

  test('the agent skill and docs/develop.md say the same, so no harness reads another rule', () => {
    const skill = flat(join('skill', 'shepherdr-agent', 'SKILL.md'))
    expect(skill).toContain("a task runs the repository's own quick pre-ready check")
    expect(skill).toContain('`bun run check:local --quick` in Shepherdr')
    expect(skill).toContain('`SHEPHERDR_TEST_JOBS=1`')
    const develop = flat(join('docs', 'develop.md'))
    expect(develop).toContain("`bun run check:local --quick` is a task's pre-ready run")
    expect(develop).toContain('the merge gate, the weekly sweep, and the coordinator')
  })

  test('a change to a file that can break any test runs the whole suite, in a quick run too', () => {
    const source = readFileSync(join(root, 'scripts', 'test.ts'), 'utf8')
    expect(source).toContain('if (touched.some((f) => EVERYTHING.includes(f))) files = null')
    const list = /const EVERYTHING = \[([^\]]*)\]/.exec(source)?.[1] ?? ''
    for (const f of ['package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'test/preload.ts', 'test/once.ts', 'scripts/test.ts']) {
      expect(list).toContain(`'${f}'`)
    }
    // the pages name the same list, so a task knows what makes its quick run the whole suite
    for (const page of ['AGENTS.md', join('docs', 'develop.md')]) expect(flat(page)).toContain('`test/preload.ts`, `test/once.ts`, `scripts/test.ts`')
  })
})
