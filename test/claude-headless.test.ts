// A Claude Code on the API key login runs headless (server/live/headless.ts): a runner in its pane takes each message as
// one `claude -p` turn on the same session. A fake claude only: no real Claude Code, key or Anthropic request here.
import { afterAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const H = await import('../server/live/headless.ts')
const { Agents } = await import('../server/live/agents.ts')

const ROOT = join(import.meta.dir, '..')
const runners: ChildProcess[] = []
afterAll(() => {
  for (const r of runners) r.kill('SIGTERM')
})

/** a fake claude: it notes its arguments and the prompt it got on stdin, starts the session's log, says one line in
 *  claude's stream format, and sleeps first when the prompt asks it to */
function fakeClaude(dir: string) {
  const bin = join(dir, 'claude')
  writeFileSync(
    bin,
    `#!/bin/sh
prompt=$(cat)
printf '%s\\n' "$*" >> "$FAKE_CALLS"
printf '%s\\n' "$prompt" >> "$FAKE_PROMPTS"
case "$prompt" in *sleep*) sleep 30 ;; *fail*) echo "Credit balance is too low" >&2; exit 1 ;; esac
touch "$FAKE_LOG"
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"done: '"$prompt"'"}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"duration_ms":10,"total_cost_usd":0.001}'
`,
  )
  chmodSync(bin, 0o755)
  return bin
}

async function until(f: () => boolean, ms = 10_000) {
  for (const end = Date.now() + ms; !f(); ) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

function startRunner(name: string) {
  const dir = tmp('headless-fake')
  const log = join(dir, 'session.jsonl')
  const calls = join(dir, 'calls.txt')
  const prompts = join(dir, 'prompts.txt')
  H.writeSpec(name, { claude: fakeClaude(dir), args: ['--settings', '/x.json', '--permission-mode', 'auto'], sessionId: '11111111-2222-3333-4444-555555555555', log, cwd: dir, env: { FAKE_LOG: log, FAKE_CALLS: calls, FAKE_PROMPTS: prompts } })
  const out: string[] = []
  const p = spawn(process.execPath, [join(ROOT, 'scripts', 'claude-headless.ts'), H.headlessDir(name)], { stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout!.on('data', (d: Buffer) => out.push(d.toString()))
  runners.push(p)
  return { p, log, calls, prompts, out }
}

describe('the headless runner', () => {
  test('takes each message as one claude -p turn: the session started the first time, resumed after', async () => {
    const r = startRunner('shep-headless-a')
    await until(() => !!H.readState('shep-headless-a'))
    H.writeInbox('shep-headless-a', 'first message')
    H.writeInbox('shep-headless-a', 'second\nline two')
    await until(() => H.readState('shep-headless-a')?.turns === 2 && !H.readState('shep-headless-a')?.working)
    const calls = readFileSync(r.calls, 'utf8').trim().split('\n')
    expect(calls[0]).toStartWith('-p --session-id 11111111-2222-3333-4444-555555555555 --settings /x.json --permission-mode auto --output-format stream-json --verbose')
    expect(calls[1]).toStartWith('-p --resume 11111111-2222-3333-4444-555555555555 ')
    // in order, whole, through stdin: a long or many-line message is never an argument
    expect(readFileSync(r.prompts, 'utf8')).toBe('first message\nsecond\nline two\n')
    expect(H.inboxCount('shep-headless-a')).toBe(0)
    // the pane shows the turn: what was asked, what it said, that it ended
    const shown = r.out.join('')
    expect(shown).toContain('› first message')
    expect(shown).toContain('done: first message')
    expect(shown).toContain('turn done')
  })

  test('an interrupt stops the turn under way, not the runner', async () => {
    const r = startRunner('shep-headless-b')
    await until(() => !!H.readState('shep-headless-b'))
    H.writeInbox('shep-headless-b', 'please sleep')
    await until(() => !!H.readState('shep-headless-b')?.working && !!H.readState('shep-headless-b')?.child)
    expect(H.interruptTurn('shep-headless-b')).toBe(true)
    await until(() => H.readState('shep-headless-b')?.working === false)
    expect(r.out.join('')).toContain('interrupted')
    // still there for the next message
    H.writeInbox('shep-headless-b', 'again')
    await until(() => H.readState('shep-headless-b')?.turns === 2)
    expect(existsSync(r.log)).toBe(true)
  })

  test('is gone once its process ends: nothing says it lives', async () => {
    const r = startRunner('shep-headless-c')
    await until(() => !!H.readState('shep-headless-c'))
    r.p.kill('SIGTERM')
    await until(() => !H.readState('shep-headless-c'))
    expect(H.interruptTurn('shep-headless-c')).toBe(false)
  })
})

describe('an agent on the API key login', () => {
  test("claude's session arguments are the runner's to choose", () => {
    expect(H.withoutSession(['--resume', 'abc', '--settings', 's.json', '--session-id', 'x', '--model', 'm'])).toEqual(['--settings', 's.json', '--model', 'm'])
  })

  test('is listed as a live Claude Code while its runner lives, working while a message waits, and what it is sent goes to its inbox', async () => {
    startRunner('shep-headless-d')
    await until(() => !!H.readState('shep-headless-d'))
    const a = new Agents()
    try {
      const rec = { key: 'p:one:d', name: 'shep-headless-d', kind: 'claude', cwd: '/unused', workspace: 'w', logs: [], started: 0, headless: true, lastPane: 'w1:p1', sessionId: '11111111-2222-3333-4444-555555555555' }
      ;(a as any).records[rec.key] = rec
      ;(a as any).byName.set(rec.name, rec.key)
      ;(a as any).listHeadless()
      expect(a.info(rec.key)).toMatchObject({ name: 'shep-headless-d', agent: 'claude', agent_status: 'idle', pane_id: 'w1:p1', agent_session: { kind: 'id', value: rec.sessionId } })
      await (a as any).put(rec.key, { id: 'x', key: rec.key, text: 'from the chat', at: Date.now() })
      await until(() => H.readState('shep-headless-d')?.turns === 1)
      // a finished one is not listed, so its chat reads it as gone and a message to it starts it again
      ;(a as any).live = new Map()
      ;(rec as any).finished = true
      ;(a as any).listHeadless()
      expect(a.info(rec.key)).toBeUndefined()
    } finally {
      a.stop()
    }
  })

  test("reads its state from the runner, not its hooks, and says a failed turn in claude's words", async () => {
    startRunner('shep-headless-f')
    await until(() => !!H.readState('shep-headless-f'))
    const a = new Agents()
    const failed: string[] = []
    a.on('turnFailed', (_k, why) => failed.push(why))
    try {
      const rec = { key: 'p:one:f', name: 'shep-headless-f', kind: 'claude', cwd: '/unused', workspace: 'w', logs: [], started: 0, headless: true, lastPane: 'w1:p2', sessionId: '11111111-2222-3333-4444-555555555555' }
      ;(a as any).records[rec.key] = rec
      ;(a as any).listHeadless()
      // a claude -p run's own session start and end say nothing of the agent: idle while the runner waits
      ;(a as any).said = () => ({ state: 'working', at: Date.now() })
      expect(a.status(rec.key)).toBe('idle')
      ;(a as any).said = () => ({ state: 'idle', at: Date.now(), helper: true })
      expect(a.status(rec.key)).toBe('blocked')
      ;(a as any).said = () => undefined
      H.writeInbox('shep-headless-f', 'please fail')
      await until(() => H.readState('shep-headless-f')?.turns === 1 && !H.readState('shep-headless-f')?.working)
      ;(a as any).live = new Map()
      ;(a as any).listHeadless()
      expect(failed).toEqual(['Credit balance is too low'])
      // said once: the next look has nothing new
      ;(a as any).live = new Map()
      ;(a as any).listHeadless()
      expect(failed.length).toBe(1)
    } finally {
      a.stop()
    }
  })

  test('a slash command is refused, not sent as a message', async () => {
    startRunner('shep-headless-g')
    await until(() => !!H.readState('shep-headless-g'))
    const a = new Agents()
    try {
      const rec = { key: 'p:one:g', name: 'shep-headless-g', kind: 'claude', cwd: '/unused', workspace: 'w', logs: [], started: 0, headless: true }
      ;(a as any).records[rec.key] = rec
      await expect((a as any).put(rec.key, { id: 'z', key: rec.key, text: '/clear', command: true, at: Date.now() })).rejects.toThrow(/headless/)
      expect(H.inboxCount('shep-headless-g')).toBe(0)
    } finally {
      a.stop()
    }
  })

  test('a message to a headless agent whose runner is gone waits for it to start again', async () => {
    const a = new Agents()
    try {
      const rec = { key: 'p:one:e', name: 'shep-headless-gone', kind: 'claude', cwd: '/unused', workspace: 'w', logs: [], started: 0, headless: true }
      ;(a as any).records[rec.key] = rec
      await expect((a as any).put(rec.key, { id: 'y', key: rec.key, text: 'hi', at: Date.now() })).rejects.toMatchObject({ code: 'agent_not_running' })
    } finally {
      a.stop()
    }
  })
})
