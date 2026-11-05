// A start that never becomes a turn: what its screen says, what counts as a slow start, and when it is settled once.
// The CLI's own words are the only witness here (no hook, no log), so nothing is read twice into two cards.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIRST_LOOK, LOST_SESSION, RESUME_SETTLE, Starts, type StartLook } from '../server/live/start.ts'
import { lastWords, menuFooter, menuId, parseMenu, restingScreen, sameScreen, screenText } from '../server/live/screen.ts'

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures/startup', name + '.txt'), 'utf8')
const TRUST = fixture('claude-trust')
const THEME = 'Choose a style\n\n ❯ Dark mode\n   Light mode\n\n Enter to confirm\n'
// a working agent's own screen: no footer a menu would have
const WORKING = '⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← 4 agents\n'
// its transcript's end, which reads like a numbered menu with a question above it
const TRANSCRIPT = 'Should I take the second approach?\n\n1. Yes, do that\n2. No, keep this one\n'
const PI = " █▀ █ escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash ·\n Press ctrl+o to show full startup help and loaded resources.\n /tmp/pitest\n 0.0%/1.0M (auto)  deepseek/deepseek-v4.1-flash • high\n"
const CLAUDE_LOST = 'No conversation found with session ID: 11111111-2222-4333-8444-555555555555\n'
const STARTED = 1_000_000
const SETTLED = STARTED + FIRST_LOOK + 2000
/** a look at a start that began at STARTED, changing only what the test is about */
const look = (o: Partial<StartLook> = {}): StartLook => ({ started: STARTED, wrong: undefined, pending: false, begun: false, prior: false, screen: '', resumed: false, waits: false, card: false, ...o })
/** two looks at the same start, a poll apart, past the first look: what a card takes */
function settle(l: StartLook = look(), at = SETTLED) {
  const s = new Starts()
  const first = s.look('EX-1/Agent', l, at)
  const second = s.look('EX-1/Agent', l, at + 2000)
  return { s, first, second }
}

describe('reading what a screen says', () => {
  test('a spinner, a timer and an activity bar move; the words do not', () => {
    expect(sameScreen('Thinking… (3s)', 'Thinking… (7s)')).toBe(true)
    expect(sameScreen('⠋ Loading', '⠙ Loading')).toBe(true)
    expect(sameScreen('⣾ 40%', '⣽ 70%')).toBe(false)
    expect(sameScreen('▁▂▃▄ Loading', '▄▅▆▇ Loading')).toBe(true)
    expect(sameScreen('Step 1 of 3', 'Step 2 of 3')).toBe(false)
    expect(sameScreen(TRUST, THEME)).toBe(false)
    expect(restingScreen('\n   \n')).toBe('')
  })

  test('only a screen with the CLI’s own menu footer under it is a prompt to press keys in', () => {
    expect(menuFooter(TRUST)).toBe(true)
    expect(menuFooter(THEME)).toBe(true)
    expect(menuFooter('Which do you want?\n1. This\n2. That\n')).toBe(false)
    expect(menuFooter(WORKING)).toBe(false)
    // a numbered picker with no question mark on it, ended on a footer, is a menu all the same
    expect(parseMenu('Choose the text style:\n\n 1. Dark\n 2. Light\n\n Enter to select · ↑/↓ to navigate\n')?.choices).toEqual(['Dark', 'Light'])
    expect(parseMenu('Pick one:\n\n 1. A\n 2. B\n')).toBeNull()
  })

  test('a spinner frame is a frame only at a line\'s start: the rest of the screen counts, whatever it is', () => {
    expect(restingScreen('⠋ Loading')).toBe('Loading')
    // a braille mark in words is part of the words, so the screen rests and says something new when it changes
    expect(restingScreen('⠁ means allow access')).toBe('⠁ means allow access')
    expect(sameScreen('⠁ means allow access', '⠃ means allow access')).toBe(false)
    expect(screenText('  ⠋ Signing in… (12s)')).toBe('   Signing in… (12s)')
    expect(screenText('Plan 1 ⣾')).toBe('Plan 1 ⣾')
  })

  test('a card is the words on its screen: the cursor and a spinner frame may move, every other mark counts', () => {
    const m = parseMenu(THEME)!
    const at = (o: Partial<typeof m>) => ({ ...m, ...o })
    // the cursor moving from one choice to another is no change of words
    expect(menuId('c', at({ cursor: 0 }))).toBe(menuId('c', at({ cursor: 1, all: 'Choose a style\n\n   Dark mode\n ❯ Light mode\n\n Enter to confirm\n' })))
    // a spinner frame above the menu, and a timer running under it, are no change either
    expect(menuId('c', at({ all: '⠋ Signing in… (12s)\n' + THEME }))).toBe(menuId('c', at({ all: '⠙ Signing in… (19s)\n' + THEME })))
    // words above the card count: a path, a number, a symbol, a space the CLI drew
    for (const above of ['Trust /repo/two', 'Trust 1', 'Trust /one', 'Trust /repo/🔒', 'Trust /repo/🚀'])
      expect(menuId('c', at({ all: above + '\n\n' + THEME }))).not.toBe(menuId('c', at({ all: 'Trust /repo/one\n\n' + THEME })))
    // other words, or another set of choices, are another card
    expect(menuId('c', m)).not.toBe(menuId('c', { ...m, choices: ['Dark theme', 'Light theme'] }))
  })

  test('the words it stopped on are its last lines, never the shell prompt that started it', () => {
    const screen = `me@box:~/wt$ claude --resume ${'1'.repeat(8)}\n${CLAUDE_LOST}me@box:~/wt$ `
    expect(lastWords(screen)).toBe(CLAUDE_LOST.trim())
    expect(lastWords('Starting\n\nError: Invalid API key\nPlease run /login\n')).toBe('Starting Error: Invalid API key Please run /login')
  })

  test('a session that is gone says so in the CLI’s own words, and nothing else does', () => {
    expect(LOST_SESSION.test(CLAUDE_LOST)).toBe(true)
    expect(LOST_SESSION.test('ERROR: No saved session found with ID 1111. Run `codex resume` without an ID to choose.')).toBe(true)
    expect(LOST_SESSION.test('Starting the servers')).toBe(false)
    expect(LOST_SESSION.test(PI)).toBe(false)
  })

  test('the startup screens are read as choices, with the cursor where the CLI drew it', () => {
    expect(parseMenu(TRUST)?.choices).toEqual(['No, exit', 'Yes, I trust this folder'])
    expect(parseMenu(TRUST)?.cursor).toBe(0)
    expect(parseMenu(THEME)?.choices).toEqual(['Dark mode', 'Light mode'])
  })
})

