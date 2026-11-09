// A coordinator's backup agent (Settings' coordinator.fallback, on backup.model and backup.effort): the same CLI again
// with its session, or another CLI taking the chat over once; off, it waits for the human as before. A real LiveSource,
// its agents stubbed at the one place they start (no herdr is here), and a herdr socket that isn't there.
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
async function place(name: string, kind = 'claude') {
  const dir = tmp('backup-repo')
  execSync(REPO, { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, name)
  const key = placeId.space(p.name)
  src.agents.records[key] = { key, name: `shep-${p.name}`, kind, cwd: dir, workspace: p.name, logs: [], started: Date.now() }
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
