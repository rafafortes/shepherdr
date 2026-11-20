// GitHub Actions is off on this repo (2026-11-06): the Check workflow (`.github/workflows/check.yml`) starts nothing
// by itself and stays only for a run asked for by hand, and the whole check runs on the machine the agents work on
// (`bun run check:local`, AGENTS.md). Shepherdr reads a repo's workflow on a pull request as one whose checks will show
// up on it, and holds a merge until they do (server/live/engine/git.ts, prWorkflowExpect, read by checksOf in
// server/live/engine/engine.ts): no merge here may wait for checks that never start.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keyOf, main, prune } from '../scripts/prune-logs.ts'
import { prWorkflowExpect } from '../server/live/engine/git.ts'
import { tmp } from './tmp.ts'

type Workflow = {
  on: Record<string, unknown>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, { name?: string; 'runs-on': string; 'timeout-minutes': number; strategy?: { matrix: { shard: number[] } } }>
}

const root = join(import.meta.dir, '..')
// one literal path: bun run test changed follows it, so a change to the workflow runs this file (scripts/test.ts)
const file = join(root, '.github/workflows/check.yml')
const text = readFileSync(file, 'utf8')
const workflow = Bun.YAML.parse(text) as Workflow

/** a git repo holding this repo's Check workflow at HEAD: what prWorkflowExpect reads, whatever this worktree hasn't
 *  committed yet */
function repoWithWorkflow() {
  const dir = tmp('check')
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    return r.stdout.toString().trim()
  }
  git('init', '-q', '-b', 'herdr-tui')
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'check.yml'), text)
  git('add', '-A')
  git('-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-qm', 'check')
  return { dir, git }
}

