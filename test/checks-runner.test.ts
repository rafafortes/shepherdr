// The runner (scripts/check-local.sh) keeps the lock, the logs, the verdict and the browser probe, and discovers the
// checks it runs by sorted file name under scripts/checks/. These tests run the real runner against a fixture repo of
// its own with fake checks: adding a check must need no edit to a shared list, and one failure must stop the run.
// The pattern is test/check-workflow.test.ts's: a git repo made in /tmp, driven by the file's own commands.
import { describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmp } from './tmp.ts'

const root = join(import.meta.dir, '..')
const runner = join(root, 'scripts', 'check-local.sh')

/** a fake check: it records that it ran (in the fixture's HOME, never in the repo, whose tree must stay clean), then
 *  does whatever the test gives it and exits with its status */
const check = (extra = '', exit = 0) => `#!/usr/bin/env bash
set -uo pipefail
echo "$SHEPHERDR_CHECK_NAME" >> "$HOME/calls.txt"
${extra}
exit ${exit}
`

/** a fixture repo holding a copy of the real runner, the given checks, a stand-in browser probe and a HOME of its own
 *  (outside the repo: a file left in the worktree would change the tree a verdict is kept by) */
function fixture(checks: Record<string, string>, branch = 'herdr-tui', commit = true) {
  const dir = tmp('checks-runner')
  const home = tmp('checks-runner-home')
  mkdirSync(join(dir, 'scripts', 'checks'), { recursive: true })
  mkdirSync(home, { recursive: true })
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    return r.stdout.toString().trim()
  }
  git('init', '-q', '-b', branch)
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  copyFileSync(runner, join(dir, 'scripts', 'check-local.sh'))
  writeFileSync(join(dir, 'scripts', 'check-browsers.ts'), "console.log('chromium: ok (fixture)')\nconsole.log('webkit: ok (fixture)')\n")
  for (const [name, body] of Object.entries(checks)) {
    const file = join(dir, 'scripts', 'checks', name)
    writeFileSync(file, body)
    chmodSync(file, 0o755)
  }
  // the scaffolding is committed with the fixture: a worktree with a file of its own is no clean tree
  if (commit) {
    git('add', '-A')
    git('-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-qm', 'init')
  }
  const logs = join(home, '.cache', 'shepherdr', 'check-local', basename(dir))
  const kept = join(home, '.cache', 'shepherdr', 'check-local', 'verdicts')
  return {
    dir,
    home,
    logs,
    kept,
    git,
    tree: () => git('rev-parse', 'HEAD^{tree}'),
    run: (...args: string[]) => {
      const r = Bun.spawnSync(['bash', join(dir, 'scripts', 'check-local.sh'), ...args], {
        cwd: dir,
        env: { ...process.env, HOME: home, SHEPHERDR_CHECK_WAIT: '5', SHEPHERDR_CHECK_STEP_TIMEOUT: '30' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode }
    },
    calls: () => (existsSync(join(home, 'calls.txt')) ? readFileSync(join(home, 'calls.txt'), 'utf8').trim().split('\n').filter(Boolean) : []),
    verdict: (file = 'verdict.txt') => readFileSync(join(logs, file), 'utf8'),
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

  test("stop at the first failure: no later check, and no older run's notes", () => {
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

  // QG-13: a Chromium that cannot start leaves the screen unrecorded, and the coverage step must be told instead of
  // reading every screen file as code no test runs any more
  test('a Chromium that cannot start tells the coverage step the screen was not measured, and one that can says nothing', () => {
    const seen = `printf 'absent=%s\\n' "\${SHEPHERDR_CHECK_SCREEN_ABSENT:-}" >> "$HOME/absent.txt"`
    const cases = [
      ["console.log('chromium: not installed: bun x playwright-core install --only-shell chromium')\nconsole.log('webkit: ok (fixture)')\n", 'absent=1'],
      ["console.log('chromium: ok (fixture)')\nconsole.log('webkit: not installed: bun x playwright-core install webkit')\n", 'absent='],
    ] as const
    for (const [probe, want] of cases) {
      const f = fixture({ '10-one': check(), '30-coverage': check(seen) })
      // the probe's stand-in, written after the fixture's own: it answers as a host with or without Chromium
      writeFileSync(join(f.dir, 'scripts', 'check-browsers.ts'), probe)
      const r = f.run()
      expect(r.code).toBe(0)
      expect(readFileSync(join(f.home, 'absent.txt'), 'utf8'), probe).toBe(`${want}\n`)
    }
  })

  test("the variable the probe sets never comes from the caller: this host's Chromium decides alone", () => {
    const seen = `printf 'absent=%s\\n' "\${SHEPHERDR_CHECK_SCREEN_ABSENT:-}" >> "$HOME/absent.txt"`
    const f = fixture({ '10-one': check(), '30-coverage': check(seen) })
    // the caller's environment says no browser can start; this host's probe says Chromium is fine
    process.env.SHEPHERDR_CHECK_SCREEN_ABSENT = '1'
    try {
      expect(f.run().code).toBe(0)
    } finally {
      delete process.env.SHEPHERDR_CHECK_SCREEN_ABSENT
    }
    expect(readFileSync(join(f.home, 'absent.txt'), 'utf8')).toBe('absent=\n')
  })

  test('a step that skips one part and runs another keeps both on its line', () => {
    // 17-scripts without shellcheck: the skip names the tool that is missing, the note says what did run
    const both = `printf 'shellcheck is not installed\n' > "$SHEPHERDR_CHECK_SKIP"; printf 'perl -c: 6 helpers syntax OK\n' > "$SHEPHERDR_CHECK_NOTE"`
    const f = fixture({ '10-one': check(both) })
    const r = f.run()
    expect(r.code).toBe(0)
    expect(r.out).toContain('1/1 one skipped: shellcheck is not installed · perl -c: 6 helpers syntax OK')
    // and the verdict still names what did not run
    expect(r.out).toContain('with parts of it not run:')
    expect(r.out).toContain('  ! one: shellcheck is not installed')
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

describe('the verdict a tree already passed (--reuse)', () => {
  const passing = { '10-one': check() }

  test('a clean full run keeps its verdict by tree, and --reuse answers from it without running anything', () => {
    const f = fixture(passing)
    expect(f.run().code).toBe(0)
    expect(f.calls()).toEqual(['one'])
    const tree = f.tree()
    const kept = readFileSync(join(f.kept, tree), 'utf8')
    expect(kept).toContain(`tree ${tree}`)
    expect(kept).toContain(`commit ${f.git('rev-parse', 'HEAD')}`)
    expect(kept).toContain('branch herdr-tui')
    expect(kept).toMatch(/^at \d+$/m)
    expect(kept).toMatch(/^took \d+$/m)
    // the same tree again: nothing runs, and its own log folder is left alone
    rmSync(join(f.home, 'calls.txt'))
    const again = f.run('--reuse')
    expect(again.code).toBe(0)
    expect(again.err).toBe('')
    expect(f.calls()).toEqual([])
    expect(again.out).toMatch(/^check:local reuse · herdr-tui at [0-9a-f]+ · this exact tree passed the full check already$/m)
    expect(again.out).toContain('Reused the verdict of')
    expect(again.out).not.toContain('/1 one')
  })

  test('a tree with no verdict, and one that moved, are checked in full', () => {
    const f = fixture(passing)
    const first = f.run('--reuse')
    expect(first.code).toBe(0)
    expect(first.out).toContain('no full check has passed on this tree yet')
    expect(f.calls()).toEqual(['one'])
    // the last line is what a merge commit carries: no path of this machine in it
    expect(first.out.trimEnd().split('\n').at(-1)).toMatch(/^PASSED in \d+s$/)
    rmSync(join(f.home, 'calls.txt'))
    // another commit is another tree: the one that passed says nothing of it
    writeFileSync(join(f.dir, 'README.md'), 'fixture, changed\n')
    f.git('add', '-A')
    f.git('-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-qm', 'change')
    expect(f.run('--reuse').code).toBe(0)
    expect(f.calls()).toEqual(['one'])
  })

  test('a dirty worktree and one with no commit are named, checked, and kept for no tree', () => {
    // uncommitted: HEAD's tree is not what the run read
    const dirty = fixture(passing)
    writeFileSync(join(dirty.dir, 'extra.txt'), 'not committed\n')
    const d = dirty.run('--reuse')
    expect(d.code).toBe(0)
    expect(d.out).toContain('the worktree has uncommitted changes')
    expect(dirty.calls()).toEqual(['one'])
    expect(existsSync(dirty.kept)).toBe(false)
    // a repository with no commit has no tree to name either
    const bare = fixture(passing, 'herdr-tui', false)
    const b = bare.run('--reuse')
    expect(b.code).toBe(0)
    expect(b.out).toContain('no commit yet')
    expect(bare.calls()).toEqual(['one'])
    expect(existsSync(bare.kept)).toBe(false)
  })

  test('a record that cannot be read is no verdict: the check runs again', () => {
    const f = fixture(passing)
    mkdirSync(f.kept, { recursive: true })
    writeFileSync(join(f.kept, f.tree()), 'tree whatever\nat nope\n')
    const r = f.run('--reuse')
    expect(r.code).toBe(0)
    expect(r.out).toContain('unreadable')
    expect(f.calls()).toEqual(['one'])
  })

  test('a part skipped keeps no verdict, and the gate refuses it instead of passing it', () => {
    const f = fixture({ '10-one': check(`printf 'the tool is missing\\n' > "$SHEPHERDR_CHECK_SKIP"`) })
    // the pre-ready run stays soft: it passed, saying what did not run
    const pre = f.run()
    expect(pre.code).toBe(0)
    expect(pre.out).toContain('with parts of it not run:')
    expect(existsSync(f.kept)).toBe(false)
    // the gate's ask: a tree nothing checked whole is no tree that passed
    const gate = f.run('--reuse')
    expect(gate.code).toBe(1)
    expect(gate.out).toContain('NOT A FULL VERDICT')
    expect(gate.out).toContain('the tool is missing')
    expect(existsSync(f.kept)).toBe(false)
  })

  test("a quick run is refused as a gate question, and a later failure takes the tree's verdict away", () => {
    // the check fails only while the fixture's HOME holds a flag: the same tree, a different host state
    const f = fixture({ '10-one': check('[ -f "$HOME/fail" ] && exit 1') })
    expect(f.run().code).toBe(0)
    const tree = f.tree()
    expect(existsSync(join(f.kept, tree))).toBe(true)
    rmSync(join(f.home, 'calls.txt'))
    const both = f.run('--quick', '--reuse')
    expect(both.code).toBe(1)
    expect(both.out).toContain('--quick and --reuse ask different things')
    expect(f.calls()).toEqual([])
    // the same tree fails on a later full run: its old verdict is not one to answer from
    writeFileSync(join(f.home, 'fail'), '')
    expect(f.run().code).toBe(1)
    expect(existsSync(join(f.kept, tree))).toBe(false)
    const after = f.run('--reuse')
    expect(after.code).toBe(1)
    expect(after.out).toContain('no full check has passed on this tree yet')
  })

  test('a run that waited behind another answers from the verdict it kept meanwhile, and pays for no shared phase', async () => {
    // the point of asking again after the lock: a gate queued behind another worktree's check does not run the tests,
    // the coverage, the build and the dist budget a second time. Its own worktree-local steps already ran by then, so
    // those keep their lines in its verdict (SHE-172 split the run in two phases)
    if (!Bun.which('flock')) return // the runner then runs without the one-at-a-time lock, and there is nothing to wait for
    const f = fixture({ '10-one': check(), '30-tests': check() })
    const lock = join(f.home, '.cache', 'shepherdr', 'check-local.lock')
    mkdirSync(join(f.home, '.cache', 'shepherdr'), { recursive: true })
    // holds the lock for a moment: room enough for a loaded machine's runner to reach it and say it waits, and short
    // enough not to slow the suite
    const holder = Bun.spawn(['flock', lock, 'sleep', '4'])
    await Bun.sleep(300)
    const runner = Bun.spawn(['bash', join(f.dir, 'scripts', 'check-local.sh'), '--reuse'], {
      cwd: f.dir,
      env: { ...process.env, HOME: f.home, SHEPHERDR_TEST_JOBS: '', SHEPHERDR_CHECK_WAIT: '20', SHEPHERDR_CHECK_STEP_TIMEOUT: '30' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const decoder = new TextDecoder()
    const reader = runner.stdout.getReader()
    let out = ''
    // it said it waits for the other check, so it is past its first look at the verdicts and past its local phase
    while (!out.includes('waiting for it, up to')) {
      const { value, done } = await reader.read()
      if (done) break
      out += decoder.decode(value)
    }
    expect(out).toContain('waiting for it, up to')
    // the check it waits behind keeps this very tree's verdict, then goes away
    mkdirSync(f.kept, { recursive: true })
    writeFileSync(join(f.kept, f.tree()), `tree ${f.tree()}\nat ${Math.floor(Date.now() / 1000)}\ntook 12\n`)
    expect(await holder.exited).toBe(0)
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      out += decoder.decode(value)
    }
    expect(await runner.exited).toBe(0)
    expect(out).toContain('this exact tree passed the full check already')
    // the worktree-local check ran; the shared one, what a second full run would pay for, did not
    expect(f.calls()).toEqual(['one'])
    // the worktree's verdict says what happened, beside the steps this run did run
    expect(f.verdict()).toContain('this exact tree passed the full check already')
    expect(f.verdict()).toContain('the shared phase did not run here')
  })

  test('a tree the branch moved away from while the check ran is never kept', () => {
    const moved = `printf 'x\\n' >> "$SHEPHERDR_CHECK_ROOT/README.md" && git -C "$SHEPHERDR_CHECK_ROOT" -c user.name=CI -c user.email=ci@localhost commit -qam moved`
    const f = fixture({ '10-one': check(moved) })
    expect(f.run().code).toBe(0)
    expect(existsSync(f.kept)).toBe(false)
  })
})

describe('the check files themselves', () => {
  test('one executable per step, each running its own command', () => {
    const dir = join(root, 'scripts', 'checks')
    // a .ts module beside the checks is not a check; a check without its executable bit would still be discovered
    expect(statSync(join(dir, 'secrets.ts')).mode & 0o111, 'secrets.ts is a module, not a check').toBe(0)
    expect(statSync(join(dir, 'scripts.ts')).mode & 0o111, 'scripts.ts is a module, not a check').toBe(0)
    expect(statSync(join(dir, 'audit.ts')).mode & 0o111, 'audit.ts is a module, not a check').toBe(0)
    expect(statSync(join(dir, 'lint.ts')).mode & 0o111, 'lint.ts is a module, not a check').toBe(0)
    expect(statSync(join(dir, 'format.ts')).mode & 0o111, 'format.ts is a module, not a check').toBe(0)
    const names = readdirSync(dir)
      .filter((n) => !n.endsWith('.ts'))
      .sort()
    expect(names).toEqual([
      '10-dependencies',
      '12-audit',
      '15-secrets',
      '17-scripts',
      '18-docs',
      '19-version',
      '20-types',
      '21-language',
      '22-lint',
      '23-format',
      '30-tests',
      '40-coverage',
      '50-build',
      '60-dist-budget',
    ])
    const text = Object.fromEntries(names.map((n) => [n, readFileSync(join(dir, n), 'utf8')])) as Record<string, string>
    expect(text['10-dependencies']).toContain('bun install --frozen-lockfile')
    expect(text['12-audit']).toContain('scripts/checks/audit.ts')
    expect(text['15-secrets']).toContain('scripts/checks/secrets.ts')
    expect(text['17-scripts']).toContain('scripts/checks/scripts.ts')
    expect(text['18-docs']).toContain('scripts/checks/docs.ts')
    expect(text['19-version']).toContain('scripts/checks/version.ts')
    expect(text['20-types']).toContain('bun run typecheck')
    expect(text['21-language']).toContain('scripts/checks/language.ts')
    expect(text['22-lint']).toContain('scripts/checks/lint.ts')
    expect(text['23-format']).toContain('scripts/checks/format.ts')
    expect(text['30-tests']).toContain('scripts/test.ts')
    expect(text['30-tests']).toContain('--force')
    expect(text['30-tests']).toContain('SHEPHERDR_CHECK_MAP')
    expect(text['40-coverage']).toContain('scripts/coverage.ts')
    expect(text['40-coverage']).toContain('SHEPHERDR_CHECK_RECORD')
    expect(text['50-build']).toContain('bun run build')
    expect(text['60-dist-budget']).toContain('scripts/checks/dist-budget.ts')
    expect(text['60-dist-budget']).toContain('SHEPHERDR_CHECK_RECORD')
    for (const name of names) expect(statSync(join(dir, name)).mode & 0o111, name).toBeTruthy()
  })

  test('a check run on its own finds the repo root, two folders up from scripts/checks/', () => {
    const dir = tmp('checks-standalone')
    const bin = join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    const stub = join(bin, 'bun')
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
    chmodSync(stub, 0o755)
    for (const [name, script] of [
      ['30-tests', 'scripts/test.ts'],
      ['40-coverage', 'scripts/coverage.ts'],
      ['60-dist-budget', 'scripts/checks/dist-budget.ts'],
    ]) {
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

// SHE-172: the run is two phases. Everything numbered below 30 is worktree-local and runs before the one-at-a-time
// lock, so broken types, scripts, docs, version or language fail in seconds instead of after the test queue; 30 and
// up (tests, coverage, build) share the machine's browsers and cores and still go one run at a time under the lock.
describe('the two phases of a full run', () => {
  /** records whether the shared lock was held while this check ran */
  const phases = `#!/usr/bin/env bash
set -uo pipefail
echo "$SHEPHERDR_CHECK_NAME held=$([ -f "$SHEPHERDR_CHECK_ROOT/held" ] && echo yes || echo no)" >> "$SHEPHERDR_CHECK_ROOT/phases.txt"
exit 0
`
  /** hold the shared lock from another process for ms, as a full run does, then release it */
  const holdLock = async (f: ReturnType<typeof fixture>, ms = 2000) => {
    const lock = join(f.home, '.cache', 'shepherdr', 'check-local.lock')
    mkdirSync(dirname(lock), { recursive: true })
    const held = join(f.dir, 'held')
    const proc = Bun.spawn(['bash', '-c', `exec 9>>"${lock}"; flock 9; touch "${held}"; sleep ${ms / 1000}; rm -f "${held}"`], { stdout: 'ignore', stderr: 'ignore' })
    for (let i = 0; i < 200 && !existsSync(held); i++) await Bun.sleep(25)
    expect(existsSync(held), 'the shared lock is held').toBe(true)
    return { held, stop: () => proc.kill() }
  }

  test('the worktree-local checks run while the shared lock is held, and the shared ones wait for it', async () => {
    const f = fixture({ '10-one': phases, '30-tests': phases })
    const holder = await holdLock(f)
    try {
      const r = f.run()
      expect(r.code).toBe(0)
      expect(readFileSync(join(f.dir, 'phases.txt'), 'utf8').trim().split('\n')).toEqual(['one held=yes', 'tests held=no'])
      expect(r.out).toContain('· worktree-local checks done in')
      expect(r.out).toMatch(/2\/2 tests ok/)
    } finally {
      holder.stop()
    }
  })

  test('a worktree-local failure fails at once, never reaching the queue for the shared phase', async () => {
    const f = fixture({ '10-one': check('', 1), '30-tests': phases })
    const holder = await holdLock(f)
    try {
      const r = f.run()
      expect(r.code).toBe(1)
      expect(f.calls()).toEqual(['one'])
      expect(r.out).not.toContain('waiting for it')
      expect(existsSync(join(f.dir, 'phases.txt'))).toBe(false)
    } finally {
      holder.stop()
    }
  })

  test('with no shared check to run, no lock is taken at all', () => {
    const f = fixture({ '10-one': check(), '20-two': check() })
    const r = f.run()
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('Another check')
    expect(existsSync(join(f.home, '.cache', 'shepherdr', 'check-local.lock.pid'))).toBe(false)
  })
})

// Two runs of one worktree can now overlap (a --quick one beside a full one): what they still share must never race.
describe('what two runs of one worktree share', () => {
  test('two full runs never run their shared phase at once: 30-tests still goes one at a time', async () => {
    const tests = `#!/usr/bin/env bash
set -uo pipefail
echo "tests $1 $(date +%s%N)" >> "$SHEPHERDR_CHECK_ROOT/phases.txt"
sleep 0.4
echo "tests $2 $(date +%s%N)" >> "$SHEPHERDR_CHECK_ROOT/phases.txt"
`
    const f = fixture({ '10-one': check(), '30-tests': tests.replace('$1', 'start').replace('$2', 'end') })
    const spawn = () =>
      Bun.spawn(['bash', join(f.dir, 'scripts', 'check-local.sh')], {
        cwd: f.dir,
        env: { ...process.env, HOME: f.home, SHEPHERDR_TEST_JOBS: '', SHEPHERDR_CHECK_WAIT: '30', SHEPHERDR_CHECK_STEP_TIMEOUT: '30' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
    const [a, b] = [spawn(), spawn()]
    expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0])
    const lines = readFileSync(join(f.dir, 'phases.txt'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(' '))
    expect(lines.length).toBe(4)
    const starts = lines
      .filter((l) => l[1] === 'start')
      .map((l) => Number(l[2]))
      .sort((x, y) => x - y)
    const ends = lines
      .filter((l) => l[1] === 'end')
      .map((l) => Number(l[2]))
      .sort((x, y) => x - y)
    // each test step finishes before the other starts: the lock serializes them, not the minute of the run
    expect(ends[0]).toBeLessThan(starts[1])
  })

  test('one build of a worktree at a time: the build and the budget over dist wait for the lock another run holds', async () => {
    const dir = tmp('build-lock')
    const logs = join(dir, 'logs')
    mkdirSync(join(dir, 'scripts', 'checks'), { recursive: true })
    mkdirSync(logs, { recursive: true })
    // both read or write dist/, so both take the same lock: the build because vite empties it, the budget because it reads it
    for (const name of ['50-build', '60-dist-budget']) copyFileSync(join(root, 'scripts', 'checks', name), join(dir, 'scripts', 'checks', name))
    // a bun that only records whether the other run was still building when it ran
    const bin = join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho "held=$([ -f "${dir}/held" ] && echo yes || echo no)" >> "${dir}/built.txt"\n`)
    chmodSync(join(bin, 'bun'), 0o755)
    const held = join(dir, 'held')
    const proc = Bun.spawn(['bash', '-c', `exec 9>>"${join(logs, 'build.lock')}"; flock 9; touch "${held}"; sleep 1.5; rm -f "${held}"`], { stdout: 'ignore', stderr: 'ignore' })
    try {
      for (let i = 0; i < 200 && !existsSync(held); i++) await Bun.sleep(25)
      expect(existsSync(held), 'the build lock is held').toBe(true)
      // the build fails on the dist checks below (the fixture builds nothing), which is not what this test is about
      for (const name of ['50-build', '60-dist-budget'])
        Bun.spawnSync(['bash', join(dir, 'scripts', 'checks', name)], {
          cwd: dir,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHEPHERDR_CHECK_ROOT: dir, SHEPHERDR_CHECK_LOGS: logs, SHEPHERDR_CHECK_LOG: join(logs, `${name}.log`) },
          stdout: 'pipe',
          stderr: 'pipe',
        })
      expect(readFileSync(join(dir, 'built.txt'), 'utf8').trim().split('\n')).toEqual(['held=no', 'held=no'])
    } finally {
      proc.kill()
    }
  })
})
