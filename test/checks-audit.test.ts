// The dependency audit step (audit 2026-11-18, QG-05): a new advisory id fails, one in the .git baseline passes with
// a comment, an unknown licence fails naming its package, and an unreachable registry is a note and a pass. These
// drive the real module against fixture repos of their own; bun audit is stubbed so no test needs the registry.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALLOWED,
  advisoryId,
  allows,
  baselineFile,
  bunAudit,
  checkLicenses,
  compare,
  describe as describeAdvisory,
  found,
  installedPaths,
  licenseOf,
  main,
  packagesOf,
  parseAudit,
  readBaseline,
  recordBaseline,
  runAudit,
  type Advisory,
  type Report,
  type Spawn,
} from '../scripts/checks/audit.ts'
import { tmp } from './tmp.ts'

/** an advisory straight from bun audit --json */
const advisory = (id: number, extra: Partial<Advisory> = {}): Advisory => ({
  id,
  title: 'Prototype Pollution',
  severity: 'high',
  vulnerable_versions: '>=1.0.0 <1.2.6',
  url: 'https://github.com/advisories/GHSA-test-0000',
  ...extra,
})

/** a fixture repo with a lockfile, one installed MIT package, one for another platform, and a commit of its own */
function fixture() {
  const dir = tmp('audit-repo')
  const logs = tmp('audit-logs')
  mkdirSync(logs, { recursive: true })
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    return r.stdout.toString().trim()
  }
  git('init', '-q', '-b', 'herdr-tui')
  const lock = { lockfileVersion: 2, packages: { 'good-pkg': ['good-pkg@1.0.0', '', {}, 'x'], 'other-platform': ['other-platform@2.0.0', '', {}, 'x'] } }
  writeFileSync(join(dir, 'bun.lock'), JSON.stringify(lock))
  mkdirSync(join(dir, 'node_modules', 'good-pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'good-pkg', 'package.json'), JSON.stringify({ license: 'MIT' }))
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  git('add', '-A')
  git('-c', 'user.name=CI', '-c', 'user.email=ci@localhost', 'commit', '-qm', 'init')
  const baseline = join(logs, 'accepted.json')
  const audit = (report: Report | string | null, exitCode = 0, stderr = '') => ({
    root: dir,
    baseline,
    audit: () => ({ stdout: typeof report === 'string' ? report : report === null ? '' : JSON.stringify(report), exitCode, stderr }),
  })
  return { dir, logs, baseline, git, audit }
}

describe('advisory ids and the baseline ratchet', () => {
  test('an id is its number, or the GHSA in the link when bun gives no number', () => {
    expect(advisoryId(advisory(1097678))).toBe('1097678')
    expect(advisoryId({ url: 'See https://github.com/advisories/GHSA-xvch-5gv4-984h for more' })).toBe('GHSA-xvch-5gv4-984h')
    expect(advisoryId({ title: 'no id at all' })).toBe('unknown')
  })

  test('a report is an object; empty, broken or non-advisory answers are not one', () => {
    expect(parseAudit('{}')).toEqual({})
    expect(parseAudit('{"ws":[{"id":1}]}')).toEqual({ ws: [{ id: 1 }] })
    expect(parseAudit('[]')).toBeNull()
    expect(parseAudit('"nope"')).toBeNull()
    expect(parseAudit('{"error":"ENOTFOUND registry.npmjs.org"}')).toBeNull()
    expect(parseAudit('not json')).toBeNull()
  })

  test('a new advisory names its package, id and fix hint; an accepted one is only a comment', () => {
    const report: Report = { widget: [advisory(111)], ws: [advisory(222, { severity: undefined, title: undefined, vulnerable_versions: undefined, url: undefined })] }
    expect(found({ ...report, 'no-list': null as never })).toHaveLength(2)
    const c = compare(report, ['222'])
    expect(c.fresh).toHaveLength(1)
    expect(c.fresh[0]).toContain('widget')
    expect(c.fresh[0]).toContain('advisory 111')
    expect(c.fresh[0]).toContain('(high)')
    expect(c.fresh[0]).toContain('>=1.0.0 <1.2.6')
    expect(c.fresh[0]).toContain('fix: https://github.com/advisories/GHSA-test-0000')
    expect(c.known).toHaveLength(1)
    expect(c.known[0]).toContain('advisory 222')
    expect(c.known[0]).toContain('affected unknown')
    expect(c.known[0]).toContain('fix: see the npm advisory database')
    expect(compare({ a: [advisory(2)], b: [advisory(1)] }, []).fresh.map((x) => x.split(' ')[0])).toEqual(['a', 'b'])
  })

  test('the baseline lives in the repo .git for every worktree, and is read and written like coverage.ts', () => {
    const f = fixture()
    expect(baselineFile(f.dir)).toBe(join(f.dir, '.git', 'shepherdr-audit', 'accepted.json'))
    expect(baselineFile(tmp('audit-no-git'))).toEndWith(join('node_modules', '.cache', 'shepherdr-audit', 'accepted.json'))
    expect(readBaseline(f.baseline)).toBeNull()
    writeFileSync(f.baseline, 'not json')
    expect(readBaseline(f.baseline)).toBeNull()
    writeFileSync(f.baseline, JSON.stringify({ at: 1 }))
    expect(readBaseline(f.baseline)).toBeNull()
    recordBaseline(f.baseline, ['111', '222'], 'abc1234def')
    expect(readBaseline(f.baseline)).toEqual({ commit: 'abc1234def', at: expect.any(Number), ids: ['111', '222'] })
  })
})

describe('licences', () => {
  test('the allowlist covers the tree, an SPDX choice needs one of its options, a conjunction needs both', () => {
    for (const lic of ALLOWED) expect(allows(lic)).toBe(true)
    expect(allows('(MPL-2.0 OR Apache-2.0)')).toBe(true)
    expect(allows('MIT OR GPL-3.0')).toBe(true)
    expect(allows('MIT AND Apache-2.0')).toBe(true)
    expect(allows('MIT AND GPL-3.0')).toBe(false)
    expect(allows('GPL-3.0')).toBe(false)
    expect(allows('UNLICENSED')).toBe(false)
    expect(allows(undefined)).toBe(false)
    expect(allows('Apache-2.0', ['MIT'])).toBe(false)
  })

  test("a licence is read from each package's package.json, as a string or a { type }", () => {
    expect(licenseOf('{"license":"MIT"}')).toBe('MIT')
    expect(licenseOf('{"license":{"type":"ISC"}}')).toBe('ISC')
    expect(licenseOf('{"name":"x"}')).toBeUndefined()
    expect(licenseOf('not json')).toBeUndefined()
    expect(packagesOf('{"packages":{"a":[],"b":[]}}')).toEqual(['a', 'b'])
    expect(packagesOf('{}')).toEqual([])
  })

  test('a bad or undeclared licence fails naming its package; a package for another platform is not installed', () => {
    const f = fixture()
    const names = ['good-pkg', 'other-platform', 'gpl-pkg', 'no-licence', 'dual-pkg', 'broken-pkg']
    const pkg = (name: string, body: string) => {
      mkdirSync(join(f.dir, 'node_modules', name), { recursive: true })
      writeFileSync(join(f.dir, 'node_modules', name, 'package.json'), body)
    }
    pkg('gpl-pkg', '{"license":"GPL-3.0"}')
    pkg('no-licence', '{"name":"no-licence"}')
    pkg('dual-pkg', '{"license":"(MPL-2.0 OR Apache-2.0)"}')
    pkg('broken-pkg', 'not json')
    const r = checkLicenses(f.dir, names, (file) => readFileSync(file, 'utf8'))
    expect(r.checked).toBe(5)
    expect(r.missing).toBe(1)
    expect(r.bad).toEqual(['gpl-pkg: GPL-3.0', 'no-licence: no licence declared', 'broken-pkg: no licence declared'])
  })

  test('a nested locked package is found under its parent, and its licence is checked too', () => {
    const f = fixture()
    const name = '@tailwindcss/node/lightningcss'
    expect(installedPaths(f.dir, name)[2]).toBe(join(f.dir, 'node_modules', '@tailwindcss', 'node', 'node_modules', 'lightningcss', 'package.json'))
    const nested = join(f.dir, 'node_modules', '@tailwindcss', 'node', 'node_modules', 'lightningcss')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'package.json'), '{"license":"MPL-2.0"}')
    const good = checkLicenses(f.dir, [name], (file) => readFileSync(file, 'utf8'))
    expect(good).toEqual({ bad: [], checked: 1, missing: 0 })
    writeFileSync(join(nested, 'package.json'), '{"license":"GPL-3.0"}')
    expect(checkLicenses(f.dir, [name], (file) => readFileSync(file, 'utf8')).bad).toEqual([`${name}: GPL-3.0`])
  })
})

