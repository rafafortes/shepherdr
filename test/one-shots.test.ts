// The two runs Shepherdr makes of a real CLI that are nobody's turn: the probe that asks a primary whether its provider
// answers again (return.ts probeHarness) and the advisor's read-only run (advisor.ts runAdvisor). Their own tests stub
// both; here each runs a CLI of its own on PATH, a shell script, so what they do with a real process is checked: its
// words and exit code, a hard timeout even when a grandchild keeps the pipes open, nothing of Shepherdr's in its
// environment, and the cases where nothing runs at all.
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const { probeHarness } = await import('../server/live/return.ts')
const { runAdvisor } = await import('../server/live/advisor.ts')

const bin = tmp('one-shots-bin')
const seen = join(tmp('one-shots-seen'), 'env')
/** a CLI by that name: what FAKE_MODE says it does, after writing down the environment it got */
for (const name of ['pi', 'claude']) {
  writeFileSync(
    join(bin, name),
    `#!/bin/sh
env > '${seen}'
cat > /dev/null
case "$FAKE_MODE" in
  ok) echo 'all good' ;;
  fail) echo 'some words' ; echo '402 Insufficient account funds' >&2 ; exit 3 ;;
  hang) exec sleep 30 ;;
  held) sleep 30 & exec sleep 30 ;;
esac
`,
  )
  chmodSync(join(bin, name), 0o755)
}
const path = process.env.PATH
const source = process.env.SHEPHERDR_SOURCE
process.env.PATH = `${bin}:${path}`
afterAll(() => {
  process.env.PATH = path
  if (source === undefined) delete process.env.SHEPHERDR_SOURCE
  else process.env.SHEPHERDR_SOURCE = source
})
const mode = (m: string) => (process.env.FAKE_MODE = m)

describe("the primary's probe (probeHarness)", () => {
  test('its words and exit code; nothing of Shepherdr or herdr in its environment', async () => {
    mode('ok')
    process.env.SHEPHERDR_CHAT = 'X-1/Agent'
    process.env.HERDR_PANE_ID = 'w1:p1'
    expect(await probeHarness({ kind: 'pi' })).toEqual({ ok: true, said: 'all good' })
    const env = readFileSync(seen, 'utf8')
    expect(env).not.toContain('SHEPHERDR_CHAT')
    expect(env).not.toContain('HERDR_PANE_ID')
    delete process.env.SHEPHERDR_CHAT
    delete process.env.HERDR_PANE_ID
    mode('fail')
    expect(await probeHarness({ kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })).toEqual({ ok: false, said: 'some words 402 Insufficient account funds' })
  })

  test('a hard timeout: one that hangs is killed; one whose grandchild holds its pipes is given up on', async () => {
    mode('hang')
    expect((await probeHarness({ kind: 'pi' }, 200)).ok).toBe(false)
    mode('held')
    const at = Date.now()
    expect(await probeHarness({ kind: 'pi' }, 200)).toEqual({ ok: false, said: 'timed out' })
    expect(Date.now() - at).toBeLessThan(5_000)
  }, 15_000)

  test("a CLI that can't start (its interpreter is gone) is a failed probe, said so", async () => {
    const broken = tmp('one-shots-broken')
    writeFileSync(join(broken, 'codex'), '#!/nonexistent/interpreter\n')
    chmodSync(join(broken, 'codex'), 0o755)
    process.env.PATH = `${broken}:${path}`
    const r = await probeHarness({ kind: 'codex' })
    process.env.PATH = `${bin}:${path}`
    expect(r.ok).toBe(false)
    expect(r.said).not.toBe('')
  })

  test('one that cannot even be started (its folder is gone) is a failed probe with the reason', async () => {
    mode('ok')
    const tmpdir = process.env.TMPDIR
    process.env.TMPDIR = join(tmp('one-shots-tmp'), 'gone')
    const r = await probeHarness({ kind: 'pi' })
    if (tmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = tmpdir
    expect(r.ok).toBe(false)
    expect(r.said).not.toBe('')
  })

  test('nothing runs: a CLI with no silent one-shot, one not installed, or the demo world', async () => {
    expect(await probeHarness({ kind: 'gemini' })).toEqual({ ok: false, said: 'no silent one-shot for gemini' })
    process.env.PATH = path
    const missing = await probeHarness({ kind: 'codex' })
    process.env.PATH = `${bin}:${path}`
    expect(missing.ok).toBe(false)
    process.env.SHEPHERDR_SOURCE = 'demo'
    expect(await probeHarness({ kind: 'pi' })).toEqual({ ok: false, said: 'the demo world never probes' })
    delete process.env.SHEPHERDR_SOURCE
  })
})

describe("the advisor's run (runAdvisor)", () => {
  test('its words where it ends well; its last words with its errors where it does not; in the folder of the work', async () => {
    const cwd = tmp('one-shots-work')
    mode('ok')
    expect(await runAdvisor({ kind: 'pi' }, 'Which store?', cwd)).toEqual({ ok: true, out: 'all good\n' })
    expect(readFileSync(seen, 'utf8')).toContain(`PWD=${cwd}`)
    mode('fail')
    expect(await runAdvisor({ kind: 'claude' }, 'Which store?', cwd)).toEqual({ ok: false, out: 'some words\n402 Insufficient account funds\n' })
  })

  test('a hard timeout over the whole call, even with its pipes held open', async () => {
    const cwd = tmp('one-shots-work')
    mode('hang')
    expect((await runAdvisor({ kind: 'pi' }, 'Which?', cwd, 200)).ok).toBe(false)
    mode('held')
    expect(await runAdvisor({ kind: 'pi' }, 'Which?', cwd, 200)).toEqual({ ok: false, out: 'timed out' })
  }, 15_000)

  test('nothing runs: a CLI it has no run for, one not installed, a folder that is not there, or the demo world', async () => {
    expect(await runAdvisor({ kind: 'gemini' }, 'x', tmp('one-shots-work'))).toEqual({ ok: false, out: 'no advisor run for gemini' })
    process.env.PATH = path
    const missing = await runAdvisor({ kind: 'codex' }, 'x', tmp('one-shots-work'))
    process.env.PATH = `${bin}:${path}`
    expect(missing.ok).toBe(false)
    mode('ok')
    const gone = join(tmp('one-shots-work'), 'not-there')
    expect((await runAdvisor({ kind: 'pi' }, 'x', gone)).ok).toBe(false)
    process.env.SHEPHERDR_SOURCE = 'demo'
    expect(await runAdvisor({ kind: 'pi' }, 'x', tmp('one-shots-work'))).toEqual({ ok: false, out: 'the demo world has no advisor' })
    delete process.env.SHEPHERDR_SOURCE
  })
})
