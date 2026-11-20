// The chat's plain rules: day lines and search in a chat; and the built chat's cache (SHE-68).
import { describe, expect, test } from 'bun:test'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayLabel, findIn } from '../plugins/chat/days.ts'
import type { Message } from '../shared/types.ts'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME ??= tmp('chat')
const { Chats, nextClose, rememberReply } = await import('../server/live/chats.ts')

describe('day lines', () => {
  const now = new Date(2026, 9, 25, 9, 30)
  test('today, yesterday, a weekday this week, else the date; the year only when it is not this one', () => {
    expect(dayLabel(new Date(2026, 9, 25, 0, 5).getTime(), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 9, 24, 23, 59).getTime(), now)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 9, 21, 12).getTime(), now)).toBe(new Date(2026, 9, 21).toLocaleDateString([], { weekday: 'long' }))
    const old = dayLabel(new Date(2026, 8, 2).getTime(), now)
    expect(old).not.toContain('2026')
    expect(dayLabel(new Date(2025, 8, 2).getTime(), now)).toContain('2025')
  })
})

describe('search in a chat', () => {
  const msgs: Message[] = [
    { id: 'a', who: 'you', text: 'Is the Clock mocked?' },
    { id: 'b', who: 'agent', text: 'No.' },
    { id: 'c', who: 'you', file: { name: 'clock.png', path: '/x/clock.png' } },
    { id: 'd', who: 'you', text: 'clock again', waiting: true },
    { id: 'e', who: 'agent', question: { id: 'q', title: 'Fix the clock?', kind: 'Question', choices: [], to: 'x' } },
  ]
  test('words in any case, file names and card titles; nothing still waiting to go in', () => {
    expect(findIn(msgs, '  CLOCK ')).toEqual(['a', 'c', 'e'])
    expect(findIn(msgs, '')).toEqual([])
    expect(findIn(msgs, 'zebra')).toEqual([])
    // markdown aside: a link by its words, not its address; no ** in the way
    const md: Message[] = [{ id: 'm', who: 'agent', text: 'See **the** [docs](https://example.com/clockwork)' }]
    expect(findIn(md, 'see the docs')).toEqual(['m'])
    expect(findIn(md, 'clockwork')).toEqual([])
  })
})

/* SHE-68: the message array is built once per change of the sources it reads, not on every chat() call */

const agentsForChat = () => {
  const outbox: object[] = []
  const delivered: object[] = []
  return {
    outbox,
    delivered,
    record: () => undefined,
    sentLately: () => delivered,
    waiting: () => outbox,
    holdOf: () => undefined,
    status: () => 'blocked',
    failedLately: () => [],
    info: () => undefined,
    runtime: () => undefined,
    runtimeHook: () => undefined,
    background: () => false,
    unreadable: () => undefined,
    stillRuns: () => false,
    procs: { list: () => [] },
  }
}
const chatWith = (agents: object = agentsForChat(), watched?: (key: string) => boolean) =>
  new Chats(
    agents as never,
    (k) => k,
    () => 'You',
    undefined,
    watched,
  )

/** what a CLI's reader left in the log, with the revision a real read would have bumped */
const reached = (chats: InstanceType<typeof Chats>, key: string, ...ev: object[]) => {
  const state = chats as unknown as { events: Map<string, object[]>; revs: Map<string, number> }
  state.events.set(key, [...(state.events.get(key) ?? []), ...ev])
  state.revs.set(key, (state.revs.get(key) ?? 0) + 1)
}
const question = (id: string) => ({ id, title: 'Pick one', kind: 'Plan' as const, choices: [{ label: 'Yes' }], to: 'T agent' })

