// The dist budget (scripts/checks/dist-budget.ts): what the build left in dist/, by kind and by largest asset, held
// against the default branch's baseline. Its command runs here against a git repo of its own, a fixture dist directory
// and a baseline file of its own: never this repo's .git or the dist/ a build here made.
import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmp } from './tmp.ts'

const D = await import('../scripts/checks/dist-budget.ts')

/** a fixture dist/ of files of exact sizes: numbers become that many bytes */
function fixture(files: Record<string, number>): string {
  const dir = tmp('dist-budget')
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'x'.repeat(bytes))
  }
  return dir
}

/** a reading and a baseline of one: names are hash-stripped, the exemption list is what the caller wants */
function world(files: Record<string, number>, exempt: string[] = []) {
  const dir = fixture(files)
  const snap = D.scan(dir)!
  return { dir, snap, base: { ...snap, commit: 'abc1234def', at: 1, exempt } as import('../scripts/checks/dist-budget.ts').Baseline }
}

describe('reading a dist', () => {
  test('the kinds, by extension: icons include the splash art; assets of another kind are just other', () => {
    expect(D.kindOf('assets/index-5tkGkQ0q.js')).toBe('js')
    expect(D.kindOf('assets/addon.mjs')).toBe('js')
    expect(D.kindOf('assets/index-3os4MLXW.css')).toBe('css')
    expect(D.kindOf('assets/InterVariable-DiVDrmQJ.woff2')).toBe('font')
    expect(D.kindOf('a.ttf')).toBe('font')
    expect(D.kindOf('a.otf')).toBe('font')
    expect(D.kindOf('a.eot')).toBe('font')
    expect(D.kindOf('a.wasm')).toBe('wasm')
    expect(D.kindOf('splash/440x956@3-light.png')).toBe('icon')
    expect(D.kindOf('icon.svg')).toBe('icon')
    expect(D.kindOf('favicon.ico')).toBe('icon')
    expect(D.kindOf('index.html')).toBe('other')
  })

  test('a vite content hash is stripped, so a rebuild is the same asset; a name without one is left alone', () => {
    expect(D.normalize('assets/index-5tkGkQ0q.js')).toBe('assets/index.js')
    expect(D.normalize('assets/InterVariable-Italic-FCBEiFp6.woff2')).toBe('assets/InterVariable-Italic.woff2')
    expect(D.normalize('assets/rolldown-runtime-WkwZ5CU-.js')).toBe('assets/rolldown-runtime.js')
    expect(D.normalize('index-5tkGkQ0q.js')).toBe('index.js')
    expect(D.normalize('index.html')).toBe('index.html')
    expect(D.normalize('splash/440x956@3-light.png')).toBe('splash/440x956@3-light.png')
  })

  test('the sums by kind, the hash-stripped names and the top ten, and the fonts already over the cap', () => {
    const files = {
      'assets/index-5tkGkQ0q.js': 100000,
      'assets/common-H5G8LlVI.js': 20000,
      'assets/InterVariable-DiVDrmQJ.woff2': 400000,
      'assets/index-3os4MLXW.css': 3000,
      'assets/app.wasm': 2000,
      'splash/440x956@3-light.png': 1000,
      'index.html': 500,
    }
    const s = D.scan(fixture(files))!
    expect(s.total).toBe(526500)
    expect(s.js).toBe(120000)
    expect(s.kinds).toEqual({ js: 120000, css: 3000, font: 400000, icon: 1000, wasm: 2000, other: 500 })
    expect(s.files['assets/index.js']).toBe(100000)
    expect(s.files['assets/InterVariable.woff2']).toBe(400000)
    expect(s.files['assets/index-5tkGkQ0q.js']).toBeUndefined()
    expect(s.top[0]).toEqual({ name: 'assets/InterVariable.woff2', bytes: 400000, kind: 'font' })
    expect(s.exempt).toEqual(['assets/InterVariable.woff2'])
    expect(D.scan(fixture({ 'a.js': 1, 'b.js': 1 }))!.top.map((a) => a.name)).toEqual(['a.js', 'b.js'])
    expect(D.scan(join(tmp('dist-budget-missing'), 'nothing'))).toBeNull()
  })

  test('bytes in words, the one-line note and the ten largest assets in a report', () => {
    expect([1, 1024, 400000, 2 * 1024 * 1024].map(D.fmt)).toEqual(['1 B', '1.0 KB', '390.6 KB', '2.00 MB'])
    const w = world({ 'assets/index-5tkGkQ0q.js': 120000, 'index.html': 500 })
    expect(D.summary(w.snap)).toBe('Dist budget: 117.2 KB JS of 117.7 KB total, 2 assets')
    const lines = D.report(w.snap).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('assets/index.js')
    expect(lines[0]).toContain('117.2 KB  js')
    expect(lines[1]).toContain('index.html')
    expect(D.report(world({ 'index.html': 5 }).snap)).toContain('index.html')
  })
})

