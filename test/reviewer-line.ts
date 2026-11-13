// The Reviewer line of a brief, as the tests expect it: the reviewer's words, how a round asks which reviewer it runs
// with (`shepherdr review <id>`, then `--done`), the backup's sentence when one is set, and who set the line.
export const ASK = (id: string) => `Each round, run \`shepherdr review ${id}\` first: it names the reviewer for that round and the words to pass. After the review, run \`shepherdr review ${id} --done\`.`

/** a Reviewer line: `- Reviewer: <words> <ask>`, then the backup's sentence, then the mark of who set it, when they are given */
export const reviewerLineFor = (words: string, id: string, backup = '', mark = '') => `- Reviewer: ${words} ${ASK(id)}${backup ? ` ${backup}` : ''}${mark ? ` ${mark}` : ''}`

export const CODEX_WORDS = 'a headless Codex or a Codex subagent (its default model and effort).'
export const PI_WORDS = 'a headless pi or a pi subagent (its default model and effort).'
