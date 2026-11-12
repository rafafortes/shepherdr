// A coordinator's backup agent (Settings' coordinator.fallback, on its own coordinator.fallbackModel and
// coordinator.fallbackEffort, or the tasks' backup.model and backup.effort while those are at default): the same CLI
// again with its session, or another CLI taking the chat over once; off, it waits for the human as before. A real
// LiveSource, its agents stubbed at the one place they start (no herdr is here), and a herdr socket that isn't there.
import { afterAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('backup')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
type Retry = import('../server/live/retry.ts').Retry

const src = new LiveSource()
afterAll(() => src.stop())

const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'

/** the source's own coordinator path, which its retries call once an agent can't go on */
type CoordinatorSide = { coordinatorCantGoOn(key: string, r: Retry): Promise<void> }
const sides = src as unknown as CoordinatorSide

/** a space whose coordinator runs on `kind`, with the agents' starts stubbed: what a backup would have started */
async function place(name: string, kind = 'claude', model?: string) {
  const dir = tmp('backup-repo')
  execSync(REPO, { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, name)
  const key = placeId.space(p.name)
  src.agents.records[key] = { key, name: `shep-${p.name}`, kind, ...(model ? { model } : {}), cwd: dir, workspace: p.name, logs: [], started: Date.now() }
  src.engine.installed = () => true
  const started: { kind: string; model?: string; effort?: string; first?: string }[] = []
  const restart = src.agents.restart
  src.agents.restart = (async (spec: { kind: string; model?: string; effort?: string }, before?: () => Promise<string | void>) => {
    started.push({ ...spec, first: (await before?.()) as string | undefined })
    return null
  }) as never
  const alerts: string[] = []
  const alert = src.alert
  src.alert = ((a: { title: string }) => alerts.push(a.title)) as never
  const done = () => {
    src.agents.restart = restart
    src.alert = alert
    delete src.agents.records[key]
  }
  const cards = () => src.chats.chat(key).messages.filter((m) => m.card)
  const cut = (reason: string) => sides.coordinatorCantGoOn(key, { cut: `e-${reason}`, tries: 1, reason, words: `${reason} (the provider's words)`, over: true })
  return { src, p, key, dir, started, alerts, done, cards, cut }
}

describe("a coordinator's backup agent", () => {
  test('the same CLI starts again on the Backup model, its session resumed, and one card says who and why', async () => {
    const s = await place('same')
    try {
      expect(s.src.settings.set('coordinator.fallback', 'claude', { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('backup.model', 'Sonnet 5.5', { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('backup.effort', 'low', { space: s.p.name }).ok).toBe(true)
      await s.cut('Out of allowance until 5pm')
      expect(s.started).toHaveLength(1)
      // the same conversation partner, on the backup's model and effort: its own session, not a handover
      expect(s.started[0]).toMatchObject({ kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })
      expect(s.started[0].first).toContain('with your session as it was')
      expect(s.started[0].first).toContain('out of allowance until 5pm')
      expect(s.started[0].first).not.toContain('Taking over')
      // the kind it starts on is the kind the CLI was running: what makes herdr's start resume that session
      expect(s.started[0].kind).toBe(s.src.agents.record(s.key)!.kind)
      expect(s.src.agents.args({ ...s.src.agents.record(s.key)!, sessionId: 'abc', logs: ['/tmp/x.jsonl'], resume: true } as never, true)).toContain('--resume')
      expect(s.src.agents.tookOver(s.key)).toMatchObject({ from: 'claude', to: 'claude', why: 'out of allowance until 5pm' })
      const card = s.cards().find((m) => m.card!.text.includes('started again'))!
      expect(card.card!.text).toBe('Claude Code (Sonnet 5.5, low) started again, with its session: out of allowance until 5pm')
      // taken over once: a backup that can't go on either waits for the human, and never starts another
      await s.cut('Signed out')
      expect(s.started).toHaveLength(1)
      expect(s.cards().some((m) => m.card!.text.startsWith('Cut off by its provider: signed out'))).toBe(true)
      expect(s.alerts).toEqual(['same stopped'])
    } finally {
      s.done()
    }
  })

  test('another CLI takes the chat over once, with the handover, the chat and its tasks; the card says so', async () => {
    const s = await place('other')
    try {
      const t = src.engine.add({ project: s.p.name, title: 'Say hello', desc: 'Add hello.txt.', by: 'test' })
      expect(s.src.settings.set('coordinator.fallback', 'codex', { space: s.p.name }).ok).toBe(true)
      src.chats.post(s.key, { id: 'm1', who: 'you', text: 'Handle the tasks while I am away.' })
      await s.cut('Signed out')
      expect(s.started).toHaveLength(1)
      // another CLI, on its own default model (backup.model is default)
      expect(s.started[0]).toMatchObject({ kind: 'codex', model: '' })
      expect(s.started[0].first).toContain('Taking over: Claude Code ran this chat\'s coordinator until now and can\'t go on (signed out)')
      // its tasks go on as they are, and it hears the chat so far
      expect(s.started[0].first).toContain(`${t.id} Say hello`)
      expect(s.started[0].first).toContain('Handle the tasks while I am away.')
      expect(s.src.agents.tookOver(s.key)).toMatchObject({ from: 'claude', to: 'codex' })
      // a different conversation partner: the card says who took over, and it keeps the coordinator's own card
      const card = s.cards().find((m) => m.card!.text.includes('took over'))!
      expect(card.card).toMatchObject({ restart: true, text: 'Codex took over from Claude Code: signed out' })
      await s.cut('Signed out')
      expect(s.started).toHaveLength(1)
    } finally {
      s.done()
    }
  })

  test('off: no takeover at all, only the card and the alert, as before', async () => {
    const s = await place('off')
    try {
      expect(s.src.settings.get('coordinator.fallback', s.p.name)).toBe('off')
      await s.cut('Out of allowance until 5pm')
      expect(s.started).toHaveLength(0)
      expect(s.src.agents.tookOver(s.key)).toBeUndefined()
      expect(s.cards().map((m) => m.card!.text)).toEqual(['Cut off by its provider: out of allowance until 5pm. Write to carry on.'])
      expect(s.alerts).toHaveLength(1)
    } finally {
      s.done()
    }
  })

  test('the same CLI again keeps the model and effort the coordinator ran on where Backup leaves them default', async () => {
    // Tasks → Backup model and effort are default; the coordinator ran on Opus 5.5 at high effort
    const s = await place('own', 'claude', 'claude-opus-5-5')
    try {
      s.src.agents.records[s.key].effort = 'high'
      expect(s.src.settings.set('coordinator.fallback', 'claude', { space: s.p.name }).ok).toBe(true)
      await s.cut('Out of allowance until 5pm')
      expect(s.started).toHaveLength(1)
      expect(s.started[0]).toMatchObject({ kind: 'claude', model: 'claude-opus-5-5', effort: 'high' })
    } finally {
      s.done()
    }
  })

  test('a backup goes in once; starting it again yourself lets one go in once more', async () => {
    const s = await place('recover')
    try {
      expect(s.src.settings.set('coordinator.fallback', 'claude', { space: s.p.name }).ok).toBe(true)
      await s.cut('Out of allowance until 5pm')
      expect(s.started).toHaveLength(1)
      expect(s.src.agents.tookOver(s.key)).toBeDefined()
      // a backup that can't go on either waits for you, its chat saying the backup went in once already
      await s.cut('Signed out')
      expect(s.started).toHaveLength(1)
      expect(s.cards().map((m) => m.card!.text).at(-1)).toContain('Its backup agent (Claude Code) already went in once')
      // you start it again yourself: a backup may go in once more the next time it can't go on
      await (s.src as unknown as { restart(key: string, to: object): Promise<string> }).restart(s.key, {})
      expect(s.src.agents.tookOver(s.key)).toBeUndefined()
      expect(s.started).toHaveLength(2)
      await s.cut('Out of allowance')
      expect(s.started).toHaveLength(3)
    } finally {
      s.done()
    }
  })

  test("a chain of coordinator backups: each takes the chat over in turn, then it waits for you, its card naming the last", async () => {
    const s = await place('chain')
    try {
      for (const [k, v] of [['coordinator.fallback', 'claude'], ['coordinator.fallback2', 'off'], ['coordinator.fallback3', 'codex']]) expect(s.src.settings.set(k, v, { space: s.p.name }).ok).toBe(true)
      await s.cut('Out of allowance until 5pm')
      expect(s.started.map((x) => x.kind)).toEqual(['claude'])
      expect(s.src.agents.tookOver(s.key)).toMatchObject({ from: 'claude', to: 'claude', step: 1 })
      // Backup 1 can't go on either: Backup 2 is off, so Backup 3 takes the chat over
      await s.cut('Signed out')
      expect(s.started.map((x) => x.kind)).toEqual(['claude', 'codex'])
      expect(s.started[1].first).toContain("Taking over: Claude Code ran this chat's coordinator until now and can't go on (signed out)")
      expect(s.src.agents.tookOver(s.key)).toMatchObject({ to: 'codex', step: 3 })
      // past the last one: no loop, the human hears it
      await s.cut('Signed out again')
      expect(s.started).toHaveLength(2)
      expect(s.cards().map((m) => m.card!.text).at(-1)).toContain('Its backup agent (Codex) already went in once, the last of its backups')
      expect(s.alerts.length).toBeGreaterThan(0)
      // a start that fails keeps its place in the chain: the one before it stays marked, and the next cut tries it again
      s.src.agents.markTookOver(s.key, { from: 'claude', to: 'claude', why: 'x', at: Date.now(), step: 1 })
      const restart = s.src.agents.restart
      s.src.agents.restart = (async () => {
        throw new Error('no pane')
      }) as never
      await s.cut('Signed out once more')
      expect(s.src.agents.tookOver(s.key)).toMatchObject({ step: 1 })
      s.src.agents.restart = restart
    } finally {
      for (const k of ['coordinator.fallback', 'coordinator.fallback2', 'coordinator.fallback3']) s.src.settings.set(k, null, { space: s.p.name })
      s.done()
    }
  })

  test("the coordinators' backup on its own pair takes over on its own model, apart from the tasks' backup's", async () => {
    const s = await place('ownpair')
    try {
      expect(s.src.settings.set('task.fallback', 'codex', { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('coordinator.fallback', 'claude', { space: s.p.name }).ok).toBe(true)
      // the tasks' backup's own pair, which the coordinators' backup followed until now
      expect(s.src.settings.set('backup.model', 'gpt-6-sol', { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('backup.effort', 'low', { space: s.p.name }).ok).toBe(true)
      // the coordinators' own: a model and an effort Claude Code has, where a Codex model would be none for it
      expect(s.src.settings.set('coordinator.fallbackModel', 'Sonnet 5.5', { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('coordinator.fallbackEffort', 'medium', { space: s.p.name }).ok).toBe(true)
      await s.cut('Out of allowance until 5pm')
      expect(s.started).toHaveLength(1)
      expect(s.started[0]).toMatchObject({ kind: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' })
      const card = s.cards().find((m) => m.card!.text.includes('started again'))!
      expect(card.card!.text).toBe('Claude Code (Sonnet 5.5, medium) started again, with its session: out of allowance until 5pm')
      // each backup on its own: what they start on, side by side
      expect(s.src.engine.backupFor('coordinator', s.p.name)).toEqual({ to: { kind: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } })
      expect(s.src.engine.backupFor('task', s.p.name)).toEqual({ to: { kind: 'codex', model: 'gpt-6-sol', effort: 'low' } })
    } finally {
      for (const k of ['task.fallback', 'coordinator.fallback', 'backup.model', 'backup.effort', 'coordinator.fallbackModel', 'coordinator.fallbackEffort']) s.src.settings.set(k, null, { space: s.p.name })
      s.done()
    }
  })

  test("a space's own coordinator backup model wins over Everywhere's, and another space follows Everywhere", async () => {
    const a = await place('pair-a')
    expect(a.src.settings.set('coordinator.fallback', 'claude', 'all').ok).toBe(true)
    expect(a.src.settings.set('coordinator.fallbackModel', 'Opus 5.5', 'all').ok).toBe(true)
    try {
      expect(a.src.settings.set('coordinator.fallbackModel', 'Sonnet 5.5', { space: a.p.name }).ok).toBe(true)
      await a.cut('Signed out')
      expect(a.started[0]).toMatchObject({ kind: 'claude', model: 'claude-sonnet-5-5' })
    } finally {
      a.done()
    }
    const b = await place('pair-b')
    try {
      await b.cut('Signed out')
      // a space that sets none reads Everywhere's, as the tasks' pair always did
      expect(b.started[0]).toMatchObject({ kind: 'claude', model: 'claude-opus-5-5' })
    } finally {
      for (const k of ['coordinator.fallback', 'coordinator.fallbackModel']) for (const l of ['all', { space: a.p.name }] as const) b.src.settings.set(k, null, l)
      b.done()
    }
  })

  test("a coordinator backup model its CLI does not have is no takeover, and the card names the row it is set in", async () => {
    const s = await place('ownbadmodel')
    try {
      // the model was picked for a Codex backup; its coordinator's backup moved to Claude Code, which has no such model
      expect(s.src.settings.set('coordinator.fallback', 'codex', { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('coordinator.fallbackModel', 'gpt-6-sol', { space: s.p.name }).ok).toBe(true)
      expect(s.src.settings.set('coordinator.fallback', 'claude', { space: s.p.name }).ok).toBe(true)
      await s.cut('Signed out')
      expect(s.started).toHaveLength(0)
      expect(s.src.agents.tookOver(s.key)).toBeUndefined()
      expect(s.cards().map((m) => m.card!.text)).toEqual([
        "Cut off by its provider: signed out. No backup agent took over: Claude Code has no model gpt-6-sol: Coordinators → Backup model is set to one it doesn't have. Write to carry on.",
      ])
      expect(s.alerts).toHaveLength(1)
    } finally {
      for (const k of ['coordinator.fallback', 'coordinator.fallbackModel']) s.src.settings.set(k, null, { space: s.p.name })
      s.done()
    }
  })

  test("shepherdr set takes the coordinators' pair for a space, and shepherdr show reads it back", async () => {
    const s = await place('cli-set')
    try {
      expect((await s.src.cli(['set', 'coordinator.fallback', 'Claude Code', '--space', s.p.name], {})).code).toBe(0)
      expect((await s.src.cli(['set', 'coordinator.fallbackModel', 'Opus 5.5', '--space', s.p.name], {})).code).toBe(0)
      expect((await s.src.cli(['set', 'coordinator.fallbackEffort', 'high', '--space', s.p.name], {})).code).toBe(0)
      expect(s.src.engine.backupFor('coordinator', s.p.name)).toEqual({ to: { kind: 'claude', model: 'claude-opus-5-5', effort: 'high' } })
      const out = (await s.src.cli(['show', '--space', s.p.name], {})).out
      expect(out).toMatch(/^coordinator\.fallback\s+Claude Code\s+\(this space\)$/m)
      expect(out).toMatch(/^coordinator\.fallbackModel\s+Opus 5\.5\s+\(this space\)$/m)
      expect(out).toMatch(/^coordinator\.fallbackEffort\s+high\s+\(this space\)$/m)
      // a model its CLI does not have is refused where it is set
      const bad = await s.src.cli(['set', 'coordinator.fallbackModel', 'gpt-6-sol', '--space', s.p.name], {})
      expect(bad.code).toBe(1)
      expect(bad.out).toContain('Claude Code has no model gpt-6-sol')
    } finally {
      for (const k of ['coordinator.fallback', 'coordinator.fallbackModel', 'coordinator.fallbackEffort']) s.src.settings.set(k, null, { space: s.p.name })
      s.done()
    }
  })

  test("a backup model the coordinator's CLI does not have is no takeover, and the space's card says why", async () => {
    const s = await place('badmodel')
    try {
      expect(s.src.settings.set('coordinator.fallback', 'claude', { space: s.p.name }).ok).toBe(true)
      // the tasks' Codex backup has it; the coordinators' Claude Code does not
      expect(s.src.settings.set('backup.model', 'gpt-6-sol', { space: s.p.name }).ok).toBe(true)
      await s.cut('Signed out')
      expect(s.started).toHaveLength(0)
      expect(s.src.agents.tookOver(s.key)).toBeUndefined()
      expect(s.cards().map((m) => m.card!.text)).toEqual([
        "Cut off by its provider: signed out. No backup agent took over: Claude Code has no model gpt-6-sol: Tasks → Backup model is set to one it doesn't have. Write to carry on.",
      ])
    } finally {
      s.done()
    }
  })

  test("a backup CLI that isn't installed is no takeover, and the space's card says why", async () => {
    const s = await place('missing')
    try {
      expect(s.src.settings.set('coordinator.fallback', 'codex', { space: s.p.name }).ok).toBe(true)
      src.engine.installed = () => false
      await s.cut('Out of allowance until 5pm')
      expect(s.started).toHaveLength(0)
      expect(s.src.agents.tookOver(s.key)).toBeUndefined()
      expect(s.cards().map((m) => m.card!.text)).toEqual([
        "Cut off by its provider: out of allowance until 5pm. No backup agent took over: Codex isn't installed on this machine. Write to carry on.",
      ])
      expect(s.alerts).toHaveLength(1)
    } finally {
      src.engine.installed = () => true
      s.done()
    }
  })
})
