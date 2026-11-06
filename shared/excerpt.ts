// The start of a message as a reaction or a reply quotes it: one line of plain words. The server quotes with it, and the
// screen shows a reply's quote with it at once, before the server has it.

/** an underscore or a star between letters, kept while markdown's marks go (these characters are in no message) */
const KEPT_UNDER = '\u0000'
const KEPT_STAR = '\u0001'

export function excerpt(text: string, n = 60) {
  const one = text
    // a mention is its name: its id is nothing in a line of words, and a cut through one would leave half a link
    .replace(/\[([#@])([^\]\n]{1,80})\]\((?:space|task):[^)\s]+\)/g, '$1$2')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*(#{1,6}|>)\s+/gm, '')
    .replace(/(\w)([_*])(?=\w)/g, (_, before: string, mark: string) => before + (mark === '_' ? KEPT_UNDER : KEPT_STAR))
    .replace(/[`*_]/g, '')
    .replaceAll(KEPT_UNDER, '_')
    .replaceAll(KEPT_STAR, '*')
    .replace(/\s+/g, ' ')
    .trim()
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one
}
