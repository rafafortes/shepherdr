// The help page split into topics (UXD-02): a bare `shepherdr help` still prints the whole page, while
// `shepherdr help <topic>` and `shepherdr <verb> --help` print one section. The sections live in args.ts, so the
// tests import them directly and check the command against them through a LiveSource with no herdr in reach.
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const home = tmp('cli-help')
process.env.SHEPHERDR_HOME = home
process.env.HERDR_SOCKET_PATH = join(home, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { HELP, TOPIC, CLI_VERBS, VERB_TOPIC, helpTopic, helpVerb } = await import('../server/live/args.ts')
const { helpVerbs } = await import('../scripts/checks/docs.ts')
const { ROW_MAX } = await import('../shared/types.ts')

/** SHA-256 of the bare-help page: the split must not drift its bytes by accident. The docs check ties HELP to the
 *  dispatch verbs; this pins the text itself. Update it when help text is meant to change (as with --json on the lists). */
const ORIGINAL_HELP_SHA = 'b345a98caa829dba5109fc9993fa288643c008d7d36329788e8db013e58ac75f'

const src = new LiveSource()
afterAll(() => src.stop())

const cli = async (args: string[]) => src.cli(args, {})

describe('shepherdr help, per topic', () => {
  test('a bare help prints the whole page, and the page is the join of every section', async () => {
    expect((await cli(['help'])).out).toBe(HELP)
    expect((await cli(['--help'])).out).toBe(HELP)
    const page = `shepherdr: talk to Shepherdr from a terminal (agents use it; so can you)\n\n${[TOPIC.spaces, TOPIC.tasks, TOPIC.agents, TOPIC.chat, TOPIC.secrets, TOPIC.artifacts, TOPIC.settings, TOPIC.setup].join('\n')}`
    expect(HELP).toBe(page)
    expect(createHash('sha256').update(HELP).digest('hex')).toBe(ORIGINAL_HELP_SHA)
    expect(Object.values(TOPIC).every((section) => section.length < HELP.length)).toBe(true)
  })

  test('titles and status lines are asked for at most 30 characters, with examples; the 40-char cut stays', () => {
    expect(ROW_MAX).toBe(30)
    expect(HELP).toContain('the title asked for at most 30 characters: the thing and the')
    expect(HELP).toContain('change in a few plain words ("Fix login redirect loop")')
    expect(HELP).toContain('colon-and-list or "and"')
    expect(HELP).toContain('characters are still accepted)')
    expect(HELP).toContain('asked for at most 30 characters, a few plain words for a')
    expect(HELP).toContain('phone\'s task row (e.g. "Fixing two failing tests")')
    expect(HELP).toContain('cut at 40 characters at a word')
    expect(HELP).toContain('asked for at most 30 characters, as on task add')
    // every example of a good title or status the help gives fits the ask
    for (const good of ['Fix login redirect loop', 'Fixing two failing tests']) expect(good.length).toBeLessThanOrEqual(ROW_MAX)
    for (const bad of ['Fix the login redirect loop after a session times out', 'Rebasing onto main, then running the whole test suite']) expect(bad.length).toBeGreaterThan(ROW_MAX)
  })

  test('a verb’s --help prints only that verb’s section', async () => {
    const tasks = await cli(['task', 'add', '--help'])
    expect(tasks.out).toBe(TOPIC.tasks)
    expect(tasks.out).toContain('shepherdr task add')
    expect(tasks.out).not.toContain('shepherdr secret run')
    // every verb the CLI takes has a section, and its --help opens exactly that section
    for (const verb of CLI_VERBS) expect((await cli([verb, '--help'])).out).toBe(TOPIC[VERB_TOPIC[verb]])
  })

  test('help <topic> prints one section; an unknown topic lists the topics and the page', async () => {
    for (const name of Object.keys(TOPIC)) {
      const section = TOPIC[name as keyof typeof TOPIC]
      expect((await cli(['help', name])).out).toBe(section)
      expect((await cli(['help', name, 'extra'])).out).toBe(section)
    }
    const unknown = await cli(['help', 'nope'])
    expect(unknown.out).toContain('No help topic nope; try one of: ')
    for (const name of Object.keys(TOPIC)) expect(unknown.out).toContain(name)
    expect(unknown.out).toContain(HELP)
    // names inherited from Object are not topics either: they used to print the page, and must not crash now
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) expect((await cli(['help', inherited])).out).toContain(`No help topic ${inherited}; try one of: `)
    expect(helpTopic('tasks')).toBe(TOPIC.tasks)
    expect(helpTopic()).toBe(HELP)
  })

  test('help <verb> finds its section too, instead of the whole page plus an unknown-topic line', async () => {
    for (const verb of CLI_VERBS) {
      expect((await cli(['help', verb])).out).toBe(TOPIC[VERB_TOPIC[verb]])
      expect(helpTopic(verb)).toBe(TOPIC[VERB_TOPIC[verb]])
    }
    expect((await cli(['help', 'task'])).out).toContain('shepherdr task add')
    expect((await cli(['help', 'task'])).out).not.toContain('shepherdr secret run')
  })

  test('every verb has a topic, and an unknown verb keeps its old refusal', async () => {
    expect(CLI_VERBS).toContain('project') // the old alias
    expect(CLI_VERBS).toContain('done') // ready's old name
    expect(CLI_VERBS).toContain('render') // the gone verb that points at artifacts
    // the verbs helpVerbs reads out of HELP are tied to the dispatch by the docs check; none may miss the map
    for (const verb of helpVerbs().groups) {
      expect(CLI_VERBS as readonly string[]).toContain(verb)
      expect(Object.hasOwn(VERB_TOPIC, verb)).toBe(true)
    }
    for (const verb of CLI_VERBS) {
      const topic = VERB_TOPIC[verb]
      expect(Object.hasOwn(TOPIC, topic)).toBe(true)
      expect(TOPIC[topic].length).toBeGreaterThan(0)
      expect(helpVerb(verb)).toBe(TOPIC[topic])
    }
    expect(helpVerb('nope')).toBeUndefined()
    expect((await cli(['nope'])).out).toBe('No command nope; shepherdr help lists them\n')
    expect((await cli(['nope', '--help'])).out).toBe('No command nope; shepherdr help lists them\n')
  })
})
