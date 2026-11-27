// A space whose merges go through a pull request has no merge line to hold (engine.lineHold): it says so and holds nothing, and
// a GitHub that does not answer is told as it is, with nothing held either. GitHub is a stand-in (test/fake-gh.ts).
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repo, sh, world } from './engine-world.ts'
import { tmp } from './tmp.ts'

setDefaultTimeout(60_000)

const ghBin = tmp('hold-ghbin')
writeFileSync(join(ghBin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, 'fake-gh.ts')}" "$@"\n`, { mode: 0o755 })

/** a clone whose origin reads as GitHub's, with gh logged in (or down) */
function onGitHub(down = false) {
  process.env.PATH = `${ghBin}:${process.env.PATH}`
  const bare = tmp('hold-gh-origin')
  sh('git init -q --bare -b main', bare)
  sh(`git push -q ${bare} main`, repo())
  const dir = tmp('hold-gh-clone')
  const remote = 'https://github.com/acme/app.git'
  sh(`git clone -q ${bare} . && git config user.email t@t && git config user.name T && git remote set-url origin ${remote} && git config url.${bare}.insteadOf ${remote}`, dir)
  const file = join(tmp('hold-gh-state'), 'github.json')
  writeFileSync(file, JSON.stringify({ origin: bare, repo: 'acme/app', prs: [], calls: [], down }))
  process.env.FAKE_GH_STATE = file
  return dir
}

describe('holding the line of a space that merges through a pull request', () => {
  test('it says there is no line to hold, and nothing is held', async () => {
    const w = world()
    const p = await w.places.add(onGitHub(), 'hold-pr')
    const r = await w.engine.lineHold(p, { by: 'you (terminal)', why: 'land a fix' }, 600_000, 30_000)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toBe("hold-pr's merges go through a pull request on GitHub, so Shepherdr keeps no merge line there to hold: GitHub's own checks and queue are the line.")
    expect(w.engine.line(p).hold).toBeUndefined()
    // nothing was left stored, and the line is free to be asked again
    const file = join(process.env.SHEPHERDR_HOME ?? '', 'tasks.json')
    expect(existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).holds ?? {}) : {}).toEqual({})
    expect(w.engine.lineRelease(p, 'you')).toBeUndefined()
  })

  test("a GitHub that does not answer is told as it is, and nothing is held: it is not known whether the space's merges go through it", async () => {
    const w = world()
    const p = await w.places.add(onGitHub(true), 'hold-down')
    const r = await w.engine.lineHold(p, { by: 'you (terminal)', why: 'land a fix' }, 600_000, 30_000)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("gh can't reach GitHub now")
    expect(w.engine.line(p).hold).toBeUndefined()
  })
})
