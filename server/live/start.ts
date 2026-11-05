// A start that never becomes a turn. A CLI that exits before its first turn leaves its reason on no log and in no hook:
// whatever it printed is all there is. A resume finds no session (Claude Code's "No conversation found with session
// ID"), and a CLI may stop on a screen of its own — a folder to trust, a theme, signing in, a model that isn't there,
// pi's start screen — where it waits for a person who is not there.
//
// The screen is the only witness of those, so it is read through herdr (a pane read) and judged here:
//   · the CLI is gone from its pane, or herdr dropped its name, once the launch has had its moment: it failed, and its
//     last words say why;
//   · a first start (no session from before) that rests on a screen with a menu footer: that is a prompt, and the chat
//     shows it as a card, answered by pressing what the card reads (nothing is typed blind);
//   · it rests on a screen that says something is wrong, or still cannot take what was handed to it (the brief waits in
//     its outbox): that is a card too, with its words and Open terminal;
//   · anything else is left alone. A screen that keeps saying something new (a step, a word, a percentage, work going
//     on) is a slow start, and so is one at rest whose brief already went in — pi on a cold local model takes a while —
//     and neither a card nor an error comes of it, however long it takes.
// An agent back on a session from before is never carded: what a CLI shows there is its transcript, which can look like
// anything (upstream's 774c4966). Nothing here counts a screen as the agent's own status: the hooks and the log do, as
// before. This is upstream's failed-starts.ts and screens.ts (eliasstravik/shepherdr 9a6a4bef, c9861ef0, 774c4966)
// against 2.0's code.
import { lastWords, menuFooter, parseMenu, restingScreen, type ScreenMenu } from './screen.ts'
import type { Wrong } from './revive.ts'

/** how long a launch has before a screen it rests on is read, and before a pane without its CLI counts as a failure:
 *  hook and log reads are given their moment, and a CLI takes its pane before herdr is done with it */
export const FIRST_LOOK = 10_000

/** how long a launch that resumed a session from before is watched for a failure, and no longer: its transcript is no
 *  start, and nothing has to be waited on there */
export const RESUME_SETTLE = 2 * 60_000

/** what a CLI prints when the session it was told to resume is gone. Claude Code 2.1.318: "No conversation found with
 *  session ID: …"; Codex: "ERROR: No saved session found with ID …" */
