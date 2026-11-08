// The runner of a headless Claude Code (server/live/headless.ts): it lives in the agent's herdr pane, takes each
// message Shepherdr writes to its inbox as the next turn, runs `claude -p` for it on the same session, and shows the
// turn in the pane. Ctrl+C in the pane, or Shepherdr's interrupt (SIGUSR2), stops the turn under way, not the runner;
// closing the pane (SIGHUP) or SIGTERM ends both.
//
//   bun scripts/claude-headless.ts <its folder>
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: claude-headless <folder>')
  process.exit(2)
}

interface Spec {
  claude: string
  args: string[]
  sessionId: string
  log: string
  cwd: string
  env: Record<string, string>
}

const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8')) as Spec
const inbox = join(dir, 'inbox')
mkdirSync(inbox, { recursive: true })

const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

const state = { pid: process.pid, working: false, child: undefined as number | undefined, turns: 0, error: undefined as string | undefined, at: Date.now() }
function save() {
  state.at = Date.now()
  const tmp = join(dir, `state.json.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, join(dir, 'state.json'))
}

let child: ChildProcess | undefined
let ending = false
/** a signal to the turn's whole process group: claude and what it runs */
const toTurn = (sig: NodeJS.Signals) => {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, sig)
  } catch {
    child.kill(sig)
  }
}
/** stop the turn under way, as Esc does: an interrupt, then an end if it doesn't listen */
const stopTurn = () => {
  const c = child
  toTurn('SIGINT')
  setTimeout(() => c === child && toTurn('SIGTERM'), 5000)
}
// Ctrl+C in the pane, or Shepherdr's interrupt: the turn stops, the runner goes on (a turn runs in a group of its own)
process.on('SIGINT', stopTurn)
process.on('SIGUSR2', stopTurn)
/** gone: no state says it lives, so a pid reused later is never taken for it */
const forget = () => rmSync(join(dir, 'state.json'), { force: true })
for (const sig of ['SIGHUP', 'SIGTERM'] as const)
  process.on(sig, () => {
    ending = true
    toTurn('SIGTERM')
    forget()
    setTimeout(() => process.exit(0), 300)
  })
process.on('exit', forget)
// a turn's failure never ends the runner: it says so and takes the next message
process.on('uncaughtException', (e) => process.stdout.write(`${RED}${e.message}${RESET}\n`))

/** the oldest message waiting, taken out of the inbox */
function next(): string | undefined {
  const f = readdirSync(inbox).filter((x) => x.endsWith('.txt')).sort()[0]
  if (!f) return undefined
  const p = join(inbox, f)
  const text = readFileSync(p, 'utf8')
  rmSync(p, { force: true })
  return text
}

/** one line of claude's stream, as the pane shows it */
function show(line: string) {
  let e: Record<string, any>
  try {
    e = JSON.parse(line)
  } catch {
    return
  }
  if (e.type === 'assistant') {
    for (const b of e.message?.content ?? []) {
      if (b.type === 'text' && b.text?.trim()) process.stdout.write(`${b.text.trim()}\n\n`)
      else if (b.type === 'tool_use') process.stdout.write(`${DIM}· ${b.name}${toolHint(b.input)}${RESET}\n`)
    }
  } else if (e.type === 'system' && e.subtype === 'api_retry') {
    process.stdout.write(`${DIM}· retrying (${e.error_status ?? ''} ${e.error ?? ''})${RESET}\n`)
  } else if (e.type === 'result') {
    if (e.is_error) {
      state.error = String(e.result ?? e.subtype ?? 'failed')
      process.stdout.write(`${RED}${state.error}${RESET}\n`)
    }
    const secs = e.duration_ms ? ` · ${Math.round(e.duration_ms / 1000)} s` : ''
    const cost = typeof e.total_cost_usd === 'number' ? ` · $${e.total_cost_usd.toFixed(4)}` : ''
    process.stdout.write(`${DIM}— turn ${e.is_error ? 'failed' : 'done'}${secs}${cost}${RESET}\n\n`)
  }
}

function toolHint(input: Record<string, unknown> | undefined) {
  const v = input?.command ?? input?.file_path ?? input?.pattern ?? input?.description
  return typeof v === 'string' ? ` ${v.split('\n')[0].slice(0, 100)}` : ''
}

/** one turn: claude -p on its session, the message on stdin */
function turn(text: string): Promise<void> {
  // its session's log is there once a turn ran: resumed; the first turn starts it under its own id
  const session = existsSync(spec.log) ? ['--resume', spec.sessionId] : ['--session-id', spec.sessionId]
  const args = ['-p', ...session, ...spec.args, '--output-format', 'stream-json', '--verbose']
  process.stdout.write(`${BOLD}${CYAN}› ${text.trim().split('\n')[0].slice(0, 160)}${RESET}\n`)
  state.working = true
  state.error = undefined
  return new Promise((resolve) => {
    const c = spawn(spec.claude, args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    child = c
    state.child = c.pid
    save()
    c.stdin!.on('error', () => undefined)
    c.stdin!.end(text)
    let buf = ''
    c.stdout!.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        show(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    })
    let err = ''
    c.stderr!.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-2000)))
    let finished = false
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return
      finished = true
      if (buf.trim()) show(buf)
      if (code && code !== 130 && !signal && !state.error) {
        state.error = (err.trim().split('\n').filter((l) => !/^Warning:/.test(l)).pop() ?? `claude exited ${code}`).slice(0, 500)
        process.stdout.write(`${RED}${state.error}${RESET}\n\n`)
      }
      if (signal === 'SIGINT' || signal === 'SIGTERM' || code === 130) process.stdout.write(`${DIM}— interrupted${RESET}\n\n`)
      child = undefined
      state.child = undefined
      state.working = false
      state.turns++
      save()
      resolve()
    }
    c.on('close', done)
    c.on('error', (e) => {
      state.error = e.message
      done(1, null)
    })
  })
}

save()
process.stdout.write(`${DIM}Claude Code, headless on the API key: each message is one claude -p turn on session ${spec.sessionId}.${RESET}\n\n`)
for (;;) {
  if (ending) break
  const text = next()
  if (text === undefined) {
    await new Promise((r) => setTimeout(r, 250))
    continue
  }
  await turn(text)
}
