// The harness (the CLI a model runs in) as the screens show it: providers are grouped under their harness, in one fixed
// order, and a provider named outside its group reads "<harness> · <provider>" ("pi · Spark (local)"). A pattern that
// names an entry by its key (`pi.spark`, `pi.spark/qwen…`) reads the same way ("pi · spark"). The stored text keeps the dot.

/** the harnesses in the order the screens group them: the single-account CLIs first, then pi and OpenCode (several providers) */
export const HARNESS_ORDER = ['claude', 'codex', 'pi', 'opencode', 'agy']
/** the harnesses with one account: their one provider row is named after the harness, with no heading above it */
export const SINGLE_ACCOUNT = ['claude', 'codex', 'agy']

/** a provider named outside its group: "pi · Spark (local)", or the harness alone when the two names are the same (Claude Code) */
export const inHarness = (harnessName: string, name: string) => (name === harnessName ? name : `${harnessName} · ${name}`)

/** a pattern in words, for a line that names it: a dot after its harness reads as " · " (pi.spark → pi · spark, pi.spark/qwen… →
 *  pi · spark/qwen…); a pattern with no harness part (claude/claude-opus-5-5, or a model's own name) is unchanged */
export function patternWords(pattern: string): string {
  const dot = pattern.indexOf('.')
  const slash = pattern.indexOf('/')
  if (dot < 0 || (slash >= 0 && slash < dot)) return pattern
  return `${pattern.slice(0, dot)} · ${pattern.slice(dot + 1)}`
}

/** one harness's group of providers, in the screens' order: its name, whether it is single-account, and its providers */
export interface HarnessGroup<T> {
  harness: string
  name: string
  single: boolean
  list: T[]
}

/** the providers grouped by their harness, the groups in HARNESS_ORDER and any other harness after them (in the order met),
 *  each group once and only when it has a provider */
export function harnessGroups<T extends { harness: string; harnessName: string }>(list: T[]): HarnessGroup<T>[] {
  const others = [...new Set(list.map((p) => p.harness))].filter((h) => !HARNESS_ORDER.includes(h))
  return [...HARNESS_ORDER, ...others]
    .map((harness) => ({ harness, name: list.find((p) => p.harness === harness)?.harnessName ?? harness, single: SINGLE_ACCOUNT.includes(harness), list: list.filter((p) => p.harness === harness) }))
    .filter((g) => g.list.length > 0)
}