describe('the built chat is cached per revision', () => {
  test('two chat() calls with no change build the messages once, and the built array is never handed out', () => {
    const key = 'cache-hit/Agent'
    const chats = chatWith()
    reached(chats, key, { kind: 'agent', id: 'a1', at: 1000, text: 'Hello.' })
    chats.post(key, { id: 'ask:1', at: 1100, question: question('ask:1') })
    const first = chats.chat(key)
    const built = chats.chatBuilds
    const second = chats.chat(key)
    expect(chats.chatBuilds).toBe(built)
    expect(second.messages).toEqual(first.messages)
    expect(second.messages).not.toBe(first.messages)
    expect(second.closedAt).toEqual(first.closedAt)
  })

  test('a post, an answer, a pulled log line and a menu each rebuild the chat', () => {
    const key = 'cache-miss/Agent'
    const chats = chatWith()
    reached(chats, key, { kind: 'agent', id: 'a1', at: 1000, text: 'Hello.' })
    const before = chats.chatBuilds
    chats.chat(key)
    expect(chats.chatBuilds).toBe(before + 1)
    chats.chat(key)
    expect(chats.chatBuilds).toBe(before + 1)
    chats.post(key, { id: 'ask:1', at: 1100, question: question('ask:1') })
    const posted = chats.chat(key)
    expect(chats.chatBuilds).toBe(before + 2)
    expect(posted.messages.some((m) => m.question?.id === 'ask:1')).toBe(true)
    chats.answer(key, 'ask:1', 0)
    const answered = chats.chat(key)
    expect(chats.chatBuilds).toBe(before + 3)
    expect(answered.messages.find((m) => m.question?.id === 'ask:1')?.question?.sent).toBe(0)
    reached(chats, key, { kind: 'agent', id: 'a2', at: 1200, text: 'A new reply.' })
    const pulled = chats.chat(key)
    expect(chats.chatBuilds).toBe(before + 4)
    expect(pulled.messages.some((m) => m.text === 'A new reply.')).toBe(true)
    chats.showStartMenu(key, { title: 'Trust folder?', choices: ['Yes'], cursor: 0, screen: 'Trust folder?', all: 'Trust folder?' })
    const menu = chats.chat(key)
    expect(chats.chatBuilds).toBe(before + 5)
    expect(menu.messages.some((m) => m.question?.terminal)).toBe(true)
  })

  test('a queued reaction and a reply linked from a space decorate a copy, never the built messages', () => {
    const key = 'cache-copy/Agent'
    const agents = agentsForChat()
    const chats = chatWith(agents)
    reached(chats, key, { kind: 'agent', id: 'a1', at: 1000, text: 'Hello.' })
    const first = chats.chat(key)
    const built = chats.chatBuilds
    agents.outbox.push({ id: 'w1', at: 2000, text: '👍', reaction: { message: 'a1', emoji: '👍' } })
    const withReaction = chats.chat(key)
    expect(chats.chatBuilds).toBe(built)
    expect(withReaction.messages.find((m) => m.id === 'a1')?.reactions?.[0]?.emoji).toBe('👍')
    expect(first.messages.find((m) => m.id === 'a1')?.reactions).toBeUndefined()
    agents.outbox.length = 0
    const line = '<reply from="You" to="Hello.">Yes, do it.</reply>'
    rememberReply(line, 'a1')
    reached(chats, key, { kind: 'user', id: 'u1', at: 1300, text: line })
    const beforeLink = chats.chat(key)
    expect(beforeLink.messages.find((m) => m.who === 'you' && m.reply?.id === 'a1')).toBeDefined()
    chats.repliedFrom(key, 'a1', 'space')
    const withLink = chats.chat(key)
    expect(withLink.messages.find((m) => m.who === 'you')?.answered).toBe('Answered')
    expect(beforeLink.messages.find((m) => m.who === 'you')?.answered).toBeUndefined()
  })

  test('a reposted page and a message closing the asks both invalidate the build', () => {
    const key = 'cache-log/Agent'
    const chats = chatWith()
    chats.post(key, { id: 'page:p1', at: 1000, text: 'A page' })
    chats.post(key, { id: 'ask:1', at: 1100, question: question('ask:1') })
    chats.chat(key)
    const built = chats.chatBuilds
    chats.repostPage(key, 'p1')
    const reposted = chats.chat(key)
    expect(chats.chatBuilds).toBe(built + 1)
    expect(reposted.messages.some((m) => m.artifact?.id === 'p1')).toBe(true)
    expect(chats.closeAsks(key, 'Answered in words')).toBe(true)
    const closed = chats.chat(key)
    expect(chats.chatBuilds).toBe(built + 2)
    expect(closed.messages.find((m) => m.question?.id === 'ask:1')?.question?.sent).toBe(-1)
  })

  test('forget drops the built chat with the rest of it', () => {
    const key = 'cache-forget/Agent'
    const chats = chatWith()
    reached(chats, key, { kind: 'agent', id: 'a1', at: 1000, text: 'Hello.' })
    chats.chat(key)
    const built = chats.chatBuilds
    chats.forget(key)
    const after = chats.chat(key)
    expect(chats.chatBuilds).toBe(built + 1)
    expect(after.messages).toHaveLength(0)
  })

  test('nextClose finds the first close strictly after a time, on a sorted list', () => {
    expect(nextClose([10, 20, 20, 50], 0)).toBe(10)
    expect(nextClose([10, 20, 20, 50], 10)).toBe(20)
    expect(nextClose([10, 20, 20, 50], 20)).toBe(50)
    expect(nextClose([10, 20, 20, 50], 50)).toBeUndefined()
    expect(nextClose([], 5)).toBeUndefined()
  })

  test('a 2,000-event chat with 200 cards builds once, within a time bound', () => {
    const key = 'cache-big/Agent'
    const chats = chatWith()
    const at = Date.now()
    const ev: object[] = []
    for (let i = 0; i < 2000; i++) {
      const kind = i % 3 === 0 ? 'peer' : i % 3 === 1 ? 'agent' : 'question'
      ev.push(
        kind === 'question'
          ? { kind, id: `e${i}`, at: at + i, items: [{ question: 'Pick?', options: [{ label: 'A' }], multiSelect: false }] }
          : { kind, id: `e${i}`, at: at + i, text: kind === 'peer' ? 'Relayed: go.' : 'A reply.' },
      )
    }
    reached(chats, key, ...ev)
    for (let i = 0; i < 200; i++) chats.post(key, { id: `ask:${i}`, at: at + i * 10, question: question(`ask:${i}`) })
    const t0 = performance.now()
    const chat = chats.chat(key)
    const buildMs = performance.now() - t0
    expect(chat.messages.length).toBeGreaterThan(200)
    expect(buildMs).toBeLessThan(1000)
    const built = chats.chatBuilds
    chats.chat(key)
    chats.chat(key)
    expect(chats.chatBuilds).toBe(built)
  })
})

