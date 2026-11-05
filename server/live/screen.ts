// Reading what a CLI shows on its terminal: the menu of a permission prompt or a startup screen, and the plain questions
// a start stops on. Framed on its own so both a running agent's menu (chats.ts) and a start that never became a turn
// (start.ts) are read the same way. Nothing here knows an agent, a chat or a task.
import { createHash } from 'node:crypto'

/** a menu the CLI shows in its terminal (permission prompts and the like), read from the screen */
export interface ScreenMenu {
  title: string
  choices: string[]
  /** what the CLI shows under each choice, in grey (Claude Code's own questions): none, or one per choice */
  descriptions?: (string | undefined)[]
  /** the choice the CLI's cursor is on */
  cursor: number
  /** Direct keys for y/n prompts; otherwise move the menu cursor and confirm. */
  keys?: string[][]
  multi?: boolean
  selected?: number[]
  reject?: string
  /** The visible prompt, including security context that must not be lost. */
  screen?: string
  /** The whole screen it was read from, as it is: a card is that screen, so a tap needs every word on it to match */
  all?: string
}

/** A card's identity is the screen it was drawn from: the words as they are, in the whole screen, but for what moves
 *  there with no one touching them (the menu's cursor, a spinner's frame, a timer, an activity bar, the helpers it
 *  counts) and for what the card itself shows (a multiple choice's ticks). Any other change is another card, and a tap
 *  on the old one presses nothing. It includes the full permission being granted. */
export function menuId(key: string, m: ScreenMenu) {
  const shown = m.all ?? m.screen
  const screen = shown === undefined ? undefined : screenText(shown, m)
  return `menu:${key}:${createHash('sha256').update(JSON.stringify([m.title, m.choices, screen])).digest('hex').slice(0, 16)}`
}

export function menuKeys(m: ScreenMenu, choice: number, choices?: number[]): string[] | undefined {
  if (m.multi) {
    if (!choices) return
    if (!choices.length && choice === -1) return ['escape']
    if (choices.some((i) => !Number.isInteger(i) || i < 0 || i >= m.choices.length)) return
    const keys: string[] = []
    let cursor = m.cursor
    const move = (to: number) => { const d = to - cursor; keys.push(...Array(Math.abs(d)).fill(d > 0 ? 'down' : 'up')); cursor = to }
    for (let i = 0; i < m.choices.length; i++) if (choices.includes(i) !== !!m.selected?.includes(i)) { move(i); keys.push('space') }
    move(m.choices.length)
    keys.push('enter')
    return keys
  }
  if (!Number.isInteger(choice) || choice < 0 || choice >= m.choices.length) return
  const d = choice - m.cursor
  return m.keys?.[choice] ?? [...Array(Math.abs(d)).fill(d > 0 ? 'down' : 'up'), 'enter']
}

/** Drop shell startup and old output above the prompt's separator. Keep all of the consent text. */
function promptScreen(lines: string[], first: number) {
  for (let i = first - 1; i >= 0; i--) if (/^\s*[╭┌│|]?[─━─]{5,}/.test(lines[i])) return lines.slice(i + 1).join('\n').trim()
  return lines.join('\n').trim()
}

