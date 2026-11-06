// The demo world: each task has one agent, and tapping a task opens its chat; merging is asked in that chat.
// A place's mode switches from the + menu of its coordinator's chat.
import { describe, expect, test } from 'bun:test'
import { DemoWorld } from '../server/demo/world.ts'

/** the demo agent answers a moment later: wait for it, up to 5s */
const until = async (f: () => boolean) => {
  for (let i = 0; !f() && i < 250; i++) await Bun.sleep(20)
}

describe('one agent per task', () => {
  test("every task has one agent, whose chat is the task's own", () => {
    const w = new DemoWorld()
    const tasks = w.snapshot().tasks
    for (const t of tasks) {
      expect(t.agent?.chat).toBe(`${t.id}/Agent`)
      // the list's dot and the chat's dot are one and the same
      expect(t.agent?.status).toBe(t.status)
    }
    expect(Object.keys(w.chats).filter((k) => k.includes('/') && !k.endsWith('/Agent'))).toEqual([])
  })

  test('the agent asks before merging with a plain choice card; Merge merges it', async () => {
    const w = new DemoWorld()
    const key = 'GTM-15/Agent'
    const q = w.chat(key).messages.find((m) => m.question?.title === 'Merge GTM-15?')!.question!
    expect(await w.act({ type: 'answer', chat: key, question: q.id, choice: 0 })).toMatchObject({ ok: true })
    const t = w.snapshot().tasks.find((x) => x.id === 'GTM-15')!
    expect(t.status).toBe('done')
    expect(t.agent?.status).toBe('done')
  })
})

describe('To do', () => {
  test("a To do task has its agent and chat; writing changes its brief, and a go sets it to work", async () => {
    const w = new DemoWorld()
    const todo = () => w.snapshot().tasks.find((x) => x.id === 'HP-204')!
    expect(todo().status).toBe('todo')
    expect(todo().agent).toMatchObject({ chat: 'HP-204/Agent', status: 'todo' })
    // a To do row is its title alone: no second line
    expect(todo().sub).toBe('')
    expect(w.chat('HP-204/Agent').messages[0].text).toStartWith('Dark mode for rendered pages\n\n')
    await w.act({ type: 'send', chat: 'HP-204/Agent', text: 'Keep code blocks light.' })
    await until(() => !!w.chat('HP-204/Agent').messages.at(-1)?.text?.includes('waiting for your go'))
    expect(todo().status).toBe('todo')
    expect(w.chat('HP-204/Agent').messages.at(-1)?.text).toContain('waiting for your go')
    await w.act({ type: 'send', chat: 'HP-204/Agent', text: 'Go ahead.' })
    await until(() => w.chat('HP-204/Agent').messages.at(-1)?.text === 'On it.')
    expect(todo().status).toBe('work')
    expect(w.chat('HP-204/Agent').messages.at(-1)?.text).toBe('On it.')
  })
})

describe('Queued', () => {
  test('a queued task says what it waits for; any message to it is the go', async () => {
    const w = new DemoWorld()
    const q = () => w.snapshot().tasks.find((x) => x.id === 'HP-203')!
    expect(q()).toMatchObject({ status: 'queued', sub: 'After HP-202', after: ['HP-202'], agent: { status: 'queued' } })
    await w.act({ type: 'send', chat: 'HP-203/Agent', text: 'Start it now, the fix can come later.' })
    await until(() => q().status === 'work')
    expect(q().status).toBe('work')
    expect(q().after).toBeUndefined()
  })
})

describe("a place's mode", () => {
  test('switching it changes only that place', async () => {
    const w = new DemoWorld()
    const [all, other] = w.snapshot().places
    for (const m of ['autopilot', 'regular'] as const) {
      expect(await w.act({ type: 'mode', place: all.id, mode: m })).toEqual({})
      expect(w.snapshot().places[0].mode).toBe(m)
    }
    expect(w.snapshot().places[1].mode).toBe(other.mode)
  })
  test('each switch posts one small card in its chat: Autopilot on or off, and what that means', async () => {
    const w = new DemoWorld()
    const all = w.snapshot().places[0]
    const cards = () => w.chat(all.chat).messages.filter((m) => m.card?.mode)
    expect(cards()).toEqual([])
    await w.act({ type: 'mode', place: all.id, mode: 'autopilot' })
    await w.act({ type: 'mode', place: all.id, mode: 'autopilot' })
    await w.act({ type: 'mode', place: all.id, mode: 'regular' })
    expect(cards().map((m) => m.text)).toEqual(['Autopilot on · works on its own', 'Autopilot off · does what you ask'])
    expect(cards()[1].card).toMatchObject({ mode: 'autopilot', text: 'off · does what you ask' })
    expect(cards()[1].card!.task).toBeUndefined()
  })
})

