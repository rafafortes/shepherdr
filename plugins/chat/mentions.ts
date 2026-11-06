// Mentions in a chat: "#" in the message box lists the spaces and "@" the tasks, and a picked one travels as plain text,
// `[#gtm](space:p:vm-str:gtm)` or `[@SHE-12](task:SHE-12)`, because that is what the CLI's log hands back: the same
// text comes out of it, so a message draws the mention as a chip that opens the space or the task, and an agent reads
// which one the person meant (skill/shepherdr: Make a mention out of the words). The box holds the readable short form
// (`#gtm`, `@SHE-12`) until Send, so a phone sees plain words while typing.
import type { Place, Snapshot, Status, Task } from '@shared/types.ts'

/** what a mention names: a space by its id (as places have them) or a task by its id */
export type Kind = 'space' | 'task'

/** a mention as a message's words hold it: the name that shows, and the space or task it points at */
export type Mention = { kind: 'space'; name: string; id: string } | { kind: 'task'; ref: string; id: string }

/** a part of a message: its words, or one mention the person picked */
export type Part = { text: string } | { mention: Mention }

/** what to put in the box for a pick, and what its mention says at Send */
export type Picked = { kind: 'space'; id: string; name: string } | { kind: 'task'; id: string; ref: string }

/** what is being typed at the caret: the "#word" or "@word" there, from `from` up to `to` in the box's words */
export type Typing = { kind: Kind; word: string; from: number; to: number }

