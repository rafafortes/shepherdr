// The chat renders its last rows, and grows upwards when the reader scrolls to the top: an "earlier" sentinel above
// the rendered window, each pass revealing another batch. The list pins to its end and the rows have variable
// heights (markdown, code, cards), so there is no virtual list library: the DOM grows in batches and stays put, and
// src/scrolling.ts and useArrive work on the natural layout.
//
// The window is a floor on the first rendered row, by its index in the list Messages builds (the chat's messages and
// what you sent, in time order, pictures of one send folded into one album row). It is the last CHAT_WINDOW rows by
// default, and moves up — never back down on its own — when the reader reveals more:
//   - the reader's own scroll into the top (or a tap on the sentinel): one batch at a time;
//   - a jump to a message (a reply's quote, search in the chat, an alert's link): up to that row, so the jump has
//     something to bring into view.
// What is outside the window is still in the store and in chat.messages: the outbox settles against the whole
// array, and search finds across it; only what is drawn is limited.

/** the newest rows rendered at once, and how many more the sentinel reveals at a time */
export const CHAT_WINDOW = 200
export const CHAT_BATCH = 100

/** how close to the top (px) counts as "the reader is at the top": within this, their own scroll reveals the
 *  previous batch (the sentinel's own pass rests further down after the compensation, so it can't reveal on its
 *  own) */
const EDGE = 48

interface Window {
  /** the floor the reader has revealed to, by row index (Infinity: only the last window) */
  top: number
  /** where each message sits in the rows, built by Messages as it draws them (an album: all of its parts) */
  rowOf: Map<string, number>
  /** how many rows Messages built, so a jump knows which of them are already on screen */
  count: number
  subs: Set<() => void>
}

const windows = new Map<string, Window>()

function of(chat: string): Window {
  let w = windows.get(chat)
  if (!w) {
    w = { top: Infinity, rowOf: new Map(), count: 0, subs: new Set() }
    windows.set(chat, w)
  }
  return w
}

const emit = (chat: string) =>
  windows.get(chat)?.subs.forEach((l) => {
    l()
  })

/** the first rendered row: the last window, or higher where the reader has revealed it */
export function topOf(chat: string, count: number): number {
  const last = Math.max(0, count - CHAT_WINDOW)
  return Math.max(0, Math.min(last, of(chat).top))
}

/** what useSyncExternalStore reads: the revealed floor (a jump or a scroll changing it redraws the window) */
export const floorOf = (chat: string) => windows.get(chat)?.top ?? Infinity

/** Messages calls it as it builds the rows, so a jump can find a message's row before it is drawn */
export function setRows(chat: string, rowOf: Map<string, number>, count: number) {
  const w = of(chat)
  w.rowOf = rowOf
  w.count = count
}

/** one more batch (top: the first rendered row now): nothing when there is nothing hidden above the window */
export function revealMore(chat: string, top: number) {
  const w = of(chat)
  const next = Math.max(0, top - CHAT_BATCH)
  if (top > 0 && next < w.top) {
    w.top = next
    emit(chat)
  }
}

/** a jump to a message: reveal up to its row (itself, or the row its album sits in) so it is in the DOM. A row
 *  already in the window is no reveal — pinning the floor there would stop the window following new messages */
export function revealChat(chat: string, id: string) {
  const w = of(chat)
  const idx = w.rowOf.get(id)
  if (idx !== undefined && idx < topOf(chat, w.count)) {
    w.top = idx
    emit(chat)
  }
}

/** the reader's own steps into the top: scrolling near it, a wheel up or an arrow key while near it. Each one
 *  asks for a batch; what lands in view is the reader's decision from there. The list itself does not scroll (its
 *  box does), so the top is read from the nearest scrollable ancestor, one frame after the event (the scroll event
 *  lands before the layout the reader's step caused) */
export function watchReveal(list: HTMLElement, by: () => void) {
  const scroller = (list.closest?.('.overflow-y-auto') ?? list) as HTMLElement
  // the listeners are on the window (a scroller may be replaced); only this chat's own box counts
  const ours = (e: Event) => e.target instanceof Node && (e.target === scroller || scroller.contains(e.target))
  const near = () => requestAnimationFrame(() => scroller.scrollTop < EDGE && by())
  const onScroll = (e: Event) => ours(e) && near()
  const onWheel = (e: WheelEvent) => ours(e) && e.deltaY < 0 && near()
  const onKey = (e: KeyboardEvent) => ours(e) && (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') && near()
  addEventListener('scroll', onScroll, { capture: true, passive: true })
  addEventListener('wheel', onWheel, { capture: true, passive: true })
  addEventListener('keydown', onKey, { capture: true, passive: true })
  return () => {
    removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions)
    removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
    removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions)
  }
}

/** a stable subscribe per chat, for useSyncExternalStore */
export function subscribeFloor(chat: string) {
  return (l: () => void) => {
    const w = of(chat)
    w.subs.add(l)
    return () => {
      w.subs.delete(l)
    }
  }
}