describe('the ratchet', () => {
  test('total JS may grow by 1% or 5 KB, whichever is larger', () => {
    expect(D.slack(100000)).toBe(5120)
    expect(D.slack(1000000)).toBe(10000)
    const w = world({ 'assets/index-5tkGkQ0q.js': 100000 })
    expect(D.compare({ ...w.snap, files: { 'assets/index.js': 105000 }, js: 105000 }, w.base)).toEqual([])
    expect(D.compare({ ...w.snap, files: { 'assets/index.js': 105120 }, js: 105120 }, w.base)).toEqual([])
    const fell = D.compare({ ...w.snap, files: { 'assets/index.js': 110000 }, js: 110000 }, w.base)
    expect(fell).toHaveLength(1)
    expect(fell[0]).toContain('total JS')
    expect(fell[0]).toContain('+10000 bytes')
  })

  test('a new asset over the 300 KB cap fails outright with the asset and its size; old big assets stay', () => {
    const w = world({ 'assets/index-5tkGkQ0q.js': 100000, 'assets/xterm-BMsy1fDS.js': 330000, 'assets/InterVariable-DiVDrmQJ.woff2': 400000 }, ['assets/xterm.js', 'assets/InterVariable.woff2'])
    const big = (name: string, bytes: number) => ({ ...w.snap, js: w.snap.js + (name.endsWith('.js') ? bytes : 0), files: { ...w.snap.files, [name]: bytes } })
    // an asset the baseline already carried is grandfathered, even one over the cap; the exempt font stays exempt
    expect(D.compare(w.snap, w.base)).toEqual([])
    expect(D.compare(big('assets/newsmall.js', 4000), w.base)).toEqual([])
    const fell = D.compare(big('assets/newbig.js', 400000), w.base)
    expect(fell).toHaveLength(2) // the cap and the total JS growth
    expect(fell.some((f) => f.includes('new asset over the 300.0 KB cap: assets/newbig.js') && f.includes('400000 bytes'))).toBe(true)
    // a new font over the cap is not let in unless the baseline already exempted its name
    expect(D.compare(big('assets/Roboto.woff2', 400000), w.base).some((f) => f.includes('Roboto.woff2'))).toBe(true)
    expect(D.compare(big('assets/InterVariable.woff2', 400000), w.base).some((f) => f.includes('cap'))).toBe(false)
    // an asset that was under the cap at the baseline and grows past it is caught too, and named as not new
    const grown = D.compare(big('assets/index.js', 400000), w.base)
    expect(grown.some((f) => f.includes('asset over the 300.0 KB cap: assets/index.js') && !f.includes('new asset'))).toBe(true)
  })
})

