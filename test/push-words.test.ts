// A failed push's own words (#963, from upstream fbc8e8c1): the hook's last lines, stdout included, end up in the
// agent's tool output and on the task's row. These are the words themselves, whatever stream git left them on.
import { expect, test } from 'bun:test'
import { pushWords, pushRefusal } from '../server/live/engine/git.ts'

const push = (out = '', err = '') => ({ ok: false, code: 1, out, err })

test('a hook that refuses on stdout: its own words reach the agent, stdout included', () => {
  const w = pushWords(push(
    'gitleaks: 1 finding\n  File: src/config.ts:42\n  Secret: AKIAIOSFODNN7EXAMPLE\n  use --no-verify to bypass',
    "error: failed to push some refs to 'origin'",
  ))
  expect(w).toContain('gitleaks: 1 finding')
  expect(w).toContain('src/config.ts:42')
  expect(w).toContain('failed to push some refs')
})

test('a hook that refuses on stderr is read too', () => {
  const w = pushWords(push('', 'lint: 3 errors in src/app.ts\nerror: failed to push some refs to origin'))
  expect(w).toContain('lint: 3 errors in src/app.ts')
  expect(w).toContain('failed to push some refs')
})

test('a refusal with no output still says the push failed', () => {
  const w = pushWords(push('', "error: failed to push some refs to 'origin'"))
  expect(w).toBe("error: failed to push some refs to 'origin'")
})

test('a push that failed another way keeps git\'s own message, with no hook claim', () => {
  const w = pushWords(push('', 'fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.'))
  expect(w).toBe('fatal: Could not read from remote repository.')
  expect(w).not.toContain('hook')
})

test('an auth failure on stdout is kept as git said it', () => {
  const w = pushWords(push('remote: Permission denied to user.\nfatal: unable to access the remote', ''))
  expect(w).toBe('remote: Permission denied to user.')
})

test('the refusal is shown to the agent and as one short line on the task row', () => {
  const { text, row } = pushRefusal('work/47-a-push-hook', push(
    'gitleaks: 1 finding\n  File: src/config.ts:42\n  Secret: AKIAIOSFODNN7EXAMPLE',
    "error: failed to push some refs to 'origin'",
  ))
  expect(text).toContain('gitleaks: 1 finding')
  expect(text).toContain('src/config.ts:42')
  expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE')
  expect(row).toBe('Could not push work/47-a-push-hook: gitleaks: 1 finding')
  expect(row).not.toContain('AKIAIOSFODNN7EXAMPLE')
})

test('a path a hook or git prints is not mistaken for a secret', () => {
  const w = pushWords(push('', "error: failed to push some refs to '/tmp/shep-gh-origin-hook-684391-684443-eFhlHy.git'"))
  expect(w).toContain('/tmp/shep-gh-origin-hook-684391-684443-eFhlHy.git')
  expect(w).not.toContain('[redacted]')
})

test('only the last few lines are kept, so a phone can read them', () => {
  const out = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  const w = pushWords(push(out, 'error: failed to push some refs to origin'))
  const lines = w.split('\n')
  expect(lines).toHaveLength(8)
  expect(lines.at(-1)).toBe('error: failed to push some refs to origin')
  expect(w).toContain('line 29')
  expect(w).not.toContain('line 0')
})

test('a secret a hook printed is redacted, but the file and line it names stay', () => {
  const w = pushWords(push(
    'gitleaks: AWS Access Key\n  File: src/config.ts:42\n  Secret: AKIAIOSFODNN7EXAMPLE\n  ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'error: failed to push some refs to origin',
  ))
  expect(w).toContain('src/config.ts:42')
  expect(w).not.toContain('AKIAIOSFODNN7EXAMPLE')
  expect(w).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  expect(w).toContain('[redacted]')
})
