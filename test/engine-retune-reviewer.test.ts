// Settings' reviewer changed (reviewer.agent, reviewer.model, reviewer.effort and the backup reviewers' keys): the
// waiting tasks read it in their brief's Settings block, as a task added now would. The block's Reviewer line is written
// again, the words above it stay byte for byte; a task whose agent already has its brief hears the new line with its
// go (or with the first message that reaches it), and is not started early. Running tasks keep their reviewer.
import { describe, expect, test } from 'bun:test'
import { placeId, repo, until, world } from './engine-world.ts'
import { reviewRetuneLine, type Retune } from '../server/live/engine/engine.ts'
import { briefReview, rebriefReviewer, reviewerChangedLine, reviewerLine, splitBrief } from '../server/live/prompts.ts'
import { OLD_HEADS, SETTINGS_HEAD } from '../shared/brief.ts'

/** a world where one task at a time runs on this machine: the rest wait for a slot */
function fresh() {
  const w = world()
  expect(w.settings.set('machine.maxTasks', '1').ok).toBe(true)
  return w
}

/** the Reviewer line of a brief's Settings block */
const reviewerOf = (desc: string) => desc.split('\n').find((l) => l.startsWith('- Reviewer: '))!

/** the Reviewer line as this world's Settings name it for a space's reviewer (Codex by default here) */
const CODEX_LINE = '- Reviewer: a headless Codex or a Codex subagent (its default model and effort).'
const PI_LINE = "- Reviewer: a headless pi or a pi subagent (its default model and effort). (this space's setting)"
const CODEX_PLAIN = '- Reviewer: a headless Codex or a Codex subagent (its default model and effort).'

