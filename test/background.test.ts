// Background work that outlives an agent's turn (readers/background.ts): Claude Code's session file and its screen, on
// samples captured from real panes and session files (Claude Code 2.1.310).
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('bg')
process.env.CLAUDE_CONFIG_DIR = tmp('bg-claude')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'herdr.sock')
const { agyScreenBackground, ClaudeSessions, Procs, headless, screenBackground, servesCommand, sessionBackground, shellCommand } = await import('../server/live/readers/background.ts')
const { Agents } = await import('../server/live/agents.ts')
const { writeJson } = await import('../server/store.ts')
const { record } = await import('../server/live/readers/hooks.ts')

const BOX = '─'.repeat(130)

/** what a test waits for has come true, however slow the machine: the pane reads a look at herdr sets going land after it */
const until = async (f: () => boolean, ms = 8000) => {
  for (const t0 = Date.now(); !f(); await Bun.sleep(20)) if (Date.now() - t0 > ms) throw new Error('timed out')
}
const screen = (above: string[], footer: string, rows: string[] = [], prompt = '❯ ') => [...above, '', BOX, prompt, BOX, footer, '', ...rows].join('\n')

/** SHE-59: it ended its turn while its fresh-eyes reviewer ran, and the reviewer's own probe (a shell and a monitor) */
const REVIEWER = screen(
  ['✻ Sautéed for 19m 18s · done 10:04 PM · 1 shell, 1 monitor still running'],
  '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · ← 4 agents · ↓ to manage',
  ['  ● main', '  ◯ general-purpose  Waiting on Bun fetch timeout probe                                                         3m 14s · ↓ 104.7k tokens'],
  '❯ ok, merge when the review\'s done',
)

/** it launched a background agent and ended its turn at once */
const WAITING_AGENT = screen(
  ['● Agent(Run python sleep 100 and reply ok)', '  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)', '', '● waiting', '', '✻ Waiting for 1 background agent to finish'],
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 4 agents · ↓ to manage',
  ['  ● main', '  ◯ general-purpose  Run python sleep 100 and reply ok                                                                                    29s · ↓ 29.3k tokens'],
)

/** the agent finished, woke it, and it answered: the old waiting line is still up in the scrollback */
const WOKE_AND_DONE = screen(
  ['✻ Waiting for 1 background agent to finish', '', '● Agent "Run python sleep 100 and reply ok" finished · 1m 43s', '', '● The agent finished and replied "ok."', '', '✻ Brewed for 1m 46s · done 10:13 PM'],
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · /tasks to see subagents · ← 4 agents',
)

/** SHE-54: three test runs in background shells */
const SHELLS = screen(
  ['● Waiting on three full test runs to rule out a flaky test.', '', '✻ Baked for 42m 58s · done 10:06 PM · 2 shells still running'],
  '  ⏵⏵ bypass permissions on · 2 shells · ← 4 agents · ↓ to manage',
)

const MONITOR = screen(['  ⎿  Monitor started · task b7csavm37 · timeout 60s', '', '● waiting', '', '✻ Crunched for 3s · done 10:14 PM · 1 monitor still running'], '  ⏵⏵ bypass permissions on · 1 monitor · ← 4 agents · ↓ to manage')

/** SHE-63: its turn ended with a question and nothing in the background */
const NOTHING = screen(
  ['  writing them each time. That way they\'re never forgotten and always match Settings.', '', '✻ Sautéed for 5m 24s · done 10:06 PM'],
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 4 agents',
  [],
  '❯ Yes, build it',
)

/** agy's screen: its input box between two rules, its footer below, and its rows of background commands below that */
const AGY_RULE = '─'.repeat(78)
const agyScreen = (rows: string[], footer: string) => ['', AGY_RULE, '>', AGY_RULE, ...rows, footer].join('\n')
const AGY_FOOT = '? for shortcuts                                         Gemini 4 Hydrogen · high'
const AGY_TASKS = '? for shortcuts                                         Gemini 4 Hydrogen · high · 2 task(s) · /tasks'
const AGY_ROWS = [
  '  ● [06:57:43] SHEPHERDR_CHAT="WEB-108/Agent" /home/…/bin/shepherdr review WEB-108 running',
  '  ● [06:57:31] git add CLAUDE.md && git commit --amend --no-edit && … running',
]
/** the agent's turn ended, and a test run of its own runs in the background (its row cut at the screen's width) */
const AGY_RUNNING = agyScreen([AGY_ROWS[0], AGY_ROWS[1].replace(' running', '')], AGY_TASKS)
const AGY_IDLE = agyScreen([], AGY_FOOT)
/** as agy draws it live: the rows between the input box and another rule above the footer */
const AGY_LIVE = ['', AGY_RULE, '>', AGY_RULE, ...AGY_ROWS, AGY_RULE, AGY_FOOT].join('\n')

