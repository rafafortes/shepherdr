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
import { checkBranch } from './screen-map.ts'
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
    const script = readFileSync(join(root, 'scripts', 'check-local.sh'), 'utf8')
    for (const step of ['bun run typecheck', 'scripts/test.ts', 'bun run build']) expect(script).toContain(step)
    expect(script).toContain('nice -n 19')
    expect(script).toContain('ionice -c 3')
    expect(script).toContain('flock')
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

describe('the branch its runs come from', () => {
  test("the repo's default branch, which origin/HEAD names: herdr-tui here, main upstream", () => {
    const dir = mkdtempSync(join(tmpdir(), 'shep-check-'))
    try {
      const git = gitIn(dir, 'herdr-tui')
      git('-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-q', '--allow-empty', '-m', 'first')
      git('update-ref', 'refs/remotes/origin/herdr-tui', 'HEAD')
      git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/herdr-tui')
      expect(checkBranch(dir)).toBe('herdr-tui')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('main, where no origin/HEAD says otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shep-check-'))
    try {
      gitIn(dir, 'main')
      expect(checkBranch(dir)).toBe('main')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** a fresh repo at `branch`, and a git to run in it that fails this test when it fails */
function gitIn(dir: string, branch: string) {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    return r.stdout.toString().trim()
  }
  git('init', '-q', '-b', branch)
  return git
}
