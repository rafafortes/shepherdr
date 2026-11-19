// A chat push sends the whole chat as JSON, so every message is a fresh object even when nothing about it changed.
// Rows are therefore memoized by what a message says, not by its identity: a chat update redraws only the rows whose
// message, or the small bits beside it, actually changed.

import { memo, type ComponentType } from 'react'
import type { Chat, Message } from '@shared/types.ts'

/** Keep the current chat outside the rows' props: a memo keeps its previous props, so a whole chat snapshot in every
 *  row would pin a full copy of every message in each one. A row takes the chat only while it is actually rendering. */
const current = new Map<string, Chat>()
export const rememberChat = (chat: Chat) => current.set(chat.key, chat)
export const currentChat = (key: string): Chat => current.get(key)!

export const sameMessage = (a: Message, b: Message): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

const sameMsgs = (a: Message[] | undefined, b: Message[] | undefined): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((m, i) => sameMessage(m, b[i])))

/** Wrap a chat row so a push redraws it only when its message changes. Everything else it gets is a key, a string, a
 *  flag or an outbox entry, compared by identity. The chat itself is not a prop at all (see currentChat). */
export function memoRow<P extends { msg?: Message; msgs?: Message[] }>(View: ComponentType<P>) {
  return memo(View, (a: P, b: P) => {
    const am = a.msg ?? a.msgs?.[0]
    const bm = b.msg ?? b.msgs?.[0]
    if ((am || bm) && (!am || !bm || !sameMessage(am, bm))) return false
    if (!sameMsgs(a.msgs, b.msgs)) return false
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])] as (keyof P)[]) {
      if (k === 'msg' || k === 'msgs') continue
      if (!Object.is(a[k], b[k])) return false
    }
    return true
  })
}

/** Test hook for the render counter in test/layout-chat-rows.test.ts; the app never sets this global. */
export function countRender(key: string) {
  const counts = (globalThis as { shepRenderCount?: Record<string, number> }).shepRenderCount
  if (counts) counts[key] = (counts[key] ?? 0) + 1
}