describe("agy's screen", () => {
  test('background commands: a task count in its footer, or a row of one below its input box', () => {
    expect(agyScreenBackground(AGY_RUNNING)).toBe('shells')
    // the live layout, its footer without a count: the rows between the box and the footer's rule still count
    expect(agyScreenBackground(AGY_LIVE)).toBe('shells')
    // a screen whose box has no rule above its prompt line has no input box to read rows under
    expect(agyScreenBackground(['', '>', AGY_RULE, AGY_RULE, ...AGY_ROWS, AGY_FOOT].join('\n'))).toBeUndefined()
    expect(agyScreenBackground(agyScreen([], AGY_TASKS))).toBe('shells')
    expect(agyScreenBackground(agyScreen([AGY_ROWS[1]], AGY_FOOT))).toBe('shells')
  })

  test('nothing in the background: a plain footer, a count of 0, a row above the input box, or no input box at all', () => {
    expect(agyScreenBackground(AGY_IDLE)).toBeUndefined()
    expect(agyScreenBackground(agyScreen([], AGY_FOOT.replace('high', 'high · 0 task(s)')))).toBeUndefined()
    expect(agyScreenBackground(['', AGY_ROWS[0], AGY_RULE, '>', AGY_RULE, AGY_FOOT].join('\n'))).toBeUndefined()
    expect(agyScreenBackground([...AGY_ROWS, AGY_TASKS].join('\n'))).toBeUndefined()
    expect(agyScreenBackground('')).toBeUndefined()
  })
})

describe("Claude Code's screen", () => {
  test('a subagent still running is background work, with or without shells of its own', () => {
    expect(screenBackground(REVIEWER)).toBe('agents')
    expect(screenBackground(WAITING_AGENT)).toBe('agents')
  })

  test('shells and monitors alone are background work too', () => {
    expect(screenBackground(SHELLS)).toBe('shells')
    expect(screenBackground(MONITOR)).toBe('shells')
  })

  test('nothing in the background: nothing, even with an old waiting line in the scrollback', () => {
    expect(screenBackground(NOTHING)).toBeUndefined()
    expect(screenBackground(WOKE_AND_DONE)).toBeUndefined()
    expect(screenBackground('')).toBeUndefined()
    // "← 4 agents" is the footer's way to the agent list, not agents at work
    expect(screenBackground(screen(['✻ Done'], '  ⏵⏵ bypass permissions on · ← 4 agents'))).toBeUndefined()
  })
})

