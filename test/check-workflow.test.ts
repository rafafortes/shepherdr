// The Check workflow (`.github/workflows/check.yml`): when it runs and what one run costs, and the branch its runs and
// screen maps come from. Our line is `herdr-tui` (this fork's default branch): its pull requests and its merges are
// what must be checked, and `main` only mirrors upstream (upstream 7c4cb02b, SHEP-36 #550).
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasPrWorkflows } from '../server/live/engine/git.ts'
import { checkBranch } from './screen-map.ts'
type Trigger = null | { branches?: string[]; 'paths-ignore'?: string[] }
type Workflow = {
  on: Record<'push' | 'pull_request' | 'workflow_dispatch', Trigger>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, { name?: string; 'runs-on': string; 'timeout-minutes': number; strategy?: { matrix: { shard: number[] } } }>
}

const root = join(import.meta.dir, '..')
// one literal path: bun run test changed follows it, so a change to the workflow runs this file (scripts/test.ts)
const file = join(root, '.github/workflows/check.yml')
const workflow = Bun.YAML.parse(await Bun.file(file).text()) as Workflow

/** what a change of docs only leaves out, on a pull request and on a merge */
const DOCS = ['**/*.md', 'docs/**']

describe('when Check runs', () => {
  test('on every pull request into herdr-tui, and on every push to it', () => {
    expect(workflow.on.pull_request?.branches).toEqual(['herdr-tui'])
    expect(workflow.on.push?.branches).toEqual(['herdr-tui'])
    // main mirrors upstream's line: nothing of ours lands there, so nothing of ours is checked there
    for (const t of [workflow.on.pull_request, workflow.on.push]) expect(t?.branches).not.toContain('main')
  })
  test('which the merge logic reads as a pull request that gets checks, before any shows', async () => {
    // engine.ts holds a merge back while GitHub's checks on its pull request are still missing; the workflow's word
    expect(await hasPrWorkflows(root)).toBe(true)
  })
  test('not on a change of docs only, since there is nothing to check in it', () => {
    expect(workflow.on.pull_request?.['paths-ignore']).toEqual(DOCS)
    expect(workflow.on.push?.['paths-ignore']).toEqual(DOCS)
  })
  test('by hand on a branch with no pull request: gh workflow run check.yml --ref <branch>', () => {
    expect(Object.keys(workflow.on)).toContain('workflow_dispatch')
  })
  test('each ref has a run of its own, and a newer run cancels the older one of it', () => {
    expect(workflow.concurrency.group).toBe('check-${{ github.ref }}')
    expect(workflow.concurrency['cancel-in-progress']).toBe(true)
  })
})

describe('what one run costs', () => {
  // GitHub bills each job by the minute, rounded up: about 1 for the types and the build, 2-7 for each test shard
  test('four jobs: the types and the build together, and the tests over three shards', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['types', 'test'])
    expect(workflow.jobs.types!.name).toBe('types and build')
    expect(workflow.jobs.test!.name).toBe('test (${{ matrix.shard }}/3)')
    expect(workflow.jobs.test!.strategy?.matrix.shard).toEqual([1, 2, 3])
  })
})

describe('the branch its runs come from', () => {
  const git = (dir: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    return r.stdout.toString().trim()
  }
  test("the repo's default branch, which origin/HEAD names: herdr-tui here, main upstream", () => {
    const dir = mkdtempSync(join(tmpdir(), 'shep-check-'))
    try {
      git(dir, 'init', '-q', '-b', 'herdr-tui')
      git(dir, '-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-q', '--allow-empty', '-m', 'first')
      git(dir, 'update-ref', 'refs/remotes/origin/herdr-tui', 'HEAD')
      git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/herdr-tui')
      expect(checkBranch(dir)).toBe('herdr-tui')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('main, where no origin/HEAD says otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shep-check-'))
    try {
      git(dir, 'init', '-q', '-b', 'main')
      expect(checkBranch(dir)).toBe('main')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