describe('a log read again from its start', () => {
  /** a pi log with a session line and one message per text */
  const piLog = (lines: { role: 'user' | 'assistant'; text: string }[], n = 0) => [
    { type: 'session', version: 3, id: 'sw-1', timestamp: '2026-10-13T20:52:53.359Z', cwd: '/w' },
    ...lines.map((l, i) => ({
      type: 'message',
      id: `e${n + i}`,
      parentId: null,
      timestamp: 1000 + n + i,
      message: { role: l.role, content: [{ type: 'text', text: l.text }], timestamp: 1000 + n + i },
    })),
  ]

  test('a log written again whole (a store mirror, a rotated file) says nothing twice', () => {
    const dir = tmp('chat-reread')
    const file = join(dir, 'session.jsonl')
    const key = 'reread/Agent'
    const body = piLog([
      { role: 'user', text: 'Hello.' },
      { role: 'assistant', text: 'Hi there.' },
    ])
    writeFileSync(file, `${body.map((l) => JSON.stringify(l)).join('\n')}\n`)
    const agents = { ...agentsForChat(), record: () => ({ kind: 'pi', logs: [file] }) }
    const chats = chatWith(agents as never)
    expect(chats.chat(key).messages.map((m) => [m.who, m.text])).toEqual([
      ['you', 'Hello.'],
      ['agent', 'Hi there.'],
    ])
    // the same log again, whole, under a new file (as a mirror written again is), and one more message with it
    const written = [...body, ...piLog([{ role: 'user', text: 'One more.' }], 10)]
    const tmpFile = join(dir, 'session.new')
    writeFileSync(tmpFile, `${written.map((l) => JSON.stringify(l)).join('\n')}\n`)
    renameSync(tmpFile, file)
    expect(chats.chat(key).messages.map((m) => [m.who, m.text])).toEqual([
      ['you', 'Hello.'],
      ['agent', 'Hi there.'],
      ['you', 'One more.'],
    ])
  })
})

