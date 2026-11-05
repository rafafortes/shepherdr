// A task that starts by itself at a time (`task add --at` / `--in`): it waits in Scheduled with no agent, starts at its
// time through the same room and queue rules as any task, takes its Settings when it starts rather than when it was
// added, survives a restart (a time missed meanwhile starts it as soon as Shepherdr is back, and says so), and its time
// can be changed or cancelled (engine-world.ts).
import { describe, expect, test } from 'bun:test'
import { placeId, repo, started, until, world, writeJson } from './engine-world.ts'

describe('a task that starts by itself at a time', () => {
  test('waits in Scheduled with no agent, saying when, and starts by itself at its time', async () => {
    const w = world()
    const p = await w.places.add(repo(), 'sched')
    const t = w.engine.add({ project: p.name, title: 'Tonight', desc: 'Add hi.txt.', by: 'test', at: Date.now() + 1500 })
    // no agent yet, and nothing started for it
    expect(t.worktree).toBeUndefined()
    expect(w.started).toEqual([])
    const v = w.engine.view(t)
    expect(v.status).toBe('scheduled')
    expect(v.sub).toStartWith('Starts ')
    expect(v.scheduled).toBe(t.scheduled!.at)
    expect(v.agent).toBeUndefined()
    expect(w.cards).toEqual([])
    expect(w.news.some((n) => n.includes('needs you'))).toBe(false)
    // its time comes: its agent starts on the brief, as any task's
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`), 15_000)
    expect(w.started.find((s) => s.key === `${t.id}/Agent`)!.first).toStartWith('Tonight\n\nAdd hi.txt.\n\nSettings:')
    expect(t.scheduled).toBeUndefined()
    expect(w.engine.statusOf(t)).not.toBe('scheduled')
  })

  test('it takes its Settings when it starts, not when it was added', async () => {
    const w = world()
    const p = await w.places.add(repo(), 'sched-settings')
    const t = w.engine.add({ project: p.name, title: 'Tonight', desc: 'Add hi.txt.', by: 'test', at: Date.now() + 1200 })
    // nothing of Settings is read yet: the brief is the words it was added with
    expect(t.desc).toBe('Add hi.txt.')
    // the human lowers the review rounds meanwhile
    expect(w.settings.set('review.rounds', '1').ok).toBe(true)
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`), 15_000)
    const first = w.started.find((s) => s.key === `${t.id}/Agent`)!.first!
    expect(first).toContain('Review rounds: 1. One round, no review again.')
    expect(t.rounds).toBe(1)
  })

  test("its time comes while the machine has no room: it waits as Queued with no agent, and starts when one frees", async () => {
    const w = world()
    expect(w.settings.set('machine.maxTasks', '1').ok).toBe(true)
    const a = await started(w, repo(), 'sched-room', 'First', 'Add a.txt.')
    w.brief(a.key)
    await until(() => w.engine.statusOf(a.t) === 'work')
    const t = w.engine.add({ project: a.p.name, title: 'Later', desc: 'Add hi.txt.', by: 'test', at: Date.now() + 500 })
    await until(() => !!t.held, 15_000)
    expect(w.engine.statusOf(t)).toBe('queued')
    expect(t.worktree).toBeUndefined()
    expect(w.started.some((s) => s.key === `${t.id}/Agent`)).toBe(false)
    // the one at work ends its turn: a slot is free, and the one whose time came starts
    w.agentIs(a.key, 'idle')
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`), 15_000)
  }, 30_000)

  test('a time that passed while Shepherdr was off starts it when it is back, and says so', async () => {
    const p = await world().places.add(repo(), 'sched-missed')
    const id = `${p.key}-1`
    const at = Date.now() - 3 * 60_000
    writeJson('tasks.json', {
      next: { [p.key]: 1 },
      tasks: [{ id, n: 1, project: placeId.space(p.name), title: 'Missed', desc: 'Add hi.txt.', by: 'test', created: at, updated: at, told: 'scheduled', scheduled: { at, desc: 'Add hi.txt.' } }],
    })
    const w = world()
    // not at once: herdr has to say which agents are alive first, so the machine's room can be seen (the same first look
    // queued tasks wait for), and then it starts
    expect(w.started).toEqual([])
    await until(() => w.started.some((s) => s.key === `${id}/Agent`), 25_000)
    expect(w.started.find((s) => s.key === `${id}/Agent`)!.first).toStartWith('Missed\n\nAdd hi.txt.\n\nSettings:')
    expect(w.posted.some((x) => x.key === `${id}/Agent` && (x.card?.text ?? '').includes('passed while Shepherdr was off'))).toBe(true)
  }, 30_000)

  test('its time can be changed, and cancelled: it starts now; only a task not started yet can be scheduled', async () => {
    const w = world()
    const p = await w.places.add(repo(), 'sched-change')
    const t = w.engine.add({ project: p.name, title: 'Change', desc: 'Add hi.txt.', by: 'test', at: Date.now() + 3_600_000 })
    const later = Date.now() + 7_200_000
    w.engine.schedule(t.id, later)
    expect(t.scheduled!.at).toBe(later)
    // the words it was added with are still its own, no Settings read yet
    expect(t.desc).toBe('Add hi.txt.')
    w.engine.schedule(t.id, null)
    expect(t.scheduled).toBeUndefined()
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`), 15_000)
    expect(() => w.engine.schedule(t.id, later)).toThrow('has already started')
  })

  test('with --after: it waits for its time, then for that task, and its agent starts once both hold', async () => {
    const w = world()
    const a = await started(w, repo(), 'sched-after', 'First', 'Add a.txt.')
    w.brief(a.key)
    await until(() => w.engine.statusOf(a.t) === 'work')
    const t = w.engine.add({ project: a.p.name, title: 'After', desc: 'Add hi.txt.', by: 'test', after: [a.t.id], at: Date.now() + 500 })
    // its time comes, and it waits under Queued for the task it was queued after
    await until(() => !t.scheduled, 15_000)
    expect(w.engine.statusOf(t)).toBe('queued')
    expect(w.started.some((s) => s.key === `${t.id}/Agent`)).toBe(false)
    // that task is done with nothing to merge: its own agent starts, the go in its brief (no agent waited to hear it)
    await w.engine.close(a.t.id)
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`), 15_000)
    expect(w.started.find((s) => s.key === `${t.id}/Agent`)!.first).toContain(`Go: ${a.t.id} is done, start now.`)
  }, 30_000)

  test('anything written to it is the go: it starts now, on its brief with the words in it', async () => {
    const w = world()
    const p = await w.places.add(repo(), 'sched-tell')
    const t = w.engine.add({ project: p.name, title: 'Tell', desc: 'Add hi.txt.', by: 'test', at: Date.now() + 3_600_000 })
    await w.engine.tell(t.id, 'Start it now, they need the file today.')
    expect(t.scheduled).toBeUndefined()
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`), 15_000)
    expect(w.started.find((s) => s.key === `${t.id}/Agent`)!.first).toStartWith('Tell\n\nAdd hi.txt.\n\nStart it now, they need the file today.\n\nSettings:')
  })

  test('one added --later for a time waits for a go once its time comes, its brief saying so', async () => {
    const w = world()
    const p = await w.places.add(repo(), 'sched-later')
    const t = w.engine.add({ project: p.name, title: 'Later', desc: 'Add hi.txt.', by: 'test', later: true, at: Date.now() + 500 })
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`), 15_000)
    expect(w.started.find((s) => s.key === `${t.id}/Agent`)!.first).toStartWith("Later\n\nAdd hi.txt.\n\nDon't start yet: wait for a go.\n\nSettings:")
  })

  test('stopped before its time: it does not start by itself, and a later word starts it on the Settings it would have taken', async () => {
    const w = world()
    const p = await w.places.add(repo(), 'sched-stop')
    const t = w.engine.add({ project: p.name, title: 'Stop', desc: 'Add hi.txt.', by: 'test', at: Date.now() + 3_600_000 })
    expect(t.desc).toBe('Add hi.txt.')
    await w.engine.stopTask(t.id)
    // no time left for it to start by itself, and its brief's Settings block is built now, so a word later starts it on them
    expect(t.scheduled).toBeUndefined()
    expect(t.desc).toContain('Settings:')
    expect(w.engine.statusOf(t)).toBe('todo')
    await w.engine.tell(t.id, 'Go on now.')
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`), 15_000)
    expect(w.started.find((s) => s.key === `${t.id}/Agent`)!.first).toContain('Settings:')
  })

  test('a task stopped before it ever started is not started by a restart', async () => {
    const p = await world().places.add(repo(), 'sched-stopped-boot')
    const id = `${p.key}-1`
    writeJson('tasks.json', {
      next: { [p.key]: 1 },
      tasks: [{ id, n: 1, project: placeId.space(p.name), title: 'Stopped', desc: 'Add hi.txt.', by: 'test', created: Date.now(), updated: Date.now(), told: 'todo', stopped: true, todo: true }],
    })
    const w = world()
    await Bun.sleep(1500)
    expect(w.started).toEqual([])
  })

  test('archived while its time passes: it waits, and starts when it is brought back', async () => {
    const w = world()
    const p = await w.places.add(repo(), 'sched-away')
    const t = w.engine.add({ project: p.name, title: 'Away', desc: 'Add hi.txt.', by: 'test', at: Date.now() + 300 })
    await w.engine.archive(t.id)
    await Bun.sleep(800)
    expect(w.started.some((s) => s.key === `${t.id}/Agent`)).toBe(false)
    w.engine.unarchive(t.id)
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`), 15_000)
  })

  test('a task held for room can be given a time instead, and cancelling it starts it once', async () => {
    const w = world()
    expect(w.settings.set('machine.maxTasks', '1').ok).toBe(true)
    const a = await started(w, repo(), 'sched-held', 'First', 'Add a.txt.')
    w.brief(a.key)
    await until(() => w.engine.statusOf(a.t) === 'work')
    const b = w.engine.add({ project: a.p.name, title: 'Held', desc: 'Add b.txt.', by: 'test' })
    await until(() => !!b.held)
    // a time replaces the wait for room: it is Scheduled, with no agent
    w.engine.schedule(b.id, Date.now() + 3_600_000)
    expect(b.held).toBeUndefined()
    expect(w.engine.statusOf(b)).toBe('scheduled')
    expect(w.started.some((s) => s.key === `${b.id}/Agent`)).toBe(false)
    // cancelled with a slot free: it starts now, once (release() must not start it again)
    expect(w.settings.set('machine.maxTasks', '2').ok).toBe(true)
    expect(w.engine.schedule(b.id, null)).toEqual({})
    w.engine.release()
    await until(() => w.started.some((s) => s.key === `${b.id}/Agent`), 15_000)
    expect(w.started.filter((s) => s.key === `${b.id}/Agent`).length).toBe(1)
  })

  test('what it waits for can change while it waits for its time, without clearing the time', async () => {
    const w = world()
    const a = await started(w, repo(), 'sched-after-change', 'First', 'Add a.txt.')
    w.brief(a.key)
    const t = w.engine.add({ project: a.p.name, title: 'Later', desc: 'Add hi.txt.', by: 'test', at: Date.now() + 3_600_000 })
    expect(w.engine.queue(t.id, [a.t.id]).queued).toEqual([a.t.id])
    expect(t.scheduled).toBeTruthy()
    expect(w.engine.statusOf(t)).toBe('scheduled')
  })

  test('what it waits for is done before its time: it starts on its brief alone, once, and is not held by itself', async () => {
    const w = world()
    const a = await started(w, repo(), 'sched-after-done', 'First', 'Add a.txt.')
    w.brief(a.key)
    await until(() => w.engine.statusOf(a.t) === 'work')
    const t = w.engine.add({ project: a.p.name, title: 'After', desc: 'Add b.txt.', by: 'test', after: [a.t.id], at: Date.now() + 700 })
    // that task is done with nothing to merge before its time comes
    await w.engine.close(a.t.id)
    await until(() => w.started.some((s) => s.key === `${t.id}/Agent`), 15_000)
    const first = w.started.find((s) => s.key === `${t.id}/Agent`)!.first!
    expect(first).toStartWith('After\n\nAdd b.txt.\n\nSettings:')
    expect(first).not.toContain('Queued:')
    // it waits for nothing, so it is not held for its own slot, and no late go starts it again
    expect(t.after).toBeUndefined()
    expect(t.held).toBeUndefined()
    expect(w.started.filter((s) => s.key === `${t.id}/Agent`).length).toBe(1)
  })
})
