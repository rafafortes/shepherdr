import { describe, expect, test } from 'bun:test'
import { DemoWorld } from '../server/demo/world.ts'
import { searchCapped, searchChats, searchExcerpt, searchResults, SEARCH_HITS_PER_KIND, SEARCH_MESSAGE_WINDOW } from '../plugins/keyboard/search-data.ts'
import { findIn } from '../plugins/chat/days.ts'
import type { Chat, Message } from '../shared/types.ts'

const all = { kind: 'all' } as const
const pName = (snap: ReturnType<DemoWorld['snapshot']>, id: string) => snap.places.find((p) => p.id === id)!.name

describe('unified search identities, scope and privacy', () => {
  test('all machine homes with duplicate names stay separate and have machine context', () => {
    const snap = new DemoWorld().snapshot()
    const homes = searchResults(snap, all, 'home', {}).filter((h) => h.kind === 'Spaces')
    expect(homes.length).toBeGreaterThan(1)
    expect(new Set(homes.map((h) => h.key)).size).toBe(homes.length)
    expect(new Set(homes.map((h) => h.context)).size).toBe(homes.length)
    for (const h of homes) expect(h.place).toBe(snap.places.find((p) => p.id === h.place)!.id)
  })

  test('chat, space, machine and everywhere broaden the same private sources without duplicates', () => {
    const snap = new DemoWorld().snapshot()
    const t = snap.tasks.find((t) => t.agent)!
    const chat = t.agent!.chat
    expect(searchChats(snap, { kind: 'chat', id: chat }).map((c) => c.key)).toEqual([chat])
    const space = searchChats(snap, { kind: 'space', id: t.place })
    expect(space.every((c) => c.place === t.place)).toBe(true)
    expect(space.map((c) => c.key)).toContain(chat)
    const results = searchResults(snap, all, `${pName(snap, t.place)} ${t.name}`, {})
    expect(results.some((h) => h.task === t.id)).toBe(true)
    const p = snap.places.find((p) => p.id === t.place)!
    const machine = searchChats(snap, { kind: 'machine', id: p.machine })
    expect(machine.length).toBeGreaterThanOrEqual(space.length)
    const global = searchChats(snap, all)
    expect(global.length).toBeGreaterThan(machine.length)
    expect(new Set(global.map((c) => c.key)).size).toBe(global.length)
  })

  test('message matching has chat-search parity and keeps the exact chat and message ids', () => {
    const snap = new DemoWorld().snapshot()
    const c = searchChats(snap, all)[0]
    const messages: Message[] = [
      { id: 'link', who: 'agent', text: 'See **the** [docs](https://hidden-address.example)' },
      { id: 'file', who: 'you', file: { name: 'the docs.pdf', path: '/private/unsearchable' } },
      { id: 'question', who: 'agent', question: { id: 'q', title: 'The docs ready?', kind: 'Question', choices: [], to: 'agent' } },
      { id: 'waiting', who: 'you', text: 'the docs', waiting: true },
      { id: 'late', who: 'agent', text: `${'Intro '.repeat(100)}the docs at the end`, at: 10 },
    ]
    const chats = { [c.key]: { key: c.key, cli: 'Codex', messages } }
    const hits = searchResults(snap, { kind: 'chat', id: c.key }, 'THE DOCS', chats).filter((h) => h.kind === 'Messages')
    expect(hits.map((h) => h.message).sort()).toEqual(findIn(messages, 'THE DOCS').sort())
    expect(hits.every((h) => h.chat === c.key)).toBe(true)
    expect(hits.find((h) => h.message === 'late')?.label).toContain('the docs')
    expect(searchResults(snap, all, 'hidden-address', chats).filter((h) => h.kind === 'Messages')).toEqual([])
    expect(searchResults(snap, all, 'unsearchable', chats).filter((h) => h.kind === 'Messages')).toEqual([])
  })

  test('secret cards and tool output are never indexed; settings are read by word, never by value', () => {
    const snap = new DemoWorld().snapshot()
    const c = searchChats(snap, all)[0]
    const chats: Record<string, Chat> = {
      [c.key]: {
        key: c.key,
        cli: 'Codex',
        messages: [
          { id: 'secret', who: 'agent', secret: { id: 'secret', name: 'PRIVATE_TOKEN', why: 'hidden-needle', levels: [] } },
          { id: 'empty', who: 'agent' },
        ],
      },
    }
    // Search reads a setting's words (label, key, hint, group, sub) and where it opens; a value can hold a private
    // instruction or a secret, so reading one here throws and a regression cannot slip in quietly.
    Object.defineProperty(snap, 'settings', {
      value: snap.settings.map((s) => ({
        ...s,
        rows: s.rows.map((r) => {
          const meta = { ...r }
          Object.defineProperty(meta, 'value', {
            get() {
              throw new Error('Search must never read a setting value')
            },
          })
          return meta
        }),
      })),
    })
    expect(searchResults(snap, all, '', chats).some((h) => h.kind === 'Messages')).toBe(false)
    expect(searchResults(snap, all, 'hidden-needle', chats)).toEqual([])
    expect(searchResults(snap, all, 'PRIVATE_TOKEN', chats)).toEqual([])
  })

  test('settings rows match their words at their own level and carry the page and level to open', () => {
    const snap = new DemoWorld().snapshot()
    const rounds = searchResults(snap, all, 'rounds', {}).filter((h) => h.kind === 'Settings')
    expect(rounds.length).toBeGreaterThan(0)
    const row = rounds.find((h) => h.label === 'Review rounds')!
    expect(row.setting).toBe('How tasks work')
    expect(row.level).toBe('all')
    expect(row.context).toContain('How tasks work')
    expect(row.context).toContain('Everywhere')
    // a grouped row is found by its key, and its group and level are shown
    const load = searchResults(snap, { kind: 'machine', id: 'vm-str' }, 'startLoad', {})
      .filter((h) => h.kind === 'Settings')
      .find((h) => h.label === 'Wait while CPU load is over')!
    expect(load.setting).toBe('Machine')
    expect(load.level).toBe('m:vm-str')
    expect(load.context).toContain('Working tasks')
    // a space reads only its own level, never Everywhere's rows or another space's
    const space = searchResults(snap, { kind: 'space', id: 'p:vm-str:~' }, 'rounds', {}).filter((h) => h.kind === 'Settings')
    expect(space.length).toBeGreaterThan(0)
    expect(space.every((h) => h.level === 'p:vm-str:~')).toBe(true)
    expect(space.some((h) => h.label === 'Review rounds')).toBe(true)
    // sections with no page of their own open the page that draws them, and the context names that page
    expect(
      searchResults(snap, all, 'Voice agent', {})
        .filter((h) => h.kind === 'Settings')
        .find((h) => h.label === 'Voice agent')?.setting,
    ).toBe('Voice')
    expect(
      searchResults(snap, all, 'alerts on', {})
        .filter((h) => h.kind === 'Settings')
        .find((h) => h.label === 'Alerts on')?.setting,
    ).toBe('Notifications')
    expect(
      searchResults(snap, all, 'quota.alertAt', {})
        .filter((h) => h.kind === 'Settings')
        .find((h) => h.key.endsWith('quota.alertAt'))?.setting,
    ).toBe('Models')
    // no query keeps 'Recent items' as it was: all 66 rows do not flood the sheet
    expect(searchResults(snap, all, '', {}).some((h) => h.kind === 'Settings')).toBe(false)
  })

  test('archived tasks are found by brief words, keep their identity, and stay out of empty search', () => {
    const snap = new DemoWorld().snapshot()
    const task = snap.tasks[0]
    task.archived = Date.now()
    task.desc = 'needle-in-archived-brief'
    expect(searchResults(snap, all, task.desc, {}).find((h) => h.task === task.id)?.context).toContain('Archived')
    expect(searchResults(snap, all, '', {}).some((h) => h.task === task.id)).toBe(false)
  })

  test('all matches remain available for paging and newest messages come first', () => {
    const snap = new DemoWorld().snapshot()
    const c = searchChats(snap, all)[0]
    const messages = Array.from({ length: 65 }, (_, n): Message => ({ id: `page-${n}`, who: 'agent', text: `paging needle ${n}`, at: n + 1 }))
    const hits = searchResults(snap, all, 'paging needle', { [c.key]: { key: c.key, cli: 'Codex', messages } }).filter((h) => h.kind === 'Messages')
    expect(hits).toHaveLength(65)
    expect(hits[0].message).toBe('page-64')
    expect(searchExcerpt('A'.repeat(500) + 'target word', 'target')).toContain('target word')
  })
})

