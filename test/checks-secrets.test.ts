// The secrets gate step (audit 2026-11-18, QG-06): a planted token in a fixture repo fails, its fingerprint in
// .gitleaksignore passes, and a host without gitleaks skips with the install command. These drive the real module
// with real fixture repos; the report and the runner's note/skip files go to folders outside the repo under test so
// no test can add a finding to this one. A fake token in the fixture is not a credential and cannot be revoked.
import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INSTALL, main, runSecrets, type Finding } from '../scripts/checks/secrets.ts'
import { tmp } from './tmp.ts'

const gitleaks = Bun.which('gitleaks') ?? ''
// deliberately fake; the allow comment keeps this test's own source out of this repo's gitleaks findings
const FAKE_KEY = 'AKIA1234567890ABCDEF' // gitleaks:allow - fake token planted in fixture repos by this test

/** a git repo of its own with one commit, optionally holding the planted token, and a report folder outside it */
function repo(plant = false) {
  const dir = tmp('secrets-repo')
  const logs = tmp('secrets-logs')
  mkdirSync(logs, { recursive: true })
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    return r.stdout.toString().trim()
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, plant ? 'config.txt' : 'README.md'), plant ? `key = "${FAKE_KEY}"\n` : 'fixture\n')
  git('add', '-A')
  git('-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-qm', plant ? 'plant a fake key' : 'init')
  return { dir, logs, git, report: join(logs, 'gitleaks.json') }
}

/** a stand-in binary that fails a scan in a chosen way, for the paths the real gitleaks cannot take here */
function fakeBinary(body: string) {
  const dir = tmp('secrets-bin')
  const file = join(dir, 'gitleaks')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

describe('a host without gitleaks', () => {
  test('skips with the install command, never fails or scans', () => {
    const f = repo(true)
    const lines: string[] = []
    const skipped: string[] = []
    expect(runSecrets({ root: f.dir, logs: f.logs, binary: null, log: (l) => lines.push(l), skip: (s) => skipped.push(s) })).toBe(0)
    expect(skipped).toEqual([INSTALL])
    expect(lines.join('\n')).toContain('install')
    expect(existsSync(f.report), 'no report without a binary').toBe(false)
  })
})

describe('when gitleaks cannot scan', () => {
  test('a gitleaks error fails the step with its message', () => {
    const f = repo()
    const lines: string[] = []
    expect(runSecrets({ root: f.dir, logs: f.logs, binary: fakeBinary('echo "boom" >&2\nexit 2'), log: (l) => lines.push(l) })).toBe(2)
    expect(lines.join('\n')).toContain('boom')
  })
  test('a finding with no readable report still fails', () => {
    const f = repo()
    const lines: string[] = []
    expect(runSecrets({ root: f.dir, logs: f.logs, binary: fakeBinary('exit 1'), log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('could not be read')
  })
})

describe.skipIf(!gitleaks)('gitleaks over a fixture repo and its history', () => {
  test('a planted token fails, naming its file and rule, with no secret in the output or the report', () => {
    const f = repo(true)
    const lines: string[] = []
    const notes: string[] = []
    expect(runSecrets({ root: f.dir, logs: f.logs, binary: gitleaks, log: (l) => lines.push(l), note: (n) => notes.push(n) })).toBe(1)
    const out = lines.join('\n')
    expect(out).toContain('config.txt:1')
    expect(out).toMatch(/rule \S+/)
    expect(out).not.toContain(FAKE_KEY)
    const report = readFileSync(f.report, 'utf8')
    expect(report).toContain('REDACTED')
    expect(report).not.toContain(FAKE_KEY)
    expect(notes).toEqual([])
  })

  test('a fingerprint in .gitleaksignore passes: the baseline ratchet', () => {
    const f = repo(true)
    expect(runSecrets({ root: f.dir, logs: f.logs, binary: gitleaks })).toBe(1)
    const finding = (JSON.parse(readFileSync(f.report, 'utf8')) as Finding[])[0]!
    writeFileSync(join(f.dir, '.gitleaksignore'), `# Fake test key, baselined as a false positive\n${finding.Fingerprint}\n`)
    f.git('add', '-A')
    f.git('-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-qm', 'baseline the fake key')
    const notes: string[] = []
    expect(runSecrets({ root: f.dir, logs: f.logs, binary: gitleaks, note: (n) => notes.push(n) })).toBe(0)
    expect(notes).toEqual(['no secrets found in the committed tree or its history'])
  })

  test('the runner entry point reads its environment, writes its note and names a new finding', () => {
    const clean = repo()
    const planted = repo(true)
    const note = join(clean.logs, 'secrets.note')
    const skip = join(clean.logs, 'secrets.skip')
    expect(main({ SHEPHERDR_CHECK_ROOT: clean.dir, SHEPHERDR_CHECK_LOGS: clean.logs, SHEPHERDR_CHECK_NOTE: note, SHEPHERDR_CHECK_SKIP: skip })).toBe(0)
    expect(readFileSync(note, 'utf8')).toContain('no secrets found')
    expect(existsSync(skip), 'no skip when the binary is there').toBe(false)
    expect(main({ SHEPHERDR_CHECK_ROOT: planted.dir, SHEPHERDR_CHECK_LOGS: planted.logs })).toBe(1)
  })

  test("a run's report sits beside its own log, so a quick run beside a full one never overwrites it", () => {
    const f = repo()
    const log = join(f.logs, 'secrets-quick.log')
    expect(main({ SHEPHERDR_CHECK_ROOT: f.dir, SHEPHERDR_CHECK_LOGS: f.logs, SHEPHERDR_CHECK_LOG: log })).toBe(0)
    expect(existsSync(`${log}.json`)).toBe(true)
    expect(existsSync(join(f.logs, 'gitleaks.json'))).toBe(false)
  })
})