describe("Claude Code's session file", () => {
  test('busy while a background agent runs, shell while only shells or monitors do', () => {
    expect(sessionBackground('busy')).toBe('agents')
    expect(sessionBackground('shell')).toBe('shells')
    expect(sessionBackground('idle')).toBeUndefined()
    expect(sessionBackground('waiting')).toBeUndefined()
    expect(sessionBackground(undefined)).toBeUndefined()
  })

  test('found by its session id, else by its folder; one whose process is gone is none', () => {
    const dir = tmp('sessions')
    try {
      const file = (pid: number, o: object) =>
        writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, version: '2.1.310', peerProtocol: 1, kind: 'interactive', entrypoint: 'cli', name: 'work-59', ...o }))
      const me = process.pid
      // as captured from SHE-59 after its turn ended while its reviewer ran
      file(me, { sessionId: '764b1ad0-5551-4161-a30e-3706eb3321bc', cwd: '/w/59', status: 'busy', updatedAt: 1792966090908, statusUpdatedAt: 1792966090908 })
      // a process that is gone: its file is left over
      file(2 ** 22 + 7, { sessionId: 'old', cwd: '/w/60', status: 'busy', updatedAt: 1 })
      // another agent, in its own folder, with only a monitor left running
      writeFileSync(join(dir, '1.json'), JSON.stringify({ pid: process.ppid, sessionId: 'she-61', cwd: '/w/61', kind: 'interactive', status: 'shell', updatedAt: 5 }))
      let now = 1_000_000
      const s = new ClaudeSessions(() => dir)
      expect(s.status('764b1ad0-5551-4161-a30e-3706eb3321bc', '/elsewhere', now)).toBe('busy')
      // one look through the folder finds every agent's file
      expect(s.status('she-61', '/w/61', now)).toBe('shell')
      expect(s.status('resumed-under-a-new-id', '/w/59', (now += 10_000))).toBe('busy')
      expect(s.status('old', '/w/60', (now += 10_000))).toBeUndefined()
      // a live pid that started at another time is a new process that got a dead Claude Code's pid
      file(process.ppid, { sessionId: 'reused', cwd: '/w/62', status: 'busy', procStart: '1' })
      expect(s.status('reused', '/w/62', (now += 10_000))).toBeUndefined()
      // what it says now, once it is no longer fresh
      file(me, { sessionId: '764b1ad0-5551-4161-a30e-3706eb3321bc', cwd: '/w/59', status: 'idle', updatedAt: 1792966200000 })
      expect(s.status('764b1ad0-5551-4161-a30e-3706eb3321bc', '/w/59', (now += 2000))).toBe('idle')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('an agent whose turn ended', () => {
  // herdr, standing in: two Claude Code agents whose turns ended; the second has no session file, only its screen; an
  // agy, an OpenCode, a Codex and a pi agent, each with its turn over
  const screens: Record<string, string> = { p1: NOTHING, p2: REVIEWER, p3: AGY_IDLE }
  const server = createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      const { id, method, params } = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      const agent = (name: string, pane_id: string, kind = 'claude') => ({ agent: kind, agent_status: 'done', name, pane_id, tab_id: 't', workspace_id: 'w', cwd: null, interactive_ready: true })
      const result =
        method === 'agent.list'
          ? { agents: [agent('shep-t-1', 'p1'), agent('shep-t-2', 'p2'), agent('shep-t-3', 'p3', 'agy'), agent('shep-t-4', 'p4', 'opencode'), agent('shep-t-5', 'p5', 'codex'), agent('shep-t-6', 'p6', 'pi')] }
          : method === 'pane.read'
            ? { read: { text: screens[params.pane_id] ?? '' } }
            : {}
      c.end(`${JSON.stringify({ id, result })}\n`)
    })
  }).listen(process.env.HERDR_SOCKET_PATH)
  afterAll(() => server.close())

  const sessions = join(process.env.CLAUDE_CONFIG_DIR!, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const session = (status: string) => writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: '/w/1', kind: 'interactive', status, updatedAt: Date.now() }))
  const rec = (key: string, name: string, cwd: string, sessionId: string) => ({ key, name, kind: 'claude', cwd, workspace: 'w', logs: [], sessionId, started: 0 })
  writeJson('agents.json', {
    'T-1/Agent': rec('T-1/Agent', 'shep-t-1', '/w/1', 's1'),
    'T-2/Agent': rec('T-2/Agent', 'shep-t-2', '/w/2', 's2'),
    'T-3/Agent': { key: 'T-3/Agent', name: 'shep-t-3', kind: 'agy', cwd: '/w/3', workspace: 'w', logs: [], started: 0 },
    'T-4/Agent': { key: 'T-4/Agent', name: 'shep-t-4', kind: 'opencode', cwd: '/w/4', workspace: 'w', logs: [], sessionId: 'ses_4', started: 0 },
    'T-5/Agent': { key: 'T-5/Agent', name: 'shep-t-5', kind: 'codex', cwd: '/w/5', workspace: 'w', logs: [], started: 0 },
    'T-6/Agent': { key: 'T-6/Agent', name: 'shep-t-6', kind: 'pi', cwd: '/w/6', workspace: 'w', logs: [], started: 0 },
  })

  test('its session file says what still runs, else its screen; a change is told as a status change', async () => {
    session('busy')
    const a = new Agents()
    const told: string[] = []
    a.on('status', (key) => told.push(key))
    await a.refresh()
    // the pane reads (its screen) are made after the look at herdr, so health checks never wait on them
    await until(() => a.background('T-2/Agent') === 'agents')
    expect(a.background('T-1/Agent')).toBe('agents')
    expect(a.background('T-2/Agent')).toBe('agents')
    // the reviewer finished, woke it, and it stopped again in between herdr's looks: told, though herdr saw nothing
    told.length = 0
    session('idle')
    a.sessions = new ClaudeSessions()
    screens.p2 = WOKE_AND_DONE
    await a.refresh()
    await until(() => told.length === 2)
    expect(a.background('T-1/Agent')).toBeUndefined()
    expect(a.background('T-2/Agent')).toBeUndefined()
    expect(told.sort()).toEqual(['T-1/Agent', 'T-2/Agent'])
    a.stop()
  })

  test("agy: the background commands on its screen keep it at work, as Claude Code's shells do; once they are gone it needs you", async () => {
    screens.p3 = AGY_RUNNING
    const a = new Agents()
    const told: string[] = []
    a.on('status', (key) => told.push(key))
    await a.refresh()
    await until(() => a.background('T-3/Agent') === 'shells')
    expect(told).toContain('T-3/Agent')
    // its commands ended: its screen is plain again, and it is told
    told.length = 0
    screens.p3 = AGY_IDLE
    await a.refresh()
    await until(() => told.includes('T-3/Agent'))
    expect(a.background('T-3/Agent')).toBeUndefined()
    a.stop()
  })

  // SHE-53: OpenCode keeps its background shells under a pty daemon of its own, each a shell carrying the chat's
  // SHEPHERDR_CHAT, and its footer counts them ("↓ 1 shell"); it wakes the agent when one ends
  const proc = tmp('proc-opencode')
  const DAEMON = 4242
  /** its pty daemon: a child of its server, as `/proc` shows one */
  const ptyDaemon = () => {
    mkdirSync(join(proc, String(DAEMON)), { recursive: true })
    writeFileSync(join(proc, String(DAEMON), 'cmdline'), `${['/home/u/.cache/opencode/bin/opencode-pty/0.5.2-bc9cb0fa/opencode-pty', 'daemon', '--runtime-dir', '/home/u/.local/state/opencode/pty'].join('\0')}\0`)
    writeFileSync(join(proc, String(DAEMON), 'environ'), 'HOME=/h\0')
    writeFileSync(join(proc, String(DAEMON), 'stat'), `${DAEMON} (opencode-pty) S 1 0 0 0\n`)
  }
  /** a process as `/proc/<pid>` keeps one: its command line, its environment, its parent */
  const process_ = (pid: number, argv: string[], env: string[] = [], ppid = DAEMON) => {
    mkdirSync(join(proc, String(pid)), { recursive: true })
    writeFileSync(join(proc, String(pid), 'cmdline'), `${argv.join('\0')}\0`)
    writeFileSync(join(proc, String(pid), 'environ'), `${env.join('\0')}\0`)
    writeFileSync(join(proc, String(pid), 'stat'), `${pid} (${argv[0]?.split('/').at(-1) ?? 'x'}) S ${ppid} 0 0 0\n`)
  }

  test('OpenCode: a shell its pty daemon still runs keeps it at work; one that serves is a server, and none at all is needs you', async () => {
    ptyDaemon()
    process_(91, ['/bin/bash', '-c', 'cd /w/4 && tools/changed-check.sh --fast 2>&1 | tail -12'], ['HOME=/h', 'SHEPHERDR_CHAT=T-4/Agent'])
    const a = new Agents()
    a.procs = new Procs(proc)
    const told: string[] = []
    a.on('status', (key) => told.push(key))
    await a.refresh()
    await until(() => a.background('T-4/Agent') === 'shells')
    expect(told).toContain('T-4/Agent')
    // the count of how long shells alone keep it at work starts at the pass that read them
    await until(() => (a as unknown as { seen: Map<string, unknown> }).seen.has('T-4/Agent'))
    // a check that hangs is still a shell that ends and wakes it, but not for ever
    expect(a.background('T-4/Agent', Date.now() + a.shellsFor + 1)).toBeUndefined()
    // a dev server it left for you to look at never wakes it: only so long
    process_(91, ['/bin/bash', '-c', 'bun run dev --port 5173'], ['HOME=/h', 'SHEPHERDR_CHAT=T-4/Agent'])
    a.procs = new Procs(proc)
    await a.refresh()
    await until(() => a.background('T-4/Agent') === 'servers')
    await until(() => (a as unknown as { seen: Map<string, { what: string }> }).seen.get('T-4/Agent')?.what === 'servers')
    expect(a.background('T-4/Agent', Date.now() + a.serversFor + 1)).toBeUndefined()
    // it ended and woke the agent, which stopped again with nothing in the background: it needs you
    rmSync(join(proc, '91'), { recursive: true })
    a.procs = new Procs(proc)
    told.length = 0
    await a.refresh()
    await until(() => told.includes('T-4/Agent'))
    expect(a.background('T-4/Agent')).toBeUndefined()
    a.stop()
  })

  test('Codex: it keeps a command running past its turn but is never woken by it, so that turn waits on you', async () => {
    // Codex 0.163+'s code mode keeps a process with a session id past the turn (upstream's SHEP-207), and nothing tells
    // the agent when it exits: found here all the same, it counts for no CLI whose turn's end waits on you
    process_(93, ['/bin/bash', '-c', 'bun test'], ['SHEPHERDR_CHAT=T-5/Agent'])
    const a = new Agents()
    a.procs = new Procs(proc)
    await a.refresh()
    expect(a.procs.shells('T-5/Agent')).toHaveLength(1)
    expect(a.background('T-5/Agent')).toBeUndefined()
    a.stop()
  })

  test('pi: no background shell at all, so a turn that ends waits on you', async () => {
    // pi 1.5.2's bash is one command it waits on inside its turn (no run_in_background); a herdr child agent it
    // spawned wakes it through pi-herdr's delivery, which is not a process of its own here
    process_(94, ['/bin/bash', '-c', 'bun test'], ['SHEPHERDR_CHAT=T-6/Agent'])
    const a = new Agents()
    a.procs = new Procs(proc)
    await a.refresh()
    expect(a.background('T-6/Agent')).toBeUndefined()
    a.stop()
  })

  test('what runs in the background, by CLI: the shell that ends wakes it, the one that serves does not', () => {
    expect(servesCommand('/bin/bash -c cd /w && tools/changed-check.sh --fast 2>&1 | tail -12')).toBe(false)
    expect(servesCommand('/bin/bash -c bun run dev --port 5173')).toBe(true)
    expect(servesCommand('/bin/bash -c bun test --watch')).toBe(true)
    expect(servesCommand('/bin/bash -c tail -f /tmp/build.log')).toBe(true)
    // what an OpenCode background shell is: a shell command its pty daemon runs
    expect(shellCommand(['/bin/bash', '-c', 'bun test'])).toBe(true)
    expect(shellCommand(['/bin/sh', '-c', 'bun test'])).toBe(true)
    expect(shellCommand(['/bin/zsh', '-c', 'bun test'])).toBe(true)
    // a login or interactive shell runs a command the same way
    expect(shellCommand(['/bin/bash', '-lc', 'bun test'])).toBe(true)
    expect(shellCommand(['/usr/bin/zsh', '-ic', 'bun test'])).toBe(true)
    expect(shellCommand(['/bin/bash'])).toBe(false)
    expect(shellCommand(['opencode', 'run', 'x'])).toBe(false)
  })

  test('a shell running a headless reviewer of another CLI keeps it at work like a subagent, however long', async () => {
    session('shell')
    const a = new Agents()
    a.procs = { runs: (chat: string) => chat === 'T-1/Agent' } as never
    await a.refresh()
    expect(a.background('T-1/Agent')).toBe('agents')
    expect(a.background('T-1/Agent', Date.now() + a.shellsFor + 1)).toBe('agents')
    // the review is over: its shells alone again, for so long
    a.procs = { runs: () => false } as never
    expect(a.background('T-1/Agent')).toBe('shells')
    a.stop()
  })

  test("shells alone keep it at work only so long: a server it started for you never wakes it", async () => {
    session('shell')
    const a = new Agents()
    await a.refresh()
    expect(a.background('T-1/Agent')).toBe('shells')
    expect(a.background('T-1/Agent', Date.now() + a.shellsFor + 1)).toBeUndefined()
    const told: string[] = []
    a.on('status', (key) => told.push(key))
    a.shellsFor = 0
    await a.refresh()
    await until(() => told.length === 1)
    expect(a.background('T-1/Agent')).toBeUndefined()
    expect(told).toEqual(['T-1/Agent'])
    a.stop()
  })

  test('SHE-90: a subagent paused on shells of its own keeps it at work past the shells alone, and so does a session file that says busy', async () => {
    // its subagent stopped to wait on a shell of its own; it ended its turn with only <no-reply>. Stop lists only the
    // subagent's shell, and the session file says "shell" (a live re-run of SHE-90's case)
    const inputs: any[] = readFileSync(join(import.meta.dir, 'samples', 'claude-paused.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const events = join(tmp('bg-hooks'), 'e.jsonl')
    inputs.slice(0, 4).forEach((input, i) => record(events, input, Date.now() - 1000 + i))
    session('shell')
    const a = new Agents()
    a.records['T-1/Agent'].hooks = events
    await a.refresh()
    expect(a.background('T-1/Agent')).toBe('agents')
    // long past what shells alone may keep it at work
    expect(a.background('T-1/Agent', Date.now() + a.shellsFor + 1)).toBe('agents')
    a.shellsFor = 0
    await a.refresh()
    expect(a.background('T-1/Agent')).toBe('agents')
    // hooks that say only shells, while the session file says a subagent runs: it runs
    const shells = join(tmp('bg-hooks'), 'e.jsonl')
    record(shells, { hook_event_name: 'Stop', last_assistant_message: 'The preview is up.', background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] }, Date.now())
    session('busy')
    const b = new Agents()
    b.records['T-1/Agent'].hooks = shells
    b.shellsFor = 0
    await b.refresh()
    expect(b.background('T-1/Agent')).toBe('agents')
    // the pass reads the agy agent's screen too, a pane read: the next refresh is skipped while it is in progress
    await until(() => !(b as any).readingBackground)
    // and once the session file says only shells again, they keep it at work only so long
    session('shell')
    b.sessions = new ClaudeSessions()
    await b.refresh()
    expect(b.background('T-1/Agent')).toBeUndefined()
    a.stop()
    b.stop()
  })

  test('SHE-171: shells that end (a test run, a review) keep it at work long past a server; once they are done it needs you', async () => {
    // REV-4: it ended its turn "only waiting on the final test run and Codex's last review pass", 17 minutes into them
    const stop = (tasks: object[]) => {
      const events = join(tmp('bg-hooks'), 'e.jsonl')
      record(events, { hook_event_name: 'UserPromptSubmit', prompt: 'what do you need?', session_id: 's1' }, Date.now() - 3000)
      record(events, { hook_event_name: 'Stop', last_assistant_message: "Nothing from you right now. I'm only waiting on the final test run and Codex's last review pass.", background_tasks: tasks }, Date.now() - 1000)
      return events
    }
    const REV4 = [
      { id: 'bs5jno4fa', type: 'shell', status: 'running', description: 'Wait for third Codex review to finish', command: 'while pgrep -f "codex review --base main" >/dev/null; do sleep 15; done; tail -c 2500 /tmp/codex-review3.txt' },
      { id: 'b8g1hkavz', type: 'shell', status: 'running', description: 'Rerun acceptance tests then Codex review', command: 'node --test test/acceptance.test.mjs > /tmp/accept2.log 2>&1; codex review --base main > /tmp/codex-review5.txt 2>&1' },
    ]
    session('shell')
    const a = new Agents()
    a.records['T-1/Agent'].hooks = stop(REV4)
    await a.refresh()
    expect(a.background('T-1/Agent')).toBe('shells')
    // where 10 minutes used to make it "needs you"
    expect(a.background('T-1/Agent', Date.now() + a.serversFor + 1)).toBe('shells')
    expect(a.background('T-1/Agent', Date.now() + 30 * 60_000)).toBe('shells')
    // one that hangs: not for ever
    expect(a.background('T-1/Agent', Date.now() + a.shellsFor + 1)).toBeUndefined()
    // they ended and woke it, and it stopped again with nothing in the background, not ready: it needs you
    session('idle')
    a.sessions = new ClaudeSessions()
    await a.refresh()
    expect(a.background('T-1/Agent')).toBeUndefined()
    a.stop()

    // a dev server it left for you to look at never wakes it: only so long
    session('shell')
    const b = new Agents()
    b.records['T-1/Agent'].hooks = stop([{ id: 'b1', type: 'shell', status: 'running', description: 'Start the dev server', command: 'bun run dev --port 5173' }])
    await b.refresh()
    expect(b.background('T-1/Agent')).toBe('servers')
    expect(b.background('T-1/Agent', Date.now() + b.serversFor + 1)).toBeUndefined()
    b.stop()
  })

  test('SHE-171: the count starts again at each turn that ends, even one herdr never saw at work', async () => {
    const events = join(tmp('bg-hooks'), 'e.jsonl')
    const turn = (at: number) => {
      record(events, { hook_event_name: 'UserPromptSubmit', prompt: 'status?', session_id: 's1' }, at)
      record(events, { hook_event_name: 'Stop', last_assistant_message: 'Still waiting on the tests.', background_tasks: [{ id: 'b1', type: 'shell', status: 'running', command: 'bun test' }] }, at + 1)
    }
    turn(Date.now() - 5000)
    session('shell')
    const a = new Agents()
    a.records['T-1/Agent'].hooks = events
    a.shellsFor = 60_000
    await a.refresh()
    expect(a.background('T-1/Agent')).toBe('shells')
    // seen two minutes ago: past what it may wait
    ;(a as any).seen.get('T-1/Agent').since -= 120_000
    await a.refresh()
    expect(a.background('T-1/Agent')).toBeUndefined()
    // you asked how it goes; it answered in between herdr's looks and stopped again: counted from now
    turn(Date.now() - 2000)
    await a.refresh()
    expect(a.background('T-1/Agent')).toBe('shells')
    expect(a.background('T-1/Agent', Date.now() + 60_001)).toBeUndefined()
    a.stop()
  })
})