describe('the gate step', () => {
  test('a new advisory fails with its id, package and fix hint; a baseline-recorded one passes with a comment', () => {
    const f = fixture()
    const report: Report = { widget: [advisory(1097678)] }
    const lines: string[] = []
    const notes: string[] = []
    const o = f.audit(report, 1)
    expect(runAudit({ ...o, log: (l) => lines.push(l), note: (n) => notes.push(n) })).toBe(1)
    expect(lines.join('\n')).toContain('new advisory: widget · advisory 1097678')
    expect(lines.join('\n')).toContain('fix: https://github.com/advisories/GHSA-test-0000')
    expect(notes.join('\n')).toContain('1 new, 0 accepted advisories')

    recordBaseline(f.baseline, ['1097678'], 'abc1234')
    const known: string[] = []
    expect(runAudit({ ...o, log: (l) => known.push(l) })).toBe(0)
    expect(known.join('\n')).toContain('accepted: widget · advisory 1097678')
  })

  test('an unknown licence in a fixture lockfile fails the step with the package named', () => {
    const f = fixture()
    mkdirSync(join(f.dir, 'node_modules', 'evil'), { recursive: true })
    writeFileSync(join(f.dir, 'node_modules', 'evil', 'package.json'), '{"license":"AGPL-3.0"}')
    writeFileSync(join(f.dir, 'bun.lock'), JSON.stringify({ packages: { good: [], evil: [], absent: [] } }))
    const lines: string[] = []
    expect(runAudit({ ...f.audit({}), log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('licence not allowed: evil: AGPL-3.0')
  })

  test('an unreachable registry notes the skip and passes, checking licences locally', () => {
    const f = fixture()
    const lines: string[] = []
    const notes: string[] = []
    const skipped: string[] = []
    expect(runAudit({ ...f.audit(null, 1, 'ENOTFOUND registry.npmjs.org'), log: (l) => lines.push(l), note: (n) => notes.push(n), skip: (s) => skipped.push(s) })).toBe(0)
    expect(lines.join('\n')).toContain('could not read advisories (offline or the registry is down): ENOTFOUND registry.npmjs.org')
    expect(notes.join('\n')).toContain('bun audit could not reach the registry: advisories not checked; licences checked in 1 packages (1 not installed here)')
    // the verdict names the part that did not run, as it does for a browser that could not start
    expect(skipped).toEqual([notes[0]])
    // a registry that answers with an empty body and no stderr is the same named note, with the exit code
    const bare: string[] = []
    expect(runAudit({ ...f.audit(null, 1), log: (l) => bare.push(l) })).toBe(0)
    expect(bare.join('\n')).toContain('exit 1')
    // a clean online run is not a skip
    const onlineSkip: string[] = []
    expect(runAudit({ ...f.audit({}), skip: (s) => onlineSkip.push(s) })).toBe(0)
    expect(onlineSkip).toEqual([])
  })

  test('recording on the default branch accepts the ids it sees; a dirty tree records nothing', () => {
    const f = fixture()
    const report: Report = { widget: [advisory(42)] }
    expect(runAudit({ ...f.audit(report, 1), record: true })).toBe(0)
    expect(readBaseline(f.baseline)?.ids).toEqual(['42'])
    writeFileSync(join(f.dir, 'loose.txt'), 'uncommitted\n')
    const lines: string[] = []
    expect(runAudit({ ...f.audit({ widget: [advisory(99)] }, 1), record: true, log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toContain('No audit baseline recorded: the tree holds what is not committed.')
    expect(lines.join('\n')).toContain('new advisory: widget · advisory 99')
    expect(readBaseline(f.baseline)?.ids).toEqual(['42'])
  })

  test('no baseline yet says so, and a lockfile that cannot be read fails', () => {
    const f = fixture()
    const lines: string[] = []
    expect(runAudit({ root: f.dir, baseline: join(f.logs, 'none.json'), audit: () => ({ stdout: '{}', exitCode: 0, stderr: '' }), log: (l) => lines.push(l) })).toBe(0)
    expect(lines.join('\n')).toContain('No audit baseline yet: the check on the default branch records the advisory ids it accepts.')
    const noLock = tmp('audit-no-lock')
    const fail: string[] = []
    expect(runAudit({ root: noLock, audit: () => ({ stdout: '{}', exitCode: 0, stderr: '' }), log: (l) => fail.push(l) })).toBe(1)
    expect(fail.join('\n')).toContain('bun.lock could not be read: licences not checked')
  })

  test('bun audit is called once, with its JSON, and a stand-in spawn needs no registry', () => {
    const calls: string[][] = []
    const spawn: Spawn = (args, opts) => {
      calls.push(args)
      expect(opts.cwd).toBe('/tmp/fake')
      return { stdout: '{"ws":[{"id":7}]}', stderr: '', exitCode: 1 }
    }
    expect(bunAudit('/tmp/fake', spawn)).toEqual({ stdout: '{"ws":[{"id":7}]}', exitCode: 1, stderr: '' })
    expect(calls).toEqual([['bun', 'audit', '--json']])
    const sparse: Spawn = () => ({})
    expect(bunAudit('/tmp/fake', sparse)).toEqual({ stdout: '', exitCode: 1, stderr: '' })
  })

  test('the runner entry point uses its environment and writes its note', () => {
    const f = fixture()
    const note = join(f.logs, 'audit.note')
    expect(main({ SHEPHERDR_CHECK_ROOT: f.dir, SHEPHERDR_CHECK_NOTE: note, SHEPHERDR_CHECK_RECORD: '1' }, f.audit({}))).toBe(0)
    expect(readFileSync(note, 'utf8')).toContain('0 new, 0 accepted advisories')
    expect(readBaseline(f.baseline)?.ids).toEqual([])
    // offline writes a skip reason the runner reads into the verdict, as well as the note
    const skip = join(f.logs, 'audit.skip')
    expect(main({ SHEPHERDR_CHECK_ROOT: f.dir, SHEPHERDR_CHECK_SKIP: skip }, f.audit(null, 1, 'offline'))).toBe(0)
    expect(readFileSync(skip, 'utf8')).toContain('advisories not checked')
    expect(existsSync(join(f.dir, 'bun.lock'))).toBe(true)
  })
})
