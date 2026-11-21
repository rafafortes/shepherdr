// The Reviewer line of a brief, as the tests expect it: the reviewer's words, how a round runs it in a herdr pane
// (`shepherdr review <id> --run`), the headless fallback with `--done`, the backup's sentence when one is set, and who set it.
export const ASK = (id: string) =>
  `Each round, run \`shepherdr review ${id} --run <prompt-file>\` first: it opens this round's reviewer in a herdr pane beside you, waits for its findings and closes the pane (it releases the reviewer itself). If it says a pane could not open, use the headless line it prints instead and run \`shepherdr review ${id} --done\` when that review has finished. Plain \`shepherdr review ${id}\` still counts a round and names a reviewer without running one.`

/** a Reviewer line: `- Reviewer: <words> <ask>`, then the backup's sentence, then the mark of who set it, when they are given */
export const reviewerLineFor = (words: string, id: string, backup = '', mark = '') => `- Reviewer: ${words} ${ASK(id)}${backup ? ` ${backup}` : ''}${mark ? ` ${mark}` : ''}`

export const CODEX_WORDS = 'a headless Codex or a Codex subagent (its default model and effort).'
export const PI_WORDS = 'a headless pi or a pi subagent (its default model and effort).'