describe('Settings reviewer changed: the waiting tasks read it in their brief', () => {
  test('a waiting task: its Reviewer line is written again, the human’s words above the block stay byte for byte', async () => {
    const w = fresh()
    const p = await w.places.add(repo(), 'rv-brief')
    const first = w.engine.add({ project: p.name, title: 'At work', desc: 'Add a.txt.', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${first.id}/Agent`))
    const q = w.engine.add({ project: p.name, title: 'Waits', desc: 'Add b.txt.\n\nKeep it small.', by: 'test' })
    expect(w.engine.statusOf(q)).toBe('queued')
    const before = q.desc
    expect(reviewerOf(before)).toBe(CODEX_LINE)

    expect(w.settings.set('reviewer.agent', 'pi', { space: p.name }).ok).toBe(true)
    const dry = w.engine.retuneReviewers({ space: p.name }, true)
    expect(dry).toEqual({ changed: 1, same: 0, follow: 0, pinned: 0, running: 1, kept: [], spaces: [{ name: p.name, on: { kind: 'pi' }, changed: 1 }] })
    // a dry run changes nothing
    expect([q.reviewer?.kind, q.desc]).toEqual(['codex', before])

    expect(w.engine.retuneReviewers({ space: p.name })).toEqual(dry)
    expect(q.reviewer).toMatchObject({ kind: 'pi' })
    // exactly the Reviewer line changed: the words above the block, and the block's other lines, are the same bytes
    expect(q.desc).toBe(before.replace(CODEX_LINE, PI_LINE))
    expect(q.desc.startsWith('Add b.txt.\n\nKeep it small.\n\nSettings: (from shepherdr show;')).toBe(true)
    // it was never started, and nothing was sent to it: its brief is what it reads at its turn
    expect(w.started.some((s) => s.key === `${q.id}/Agent`)).toBe(false)
    expect(w.sent.some((s) => s.key === `${q.id}/Agent`)).toBe(false)
    expect(q.reviewerNote).toBeUndefined()
    // the card in its chat says who reviews it now
    expect(w.posted.some((x) => x.key === `${q.id}/Agent` && x.card?.text === 'Reviewed by pi when its turn comes')).toBe(true)
    // the running one keeps its reviewer and its brief
    expect(first.reviewer).toMatchObject({ kind: 'codex' })
    // a second run finds it on pi already
    expect(w.engine.retuneReviewers({ space: p.name })).toMatchObject({ changed: 0, same: 1, running: 1 })
  })

  test('the backup reviewers are lines of the same block: one set, the Reviewer line says it, and off takes it out again', async () => {
    const w = fresh()
    const p = await w.places.add(repo(), 'rv-backup')
    const first = w.engine.add({ project: p.name, title: 'At work', desc: 'Add a.txt.', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${first.id}/Agent`))
    const q = w.engine.add({ project: p.name, title: 'Waits', desc: 'Add b.txt.', by: 'test' })
    expect(w.settings.set('reviewer.fallback', 'claude', { space: p.name }).ok).toBe(true)
    const r = w.engine.retuneReviewers({ space: p.name })
    expect(r).toMatchObject({ changed: 1, spaces: [{ name: p.name, changed: 1 }] })
    expect(reviewerOf(q.desc)).toBe(
      '- Reviewer: a headless Codex or a Codex subagent (its default model and effort). If that reviewer cannot run at all (out of allowance, signed out, its model is gone), review with a headless Claude Code or a Claude Code subagent (its default model and effort) instead for that round only, and say in your summary that you did; every round asks that reviewer first again. (this space\'s setting)',
    )
    // the backup's model is a line of the same block too, read where it is set
    expect(w.settings.set('reviewer.fallbackModel', 'claude-sonnet-5-5', { space: p.name }).ok).toBe(true)
    expect(w.engine.retuneReviewers({ space: p.name })).toMatchObject({ changed: 1 })
    expect(reviewerOf(q.desc)).toContain('review with a headless Claude Code or a Claude Code subagent (model claude-sonnet-5-5, its default effort) instead')
    // off: the Reviewer line reads as it did without a backup
    // (no reviewer.agent of this space's own in this test, so the line carries no mark)
    expect(w.settings.set('reviewer.fallback', 'off', { space: p.name }).ok).toBe(true)
    expect(w.engine.retuneReviewers({ space: p.name })).toMatchObject({ changed: 1 })
    expect(reviewerOf(q.desc)).toBe(CODEX_PLAIN)
  })

  test('a backup reviewer is not in the line while Review is off in the brief, and comes back with it on', async () => {
    const w = fresh()
    const p = await w.places.add(repo(), 'rv-review-off')
    const first = w.engine.add({ project: p.name, title: 'At work', desc: 'Add a.txt.', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${first.id}/Agent`))
    // a brief whose Review is off (the coordinator's own --set): its block says so, and the line stays plain
    const q = w.engine.add({ project: p.name, title: 'No review', desc: 'Add b.txt.', by: 'test', set: { 'brief.review': 'off' } })
    expect(briefReview(q.desc)).toBe(false)
    expect(w.settings.set('reviewer.fallback', 'claude', { space: p.name }).ok).toBe(true)
    w.engine.retuneReviewers({ space: p.name })
    expect(reviewerOf(q.desc)).not.toContain('review with')
    expect(q.desc).toContain(`${CODEX_PLAIN}\n`)
  })

  test('running, asking, archived and done tasks keep their reviewer and their brief', async () => {
    const w = fresh()
    const p = await w.places.add(repo(), 'rv-running')
    expect(w.settings.set('machine.maxTasks', '10').ok).toBe(true)
    const work = w.engine.add({ project: p.name, title: 'At work', desc: 'Add a.txt.', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${work.id}/Agent`))
    const asking = w.engine.add({ project: p.name, title: 'Asks', desc: 'Add c.txt.', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${asking.id}/Agent`))
    w.agentIs(`${asking.id}/Agent`, 'blocked')
    expect(w.engine.statusOf(asking)).toBe('need')
    const archived = w.engine.add({ project: p.name, title: 'Archived', desc: 'Add d.txt.', by: 'test' })
    archived.archived = Date.now()
    const done = w.engine.add({ project: p.name, title: 'Done', desc: 'Add e.txt.', by: 'test' })
    done.merged = true
    const before = [work.desc, asking.desc, archived.desc, done.desc]
    expect(w.settings.set('reviewer.agent', 'pi', { space: p.name }).ok).toBe(true)
    expect(w.engine.retuneReviewers({ space: p.name })).toEqual({ changed: 0, same: 0, follow: 0, pinned: 0, running: 2, kept: [], spaces: [] })
    expect([work.desc, asking.desc, archived.desc, done.desc]).toEqual(before)
    expect(work.reviewer).toMatchObject({ kind: 'codex' })
  })

  test('a space that sets the key itself keeps it when the change is Everywhere or this machine', async () => {
    const w = fresh()
    const own = await w.places.add(repo(), 'rv-own')
    const plain = await w.places.add(repo(), 'rv-plain')
    expect(w.settings.set('reviewer.agent', 'codex', { space: own.name }).ok).toBe(true)
    const kept = w.engine.add({ project: own.name, title: 'Kept', desc: 'Add a.txt.', by: 'test' })
    const moved = w.engine.add({ project: plain.name, title: 'Moves', desc: 'Add b.txt.', by: 'test' })
    expect(kept.reviewer).toMatchObject({ kind: 'codex' })
    expect(moved.reviewer).toMatchObject({ kind: 'codex' })
    const keptBefore = kept.desc
    expect(w.settings.set('reviewer.agent', 'pi', 'all').ok).toBe(true)
    const r = w.engine.retuneReviewers({ key: 'reviewer.agent' }, true)
    expect(r.kept).toEqual([own.name])
    expect(r).toMatchObject({ changed: 1, spaces: [{ name: plain.name, on: { kind: 'pi' }, changed: 1 }] })
    w.engine.retuneReviewers({ key: 'reviewer.agent' })
    expect(moved.reviewer).toMatchObject({ kind: 'pi' })
    expect(reviewerOf(moved.desc)).toBe("- Reviewer: a headless pi or a pi subagent (its default model and effort). (your setting for every machine)")
    expect([kept.reviewer, kept.desc]).toEqual([{ kind: 'codex' }, keptBefore])
  })

  test('a reviewer the coordinator chose with task add changes too, counted apart, and then runs on Settings', async () => {
    const w = fresh()
    const p = await w.places.add(repo(), 'rv-pinned')
    const pinned = w.engine.add({ project: p.name, title: 'Chosen', desc: 'Add a.txt.', by: 'test', reviewer: { kind: 'codex' } })
    expect(pinned.reviewerChosen).toBe(true)
    expect(reviewerOf(pinned.desc)).toBe('- Reviewer: a headless Codex or a Codex subagent (its default model and effort). (set by coordinator for this task)')
    expect(w.settings.set('reviewer.agent', 'pi', { space: p.name }).ok).toBe(true)
    expect(w.engine.retuneReviewers({ space: p.name })).toMatchObject({ changed: 1, pinned: 1, same: 0 })
    expect(pinned.reviewer).toMatchObject({ kind: 'pi' })
    expect(pinned.reviewerChosen).toBeUndefined()
    expect(reviewerOf(pinned.desc)).toBe(PI_LINE)
  })

  test('a scheduled task builds its brief at its time from Settings: it follows, and a reviewer task add gave it goes', async () => {
    const w = fresh()
    const p = await w.places.add(repo(), 'rv-scheduled')
    const later = Date.now() + 86_400_000
    const follows = w.engine.add({ project: p.name, title: 'Tomorrow', desc: 'Add a.txt.', by: 'test', at: later })
    const chosen = w.engine.add({ project: p.name, title: 'Tomorrow too', desc: 'Add b.txt.', by: 'test', at: later, reviewer: { kind: 'codex' } })
    expect(w.settings.set('reviewer.agent', 'pi', { space: p.name }).ok).toBe(true)
    const dry = w.engine.retuneReviewers({ space: p.name }, true)
    expect(dry).toMatchObject({ changed: 1, pinned: 1, follow: 1, same: 0 })
    expect(follows.desc).toBe('Add a.txt.')
    w.engine.retuneReviewers({ space: p.name })
    expect(follows.scheduled?.reviewer).toBeUndefined()
    expect(chosen.scheduled?.reviewer).toBeUndefined()
    // no brief yet: none is written before its time
    expect(chosen.desc).toBe('Add b.txt.')
    // a time's task whose reviewer already is Settings' is the same, and keeps its own flags
    const same = w.engine.add({ project: p.name, title: 'Same', desc: 'Add c.txt.', by: 'test', at: later, reviewer: { kind: 'pi' } })
    // (the two before it had their flags cleared by the change, so they follow Settings now)
    expect(w.engine.retuneReviewers({ space: p.name })).toMatchObject({ changed: 0, same: 1, follow: 2 })
    expect(same.scheduled?.reviewer).toEqual({ kind: 'pi' })
  })

  test('a waiting task whose agent has its brief (To do) is told the new reviewer with its go, and not started before', async () => {
    const w = fresh()
    expect(w.settings.set('machine.maxTasks', '10').ok).toBe(true)
    const p = await w.places.add(repo(), 'rv-todo')
    const t = w.engine.add({ project: p.name, title: 'Todo', desc: 'Add a.txt.\n\nWait for my go.', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
    w.brief(`${t.id}/Agent`)
    w.engine.todo(t.id)
    expect(w.engine.statusOf(t)).toBe('todo')
    const sentBefore = w.sent.length
    const startedBefore = w.started.length
    expect(w.settings.set('reviewer.agent', 'pi', { space: p.name }).ok).toBe(true)
    expect(w.engine.retuneReviewers({ space: p.name })).toMatchObject({ changed: 1, spaces: [{ name: p.name, changed: 1 }] })
    // nothing reaches its agent now, and nothing starts it
    expect([w.sent.length, w.started.length]).toEqual([sentBefore, startedBefore])
    expect(t.reviewerNote).toBe(reviewerChangedLine(reviewerLine({ kind: 'pi' })))
    expect(t.reviewerNote).toContain('Your reviewer changed while you waited')
    expect(w.posted.some((x) => x.key === `${t.id}/Agent` && x.card?.text === 'Reviewed by pi: its agent is told at its go')).toBe(true)
    expect(w.engine.statusOf(t)).toBe('todo')

    // its go carries the line, once
    w.engine.startNow(t.id)
    await until(() => w.sent.some((s) => s.key === `${t.id}/Agent` && s.text.includes('Your reviewer changed')))
    const go = w.sent.filter((s) => s.key === `${t.id}/Agent`).at(-1)!.text
    expect(go).toContain('Go: you were started now')
    expect(go).toContain(reviewerChangedLine(reviewerLine({ kind: 'pi' })))
    expect(t.reviewerNote).toBeUndefined()
  })

  test('the first message to a To do task carries the new reviewer too, and a restart on the same CLI tells it', async () => {
    const w = fresh()
    expect(w.settings.set('machine.maxTasks', '10').ok).toBe(true)
    const p = await w.places.add(repo(), 'rv-message')
    const t = w.engine.add({ project: p.name, title: 'Message', desc: 'Add a.txt.', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
    w.brief(`${t.id}/Agent`)
    w.engine.todo(t.id)
    expect(w.settings.set('reviewer.agent', 'pi', { space: p.name }).ok).toBe(true)
    w.engine.retuneReviewers({ space: p.name })
    await w.engine.tell(t.id, 'Please go ahead.')
    const said = w.sent.filter((s) => s.key === `${t.id}/Agent`).at(-1)!.text
    expect(said.startsWith('Please go ahead.')).toBe(true)
    expect(said).toContain(reviewerChangedLine(reviewerLine({ kind: 'pi' })))
    expect(t.reviewerNote).toBeUndefined()
    // a message starts it: from here it is at work, so the next change waits for a To do again
    expect(w.engine.statusOf(t)).toBe('work')
  })

  test('a restart of a To do task tells the new reviewer: on the same CLI in its message, on another CLI through its brief', async () => {
    const w = fresh()
    expect(w.settings.set('machine.maxTasks', '10').ok).toBe(true)
    const p = await w.places.add(repo(), 'rv-restart')
    const t = w.engine.add({ project: p.name, title: 'Restart', desc: 'Add a.txt.', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`))
    w.brief(`${t.id}/Agent`)
    w.engine.todo(t.id)
    expect(w.settings.set('reviewer.agent', 'pi', { space: p.name }).ok).toBe(true)
    expect(w.engine.retuneReviewers({ space: p.name })).toMatchObject({ changed: 1 })
    expect(t.reviewerNote).toBe(reviewerChangedLine(reviewerLine({ kind: 'pi' })))
    // the same CLI reads its brief from its session: it is told the new line in its restart message
    await w.engine.restart(t.id, { kind: 'claude' })
    const again = w.started.filter((s) => s.key === `${t.id}/Agent`).at(-1)!
    expect(again.first).toContain(reviewerChangedLine(reviewerLine({ kind: 'pi' })))
    expect(t.reviewerNote).toBeUndefined()

    // a change again, then a restart on another CLI: its brief (read as it is now) has the line, so no note is owed
    w.engine.todo(t.id)
    expect(w.settings.set('reviewer.agent', 'codex', { space: p.name }).ok).toBe(true)
    expect(w.engine.retuneReviewers({ space: p.name })).toMatchObject({ changed: 1 })
    expect(t.reviewerNote).toBeDefined()
    await w.engine.restart(t.id, { kind: 'pi' })
    const moved = w.started.filter((s) => s.key === `${t.id}/Agent`).at(-1)!
    expect(moved.first).toContain(CODEX_PLAIN)
    expect(moved.first).not.toContain('Your reviewer changed')
    expect(t.reviewerNote).toBeUndefined()
  })

  test('a task still in line (held, nothing started) gets its brief only: no note, no message', async () => {
    const w = fresh()
    const p = await w.places.add(repo(), 'rv-held')
    const first = w.engine.add({ project: p.name, title: 'At work', desc: 'Add a.txt.', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${first.id}/Agent`))
    const held = w.engine.add({ project: p.name, title: 'Held', desc: 'Add b.txt.', by: 'test' })
    expect(held.worktree).toBeUndefined()
    expect(w.settings.set('reviewer.agent', 'pi', { space: p.name }).ok).toBe(true)
    expect(w.engine.retuneReviewers({ space: p.name })).toMatchObject({ changed: 1 })
    expect(held.reviewerNote).toBeUndefined()
    expect(w.sent.some((s) => s.key === `${held.id}/Agent`)).toBe(false)
    expect(reviewerOf(held.desc)).toBe(PI_LINE)
  })

  test('a task queued after another with no agent yet: its brief only, and its go is the start', async () => {
    const w = fresh()
    expect(w.settings.set('machine.maxTasks', '10').ok).toBe(true)
    const p = await w.places.add(repo(), 'rv-after')
    const first = w.engine.add({ project: p.name, title: 'First', desc: 'Add a.txt.', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${first.id}/Agent`))
    const after = w.engine.add({ project: p.name, title: 'After', desc: 'Add b.txt.', by: 'test', after: [first.id] })
    expect(w.engine.statusOf(after)).toBe('queued')
    expect(w.settings.set('reviewer.agent', 'pi', { space: p.name }).ok).toBe(true)
    expect(w.engine.retuneReviewers({ space: p.name })).toMatchObject({ changed: 1, running: 1 })
    expect(after.reviewerNote).toBeUndefined()
    expect(reviewerOf(after.desc)).toBe(PI_LINE)
  })
})