describe('a start that never becomes a turn', () => {
  test('nothing is read before it has had its moment, nor of one that is not a start any more', () => {
    const s = new Starts()
    expect(s.look('EX-1/Agent', look({ screen: TRUST }), STARTED + 1000)).toEqual({ do: 'wait' })
    // herdr still finishes the launch (issue #491): its hooks get their chance first
    expect(s.look('EX-1/Agent', look({ screen: TRUST, pending: true }), STARTED + 30_000)).toEqual({ do: 'wait' })
    // its log shows a turn: an agent at work, whatever the screen says
    expect(s.look('EX-1/Agent', look({ screen: TRUST, begun: true }), STARTED + 30_000)).toEqual({ do: 'wait' })
    // herdr can't say what runs in its pane
    expect(s.look('EX-1/Agent', look({ screen: TRUST, wrong: null }), STARTED + 30_000)).toEqual({ do: 'wait' })
  })

  test('a screen it rests on comes to the chat as a card, with the choices it reads there', () => {
    const { first, second } = settle(look({ screen: TRUST }))
    expect(first).toEqual({ do: 'wait' })
    expect(second).toMatchObject({ do: 'card', menu: { choices: ['No, exit', 'Yes, I trust this folder'] } })
    expect(second.do === 'card' && second.menu.screen).toContain('Quick safety check')
  })

  test('a slow start is no card and no error, however long it takes', () => {
    // a screen that keeps saying something new: steps, percentages, an agent's own words
    const s = new Starts()
    expect(s.look('EX-1/Agent', look({ screen: 'Loading model 1 of 4' }), SETTLED)).toEqual({ do: 'wait' })
    expect(s.look('EX-1/Agent', look({ screen: 'Loading model 2 of 4' }), SETTLED + 2000)).toEqual({ do: 'wait' })
    expect(s.look('EX-1/Agent', look({ screen: 'Loading model 3 of 4' }), SETTLED + 4000)).toEqual({ do: 'wait' })
    // a screen that rests but says nothing wrong, its brief already in: the model is loading, and it may take a while
    expect(settle(look({ screen: PI })).second).toEqual({ do: 'wait' })
    expect(settle(look({ screen: WORKING })).second).toEqual({ do: 'wait' })
  })

  test('a screen with nothing to choose is still a card when it says something is wrong, or its brief is still waiting', () => {
    const { first, second } = settle(look({ screen: 'Error: model nope/nope not found' }))
    expect(first).toEqual({ do: 'wait' })
    expect(second).toMatchObject({ do: 'card', menu: { choices: [] } })
    expect(second.do === 'card' && second.menu.screen).toContain('nope/nope')
    // pi's start screen, its brief still waiting to go in: it is not a slow start, it never took it
    expect(settle(look({ screen: PI, waits: true })).second).toMatchObject({ do: 'card', menu: { choices: [] } })
  })

  test('a card of a screen whose brief went in after all has nothing left to say', () => {
    expect(settle(look({ screen: PI, card: true })).second).toEqual({ do: 'clear' })
    // a prompt it still waits at stays a card
    expect(settle(look({ screen: TRUST, card: true })).second).toMatchObject({ do: 'card' })
  })

  test('a CLI gone from its pane failed, with its own words in the chat', () => {
    const { first, second } = settle(look({ screen: 'Error: Invalid API key\nPlease run /login\n', wrong: 'exited' }))
    expect(first).toEqual({ do: 'failed', why: 'Error: Invalid API key Please run /login', fresh: false })
    // one launch, one error: the next look says nothing more
    expect(second).toEqual({ do: 'wait' })
  })

  test('a CLI takes its pane first: a launch is not failed before its moment', () => {
    const s = new Starts()
    expect(s.look('EX-1/Agent', look({ screen: 'Error: broken', wrong: 'exited' }), STARTED + 2000)).toEqual({ do: 'wait' })
    expect(s.look('EX-1/Agent', look({ screen: 'Error: broken', wrong: 'exited' }), SETTLED)).toMatchObject({ do: 'failed' })
  })

  test('a new launch has its own say, after one that failed', () => {
    const s = new Starts()
    const failed = look({ screen: 'Error: broken', wrong: 'exited' })
    expect(s.look('EX-1/Agent', failed, SETTLED).do).toBe('failed')
    for (const t of [60_000, 600_000]) expect(s.look('EX-1/Agent', failed, STARTED + t)).toEqual({ do: 'wait' })
    expect(s.look('EX-1/Agent', { ...failed, started: STARTED + 700_000 }, STARTED + 705_000 + FIRST_LOOK).do).toBe('failed')
  })

  test('a resume whose session is gone is the one failure a start without it is the way on', () => {
    const fresh = new Starts().look('EX-1/Agent', look({ screen: CLAUDE_LOST, wrong: 'exited', resumed: true }), SETTLED)
    expect(fresh).toEqual({ do: 'failed', why: CLAUDE_LOST.trim(), fresh: true })
    // the same words on a start that resumed nothing are only a start that failed
    const one = new Starts().look('EX-1/Agent', look({ screen: CLAUDE_LOST, wrong: 'exited' }), SETTLED)
    expect(one).toMatchObject({ do: 'failed', fresh: false })
  })

  test('herdr dropped the agent and left no screen to read: the reason is what the launch itself said', () => {
    expect(new Starts().look('EX-1/Agent', look({ wrong: 'gone', error: 'herdr is not answering' }), SETTLED)).toEqual({ do: 'failed', why: 'herdr is not answering', fresh: false })
    expect(new Starts().look('EX-1/Agent', look({ wrong: 'gone' }), SETTLED)).toEqual({ do: 'failed', why: 'It stopped before its first turn', fresh: false })
  })

  test('a screen that changed once is read again before it is a card', () => {
    const s = new Starts()
    expect(s.look('EX-1/Agent', look({ screen: TRUST }), SETTLED)).toEqual({ do: 'wait' })
    expect(s.look('EX-1/Agent', look({ screen: THEME }), SETTLED + 2000)).toEqual({ do: 'wait' })
    expect(s.look('EX-1/Agent', look({ screen: THEME }), SETTLED + 4000)).toMatchObject({ do: 'card', menu: { choices: ['Dark mode', 'Light mode'] } })
  })

  test('an agent back on a session from before is never carded from its words: its transcript reads like anything', () => {
    const s = new Starts()
    for (const at of [SETTLED, SETTLED + 2000, SETTLED + 60_000]) expect(s.look('EX-1/Agent', look({ prior: true, screen: TRANSCRIPT, resumed: true }), at)).toEqual({ do: 'wait' })
    // even a trust screen, which a transcript could show: it has been through a start before
    expect(settle(look({ prior: true, screen: TRUST, resumed: true })).second).toEqual({ do: 'wait' })
    // what was handed to it still cannot go in: that is a state, and a card
    expect(settle(look({ prior: true, screen: TRANSCRIPT, resumed: true, waits: true })).second).toMatchObject({ do: 'card', menu: { choices: [] } })
    // and once it goes in, the card has nothing left to say
    expect(settle(look({ prior: true, screen: TRANSCRIPT, resumed: true, card: true })).second).toEqual({ do: 'clear' })
    // a failure is still worth saying while it settles, and nothing after that
    const gone = look({ prior: true, resumed: true, wrong: 'gone', screen: CLAUDE_LOST })
    expect(new Starts().look('EX-1/Agent', gone, STARTED + FIRST_LOOK + 2000)).toMatchObject({ do: 'failed', fresh: true })
    expect(new Starts().look('EX-1/Agent', gone, STARTED + RESUME_SETTLE + 2000)).toEqual({ do: 'wait' })
  })
})
