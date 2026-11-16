// A real pre-push hook refusing a real push (#963, from upstream fbc8e8c1): its own words reach the agent that ran
// shepherdr pr / shepherdr merge and the task's own row, redacted, never another task's chat. Every harness runs
// these commands as a shell command and reads the one text and exit code server/cli.ts prints, so this one path is
// the same for Claude Code, Codex, pi, OpenCode and Antigravity; no reader treats any of them differently.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sh, repo, world, started } from './engine-world.ts'
import { tmp } from './tmp.ts'

setDefaultTimeout(60_000)

const ghBin = tmp('ghbin-hook')
writeFileSync(join(ghBin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, 'fake-gh.ts')}" "$@"\n`, { mode: 0o755 })

function onGitHub() {
  process.env.PATH = `${ghBin}:${process.env.PATH}`
  const bare = tmp('gh-origin-hook')
  sh('git init -q --bare -b main', bare)
  sh(`git push -q ${bare} main`, repo())
  const dir = tmp('gh-clone-hook')
  sh(`git clone -q ${bare} . && git config user.email t@t && git config user.name T && git remote set-url origin https://github.com/acme/app.git && git config url.${bare}.insteadOf https://github.com/acme/app.git`, dir)
  const file = join(tmp('gh-state-hook'), 'github.json')
  writeFileSync(file, JSON.stringify({ origin: bare, repo: 'acme/app', prs: [], calls: [], checks: [] }))
  process.env.FAKE_GH_STATE = file
  return { bare, dir }
}

/** a pre-push hook that refuses with its reason on one stream and the secret it found alongside it */
function refusingHook(wt: string, stream: 'stdout' | 'stderr' = 'stdout') {
  const to = stream === 'stderr' ? ' >&2' : ''
  const lines = [
    `echo 'gitleaks: 1 finding'${to}`,
    `echo '  File: src/config.ts:42'${to}`,
    `echo '  Secret: AKIAIOSFODNN7EXAMPLE'${to}`,
  ].join('\n')
  // a task works in a linked worktree: its .git is a file, and hooks come from the repo's common git dir
  const common = sh('git rev-parse --git-common-dir', wt)
  const hook = join(resolve(wt, common), 'hooks', 'pre-push')
  writeFileSync(hook, `#!/bin/sh\n${lines}\nexit 1\n`)
  chmodSync(hook, 0o755)
  return hook
}

test('a hook that refuses a push puts its own words in the agent output and the task row, redacted', async () => {
  const w = world()
  const g = onGitHub()
  const { t } = await started(w, g.dir, 'hooked')
  const other = await started(w, g.dir, 'bystander')
  writeFileSync(join(t.worktree!, 'work.txt'), 'work')
  sh('git add -A && git commit -qm work', t.worktree!)
  refusingHook(t.worktree!, 'stdout')

  const r = await w.engine.openPr(t.id)
  expect(r.ok).toBe(false)
  // what the agent running `shepherdr pr` reads: the finding, not a bare "hook failed"
  expect(r.text).toContain('gitleaks: 1 finding')
  expect(r.text).toContain('src/config.ts:42')
  expect(r.text).toContain('failed to push some refs')
  expect(r.text).not.toContain('AKIAIOSFODNN7EXAMPLE')
  // the task's own row says it too, without the secret
  expect(w.engine.subOf(t)).toContain('Could not push')
  expect(w.engine.subOf(t)).toContain('gitleaks')
  expect(w.engine.subOf(t)).not.toContain('AKIAIOSFODNN7EXAMPLE')
  // no other task's row or chat carries it
  expect(w.engine.subOf(other.t)).not.toContain('gitleaks')
  expect(w.sent.filter((s) => s.key !== `${t.id}/Agent`).map((s) => s.text).join()).not.toContain('gitleaks')
})

test('a hook that refuses on stderr reaches the merge caller and the agent, redacted', async () => {
  const w = world()
  const g = onGitHub()
  const { t } = await started(w, g.dir, 'hookmerge')
  writeFileSync(join(t.worktree!, 'work.txt'), 'work')
  sh('git add -A && git commit -qm work', t.worktree!)
  expect((await w.engine.openPr(t.id)).ok).toBe(true)
  // a fresh commit after the pull request opened: the merge has to push again, so the hook runs
  writeFileSync(join(t.worktree!, 'more.txt'), 'more')
  sh('git add -A && git commit -qm more', t.worktree!)
  await w.engine.done(t.id, 'Done.')
  refusingHook(t.worktree!, 'stderr')

  const r = await w.engine.merge(t.id, { self: true })
  expect(r.ok).toBe(false)
  // r.error is what `shepherdr merge` prints to the agent that ran it (source.ts mergeCommand throws it)
  expect(r.error).toContain('gitleaks: 1 finding')
  expect(r.error).toContain('src/config.ts:42')
  expect(r.error).not.toContain('AKIAIOSFODNN7EXAMPLE')
  expect(w.engine.subOf(t)).toContain('gitleaks')
  expect(w.engine.subOf(t)).not.toContain('AKIAIOSFODNN7EXAMPLE')
})

test('with the hook fixed the same push works again and the row stops saying it failed', async () => {
  const w = world()
  const g = onGitHub()
  const { t } = await started(w, g.dir, 'retry')
  writeFileSync(join(t.worktree!, 'work.txt'), 'work')
  sh('git add -A && git commit -qm work', t.worktree!)
  const hook = refusingHook(t.worktree!, 'stdout')
  expect((await w.engine.openPr(t.id)).ok).toBe(false)
  expect(w.engine.subOf(t)).toContain('Could not push')

  unlinkSync(hook)
  expect((await w.engine.openPr(t.id)).ok).toBe(true)
  expect(w.engine.subOf(t)).not.toContain('Could not push')
})