/** Unnumbered arrow menus and single-line confirmations, as used at startup. */
function startupMenu(lines: string[]): ScreenMenu | null {
  const screen = lines.join('\n').trim()
  const clean = (s: string) => s.replace(/^[\s─╭╰]+|[\s─╮╯]+$/g, '').trim()
  // Claude's multi-server MCP consent is a checkbox list followed by a submit row.
  if (/new MCP servers found in this project/i.test(screen) && /Space to select.*Esc to reject all/i.test(screen)) {
    const first = lines.findIndex((l) => /^\s*[❯›>▶]?\s*\[[✔✓x ]\]\s+/.test(l))
    const rows = lines.slice(first).filter((l) => /^\s*[❯›>▶]?\s*\[[✔✓x ]\]\s+/.test(l))
    if (first >= 0 && rows.length) {
      const cursor = rows.findIndex((l) => /[❯›>▶]/.test(l))
      return { title: lines.find((l) => /new MCP servers found in this project/i.test(l))!.trim(), choices: rows.map((l) => l.replace(/^\s*[❯›>▶]?\s*\[[✔✓x ]\]\s+/, '').trim()), cursor: cursor < 0 ? rows.length : cursor, multi: true, selected: rows.flatMap((l, i) => (/\[[✔✓x]\]/.test(l) ? [i] : [])), reject: 'Reject all', screen: promptScreen(lines, first) }
    }
  }
  const cursor = lines.findLastIndex((l) => /^\s*[❯›>▶]\s+\S/.test(l))
  if (cursor >= 0 && /enter.*(?:confirm|select|continue)|[↑↓]|arrow keys/i.test(screen)) {
    const col = lines[cursor].search(/[❯›>▶]/) + 2
    const isOption = (i: number) => i === cursor || (!!lines[i]?.trim() && lines[i].search(/\S/) === col && !/^(?:enter|esc|press |[↑↓]|arrow keys).*?(?:confirm|select|continue|cancel|navigate|back)/i.test(lines[i].trim()))
    let first = cursor, last = cursor
    while (first > 0 && isOption(first - 1)) first--
    while (last + 1 < lines.length && isOption(last + 1)) last++
    if (last > first) {
      const choices = lines.slice(first, last + 1).map((l) => l.replace(/^\s*[❯›>▶]?\s*/, '').trim())
      const context = lines.slice(0, first).map(clean).filter(Boolean)
      const title = context.findLast((l) => /\?|MCP servers? found|trust|accessing workspace/i.test(l)) ?? context.at(-1) ?? 'Choose an option'
      return { title, choices, cursor: cursor - first, screen: promptScreen(lines, first) }
    }
  }
  const yn = screen.match(/([^\n]*?)(?:\[y\/n\]|\(y\/n\)|\[yes\/no\]|\(yes\/no\))\s*[:?]?\s*$/i)
  if (yn) return { title: yn[1].trim() || 'Continue?', choices: ['Yes', 'No'], cursor: 0, keys: [['y', 'enter'], ['n', 'enter']], screen }
  // a numbered picker the CLI ends on a footer ("Choose the text style:", "Select login method:") asks no question, so the
  // numbered reading above found nothing to go by; its footer is what says it is a menu and not a list in a transcript
  if (!menuFooter(screen)) return null
  const OPT = /^\s*([❯›>▶*]\s*)?(\d{1,2})[.)]\s+(.+)$/
  const first = lines.findIndex((l) => OPT.exec(l)?.[2] === '1')
  if (first < 0) return null
  const choices: string[] = []
  let on = -1
  for (let i = first; i < lines.length; i++) {
    const m = OPT.exec(lines[i])
    if (!m) {
      if (!lines[i].trim()) continue
      break
    }
    if (Number(m[2]) !== choices.length + 1) break
    if (m[1]) on = choices.length
    choices.push(m[3].trim())
  }
  if (choices.length < 2) return null
  const context = lines.slice(0, first).map(clean).filter(Boolean)
  return { title: context.at(-1) ?? 'Choose an option', choices, cursor: Math.max(0, on), screen: promptScreen(lines, first) }
}

export function parseMenu(screen: string): ScreenMenu | null {
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, '').replace(/^[\s│|]+|[│|]+$/g, (m) => m.replace(/[│|]/g, ' ')))
  const OPT = /^(\s*)([❯›>▶*]\s*)?(\d{1,2})[.)]\s+(.+)$/
  // the last numbered list on screen that starts at 1
  let first = -1
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    const m = lines[i].match(OPT)
    if (m && m[3] === '1') {
      first = i
      break
    }
  }
  if (first < 0) return startupMenu(lines)
  const opts: { label: string; description?: string; on: boolean }[] = []
  let indent = 0
  // the terminal's width, by its longest line: a line wraps only once the next word would pass it
  const width = Math.max(...lines.map((l) => l.trimEnd().length))
  for (let i = first; i < lines.length; i++) {
    const l = lines[i]
    const m = l.match(OPT)
    if (m && Number(m[3]) === opts.length + 1) {
      opts.push({ label: m[4].trim(), on: !!m[2] })
      indent = m[1].length + (m[2]?.length ?? 0)
      continue
    }
    // an indented line under a choice: the choice wrapping on, or (under a line that had room for more) its description
    if (opts.length && l.trim() && l.search(/\S/) > indent) {
      const o = opts[opts.length - 1]
      const wraps = lines[i - 1].trimEnd().length + 1 + l.trim().split(' ')[0].length > width
      if (o.description !== undefined || !wraps) o.description = o.description === undefined ? l.trim() : `${o.description} ${l.trim()}`
      else o.label += ` ${l.trim()}`
      continue
    }
    if (!l.trim() && opts.length) continue
    break
  }
  if (opts.length < 2) return null
  for (const o of opts) o.label = o.label.replace(/\s*\((esc|enter|tab|[a-z])\)$/i, '').trim()
  // the question: the nearest line above the list with a "?"
  const clean = (x: string) => x.replace(/^[\s╭╰─]+|[\s╮╯─]+$/g, '').trim()
  const asks = /would you like|do you want|allow|proceed|run the following|run this/i
  const marked = [...Array(Math.min(14, first)).keys()].map((k) => first - 1 - k).filter((i) => lines[i].includes('?'))
  const qi = marked.find((i) => asks.test(lines[i])) ?? marked[0] ?? -1
  // a numbered list no question asks about ("Choose the text style", "Select login method:"): the startup shapes read it
  if (qi < 0) return startupMenu(lines)
  // a question that wraps: its lines above, while each goes on from the one before (starts in lower case)
  let top = qi
  while (top > 0 && /^[a-z]/.test(clean(lines[top])) && clean(lines[top - 1])) top--
  const qline = lines.slice(top, qi + 1).map(clean).join(' ')
  const qmark = qline.indexOf('?')
  const question = qline.slice(Math.max(qline.lastIndexOf('. ', qmark) + 1, 0), qmark + 1).trim()
  // the command being asked about, when the CLI shows one between the question and the list
  const shown = lines
    .slice(qi + 1, first)
    .map(clean)
    .filter(Boolean)
  const at = shown.findIndex((l) => l.startsWith('$ '))
  const cmd = (at >= 0 ? shown.slice(at).filter((l, k) => k === 0 || !/[?:]$/.test(l)).join(' ').slice(2) : undefined) ?? lines.slice(Math.max(0, qi - 4), qi).map(clean).filter((l) => l && !/[.:]$/.test(l) && !/^(Bash|Edit|Write|Read)( command)?$/i.test(l)).at(-1)
  const asksToRun = asks.test(question)
  const title = asksToRun && cmd ? `Allow: ${cmd.replace(/\?$/, '')}?` : question
  const descriptions = opts.some((o) => o.description) ? opts.map((o) => o.description) : undefined
  return { title, screen: promptScreen(lines, first), choices: opts.map((o) => o.label), ...(descriptions ? { descriptions } : {}), cursor: Math.max(0, opts.findIndex((o) => o.on)) }
}

