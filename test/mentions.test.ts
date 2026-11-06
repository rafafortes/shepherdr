// The words of a mention in a chat (plugins/chat/mentions.ts): what is typed, what a pick becomes at Send, and what a
// message draws. The round trip matters: what Send writes is what the CLI's log hands back, as text.
import { describe, expect, test } from 'bun:test'
import { expand, forMarkdown, fromFragment, hasMention, matchSpaces, matchTasks, mentionTyping, plain, put, split, taskToken } from '../plugins/chat/mentions.ts'
import type { Place, Task } from '../shared/types.ts'

const space = { id: 'p:vm-str:gtm', name: 'gtm', machine: 'vm-str', level: 2, status: 'idle', mode: 'regular', chat: 'p:vm-str:gtm' } as Place
const home = { id: 'p:vm-str:home', name: 'home', machine: 'vm-str', level: 2, status: 'idle', mode: 'regular', chat: 'p:vm-str:home' } as Place
const picked = [
  { kind: 'space', id: space.id, name: space.name },
  { kind: 'task', id: 'SHE-12', ref: 'SHE-12' },
] as const

describe('what is typed in the box', () => {
  test('# lists the spaces and @ the tasks, from the caret', () => {
    expect(mentionTyping('hi #')).toEqual({ kind: 'space', word: '', from: 3, to: 4 })
    expect(mentionTyping('hi #gt')).toEqual({ kind: 'space', word: 'gt', from: 3, to: 6 })
    expect(mentionTyping('@SHE-1')).toEqual({ kind: 'task', word: 'SHE-1', from: 0, to: 6 })
    // in the middle of the words: the word before the caret, what follows stays
    expect(mentionTyping('#gtm then', 4)).toEqual({ kind: 'space', word: 'gtm', from: 0, to: 4 })
    expect(mentionTyping('a (#s', 5)).toEqual({ kind: 'space', word: 's', from: 3, to: 5 })
  })

  test('never inside a word, so a heading, an email or a link is only words', () => {
    expect(mentionTyping('write to a@b.com')).toBeNull()
    expect(mentionTyping('see https://example.com/#top')).toBeNull()
    // a markdown heading is typed whole, with its space: only "#rel" opens a list
    expect(mentionTyping('# Release notes')).toBeNull()
    // the caret inside a word that is being typed is not its end
    expect(mentionTyping('#gtmx', 4)).toBeNull()
    expect(mentionTyping('nothing here')).toBeNull()
  })

  test('a pick goes in as words, and the mention is written at Send', () => {
    const t = mentionTyping('look at #gt')!
    expect(put('look at #gt', t, '#gtm ')).toEqual({ text: 'look at #gtm ', caret: 13 })
    expect(expand('look at #gtm and #gtm again', [...picked])).toBe(`look at [#gtm](space:${space.id}) and [#gtm](space:${space.id}) again`)
    expect(expand('ask @she-12 to look', [...picked])).toBe('ask [@SHE-12](task:SHE-12) to look')
  })

  test('a word typed by hand, never picked, is only words', () => {
    expect(expand('see #home and #gtm', [{ kind: 'space', id: space.id, name: 'gtm' }])).toBe(`see #home and [#gtm](space:${space.id})`)
    // and a letter straight before it is not a mention either
    expect(expand('x#gtm', [...picked])).toBe('x#gtm')
  })

  test('a sentence typed after a pick keeps its punctuation', () => {
    expect(expand('look at #gtm.', [...picked])).toBe(`look at [#gtm](space:${space.id}).`)
    expect(expand('ask @SHE-12.', [...picked])).toBe('ask [@SHE-12](task:SHE-12).')
  })

  test('what Send wrote is what the log hands back: expanding it again changes nothing', () => {
    const once = expand('ask @SHE-12 about #gtm', [...picked])
    expect(expand(once, [...picked])).toBe(once)
    expect(split(once)).toEqual([
      { text: 'ask ' },
      { mention: { kind: 'task', ref: 'SHE-12', id: 'SHE-12' } },
      { text: ' about ' },
      { mention: { kind: 'space', name: 'gtm', id: space.id } },
    ])
  })
})

