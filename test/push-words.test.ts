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
  expect(lines).toHaveLength(12)
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

test('secrets in the shapes real scanners and git print are all redacted', () => {
  const w = pushWords(push(
    [
      'MY_API_KEY=abc123',
      'DB_PASSWORD: hunter2',
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'export STRIPE_SECRET=sk_live_abc123',
      'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'found: postgres://admin:hunter2@db.internal:5432/prod',
      'id_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop',
      "error: failed to push some refs to 'https://ghp_0123456789abcdefghijklmnopqrstuvwxyz@github.com/acme/app.git'",
    ].join('\n'), '',
  ))
  for (const secret of ['abc123', 'hunter2', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'sk_live_abc123', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'ghp_0123456789abcdefghijklmnopqrstuvwxyz'])
    expect(w).not.toContain(secret)
  expect(w).toContain('postgres://[redacted]@db.internal')
})

test('a commit sha and a gitleaks fingerprint keep their detail', () => {
  const w = pushWords(push(
    [
      'gitleaks: 1 finding',
      '  Fingerprint: src/config.ts:aws-access-token:42',
      '  Commit: 0123456789abcdef0123456789abcdef01234567',
      "error: failed to push some refs to 'origin'",
    ].join('\n'), '',
  ))
  expect(w).toContain('src/config.ts:aws-access-token:42')
  expect(w).toContain('0123456789abcdef0123456789abcdef01234567')
})

test('the headline survives a long hook, and the row names the finding', () => {
  const out = [
    'gitleaks: 2 findings',
    'Finding: AWS Access Key',
    'Description: Identified a pattern of characters that may indicate AWS credentials.',
    ...Array.from({ length: 12 }, (_, i) => `  pad ${i}`),
    '  File: src/config.ts:42',
    '  Secret: AKIAIOSFODNN7EXAMPLE',
  ].join('\n')
  const { text, row } = pushRefusal('work/47-hook', push(out, "error: failed to push some refs to 'origin'"))
  expect(text).toContain('gitleaks: 2 findings')
  expect(text).toContain('src/config.ts:42')
  expect(row).toBe('Could not push work/47-hook: gitleaks: 2 findings')
})

test('with gitleaks banner fields, the row names the file, not a metadata line', () => {
  const out = [
    'Finding: AWS Access Key',
    'RuleID: aws-access-token',
    'File: src/config.ts',
    'Line: 42',
    'Secret: AKIAIOSFODNN7EXAMPLE',
    "error: failed to push some refs to 'origin'",
  ].join('\n')
  const { row } = pushRefusal('work/47-hook', push(out, ''))
  expect(row).toBe('Could not push work/47-hook: Finding: AWS Access Key')
})

test('a labelled Authorization header does not leak its credential', () => {
  const w = pushWords(push(
    [
      'Authorization: Bearer abcd1234efgh',
      'Authorization: Basic dXNlcjpwYXNz',
      'Authorization: Token 0123456789abcdef',
      'Bearer wxyz1234ijkl',
    ].join('\n'), "error: failed to push some refs to 'origin'",
  ))
  for (const secret of ['abcd1234efgh', 'dXNlcjpwYXNz', '0123456789abcdef', 'wxyz1234ijkl']) expect(w).not.toContain(secret)
})

test('a quoted JSON label is redacted too', () => {
  const w = pushWords(push('{"client_secret":"abc123"}', "error: failed to push some refs to 'origin'"))
  expect(w).not.toContain('abc123')
  expect(w).toContain('client_secret')
})

test('a blank first stderr line does not swallow git\'s failure', () => {
  const w = pushWords(push('', '   \nfatal: unable to access the remote'))
  expect(w).toBe('fatal: unable to access the remote')
})

test('the row names the error line, not an npm hook banner', () => {
  const { row } = pushRefusal('work/47', push(
    '> app@1.0.0 lint\n12:7  error  Unexpected var  no-var', "error: failed to push some refs to 'origin'",
  ))
  expect(row).toContain('Unexpected var')
  expect(row).not.toContain('app@1.0.0')
})

test('a non-hook ref rejection keeps git\'s own words, with no hook claim', () => {
  const w = pushWords(push('', [
    'error: failed to push some refs to ../remote.git',
    'To ../remote.git',
    ' ! [rejected]        main -> main (non-fast-forward)',
    'hint: Updates were rejected because the tip of your current branch is behind',
  ].join('\n')))
  expect(w).toContain('non-fast-forward')
  expect(w).not.toContain('gitleaks')
  expect(w).not.toContain('hook')
  expect(pushRefusal('work/47', push('', w)).row).toContain('non-fast-forward')
})

test('a failure that is not a refusal still prefers git\'s stderr over hook chatter', () => {
  const w = pushWords(push('hook said hello', 'fatal: unable to access the remote'))
  expect(w).toBe('fatal: unable to access the remote')
})
