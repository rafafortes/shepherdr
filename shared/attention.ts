/** Coordinator questions that still wait: the open cards of its chat, as `openCards` says (one rule for a card and a
 *  CLI's own question: the human's words, hidden notes included, or another agent's relay after it closes one; the
 *  agent's own later news does not). A card answered by a relay is no longer in `open`, so it leaves Needs you, its
 *  counts, the badge and the alert command as a task's card does. With nothing open, the CLI's own menu nobody reads
 *  can still hold the coordinator. */
export function coordinatorRequestIds(open: readonly string[], answers: Record<string, unknown>, blocked: boolean): string[] {
  const ids = open.filter((id) => answers[id] === undefined)
  return ids.length ? ids : blocked ? ['blocked'] : []
}
