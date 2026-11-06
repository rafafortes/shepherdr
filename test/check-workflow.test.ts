// GitHub Actions is off on this repo (2026-11-06): the Check workflow (`.github/workflows/check.yml`) starts nothing
// by itself and stays only for a run asked for by hand, and the whole check runs on the machine the agents work on
// (`bun run check:local`, AGENTS.md). Shepherdr reads a repo's workflow on a pull request as one whose checks will show
// up on it, and holds a merge until they do (server/live/engine/git.ts, hasPrWorkflows, read by checksOf in
// server/live/engine/engine.ts): no merge here may wait for checks that never start.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasPrWorkflows } from '../server/live/engine/git.ts'
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

/** a git repo holding this repo's Check workflow at HEAD: what hasPrWorkflows reads, whatever this worktree hasn't
 *  committed yet */
function repoWithWorkflow() {
  const dir = mkdtempSync(join(tmpdir(), 'shep-check-'))
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
      expect(await hasPrWorkflows(dir)).toBe(false)
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
  test('whose script runs the types, the tests and the build, one run at a time, last in line for the CPU', () => {
    // its comments name these too: what runs is what a line that isn't a comment says
    const lines = readFileSync(join(root, 'scripts', 'check-local.sh'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .join('\n')
    for (const step of ['bun run typecheck', 'scripts/test.ts', 'bun run build']) expect(lines).toContain(step)
    // the wrapper and the lock that is used, not the words near them
    expect(lines).toContain('prio+=(nice -n 19)')
    expect(lines).toContain('prio+=(ionice -c 3)')
    expect(lines).toContain('exec 9>>"$lock"')
    expect(lines).toContain('flock -w "$wait_timeout" 9')
    // the step's own processes never keep the lock, and never take a pass at this commit for this one
    expect(lines).toContain('exec 9>&-')
    expect(lines).toContain('--force')
  })
})

describe('what a failing run says', () => {
  // the awk that reads a failing run's log (scripts/check-local.sh): the failing tests by file, the closing summary
  // left out, and a file whose error names no test left to the log's end
  const script = readFileSync(join(root, 'scripts', 'check-local.sh'), 'utf8')
  const from = script.indexOf("awk '") + "awk '".length
  const program = script.slice(from, script.indexOf("' \"$1\"", from))
  const run = (log: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'shep-check-log-'))
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
