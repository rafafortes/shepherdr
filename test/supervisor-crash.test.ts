// A server that keeps crashing must slow down and tell the operator, not spin every 2 s in silence. The supervisor's
// decisions are dependency-injected (SupervisorDeps), so a fake clock and a fake alert command drive them here: no
// server, no herdr, no real notifier, and no time spent waiting on a backoff.
import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateStatus } from '../shared/types.ts'
import { ALERT_ENV, alertCommand, CRASHES, LOOP_KEY, STABLE, Supervisor, WINDOW } from '../scripts/supervisor.ts'
import { tmp } from './tmp.ts'

interface Sent {
  command: string
  args: string[]
  env: Record<string, string | undefined>
}

/** a supervisor with its own home, a stub clock and a fake alert command that records its argv */
function crashLoop(command?: string) {
  const home = tmp('crash-loop')
  let t = 1_000_000
  const sent: Sent[] = []
  const lines: string[] = []
  const statusFile = join(home, 'update.json')
  if (command) writeFileSync(join(home, 'settings.json'), JSON.stringify({ everywhere: { 'alerts.command': command } }))
  const sup = new Supervisor({
    root: home,
    home,
    status: null,
    save: (s) => writeFileSync(statusFile, JSON.stringify(s)),
    drain: async () => 0,
    restart: () => {},
    sleep: async () => {},
    log: (m) => void lines.push(m),
    now: () => t,
    alert: (c, args, env) => void sent.push({ command: c, args, env }),
  })
  /** one short-lived server that dies non-zero */
  const crash = () => {
    sup.started()
    t += 1000
    return sup.stopped(1)
  }
  return { sup, home, sent, lines, statusFile, crash, tick: (ms: number) => (t += ms), status: () => JSON.parse(readFileSync(statusFile, 'utf8')) as UpdateStatus }
}

describe('a server that keeps crashing', () => {
  test('restarts back off 2, 4, 8 ... 60 s and reset after a stable stretch', () => {
    const s = crashLoop()
    const delays = Array.from({ length: 8 }, () => s.crash())
    expect(delays).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000])
    // a server that stayed up five minutes is a stable stretch: the next crash starts at 2 s again
    s.sup.started()
    s.tick(STABLE + 1000)
    expect(s.sup.stopped(1)).toBe(2000)
  })

  test('a clean exit keeps the 200 ms restart and ends the loop', () => {
    const s = crashLoop()
    expect(s.crash()).toBe(2000)
    s.sup.started()
    s.tick(1000)
    expect(s.sup.stopped(0)).toBe(200)
    expect(s.crash()).toBe(2000)
  })

  test('the alerted command runs once per loop, with the words as argv and a marker in its environment', () => {
    const s = crashLoop('notify-me')
    expect(alertCommand(s.home)).toBe('notify-me')
    for (let i = 0; i < CRASHES - 1; i++) s.crash()
    expect(s.sent).toEqual([])
    s.crash()
    expect(s.sent).toEqual([
      {
        command: 'notify-me',
        args: ['Shepherdr is not staying up', `(${CRASHES} restarts in ${WINDOW / 60_000} min); see ${join(s.home, 'run', 'server.log')}`, LOOP_KEY],
        env: expect.objectContaining({ [ALERT_ENV]: 'crash-loop' }),
      },
    ])
    expect(s.lines.at(-1)).toContain('told the operator')
    for (let i = 0; i < 3; i++) s.crash()
    expect(s.sent).toHaveLength(1)
    // a stable stretch passes: a new loop may tell the operator again, once
    s.sup.started()
    s.tick(STABLE + 1000)
    s.sup.stopped(1)
    for (let i = 0; i < CRASHES; i++) s.crash()
    expect(s.sent).toHaveLength(2)
  })

  test('without an alert command the loop is written to server.log and update.json for the next start', () => {
    const s = crashLoop()
    for (let i = 0; i < CRASHES; i++) s.crash()
    expect(s.sent).toEqual([])
    expect(s.lines.join('\n')).toContain('Shepherdr is not staying up')
    expect(s.lines.join('\n')).toContain('no alert command is set')
    const saved = s.status()
    expect(saved.state).toBe('failed')
    expect(saved.error).toContain(`Shepherdr is not staying up (${CRASHES} restarts in ${WINDOW / 60_000} min); see `)
    expect(saved.error).toContain('server.log')
    expect(saved.error).toContain('stopped non-zero')
    // once it is up for a stable stretch, the screen's notice goes away
    s.sup.started()
    s.tick(STABLE + 1000)
    s.sup.stopped(0)
    expect(s.status().state).toBe('ok')
    expect(s.status().error).toBeUndefined()
  })

  /** the finding is about cost: with a stub clock, count starts in a ten-minute crisis, old fixed 2 s vs backoff */
  test('a ten-minute crash storm starts the server 14 times instead of the old 300', () => {
    let old = 0
    for (let t = 0; t < WINDOW; t += 2000) old++
    const s = crashLoop()
    let elapsed = 0
    let backoff = 0
    while (elapsed < 10 * 60_000) {
      elapsed += s.sup.stopped(1)
      backoff++
    }
    expect(old).toBe(300)
    expect(backoff).toBe(14)
  })

  test('the alert command comes from Settings: this machine over Everywhere, off or unset is none', () => {
    const s = crashLoop()
    expect(alertCommand(s.home)).toBeUndefined()
    writeFileSync(join(s.home, 'settings.json'), JSON.stringify({ everywhere: { 'alerts.command': '  everywhere-notify  ' } }))
    expect(alertCommand(s.home)).toBe('everywhere-notify')
    writeFileSync(join(s.home, 'settings.json'), JSON.stringify({ everywhere: { 'alerts.command': 'everywhere-notify' }, machine: { 'alerts.command': 'machine-notify' } }))
    expect(alertCommand(s.home)).toBe('machine-notify')
    writeFileSync(join(s.home, 'settings.json'), JSON.stringify({ everywhere: { 'alerts.command': 'off' }, machine: { 'alerts.command': 'OFF' } }))
    expect(alertCommand(s.home)).toBeUndefined()
  })
})