describe('headless reviewers', () => {
  test('codex exec, claude -p and pi -p are; an interactive CLI or another command is not', () => {
    expect(headless(['/usr/local/bin/codex', 'exec', '-s', 'read-only', '-'])).toBe(true)
    expect(headless(['node', '/usr/lib/node_modules/@openai/codex/bin/codex.js', 'exec', '-'])).toBe(true)
    expect(headless(['claude', '-p', '--model', 'opus'])).toBe(true)
    expect(headless(['pi', '--print'])).toBe(true)
    expect(headless(['opencode', 'run', '--standalone', 'Review this change'])).toBe(true)
    expect(headless(['/home/u/.opencode/bin/opencode', 'run'])).toBe(true)
    // OpenCode's interactive TUI is not a one-shot
    expect(headless(['opencode', '--standalone', '--session', 'ses_x', '--auto'])).toBe(false)
    expect(headless(['claude', '--settings', 'x.json'])).toBe(false)
    expect(headless(['codex', 'resume'])).toBe(false)
    expect(headless(['grep', 'codex', 'exec'])).toBe(false)
  })
  test("they are found in /proc by their command, and are the chat's their environment names", () => {
    const proc = tmp('proc')
    const put = (pid: number, argv: string[], env: string[]) => {
      mkdirSync(join(proc, String(pid)))
      writeFileSync(join(proc, String(pid), 'cmdline'), `${argv.join('\0')}\0`)
      writeFileSync(join(proc, String(pid), 'environ'), `${env.join('\0')}\0`)
    }
    put(10, ['codex', 'exec', '-'], ['HOME=/h', 'SHEPHERDR_CHAT=T-1/Agent'])
    put(11, ['claude', '--settings', 'x'], ['SHEPHERDR_CHAT=T-2/Agent'])
    put(12, ['claude', '-p'], ['HOME=/h'])
    mkdirSync(join(proc, 'self'))
    const r = new Procs(proc)
    expect(r.runs('T-1/Agent')).toBe(true)
    expect(r.runs('T-2/Agent')).toBe(false)
  })
  test('a process that is no headless CLI is read once, then again only while it is young', () => {
    const proc = tmp('proc-plain')
    const put = (pid: number, argv: string[], env: string[] = []) => {
      mkdirSync(join(proc, String(pid)), { recursive: true })
      writeFileSync(join(proc, String(pid), 'cmdline'), `${argv.join('\0')}\0`)
      writeFileSync(join(proc, String(pid), 'environ'), `${env.join('\0')}\0`)
    }
    put(20, ['bash', '-c', 'sleep 1'])
    const r = new Procs(proc)
    const base = Date.now()
    expect(r.runs('T-9/Agent', base)).toBe(false)
    // the shell execs a headless CLI (same pid, new command line) while it is young: found
    put(20, ['claude', '-p'], ['SHEPHERDR_CHAT=T-9/Agent'])
    expect(r.runs('T-9/Agent', base + 2500)).toBe(true)
    // an old plain one is not read again: a command line it grows later is not looked at (it never does, but the cost is
    // what is saved on a machine with thousands)
    put(21, ['sleep', '100'])
    expect(r.runs('T-9/Agent', base + 5000)).toBe(true)
    put(21, ['claude', '-p'], ['SHEPHERDR_CHAT=T-8/Agent'])
    expect(r.runs('T-8/Agent', base + 40_000)).toBe(false)
    // and a process that ended is forgotten: its pid may come back as another
    rmSync(join(proc, '21'), { recursive: true })
    expect(r.runs('T-8/Agent', base + 50_000)).toBe(false)
    put(21, ['claude', '-p'], ['SHEPHERDR_CHAT=T-8/Agent'])
    expect(r.runs('T-8/Agent', base + 60_000)).toBe(true)
  })
  test('with no /proc (macOS) they are found in ps, which prints each command with its environment after it', () => {
    const ps = [
      '/usr/local/bin/codex exec -s workspace-write - TERM=xterm SHEPHERDR_CHAT=T-1/Agent HOME=/Users/e',
      'claude --settings /h/x.json SHEPHERDR_CHAT=T-2/Agent',
      'claude -p --model opus HOME=/Users/e',
      'grep codex exec SHEPHERDR_CHAT=T-3/Agent',
    ].join('\n')
    const r = new Procs('/no/proc/here', () => ps)
    expect(r.runs('T-1/Agent')).toBe(true)
    expect(r.runs('T-2/Agent')).toBe(false)
    expect(r.runs('T-3/Agent')).toBe(false)
    expect(new Procs('/no/proc/here', () => { throw new Error('no ps') }).runs('T-1/Agent')).toBe(false)
  })
})

