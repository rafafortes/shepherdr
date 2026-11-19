// check:local --quick is a task's pre-ready run: incremental types + the tests that reach what changed + the build. It
// never runs the coverage ratchet, records no baseline or screen map, and its verdict is marked QUICK on its first line
// in a file of its own, so a full verdict asked for elsewhere (QG-10) cannot mistake it for one. The full gate still
// runs (the merge gate, the weekly sweep and a release), and a change to a file that can break any test runs the whole
// suite even in a quick run. These tests hold that composition, and the rule the repo's own pages tell a task.
import { describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmp } from './tmp.ts'

const root = join(import.meta.dir, '..')
const runner = join(root, 'scripts', 'check-local.sh')
const notComments = (p: string) =>
  readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .join('\n')

describe('what --quick composes', () => {
  test('the runner keeps the lock, cap and timeout, filters coverage and writes a verdict of its own', () => {
    const lines = notComments(runner)
    expect(lines).toContain('for arg in "$@"; do [ "$arg" = --quick ] && quick=1; done')
    expect(lines).toContain('V="$logs/verdict-quick.txt"')
    expect(lines).toContain('[ "${file#*-}" = coverage ] || kept+=("$file")')
    expect(lines).toContain('export SHEPHERDR_CHECK_QUICK="$quick"')
    expect(lines).toContain("[ \"$quick\" = 1 ] && { map_flag=''; record_flag=''; }")
    // the first line says what kind of run it was and what it did not run
    expect(lines).toContain('check:local QUICK')
    expect(lines).toContain('NOT run: coverage, screen map and baseline')
    expect(lines).toContain('the full suite only if a shared file changed')
    // a quick run never waits behind a full one: it takes a lock of its own, and while a full run holds the shared one
    // it caps its workers to max(2, cores / 8) unless the caller set SHEPHERDR_TEST_JOBS itself (SHE-172)
    expect(lines).toContain('full_lock="$HOME/.cache/shepherdr/check-local.lock"')
    expect(lines).toContain('quick_lock="$HOME/.cache/shepherdr/check-local-quick.lock"')
    expect(lines).toContain('[ "$quick" = 1 ] && lock=$quick_lock')
    expect(lines).toContain('share=$((cores / 8))')
    expect(lines).toContain('[ "$share" -ge 2 ] || share=2')
    expect(lines).toContain('[ -z "$caller_jobs" ] || return 0')
    // it can run beside a full run of the same worktree, so its step logs and verdict never share their names
    expect(lines).toContain("log_suffix='-quick'")
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
function fixture(checks: Record<string, string>, branch = 'herdr-tui', opts: { cores?: number; env?: Record<string, string> } = {}) {
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
  // a fake nproc, so the worker cap is the same on every machine this check runs on
  let path = process.env.PATH ?? ''
  if (opts.cores) {
    const bin = join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'nproc'), `#!/bin/sh\necho ${opts.cores}\n`)
    chmodSync(join(bin, 'nproc'), 0o755)
    path = `${bin}:${path}`
  }
  for (const [name, body] of Object.entries(checks)) {
    const f = join(dir, 'scripts', 'checks', name)
    writeFileSync(
      f,
      `#!/usr/bin/env bash\nset -uo pipefail\necho "$SHEPHERDR_CHECK_NAME $SHEPHERDR_CHECK_QUICK" >> "$SHEPHERDR_CHECK_ROOT/calls.txt"\necho "$SHEPHERDR_CHECK_NAME map=\${SHEPHERDR_CHECK_MAP:-} record=\${SHEPHERDR_CHECK_RECORD:-}" >> "$SHEPHERDR_CHECK_ROOT/flags.txt"\n${body}\nexit 0\n`,
    )
    chmodSync(f, 0o755)
  }
  const logs = join(home, '.cache', 'shepherdr', 'check-local', basename(dir))
  const spawn = (quick: boolean) =>
    Bun.spawnSync(['bash', join(dir, 'scripts', 'check-local.sh'), ...(quick ? ['--quick'] : [])], {
      cwd: dir,
      // a check of the real suite passes its own SHEPHERDR_TEST_JOBS down: this fixture never inherits one
      env: { ...process.env, HOME: home, PATH: path, SHEPHERDR_TEST_JOBS: '', SHEPHERDR_CHECK_WAIT: '5', SHEPHERDR_CHECK_STEP_TIMEOUT: '30', ...opts.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  return {
    dir,
    home,
    logs,
    run: (quick: boolean) => {
      const r = spawn(quick)
      expect(r.exitCode, r.stderr.toString()).toBe(0)
      return r.stdout.toString()
    },
    runRaw: spawn,
    calls: () => (existsSync(join(dir, 'calls.txt')) ? readFileSync(join(dir, 'calls.txt'), 'utf8').trim().split('\n') : []),
    flags: () => (existsSync(join(dir, 'flags.txt')) ? readFileSync(join(dir, 'flags.txt'), 'utf8').trim().split('\n') : []),
    verdict: (file: string) => readFileSync(join(logs, file), 'utf8'),
    /** hold the shared lock from another process, as a full run does, until stopped */
    holdFullLock: async (ms = 4000) => {
      const lock = join(home, '.cache', 'shepherdr', 'check-local.lock')
      mkdirSync(dirname(lock), { recursive: true })
      const held = join(dir, 'held')
      const proc = Bun.spawn(['bash', '-c', `exec 9>>"${lock}"; flock 9; touch "${held}"; exec sleep ${ms / 1000}`], { stdout: 'ignore', stderr: 'ignore' })
      for (let i = 0; i < 200 && !existsSync(held); i++) await Bun.sleep(25)
      expect(existsSync(held), 'the full lock is held').toBe(true)
      return { held, stop: () => proc.kill() }
    },
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
    expect(lines[0]).toContain('NOT run: coverage, screen map and baseline')
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
const flat = (path: string) => readFileSync(path, 'utf8').replace(/\s+/g, ' ')

/** the pages a task agent reads its pre-ready rule in; the literal join() paths are how `bun run test changed` picks
 *  this file when one of them changes (scripts/test.ts's reach) */
const pages = () => ({
  agents: flat(join(root, 'AGENTS.md')),
  develop: flat(join(root, 'docs', 'develop.md')),
  tasks: flat(join(root, 'docs', 'tasks.md')),
  skill: flat(join(root, 'skill', 'shepherdr-agent', 'SKILL.md')),
})

/** tell a task to run the whole check before it is ready: the shapes the rule had before --quick, whoever wrote them */
const FULL_BEFORE_READY = /`bun run check:local`(?! --quick)[^.]*before `shepherdr ready`|full check \(`bun run check:local`[^)]*\)[^.]*`shepherdr ready`/

describe('the pre-ready run the repo asks for', () => {
  test('AGENTS.md asks for the quick run before ready, forbids a single worker, and keeps the full check elsewhere', () => {
    const { agents, develop, skill } = pages()
    expect(agents).toContain('A task runs `bun run check:local --quick` before `shepherdr ready`')
    expect(agents).toContain('`SHEPHERDR_TEST_JOBS=1` serializes the suite and is for debugging')
    expect(agents).toContain('The full `bun run check:local` is where nothing may be missed')
    expect(agents).toContain('the weekly sweep, and the coordinator')
    expect(agents).toContain('`bash scripts/check-local.sh --reuse`')
    // no page asks for the whole check before ready again (a revert of the rule fails here)
    for (const page of [agents, develop, skill]) expect(page).not.toMatch(FULL_BEFORE_READY)
  })

  test('the agent skill and docs/develop.md say the same, so no harness reads another rule', () => {
    const { develop, tasks, skill } = pages()
    expect(skill).toContain("runs the check its repo's rules name for that point")
    expect(skill).toContain('`bun run check:local --quick` in')
    expect(skill).toContain("where they name none, the repo's own full check")
    expect(skill).toContain('keeps `shepherdr ready` unrun and the change unmerged')
    expect(skill).toContain('`SHEPHERDR_TEST_JOBS=1`')
    expect(develop).toContain("`bun run check:local --quick` is a task's pre-ready run")
    expect(develop).toContain('the merge gate, the weekly sweep, and the coordinator')
    // the product page says where the full check now happens, and how a space asks for it on every merge
    expect(tasks).toContain('the quick pre-ready check, `bun run check:local --quick`')
    expect(tasks).toContain('merge sets the gate to the check itself, below')
    // the gate answers at once only for a tree a full run passed, and a task's quick run never becomes one
    expect(flat(join(root, 'docs', 'tasks.md'))).toContain("is never kept as a tree's verdict")
    expect(pages().agents).toContain('`bash scripts/check-local.sh --reuse`')
  })

  test('a change to a file that can break any test runs the whole suite, in a quick run too', () => {
    const source = readFileSync(join(root, 'scripts', 'test.ts'), 'utf8')
    expect(source).toContain('if (touched.some((f) => EVERYTHING.includes(f))) files = null')
    const list = /const EVERYTHING = \[([^\]]*)\]/.exec(source)?.[1] ?? ''
    for (const f of ['package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'test/preload.ts', 'test/once.ts', 'scripts/test.ts']) {
      expect(list).toContain(`'${f}'`)
    }
    // the pages name the same list, so a task knows what makes its quick run the whole suite
    for (const page of [pages().agents, pages().develop]) expect(page).toContain('`test/preload.ts`, `test/once.ts`, `scripts/test.ts`')
  })

  test('a quick run nothing reached says so, instead of leaving the result line blank', () => {
    const step = readFileSync(join(root, 'scripts', 'checks', '30-tests'), 'utf8')
    expect(step).toContain("note='no test reaches what changed'")
  })
})

// SHE-172: a quick run is the pre-ready one, so it can never sit behind a full run that has 3 to 20 minutes of tests
// left. It takes a lock of its own and runs at once, capping its own changed tests while a full run holds the machine.
describe('a quick run beside a full one', () => {
  const record = 'echo "$SHEPHERDR_CHECK_NAME jobs=$SHEPHERDR_TEST_JOBS held=$([ -f "$SHEPHERDR_CHECK_ROOT/held" ] && echo yes || echo no)" >> "$SHEPHERDR_CHECK_ROOT/jobs.txt"'
  const checks = { '30-tests': record }
  const jobs = (f: ReturnType<typeof fixture>) => readFileSync(join(f.dir, 'jobs.txt'), 'utf8').trim()

  test('runs at once while a full run holds the shared lock, taking max(2, cores / 8) workers and never writing its pid', async () => {
    const f = fixture(checks, 'herdr-tui', { cores: 32 })
    const holder = await f.holdFullLock()
    try {
      const out = f.run(true)
      // 32 cores: a quarter is 8, and 4 is the conservative share a full run leaves it
      expect(jobs(f)).toBe('tests jobs=4 held=yes')
      expect(out).toContain('4 test workers (a full check holds the machine)')
      expect(f.verdict('verdict-quick.txt')).toContain('PASSED in')
      // its own lock: the full run's pid file is not its to write
      expect(existsSync(join(f.home, '.cache', 'shepherdr', 'check-local.lock.pid'))).toBe(false)
    } finally {
      holder.stop()
    }
  })

  test('with no full run beside it, it takes the ordinary quarter of the cores', () => {
    const f = fixture(checks, 'herdr-tui', { cores: 32 })
    f.run(true)
    expect(jobs(f)).toBe('tests jobs=8 held=no')
    expect(f.verdict('verdict-quick.txt')).not.toContain('holds the machine')
  })

  test('an explicit SHEPHERDR_TEST_JOBS is never capped', async () => {
    const f = fixture(checks, 'herdr-tui', { cores: 32, env: { SHEPHERDR_TEST_JOBS: '3' } })
    const holder = await f.holdFullLock()
    try {
      f.run(true)
      expect(jobs(f)).toBe('tests jobs=3 held=yes')
    } finally {
      holder.stop()
    }
  })

  test('a quick run beside a full run of the same worktree never overwrites its logs or notes', async () => {
    const f = fixture(checks, 'herdr-tui', { cores: 32 })
    // what a full run of this worktree left behind, while it was running
    mkdirSync(f.logs, { recursive: true })
    writeFileSync(join(f.logs, 'tests.log'), 'Ran 3057 tests across 234 files\n')
    writeFileSync(join(f.logs, 'tests.note'), 'Ran 3057 tests across 234 files\n')
    const holder = await f.holdFullLock()
    try {
      f.run(true)
      // its own step log, and the full run's log and note untouched
      expect(existsSync(join(f.logs, 'tests-quick.log'))).toBe(true)
      expect(readFileSync(join(f.logs, 'tests.log'), 'utf8')).toBe('Ran 3057 tests across 234 files\n')
      expect(readFileSync(join(f.logs, 'tests.note'), 'utf8')).toBe('Ran 3057 tests across 234 files\n')
      expect(existsSync(join(f.logs, 'verdict.txt'))).toBe(false)
    } finally {
      holder.stop()
    }
  })

  test('another quick run is the only one it waits for, and it says so before its checks', async () => {
    const f = fixture(checks)
    const lock = join(f.home, '.cache', 'shepherdr', 'check-local-quick.lock')
    mkdirSync(dirname(lock), { recursive: true })
    const held = join(f.dir, 'quick-held')
    const proc = Bun.spawn(['bash', '-c', `exec 9>>"${lock}"; flock 9; touch "${held}"; exec sleep 2`], { stdout: 'ignore', stderr: 'ignore' })
    try {
      for (let i = 0; i < 200 && !existsSync(held); i++) await Bun.sleep(25)
      expect(existsSync(held), 'the quick lock is held').toBe(true)
      const r = f.runRaw(true)
      expect(r.exitCode, r.stderr.toString()).toBe(0)
      const out = r.stdout.toString()
      expect(out).toContain('Another check is running: waiting for it')
      // the header first, then the wait: the verdict never starts with a line about somebody else
      expect(out.indexOf('check:local QUICK')).toBeLessThan(out.indexOf('Another check is running'))
      expect(out).toMatch(/1\/1 tests ok/)
    } finally {
      proc.kill()
    }
  })

  test('a quick run too long kept out of its own lock says nothing ran, and exits 2', async () => {
    const f = fixture(checks)
    const lock = join(f.home, '.cache', 'shepherdr', 'check-local-quick.lock')
    mkdirSync(dirname(lock), { recursive: true })
    const held = join(f.dir, 'quick-held')
    const proc = Bun.spawn(['bash', '-c', `exec 9>>"${lock}"; flock 9; touch "${held}"; exec sleep 30`], { stdout: 'ignore', stderr: 'ignore' })
    try {
      for (let i = 0; i < 200 && !existsSync(held); i++) await Bun.sleep(25)
      const r = Bun.spawnSync(['bash', join(f.dir, 'scripts', 'check-local.sh'), '--quick'], {
        cwd: f.dir,
        env: { ...process.env, HOME: f.home, SHEPHERDR_TEST_JOBS: '', SHEPHERDR_CHECK_WAIT: '1', SHEPHERDR_CHECK_STEP_TIMEOUT: '30' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(r.exitCode).toBe(2)
      expect(r.stdout.toString()).toContain('GAVE UP: another check still ran after 1s; nothing ran here.')
      expect(existsSync(join(f.dir, 'jobs.txt'))).toBe(false)
    } finally {
      proc.kill()
    }
  })
})