describe('a message with a mention', () => {
  test('a "#" names a space and a "@" a task: the other way round is words', () => {
    expect(hasMention('nothing')).toBe(false)
    expect(split('a [#x](task:x) b')).toEqual([{ text: 'a [#x](task:x) b' }])
    expect(split(`[#gtm](space:${space.id})`)).toEqual([{ mention: { kind: 'space', name: 'gtm', id: space.id } }])
    expect(hasMention(taskToken({ kind: 'task', ref: 'SHE-12', id: 'SHE-12' }))).toBe(true)
  })

  test("an agent's markdown keeps its mentions, and its code keeps its words", () => {
    const token = `[#gtm](space:${space.id})`
    expect(forMarkdown(`hello ${token}`)).toBe(`hello [#gtm](#space=${encodeURIComponent(space.id)})`)
    // markdown's own marks are left alone
    expect(forMarkdown('# Heading\n\n[a link](https://example.com)')).toBe('# Heading\n\n[a link](https://example.com)')
    expect(forMarkdown(`mail a@b.com`)).toBe('mail a@b.com')
    // code is code: a mention in it stays as it was written
    expect(forMarkdown(`run \`echo ${token}\``)).toBe(`run \`echo ${token}\``)
    expect(forMarkdown(`\`\`\`\n${token}\n\`\`\``)).toBe(`\`\`\`\n${token}\n\`\`\``)
    // an indented block is code too
    expect(forMarkdown(`    ${token}`)).toBe(`    ${token}`)
  })

  test('a quote names the mention as the space is called now, or as its words were', () => {
    const snap = { places: [{ ...space, name: 'renamed' }], tasks: [] } as unknown as Parameters<typeof plain>[1]
    expect(plain(`see [#gtm](space:${space.id}) and [@SHE-12](task:SHE-12)`)).toBe('see #gtm and @SHE-12')
    expect(plain(`see [#gtm](space:${space.id})`, snap)).toBe('see #renamed')
    expect(plain('no mentions here', snap)).toBe('no mentions here')
  })

  test('a fragment link is the mention it was made from', () => {
    const token = taskToken({ kind: 'task', ref: 'SHE-12', id: 'p:vm-str:task' })
    const href = forMarkdown(token).slice(forMarkdown(token).indexOf('](#') + 2, -1)
    expect(fromFragment(href)).toEqual({ kind: 'task', id: 'p:vm-str:task', ref: '' })
    expect(fromFragment('#space=p%3Avm-str%3Agtm')).toEqual({ kind: 'space', id: 'p:vm-str:gtm', name: '' })
    expect(fromFragment('https://example.com')).toBeNull()
  })
})

const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task =>
  ({ id, name: `Task ${id}`, status, place: 'p:vm-str:gtm', state: '', on: 'pi', created: '', ...extra }) as Task

describe('the lists', () => {
  test('tasks: waiting on you and at work first, Done last, archived never', () => {
    const all = [task('A-1', 'done'), task('A-2', 'work'), task('A-3', 'need'), task('A-4', 'todo'), task('A-5', 'need', { archived: 1 })]
    expect(matchTasks(all, '').map((t) => t.id)).toEqual(['A-3', 'A-2', 'A-4', 'A-1'])
    expect(matchTasks([], 'x')).toEqual([])
  })

  test('tasks: an id that starts with what is typed comes before one that holds it', () => {
    const all = [task('B-1', 'need', { name: 'SHE-12 follow-up' }), task('SHE-12', 'done'), task('SHE-120', 'work')]
    expect(matchTasks(all, 'she-12').map((t) => t.id)).toEqual(['SHE-12', 'SHE-120', 'B-1'])
    // a word that is no id: the ids that start with it first, then the task whose title holds it
    expect(matchTasks(all, 'she-1').map((t) => t.id)).toEqual(['SHE-120', 'SHE-12', 'B-1'])
  })

  test('spaces: the name that starts with it first, then one that holds it or its machine', () => {
    const places = [space, home, { id: 'p:mac:gtm-docs', name: 'gtm-docs', machine: 'mac', level: 2, status: 'idle', mode: 'regular', chat: 'p:mac:gtm-docs' } as Place]
    expect(matchSpaces(places, 'gtm').map((p) => p.id)).toEqual(['p:vm-str:gtm', 'p:mac:gtm-docs'])
    expect(matchSpaces(places, 'mac').map((p) => p.id)).toEqual(['p:mac:gtm-docs'])
    // the stored place itself, which everything else here names
    expect(matchSpaces(places, 'gtm').map((p) => p.id)).toEqual(['p:vm-str:gtm', 'p:mac:gtm-docs'])
    // nothing typed: every space, in the sidebar's order
    expect(matchSpaces(places, '')).toHaveLength(3)
  })
})