describe("OpenCode's background shells", () => {
  /** a /proc of a test's own: an OpenCode pty daemon, and processes under it or elsewhere */
  const put = (proc: string, pid: number, argv: string[], env: string[] = [], ppid = 0) => {
    mkdirSync(join(proc, String(pid)), { recursive: true })
    writeFileSync(join(proc, String(pid), 'cmdline'), `${argv.join('\0')}\0`)
    writeFileSync(join(proc, String(pid), 'environ'), `${env.join('\0')}\0`)
    writeFileSync(join(proc, String(pid), 'stat'), `${pid} (${argv[0]?.split('/').at(-1) ?? 'x'}) S ${ppid} 0 0 0\n`)
  }
  const daemon = (proc: string, pid = 10, ppid = 5) => put(proc, pid, ['/home/u/.cache/opencode/bin/opencode-pty/0.5.2/opencode-pty', 'daemon', '--runtime-dir', '/state'], ['HOME=/h'], ppid)

  test('a shell under its pty daemon, by the chat its environment names: a command line is read again while it runs', () => {
    const proc = tmp('proc-oc-procs')
    daemon(proc)
    put(proc, 11, ['/bin/bash', '-c', 'tools/changed-check.sh --fast'], ['SHEPHERDR_CHAT=T-1/Agent'], 10)
    // a shell of that chat whose parent is no daemon (another CLI's own command), and one with no chat of its own
    put(proc, 12, ['/bin/bash', '-c', 'bun test'], ['SHEPHERDR_CHAT=T-1/Agent'], 5)
    put(proc, 13, ['/bin/bash', '-c', 'bun test'], ['HOME=/h'], 10)
    // a process that vanished as the pass read it: its command line and environment there, no stat to name its parent
    mkdirSync(join(proc, '15'))
    writeFileSync(join(proc, '15', 'cmdline'), '/bin/bash\0-c\0bun test\0')
    writeFileSync(join(proc, '15', 'environ'), 'SHEPHERDR_CHAT=T-1/Agent\0')
    // a process still starting (an empty command line: a kernel thread, or a shell just forked)
    mkdirSync(join(proc, '14'))
    writeFileSync(join(proc, '14', 'cmdline'), '')
    writeFileSync(join(proc, '14', 'environ'), 'SHEPHERDR_CHAT=T-1/Agent\0')
    writeFileSync(join(proc, '14', 'stat'), '14 (bash) S 10 0 0 0\n')
    const p = new Procs(proc)
    expect(p.shells('T-1/Agent')).toEqual([['/bin/bash', '-c', 'tools/changed-check.sh --fast']])
    expect(p.shells('T-2/Agent')).toEqual([])
    // the same process, its command line changed: read again, since it is one of the chat's shells
    put(proc, 11, ['/bin/bash', '-c', 'tools/changed-check.sh'], ['SHEPHERDR_CHAT=T-1/Agent'], 10)
    expect(p.shells('T-1/Agent', Date.now() + 2500)).toEqual([['/bin/bash', '-c', 'tools/changed-check.sh']])
    // it ended and is a zombie: its folder is there, its command line empty, so it counts for nothing
    writeFileSync(join(proc, '11', 'cmdline'), '')
    expect(p.shells('T-1/Agent', Date.now() + 5000)).toEqual([])
    // and once it is reaped, nothing is left of it either
    rmSync(join(proc, '11'), { recursive: true })
    expect(p.shells('T-1/Agent', Date.now() + 7500)).toEqual([])
  })

  test('with no /proc (macOS) a shell carrying the chat is one of them, since its parent cannot be read there', () => {
    const ps = [
      '/bin/bash -c tools/changed-check.sh --fast SHEPHERDR_CHAT=T-1/Agent HOME=/Users/e',
      '/opt/google/chrome/chrome --type=renderer SHEPHERDR_CHAT=T-1/Agent',
      '/bin/bash -c bun test HOME=/Users/e',
    ].join('\n')
    expect(new Procs('/no/proc/here', () => ps).shells('T-1/Agent')).toEqual([['/bin/bash', '-c', 'tools/changed-check.sh', '--fast']])
    // a headless reviewer is still a reviewer there, never a shell
    expect(new Procs('/no/proc/here', () => 'claude -p --model opus SHEPHERDR_CHAT=T-1/Agent').shells('T-1/Agent')).toEqual([])
  })
})

