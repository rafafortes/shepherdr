// Your alert command (Settings → Alert command, server/live/wait-alerts.ts): each wait of Needs you still open after the
// delay runs it once, as `<command> <title> <message> <key>`; one answered sooner runs nothing; a restart tells nothing
// twice; while it is off every wait counts as told. And Shepherdr's agents, of every CLI, start with SHEPHERDR_NOTIFIES=1
// while it is set (box.ts agentEnv), so a notifier of their CLI's own can stand aside.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentEnv, notifiesWith } from '../server/live/box.ts'
import { Settings } from '../server/live/settings.ts'
import { keyWords, runCommand, WaitAlerts, type Wait } from '../server/live/wait-alerts.ts'
import { readJson, writeJson } from '../server/store.ts'
import { repo, started, until, world } from './engine-world.ts'
import { tmp } from './tmp.ts'

/** what the command was run with, by a fresh watcher (its state from wait-alerts.json, emptied first unless kept) */
function watcher(keep = false) {
  if (!keep) writeJson('wait-alerts.json', { waits: {} })
  const ran: { command: string; args: string[] }[] = []
  return { w: new WaitAlerts((command, args) => ran.push({ command, args })), ran }
}
const wait = (key: string, title = `asks ${key}`): Wait => ({ key, words: () => ({ title, body: `about ${key}` }) })
const ON = { command: 'notify', after: 10_000 }

describe('the alert command is told what waits on you', () => {
  test('once a wait has stayed open the delay, once; one answered sooner, never', () => {
    const { w, ran } = watcher()
    w.look([wait('a'), wait('b')], ON, 1000)
    expect(ran).toEqual([])
    // b is answered before its delay: it goes; a is told once it waited 10 s, and only once
    w.look([wait('a')], ON, 11_000)
    w.look([wait('a')], ON, 20_000)
    expect(ran).toEqual([{ command: 'notify', args: ['asks a', 'about a', 'shepherdr-a-1000'] }])
  })

  test('a wait that opens again is a new one, with a key of its own', () => {
    const { w, ran } = watcher()
    w.look([wait('T-1/Agent:attention')], ON, 0)
    w.look([wait('T-1/Agent:attention')], ON, 10_000)
    w.look([], ON, 15_000)
    w.look([wait('T-1/Agent:attention')], ON, 20_000)
    w.look([wait('T-1/Agent:attention')], ON, 30_000)
    expect(ran.map((r) => r.args[2])).toEqual(['shepherdr-T-1_Agent_attention-0', 'shepherdr-T-1_Agent_attention-20000'])
  })

  test('a restart tells nothing twice: what was told and when each wait was seen are kept', () => {
    const first = watcher()
    first.w.look([wait('a'), wait('b')], ON, 0)
    first.w.look([wait('a'), wait('b')], ON, 10_000)
    expect(first.ran).toHaveLength(2)
    const again = watcher(true)
    again.w.look([wait('a'), wait('b'), wait('c')], ON, 12_000)
    again.w.look([wait('a'), wait('b'), wait('c')], ON, 22_000)
    expect(again.ran.map((r) => r.args[0])).toEqual(['asks c'])
    expect(readJson<{ waits: Record<string, unknown> }>('wait-alerts.json', { waits: {} }).waits).toEqual({ a: { seen: 0, told: true }, b: { seen: 0, told: true }, c: { seen: 12_000, told: true } })
  })

  test('while it is off nothing runs and every wait counts as told: turning it on tells only what comes next', () => {
    const { w, ran } = watcher()
    w.look([wait('old')], { after: 10_000 }, 0)
    w.look([wait('old')], { after: 10_000 }, 60_000)
    w.look([wait('old'), wait('new')], ON, 61_000)
    w.look([wait('old'), wait('new')], ON, 71_000)
    expect(ran.map((r) => r.args[0])).toEqual(['asks new'])
    // a told wait that is off again stays told
    w.look([wait('new')], { after: 10_000 }, 80_000)
    expect(ran).toHaveLength(1)
  })

  test('its words are read only when it is told, and nothing is written while nothing changed', () => {
    const { w } = watcher()
    let read = 0
    const x: Wait = { key: 'k', words: () => (read++, { title: 't', body: 'b' }) }
    w.look([x], ON, 0)
    expect(read).toBe(0)
    writeJson('wait-alerts.json', { waits: { k: { seen: 0 } }, marker: 1 })
    w.look([x], ON, 5000)
    // the state in memory had not changed: the file was not written again
    expect(readJson<{ marker?: number }>('wait-alerts.json', {}).marker).toBe(1)
    w.look([x], ON, 10_000)
    expect(read).toBe(1)
  })

  test('a key a command can name a file by', () => {
    expect(keyWords('p:host:lyvora site:ask:1/2', 5)).toBe('shepherdr-p_host_lyvora_site_ask_1_2-5')
    expect(keyWords('x'.repeat(300), 1)).toHaveLength(200)
  })
})