/** A frame of the usual Braille spinner or Claude Code's, starting a line, in a box or not: any other symbol there may
 *  mean something of its own (a mark in the text, a bullet), so only these are a spinner. */
const SPINNER = /^([\s│┃]*)[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷✢✳✶✻✽](?=\s|$)/u

/** what only moves while a CLI sits still: its spinner's frames, its timers, an activity bar, the count of helpers it
 *  shows. A percentage it prints is content: a progress that goes from 40 to 70 says something new */
const MOVING = [/\b\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?|mins?|minutes?)\b/gi, /[▁▂▃▄▅▆▇█]+/gu, /[·•]\s*(?:←\s*)?\d+\s*(?:agents?|tasks?|shells?)\b/gi]

/** the footer a CLI puts under a menu it wants answered: "Enter to confirm · Esc to cancel", "Space to select · Esc to
 *  reject all", a y/n prompt. A screen without one is no prompt to press keys in, whatever it looks like. */
export const MENU_FOOTER = /(?:enter|space|tab|↑|↓|arrow keys)[^\n]{0,40}(?:confirm|select|continue|cancel|submit|navigate)|\[y\/n\]|\(y\/n\)/i

/** whether a screen ends on such a footer (looked at on its last lines, where a CLI draws it) */
export function menuFooter(text: string) {
  return MENU_FOOTER.test(text.trimEnd().split('\n').slice(-4).join('\n'))
}

/** a screen without what only moves: two reads of an agent that rested look the same, and a slow start that keeps
 *  saying something new (a step, an agent's words) never does. Only a spinner's frame at a line's start is a spinner */
export function restingScreen(text: string) {
  return text
    .split('\n')
    .map((l) => l.replace(SPINNER, '$1 ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(MOVING[0], ' ')
    .replace(MOVING[1], ' ')
    .replace(MOVING[2], ' ')
}

/**
 * The screen as it is, all but what moves there with no one touching its words (see `menuId`), and the blanks and
 * trailing spaces it drew. Everything else counts, whatever it is — a path, a number, a symbol — so a card is only
 * closed (or a tap only lands) on the screen it was drawn from, not on one that merely looks like it.
 */
export function screenText(text: string, m?: Pick<ScreenMenu, 'choices' | 'cursor' | 'multi'>) {
  const lines = text.split('\n').map((l) => l.replace(SPINNER, '$1 '))
  // the choice the cursor is on: its mark is the cursor, not words, so moving it is no change
  const on = m?.choices[m.cursor]
  if (on !== undefined) {
    const line = lines.findLastIndex((l) => /^\s*[❯›>▶*]/.test(l) && plainChoice(l) === plainChoice(on))
    if (line >= 0) lines[line] = lines[line].replace(/^(\s*)[❯›>▶*](?=\s)/, '$1 ')
  }
  // a multiple choice's ticks are drawn on the card itself: ticking one is no new screen
  return restingScreen((m?.multi ? lines.map((l) => l.replace(/\[[✔✓x]\]/, '[ ]')) : lines).join('\n'))
}

/** a choice's words, as a line on the screen or as the card reads it: no cursor, no number, no checkbox, no "(esc)" hint */
const plainChoice = (line: string) =>
  line
    .replace(/^\s*[❯›>▶*]\s*/, '')
    .replace(/^\d{1,2}[.)]\s+/, '')
    .replace(/^\[[✔✓x ]\]\s*/, '')
    .replace(/\s*\((?:esc|enter|tab|[a-z])\)$/i, '')
    .trim()

/** two reads of a screen that only moved: a spinner turned, a timer counted, the cursor blinked */
export const sameScreen = (a: string, b: string) => restingScreen(a) === restingScreen(b)

/** the words a CLI stopped on: its last lines, for a chat card or a status line. A shell's prompt line, the command
 *  herdr ran to start it still on it, is no part of them. */
export function lastWords(text: string, lines = 3) {
  const kept = text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && !/^\s*\S*[$#](\s|$)/.test(l))
    .map((l) => l.trim())
    .slice(-lines)
  return kept.join(' ').replace(/\s{2,}/g, ' ').trim()
}