describe('the logs an agent keeps', () => {
  test('each once: an old record with one twice reads it once, and the same log found again is not added', () => {
    const p = (id: string, dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-w-3')) => join(dir, `${id}.jsonl`)
    // SHE-253: a coordinator's record held its 95 MB log twice
    writeJson('agents.json', { 'T-3/Agent': { key: 'T-3/Agent', name: 'shep-t-3', kind: 'claude', cwd: '/w/3', workspace: 'w', logs: [p('a'), p('b'), p('a'), p('c')], sessionId: 'c', started: 0 } })
    const a = new Agents()
    expect(a.record('T-3/Agent')!.logs).toEqual([p('a'), p('b'), p('c')])
    // found again: by its session id, and by the path herdr names it by
    a.discoverLog('T-3/Agent')
    ;(a as unknown as { learnSession: (k: string, i: object) => void }).learnSession('T-3/Agent', { agent_session: { kind: 'path', value: p('a', '/elsewhere') } })
    expect(a.record('T-3/Agent')!.logs).toEqual([p('a'), p('b'), p('c')])
    a.save()
    expect(JSON.parse(readFileSync(join(process.env.SHEPHERDR_HOME!, 'agents.json'), 'utf8'))['T-3/Agent'].logs).toEqual([p('a'), p('b'), p('c')])
    a.stop()
  })
})