/* SHE-99: parsed chat events are bounded; an idle chat rebuilds its history when it is opened again */

const idleAgents = (status: (key: string) => string = () => 'gone', record: (key: string) => object | undefined = () => undefined) => ({ ...agentsForChat(), status, record })

const withClock = <T>(fn: (advance: (ms: number) => void) => T): T => {
  const real = Date.now
  let at = 1_700_000_000_000
  Date.now = () => at
  try {
    return fn((ms) => {
      at += ms
    })
  } finally {
    Date.now = real
  }
}

const evLines = (key: string, n: number) => Array.from({ length: n }, (_, i) => ({ kind: i % 2 ? 'agent' : 'user', id: `${key}-${i}`, at: 1000 + i, text: `A line ${i}.` }))

/** a pi log of one message per text, written where a chat's reader finds it */
const piFile = (dir: string, texts: string[], id: string) => {
  const file = join(dir, 'session.jsonl')
  const lines = [
    { type: 'session', version: 3, id, timestamp: '2026-10-13T20:52:53.359Z', cwd: '/w' },
    ...texts.map((text, i) => ({
      type: 'message',
      id: `e${i}`,
      parentId: null,
      timestamp: 1000 + i,
      message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text }], timestamp: 1000 + i },
    })),
  ]
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  return file
}

