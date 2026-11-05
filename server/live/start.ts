// A start that never becomes a turn. A CLI that exits before its first turn leaves its reason on no log and in no hook:
// whatever it printed is all there is. A resume finds no session (Claude Code's "No conversation found with session
// ID"), and a CLI may stop on a screen of its own — a folder to trust, a theme, signing in, a model that isn't there,
// pi's start screen — where it waits for a person who is not there.
//
// The screen is the only witness of those, so it is read through herdr (a pane read) and judged here:
//   · the CLI is gone from its pane, or herdr dropped its name: it failed, and its last words say why;
//   · it rests on a screen with choices in it: that is a prompt, and the chat shows it as a card, answered by pressing
//     what the card reads (nothing is typed blind);
//   · it rests on a screen that says something is wrong, or still cannot take what was handed to it (the brief waits
//     in its outbox): that is a card too, with its words and Open terminal;
//   · a screen that keeps moving (a spinner, a timer, a step, a percentage) is a slow start, and no card and no error
//     come of it, however long it takes: pi on a cold local model may take a while to say anything.
// Nothing here counts a screen as the agent's own status: the hooks and the log do, as before. This is upstream's
// failed-starts.ts and screens.ts (eliasstravik/shepherdr 9a6a4bef, c9861ef0, 774c4966) against 2.0's code.
import { lastWords, parseMenu, restingScreen, type ScreenMenu } from './screen.ts'
import type { Wrong } from './revive.ts'

/** how long a start has before a screen it rests on is read at all: hook and log reads are given their moment first */
export const FIRST_LOOK = 10_000

/** what a CLI prints when the session it was told to resume is gone. Claude Code 2.1.318: "No conversation found with
 *  session ID: …"; Codex: "ERROR: No saved session found with ID …" */
export const LOST_SESSION = /\bno (?:saved )?(?:conversation|session|rollout)\b[^\n]{0,40}\b(?:found|exists)\b|\b(?:conversation|session)\b[^\n]{0,40}\bnot found\b|\bcould(?: not|n't) find (?:the |your )?session\b/i

/** words that say a CLI stopped on something, rather than still starting: a slow start says none of them */
const STOPPED = /\b(?:error|failed|failure|cannot|can't|could not|couldn't|unable to|invalid|denied|refused|expired|unauthori[sz]ed|logged out|not signed in|sign in|sign-in|usage limit|out of allowance|exceeded|no such)\b/i

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
  /** what its pane shows now */
  screen: string
  /** it was resuming a session: the one case where a start without one is the way on */
  resumed: boolean
  /** what was handed to it (its brief, what you wrote) still waits to go in: it has not taken its first turn */
  waits: boolean
  /** the launch itself threw, before a pane was there to read */
  error?: string
}

export type StartStep =
  | { do: 'wait' }
  /** it rests on a screen of its own: a card for the chat, with what it shows and the choices it reads in it */
  | { do: 'card'; menu: ScreenMenu }
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
    if (l.pending || l.wrong === null) {
      this.seen.delete(key)
      return { do: 'wait' }
    }
    if (l.wrong === 'gone' || l.wrong === 'exited') {
      this.seen.delete(key)
      // one card and one error per launch: the relaunch loop and the next look must not say it again
      if (this.settled(key, l.started)) return { do: 'wait' }
      this.failed.set(key, l.started)
      const why = lastWords(l.screen) || l.error || 'It stopped before its first turn'
      return { do: 'failed', why, fresh: l.resumed && LOST_SESSION.test(l.screen) }
    }
    // it runs: a screen that rests says something, one that keeps moving is a slow start
    const screen = restingScreen(l.screen)
    if (!screen) {
      this.seen.set(key, { launch: l.started, screen: '' })
      return { do: 'wait' }
    }
    const was = this.seen.get(key)
    this.seen.set(key, { launch: l.started, screen })
    if (was?.launch !== l.started) return { do: 'wait' }
    if (was.screen !== screen) return { do: 'wait' }
    if (now - l.started < FIRST_LOOK) return { do: 'wait' }
    const menu = parseMenu(l.screen)
    if (menu) return { do: 'card', menu }
    // Nothing to choose: a card only when the screen says something is wrong, or when it still cannot take its brief.
    // What a slow start shows is neither — a screen that rests while the model loads, its brief already in — and a
    // screen that keeps saying something new never gets here at all.
    if (!STOPPED.test(lastWords(l.screen, 4)) && !l.waits) return { do: 'wait' }
    return { do: 'card', menu: { title: 'Waiting on its screen', choices: [], cursor: 0, screen: l.screen.trim() } }
  }
}