describe('the command', () => {
  /** a fixture dist/ in a git repo of its own, committed clean, with a baseline file of its own */
  function worldOf(files: Record<string, number>, extra: (dir: string) => void = () => {}) {
    const repo = tmp('dist-budget-repo')
    const dir = join(repo, 'dist')
    mkdirSync(join(dir, 'assets'), { recursive: true })
    for (const [name, bytes] of Object.entries(files)) {
      const path = join(dir, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'x'.repeat(bytes))
    }
    extra(repo)
    execSync('git init -q -b main && git -c user.email=t@t -c user.name=T add -A && git -c user.email=t@t -c user.name=T commit -qm init', { cwd: repo, shell: '/bin/sh' })
    const baseline = join(tmp('dist-budget-base'), 'dist-budget.json')
    const said: string[] = []
    const main = (...args: string[]) => D.main(args, { repo, baseline, log: (x) => said.push(x) })
    return { repo, dir, baseline, said, main }
  }

  test('no dist, no folder: it says how to make one', () => {
    const w = worldOf({ 'index.html': 10 })
    expect(w.main(join(w.repo, 'none'))).toBe(2)
    expect(w.said.at(-1)).toContain('run bun run build first')
    // the default log, repo and baseline are the command's own when a caller names none
    expect(D.main([join(tmp('dist-budget-absent'), 'dist')])).toBe(2)
  })

  test('no baseline yet: it says the counts and compares nothing; --record keeps them for a clean tree only', () => {
    const w = worldOf({ 'assets/index-5tkGkQ0q.js': 100000, 'assets/InterVariable-DiVDrmQJ.woff2': 400000 })
    expect(w.main(w.dir)).toBe(0)
    expect(w.said[0]).toContain('Dist budget:')
    expect(w.said.some((s) => s.startsWith('No dist baseline yet: the check on the default branch records one'))).toBe(true)
    expect(w.said.join('\n')).toContain('The ten largest assets:')
    expect(w.said.join('\n')).toContain('assets/index.js')
    // a tree with what isn't committed records nothing: a baseline is a commit's
    writeFileSync(join(w.repo, 'loose.txt'), 'x\n')
    expect(w.main(w.dir, '--record')).toBe(0)
    expect(w.said.at(-1)).toContain('No dist baseline recorded')
    execSync('rm loose.txt', { cwd: w.repo, shell: '/bin/sh' })
    expect(w.main(w.dir, '--record')).toBe(0)
    expect(w.said.at(-1)).toMatch(/^Dist baseline of [0-9a-f]{7}: recorded in /)
    const base = JSON.parse(readFileSync(w.baseline, 'utf8'))
    expect(base.js).toBe(100000)
    expect(base.files).toEqual({ 'assets/index.js': 100000, 'assets/InterVariable.woff2': 400000 })
    expect(base.exempt).toEqual(['assets/InterVariable.woff2'])
    expect(base.top[0]).toEqual({ name: 'assets/InterVariable.woff2', bytes: 400000, kind: 'font' })
    expect(base.top.map((a: { name: string }) => a.name)).toContain('assets/index.js')
  })

  test('a baseline 10 KB smaller than the fixture dist fails with the delta named; a big new asset fails too', () => {
    const w = worldOf({ 'assets/index-5tkGkQ0q.js': 100000 }, (repo) => { writeFileSync(join(repo, '.gitignore'), 'dist/\n') })
    w.main(w.dir, '--record')
    expect(w.main(w.dir)).toBe(0)
    expect(w.said.at(-1)).toContain('Dist budget held')
    writeFileSync(join(w.dir, 'assets', 'index-5tkGkQ0q.js'), 'x'.repeat(110240))
    expect(w.main(w.dir)).toBe(1)
    expect(w.said.join('\n')).toMatch(/Dist budget grew since the baseline \([0-9a-f]{7}\)/)
    expect(w.said.join('\n')).toContain('total JS')
    expect(w.said.join('\n')).toContain('+10240 bytes')
    writeFileSync(join(w.dir, 'assets', 'newbig.js'), 'x'.repeat(400000))
    expect(w.main(w.dir)).toBe(1)
    expect(w.said.join('\n')).toContain('new asset over the 300.0 KB cap: assets/newbig.js')
  })

  test('where the baseline is kept: the repo\'s own .git, for every worktree; a broken one is none', () => {
    const w = worldOf({ 'index.html': 10 })
    expect(D.baselineFile(w.repo)).toBe(join(w.repo, '.git', 'shepherdr-test', 'dist-budget.json'))
    expect(D.baselineFile(tmp('dist-budget-no-git'))).toEndWith(join('node_modules', '.cache', 'shepherdr-test', 'dist-budget.json'))
    writeFileSync(w.baseline, 'not json')
    expect(D.readBaseline(w.baseline)).toBeNull()
    writeFileSync(w.baseline, JSON.stringify({ at: 1 }))
    expect(D.readBaseline(w.baseline)).toBeNull()
  })
})