describe('the brief helpers', () => {
  const brief = 'Add a.txt.\n\nSettings: (from shepherdr show; where the brief above says otherwise, it wins)\n- Review: on. Have your change reviewed by fresh eyes before it merges.\n- Reviewer: a headless Codex or a Codex subagent (its default model and effort).\n- Merge: on its own.'

  test('a Reviewer line is found by its label, in the block only, and the rest comes back as it is', () => {
    const r = { reviewer: { kind: 'pi' }, review: true }
    expect(rebriefReviewer(brief, r)).toBe(brief.replace('a headless Codex or a Codex subagent (its default model and effort).', 'a headless pi or a pi subagent (its default model and effort).'))
    // no block: the words come back as they are
    expect(rebriefReviewer('Just words: - Reviewer: nothing here.', r)).toBe('Just words: - Reviewer: nothing here.')
    // a block with no Reviewer line: nothing to say, nothing changed
    const noLine = 'Words.\n\nSettings: (from shepherdr show; where the brief above says otherwise, it wins)\n- Review: off. No review; the lines on reviewing below don\'t apply.'
    expect(rebriefReviewer(noLine, r)).toBe(noLine)
    // an older block's head is read too
    const old = brief.replace(SETTINGS_HEAD, OLD_HEADS[0]!)
    expect(old).not.toBe(brief)
    expect(splitBrief(rebriefReviewer(old, r))[1].split('\n')[2]).toContain('a headless pi')
    // a line that is not in the block (below its last "- " line) is not touched
    const below = `${brief}\nNot a block line.\n- Reviewer: a line of the human's own.`
    expect(rebriefReviewer(below, r).endsWith("\n- Reviewer: a line of the human's own.")).toBe(true)
  })

  test('the line says the backup reviewers only where the block has Review on', () => {
    const fallback = [{ kind: 'claude' }]
    const on = rebriefReviewer(brief, { reviewer: { kind: 'pi' }, fallback, review: false })
    expect(on).toContain('a headless pi or a pi subagent (its default model and effort). If that reviewer cannot run at all')
    const off = rebriefReviewer(brief.replace('- Review: on.', '- Review: off.'), { reviewer: { kind: 'pi' }, fallback, review: true })
    expect(off).toContain('- Reviewer: a headless pi or a pi subagent (its default model and effort).\n')
    expect(briefReview(off)).toBe(false)
    expect(briefReview('no block')).toBeUndefined()
  })

  test('the reviewer words in a line: one space, several, and nothing changed', () => {
    const base: Retune = { changed: 0, same: 0, follow: 0, pinned: 0, running: 0, kept: [], spaces: [] }
    expect(reviewRetuneLine({ ...base, changed: 2, same: 1, pinned: 1, running: 1, follow: 1, kept: ['lyvora-app'], spaces: [{ name: 'lyvora-site', on: { kind: 'pi', model: 'opencode-go/deepseek' }, changed: 2 }] })).toBe(
      '2 waiting tasks in lyvora-site are reviewed by pi (opencode-go/deepseek) when their turn comes; 1 of them had a reviewer of its own from task add, and changes too; 1 already on it; 1 takes Settings\' reviewer at its turn anyway; 1 running task keeps its reviewer; lyvora-app keeps its own setting.',
    )
    expect(reviewRetuneLine({ ...base, changed: 3, spaces: [{ name: 'a', on: { kind: 'pi' }, changed: 1 }, { name: 'b', on: { kind: 'codex' }, changed: 2 }] })).toBe(
      '3 waiting tasks in 2 spaces are reviewed by what Settings name for each (a by pi; b by Codex).',
    )
    expect(reviewRetuneLine({ ...base, changed: 1, spaces: [{ name: 'a', on: { kind: 'pi' }, changed: 1 }] })).toBe('1 waiting task in a is reviewed by pi when its turn comes.')
    expect(reviewRetuneLine({ ...base, same: 2, follow: 2, running: 2 })).toBe('no waiting task changes; 2 already on it; 2 take Settings\' reviewer at their turn anyway; 2 running tasks keep their reviewer.')
  })
})