/** spaces as [#name](space:id), tasks as [@REF](task:id); the words in between are the person's */
const TOKEN = /\[([#@])([^\]\n]{1,80})\]\((space|task):([^)\s]+)\)/g
/** a word of a mention: a space's name (letters, numbers, - and _), a task's id (letters, numbers and -) */
const WORD = /[\w.-]/

/** what a picked space puts in a message */
export const spaceToken = (p: Picked & { kind: 'space' }) => `[#${p.name}](space:${p.id})`

/** what a picked task puts in a message */
export const taskToken = (p: Picked & { kind: 'task' }) => `[@${p.ref}](task:${p.id})`

/** the token of a pick, whatever it is */
export const token = (p: Picked) => (p.kind === 'space' ? spaceToken(p) : taskToken(p))

/** the "#word" or "@word" the caret sits at the end of, else null. Never inside a word (an email's "a@b", a link's
    "#anchor"), so neither fights the words around it */
export function mentionTyping(text: string, caret = text.length): Typing | null {
  if (WORD.test(text.slice(caret, caret + 1))) return null
  const m = /(^|[\s(])([#@])([\w.-]*)$/.exec(text.slice(0, caret))
  if (!m) return null
  return { kind: m[2] === '#' ? 'space' : 'task', word: m[3], from: m.index + m[1].length, to: caret }
}

/** the box after a pick: its "#word" (or "@word") becomes "#gtm " (a task's its id), the caret after it */
export function put(text: string, t: Typing, words: string): { text: string; caret: number } {
  const out = text.slice(0, t.from) + words + text.slice(t.to)
  return { text: out, caret: t.from + words.length }
}

/* ---------- at Send ---------- */

/** the words to send: each "#name" and "@REF" the person picked becomes its mention, and the rest stays as typed. A
    word typed by hand, never picked, is only words */
export function expand(text: string, picks: Picked[]): string {
  if (!picks.length) return text
  const spaces = new Map<string, Picked & { kind: 'space' }>(picks.flatMap((p) => (p.kind === 'space' ? [[p.name, p] as const] : [])))
  const tasks = new Map<string, Picked & { kind: 'task' }>(picks.flatMap((p) => (p.kind === 'task' ? [[p.ref.toLowerCase(), p] as const] : [])))
  // "a sentence ends at #gtm.": the pick is the word less the punctuation the sentence added, and that stays after it
  const word = (w: string) => [w, w.replace(/[.-]+$/, '')]
  const withSpaces = text.replace(/(^|[\s(])#([\w.-]+)(?![\w.-]|\]\()/g, (all, before: string, w: string) => {
    const p = word(w).map((x) => spaces.get(x)).find(Boolean)
    return p ? `${before}${spaceToken(p)}${w.slice(p.name.length)}` : all
  })
  return withSpaces.replace(/(^|[\s(])@([\w.-]+)(?![\w.-]|\]\()/g, (all, before: string, w: string) => {
    const p = word(w.toLowerCase())
      .map((x) => tasks.get(x))
      .find(Boolean)
    return p ? `${before}${taskToken(p)}${w.slice(p.ref.length)}` : all
  })
}

/* ---------- in a message ---------- */

/** does this text hold a mention a message draws */
export const hasMention = (text: string) => /\[[#@][^\]\n]{1,80}\]\((?:space|task):[^)\s]+\)/.test(text)

/** the words of a message and the mentions in it, in order */
export function split(text: string): Part[] {
  const out: Part[] = []
  let at = 0
  for (const m of text.matchAll(TOKEN)) {
    // a "#" is a space and a "@" a task: one of the other is not a mention, just words
    if ((m[1] === '#') !== (m[3] === 'space')) continue
    if (m.index > at) out.push({ text: text.slice(at, m.index) })
    out.push({ mention: m[3] === 'space' ? { kind: 'space', name: m[2], id: m[4] } : { kind: 'task', ref: m[2], id: m[4] } })
    at = m.index + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}

/** a message's words without its mentions' tokens, for a line that only quotes them (a reply's quote): "#gtm",
    "@SHE-12", named as the space or task is called now when `snap` knows it (a quote's words are cut and thinned, so
    its token may be old) */
export const plain = (text: string, snap?: Snapshot | null) =>
  hasMention(text)
    ? split(text)
        .map((p) => {
          if ('text' in p) return p.text
          const named = p.mention.kind === 'space' ? placeOf(snap, p.mention.id)?.name : taskOf(snap, p.mention.id)?.id
          return p.mention.kind === 'space' ? `#${named ?? p.mention.name}` : `@${named ?? p.mention.ref}`
        })
        .join('')
    : text

/** an agent's markdown before it is drawn: each mention as a link to a fragment, which toHtml turns into a chip (a
    fragment survives the sanitizer, "space:" does not); what is in code, inline or a block, keeps its words */
export function forMarkdown(text: string): string {
  if (!hasMention(text)) return text
  const parts = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
  return parts
    .map((part, i) => {
      if (i % 2) return part
      // what comes after a fence or a code span, with a newline before it, starts a line; else it is mid-line
      const startsLine = i === 0 || parts[i - 1].endsWith('\n')
      return part.replace(/\[([#@])([^\]\n]{1,80})\]\((space|task):([^)\s]+)\)/g, (all, mark: string, name: string, kind: string, id: string, offset: number) => {
        if (indentedCode(part, offset, startsLine)) return all
        return (mark === '#') === (kind === 'space') ? `[${mark}${name}](#${kind}=${encodeURIComponent(id)})` : all
      })
    })
    .join('')
}

/** does `at` sit in a block markdown reads as indented code: four spaces or a tab at a line's start, after a blank line
    (a nested list's item is indented without one, and is a paragraph's words, not code) */
function indentedCode(part: string, at: number, startsLine: boolean) {
  const start = part.lastIndexOf('\n', at - 1) + 1
  if (!/^( {4}|\t)/.test(part.slice(start, at))) return false
  if (start === 0) return startsLine
  const before = part.lastIndexOf('\n', start - 2) + 1
  return !part.slice(before, start - 1).trim()
}

/** what a token's fragment link names, or null when it is not one */
export function fromFragment(href: string): Picked | null {
  const m = /^#(space|task)=(.+)$/.exec(href)
  if (!m) return null
  let id = m[2]
  try {
    id = decodeURIComponent(id)
  } catch {
    /* a link written by hand, not encoded: it is its own id */
  }
  return m[1] === 'space' ? { kind: 'space', id, name: '' } : { kind: 'task', id, ref: '' }
}

/* ---------- the lists ---------- */

/** how near the top of the "@" list a task is: waiting on the person and at work first, Done last */
const RANK: Record<Status, number> = { need: 0, work: 1, ready: 2, merging: 3, scheduled: 4, queued: 5, todo: 6, idle: 7, done: 9, off: 9 }

/** a task a mention can name: its id, never one archived (those are out of every list, and search finds them) */
const pickable = (t: Task) => !t.archived && /^[\w.-]+$/.test(t.id)

/** a space by its id, the way a message's mention names it */
export const placeOf = (snap: Snapshot | null | undefined, id: string) => snap?.places.find((p) => p.id === id)

/** a task by its id, the way a mention names it */
export const taskOf = (snap: Snapshot | null | undefined, id: string) =>
  snap?.tasks.find((t) => t.id === id || t.id.toLowerCase() === id.toLowerCase())

/** the spaces for what is typed: names that start with it first, then names or machines that hold it */
export function matchSpaces(places: Place[], word: string, n = 6): Place[] {
  const w = word.toLowerCase()
  const starts = places.filter((p) => p.name.toLowerCase().startsWith(w))
  const has = places.filter((p) => !p.name.toLowerCase().startsWith(w) && (p.name.toLowerCase().includes(w) || (p.machine ?? '').toLowerCase().includes(w)))
  return [...starts, ...has].slice(0, n)
}

/** the tasks for what is typed: ids that start with it first (its own id before a longer one), then ids and titles that
    hold it; within each, waiting on the person and at work first and Done last, so a quiet word reaches what needs an
    eye */
export function matchTasks(tasks: Task[], word: string, n = 8): Task[] {
  const w = word.toLowerCase()
  const live = tasks.filter(pickable)
  const rank = (a: Task, b: Task) => Number(b.id.toLowerCase() === w) - Number(a.id.toLowerCase() === w) || RANK[a.status] - RANK[b.status]
  const starts = live.filter((t) => t.id.toLowerCase().startsWith(w)).sort(rank)
  const has = live
    .filter((t) => !t.id.toLowerCase().startsWith(w) && (t.id.toLowerCase().includes(w) || t.name.toLowerCase().includes(w)))
    .sort(rank)
  return [...starts, ...has].slice(0, n)
}

/** a title short enough for a chip, and for a phone's line */
export const short = (title: string, n = 28) => {
  const t = title.trim()
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}
