// The plugin build is a pure function of its inputs, so typecheck, tests and the build can share one write per run:
// scripts/build-plugins.ts keeps a hash of them in node_modules/.cache and skips a build whose inputs and outputs did
// not change. These tests drive writeRegistries on a fixture of its own, including the invalidation paths.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeRegistries } from '../scripts/build-plugins.ts'
import { tmp } from './tmp.ts'

function file(path: string, text = '') {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** a build with two base plugins, a nested file and a .git folder the hash must ignore, and no staged user plugins */
function fixture() {
  const dir = tmp('build-plugins-cache')
  file(join(dir, 'plugins.json'), JSON.stringify({ plugins: ['a', 'b'] }))
  file(join(dir, 'plugins', 'a', 'client.tsx'), 'export default a\n')
  file(join(dir, 'plugins', 'a', 'server.ts'), 'export default a\n')
  file(join(dir, 'plugins', 'a', 'nested', 'extra.ts'), 'nested\n')
  file(join(dir, 'plugins', 'a', '.git', 'config'), 'git\n')
  file(join(dir, 'plugins', 'b', 'client.tsx'), 'export default b\n')
  const cache = join(dir, 'node_modules', '.cache', 'build-plugins.json')
  const client = join(dir, 'generated', 'client-plugins.ts')
  const server = join(dir, 'generated', 'server-plugins.ts')
  return { dir, cache, client, server }
}

describe('the plugin build cache', () => {
  test('writes the registries once, then skips a run whose inputs did not change, byte for byte', () => {
    const f = fixture()
    expect(writeRegistries(f.dir)).toEqual(['a', 'b'])
    const before = { client: readFileSync(f.client, 'utf8'), server: readFileSync(f.server, 'utf8'), cache: readFileSync(f.cache, 'utf8') }
    const clientAt = statSync(f.client).mtimeMs
    const cacheAt = statSync(f.cache).mtimeMs
    expect(writeRegistries(f.dir)).toEqual(['a', 'b'])
    expect(readFileSync(f.client, 'utf8')).toBe(before.client)
    expect(readFileSync(f.server, 'utf8')).toBe(before.server)
    expect(readFileSync(f.cache, 'utf8')).toBe(before.cache)
    expect(statSync(f.client).mtimeMs, 'the registry was not written again').toBe(clientAt)
    expect(statSync(f.cache).mtimeMs, 'the cache was hit, not rewritten').toBe(cacheAt)
  })

  test('changed inputs rebuild: a plugin added to the list is in the registry', () => {
    const f = fixture()
    writeRegistries(f.dir)
    const first = readFileSync(f.cache, 'utf8')
    file(join(f.dir, 'plugins', 'c', 'client.tsx'), 'export default c\n')
    file(join(f.dir, 'plugins.json'), JSON.stringify({ plugins: ['a', 'b', 'c'] }))
    expect(writeRegistries(f.dir)).toEqual(['a', 'b', 'c'])
    expect(readFileSync(f.client, 'utf8')).toContain("../plugins/c/client.tsx")
    expect(readFileSync(f.cache, 'utf8')).not.toBe(first)
  })

  test('a registry deleted or edited by hand is written again even when the inputs did not change', () => {
    const f = fixture()
    writeRegistries(f.dir)
    const good = readFileSync(f.client, 'utf8')
    rmSync(f.client)
    expect(writeRegistries(f.dir)).toEqual(['a', 'b'])
    expect(readFileSync(f.client, 'utf8')).toBe(good)
    writeFileSync(f.client, 'edited by hand\n')
    expect(writeRegistries(f.dir)).toEqual(['a', 'b'])
    expect(readFileSync(f.client, 'utf8')).toBe(good)
  })

  test('a half-written or absent cache is a miss, and a fresh build makes it whole again', () => {
    const f = fixture()
    // absent on the first build: the reader's catch must not stand in the way
    expect(existsSync(f.cache)).toBe(false)
    writeRegistries(f.dir)
    expect(existsSync(f.cache)).toBe(true)
    writeFileSync(f.cache, '{not json')
    expect(writeRegistries(f.dir)).toEqual(['a', 'b'])
    expect(JSON.parse(readFileSync(f.cache, 'utf8')).names).toEqual(['a', 'b'])
  })

  test('staged user plugins and an off list are part of the inputs', () => {
    const f = fixture()
    file(join(f.dir, 'user-plugins.json'), JSON.stringify({ off: ['a'], broken: {} }))
    file(join(f.dir, 'user-plugins', 'mine', 'client.tsx'), 'export default mine\n')
    expect(writeRegistries(f.dir)).toEqual(['b', 'mine'])
    const client = readFileSync(f.client, 'utf8')
    expect(client).not.toContain('../plugins/a/')
    expect(client).toContain('../user-plugins/mine/client.tsx')
    const at = statSync(f.cache).mtimeMs
    expect(writeRegistries(f.dir)).toEqual(['b', 'mine'])
    expect(statSync(f.cache).mtimeMs, 'the second build is a hit').toBe(at)
  })
})
