// A card closed without an answer: its Dismiss, or Esc on a card you pressed. The agent hears the person declined it,
// so it carries on with its own judgment and says what it assumed; a dismissed permission is never a yes, and a
// dismissed plan is no approval. Shepherdr's own cards (its choice card, a task's plan) say it in words of their own; a
// CLI's own prompt (its screen menu, its question tool) takes Esc, exactly as the person's Esc in the terminal would,
// and the CLI's own words reach the agent.

/** what the person did, as the agent hears it */
export const DISMISSED = 'The person dismissed this without answering'

/** what a dismissed card says to its agent, by what it asked */
export const dismissWords = (kind: 'questions' | 'plan'): string =>
  kind === 'plan'
    ? `${DISMISSED}: the plan isn't approved. Don't carry it out: say what you'll do instead, or wait for the person's message.`
    : `${DISMISSED}. Don't ask these questions again now: carry on with your best judgment, and say what you assumed.`

/** the kind of a card Shepherdr posted, by its id: a task's plan, or a question of its own */
export const dismissKind = (qid: string): 'questions' | 'plan' => (qid.startsWith('plan:') ? 'plan' : 'questions')