describe('when Check runs', () => {
  test('only when someone asks for it: on nothing by itself', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  })
  test('and Shepherdr reads no pull request workflow in it, so no merge waits for checks that never start', async () => {
    const { dir } = repoWithWorkflow()
    try {
      expect(await prWorkflowExpect(dir)).toBe('none')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('each run of it has a ref of its own, and a newer one cancels the older one of it', () => {
    expect(workflow.concurrency.group).toBe('check-${{ github.ref }}')
    expect(workflow.concurrency['cancel-in-progress']).toBe(true)
  })
})

describe('the check itself', () => {
  test('runs here: bun run check:local, and bun run check with it', () => {
    const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts['check:local']).toBe('bash scripts/check-local.sh')
    expect(scripts.check).toBe('bun run check:local')
  })
  test('answers --reuse from the verdict every worktree shares by tree, and keeps one for each tree that passed', () => {
    const lines = readFileSync(join(root, 'scripts', 'check-local.sh'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
    // the cheap merge gate (QG-10): the tree the check read, in a folder every worktree of the repo shares
    expect(lines).toContain('verdicts="$HOME/.cache/shepherdr/check-local/verdicts"')
    expect(lines).toContain(`  tree=$(git -C "$root" rev-parse --verify --quiet 'HEAD^{tree}' 2>/dev/null)`)
    expect(lines).toContain('for arg in "$@"; do [ "$arg" = --reuse ] && reuse=1; done')
    // a quick run answers nothing and keeps nothing, and the gate question is asked after the lock wait too (the run
    // it waited behind may have just kept this very tree)
    expect(lines).toContain(`if [ "$quick" = 1 ] && [ "$reuse" = 1 ]; then`)
    expect(lines).toContain('reuse_answer && exit 0')
    // asked again once the run reaches the lock (it may be indented inside the shared phase)
    expect(lines.some((l) => l.trim() === 'if reuse_answer; then')).toBe(true)
    // a tree's verdict is written only once the run passed whole, and taken away when it fails
    const call = lines.indexOf('  record 1')
    expect(call).toBeGreaterThan(-1)
    expect(lines).toContain('record 0')
    // a --reuse run's last line is the one a merge commit carries: the log folder is said before it, never in it
    const tail = lines.slice(call)
    const logs = tail.indexOf('    say "· logs: $logs"')
    const passed = tail.findIndex((l) => l.includes('say "PASSED in'))
    expect(logs).toBeGreaterThan(0)
    expect(logs).toBeLessThan(passed)
  })

  test('whose runner discovers the checks, one run at a time, last in line for the CPU', () => {
    // its comments name these too: what runs is what a line that isn't a comment says
    const lines = readFileSync(join(root, 'scripts', 'check-local.sh'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .join('\n')
    // the checks are discovered by sorted file name, not named here; adding one is adding one file
    expect(lines).toContain('checks_dir="$root/scripts/checks"')
    expect(lines).toContain('find "$checks_dir" -maxdepth 1 -type f')
    expect(lines).toContain('LC_ALL=C sort')
    expect(lines).toContain('step "$name" "$checks_dir/$file"')
    // no command of a check is embedded in the runner any more
    for (const command of ['bun install', 'bun run typecheck', 'scripts/test.ts', 'scripts/coverage.ts', 'bun run build']) expect(lines).not.toContain(command)
    // the wrapper and the lock that is used, not the words near them
    expect(lines).toContain('prio+=(nice -n 19)')
    expect(lines).toContain('prio+=(ionice -c 3)')
    expect(lines).toContain('exec 9>>"$lock"')
    expect(lines).toContain('flock -w "$wait_timeout" 9')
    // a check's own processes never keep the lock
    expect(lines).toContain('exec 9>&-')
  })

  test('prunes old log folders on success only, never beside another check and never outside the cache', () => {
    const lines = readFileSync(join(root, 'scripts', 'check-local.sh'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => l.trim())
    expect(lines).toContain('log_root="$HOME/.cache/shepherdr/check-local"')
    expect(lines).toContain('export SHEPHERDR_CHECK_LIVE="$live"')
    expect(lines.some((l) => l.includes('bun "$root/scripts/prune-logs.ts" >/dev/null 2>&1'))).toBe(true)
    expect(lines.some((l) => l.includes('exec "') && l.includes('prio[@]'))).toBe(true)
    expect(lines).toContain('exec 9>&-')
    // the other lock is probed, so a quick run beside a full one leaves the folder it shares alone
    expect(lines).toContain('( exec 8>>"$other_lock" 2>/dev/null || exit 1; flock -n 8 ) || return 0')
    expect(lines).toContain('[ "$quick" = 1 ] && other_lock=$full_lock')
    // only the three exit-0 paths call it: a failed run leaves its logs for the person who has to read them
    expect(lines.filter((l) => l === 'prune_logs')).toHaveLength(3)
  })
})

describe('pruning check-local log folders', () => {
  /** a cache of run folders, oldest first: mtime decides which runs of a worktree are the newest */
  const cache = (names: string[]) => {
    const home = tmp('check-prune')
    const logs = join(home, '.cache', 'shepherdr', 'check-local')
    mkdirSync(logs, { recursive: true })
    names.forEach((name, i) => {
      const dir = join(logs, name)
      mkdirSync(dir)
      writeFileSync(join(dir, 'verdict.txt'), 'PASSED in 1s\n')
      const at = new Date(1_700_000_000_000 + i * 60_000)
      utimesSync(dir, at, at)
    })
    return { home, logs }
  }
  const names = (logs: string) => readdirSync(logs).sort()

  test('a folder belongs to the worktree it is named for, or to the one before a run suffix', () => {
    const live = new Set(['wt', 'other'])
    expect(keyOf('wt', live)).toBe('wt')
    expect(keyOf('wt.3', live)).toBe('wt')
    expect(keyOf('other', live)).toBe('other')
    expect(keyOf('gone.3', live)).toBeUndefined()
    expect(keyOf('gone', live)).toBeUndefined()
  })

  test('removes the folders of worktrees that are gone and keeps the live ones', () => {
    const { logs } = cache(['live-a', 'gone-b', 'live-c'])
    expect(prune(logs, ['live-a', 'live-c'], 'live-a', 5)).toEqual(['gone-b'])
    expect(names(logs)).toEqual(['live-a', 'live-c'])
    expect(existsSync(join(logs, 'live-a', 'verdict.txt'))).toBe(true)
  })

  test('keeps at most N run folders per worktree, the newest ones, and always the current run', () => {
    const runs = ['wt.1', 'wt.2', 'wt.3', 'wt.4', 'wt.5', 'wt.6']
    const newest = cache(runs)
    expect(prune(newest.logs, ['wt'], 'wt.6', 3)).toEqual(['wt.1', 'wt.2', 'wt.3'])
    expect(names(newest.logs)).toEqual(['wt.4', 'wt.5', 'wt.6'])

    // the current folder wins a place even when an older run's mtime is behind it
    const oldest = cache(runs)
    expect(prune(oldest.logs, ['wt'], 'wt.1', 3).sort()).toEqual(['wt.2', 'wt.3', 'wt.4'])
    expect(names(oldest.logs)).toEqual(['wt.1', 'wt.5', 'wt.6'])
  })

  test('keeps the current folder even when its worktree is gone, and touches nothing outside the cache', () => {
    const { home, logs } = cache(['current', 'gone', 'verdicts'])
    mkdirSync(join(home, 'outside'))
    expect(prune(logs, ['elsewhere'], 'current', 5)).toEqual(['gone'])
    expect(names(logs)).toEqual(['current', 'verdicts'])
    expect(existsSync(join(home, 'outside'))).toBe(true)
  })

  test('leaves every folder alone when no live worktree could be read', () => {
    const { logs } = cache(['gone'])
    expect(prune(logs, [], '', 5)).toEqual([])
    expect(names(logs)).toEqual(['gone'])
  })

  test('main takes the cache, the live worktree paths, the current folder and the cap from the runner', () => {
    const { home, logs } = cache(['wt.1', 'wt.2', 'wt.3', 'gone'])
    expect(
      main({
        HOME: home,
        SHEPHERDR_CHECK_LIVE: '/anywhere/wt\n/anywhere/else',
        SHEPHERDR_CHECK_CURRENT: 'wt.3',
        SHEPHERDR_CHECK_KEEP: '2',
      }),
    ).toEqual(['gone', 'wt.1'])
    expect(names(logs)).toEqual(['wt.2', 'wt.3'])
  })
})

describe('what a failing run says', () => {
  // the awk that reads a failing run's log (scripts/check-local.sh): the failing tests by file, the closing summary
  // left out, and a file whose error names no test left to the log's end
  const script = readFileSync(join(root, 'scripts', 'check-local.sh'), 'utf8')
  const from = script.indexOf("awk '") + "awk '".length
  const program = script.slice(from, script.indexOf('\' "$1"', from))
  const run = (log: string) => {
    const dir = tmp('check-log')
    try {
      const file = join(dir, 'tests.log')
      writeFileSync(file, log)
      const r = Bun.spawnSync(['awk', program, file], { stdout: 'pipe', stderr: 'pipe' })
      expect(r.exitCode, r.stderr.toString()).toBe(0)
      return r.stdout.toString().trim().split('\n').filter(Boolean)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  test('names each failing test against its own file, once, and never the closing summary', () => {
    expect(
      run(
        [
          'test/one.test.ts:',
          '(pass) works [1.00ms]',
          '(fail) breaks [2.00ms]',
          '',
          'test/two.test.ts:',
          '(fail) another breaks [3.00ms]',
          '',
          ' 1 tests failed:',
          '(fail) breaks [2.00ms]',
          ' 1192 pass',
          ' 1 fail',
          'Ran 1193 tests across 105 files. [100.00s]',
          '',
        ].join('\n'),
      ),
    ).toEqual(['test/one.test.ts > breaks', 'test/two.test.ts > another breaks'])
  })
  test("says nothing when the log names no test: the check shows the log's end instead", () => {
    expect(run(['test/one.test.ts:', '# Unhandled error between tests', 'ReferenceError: describe is not defined'].join('\n'))).toEqual([])
  })
})

describe('a run asked for by hand', () => {
  test('still runs the whole check: the types and the build together, and the tests over three shards', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['types', 'test'])
    expect(workflow.jobs.types!.name).toBe('types and build')
    expect(workflow.jobs.test!.name).toBe('test (${{ matrix.shard }}/3)')
    expect(workflow.jobs.test!.strategy?.matrix.shard).toEqual([1, 2, 3])
  })
})