describe('a renamed space: the reviewer answer names it as it shows, and a scope by either name or its place id reaches it', () => {
  test('its waiting task is reviewed by pi under its shown name, the kept list names its own setting, and each way to name it works', async () => {
    const w = fresh()
    const plain = await w.places.add(repo(), 'rv-site')
    const own = await w.places.add(repo(), 'rv-own')
    w.places.rename(placeId.space('rv-site'), 'lyvora-site')
    w.places.rename(placeId.space('rv-own'), 'lyvora-app')
    expect(w.settings.set('reviewer.agent', 'codex', { space: own.name }).ok).toBe(true)
    const first = w.engine.add({ project: plain.name, title: 'At work', desc: 'Add a.txt.', by: 'test' })
    await until(() => w.started.some((s) => s.key === `${first.id}/Agent`))
    const waits = w.engine.add({ project: plain.name, title: 'Waits', desc: 'Add b.txt.', by: 'test' })
    const kept = w.engine.add({ project: own.name, title: 'Kept', desc: 'Add c.txt.', by: 'test' })
    expect([w.engine.statusOf(waits), w.engine.statusOf(kept)]).toEqual(['queued', 'queued'])
    expect(w.settings.set('reviewer.agent', 'pi', 'all').ok).toBe(true)

    const everywhere: Retune = { changed: 1, same: 0, follow: 0, pinned: 0, running: 1, kept: ['lyvora-app'], spaces: [{ name: 'lyvora-site', on: { kind: 'pi' }, changed: 1 }] }
    expect(w.engine.retuneReviewers({ key: 'reviewer.agent' }, true)).toEqual(everywhere)
    for (const scope of [plain.name, 'lyvora-site', placeId.space(plain.name)]) {
      expect(w.engine.retuneReviewers({ space: scope }, true)).toEqual({ ...everywhere, kept: [] })
    }
    expect(w.engine.retuneReviewers({ space: 'nowhere' }, true)).toEqual({ changed: 0, same: 0, follow: 0, pinned: 0, running: 0, kept: [], spaces: [] })

    expect(w.engine.retuneReviewers({ key: 'reviewer.agent' })).toEqual(everywhere)
    expect(waits.reviewer).toMatchObject({ kind: 'pi' })
    expect(kept.reviewer).toMatchObject({ kind: 'codex' })
    expect(reviewRetuneLine(everywhere)).toBe('1 waiting task in lyvora-site is reviewed by pi when its turn comes; 1 running task keeps its reviewer; lyvora-app keeps its own setting.')
  })
})