describe('chat events kept in memory', () => {
  test('a sweep caps the events kept across many chats, dropping the least recently read first', () => {
    withClock((advance) => {
      const chats = chatWith(idleAgents())
      chats.maxEvents = 100
      chats.idleMs = Infinity
      for (let c = 0; c < 10; c++) {
        const key = `cap-${c}/Agent`
        reached(chats, key, ...evLines(key, 30))
        chats.seen(key)
        advance(1000)
      }
      expect(chats.memory().events).toBe(300)
      expect(chats.memory().holders[0]?.events).toBe(30)
      const out = chats.sweep()
      expect(out.evicted).toBe(7)
      expect(out.events).toBe(90)
      expect(chats.memory().events).toBeLessThanOrEqual(chats.maxEvents)
      const kept = chats.memory().holders.map((h) => h.key)
      expect(kept).not.toContain('cap-0/Agent')
      expect(kept).toContain('cap-9/Agent')
    })
  })

  test('a chat no one has read for hours is evicted, and a fresh read keeps it', () => {
    withClock((advance) => {
      const chats = chatWith(idleAgents())
      chats.maxEvents = Infinity
      const key = 'idle/Agent'
      reached(chats, key, ...evLines(key, 5))
      chats.seen(key)
      expect(chats.sweep().evicted).toBe(0)
      advance(chats.idleMs - 1000)
      expect(chats.sweep().evicted).toBe(0)
      advance(2000)
      expect(chats.sweep().evicted).toBe(1)
      expect(chats.memory().events).toBe(0)
      chats.seen(key)
      reached(chats, key, ...evLines(key, 5))
      expect(chats.sweep().evicted).toBe(0)
      expect(chats.memory().events).toBe(5)
    })
  })

  test('an evicted chat rebuilds its whole history on the next open, not on a background pull', () => {
    withClock((advance) => {
      const dir = tmp('chat-evict')
      const file = piFile(
        dir,
        Array.from({ length: 8 }, (_, i) => `Line ${i}.`),
        'ev-1',
      )
      const key = 'evict/Agent'
      const record = { kind: 'pi', logs: [file], finished: true }
      const chats = chatWith(idleAgents(undefined, () => record))
      const before = chats.chat(key).messages.map((m) => [m.who, m.text])
      expect(before.length).toBe(8)
      // its first load starts the idle window: a chat pulled a moment ago is not one nobody read for hours
      expect(chats.sweep().evicted).toBe(0)
      advance(chats.idleMs + 1000)
      expect(chats.sweep().evicted).toBe(1)
      expect(chats.memory().events).toBe(0)
      // the periodic passes leave it cold: nothing is reread until a chat() shows it again
      expect(chats.pull(key)).toBe(false)
      expect(chats.memory().events).toBe(0)
      expect(chats.chat(key).messages.map((m) => [m.who, m.text])).toEqual(before)
      expect(chats.memory().events).toBeGreaterThan(0)
    })
  })

  test('a chat whose agent starts again reads its new log lines without waiting to be opened', () => {
    withClock((advance) => {
      const dir = tmp('chat-resume')
      const file = piFile(dir, ['Hello.'], 're-1')
      const key = 'resume/Agent'
      const record = { kind: 'pi', logs: [file], finished: true }
      const chats = chatWith(idleAgents(undefined, () => record))
      expect(chats.chat(key).messages.map((m) => m.text)).toEqual(['Hello.'])
      advance(chats.idleMs + 1000)
      expect(chats.sweep().evicted).toBe(1)
      // the task is worked on again: its agent resumes the same session and writes a new line
      record.finished = false
      const next = { type: 'message', id: 'e1', parentId: null, timestamp: 2000, message: { role: 'assistant', content: [{ type: 'text', text: 'Back at it.' }], timestamp: 2000 } }
      writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify(next)}\n`)
      expect(chats.pull(key)).toBe(true)
      expect(chats.chat(key).messages.map((m) => m.text)).toEqual(['Hello.', 'Back at it.'])
    })
  })

  test('a chat the screen watches again is read without waiting to be opened', () => {
    withClock((advance) => {
      const dir = tmp('chat-watch-again')
      const file = piFile(dir, ['Hello.'], 'wa-1')
      const key = 'watch-again/Agent'
      let watching = false
      const chats = chatWith(
        idleAgents(undefined, () => ({ kind: 'pi', logs: [file], finished: true })),
        (k) => watching && k === key,
      )
      chats.chat(key)
      advance(chats.idleMs + 1000)
      expect(chats.sweep().evicted).toBe(1)
      watching = true
      expect(chats.pull(key)).toBe(true)
      expect(chats.memory().events).toBeGreaterThan(0)
    })
  })

  test('a watched chat, a live agent, an open question, a card and a reading log are never evicted', () => {
    const watched = 'watched/Agent'
    const working = 'working/Agent'
    const blocked = 'blocked/Agent'
    const live = 'live/Agent'
    const question = 'question/Agent'
    const card = 'card/Agent'
    const reading = 'reading/Agent'
    const menus = 'menus/Agent'
    const idle = 'idle/Agent'
    const statuses: Record<string, string> = { [working]: 'working', [blocked]: 'blocked' }
    const records = new Map<string, object>([[live, { kind: 'pi', logs: [], started: 0 }]])
    const chats = chatWith(
      idleAgents(
        (k) => statuses[k] ?? 'gone',
        (k) => records.get(k),
      ),
      (k) => k === watched,
    )
    chats.maxEvents = 0
    for (const key of [watched, working, blocked, live, question, card, reading, menus, idle]) reached(chats, key, ...evLines(key, 4))
    reached(chats, question, {
      kind: 'question',
      id: 'q1',
      at: 2000,
      items: [{ question: 'Pick?', options: [{ label: 'A' }], multiSelect: false }],
    })
    chats.post(card, { id: 'ask:1', at: 2000, question: { id: 'ask:1', title: 'Pick?', kind: 'Plan', choices: [{ label: 'A' }], to: 'You' } })
    chats.showStartMenu(menus, { title: 'Trust?', choices: ['Yes'], cursor: 0, screen: 'Trust?', all: 'Trust?' })
    ;(chats as unknown as { reading: Set<string> }).reading.add(reading)
    ;(chats as unknown as { commandMenus: Set<string> }).commandMenus.add(menus)
    ;(chats as unknown as { events: Map<string, object[]> }).events.set('empty/Agent', [])
    expect(chats.sweep().evicted).toBe(1)
    const kept = chats.memory().holders.map((h) => h.key)
    for (const key of [watched, working, blocked, live, question, card, reading, menus]) expect(kept).toContain(key)
    expect(kept).not.toContain(idle)
  })
})