export const LOST_SESSION = /\bno (?:saved )?(?:conversation|session|rollout)\b[^\n]{0,40}\b(?:found|exists)\b|\b(?:conversation|session)\b[^\n]{0,40}\bnot found\b|\bcould(?: not|n't) find (?:the |your )?session\b/i

/** words that say a CLI stopped on something, rather than still starting: a slow start says none of them */
const STOPPED = /\b(?:error|failed|failure|cannot|can't|could not|couldn't|unable to|invalid|denied|refused|expired|unauthori[sz]ed|logged out|not signed in|sign in|sign-in|\/login|usage limit|out of allowance|exceeded|no such)\b/i

/** one look at a start */
export interface StartLook {
  /** when this launch began (AgentRecord.started): a new launch is a new start, with nothing remembered of the last */
  started: number
  /** herdr's word on what runs in its pane: the CLI exited, herdr dropped the agent, herdr can't say (null), or nothing
   *  wrong (undefined) */
  wrong: Wrong | undefined | null
  /** herdr is still finishing this launch (issue #491): it is neither failed nor stopped */
  pending: boolean
  /** its log shows a turn since it started, or its hooks said anything: it is an agent at work, no start any more */
  begun: boolean
  /** it came back to a session from before this launch: its screen is a transcript, never a start to card */
  prior: boolean
  /** what its pane shows now */
  screen: string
  /** it was resuming a session: the one case where a start without one is the way on */
  resumed: boolean
  /** what was handed to it (its brief, what you wrote) still waits to go in: it has not taken its first turn */
  waits: boolean
  /** a card of a start's screen is up already */
  card: boolean
  /** the launch itself threw, before a pane was there to read */
  error?: string
}

export type StartStep =
  | { do: 'wait' }
  /** it rests on a screen of its own: a card for the chat, with what it shows and the choices it reads in it */
  | { do: 'card'; menu: ScreenMenu }
  /** its screen moved on: the card of it goes, and the next screen is read as a card of its own */
  | { do: 'clear' }
  /** it could not start: why, in words for the chat, and whether starting again without its session is the way on */
  | { do: 'failed'; why: string; fresh: boolean }

/** What each start has shown so far, and what was already said of it. One screen is one card: it takes two reads that
 *  rest the same way, a poll or two apart, before a screen becomes one (upstream's c9861ef0, 774c4966). */
export class Starts {
  /** what each launch last showed: the launch it is, and its screen without what only moves */
  private seen = new Map<string, { launch: number; screen: string }>()
  /** the launches already settled as failed, so one failure is one card and one error */
  private failed = new Map<string, number>()

  /** whether this launch was settled as failed already */
  settled(key: string, started: number) {
    return this.failed.get(key) === started
  }

  /** what to do with a start as it is now */
  look(key: string, l: StartLook, now = Date.now()): StartStep {
    // it reported, herdr is still launching it, or herdr can't say what runs there: nothing to judge yet
    if (l.begun) {
      this.seen.delete(key)
      this.failed.delete(key)
      return { do: 'wait' }
    }
    // back on an older session: only a failure is worth a look, and only while the launch settles
    if (l.prior && now - l.started >= RESUME_SETTLE) return { do: 'wait' }
    if (l.pending || l.wrong === null) {
      this.seen.delete(key)
      return { do: 'wait' }
    }
    if (l.wrong === 'gone' || l.wrong === 'exited') {
      this.seen.delete(key)
      // a CLI takes its pane when herdr starts it: only past the first look is one gone for good
      if (now - l.started < FIRST_LOOK) return { do: 'wait' }
      // one card and one error per launch: the relaunch loop and the next look must not say it again
      if (this.settled(key, l.started)) return { do: 'wait' }
      this.failed.set(key, l.started)
      const why = lastWords(l.screen) || l.error || 'It stopped before its first turn'
      return { do: 'failed', why, fresh: l.resumed && LOST_SESSION.test(l.screen) }
    }
    // it runs: a screen that rests says something, one that keeps saying something new is a slow start
    const screen = restingScreen(l.screen)
    if (!screen) return { do: 'wait' }
    const was = this.seen.get(key)
    const resting = was?.launch === l.started && was.screen === screen
    this.seen.set(key, { launch: l.started, screen })
    if (!resting || now - l.started < FIRST_LOOK) return { do: 'wait' }
    // Back on a session from before: its screen is a transcript, so no menu there is a card and nothing it says reads as
    // a start's words. Only a state — what was handed to it still cannot go in — is worth one.
    if (l.prior) {
      if (!l.waits) return l.card ? { do: 'clear' } : { do: 'wait' }
      return { do: 'card', menu: { title: 'Waiting on its screen', choices: [], cursor: 0, screen, all: screen } }
    }
    // a menu it reads, with the CLI's own footer under it: a startup screen, not a wall of text. Its card is the screen
    // at rest: what only moves there (a timer) is no change of words, and the card of it stays the card
    const menu = menuFooter(l.screen) ? parseMenu(l.screen) : null
    if (menu) return { do: 'card', menu: { ...menu, all: screen } }
    // Nothing to choose: a card only when the screen says something is wrong, or when it still cannot take its brief.
    // A slow start says neither — a screen at rest while the model loads, its brief already in — and gets no card.
    if (STOPPED.test(lastWords(l.screen, 4)) || l.waits) return { do: 'card', menu: { title: 'Waiting on its screen', choices: [], cursor: 0, screen, all: screen } }
    // its brief went in after all: a card about waiting for it has nothing left to say
    return l.card ? { do: 'clear' } : { do: 'wait' }
  }
}
