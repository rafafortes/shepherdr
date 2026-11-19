// The chat's windowed message list, tested without a browser (the DOM cap and the sentinel are
// test/layout-chat-window.test.ts): the floor on the first rendered row, its reveal by scroll (one batch at a
// time) and by a jump to a message (up to that row), and the row map a jump finds its row by.
import { describe, expect, test } from 'bun:test'
import { CHAT_BATCH, CHAT_WINDOW, floorOf, revealChat, revealMore, setRows, subscribeFloor, topOf } from '../plugins/chat/windowing.ts'

/** one row index per message, a long chat's list as Messages builds it */
const rows = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`m${i}`, i]))

describe('the window over the rows', () => {
  test('a short chat renders everything, and there is nothing more to reveal', () => {
    const A = 'chat-a'
    setRows(A, new Map())
    expect(topOf(A, 50)).toBe(0)
    revealMore(A, 0)
    expect(floorOf(A)).toBe(Infinity)
    expect(topOf(A, 50)).toBe(0)
  })

  test('a long chat renders its last window, with the rest in batches', () => {
    const B = 'chat-b'
    setRows(B, rows(500))
    expect(topOf(B, 500)).toBe(500 - CHAT_WINDOW)
    // the reader's floor (what the sentinel would reveal from) is its clamped top, not the raw floor
    expect(topOf(B, 500)).toBe(3 * CHAT_BATCH)
  })

  test('scrolling up reveals batch by batch, down to the start, and never past it', () => {
    const C = 'chat-c'
    let seen = 0
    const off = subscribeFloor(C)(() => seen++)
    setRows(C, rows(350))
    expect(topOf(C, 350)).toBe(150)
    revealMore(C, topOf(C, 350))
    expect(topOf(C, 350)).toBe(50)
    revealMore(C, topOf(C, 350))
    expect(topOf(C, 350)).toBe(0)
    // at the start there is nothing more to reveal, and asking again changes nothing
    revealMore(C, topOf(C, 350))
    expect(topOf(C, 350)).toBe(0)
    expect(seen).toBe(2)
    off()
    revealMore(C, topOf(C, 350))
    expect(seen).toBe(2)
  })

  test('a jump puts its row in the window, and only the rows before it go away', () => {
    const D = 'chat-d'
    setRows(D, rows(400))
    expect(topOf(D, 400)).toBe(200)
    // a jump to a message in the rendered window reveals nothing
    revealChat(D, 'm399')
    expect(topOf(D, 400)).toBe(200)
    // one above the window reveals up to its row
    revealChat(D, 'm199')
    expect(topOf(D, 400)).toBe(199)
    // and a later jump further up reveals further
    revealChat(D, 'm40')
    expect(topOf(D, 400)).toBe(40)
    // a message the window does not know (it came in after the rows were built) reveals nothing until the next draw
    revealChat(D, 'm-new')
    expect(topOf(D, 400)).toBe(40)
  })

  test('an album row is found by any of its parts', () => {
    const E = 'chat-e'
    const e = rows(300)
    // one album row (two pictures of one send) is one row of the list, known by both of its parts
    e.set('pic-1', 60)
    e.set('pic-2', 60)
    setRows(E, e)
    expect(topOf(E, 300)).toBe(100)
    revealChat(E, 'pic-2')
    expect(topOf(E, 300)).toBe(60)
  })

  test('one chat window does not move another', () => {
    const F = 'chat-f'
    const G = 'chat-g'
    setRows(F, rows(400))
    setRows(G, rows(400))
    revealMore(F, topOf(F, 400))
    expect(topOf(F, 400)).toBe(100)
    expect(topOf(G, 400)).toBe(200)
  })

  test('the numbers the screen counts against: at most the window plus what was revealed', () => {
    expect(CHAT_WINDOW + CHAT_BATCH).toBe(300)
    expect(topOf('chat-b', 1000)).toBe(1000 - CHAT_WINDOW)
  })
})