describe('bounded search loads', () => {
  test('an empty query lists snapshot items only, even when chats are in hand', () => {
    const snap = new DemoWorld().snapshot()
    const c = searchChats(snap, all)[0]
    const chats: Record<string, Chat> = {
      [c.key]: {
        key: c.key,
        cli: 'Codex',
        messages: [
          { id: 'real-a', who: 'agent', text: 'a real message', at: 1 },
          { id: 'real-b', who: 'you', text: 'another real message', at: 2 },
        ],
      },
    }
    const hits = searchResults(snap, all, '', chats)
    expect(hits.some((h) => h.kind === 'Messages')).toBe(false)
    for (const kind of ['Spaces', 'Tasks', 'Artifacts'] as const) expect(hits.some((h) => h.kind === kind)).toBe(true)
  })

  test('only the newest messages of a chat are scanned, and a capped chat is reported', () => {
    const snap = new DemoWorld().snapshot()
    const c = searchChats(snap, all)[0]
    const scope = { kind: 'chat' as const, id: c.key }
    const needle = 'window-needle'
    const messages: Message[] = Array.from({ length: SEARCH_MESSAGE_WINDOW + 20 }, (_, n): Message => ({ id: `m-${n}`, who: 'agent', text: `filler ${n}`, at: n + 1 }))
    messages[2] = { id: 'outside', who: 'agent', text: `old ${needle}`, at: 3 }
    messages[messages.length - 1] = { id: 'inside', who: 'agent', text: `recent ${needle}`, at: messages.length }
    const chats: Record<string, Chat> = { [c.key]: { key: c.key, cli: 'Codex', messages } }
    const hits = searchResults(snap, scope, needle, chats).filter((h) => h.kind === 'Messages')
    expect(hits.map((h) => h.message)).toEqual(['inside'])
    expect(searchCapped(searchChats(snap, scope), chats)).toBe(true)
    expect(searchCapped(searchChats(snap, scope), { [c.key]: { key: c.key, cli: 'Codex', messages: messages.slice(-SEARCH_MESSAGE_WINDOW) } })).toBe(false)
  })

  test('no more than SEARCH_HITS_PER_KIND hits of any one kind are built', () => {
    const snap = new DemoWorld().snapshot()
    const place = snap.places[0]
    const task = snap.tasks[0]
    const artifact = snap.artifacts[0]
    const over = SEARCH_HITS_PER_KIND + 10
    snap.places = Array.from({ length: over }, (_, n) => ({ ...place, id: `cap-place-${n}`, name: `CapSpace ${n}`, chat: `cap-place-${n}` }))
    snap.tasks = Array.from({ length: over }, (_, n) => ({ ...task, id: `CAP-T-${n}`, name: `CapTask ${n}`, agent: undefined }))
    snap.artifacts = Array.from({ length: over }, (_, n) => ({ ...artifact, id: `cap-a-${n}`, title: `CapArt ${n}`, place: place.id }))
    const c = searchChats(snap, all)[0]
    const messages: Message[] = Array.from({ length: over }, (_, n) => ({ id: `cap-m-${n}`, who: 'agent', text: `CapMsg ${n}`, at: n + 1 }))
    const chats: Record<string, Chat> = { [c.key]: { key: c.key, cli: 'Codex', messages } }
    for (const [q, kind] of [
      ['CapSpace', 'Spaces'],
      ['CapTask', 'Tasks'],
      ['CapArt', 'Artifacts'],
      ['CapMsg', 'Messages'],
    ] as const) {
      const hits = searchResults(snap, all, q, chats)
      expect(hits.every((h) => h.kind === kind)).toBe(true)
      expect(hits).toHaveLength(SEARCH_HITS_PER_KIND)
    }
  })
})
