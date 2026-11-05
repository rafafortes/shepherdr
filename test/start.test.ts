// A start that never becomes a turn: what its screen says, what counts as a slow start, and when it is settled once.
// The CLI's own words are the only witness here (no hook, no log), so nothing is read twice into two cards.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIRST_LOOK, LOST_SESSION, Starts, type StartLook } from '../server/live/start.ts'
import { lastWords, parseMenu, restingScreen, sameScreen } from '../server/live/screen.ts'

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures/startup', name + '.txt'), 'utf8')
const TRUST = fixture('claude-trust')
const THEME = 'Choose a style\n\n ❯ Dark mode\n   Light mode\n\n Enter to confirm\n'
const WORKING = '⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← 4 agents\n'
const PI = " █▀ █ escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash ·\n Press ctrl+o to show full startup help and loaded resources.\n /tmp/pitest\n 0.0%/1.0M (auto)  deepseek/deepseek-v4.1-flash • high\n"
const CLAUDE_LOST = 'No conversation found with session ID: 11111111-2222-4333-8444-555555555555\n'
const STARTED = 1_000_000
/** a look at a start that began at STARTED, changing only what the test is about */
const look = (o: Partial<StartLook> = {}): StartLook => ({ started: STARTED, wrong: undefined, pending: false, begun: false, screen: '', resumed: false, waits: false, ...o })
/** two looks at the same start, a poll apart, past the first look: what a card takes */
function settle(l: StartLook = look(), at = STARTED + FIRST_LOOK + 2000) {
  const s = new Starts()
  const first = s.look('EX-1/Agent', l, at)
  const second = s.look('EX-1/Agent', l, at + 2000)
  return { s, first, second }
}

describe('reading what a screen says', () => {
  test('a spinner, a timer and an activity bar move; the words do not', () => {
    expect(sameScreen('Thinking… (3s)', 'Thinking… (7s)')).toBe(true)
    expect(sameScreen('⠋ Loading', '⠙ Loading')).toBe(true)
    expect(sameScreen('▁▂▃▄ 40%', '▄▅▆▇ 70%')).toBe(true)
    expect(sameScreen('Step 1 of 3', 'Step 2 of 3')).toBe(false)
    expect(sameScreen(TRUST, THEME)).toBe(false)
    expect(restingScreen('\n   \n')).toBe('')
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
    const at = STARTED + FIRST_LOOK
    expect(s.look('EX-1/Agent', look({ screen: 'Loading model 1 of 4' }), at)).toEqual({ do: 'wait' })
    expect(s.look('EX-1/Agent', look({ screen: 'Loading model 2 of 4' }), at + 2000)).toEqual({ do: 'wait' })
    expect(s.look('EX-1/Agent', look({ screen: 'Loading model 3 of 4' }), at + 4000)).toEqual({ do: 'wait' })
    // and one that only counts seconds moves too
    expect(s.look('EX-1/Agent', look({ screen: 'Starting 13s' }), at + 6000)).toEqual({ do: 'wait' })
    expect(s.look('EX-1/Agent', look({ screen: 'Starting 21s' }), at + 8000)).toEqual({ do: 'wait' })
    // a screen that rests but says nothing wrong, its brief already in: the model is loading, and it may take a while
    expect(settle(look({ screen: PI })).second).toEqual({ do: 'wait' })
    expect(settle(look({ screen: WORKING })).second).toEqual({ do: 'wait' })
  })

  test('a screen with nothing to choose is still a card when it says something is wrong, or its brief is still waiting', () => {
    const { second, first } = settle(look({ screen: 'Error: model nope/nope not found' }))
    expect(first).toEqual({ do: 'wait' })
    expect(second).toMatchObject({ do: 'card', menu: { choices: [] } })
    expect(second.do === 'card' && second.menu.screen).toContain('nope/nope')
    // pi's start screen, its brief still waiting to go in: it is not a slow start, it never took it
    const stuck = settle(look({ screen: PI, waits: true }))
    expect(stuck.second).toMatchObject({ do: 'card', menu: { choices: [] } })
  })

  test('a CLI gone from its pane failed, with its own words in the chat', () => {
    const { first, second } = settle(look({ screen: 'Error: Invalid API key\nPlease run /login\n', wrong: 'exited' }))
    // a failure is settled on the first look, not after two
    expect(first).toEqual({ do: 'failed', why: 'Error: Invalid API key Please run /login', fresh: false })
    expect(second).toEqual({ do: 'wait' })
  })

  test('one launch, one error: the next look and the relaunch loop say nothing more', () => {
    const s = new Starts()
    const failed = look({ screen: 'Error: broken', wrong: 'exited' })
    expect(s.look('EX-1/Agent', failed, STARTED + 5000).do).toBe('failed')
    for (const t of [6000, 60_000, 600_000]) expect(s.look('EX-1/Agent', failed, STARTED + t)).toEqual({ do: 'wait' })
    // a new launch has its own say: its own screen, its own error
    const again = { ...failed, started: STARTED + 700_000 }
    expect(s.look('EX-1/Agent', again, STARTED + 705_000).do).toBe('failed')
  })

  test('a resume whose session is gone is the one failure a start without it is the way on', () => {
    const fresh = new Starts().look('EX-1/Agent', look({ screen: CLAUDE_LOST, wrong: 'exited', resumed: true }), STARTED + 5000)
    expect(fresh).toEqual({ do: 'failed', why: CLAUDE_LOST.trim(), fresh: true })
    // the same words on a start that resumed nothing are only a start that failed
    const one = new Starts().look('EX-1/Agent', look({ screen: CLAUDE_LOST, wrong: 'exited' }), STARTED + 5000)
    expect(one).toMatchObject({ do: 'failed', fresh: false })
  })

  test('herdr dropped the agent and left no screen to read: the reason is what the launch itself said', () => {
    const step = new Starts().look('EX-1/Agent', look({ wrong: 'gone', error: 'herdr is not answering' }), STARTED + 5000)
    expect(step).toEqual({ do: 'failed', why: 'herdr is not answering', fresh: false })
    const empty = new Starts().look('EX-1/Agent', look({ wrong: 'gone' }), STARTED + 5000)
    expect(empty).toEqual({ do: 'failed', why: 'It stopped before its first turn', fresh: false })
  })

  test('a screen that changed once is read again before it is a card', () => {
    const s = new Starts()
    const at = STARTED + FIRST_LOOK
    expect(s.look('EX-1/Agent', look({ screen: TRUST }), at)).toEqual({ do: 'wait' })
    expect(s.look('EX-1/Agent', look({ screen: THEME }), at + 2000)).toEqual({ do: 'wait' })
    expect(s.look('EX-1/Agent', look({ screen: THEME }), at + 4000)).toMatchObject({ do: 'card', menu: { choices: ['Dark mode', 'Light mode'] } })
  })
})