describe('Autopilot Run now', () => {
  test('one wake per tap, refused while one wakes and off Autopilot, and it leaves one quiet line in that chat only', async () => {
    const w = new DemoWorld()
    const p = w.snapshot().places.find((x) => x.machine === 'vm-str' && !x.home)!
    const line = () => w.chat(p.chat).messages.filter((m) => m.pilot)
    // another machine's space: its own machine wakes it, so nothing here offers it, and asking is refused
    const away = w.snapshot().places.find((x) => x.machine !== 'vm-str')!
    await world0(w, away)
    expect(await w.act({ type: 'heartbeat', place: away.id, op: 'run' })).toEqual({ ok: false, error: `${away.name} is on another machine: wake it there.` })
    // off Autopilot: no Run now to offer, and one that asks anyway is refused
    expect(p.runNow).toBeUndefined()
    expect(await w.act({ type: 'heartbeat', place: p.id, op: 'run' })).toEqual({ ok: false, error: `${p.name} is not on Autopilot: switch it on first.` })
    await w.act({ type: 'mode', place: p.id, mode: 'autopilot' })
    const at = () => w.snapshot().places.find((x) => x.id === p.id)!.runNow
    expect(at()).toBe('ready')
    // a wake's quiet line says nothing to read: it wakes nothing unread in the sidebar, and buzzes nothing
    const last = w.snapshot().last?.[p.chat]
    // a tap wakes it once, and shows Waking until its turn is over
    expect(await w.act({ type: 'heartbeat', place: p.id, op: 'run' })).toEqual({ ok: true, queued: false })
    expect(line().map((m) => m.pilot)).toEqual(['Autopilot woke · Run now · nothing to report'])
    expect(w.snapshot().last?.[p.chat]).toBe(last)
    expect(at()).toBe('waking')
    // one at a time: a second tap while its wake runs is refused
    expect(await w.act({ type: 'heartbeat', place: p.id, op: 'run' })).toEqual({ ok: false, error: `${p.name}'s coordinator is already waking: one wake at a time.` })
    expect(line()).toHaveLength(1)
    await until(() => at() === 'ready')
    // another tap goes again: one wake per tap, never a card and never another chat's line
    expect(await w.act({ type: 'heartbeat', place: p.id, op: 'run' })).toEqual({ ok: true, queued: false })
    expect(line()).toHaveLength(2)
    expect(line()[1].card).toBeUndefined()
    expect(Object.entries(w.chats).filter(([k, c]) => k !== p.chat && c.messages.some((m) => m.pilot))).toEqual([])
    await w.act({ type: 'mode', place: p.id, mode: 'regular' })
  })
})

/** puts a place on Autopilot, as its ⋯ menu does */
async function world0(w: DemoWorld, p: { id: string }) {
  await w.act({ type: 'mode', place: p.id, mode: 'autopilot' })
}

describe('attachments', () => {
  test('each file sent is a message of its own after the text, served only from where it was attached', async () => {
    const w = new DemoWorld()
    const key = 'GTM-15/Agent'
    const shot = await w.upload(key, 'shot.png', new Uint8Array([7]))
    // still in the message box: it shows there, in its own chat only
    expect(await (await w.attachment(key, shot))?.bytes()).toEqual(new Uint8Array([7]))
    expect(await w.attachment('all', shot)).toBeNull()
    await w.act({ type: 'send', chat: key, text: 'See', attachments: [shot] })
    const last = w.chat(key).messages.slice(-2)
    expect(last.map((m) => m.text ?? m.file?.name)).toEqual(['See', 'shot.png'])
    expect(await (await w.attachment(key, shot))?.bytes()).toEqual(new Uint8Array([7]))
    expect(await w.attachment('all', shot)).toBeNull()
  })
})

describe('archiving', () => {
  test('archived tasks stay in the snapshot, marked; archiving a working one stops it, and unarchive brings it back', async () => {
    const w = new DemoWorld()
    const t = () => w.snapshot().tasks.find((x) => x.id === 'HP-202')!
    expect(w.snapshot().tasks.filter((x) => x.archived).map((x) => x.id)).toEqual(['GTM-9', 'GTM-11'])
    expect(t().status).toBe('work')
    expect(await w.act({ type: 'archive', chat: 'HP-202/Agent', on: true })).toMatchObject({ ok: true })
    expect(t().archived).toBeNumber()
    expect(t().status).not.toBe('work')
    expect(t().state).toStartWith('Archived')
    await w.act({ type: 'archive', chat: 'HP-202/Agent', on: false })
    expect(t().archived).toBeUndefined()
  })
})

describe("a row's menu", () => {
  test('pause, pin, mark done (asked first when work is unmerged) and delete (asked first when it holds work)', async () => {
    const w = new DemoWorld()
    const t = (id: string) => w.snapshot().tasks.find((x) => x.id === id)
    expect(t('HP-202')!.status).toBe('work')
    expect(await w.act({ type: 'pause', chat: 'HP-202/Agent' })).toMatchObject({ ok: true })
    expect(t('HP-202')!.status).toBe('todo')
    expect(await w.act({ type: 'pause', chat: 'HP-202/Agent' })).toMatchObject({ ok: false })
    expect(await w.act({ type: 'pin', chat: 'HP-202/Agent', on: true })).toMatchObject({ ok: true })
    expect(t('HP-202')!.pinned).toBeNumber()
    await w.act({ type: 'archive', chat: 'HP-202/Agent', on: true })
    expect(t('HP-202')!.pinned).toBeUndefined()
    const [ready, open] = (['ready', 'need'] as const).map((s) => w.snapshot().tasks.find((x) => x.status === s && !x.archived)!)
    expect(await w.act({ type: 'close', chat: `${ready.id}/Agent` })).toMatchObject({ ok: false, held: [expect.any(String)] })
    expect(await w.act({ type: 'close', chat: `${ready.id}/Agent`, force: true })).toMatchObject({ ok: true })
    expect(t(ready.id)!.status).toBe('done')
    expect(await w.act({ type: 'delete', chat: `${open.id}/Agent` })).toMatchObject({ ok: false, held: [expect.any(String)] })
    expect(await w.act({ type: 'delete', chat: `${open.id}/Agent`, force: true })).toMatchObject({ ok: true })
    expect(t(open.id)).toBeUndefined()
  })
})
