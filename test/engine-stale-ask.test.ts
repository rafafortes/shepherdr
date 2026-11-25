// A card that asked for an extra review round is settled by the coordinator's grant, so it never keeps or brings back
// Needs you while the agent works the round and its merge goes in (SHE-201). These paths read the chat log and herdr,
// never a CLI's own screen: the same for every harness, each one run here.
import { describe, expect, test } from 'bun:test'
import { repo, until, world } from './engine-world.ts'

const KINDS = ['claude', 'codex', 'pi', 'opencode', 'agy']
type W = ReturnType<typeof world>

/** a started task, on the given CLI, whose agent asked a card in the turn that just ended */
async function asking(w: W, kind: string, name: string) {
  const p = await w.places.add(repo(), name)
  const t = w.engine.add({ project: p.name, title: 'Add one review round', desc: 'Merge when done.', by: 'test', set: { 'review.rounds': '2' } })
  await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
  const key = `${t.id}/Agent`
  const record = w.records[key]
  if (!record) throw new Error(`no agent record for ${key}`)
  record.kind = kind
  w.chat.card = 'ask'
  w.chat.cardTitle = 'Add one more review round?'
  w.chat.askedInTurn = false
  // its turn ended on the card it asked
  w.agentIs(key, 'idle')
  // all of its own rounds were used, so only its coordinator can add one
  t.reviews = 2
  return { t, key }
}

/** a merge gate in flight, as it is after a detached shepherdr merge */
function gate(w: W, id: string) {
  ;(w.engine as unknown as { runner: { landings: Map<string, unknown> } }).runner.landings.set(id, Promise.resolve())
}

for (const kind of KINDS) {
  describe(`the stale review card on ${kind}`, () => {
    test('review-more settles the card; the turn ending in a merge is Merging, not Needs you', async () => {
      const w = world()
      const { t, key } = await asking(w, kind, `grant-${kind}`)
      expect(w.engine.statusOf(t)).toBe('need')
      expect(w.engine.subOf(t, 'need')).toContain('Add one more review round?')

      expect(await w.engine.reviewMore(t.id, t.project)).toEqual({ rounds: 3 })
      // the card shows as answered by the coordinator, and stops being the question the agent waits on
      expect(w.settled).toEqual([{ key, words: expect.stringContaining('coordinator') }])
      expect(w.chat.card).toBeUndefined()
      expect(w.engine.statusOf(t)).not.toBe('need')

      // the agent works the added round, reports and starts its merge gate, then its turn ends
      t.reported = true
      t.landing = { step: 'gate', at: Date.now() }
      gate(w, t.id)
      w.agentIs(key, 'idle')
      expect(w.engine.statusOf(t)).toBe('merging')
      expect(w.engine.subOf(t)).toContain('Running the merge gate')
    })

    test('a message that reaches the agent while the merge is in flight keeps Merging', async () => {
      const w = world()
      const { t, key } = await asking(w, kind, `word-${kind}`)
      await w.engine.reviewMore(t.id, t.project)
      t.reported = true
      t.landing = { step: 'gate', at: Date.now() }
      gate(w, t.id)
      w.agentIs(key, 'idle')

      // the advisor's answer, a relay or the human's words all reach it through youWrote
      w.engine.youWrote(key)
      expect(t.reported).toBe(true)
      expect(t.landing?.step).toBe('gate')
      expect(w.engine.statusOf(t)).toBe('merging')

      // once the merge is over, a word starts a new turn as before
      ;(w.engine as unknown as { runner: { landings: Map<string, unknown> } }).runner.landings.delete(t.id)
      w.engine.youWrote(key)
      expect(t.reported).toBe(false)
      expect(t.landing).toBeUndefined()
    })

    test('a real open card on an unreported task still reads Needs you', async () => {
      const w = world()
      const { t, key } = await asking(w, kind, `real-${kind}`)
      // no coordinator settled it and the agent did not report: the question is still the human's
      w.agentIs(key, 'idle')
      expect(w.engine.statusOf(t)).toBe('need')
      expect(w.engine.subOf(t, 'need')).toContain('Add one more review round?')
    })

    test('a card asked in the turn that just ended still reads Needs you, even on a reported task', async () => {
      const w = world()
      const { t, key } = await asking(w, kind, `fresh-${kind}`)
      // no turn began after this card: an agent woken by its own background shell may still wait on it
      t.reported = true
      w.agentIs(key, 'idle')
      expect(w.engine.statusOf(t)).toBe('need')
      expect(w.engine.subOf(t, 'need')).toContain('Add one more review round?')
    })
  })
}

test('review-more leaves an unrelated open ask alone', async () => {
  const w = world()
  const { t } = await asking(w, 'opencode', 'unrelated')
  w.chat.cardTitle = 'Which store for the outbox?'
  expect(await w.engine.reviewMore(t.id, t.project)).toEqual({ rounds: 3 })
  expect(w.settled).toEqual([])
  expect(w.chat.card).toBe('ask')
  expect(w.engine.statusOf(t)).toBe('need')
})

test('a gate run on its own also keeps a message from taking the task out of Merging', async () => {
  const w = world()
  const { t, key } = await asking(w, 'opencode', 'gate-only')
  await w.engine.reviewMore(t.id, t.project)
  t.reported = true
  t.landing = { step: 'gate', at: Date.now() }
  // a detached gate is on the task record, not in the merge runner's in-memory map
  t.gateRun = { at: Date.now(), pid: 1, exit: 'gate.exit', log: 'gate.log' } as never
  w.agentIs(key, 'idle')
  w.engine.youWrote(key)
  expect(t.reported).toBe(true)
  expect(t.landing?.step).toBe('gate')
  expect(w.engine.statusOf(t)).toBe('merging')
})

test('a merge stopped on a conflict still goes back to the agent when written to', async () => {
  const w = world()
  const { t, key } = await asking(w, 'opencode', 'rebase')
  await w.engine.reviewMore(t.id, t.project)
  t.reported = true
  t.landing = { step: 'rebase', at: Date.now() }
  gate(w, t.id)
  w.engine.youWrote(key)
  expect(t.reported).toBe(false)
  expect(t.landing).toBeUndefined()
})