describe('the command runs through sh, with what it is told as its arguments', () => {
  const dir = tmp('wait-alerts-run')
  test('~ and words of its own work; quotes, $( ) and ; in the words are never run', async () => {
    const out = join(dir, 'out.txt')
    const script = join(dir, 'tell.sh')
    await Bun.write(script, `#!/bin/sh\nprintf '%s|%s|%s|%s\\n' "$1" "$2" "$3" "$4" > ${out}\n`)
    await Bun.$`chmod +x ${script}`
    runCommand(`${script} extra`, [`T · "quoted" $(touch ${dir}/pwned)`, 'line one\nline two; rm -rf /', 'shepherdr-k-1'])
    await until(() => existsSync(out))
    await Bun.sleep(50)
    expect(readFileSync(out, 'utf8')).toBe(`extra|T · "quoted" $(touch ${dir}/pwned)|line one\nline two; rm -rf /|shepherdr-k-1\n`)
    expect(existsSync(join(dir, 'pwned'))).toBe(false)
  })

  test('a command that fails or is not there says so, and never throws', async () => {
    const said: string[] = []
    const error = console.error
    console.error = (m: string) => void said.push(m)
    try {
      runCommand('exit 3', [])
      runCommand(join(dir, 'missing-command'), [])
      await until(() => said.length >= 2)
    } finally {
      console.error = error
    }
    expect(said).toEqual(expect.arrayContaining(['shepherdr: the alert command ended with 3', 'shepherdr: the alert command ended with 127']))
  })
})

describe('the settings', () => {
  test('the command is off by default, the delay 10 s; off in any case is off; seconds and minutes', () => {
    const s = new Settings()
    expect([s.alertCommand(), s.alertAfter()]).toEqual([undefined, 10_000])
    expect(s.set('alerts.command', '~/.local/bin/notify-operator', 'machine').ok).toBe(true)
    expect(s.alertCommand()).toBe('~/.local/bin/notify-operator')
    expect(s.set('alerts.command', ' OFF ', 'machine').ok).toBe(true)
    expect(s.alertCommand()).toBeUndefined()
    expect(s.set('alerts.after', '2 min', 'machine').ok).toBe(true)
    expect(s.alertAfter()).toBe(120_000)
    expect(s.set('alerts.after', '30 s').ok).toBe(true)
    expect(s.set('alerts.after', null, 'machine').ok).toBe(true)
    expect(s.alertAfter()).toBe(30_000)
    // a machine's own command, never a space's
    expect(s.set('alerts.command', 'x', { space: 'app' }).ok).toBe(false)
    for (const k of ['alerts.command', 'alerts.after']) s.set(k, null)
  })
})

describe("every CLI's agent starts with SHEPHERDR_NOTIFIES=1 while the command is set", () => {
  afterEach(() => notifiesWith(() => false))
  test('the environment of an agent says so, and stops saying it once the command is off', () => {
    notifiesWith((chat) => chat === 'T-1/Agent')
    expect(agentEnv('T-1/Agent', '/root').SHEPHERDR_NOTIFIES).toBe('1')
    expect(agentEnv('p:h:app', '/root').SHEPHERDR_NOTIFIES).toBeUndefined()
    notifiesWith(() => false)
    expect(agentEnv('T-1/Agent', '/root').SHEPHERDR_NOTIFIES).toBeUndefined()
  })

  for (const kind of ['claude', 'codex', 'pi', 'opencode', 'agy'])
    test(`a task's ${kind} agent`, async () => {
      notifiesWith(() => true)
      const w = world()
      w.engine.installed = () => true
      expect(w.settings.set('task.agent', kind).ok).toBe(true)
      const a = await started(w, repo(), `notifies-${kind}`)
      const s = w.started.find((x) => x.key === a.key) as unknown as { kind: string; env?: Record<string, string> }
      expect(s.kind).toBe(kind)
      expect(s.env?.SHEPHERDR_NOTIFIES).toBe('1')
      w.settings.set('task.agent', null)
    })
})
