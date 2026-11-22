// The Reviewer line of a brief, as the tests expect it: the reviewer's words, how a round asks Shepherdr for its prompt
// (`shepherdr review <id>`) and passes that file to the pane (`--run`), the headless fallback with `--done`, the backup's
// sentence when one is set, and who set it.
export const ASK = (id: string) =>
  `Each round, run \`shepherdr review ${id}\` first: it counts the round, writes your reviewer's prompt into this task's temp folder and names the file (a later round's prompt names what changed since the last reviewed commit, with the whole change for context). Pass that file to \`shepherdr review ${id} --run <that-file>\`: it opens this round's reviewer in a herdr pane beside you, waits for its findings and closes the pane (it releases the reviewer itself). Pass the same file to a headless run or a subagent; write no prompt of your own. If a pane could not open, use the headless line it prints instead and run \`shepherdr review ${id} --done\` when that review has finished: it records the commit this round reviewed, which your final commit must be before ready or merge.`

/** a Reviewer line: `- Reviewer: <words> <ask>`, then the backup's sentence, then the mark of who set it, when they are given */
export const reviewerLineFor = (words: string, id: string, backup = '', mark = '') => `- Reviewer: ${words} ${ASK(id)}${backup ? ` ${backup}` : ''}${mark ? ` ${mark}` : ''}`

export const CODEX_WORDS = 'a headless Codex or a Codex subagent (its default model and effort).'
export const PI_WORDS = 'a headless pi or a pi subagent (its default model and effort).'
